// Baseline-JPEG entropy scanner that decodes no pixels.
//
// Ported from mega-yfue/eufy-sdk (src/transport/http/jpeg-scan.ts, commit 7d1f016),
// Apache License 2.0, see bridge/third-party/eufy-sdk-LICENSE. Changes: TypeScript -> JavaScript,
// comments shortened.
//
// Walks the Huffman-coded scan and keeps one luma DC value per MCU. The v2 thumbnail decoder uses
// it to find the chroma subsampling and the MCU count of a scan whose header is missing, without
// allocating full decode buffers for every hypothesis.

const DHT = 0xc4;
const SOS = 0xda;
const DRI = 0xdd;
const RST_FIRST = 0xd0;
const RST_LAST = 0xd7;

/** Luma sampling factors [h, v] per subsampling id: 0 = 4:4:4, 1 = 4:2:2, 2 = 4:2:0. */
const LUMA_SAMPLING = { 0: [1, 1], 1: [2, 1], 2: [2, 2] };

/** Unwinds out of the bit reader when the data ends or a hypothesis diverges. */
class ScanEnd extends Error {}

/** Parses every table in a DHT segment (`FF C4` included) into `class<<4 | id` -> table. */
function readHuffmanTables(segment, into) {
  const end = 2 + ((segment[2] << 8) | segment[3]);
  let at = 4;
  while (at < end) {
    const id = segment[at];
    const counts = segment.subarray(at + 1, at + 17);
    let total = 0;
    for (const count of counts) total += count;
    const values = segment.slice(at + 17, at + 17 + total);

    const minCode = new Int32Array(17);
    const maxCode = new Int32Array(17).fill(-1);
    const valPtr = new Int32Array(17);
    let code = 0;
    let index = 0;
    for (let length = 1; length <= 16; length++) {
      const count = counts[length - 1];
      if (count > 0) {
        valPtr[length] = index;
        minCode[length] = code;
        code += count;
        index += count;
        maxCode[length] = code - 1;
      }
      code <<= 1;
    }
    into.set(id, { minCode, maxCode, valPtr, values });
    at += 17 + total;
  }
}

/** Bit reader over entropy-coded data: unstuffs `FF 00`, resyncs on RSTn, ends at other markers. */
class BitReader {
  constructor(data, start) {
    this.data = data;
    this.position = start;
    this.bits = 0;
    this.count = 0;
    this.restarted = false;
  }

  get consumed() {
    return this.position;
  }

  readBit() {
    if (this.count === 0) {
      if (this.position >= this.data.length) throw new ScanEnd("out of data");
      let byte = this.data[this.position++];
      if (byte === 0xff) {
        const next = this.data[this.position];
        if (next === 0x00) {
          this.position++;
        } else if (next !== undefined && next >= RST_FIRST && next <= RST_LAST) {
          this.position++;
          this.restarted = true;
          if (this.position >= this.data.length) throw new ScanEnd("out of data");
          byte = this.data[this.position++];
          if (byte === 0xff) throw new ScanEnd("marker after restart");
        } else {
          this.position--;
          throw new ScanEnd("marker");
        }
      }
      this.bits = byte;
      this.count = 8;
    }
    this.count--;
    return (this.bits >> this.count) & 1;
  }

  readBits(length) {
    let value = 0;
    for (let i = 0; i < length; i++) value = (value << 1) | this.readBit();
    return value;
  }

  align() {
    this.count = 0;
  }
}

/** Decodes one Huffman-coded value (spec F.16). */
function decodeHuffman(reader, table) {
  let code = reader.readBit();
  for (let length = 1; length <= 16; length++) {
    if (table.maxCode[length] >= 0 && code <= table.maxCode[length]) {
      return table.values[table.valPtr[length] + code - table.minCode[length]];
    }
    code = (code << 1) | reader.readBit();
  }
  throw new ScanEnd("no huffman code of any length");
}

/** Sign-extends a `length`-bit magnitude into a signed coefficient (spec F.12). */
function extend(value, length) {
  return value < 1 << (length - 1) ? value - (1 << length) + 1 : value;
}

