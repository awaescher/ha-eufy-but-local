// Connects to the HomeBase through eufy-security-client (or the simulator) and
// translates its events into the bridge state.
//
// Local (LAN only, P2P mode ONLY_LOCAL): event database polling, thumbnails,
// livestream, guard mode. Cloud: login + device list on start, optional
// person/motion push notifications.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { decodeImageV2, isV2Image } from "./image-v2.mjs";
import { ImageStore } from "./images.mjs";
import { LiveStreams } from "./live.mjs";
import { CAMERA_PROPERTIES, HUMANS_ONLY, STATION_PROPERTIES, pick } from "./properties.mjs";

export class EufyConnector {
  /**
   * @param {object} opts
   * @param {import("./state.mjs").BridgeState} opts.state
   * @param {object} opts.config     see config.mjs
   * @param {object} opts.lib        { EufySecurity, P2PConnectionType, GuardMode, PropertyName }
   * @param {(tag: string, msg: string) => void} [opts.log]
   */
  constructor({ state, config, lib, log = () => {} }) {
    this.state = state;
    this.config = config;
    this.lib = lib;
    this.log = log;
    this.client = null;
    this.openPush = null;
    this.state.setCloudPush(Boolean(config.cloudPush));
    this.pending = null; // "tfa" | { captchaId }
    this.captcha = null; // data URI
    this.stations = new Map();
    this.pollers = new Map();
    this.pathStation = new Map();

    this.images = new ImageStore({
      download: (path) => this.pathStation.get(path).downloadImage(path),
      log: (m) => this.log("local", m),
    });
    this.live = new LiveStreams({
      start: (sn) => this.client.startStationLivestream(sn),
      stop: (sn) => this.client.stopStationLivestream(sn),
      idleMs: config.liveIdleSeconds * 1000,
      onChange: (sn, live) => this.state.upsertCamera(sn, { live }),
      log: (m) => this.log("local", m),
      stationOf: (sn) => this.state.cameras[sn]?.station ?? sn,
    });
  }

