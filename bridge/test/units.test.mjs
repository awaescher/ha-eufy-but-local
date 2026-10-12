import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";

import { readConfig } from "../src/config.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { findSpsOffset } from "../src/h264.mjs";
import { ImageStore } from "../src/images.mjs";
import { LiveStreams } from "../src/live.mjs";
import { splitFrames } from "../src/simulator.mjs";
import { BridgeState } from "../src/state.mjs";

const SPS4 = Buffer.from([0, 0, 0, 1, 0x67, 0x42]);
const SPS3 = Buffer.from([0, 0, 1, 0x67, 0x42]);
const PFRAME = Buffer.from([0, 0, 0, 1, 0x41, 0x9a, 0x00]);

class Sink {
  constructor() { this.chunks = []; this.ended = false; }
  write(c) { this.chunks.push(c); }
  end() { this.ended = true; }
  get bytes() { return Buffer.concat(this.chunks); }
}

describe("config", () => {
  it("uses defaults", () => {
    const c = readConfig({});
    assert.equal(c.port, 3080);
    assert.equal(c.token, "");
    assert.equal(c.simulator, false);
    assert.equal(c.credentials, null);
  });

  it("reads credentials only when complete", () => {
    assert.equal(readConfig({ EUFY_EMAIL: "a@b.c" }).credentials, null);
    assert.deepEqual(readConfig({ EUFY_EMAIL: "a@b.c", EUFY_PASSWORD: "x" }).credentials, { email: "a@b.c", password: "x", country: "DE" });
  });

  it("rejects invalid numbers", () => {
    assert.throws(() => readConfig({ BRIDGE_PORT: "abc" }), /BRIDGE_PORT/);
    assert.throws(() => readConfig({ POLL_SEC: "-1" }), /POLL_SEC/);
  });
});

describe("credentials", () => {
  it("round-trips with mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "eufy-cred-"));
    const store = new CredentialStore(dir);
    assert.equal(store.load(), null);
    store.save({ email: "a@b.c", password: "secret", country: "DE" });
    assert.deepEqual(store.load(), { email: "a@b.c", password: "secret", country: "DE" });
    assert.equal(statSync(store.file).mode & 0o777, 0o600);
  });
});

describe("findSpsOffset", () => {
  it("finds SPS behind 4- and 3-byte start codes", () => {
    assert.equal(findSpsOffset(SPS4), 0);
    assert.equal(findSpsOffset(SPS3), 0);
    assert.equal(findSpsOffset(Buffer.concat([Buffer.from([9, 9, 9]), SPS4])), 3);
  });

  it("ignores other NAL types", () => {
    assert.equal(findSpsOffset(PFRAME), -1);
    assert.equal(findSpsOffset(Buffer.alloc(0)), -1);
  });
});

describe("splitFrames", () => {
  it("splits the simulator sample into keyframes and P-frames", () => {
    const buf = readFileSync(new URL("../simulator-assets/stream.h264", import.meta.url));
    const frames = splitFrames(buf);
    assert.ok(frames.length >= 50);
    assert.equal(Buffer.concat(frames).length, buf.length);
    assert.equal(findSpsOffset(frames[0]), 0);
  });
});

describe("BridgeState", () => {
  it("merges camera fields and emits change", () => {
    const s = new BridgeState("1.0.0");
    const changed = mock.fn();
    s.on("change", changed);
    s.upsertCamera("C1", { name: "Front door" });
    s.upsertCamera("C1", { battery: 50 });
    assert.equal(s.cameras.C1.name, "Front door");
    assert.equal(s.cameras.C1.battery, 50);
    assert.equal(s.cameras.C1.live, false);
    assert.equal(changed.mock.callCount(), 2);
  });

  it("rejects unknown phases", () => {
    assert.throws(() => new BridgeState("1").setPhase("weird"), /Unknown phase/);
  });

  it("timestamps published events", () => {
    const s = new BridgeState("1");
    let evt;
    s.on("event", (e) => (evt = e));
    s.publish({ type: "local_recording", device_sn: "C1" });
    assert.equal(evt.type, "local_recording");
    assert.ok(Date.parse(evt.at));
  });
});

