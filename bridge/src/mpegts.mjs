// Minimal MPEG-TS muxer for one H.264 video and one AAC (ADTS) audio track.
//
// Raw Annex-B cannot carry audio and has no timestamps. MPEG-TS carries both, is made for
// live transport over a byte stream, and is read by Home Assistant's stream component (PyAV)
// and by go2rtc. Timestamps are the arrival times of the frames, which is the right clock for
// a live feed. Each viewer gets its own muxer, because continuity counters are per output.

const PACKET = 188;
const PID_PMT = 0x1000;
const PID_VIDEO = 0x100;
const PID_AUDIO = 0x101;
const STREAM_TYPE_H264 = 0x1b;
const STREAM_TYPE_AAC_ADTS = 0x0f;
// Small headroom so the first audio frame, arriving just before the first video frame, keeps
// a positive timestamp.
const START_OFFSET_MS = 100;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC-32/MPEG-2 over a PSI section. */
export function crc32mpeg(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc >>> 0;
}

function section(tableId, tableIdExt, body) {
  // table_id, section_syntax_indicator=1, length, ext, version 0/current, section 0 of 0
  const length = 5 + body.length + 4;
  const head = Buffer.from([
    tableId,
    0xb0 | ((length >> 8) & 0x0f),
    length & 0xff,
    (tableIdExt >> 8) & 0xff,
    tableIdExt & 0xff,
    0xc1,
    0x00,
    0x00,
  ]);
  const withoutCrc = Buffer.concat([head, body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32mpeg(withoutCrc));
  return Buffer.concat([withoutCrc, crc]);
}

function patSection() {
  // program 1 -> PMT PID
  return section(0x00, 1, Buffer.from([0x00, 0x01, 0xe0 | (PID_PMT >> 8), PID_PMT & 0xff]));
}

function pmtSection(withAudio) {
  const streams = [[STREAM_TYPE_H264, PID_VIDEO]];
  if (withAudio) streams.push([STREAM_TYPE_AAC_ADTS, PID_AUDIO]);
  const body = [0xe0 | (PID_VIDEO >> 8), PID_VIDEO & 0xff, 0xf0, 0x00]; // PCR PID, no program info
  for (const [type, pid] of streams) body.push(type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0x00);
  return section(0x02, 1, Buffer.from(body));
}

/** 33-bit PTS in the 5-byte PES encoding with the given 4-bit prefix. */
function encodeTimestamp(prefix, ts) {
  const t = BigInt(ts) & 0x1ffffffffn;
  return Buffer.from([
    (prefix << 4) | (Number((t >> 30n) & 0x07n) << 1) | 1,
    Number((t >> 22n) & 0xffn),
    (Number((t >> 15n) & 0x7fn) << 1) | 1,
    Number((t >> 7n) & 0xffn),
    (Number(t & 0x7fn) << 1) | 1,
  ]);
}

function pesPacket(streamId, payload, pts90k) {
  const header = Buffer.concat([Buffer.from([0x80, 0x80, 0x05]), encodeTimestamp(0x2, pts90k)]);
  const length = header.length + payload.length;
  // Video PES may leave the length open (0); audio frames are small enough to state it.
  const pesLength = streamId === 0xe0 || length > 0xffff ? 0 : length;
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x01, streamId, pesLength >> 8, pesLength & 0xff]), header, payload]);
}

function pcrField(pts90k) {
  const base = BigInt(pts90k) & 0x1ffffffffn;
  return Buffer.from([
    Number((base >> 25n) & 0xffn),
    Number((base >> 17n) & 0xffn),
    Number((base >> 9n) & 0xffn),
    Number((base >> 1n) & 0xffn),
    (Number(base & 1n) << 7) | 0x7e,
    0x00,
  ]);
}

export class TsMuxer {
  /** @param {{ audio?: boolean }} [opts] whether the program announces an audio track */
  constructor({ audio = true } = {}) {
    this.audio = audio;
    this.counters = new Map();
    this.origin = null;
  }

  #packets(pid, payload, { unitStart, pcr = null, randomAccess = false }) {
    const out = [];
    let offset = 0;
    let first = true;
    while (offset < payload.length) {
      const flags = first ? (randomAccess ? 0x40 : 0) | (pcr !== null ? 0x10 : 0) : 0;
      let adaptation = flags ? [flags, ...(first && pcr !== null ? pcrField(pcr) : [])] : null;
      const headerLength = 4 + (adaptation ? 1 + adaptation.length : 0);
      const take = Math.min(payload.length - offset, PACKET - headerLength);
      // The last packet of a unit is padded through the adaptation field.
      const stuffing = PACKET - headerLength - take;
      if (stuffing > 0) {
        if (!adaptation) adaptation = stuffing === 1 ? [] : [0x00, ...Array(stuffing - 2).fill(0xff)];
        else adaptation.push(...Array(stuffing).fill(0xff));
      }
      const cc = this.counters.get(pid) ?? 0;
      this.counters.set(pid, (cc + 1) & 0x0f);
      const packet = Buffer.alloc(PACKET);
      packet[0] = 0x47;
      packet[1] = (first && unitStart ? 0x40 : 0) | ((pid >> 8) & 0x1f);
      packet[2] = pid & 0xff;
      packet[3] = (adaptation ? 0x30 : 0x10) | cc;
      let at = 4;
      if (adaptation) {
        packet[at++] = adaptation.length;
        Buffer.from(adaptation).copy(packet, at);
        at += adaptation.length;
      }
      payload.copy(packet, at, offset, offset + take);
      out.push(packet);
      offset += take;
      first = false;
    }
    return out;
  }

  #psi(pid, sectionData) {
    return this.#packets(pid, Buffer.concat([Buffer.from([0x00]), sectionData]), { unitStart: true });
  }

  #pts(at) {
    if (this.origin === null) this.origin = at - START_OFFSET_MS;
    return Math.max(0, Math.round((at - this.origin) * 90));
  }

  /**
   * Muxes one frame. `keyframe` video frames are preceded by PAT/PMT so a reader can start there.
   *
   * @param {{ kind: "video" | "audio", data: Buffer, at: number, keyframe?: boolean }} unit
   *        `at` is the arrival time in milliseconds
   * @returns {Buffer}
   */
  mux({ kind, data, at, keyframe = false }) {
    const pts = this.#pts(at);
    if (kind === "audio") {
      if (!this.audio) return Buffer.alloc(0);
      return Buffer.concat(this.#packets(PID_AUDIO, pesPacket(0xc0, data, pts), { unitStart: true }));
    }
    const packets = [];
    if (keyframe) packets.push(...this.#psi(0x0000, patSection()), ...this.#psi(PID_PMT, pmtSection(this.audio)));
    packets.push(...this.#packets(PID_VIDEO, pesPacket(0xe0, data, pts), { unitStart: true, pcr: pts, randomAccess: keyframe }));
    return Buffer.concat(packets);
  }
}
