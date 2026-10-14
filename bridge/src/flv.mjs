// Minimal FLV muxer for one H.264 video and one AAC (ADTS) audio track.
//
// Why FLV next to MPEG-TS: the ffmpeg command line (used by Home Assistant's HomeKit Bridge)
// analyses an MPEG-TS stream for a full 5 s before it outputs anything, because it scans for
// further programs (`scan_all_pmts`). An FLV header announces its tracks, and the metadata
// carries the frame rate, so ffmpeg stops analysing once it saw both tracks. go2rtc and
// PyAV read FLV too; Matroska would be faster still, but go2rtc cannot read it.
//
// The stream starts at the first keyframe: FLV needs SPS/PPS (AVC sequence header) before any
// video. Timestamps are milliseconds since that keyframe's arrival.

const TAG_AUDIO = 8;
const TAG_VIDEO = 9;
const TAG_SCRIPT = 18;
const CODEC_AVC = 7;
const CODEC_AAC = 10;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;

/** NAL units of an Annex-B buffer, without start codes. */
export function splitNals(buf) {
  const starts = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  return starts.map((start, n) => {
    let end = n + 1 < starts.length ? starts[n + 1] - 3 : buf.length;
    // A 4-byte start code leaves one zero byte at the end of the previous unit.
    while (end > start && buf[end - 1] === 0) end--;
    return buf.subarray(start, end);
  });
}

/** AAC frames of an ADTS buffer: `{ config, data }` with the AudioSpecificConfig and raw AAC. */
export function adtsFrames(buf) {
  const frames = [];
  let at = 0;
  while (at + 7 <= buf.length && buf[at] === 0xff && (buf[at + 1] & 0xf6) === 0xf0) {
    const headerLength = buf[at + 1] & 0x01 ? 7 : 9;
    const frameLength = ((buf[at + 3] & 0x03) << 11) | (buf[at + 4] << 3) | (buf[at + 5] >> 5);
    if (frameLength <= headerLength || at + frameLength > buf.length) break;
    const objectType = ((buf[at + 2] >> 6) & 0x03) + 1;
    const rateIndex = (buf[at + 2] >> 2) & 0x0f;
    const channels = ((buf[at + 2] & 0x01) << 2) | (buf[at + 3] >> 6);
    const asc = (objectType << 11) | (rateIndex << 7) | (channels << 3);
    frames.push({ config: Buffer.from([asc >> 8, asc & 0xff]), data: buf.subarray(at + headerLength, at + frameLength) });
    at += frameLength;
  }
  return frames;
}

function tag(type, timestamp, data) {
  const head = Buffer.alloc(11);
  head[0] = type;
  head.writeUIntBE(data.length, 1, 3);
  head.writeUIntBE(timestamp & 0xffffff, 4, 3);
  head[7] = (timestamp >>> 24) & 0xff;
  // stream id (3 bytes) stays 0
  const size = Buffer.alloc(4);
  size.writeUInt32BE(11 + data.length);
  return Buffer.concat([head, data, size]);
}

function amfString(s) {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function amfNumber(n) {
  const b = Buffer.alloc(9);
  b[0] = 0x00;
  b.writeDoubleBE(n, 1);
  return b;
}

function onMetaData(fields) {
  const entries = Object.entries(fields);
  const count = Buffer.alloc(5);
  count[0] = 0x08; // ECMA array
  count.writeUInt32BE(entries.length, 1);
  const body = entries.map(([key, value]) =>
    Buffer.concat([amfString(key), typeof value === "boolean" ? Buffer.from([0x01, value ? 1 : 0]) : amfNumber(value)]),
  );
  return Buffer.concat([Buffer.from([0x02]), amfString("onMetaData"), count, ...body, Buffer.from([0, 0, 9])]);
}

function avcConfig(sps, pps) {
  const len = (b) => Buffer.from([b.length >> 8, b.length & 0xff]);
  return Buffer.concat([Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]), len(sps), sps, Buffer.from([1]), len(pps), pps]);
}

export class FlvMuxer {
  /** @param {{ audio?: boolean, fps?: number }} [opts] audio track announced; frame rate for the metadata */
  constructor({ audio = true, fps = 15 } = {}) {
    this.audio = audio;
    this.fps = fps;
    this.origin = null;
    this.sps = null;
    this.pps = null;
    this.audioConfig = null;
  }

  #ms(at) {
    return Math.max(0, Math.round(at - this.origin));
  }

  #header() {
    const head = Buffer.from([0x46, 0x4c, 0x56, 1, (this.audio ? 0x04 : 0) | 0x01, 0, 0, 0, 9, 0, 0, 0, 0]);
    const meta = { framerate: this.fps, videocodecid: CODEC_AVC };
    if (this.audio) Object.assign(meta, { audiocodecid: CODEC_AAC });
    return Buffer.concat([head, tag(TAG_SCRIPT, 0, onMetaData(meta))]);
  }

  #video({ data, at, keyframe }) {
    const out = [];
    const nals = splitNals(data);
    if (keyframe) {
      const sps = nals.find((n) => (n[0] & 0x1f) === NAL_SPS);
      const pps = nals.find((n) => (n[0] & 0x1f) === NAL_PPS);
      if (sps && pps && !(this.sps?.equals(sps) && this.pps?.equals(pps))) {
        if (this.origin === null) {
          this.origin = at;
          out.push(this.#header());
        }
        this.sps = sps;
        this.pps = pps;
        out.push(tag(TAG_VIDEO, this.#ms(at), Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0]), avcConfig(sps, pps)])));
      }
    }
    if (this.origin === null) return out;
    const units = nals.filter((n) => n.length > 0 && (n[0] & 0x1f) !== NAL_AUD);
    const body = units.flatMap((n) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(n.length);
      return [len, n];
    });
    out.push(tag(TAG_VIDEO, this.#ms(at), Buffer.concat([Buffer.from([keyframe ? 0x17 : 0x27, 1, 0, 0, 0]), ...body])));
    return out;
  }

  #audioTags({ data, at }) {
    if (!this.audio || this.origin === null) return [];
    const out = [];
    for (const frame of adtsFrames(data)) {
      if (!this.audioConfig?.equals(frame.config)) {
        this.audioConfig = frame.config;
        out.push(tag(TAG_AUDIO, this.#ms(at), Buffer.concat([Buffer.from([0xaf, 0]), frame.config])));
      }
      out.push(tag(TAG_AUDIO, this.#ms(at), Buffer.concat([Buffer.from([0xaf, 1]), frame.data])));
    }
    return out;
  }

  /**
   * Muxes one frame; returns an empty buffer until the first keyframe.
   *
   * @param {{ kind: "video" | "audio", data: Buffer, at: number, keyframe?: boolean }} unit
   *        `at` is the arrival time in milliseconds
   * @returns {Buffer}
   */
  mux(unit) {
    return Buffer.concat(unit.kind === "audio" ? this.#audioTags(unit) : this.#video(unit));
  }
}