describe("ImageStore", () => {
  it("serializes downloads and maps paths to cameras", () => {
    const requested = [];
    const store = new ImageStore({ download: (p) => requested.push(p) });
    store.request("C1", "/a.jpg");
    store.request("C2", "/b.jpg");
    assert.deepEqual(requested, ["/a.jpg"]);
    assert.equal(store.received("/a.jpg", Buffer.from("A")), "C1");
    assert.deepEqual(requested, ["/a.jpg", "/b.jpg"]);
    assert.equal(store.received("/b.jpg", Buffer.from("B"), "image/png"), "C2");
    assert.equal(store.get("C2").mime, "image/png");
    store.close();
  });

  it("skips paths it already fetched unless forced", () => {
    const requested = [];
    const store = new ImageStore({ download: (p) => requested.push(p) });
    store.request("C1", "/a.jpg");
    store.received("/a.jpg", Buffer.from("A"));
    store.request("C1", "/a.jpg");
    assert.equal(requested.length, 1);
    store.request("C1", "/a.jpg", { force: true });
    assert.equal(requested.length, 2);
    store.close();
  });

  it("continues after a failing download", () => {
    const requested = [];
    const store = new ImageStore({
      download: (p) => { requested.push(p); if (p === "/bad.jpg") throw new Error("boom"); },
    });
    store.request("C1", "/bad.jpg");
    store.request("C2", "/good.jpg");
    assert.deepEqual(requested, ["/bad.jpg", "/good.jpg"]);
    store.close();
  });

  it("ignores unknown or empty answers", () => {
    const store = new ImageStore({ download: () => {} });
    assert.equal(store.received("/unknown.jpg", Buffer.from("x")), null);
    store.request("C1", "/a.jpg");
    store.received("/a.jpg", Buffer.alloc(0));
    assert.equal(store.get("C1"), null);
    store.close();
  });
});

describe("LiveStreams", () => {
  const make = (overrides = {}) => {
    const calls = { start: [], stop: [], change: [] };
    const live = new LiveStreams({
      start: async (sn) => calls.start.push(sn),
      stop: async (sn) => calls.stop.push(sn),
      idleMs: 20,
      onChange: (sn, on) => calls.change.push([sn, on]),
      ...overrides,
    });
    return { live, calls };
  };

  it("starts once for several viewers", async () => {
    const { live, calls } = make();
    await live.addViewer("C1", new Sink());
    await live.addViewer("C1", new Sink());
    assert.deepEqual(calls.start, ["C1"]);
    assert.equal(live.viewerCount("C1"), 2);
  });

  it("delivers frames to viewers and replays the GOP to late viewers", async () => {
    const { live, calls } = make();
    const early = new Sink();
    await live.addViewer("C1", early);
    live.started("C1");
    live.feed("C1", Buffer.concat([Buffer.from([7, 7]), SPS4])); // garbage before SPS
    live.feed("C1", PFRAME);
    const late = new Sink();
    await live.addViewer("C1", late);
    assert.equal(early.chunks.length, 2);
    assert.equal(findSpsOffset(late.bytes), 0, "late viewer must start exactly at SPS");
    assert.deepEqual(calls.change, [["C1", true]]);
  });

  it("does not cache frames before the first keyframe", async () => {
    const { live } = make();
    await live.addViewer("C1", new Sink());
    live.started("C1");
    live.feed("C1", PFRAME);
    const late = new Sink();
    await live.addViewer("C1", late);
    assert.equal(late.chunks.length, 0);
  });

  it("stops after the idle period once the last viewer left", async () => {
    const { live, calls } = make();
    const v = new Sink();
    await live.addViewer("C1", v);
    live.started("C1");
    live.removeViewer("C1", v);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(calls.stop, ["C1"]);
  });

  it("keeps running when a viewer returns within the idle period", async () => {
    const { live, calls } = make();
    const v = new Sink();
    await live.addViewer("C1", v);
    live.started("C1");
    live.removeViewer("C1", v);
    await live.addViewer("C1", new Sink());
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(calls.stop, []);
  });

  it("ends all viewers when the stream stops", async () => {
    const { live, calls } = make();
    const v = new Sink();
    await live.addViewer("C1", v);
    live.started("C1");
    live.ended("C1");
    live.ended("C1"); // second call is a no-op
    assert.equal(v.ended, true);
    assert.equal(live.isRunning("C1"), false);
    assert.deepEqual(calls.change, [["C1", true], ["C1", false]]);
  });

  it("cleans up when starting fails", async () => {
    const { live } = make({ start: async () => { throw new Error("camera asleep"); } });
    const v = new Sink();
    await live.addViewer("C1", v);
    assert.equal(v.ended, true);
    assert.equal(live.viewerCount("C1"), 0);
  });
});
