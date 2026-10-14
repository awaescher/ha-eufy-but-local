import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";

import { readConfig } from "../src/config.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { findSpsOffset } from "../src/h264.mjs";
import { ImageStore } from "../src/images.mjs";
import { LiveStreams, adtsDurationMs, boundBacklog } from "../src/live.mjs";
import { splitFrames } from "../src/simulator.mjs";
import { BridgeState } from "../src/state.mjs";

const SPS4 = Buffer.from([0, 0, 0, 1, 0x67, 0x42]);
const SPS3 = Buffer.from([0, 0, 1, 0x67, 0x42]);
const PFRAME = Buffer.from([0, 0, 0, 1, 0x41, 0x9a, 0x00]);
const IDR = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84]);

class Sink {
  constructor() { this.chunks = []; this.units = []; this.ended = false; }
  push(u) { this.units.push(u); if (u.kind === "video") this.chunks.push(u.data); }
  end() { this.ended = true; }
  get bytes() { return Buffer.concat(this.chunks); }
}

describe("config", () => {
  it("uses defaults", () => {
    const c = readConfig({});
    assert.equal(c.port, 3080);
    assert.equal(c.token, "");
    assert.equal(c.simulator, false);
    assert.equal(c.debug, false);
    assert.equal(readConfig({ BRIDGE_DEBUG: "true" }).debug, true);
    assert.equal(c.credentials, null);
  });

  it("reads credentials only when complete", () => {
    assert.equal(readConfig({ EUFY_EMAIL: "a@b.c" }).credentials, null);
    assert.deepEqual(readConfig({ EUFY_EMAIL: "a@b.c", EUFY_PASSWORD: "x" }).credentials, { email: "a@b.c", password: "x", country: "DE" });
  });

  it("pins the HomeBase from HOMEBASE_IP and HOMEBASE_SERIAL", () => {
    const c = readConfig({ HOMEBASE_IP: "192.168.1.50", HOMEBASE_SERIAL: "T8010SIM0000001" });
    assert.equal(c.stationIp, "192.168.1.50");
    assert.equal(c.stationSerial, "T8010SIM0000001");
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

  it("displaces the running camera of the same station and refuses it for a while", async () => {
    let t = 1000;
    const { live, calls } = make({ stationOf: () => "HB", switchCooldownMs: 30_000, now: () => t });
    const first = new Sink();
    await live.addViewer("C1", first);
    live.started("C1");

    await live.addViewer("C2", new Sink());
    assert.equal(first.ended, true, "viewers of the displaced camera are ended");
    assert.deepEqual(calls.stop, ["C1"]);
    assert.deepEqual(calls.start, ["C1", "C2"]);

    // Clients reconnect on their own; that must not displace the new camera right back.
    assert.equal(live.admits("C1"), false);
    assert.equal(live.admits("C2"), true);
    t += 30_000;
    assert.equal(live.admits("C1"), true);
  });

  it("does not displace cameras of another station", async () => {
    const { live, calls } = make({ stationOf: (sn) => (sn === "C1" ? "HB1" : "HB2") });
    const first = new Sink();
    await live.addViewer("C1", first);
    live.started("C1");
    await live.addViewer("C2", new Sink());
    assert.equal(first.ended, false);
    assert.deepEqual(calls.stop, []);
    assert.equal(live.admits("C1"), true);
  });

  it("keeps timestamps advancing when P2P delivers frames in bursts", async () => {
    let t = 1000;
    const { live } = make({ now: () => t });
    const v = new Sink();
    await live.addViewer("C1", v);
    live.started("C1", { audio: true, fps: 10 });
    const ADTS = Buffer.from([0xff, 0xf1, 0x60, 0x40, 0x18, 0x02, 0x40, 0, 0]); // 16 kHz, 1 block: 64 ms
    // Three video and three audio frames arrive in the same millisecond.
    for (let i = 0; i < 3; i++) live.feed("C1", i === 0 ? Buffer.concat([SPS4, PFRAME]) : PFRAME);
    for (let i = 0; i < 3; i++) live.feedAudio("C1", ADTS);
    const at = (kind) => v.units.filter((u) => u.kind === kind).map((u) => u.at);
    assert.deepEqual(at("video"), [1000, 1050, 1100], "at least half a frame interval apart");
    assert.deepEqual(at("audio"), [1000, 1064, 1128], "audio follows its sample count");

    // After a long gap the audio clock re-anchors to arrival time instead of lagging behind.
    t = 5000;
    live.feedAudio("C1", ADTS);
    assert.equal(at("audio").at(-1), 5000);
  });

  it("reads the duration of an ADTS frame", () => {
    assert.equal(adtsDurationMs(Buffer.from([0xff, 0xf1, 0x60, 0x40, 0x18, 0x02, 0x40])), 64);
    assert.equal(adtsDurationMs(Buffer.from([1, 2, 3, 4, 5, 6, 7])), null);
  });

  it("cleans up when starting fails", async () => {
    const { live } = make({ start: async () => { throw new Error("camera asleep"); } });
    const v = new Sink();
    await live.addViewer("C1", v);
    assert.equal(v.ended, true);
    assert.equal(live.viewerCount("C1"), 0);
  });

  it("completes a still frame whose IDR slice arrives after SPS/PPS", async () => {
    const frames = [];
    const { live } = make({ onFrame: (sn, at) => frames.push(at) });
    const v = new Sink();
    await live.addViewer("C1", v);
    live.started("C1");
    live.feed("C1", SPS4);
    assert.equal(live.lastFrame("C1"), null, "SPS/PPS alone is no picture");
    live.feed("C1", IDR);
    assert.deepEqual(live.lastFrame("C1").data, Buffer.concat([SPS4, IDR]));
    assert.equal(frames.length, 1);
    assert.equal(v.units.length, 2, "viewers still get both units");
    const late = new Sink();
    await live.addViewer("C1", late);
    assert.equal(late.units.length, 2, "and the GOP cache holds both");
  });

  it("delivers nothing before the first keyframe, so every viewer starts with one", async () => {
    const { live } = make();
    const v = new Sink();
    await live.addViewer("C1", v);
    live.started("C1", { audio: true });
    const ADTS = Buffer.from([0xff, 0xf1, 0x60, 0x40, 0x18, 0x02, 0x40, 0, 0]);
    live.feedAudio("C1", ADTS);
    live.feed("C1", PFRAME);
    assert.equal(v.units.length, 0);
    live.feed("C1", Buffer.concat([SPS4, PFRAME]));
    live.feedAudio("C1", ADTS);
    assert.deepEqual(v.units.map((u) => u.kind), ["video", "audio"]);
    assert.equal(v.units[0].keyframe, true);
  });

  it("logs where the start-up time goes", async () => {
    let t = 1000;
    const logs = [];
    const { live } = make({ now: () => t, log: (m) => logs.push(m), nameOf: () => "Garage" });
    await live.addViewer("C1", new Sink());
    t = 2900;
    live.started("C1");
    t = 3000;
    live.feed("C1", PFRAME);
    t = 4500;
    live.feed("C1", Buffer.concat([SPS4, PFRAME]));
    assert.deepEqual(logs, ["livestream Garage: started after 1900 ms, first frame after 2000 ms, first keyframe after 3500 ms"]);
    t = 64_500;
    live.ended("C1");
    assert.match(logs.at(-1), /^livestream Garage ended after 62 s \(timestamps at most \d+ ms ahead, slow viewers skipped 0 times\)$/);
  });

  it("keeps the latest keyframe as a still frame and reports it at most every 10 s", async () => {
    let t = Date.parse("2026-10-14T10:00:00Z");
    const frames = [];
    const { live } = make({ now: () => t, onFrame: (sn, at) => frames.push(at) });
    assert.equal(live.lastFrame("C1"), null);
    await live.addViewer("C1", new Sink());
    live.started("C1");
    live.feed("C1", Buffer.concat([Buffer.from([9]), SPS4, IDR]));
    t += 4000;
    live.feed("C1", Buffer.concat([SPS3, IDR]));
    assert.deepEqual(frames, ["2026-10-14T10:00:00.000Z"], "throttled");
    assert.equal(findSpsOffset(live.lastFrame("C1").data), 0);
    live.ended("C1");
    assert.deepEqual(frames, ["2026-10-14T10:00:00.000Z", "2026-10-14T10:00:04.000Z"], "final frame reported on end");
    assert.equal(live.lastFrame("C1").at, "2026-10-14T10:00:04.000Z", "kept after the stream ended");
  });
});

describe("boundBacklog", () => {
  const key = { kind: "video", keyframe: true };
  const p = { kind: "video", keyframe: false };
  const audio = { kind: "audio" };

  it("passes everything while the viewer keeps up", () => {
    const accept = boundBacklog(() => 0, { maxBytes: 10 });
    assert.deepEqual([key, p, audio].map(accept), [true, true, true]);
  });

  it("skips a slow viewer to the next keyframe once it caught up", () => {
    let backlog = 0;
    let skips = 0;
    const accept = boundBacklog(() => backlog, { maxBytes: 10, onSkip: () => skips++ });
    assert.equal(accept(key), true);
    backlog = 50;
    assert.deepEqual([p, audio, p].map(accept), [false, false, false]);
    assert.equal(accept(key), false, "still behind at the keyframe");
    backlog = 0;
    assert.deepEqual([p, audio].map(accept), [false, false], "resumes only at a keyframe");
    assert.deepEqual([key, p, audio].map(accept), [true, true, true]);
    assert.equal(skips, 1);
  });
});

