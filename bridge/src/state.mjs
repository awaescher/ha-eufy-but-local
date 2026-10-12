// Observable bridge state shared by the Eufy connector and the HTTP layer.
//
// Emits:
//   "change"            whenever the snapshot changed (debounced by consumers)
//   "event", payload    discrete events (local recording, cloud push, new image)

import { EventEmitter } from "node:events";

export const PHASES = Object.freeze(["idle", "connecting", "tfa", "captcha", "ok", "error"]);

export class BridgeState extends EventEmitter {
  constructor(version) {
    super();
    this.version = version;
    this.reset();
  }

  reset() {
    this.phase = "idle";
    this.message = "";
    this.cloud = false;
    this.stations = {};
    this.cameras = {};
    this.emit("change");
  }

  setPhase(phase, message = "") {
    if (!PHASES.includes(phase)) throw new Error(`Unknown phase: ${phase}`);
    this.phase = phase;
    this.message = message;
    this.emit("change");
  }

  setCloud(connected) {
    this.cloud = connected;
    this.emit("change");
  }

  upsertStation(sn, fields) {
    this.stations[sn] = { name: sn, model: null, p2p: false, guardMode: null, guardModeName: null, ...this.stations[sn], ...fields };
    this.emit("change");
  }

  upsertCamera(sn, fields) {
    this.cameras[sn] = {
      name: sn, model: null, station: null, battery: null, count: null,
      lastEventAt: null, imageAt: null, live: false, codec: null, personAt: null, motionAt: null,
      ...this.cameras[sn], ...fields,
    };
    this.emit("change");
  }

  publish(event) {
    this.emit("event", { ...event, at: new Date().toISOString() });
  }

  snapshot() {
    return {
      version: this.version,
      phase: this.phase,
      message: this.message,
      cloud: this.cloud,
      stations: this.stations,
      cameras: this.cameras,
    };
  }
}
