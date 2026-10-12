// Minimal H.264 Annex-B helpers.

const NAL_SPS = 7;

/**
 * Returns the offset of the start code that precedes the first SPS NAL unit
 * in the buffer, or -1 if there is none. Handles 3- and 4-byte start codes.
 */
export function findSpsOffset(buf) {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
    let nal = -1;
    if (buf[i + 2] === 1) nal = i + 3;
    else if (buf[i + 2] === 0 && buf[i + 3] === 1) nal = i + 4;
    if (nal > 0 && nal < buf.length && (buf[nal] & 0x1f) === NAL_SPS) return i;
  }
  return -1;
}