  /** Keeps a thumbnail the v2 decoder could not handle, for diagnosis; it never leaves the host. */
  #keepUndecoded(path, data) {
    const dir = join(this.config.dataDir, "undecoded");
    const file = join(dir, basename(path).replace(/[^\w.-]/g, "_") + ".v2");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, data);
      this.log("local", `could not decode v2 thumbnail ${path}, kept as ${file}`);
    } catch (err) {
      this.log("local", `could not decode v2 thumbnail ${path} (${err.message})`);
    }
  }

  get connected() {
    return this.client !== null;
  }

  guardModeName(mode) {
    return mode === undefined || mode === null ? null : this.lib.GuardMode[mode] ?? String(mode);
  }

  guardModeValue(name) {
    if (typeof name === "number") return name;
    const v = this.lib.GuardMode[String(name ?? "").toUpperCase()];
    return typeof v === "number" ? v : undefined;
  }

  async start(credentials) {
    await this.close();
    this.state.reset();
    this.state.setPhase("connecting", "Logging in to Eufy");
    const { EufySecurity, P2PConnectionType } = this.lib;
    const { stationSerial, stationIp } = this.config;
    try {
      this.client = await EufySecurity.initialize(
        {
          username: credentials.email,
          password: credentials.password,
          country: credentials.country || "DE",
          // Kept from the old name: changing it makes Eufy ask for a new 2FA code.
          trustedDeviceName: "eufy-local-bridge",
          persistentDir: this.config.dataDir,
          p2pConnectionSetup: P2PConnectionType.ONLY_LOCAL,
          pollingIntervalMinutes: 0, // no periodic cloud polling
          eventDurationSeconds: 10,
          acceptInvitations: true,
          ...(stationSerial && stationIp ? { stationIPAddresses: { [stationSerial]: stationIp } } : {}),
        },
        quietLogger,
      );
    } catch (err) {
      this.client = null;
      this.state.setPhase("error", `Eufy cloud not reachable: ${err.message}`);
      this.log("cloud", this.state.message);
      return;
    }
    this.client.setCameraMaxLivestreamDuration(this.config.liveMaxSeconds);
    this.#limitCloud(this.client);
    this.#wire(this.client);
    try {
      await this.client.connect();
    } catch (err) {
      this.state.setPhase("error", err.message);
    }
  }

  /**
   * eufy-security-client opens FCM push and Eufy's MQTT after every login and has no option
   * to skip them. MQTT only serves locks and appliances, so it never starts; push starts only
   * while the user enabled it (AGENTS.md rule 0).
   */
  #limitCloud(client) {
    if (client.mqttService) client.mqttService.connect = () => {};
    if (typeof client.registerPushNotifications !== "function") return;
    const register = client.registerPushNotifications.bind(client);
    this.openPush = () => register(client.persistentData?.push_credentials, client.persistentData?.push_persistentIds);
    client.registerPushNotifications = async (...args) => {
      if (this.state.cloudPush) await register(...args);
    };
  }

  /** Switches the cloud push channel (person/motion notifications) on or off at runtime. */
  async setCloudPush(enabled) {
    const changed = enabled !== this.state.cloudPush;
    this.state.setCloudPush(enabled);
    if (!changed || !this.client || this.state.phase !== "ok") return;
    if (enabled) await this.openPush?.();
    else this.client.pushService?.close();
    this.log("cloud", `push notifications ${enabled ? "enabled" : "disabled"}`);
  }

  async submitCode(code) {
    if (!this.client || !this.pending) throw new Error("No code requested");
    const pending = this.pending;
    this.pending = null;
    this.state.setPhase("connecting", "Verifying code");
    if (pending === "tfa") await this.client.connect({ verifyCode: code, force: false });
    else await this.client.connect({ captcha: { captchaId: pending.captchaId, captchaCode: code }, force: false });
  }

  /** Everything the library knows about a device: property values, writable ones, commands. */
  async deviceInfo(sn) {
    if (!this.client) throw new Error("Not connected");
    const device = await this.client.getDevice(sn);
    const metadata = device.getPropertiesMetadata();
    return {
      properties: device.getProperties(),
      writable: Object.keys(metadata).filter((name) => metadata[name].writeable),
      commands: device.getCommands(),
    };
  }

  /**
   * Recordings in the HomeBase database (P2P, local) between `start` and `end`. Tries
   * `databaseQueryLocal` (at most 20 records, with detection details) and falls back to the
   * older `databaseQueryByDate` when that returns nothing.
   */
  async stationEvents(stationSn, start, end, timeoutMs = 15_000) {
    if (!this.client) throw new Error("Not connected");
    const station = await this.client.getStation(stationSn);
    const serials = Object.entries(this.state.cameras)
      .filter(([, cam]) => cam.station === stationSn)
      .map(([sn]) => sn);
    const local = await this.#query(stationSn, "station database query local", timeoutMs, () =>
      station.databaseQueryLocal(serials, start, end),
    );
    if (local.records?.length) return { query: "local", ...local };
    const byDate = await this.#query(stationSn, "station database query by date", timeoutMs, () =>
      station.databaseQueryByDate(serials, start, end),
    );
    return { query: "byDate", ...byDate, localReturnCode: local.returnCode };
  }

  /** Sends a request to a station and resolves with its answer event (`pick` shapes it). */
  #query(stationSn, eventName, timeoutMs, send, pick = (returnCode, records) => ({ returnCode, records })) {
    return new Promise((resolve, reject) => {
      const client = this.client;
      const done = () => {
        clearTimeout(timer);
        client.removeListener(eventName, onAnswer);
      };
      const onAnswer = (st, ...args) => {
        if (st.getSerial() !== stationSn) return;
        done();
        resolve(pick(...args));
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`the HomeBase did not answer (${eventName})`));
      }, timeoutMs);
      client.on(eventName, onAnswer);
      Promise.resolve()
        .then(send)
        .catch((err) => {
          done();
          reject(err);
        });
    });
  }

  /**
   * Writes one property of a camera (`kind` "device") or HomeBase (`kind` "station") over P2P
   * and waits for the HomeBase's command result. `ms` tells how long the HomeBase took, which
   * shows whether it had to wake the camera.
   */
  async setProperty(kind, sn, name, value, timeoutMs = 15_000) {
    if (!this.client) throw new Error("Not connected");
    const stationSn = kind === "station" ? sn : this.state.cameras[sn]?.station;
    const started = Date.now();
    const write = () =>
      kind === "station" ? this.client.setStationProperty(sn, name, value) : this.client.setDeviceProperty(sn, name, value);
    const result = await this.#query(stationSn, "station command result", timeoutMs, async () => {
      try {
        await write();
      } catch (err) {
        // The library rejects unknown, read-only or out-of-range values before sending.
        throw new RangeError(err.message);
      }
    }, (r) => ({ returnCode: r?.return_code, commandType: r?.command_type }));
    const ms = Date.now() - started;
    const label = kind === "station" ? this.state.stations[sn]?.name : this.state.cameras[sn]?.name;
    this.log("local", `set ${label ?? sn} ${name}=${JSON.stringify(value)}: return code ${result.returnCode} after ${ms} ms`);
    return { ...result, ms };
  }

  /**
   * Runs a command over P2P and waits for the HomeBase's result. Camera (`kind` "device"):
   * `alarm` {seconds}, `stopAlarm`, `snooze` {seconds}. HomeBase (`kind` "station"): `alarm`
   * {seconds}, `stopAlarm`, `reboot`.
   */
  async command(kind, sn, name, { seconds } = {}, timeoutMs = 15_000) {
    if (!this.client) throw new Error("Not connected");
    const stationSn = kind === "station" ? sn : this.state.cameras[sn]?.station;
    const station = await this.client.getStation(stationSn);
    const device = kind === "device" ? await this.client.getDevice(sn) : null;
    const duration = Math.round(Number(seconds));
    const needsSeconds = name === "alarm" || name === "snooze";
    if (needsSeconds && !(duration > 0 && duration <= 3600)) throw new RangeError("seconds: 1..3600");
    const run = {
      device: {
        alarm: () => station.triggerDeviceAlarmSound(device, duration),
        stopAlarm: () => station.resetDeviceAlarmSound(device),
        snooze: () => station.snooze(device, { snooze_time: duration }),
      },
      station: {
        alarm: () => station.triggerStationAlarmSound(duration),
        stopAlarm: () => station.resetStationAlarmSound(),
        reboot: () => station.rebootHUB(),
      },
    }[kind]?.[name];
    if (!run) throw new RangeError(`unknown command ${name}`);
    const started = Date.now();
    const result = await this.#query(stationSn, "station command result", timeoutMs, run, (r) => ({
      returnCode: r?.return_code,
      commandType: r?.command_type,
    }));
    this.log("local", `command ${name} on ${sn}: return code ${result.returnCode} after ${Date.now() - started} ms`);
    return { ...result, ms: Date.now() - started };
  }

  async setGuardMode(stationSn, mode) {
    const value = this.guardModeValue(mode);
    if (value === undefined) throw new RangeError(`Unknown guard mode: ${mode}`);
    if (!this.client) throw new Error("Not connected");
    await this.client.setStationProperty(stationSn, this.lib.PropertyName.StationGuardMode, value);
  }

  async close() {
    for (const t of this.pollers.values()) clearInterval(t);
    this.pollers.clear();
    this.live.close();
    this.images.close();
    if (this.client) {
      try { this.client.close(); } catch { /* ignore */ }
    }
    this.client = null;
    this.pending = null;
    this.captcha = null;
  }

  #wire(client) {
    const { PropertyName } = this.lib;
    const s = this.state;
    // Ignore late events from a client that has been closed or replaced.
    const c = { on: (name, fn) => client.on(name, (...args) => { if (this.client === client) fn(...args); }) };

    // --- login
    c.on("tfa request", () => {
      this.pending = "tfa";
      s.setPhase("tfa", "Verification code required");
    });
    c.on("captcha request", (captchaId, image) => {
      this.pending = { captchaId };
      this.captcha = image;
      s.setPhase("captcha", "Captcha required");
    });
    c.on("connect", () => {
      this.captcha = null;
      s.setCloud(true);
      s.setPhase("ok", "Logged in");
      this.log("cloud", "login ok");
    });
    c.on("close", () => s.setCloud(false));
    c.on("connection error", (err) => this.log("cloud", `error: ${err?.message ?? err}`));

    // --- devices (from the cloud device list)
    c.on("station added", (st) => {
      this.stations.set(st.getSerial(), st);
      const mode = st.getPropertyValue(PropertyName.StationGuardMode);
      s.upsertStation(st.getSerial(), {
        name: st.getName(),
        model: st.getModel(),
        guardMode: mode ?? null,
        guardModeName: this.guardModeName(mode),
        properties: pick(st.getProperties?.(), STATION_PROPERTIES),
      });
      this.log("cloud", `station ${st.getName()} (${st.getSerial()}, ${st.getModel()})`);
    });
    c.on("device added", (d) => {
      if (!d.isCamera()) return;
      s.upsertCamera(d.getSerial(), {
        name: d.getName(),
        model: d.getModel(),
        station: d.getStationSerial(),
        battery: d.hasProperty(PropertyName.DeviceBattery) ? d.getPropertyValue(PropertyName.DeviceBattery) ?? null : null,
        properties: pick(d.getProperties?.(), CAMERA_PROPERTIES),
      });
      this.log("cloud", `camera ${d.getName()} (${d.getSerial()}, ${d.getModel()})`);
    });

    // --- local P2P connection + event database polling
    c.on("station connect", (st) => {
      const sn = st.getSerial();
      const mode = st.getPropertyValue(PropertyName.StationGuardMode);
      s.upsertStation(sn, {
        p2p: true,
        ...(mode !== undefined && mode !== null ? { guardMode: mode, guardModeName: this.guardModeName(mode) } : {}),
      });
      this.log("local", `P2P connected to ${st.getName()} (LAN only)`);
      clearInterval(this.pollers.get(sn));
      const poll = () => {
        try { st.databaseQueryLatestInfo(); } catch (err) { this.log("local", `event database query failed: ${err.message}`); }
      };
      poll();
      this.pollers.set(sn, setInterval(poll, this.config.pollSeconds * 1000));
    });
    const disconnected = (st, reason) => {
      const sn = st.getSerial();
      clearInterval(this.pollers.get(sn));
      this.pollers.delete(sn);
      s.upsertStation(sn, { p2p: false });
      this.log("local", `P2P to ${st.getName()} closed${reason ? `: ${reason}` : ""}`);
    };
    c.on("station close", (st) => disconnected(st));
    c.on("station connection error", (st, err) => disconnected(st, err?.message));

    c.on("station database query latest", (st, _rc, rows) => {
      for (const row of rows ?? []) {
        const cam = s.cameras[row.device_sn];
        if (!cam) continue;
        const previous = cam.count;
        const isNew = previous !== null && row.event_count > previous;
        s.upsertCamera(row.device_sn, {
          count: row.event_count,
          ...(isNew ? { lastEventAt: new Date().toISOString() } : {}),
        });
        if (isNew) {
          this.log("local", `new event: ${cam.name} (+${row.event_count - previous})`);
          s.publish({ type: "local_recording", device_sn: row.device_sn, count: row.event_count });
          // A camera set to detect humans only records only when it sees a person (ADR 0012).
          if (cam.properties?.motionDetectionType === HUMANS_ONLY) {
            s.upsertCamera(row.device_sn, { personAt: new Date().toISOString() });
            s.publish({ type: "person", device_sn: row.device_sn, source: "local" });
          }
        }
        if (row.crop_local_path) {
          this.pathStation.set(row.crop_local_path, st);
          this.images.request(row.device_sn, row.crop_local_path, { force: isNew });
        }
      }
    });

    c.on("station image download", (_st, path, image) => {
      let data = image?.data;
      let mime = image?.type?.mime;
      // The library decrypts the older "eufysecurity:" format only and hands v2 over as is.
      if (data && isV2Image(data)) {
        data = decodeImageV2(data);
        mime = "image/jpeg";
        if (!data) this.#keepUndecoded(path, image.data);
      }
      const sn = this.images.received(path, data, mime);
      if (sn && data) {
        s.upsertCamera(sn, { imageAt: new Date().toISOString() });
        s.publish({ type: "image", device_sn: sn });
      }
    });

    // --- livestream
    c.on("station livestream start", (_st, device, meta, video, audio) => {
      const sn = device.getSerial();
      const codec = meta.videoCodec === 0 ? "h264" : meta.videoCodec === 1 ? "h265" : "unknown";
      // AudioCodec: 1 AAC, 2 AAC_LC, 3 AAC_ELD; 0 none, -1 unknown.
      const hasAudio = [1, 2, 3].includes(meta.audioCodec) && Boolean(audio);
      s.upsertCamera(sn, { codec });
      this.live.started(sn, { audio: hasAudio, fps: meta.videoFPS });
      this.log("local", `livestream ${device.getName()} running (${codec}, ${meta.videoWidth}x${meta.videoHeight}, ${hasAudio ? "with" : "no"} audio)`);
      video.on("data", (chunk) => this.live.feed(sn, chunk));
      video.on("end", () => this.live.ended(sn));
      if (hasAudio) audio.on("data", (chunk) => this.live.feedAudio(sn, chunk));
    });
    c.on("station livestream stop", (_st, device) => {
      this.live.ended(device.getSerial());
      this.log("local", `livestream ${device.getName()} stopped`);
    });

    // --- guard mode / battery
    const guard = (st, mode) => {
      if (mode === undefined || mode === null) return;
      s.upsertStation(st.getSerial(), { guardMode: mode, guardModeName: this.guardModeName(mode) });
    };
    c.on("station guard mode", guard);
    c.on("station property changed", (st, name, value) => {
      if (name === PropertyName.StationGuardMode) guard(st, value);
      if (STATION_PROPERTIES.includes(name) && s.stations[st.getSerial()]) {
        s.upsertStation(st.getSerial(), { properties: { [name]: value } });
      }
    });
    c.on("device property changed", (d, name, value) => {
      if (!s.cameras[d.getSerial()]) return;
      if (name === PropertyName.DeviceBattery) s.upsertCamera(d.getSerial(), { battery: value });
      if (CAMERA_PROPERTIES.includes(name)) s.upsertCamera(d.getSerial(), { properties: { [name]: value } });
      // Shows which changes reach the bridge locally (e.g. made in the Eufy app).
      if (name !== "picture") this.log("local", `property ${d.getName()} ${name}=${JSON.stringify(value)}`);
    });

    // --- cloud push (optional, off by default: tells person vs. motion)
    c.on("device person detected", (d, on) => {
      if (!on || !s.cloudPush || !s.cameras[d.getSerial()]) return;
      s.upsertCamera(d.getSerial(), { personAt: new Date().toISOString() });
      s.publish({ type: "person", device_sn: d.getSerial(), source: "cloud" });
    });
    c.on("device motion detected", (d, on) => {
      if (!on || !s.cloudPush || !s.cameras[d.getSerial()]) return;
      s.upsertCamera(d.getSerial(), { motionAt: new Date().toISOString() });
      s.publish({ type: "motion", device_sn: d.getSerial(), source: "cloud" });
    });
  }
}

const quietLogger = {
  trace() {},
  debug() {},
  info() {},
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};
