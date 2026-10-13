// Connector behaviour on error paths, driven by a hand-rolled fake client.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readConfig } from "../src/config.mjs";
import { EufyConnector } from "../src/eufy.mjs";
import { GuardMode, P2PConnectionType, PropertyName } from "../src/simulator.mjs";
import { BridgeState } from "../src/state.mjs";

const tick = () => new Promise((r) => setImmediate(r));

function setup({ initialize, env = {} } = {}) {
  const clients = [];
  class FakeClient extends EventEmitter {
    constructor(cfg) {
      super(); this.cfg = cfg; this.connectCalls = []; this.closed = false; this.calls = [];
      // The parts of eufy-security-client that reach Eufy's cloud after login.
      this.mqttService = { connect: () => this.calls.push("mqtt") };
      this.pushService = { close: () => this.calls.push("push close") };
      this.persistentData = {};
    }
    async registerPushNotifications() { this.calls.push("push open"); }
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
  const config = { ...readConfig(env), dataDir: mkdtempSync(join(tmpdir(), "eufy-conn-")), pollSeconds: 60 };
  const logs = [];
  const log = (tag, msg) => logs.push(`[${tag}] ${msg}`);
  const connector = new EufyConnector({ state, config, log, lib: { EufySecurity: FakeClient, P2PConnectionType, GuardMode, PropertyName } });
  return { state, connector, clients, logs };
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

  it("logs property values only with BRIDGE_DEBUG", async () => {
    for (const [env, expected] of [[{}, 0], [{ BRIDGE_DEBUG: "1" }, 1]]) {
      const { connector, clients, logs } = setup({ env });
      await connector.start({ email: "a", password: "b" });
      clients[0].emit("device added", camera());
      clients[0].emit("device property changed", camera(), "wifiRssi", -56);
      assert.equal(logs.filter((l) => l.includes("property Cam wifiRssi=-56")).length, expected);
      await connector.close();
    }
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

  it("keeps a v2 thumbnail it cannot decode and does not announce it", async () => {
    const { state, connector, clients } = setup();
    await connector.start({ email: "a", password: "b" });
    const events = [];
    state.on("event", (e) => events.push(e));
    connector.images.owner.set("/media/x/1_c00.jpg", "C1");
    const blob = Buffer.from("v2_eufysecurity:T8000TEST00000002:0000000000:broken");
    clients[0].emit("station image download", station(), "/media/x/1_c00.jpg", { data: blob });
    assert.deepEqual(readFileSync(join(connector.config.dataDir, "undecoded", "1_c00.jpg.v2")), blob);
    assert.equal(connector.images.get("C1"), null);
    assert.deepEqual(events, []);
  });

  it("gives up on a database query the HomeBase does not answer, ignoring other stations", async () => {
    const { connector, clients } = setup();
    await connector.start({ email: "a", password: "b" });
    const st = { ...station("S1"), databaseQueryLocal() { this.asked = true; }, databaseQueryByDate() {} };
    clients[0].getStation = async () => st;
    const pending = connector.stationEvents("S1", new Date(0), new Date(), 30);
    await tick();
    clients[0].emit("station database query local", station("OTHER"), 0, []);
    await assert.rejects(pending, /did not answer/);
    assert.equal(st.asked, true);
    assert.equal(clients[0].listenerCount("station database query local"), 0, "listener removed");
  });

  it("falls back to the by-date query when the local query returns nothing", async () => {
    const { connector, clients } = setup();
    await connector.start({ email: "a", password: "b" });
    const st = {
      ...station("S1"),
      databaseQueryLocal() { setImmediate(() => clients[0].emit("station database query local", st, 0, [])); },
      databaseQueryByDate() { setImmediate(() => clients[0].emit("station database query by date", st, 0, [{ record_id: 7 }])); },
    };
    clients[0].getStation = async () => st;
    const result = await connector.stationEvents("S1", new Date(0), new Date(), 500);
    assert.deepEqual(result, { query: "byDate", returnCode: 0, records: [{ record_id: 7 }], localReturnCode: 0 });
  });

  it("never starts Eufy's MQTT and opens push only while enabled", async () => {
    const { connector, clients } = setup();
    await connector.start({ email: "a", password: "b" });
    const c = clients[0];
    // What the library does after every login:
    c.mqttService.connect("id", "android", "api", "mail");
    await c.registerPushNotifications(undefined, undefined);
    assert.deepEqual(c.calls, [], "neither MQTT nor push opened while push is off");

    connector.state.setPhase("ok");
    await connector.setCloudPush(true);
    assert.deepEqual(c.calls, ["push open"]);
    await connector.setCloudPush(true); // no change, no second open
    await connector.setCloudPush(false);
    assert.deepEqual(c.calls, ["push open", "push close"]);
    assert.equal(connector.state.cloudPush, false);
  });

  it("asks the HomeBase for the camera settings periodically while P2P is connected", async () => {
    const { connector, clients } = setup();
    connector.config.refreshSeconds = 0.02;
    await connector.start({ email: "a", password: "b" });
    let asked = 0;
    const st = { ...station("S1"), getCameraInfo: () => asked++ };
    clients[0].emit("station added", st);
    clients[0].emit("station connect", st);
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(asked >= 3, `asked ${asked} times`);
    clients[0].emit("station close", st);
    const after = asked;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(asked, after, "stops when P2P closes");
    connector.config.refreshSeconds = 0;
    clients[0].emit("station connect", st);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(asked, after, "0 disables the refresh");
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
