// v2 thumbnail decoder, against synthetic fixtures from eufy-sdk (see third-party/README.md).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import jpegJs from "jpeg-js";

import { decodeImageV2, isV2Image } from "../src/image-v2.mjs";
import { scanEntropy } from "../src/jpeg-scan.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/** The fixtures' heads are plain JPEG, so the source picture is available for comparison. */
const original = (blob) => jpegJs.decode(blob.subarray(blob.indexOf(Buffer.from([0xff, 0xd8]))));

const meanAbsDiff = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) sum += Math.abs(a.data[i + c] - b.data[i + c]);
  return sum / ((a.data.length / 4) * 3);
};

describe("decodeImageV2", () => {
  it("recognises v2 blobs only", () => {
    assert.equal(isV2Image(fixture("v2_176x144.bin")), true);
    assert.equal(isV2Image(Buffer.from("eufysecurity:T8:CODE:xxxx")), false);
    assert.equal(isV2Image(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), false);
    assert.equal(decodeImageV2(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), null);
  });

  for (const [name, width, height] of [
    ["v2_176x144.bin", 176, 144],
    ["v2_320x240_420.bin", 320, 240],
  ]) {
    it(`reconstructs ${name} at its geometry and close to the source picture`, () => {
      const blob = fixture(name);
      const jpeg = decodeImageV2(blob);
      assert.ok(jpeg, "decoded");
      const img = jpegJs.decode(jpeg);
      assert.deepEqual([img.width, img.height], [width, height]);
      assert.ok(meanAbsDiff(img, original(blob)) < 20, "picture resembles the source");
    });
  }

  it("falls back to the standard chroma tables when the obfuscated head covers them too", () => {
    // Real HomeBase 2 blobs: only the end of the standard AC-chroma table survives in plaintext.
    const blob = Buffer.from(fixture("v2_176x144.bin"));
    const acChromaEnd = blob.indexOf(Buffer.from("e2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9fa", "hex"));
    assert.ok(acChromaEnd > 0, "fixture uses the standard chroma tables");
    const headStart = blob.indexOf(Buffer.from([0xff, 0xd8]));
    blob.fill(0x11, headStart, acChromaEnd - 6);
    assert.equal(blob.indexOf(Buffer.from([0xff, 0xc4])), -1, "no Huffman table left in plaintext");

    const img = jpegJs.decode(decodeImageV2(blob));
    assert.deepEqual([img.width, img.height], [176, 144]);
    assert.ok(meanAbsDiff(img, original(fixture("v2_176x144.bin"))) < 20);
  });

  it("returns null when the plaintext tail is missing", () => {
    assert.equal(decodeImageV2(Buffer.from("v2_eufysecurity:T8000TEST00000002:0000000000:garbage")), null);
  });
});

describe("scanEntropy", () => {
  it("rejects data that is not a baseline scan", () => {
    assert.equal(scanEntropy(Buffer.from([1, 2, 3, 4, 5]), 0, []), null);
  });
});
