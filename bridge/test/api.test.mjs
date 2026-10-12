// End-to-end tests: HTTP API + connector + simulated HomeBase.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import jpegJs from "jpeg-js";

import { readConfig } from "../src/config.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { EufyConnector } from "../src/eufy.mjs";
import { findSpsOffset } from "../src/h264.mjs";
import { createApi } from "../src/http.mjs";
import { createSimulator, SIM_CAMERAS, SIM_STATION } from "../src/simulator.mjs";
import { BridgeState } from "../src/state.mjs";

const TOKEN = "test-token";
const CAM = SIM_CAMERAS[0].sn;

async function startBridge({ tfaCode = "123456", token = TOKEN } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "eufy-bridge-"));
  const config = { ...readConfig({}), dataDir, pollSeconds: 0.1, liveIdleSeconds: 0.1, token };
  const state = new BridgeState("test");
  const { lib, simulator } = createSimulator({ tfaCode });
  const connector = new EufyConnector({ state, config, lib });
  const server = createApi({ state, connector, credentials: new CredentialStore(dataDir), simulator, token });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = token ? { authorization: `Bearer ${token}`, "content-type": "application/json" } : { "content-type": "application/json" };
  const api = (path, opts = {}) => fetch(base + path, { ...opts, headers: { ...headers, ...opts.headers } });
  const stop = async () => {
    server.closeAllConnections();
    server.close();
    await connector.close();
  };
  return { base, api, state, connector, simulator, dataDir, stop };
}

const until = async (fn, timeoutMs = 3000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
};

/** Reads Server-Sent Events from a fetch response until `predicate` matches. */
async function readEvents(res, predicate, timeoutMs = 3000) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const timer = setTimeout(() => reader.cancel().catch(() => {}), timeoutMs);
  let buf = "";
  const events = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const name = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (name && data) {
          events.push({ name, data: JSON.parse(data) });
          if (predicate(events.at(-1))) return events;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  throw new Error(`event not received; got ${events.map((e) => e.name + ":" + (e.data.type ?? e.data.phase)).join(", ")}`);
}

