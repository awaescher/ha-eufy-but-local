// MPEG-TS muxer: packet structure, PSI checksums, continuity and timestamps.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TsMuxer, crc32mpeg } from "../src/mpegts.mjs";

const SPS_FRAME = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67, 0x42]), Buffer.alloc(400, 0x11)]);
const P_FRAME = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x41, 0x9a]), Buffer.alloc(30, 0x22)]);
const ADTS = Buffer.concat([Buffer.from([0xff, 0xf1, 0x60, 0x40, 0x05, 0x1f, 0xfc]), Buffer.alloc(34, 0x33)]);

/** Splits a TS byte stream into packets and returns their parsed headers. */
function parse(ts) {
  assert.equal(ts.length % 188, 0, "whole packets only");
  const packets = [];
  for (let i = 0; i < ts.length; i += 188) {
    const p = ts.subarray(i, i + 188);
    assert.equal(p[0], 0x47, "sync byte");
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    const afc = (p[3] >> 4) & 3;
    const payloadStart = afc & 2 ? 5 + p[4] : 4;
    packets.push({ pid, pusi: Boolean(p[1] & 0x40), cc: p[3] & 0x0f, payload: p.subarray(payloadStart) });
  }
  return packets;
}

const readPts = (pes) =>
  ((pes[9] >> 1) & 0x07) * 2 ** 30 + (pes[10] << 22) + ((pes[11] >> 1) << 15) + (pes[12] << 7) + (pes[13] >> 1);

/** Reassembles each PES unit of `pid` (payloads from one PUSI to the next). */
function pesUnits(packets, pid) {
  const units = [];
  for (const p of packets.filter((x) => x.pid === pid)) {
    if (p.pusi) units.push([]);
    units.at(-1)?.push(p.payload);
  }
  return units.map((parts) => Buffer.concat(parts));
}

describe("TsMuxer", () => {
  const mux = (audio = true) => {
    const m = new TsMuxer({ audio });
    return Buffer.concat([
      m.mux({ kind: "video", data: SPS_FRAME, at: 1000, keyframe: true }),
      m.mux({ kind: "audio", data: ADTS, at: 1010 }),
      m.mux({ kind: "video", data: P_FRAME, at: 1066 }),
      m.mux({ kind: "audio", data: ADTS, at: 1074 }),
    ]);
  };

  it("writes a valid PAT and a PMT announcing H.264 and AAC", () => {
    const packets = parse(mux());
    const pat = packets.find((p) => p.pid === 0).payload;
    const patSection = pat.subarray(1, 1 + 3 + (((pat[2] & 0x0f) << 8) | pat[3]));
    assert.equal(crc32mpeg(patSection), 0, "PAT CRC");
    const pmt = packets.find((p) => p.pid === 0x1000).payload;
    const pmtLength = ((pmt[2] & 0x0f) << 8) | pmt[3];
    assert.equal(crc32mpeg(pmt.subarray(1, 1 + 3 + pmtLength)), 0, "PMT CRC");
    assert.deepEqual([pmt[13], pmt[18]], [0x1b, 0x0f], "stream types H.264 and AAC/ADTS");
  });

  it("announces no audio track when the stream has none", () => {
    const pmt = parse(mux(false)).find((p) => p.pid === 0x1000).payload;
    const pmtLength = ((pmt[2] & 0x0f) << 8) | pmt[3];
    assert.equal(pmtLength, 9 + 5 + 4, "one elementary stream");
    assert.equal(new TsMuxer({ audio: false }).mux({ kind: "audio", data: ADTS, at: 0 }).length, 0);
  });

  it("keeps continuity counters per PID and carries the frames unchanged", () => {
    const packets = parse(mux());
    for (const pid of [0x100, 0x101]) {
      const ccs = packets.filter((p) => p.pid === pid).map((p) => p.cc);
      ccs.forEach((cc, i) => assert.equal(cc, i & 0x0f));
    }
    const video = pesUnits(packets, 0x100);
    assert.deepEqual(video.map((pes) => pes.subarray(14)), [SPS_FRAME, P_FRAME]);
    const audio = pesUnits(packets, 0x101);
    assert.deepEqual(audio.map((pes) => pes.subarray(14)), [ADTS, ADTS]);
  });

  it("derives 90 kHz timestamps from the arrival times", () => {
    const packets = parse(mux());
    const video = pesUnits(packets, 0x100).map(readPts);
    const audio = pesUnits(packets, 0x101).map(readPts);
    assert.equal(video[1] - video[0], 66 * 90);
    assert.equal(audio[0] - video[0], 10 * 90);
    assert.ok(video[0] > 0, "first timestamp stays positive");
  });
});