/** Decodes one 8x8 block and keeps only its DC coefficient; AC bits are walked and dropped. */
function decodeBlock(reader, component) {
  const dcLength = decodeHuffman(reader, component.dc);
  if (dcLength > 16) throw new ScanEnd("dc magnitude out of range");
  component.pred += dcLength === 0 ? 0 : extend(reader.readBits(dcLength), dcLength);

  let k = 1;
  while (k < 64) {
    const rs = decodeHuffman(reader, component.ac);
    const size = rs & 15;
    const run = rs >> 4;
    if (size === 0) {
      if (run !== 15) break;
      k += 16;
    } else {
      k += run;
      if (k > 63) throw new ScanEnd("ac coefficient index out of range");
      reader.readBits(size);
      k++;
    }
  }
  return component.pred;
}

/**
 * Walks the scan of `tail` under one subsampling hypothesis.
 *
 * `extraTables` are DHT segments not contained in `tail` (for v2: the standard luma tables).
 * Returns null if `tail` is not a baseline scan. `complete` is true only if the walk ended on an
 * MCU boundary with nothing but a marker left - only the right hypothesis gets there.
 *
 * @returns {{ mcus: number, luma: Int32Array, complete: boolean } | null}
 */
export function scanEntropy(tail, subsampling, extraTables) {
  const tables = new Map();
  for (const segment of extraTables) readHuffmanTables(segment, tables);

  let at = 0;
  let restartInterval = 0;
  let scanStart = -1;
  let assignments = [];
  while (at + 3 < tail.length) {
    if (tail[at] !== 0xff) return null;
    const marker = tail[at + 1];
    const length = (tail[at + 2] << 8) | tail[at + 3];
    if (marker === DHT) {
      readHuffmanTables(tail.subarray(at, at + 2 + length), tables);
    } else if (marker === DRI) {
      restartInterval = (tail[at + 4] << 8) | tail[at + 5];
    } else if (marker === SOS) {
      const count = tail[at + 4];
      assignments = [];
      for (let i = 0; i < count; i++) {
        const id = tail[at + 5 + i * 2];
        const tableByte = tail[at + 6 + i * 2];
        assignments.push({ id, dc: tableByte >> 4, ac: tableByte & 15 });
      }
      scanStart = at + 2 + length;
      break;
    }
    at += 2 + length;
  }
  if (scanStart < 0 || assignments.length !== 3) return null;

  const [lumaH, lumaV] = LUMA_SAMPLING[subsampling] ?? LUMA_SAMPLING[0];
  const components = [];
  for (const [index, assignment] of assignments.entries()) {
    const dc = tables.get(assignment.dc);
    const ac = tables.get(0x10 | assignment.ac);
    if (!dc || !ac) return null;
    components.push({ h: index === 0 ? lumaH : 1, v: index === 0 ? lumaV : 1, dc, ac, pred: 0 });
  }

  const reader = new BitReader(tail, scanStart);
  let luma = new Int32Array(1024);
  const lumaBlocks = lumaH * lumaV;
  let mcus = 0;
  let consumed = reader.consumed;
  let complete = false;
  try {
    for (;;) {
      if (restartInterval > 0 && mcus > 0 && mcus % restartInterval === 0) {
        reader.align();
        for (const component of components) component.pred = 0;
      }
      if (reader.restarted) {
        reader.restarted = false;
        for (const component of components) component.pred = 0;
      }
      let lumaSum = 0;
      for (const component of components) {
        for (let block = 0; block < component.h * component.v; block++) {
          const dc = decodeBlock(reader, component);
          if (component === components[0]) lumaSum += dc;
        }
      }
      if (mcus === luma.length) {
        const grown = new Int32Array(luma.length * 2);
        grown.set(luma);
        luma = grown;
      }
      luma[mcus] = Math.round(lumaSum / lumaBlocks);
      mcus++;
      consumed = reader.consumed;
      if (consumed >= tail.length) {
        complete = true;
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof ScanEnd)) throw error;
    complete = tail.length - consumed <= 2;
  }
  return { mcus, luma: luma.subarray(0, mcus), complete };
}
