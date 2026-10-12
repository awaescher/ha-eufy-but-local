// Keyless decoder for `v2_eufysecurity:` event thumbnails.
//
// Ported from mega-yfue/eufy-sdk (src/transport/http/decodeImageV2.ts, commit 7d1f016),
// Apache License 2.0, see bridge/third-party/eufy-sdk-LICENSE. Changes: TypeScript -> JavaScript,
// comments shortened.
//
// eufy-security-client 3.8 only decrypts the older `eufysecurity:` format and returns v2 blobs
// unchanged. v2 is head-only obfuscation: everything from the standard DC-chroma Huffman table
// onward is plain JPEG. The decoder rebuilds a standard header (geometry and subsampling are
// recovered from the scan) and splices it onto that tail. The camera's quantization tables are
// lost with the head; substitute tables are scaled to the picture's own contrast, so colours and
// contrast are close to, not identical with, the original.

import jpegJs from "jpeg-js";

import { scanEntropy } from "./jpeg-scan.mjs";

const V2_PREFIX = "v2_eufysecurity:";

/** Standard baseline DC-chroma Huffman marker: the first plaintext byte of the v2 tail. */
const DC_CHROMA = Buffer.from([0xff, 0xc4, 0x00, 0x1f, 0x01]);

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
];

// Annex K base quantization tables (natural order, quality 50).
// prettier-ignore
const QUANT_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
// prettier-ignore
const QUANT_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

// Standard luma Huffman tables (Annex K.3); the chroma tables come from the plaintext tail.
const DHT_DC_LUMA = Buffer.from("ffc4001f0000010501010101010100000000000000000102030405060708090a0b", "hex");
const DHT_AC_LUMA = Buffer.from(
  "ffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c1" +
    "1552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768" +
    "696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7" +
    "c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa",
  "hex",
);

const SOI = Buffer.from([0xff, 0xd8]);
const APP0 = Buffer.from("ffe000104a46494600010100000100010000", "hex");

/** Subsampling id -> MCU pixel size [w, h]: 0 = 4:4:4, 1 = 4:2:2, 2 = 4:2:0. */
const MCU = { 0: [8, 8], 1: [16, 8], 2: [16, 16] };

/** Quality the substitute tables start at before the contrast correction. */
const REFERENCE_QUALITY = 85;
const MAX_STRETCH = 8;
const CUTOFF_PERCENT = 0.5;
/** Memory cap for the one probe decode (covers far more than any thumbnail). */
const PROBE_MEMORY_MB = 24;
const MAX_EDGE = 4096;
const MIN_ASPECT = 0.4;
const MAX_ASPECT = 4;

function scaleQuant(base, quality) {
  const factor = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * factor + 50) / 100))));
}

function dqtSegment(table, id, quality) {
  const q = scaleQuant(table, quality);
  const body = Buffer.alloc(65);
  body[0] = id;
  for (let i = 0; i < 64; i++) body[1 + i] = q[ZIGZAG[i]];
  return Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x43]), body]);
}

function sofSegment(width, height, subsampling) {
  const samplingFactors = subsampling === 2 ? 0x22 : subsampling === 1 ? 0x21 : 0x11;
  // prettier-ignore
  return Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, samplingFactors, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

/** Standard baseline header for the geometry, ending right before the DC-chroma DHT. */
function buildHeader(width, height, subsampling, quality) {
  return Buffer.concat([
    SOI,
    APP0,
    dqtSegment(QUANT_LUMA, 0, quality),
    dqtSegment(QUANT_CHROMA, 1, quality),
    sofSegment(width, height, subsampling),
    DHT_DC_LUMA,
    DHT_AC_LUMA,
  ]);
}

function decodeSpliced(header, tail) {
  try {
    return jpegJs.decode(Buffer.concat([header, tail]), { useTArray: true, maxMemoryUsageInMB: PROBE_MEMORY_MB });
  } catch {
    return null;
  }
}

/** One channel's range with `cutoff`% of the pixels trimmed off each end. */
function trimmedRange(data, channel, total, cutoff) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < total; i++) hist[data[i * 4 + channel]]++;

  let remaining = Math.floor((total * cutoff) / 100);
  let lo = 0;
  while (lo < 255 && remaining > 0) {
    if (remaining < hist[lo]) break;
    remaining -= hist[lo];
    lo++;
  }
  remaining = Math.floor((total * cutoff) / 100);
  let hi = 255;
  while (hi > 0 && remaining > 0) {
    if (remaining < hist[hi]) break;
    remaining -= hist[hi];
    hi--;
  }
  return { lo, hi };
}