describe("bridge API (simulated HomeBase)", () => {
  let b;
  before(async () => {
    b = await startBridge();
  });
  after(async () => {
    await b.stop();
    if (process.env.DEBUG_HANDLES) console.log(process._getActiveHandles().map((h) => h.constructor.name));
  });

  it("answers health without a token", async () => {
    const res = await fetch(`${b.base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.auth, true);
    assert.equal(body.simulator, true);
  });

  it("rejects requests without or with a wrong token", async () => {
    assert.equal((await fetch(`${b.base}/api/state`)).status, 401);
    assert.equal((await fetch(`${b.base}/api/state?token=wrong`)).status, 401);
    assert.equal((await fetch(`${b.base}/api/state?token=${TOKEN}`)).status, 200);
  });

  it("validates the login payload", async () => {
    const res = await b.api("/api/login", { method: "POST", body: JSON.stringify({ email: "a@b.c" }) });
    assert.equal(res.status, 400);
    const bad = await b.api("/api/login", { method: "POST", body: "{nope" });
    assert.equal(bad.status, 400);
  });

  it("logs in with 2FA and loads the devices", async () => {
    const res = await b.api("/api/login", { method: "POST", body: JSON.stringify({ email: "a@b.c", password: "pw", country: "de" }) });
    assert.equal(res.status, 202);
    await until(() => b.state.phase === "tfa");

    await b.api("/api/code", { method: "POST", body: JSON.stringify({ code: "000000" }) });
    await until(() => b.state.phase === "tfa"); // wrong code -> asked again
    await b.api("/api/code", { method: "POST", body: JSON.stringify({ code: "123456" }) });

    await until(() => b.state.phase === "ok" && b.state.stations[SIM_STATION]?.p2p);
    const state = await (await b.api("/api/state")).json();
    assert.equal(Object.keys(state.cameras).length, SIM_CAMERAS.length);
    assert.equal(state.stations[SIM_STATION].guardModeName, "HOME");
    assert.equal(state.cameras[CAM].battery, SIM_CAMERAS[0].battery);
  });

  it("stores credentials but never returns them", async () => {
    const state = JSON.stringify(await (await b.api("/api/state")).json());
    assert.ok(!state.includes("pw"));
    assert.deepEqual(new CredentialStore(b.dataDir).load(), { email: "a@b.c", password: "pw", country: "DE" });
  });

  it("serves the event thumbnail from the local database", async () => {
    await until(() => b.state.cameras[CAM]?.imageAt);
    const res = await b.api(`/api/image/${CAM}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 2)], [0xff, 0xd8]);
    assert.equal((await b.api("/api/image/UNKNOWN")).status, 404);
  });

  it("decodes v2 thumbnails before serving them", async () => {
    const v2Cam = SIM_CAMERAS.find((c) => c.image.endsWith(".v2")).sn;
    await until(() => b.state.cameras[v2Cam]?.imageAt);
    const res = await b.api(`/api/image/${v2Cam}`);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    const jpeg = Buffer.from(await res.arrayBuffer());
    const { width, height } = jpegJs.decode(jpeg);
    assert.deepEqual([width, height], [264, 200]);
  });

  it("reports a new local recording over SSE, then the cloud push", async () => {
    const res = await b.api("/api/events");
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    await b.api(`/api/simulator/${CAM}/event`, { method: "POST" });
    const events = await readEvents(res, (e) => e.name === "event" && e.data.type === "person");
    assert.equal(events[0].name, "state");
    const types = events.filter((e) => e.name === "event").map((e) => e.data.type);
    assert.ok(types.indexOf("local_recording") >= 0 && types.indexOf("local_recording") < types.indexOf("person"));
    assert.equal(events.find((e) => e.data.type === "local_recording").data.device_sn, CAM);
    assert.ok(b.state.cameras[CAM].lastEventAt);
  });

  it("switches the guard mode", async () => {
    const res = await b.api(`/api/station/${SIM_STATION}/guard`, { method: "POST", body: JSON.stringify({ mode: "away" }) });
    assert.equal(res.status, 202);
    await until(() => b.state.stations[SIM_STATION].guardModeName === "AWAY");
    const bad = await b.api(`/api/station/${SIM_STATION}/guard`, { method: "POST", body: JSON.stringify({ mode: "party" }) });
    assert.equal(bad.status, 400);
    const unknown = await b.api(`/api/station/NOPE/guard`, { method: "POST", body: JSON.stringify({ mode: "away" }) });
    assert.equal(unknown.status, 404);
  });

  it("streams H.264 on demand and stops when the viewer leaves", async () => {
    const ctrl = new AbortController();
    const res = await b.api(`/api/stream/${CAM}.h264`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < 20_000) {
      const { value } = await reader.read();
      chunks.push(value);
      size += value.length;
    }
    assert.equal(findSpsOffset(Buffer.concat(chunks)), 0, "stream must start with SPS");
    assert.equal(b.state.cameras[CAM].live, true);
    assert.equal(b.state.cameras[CAM].codec, "h264");
    ctrl.abort();
    await until(() => b.state.cameras[CAM].live === false);
  });

  it("streams MPEG-TS with video and audio by default", async () => {
    const cam = SIM_CAMERAS[2].sn;
    const ctrl = new AbortController();
    const res = await b.api(`/api/stream/${cam}.ts`, { signal: ctrl.signal });
    assert.equal(res.headers.get("content-type"), "video/mp2t");
    const reader = res.body.getReader();
    const pids = new Set();
    let pending = Buffer.alloc(0);
    while (!(pids.has(0x100) && pids.has(0x101))) {
      const { value } = await reader.read();
      pending = Buffer.concat([pending, value]);
      while (pending.length >= 188) {
        assert.equal(pending[0], 0x47);
        pids.add(((pending[1] & 0x1f) << 8) | pending[2]);
        pending = pending.subarray(188);
      }
    }
    ctrl.abort();
    await until(() => !b.state.cameras[cam].live);
  });

  it("switches the HomeBase to the newest camera and refuses the displaced one", async () => {
    const CAM2 = SIM_CAMERAS[1].sn;
    const readSome = async (res) => {
      const reader = res.body.getReader();
      const { value } = await reader.read();
      return { reader, value };
    };
    const first = new AbortController();
    const one = await b.api(`/api/stream/${CAM}`, { signal: first.signal });
    const { reader: oneReader } = await readSome(one);
    await until(() => b.state.cameras[CAM].live);

    const second = new AbortController();
    const two = await b.api(`/api/stream/${CAM2}`, { signal: second.signal });
    assert.equal(two.status, 200);
    await readSome(two);
    await until(() => b.state.cameras[CAM2].live && !b.state.cameras[CAM].live);

    // The first camera's stream was ended, and reconnecting to it is refused for now.
    let done = false;
    while (!done) ({ done } = await oneReader.read());
    const again = await b.api(`/api/stream/${CAM}`);
    assert.equal(again.status, 409);
    assert.equal(b.state.cameras[CAM2].live, true, "the refused reconnect must not displace the new camera");

    second.abort();
    first.abort();
    await until(() => !b.state.cameras[CAM2].live);
  });

  it("rejects streams for unknown cameras", async () => {
    assert.equal((await b.api("/api/stream/UNKNOWN")).status, 404);
  });

  it("has no captcha when none was requested", async () => {
    assert.equal((await b.api("/api/captcha")).status, 404);
  });

  it("returns 404 for unknown routes", async () => {
    assert.equal((await b.api("/api/nope")).status, 404);
    assert.equal((await fetch(`${b.base}/other`)).status, 404);
  });
});

describe("bridge API without token and 2FA", () => {
  it("works open when no token is configured", async () => {
    const b = await startBridge({ tfaCode: null, token: "" });
    try {
      await b.api("/api/login", { method: "POST", body: JSON.stringify({ email: "a@b.c", password: "pw" }) });
      await until(() => b.state.phase === "ok");
      assert.equal((await fetch(`${b.base}/api/state`)).status, 200);
    } finally {
      await b.stop();
    }
  });

  it("rejects a code when none was requested", async () => {
    const b = await startBridge({ tfaCode: null, token: "" });
    try {
      await b.api("/api/code", { method: "POST", body: JSON.stringify({ code: "1" }) });
      await until(() => b.state.phase === "error");
      assert.match(b.state.message, /No code requested/);
    } finally {
      await b.stop();
    }
  });
});
