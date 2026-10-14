// FLV muxer: header, sequence headers, AVCC conversion and timestamps.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FlvMuxer, adtsFrames, splitNals } from "../src/flv.mjs";

const SPS = Buffer.from([0x67, 0x42, 0xc0, 0x1e, 0xaa]);
const PPS = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
const IDR = Buffer.from([0x65, 0x88, 0x84, 0x40]); // a NAL unit never ends in a zero byte
const P = Buffer.from([0x41, 0x9a, 0x02]);
const SC4 = Buffer.from([0, 0, 0, 1]);
const SC3 = Buffer.from([0, 0, 1]);
const KEYFRAME = Buffer.concat([SC4, SPS, SC4, PPS, SC3, IDR]);
const PFRAME = Buffer.concat([SC4, P]);
// AAC-LC, 16 kHz (index 8), mono, 7-byte header + 3 payload bytes
const ADTS = Buffer.from([0xff, 0xf1, 0x60, 0x40, 0x01, 0x40, 0x00, 0xaa, 0xbb, 0xcc]);

/** Parses an FLV byte stream into its header flags and tags. */
function parse(flv) {
  assert.equal(flv.subarray(0, 3).toString(), "FLV");
  const tags = [];
  let at = 13;
  while (at < flv.length) {
    const size = flv.readUIntBE(at + 1, 3);
    const timestamp = flv.readUIntBE(at + 4, 3) | (flv[at + 7] << 24);
    tags.push({ type: flv[at], timestamp, data: flv.subarray(at + 11, at + 11 + size) });
    assert.equal(flv.readUInt32BE(at + 11 + size), 11 + size, "previous tag size");
    at += 11 + size + 4;
  }
  return { flags: flv[4], tags };
}

describe("splitNals", () => {
  it("splits on 3- and 4-byte start codes without trailing zeros", () => {
    assert.deepEqual(splitNals(KEYFRAME), [SPS, PPS, IDR]);
  });
});

describe("adtsFrames", () => {
  it("derives the AudioSpecificConfig and strips the header", () => {
    const [frame, ...rest] = adtsFrames(Buffer.concat([ADTS, ADTS]));
    assert.equal(rest.length, 1);
    assert.deepEqual(frame.config, Buffer.from([0x14, 0x08])); // LC, 16 kHz, mono
    assert.deepEqual(frame.data, Buffer.from([0xaa, 0xbb, 0xcc]));
  });

  it("ignores data that is not ADTS", () => {
    assert.deepEqual(adtsFrames(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])), []);
  });
});

describe("FlvMuxer", () => {
  it("waits for the first keyframe, then writes header, metadata and sequence headers", () => {
    const mux = new FlvMuxer({ audio: true, fps: 15 });
    assert.equal(mux.mux({ kind: "audio", data: ADTS, at: 900 }).length, 0);
    assert.equal(mux.mux({ kind: "video", data: PFRAME, at: 950 }).length, 0);
    const out = Buffer.concat([
      mux.mux({ kind: "video", data: KEYFRAME, at: 1000, keyframe: true }),
      mux.mux({ kind: "audio", data: ADTS, at: 1010 }),
      mux.mux({ kind: "video", data: PFRAME, at: 1066 }),
    ]);
    const { flags, tags } = parse(out);
    assert.equal(flags, 0x05, "audio and video announced");
    assert.deepEqual(tags.map((t) => [t.type, t.timestamp]), [[18, 0], [9, 0], [9, 0], [8, 10], [8, 10], [9, 66]]);
    assert.match(tags[0].data.toString("latin1"), /onMetaData.*framerate/s);

    const [, avcHeader, key, aacHeader, aac, p] = tags;
    assert.deepEqual(avcHeader.data.subarray(0, 2), Buffer.from([0x17, 0]));
    assert.deepEqual(avcHeader.data.subarray(5), Buffer.from([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0, 5, ...SPS, 1, 0, 4, ...PPS]));
    // NAL units with 4-byte lengths instead of start codes.
    assert.deepEqual(key.data, Buffer.from([0x17, 1, 0, 0, 0, 0, 0, 0, 5, ...SPS, 0, 0, 0, 4, ...PPS, 0, 0, 0, 4, ...IDR]));
    assert.deepEqual(aacHeader.data, Buffer.from([0xaf, 0, 0x14, 0x08]));
    assert.deepEqual(aac.data, Buffer.from([0xaf, 1, 0xaa, 0xbb, 0xcc]));
    assert.deepEqual(p.data, Buffer.from([0x27, 1, 0, 0, 0, 0, 0, 0, 3, ...P]));
  });

  it("repeats the AVC sequence header only when SPS/PPS change", () => {
    const mux = new FlvMuxer({ audio: false });
    const first = parse(mux.mux({ kind: "video", data: KEYFRAME, at: 0, keyframe: true }));
    assert.equal(first.flags, 0x01, "video only");
    const again = mux.mux({ kind: "video", data: KEYFRAME, at: 2000, keyframe: true });
    assert.equal(again[0], 9);
    assert.equal(again[11 + 1], 1, "a frame, not a sequence header");
    assert.equal(mux.mux({ kind: "audio", data: ADTS, at: 2010 }).length, 0, "no audio track");
  });
});