/**
 * Amplification that opens the probe picture up to the full range. Applied by rewriting the
 * quantization tables (a scale on the tables is a scale on every coefficient), never by
 * re-encoding pixels.
 */
function contrastScale(img, cutoff = CUTOFF_PERCENT) {
  const total = img.width * img.height;
  if (total === 0) return 1;
  let stretch = Number.POSITIVE_INFINITY;
  for (let channel = 0; channel < 3; channel++) {
    const { lo, hi } = trimmedRange(img.data, channel, total, cutoff);
    if (hi <= lo) continue;
    if (lo < 128) stretch = Math.min(stretch, 128 / (128 - lo));
    if (hi > 128) stretch = Math.min(stretch, 127 / (hi - 128));
  }
  if (!Number.isFinite(stretch)) return 1;
  return Math.min(MAX_STRETCH, Math.max(1, stretch));
}

/** The quality whose Annex-K scaling is `stretch` times REFERENCE_QUALITY's. */
function qualityForStretch(stretch) {
  const referenceFactor = REFERENCE_QUALITY < 50 ? Math.floor(5000 / REFERENCE_QUALITY) : 200 - REFERENCE_QUALITY * 2;
  const factor = referenceFactor * stretch;
  const quality = factor <= 100 ? (200 - factor) / 2 : 5000 / factor;
  return Math.min(99, Math.max(1, Math.round(quality)));
}

/** Mean row-to-row difference of the MCU-resolution luma; low for the true width. */
function mcuRowShear(luma, mcuWidth, mcuHeight) {
  if (mcuHeight < 2) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let y = 1; y < mcuHeight; y++) {
    for (let x = 0; x < mcuWidth; x++) sum += Math.abs(luma[y * mcuWidth + x] - luma[(y - 1) * mcuWidth + x]);
  }
  return sum / (mcuWidth * (mcuHeight - 1));
}

/** Best frame shape among the divisor pairs of the MCU count, by row continuity. */
function bestGeometry(luma, mcus, subsampling) {
  const [mcuPixelWidth, mcuPixelHeight] = MCU[subsampling];
  let best = null;
  for (let mcuWidth = 1; mcuWidth <= mcus; mcuWidth++) {
    if (mcus % mcuWidth !== 0) continue;
    const mcuHeight = mcus / mcuWidth;
    const width = mcuWidth * mcuPixelWidth;
    const height = mcuHeight * mcuPixelHeight;
    if (width > MAX_EDGE || height > MAX_EDGE) continue;
    const aspect = width / height;
    if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;
    const shear = mcuRowShear(luma, mcuWidth, mcuHeight);
    if (!best || shear < best.shear) best = { subsampling, width, height, shear };
  }
  return best;
}

/** Only the subsampling the encoder used walks the scan to its end; pick its best geometry. */
function findGeometry(tail) {
  let best = null;
  for (const subsampling of [0, 1, 2]) {
    const scan = scanEntropy(tail, subsampling, [DHT_DC_LUMA, DHT_AC_LUMA]);
    if (!scan?.complete || scan.mcus < 1) continue;
    const geometry = bestGeometry(scan.luma, scan.mcus, subsampling);
    if (geometry && (!best || geometry.shear < best.shear)) best = geometry;
  }
  return best;
}

/** True if `data` is a `v2_eufysecurity:` blob. */
export function isV2Image(data) {
  return data.length >= V2_PREFIX.length && data.subarray(0, V2_PREFIX.length).toString("latin1") === V2_PREFIX;
}

/**
 * Rebuilds a viewable JPEG from a v2 blob, or returns null if it is not v2 or cannot be
 * reconstructed.
 *
 * @param {Buffer} data
 * @returns {Buffer | null}
 */
export function decodeImageV2(data) {
  if (!isV2Image(data)) return null;
  const cut = data.indexOf(DC_CHROMA);
  if (cut < 0) return null;
  const tail = data.subarray(cut);

  const geometry = findGeometry(tail);
  if (!geometry) return null;

  const { width, height, subsampling } = geometry;
  const reference = buildHeader(width, height, subsampling, REFERENCE_QUALITY);
  const probe = decodeSpliced(reference, tail);
  if (!probe) return null;

  const stretch = contrastScale(probe);
  const header = stretch > 1.01 ? buildHeader(width, height, subsampling, qualityForStretch(stretch)) : reference;
  return Buffer.concat([header, tail]);
}
