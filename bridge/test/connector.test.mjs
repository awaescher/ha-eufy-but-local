// Connector behaviour on error paths, driven by a hand-rolled fake client.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readConfig } from "../src/config.mjs";
import { EufyConnector } from "../src/eufy.mjs";
import { GuardMode, P2PConnectionType, PropertyName } from "../src/simulator.mjs";
import { BridgeState } from "../src/state.mjs";

const tick = () => new Promise((r) => setImmediate(r));

function setup({ initialize } = {}) {
  const clients = [];
  class FakeClient extends EventEmitter {
    constructor(cfg) { super(); this.cfg = cfg; this.connectCalls = []; this.closed = false; }
    static async initialize(cfg) {
      if (initialize) await initialize(cfg);
      const c = new FakeClient(cfg);
      clients.push(c);
      return c;
    }
    setCameraMaxLivestreamDuration() {}
    async connect(opts) { this.connectCalls.push(opts); }
    close() { this.closed = true; }
  }
  const state = new BridgeState("test");
  const config = { ...readConfig({}), dataDir: mkdtempSync(join(tmpdir(), "eufy-conn-")), pollSeconds: 60 };
  const connector = new EufyConnector({ state, config, lib: { EufySecurity: FakeClient, P2PConnectionType, GuardMode, PropertyName } });
  return { state, connector, clients };
}

const station = (sn = "S1") => ({
  getSerial: () => sn, getName: () => "HB", getModel: () => "T8010",
  getPropertyValue: () => undefined, databaseQueryLatestInfo() { this.polled = (this.polled ?? 0) + 1; },
});
const camera = (sn = "C1") => ({
  getSerial: () => sn, getName: () => "Cam", getModel: () => "T8113", getStationSerial: () => "S1",
  isCamera: () => true, hasProperty: () => true, getPropertyValue: () => 40,
});

describe("EufyConnector", () => {
  it("forces LAN-only P2P and disables cloud polling", async () => {
    const { connector, clients } = setup();
    await connector.start({ email: "a", password: "b" });
    assert.equal(clients[0].cfg.p2pConnectionSetup, P2PConnectionType.ONLY_LOCAL);
    assert.equal(clients[0].cfg.pollingIntervalMinutes, 0);
    await connector.close();
  });

  it("reports an unreachable cloud as error", async () => {
    const { state, connector } = setup({ initialize: async () => { throw new Error("ENOTFOUND"); } });
    await connector.start({ email: "a", password: "b" });
    assert.equal(state.phase, "error");
    assert.match(state.message, /ENOTFOUND/);
    assert.equal(connector.connected, false);
  });

  it("handles the captcha flow", async () => {
    const { state, connector, clients } = setup();
    await connector.start({ email: "a", password: "b" });
    clients[0].emit("captcha request", "cid-1", "data:image/png;base64,AAAA");
    assert.equal(state.phase, "captcha");
    assert.equal(connector.captcha, "data:image/png;base64,AAAA");
    await connector.submitCode("XYZ");
    assert.deepEqual(clients[0].connectCalls.at(-1), { captcha: { captchaId: "cid-1", captchaCode: "XYZ" }, force: false });
    clients[0].emit("connect");
    assert.equal(state.phase, "ok");
    assert.equal(connector.captcha, null);
    await connector.close();
  });

  it("marks the station offline when the P2P connection drops", async () => {
    const { state, connector, clients } = setup();
    await connector.start({ email: "a", password: "b" });
    const st = station();
    clients[0].emit("station added", st);
    clients[0].emit("station connect", st);
    assert.equal(state.stations.S1.p2p, true);
    assert.equal(st.polled, 1);
    clients[0].emit("station connection error", st, new Error("timeout"));
    assert.equal(state.stations.S1.p2p, false);
    assert.equal(connector.pollers.size, 0);
    await connector.close();
  });

  it("tracks battery changes and ignores unknown devices", async () => {
    const { state, connector, clients } = setup();
    await connector.start({ email: "a", password: "b" });
    clients[0].emit("device added", camera());
    clients[0].emit("device property changed", camera(), PropertyName.DeviceBattery, 12);
    clients[0].emit("device property changed", camera("OTHER"), PropertyName.DeviceBattery, 99);
    clients[0].emit("device person detected", camera("OTHER"), true);
    assert.equal(state.cameras.C1.battery, 12);
    assert.equal(state.cameras.OTHER, undefined);
    await connector.close();
  });

  it("ignores events from a client that was replaced", async () => {
    const { state, connector, clients } = setup();
    await connector.start({ email: "a", password: "b" });
    await connector.start({ email: "a", password: "b" });
    assert.equal(clients[0].closed, true);
    clients[0].emit("station added", station("OLD"));
    clients[0].emit("station connect", station("OLD"));
    await tick();
    assert.equal(state.stations.OLD, undefined);
    assert.equal(connector.pollers.size, 0);
    await connector.close();
  });

  it("translates guard modes and rejects unknown ones", async () => {
    const { connector } = setup();
    assert.equal(connector.guardModeValue("away"), GuardMode.AWAY);
    assert.equal(connector.guardModeValue(63), 63);
    assert.equal(connector.guardModeName(GuardMode.HOME), "HOME");
    assert.equal(connector.guardModeName(null), null);
    await assert.rejects(connector.setGuardMode("S1", "party"), RangeError);
    await assert.rejects(connector.setGuardMode("S1", "away"), /Not connected/);
  });
});
