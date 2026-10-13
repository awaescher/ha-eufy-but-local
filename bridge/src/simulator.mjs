// A simulated HomeBase with three cameras. It implements the subset of the
// eufy-security-client API the connector uses, so the bridge, the Home Assistant
// integration and the dev environment can be exercised without real hardware.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "simulator-assets");

export const GuardMode = Object.freeze({
  AWAY: 0, HOME: 1, SCHEDULE: 2, CUSTOM1: 3, CUSTOM2: 4, CUSTOM3: 5, OFF: 6, GEO: 47, DISARMED: 63,
  0: "AWAY", 1: "HOME", 2: "SCHEDULE", 3: "CUSTOM1", 4: "CUSTOM2", 5: "CUSTOM3", 6: "OFF", 47: "GEO", 63: "DISARMED",
});
export const P2PConnectionType = Object.freeze({ ONLY_LOCAL: 1, QUICKEST: 2 });
export const PropertyName = Object.freeze({ DeviceBattery: "battery", StationGuardMode: "guardMode" });

export const SIM_STATION = "T8010SIM0000001";
export const SIM_CAMERAS = Object.freeze([
  { sn: "T8113SIM0000001", name: "Front door", model: "T8113", image: "cam1.jpg", battery: 87, count: 120 },
  // Garden detects humans only, so its local recordings count as persons (ADR 0012).
  { sn: "T8113SIM0000002", name: "Garden", model: "T8113", image: "cam2.jpg", battery: 55, count: 42, humansOnly: true },
  // Garage delivers the newer v2 thumbnail format, like real HomeBase 2 units do.
  { sn: "T8142SIM0000003", name: "Garage", model: "T8142", image: "cam3.v2", battery: 19, count: 7 },
]);

/**
 * Splits an Annex-B stream into frames, roughly like the camera delivers them:
 * a keyframe chunk (SPS + PPS + IDR slice) or a single P-frame slice.
 */
// Writable camera settings with the values a real eufyCam 2C reports.
const SIM_CAMERA_SETTINGS = Object.freeze({
  enabled: true, motionDetection: true, motionDetectionSensitivity: 5, motionDetectionType: 2,
  light: false, lightSettingsBrightnessManual: 100, nightvision: 1, statusLed: false, microphone: true,
  speaker: true, speakerVolume: 93, audioRecording: true, antitheftDetection: false,
  recordingClipLength: 60, recordingRetriggerInterval: 5, recordingEndClipMotionStops: false,
  powerWorkingMode: 1, powerSource: 0, notificationType: 2, watermark: 1,
});
const SIM_STATION_SETTINGS = Object.freeze({ alarmVolume: 26, promptVolume: 20, alarmTone: 1, timeFormat: 1 });

export function splitFrames(buf) {
  const starts = [];
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
      const type = buf[i + 4] & 0x1f;
      if (type === 7 || type === 1) starts.push(i); // SPS opens a keyframe, type 1 a P-frame
    }
  }
  return starts.map((s, k) => buf.subarray(s, k + 1 < starts.length ? starts[k + 1] : buf.length));
}

/** Splits an ADTS stream into frames (the header carries each frame's length). */
export function splitAdts(buf) {
  const frames = [];
  for (let i = 0; i + 7 <= buf.length; ) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xf0) !== 0xf0) break;
    const length = ((buf[i + 3] & 0x03) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
    if (length < 7) break;
    frames.push(buf.subarray(i, i + length));
    i += length;
  }
  return frames;
}

/**
 * Builds a module compatible with what EufyConnector expects from
 * eufy-security-client.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.tfaCode]          require this 2FA code on first login (null = no 2FA)
 * @param {number} [opts.eventIntervalSeconds]  emit random events periodically (0 = off)
 * @param {number} [opts.fps]
 */
export function createSimulator({ tfaCode = "123456", eventIntervalSeconds = 0, fps = 15 } = {}) {
  const video = readFileSync(join(ASSETS, "stream.h264"));
  const frames = splitFrames(video);
  // AAC-LC, 16 kHz, mono like the real cameras: one frame = 1024 samples = 64 ms.
  const audioFrames = splitAdts(readFileSync(join(ASSETS, "audio.aac")));
  const images = Object.fromEntries(SIM_CAMERAS.map((c) => [c.sn, readFileSync(join(ASSETS, c.image))]));
  const imageType = (sn) =>
    SIM_CAMERAS.find((c) => c.sn === sn)?.image.endsWith(".v2")
      ? { ext: "unknown", mime: "application/octet-stream" }
      : { ext: "jpg", mime: "image/jpeg" };
  let instance = null;

  const station = {
    guard: GuardMode.HOME,
    getSerial: () => SIM_STATION,
    getName: () => "HomeBase 2 (simulated)",
    getModel: () => "T8010",
    getPropertyValue: (name) => (name === PropertyName.StationGuardMode ? station.guard : undefined),
    settings: { ...SIM_STATION_SETTINGS },
    getProperties: () => ({ ...station.settings, alarm: false, currentMode: station.guard, sdStatus: 0, softwareVersion: "3.2.4.6" }),
    // Like the real HomeBase: settings changed in the Eufy app are not pushed; they show up when
    // the camera info is requested.
    getCameraInfo: () => {
      for (const c of cameras) {
        for (const [name, value] of Object.entries(c.settings)) {
          if (c.reported[name] !== value) {
            c.reported[name] = value;
            setTimeout(() => instance?.emit("device property changed", devices.find((d) => d.getSerial() === c.sn), name, value), 5);
          }
        }
      }
    },
    // Commands answer like the real HomeBase: with a command result.
    triggerDeviceAlarmSound: () => station.ack(),
    resetDeviceAlarmSound: () => station.ack(),
    snooze: () => station.ack(),
    triggerStationAlarmSound: () => station.ack(),
    resetStationAlarmSound: () => station.ack(),
    rebootHUB: () => station.ack(),
    ack: () => setTimeout(() => instance?.emit("station command result", station, { command_type: 1, channel: 255, return_code: 0 }), 5),
    databaseQueryLatestInfo() {
      const rows = cameras.map((c) => ({ device_sn: c.sn, event_count: c.count, crop_local_path: `/media/${c.sn}/${c.count}.jpg` }));
      setTimeout(() => instance?.emit("station database query latest", station, 0, rows), 5);
    },
    // Shape of eufy-security-client's DatabaseQueryLocal; one person recording per camera.
    databaseQueryLocal(serials, start, end) {
      const records = cameras
        .filter((c) => serials.includes(c.sn))
        .map((c, i) => ({
          record_id: 1000 + i,
          station_sn: SIM_STATION,
          device_sn: c.sn,
          history: { start_time: end, end_time: end, trigger_type: 1, storage_path: `/media/${c.sn}/${c.count}.dat`, thumb_path: `/media/${c.sn}/${c.count}.jpg` },
          picture: [{ detection_type: 2, crop_path: `/media/${c.sn}/${c.count}.jpg`, event_time: end }],
        }));
      setTimeout(() => instance?.emit("station database query local", station, 0, records), 5);
    },
    databaseQueryByDate(serials, start, end) {
      const records = cameras
        .filter((c) => serials.includes(c.sn))
        .map((c, i) => ({ record_id: 2000 + i, station_sn: SIM_STATION, device_sn: c.sn, start_time: end, end_time: end, trigger_type: 1, storage_path: `/media/${c.sn}/${c.count}.dat`, thumb_path: `/media/${c.sn}/${c.count}.jpg` }));
      setTimeout(() => instance?.emit("station database query by date", station, 0, records), 5);
    },
    downloadImage(path) {
      const sn = path.split("/")[2];
      setTimeout(() => instance?.emit("station image download", station, path, { data: images[sn], type: imageType(sn) }), 10);
    },
  };

  const cameras = SIM_CAMERAS.map((c) => ({
    ...c,
    settings: { ...SIM_CAMERA_SETTINGS, ...(c.humansOnly ? { motionDetectionType: 0 } : {}) },
  }));
  for (const c of cameras) c.reported = { ...c.settings };
  const devices = cameras.map((c) => ({
    getSerial: () => c.sn,
    getName: () => c.name,
    getModel: () => c.model,
    getStationSerial: () => SIM_STATION,
    isCamera: () => true,
    hasProperty: (n) => n === PropertyName.DeviceBattery,
    getPropertyValue: (n) => (n === PropertyName.DeviceBattery ? c.battery : undefined),
    getProperties: () => ({ battery: c.battery, wifiRssi: -60, softwareVersion: "2.2.0.5", ...c.settings }),
    getPropertiesMetadata: () => ({
      battery: { name: "battery", writeable: false },
      ...Object.fromEntries(Object.keys(c.settings).map((name) => [name, { name, writeable: true }])),
    }),
    getCommands: () => ["deviceStartLivestream", "deviceStopLivestream"],
  }));

  const streams = new Map(); // sn -> { timer, readable }

  class EufySecurity extends EventEmitter {
    static async initialize(config) {
      instance = new EufySecurity(config);
      return instance;
    }

    constructor(config) {
      super();
      this.config = config;
      this.authenticated = tfaCode === null;
      this.eventTimer = null;
    }

    setCameraMaxLivestreamDuration() {}

    async setDeviceProperty(sn, name, value) {
      const device = devices.find((d) => d.getSerial() === sn);
      if (!device) throw new Error(`unknown device ${sn}`);
      if (!device.getPropertiesMetadata()[name]?.writeable) throw new Error(`property ${name} is read only or unknown`);
      const cam = cameras.find((c) => c.sn === sn);
      cam.settings[name] = value;
      cam.reported[name] = value;
      setTimeout(() => {
        this.emit("station command result", station, { command_type: 1, channel: 0, return_code: 0 });
        this.emit("device property changed", device, name, value);
      }, 5);
    }

    async getDevice(sn) {
      const device = devices.find((d) => d.getSerial() === sn);
      if (!device) throw new Error(`unknown device ${sn}`);
      return device;
    }

    async getStation(sn) {
      if (sn !== SIM_STATION) throw new Error(`unknown station ${sn}`);
      return station;
    }

    async connect(options = {}) {
      if (!this.authenticated) {
        if (options.verifyCode === undefined) {
          setTimeout(() => this.emit("tfa request"), 10);
          return;
        }
        if (options.verifyCode !== tfaCode) {
          setTimeout(() => this.emit("tfa request"), 10);
          return;
        }
        this.authenticated = true;
      }
      setTimeout(() => {
        this.emit("connect");
        this.emit("station added", station);
        for (const d of devices) this.emit("device added", d);
        setTimeout(() => this.emit("station connect", station), 20);
      }, 10);
      if (eventIntervalSeconds > 0) {
        this.eventTimer = setInterval(() => {
          triggerEvent(cameras[Math.floor(Math.random() * cameras.length)].sn);
        }, eventIntervalSeconds * 1000);
        this.eventTimer.unref();
      }
    }

    async setStationProperty(sn, name, value) {
      if (sn !== SIM_STATION) throw new Error("not supported");
      if (name === PropertyName.StationGuardMode) {
        station.guard = value;
        setTimeout(() => this.emit("station guard mode", station, value), 5);
        return;
      }
      if (!(name in station.settings)) throw new Error(`property ${name} is read only or unknown`);
      station.settings[name] = value;
      setTimeout(() => {
        this.emit("station command result", station, { command_type: 1, channel: 255, return_code: 0 });
        this.emit("station property changed", station, name, value);
      }, 5);
    }

    async startStationLivestream(sn) {
      const device = devices.find((d) => d.getSerial() === sn);
      if (!device) throw new Error(`unknown device ${sn}`);
      if (streams.has(sn)) throw new Error("already streaming");
      // The HomeBase streams one camera at a time and switches to the newest request.
      for (const other of [...streams.keys()]) await this.stopStationLivestream(other);
      const readable = new Readable({ read() {} });
      const audio = new Readable({ read() {} });
      let i = 0;
      let a = 0;
      const entry = { readable, audio, timer: null, audioTimer: null };
      streams.set(sn, entry);
      setTimeout(() => {
        this.emit("station livestream start", station, device, { videoCodec: 0, videoFPS: fps, videoWidth: 640, videoHeight: 360, audioCodec: 2 }, readable, audio);
        entry.timer = setInterval(() => readable.push(frames[i++ % frames.length]), 1000 / fps);
        entry.audioTimer = setInterval(() => audio.push(audioFrames[a++ % audioFrames.length]), 64);
      }, 50);
    }

    async stopStationLivestream(sn) {
      const entry = streams.get(sn);
      if (!entry) return;
      clearInterval(entry.timer);
      clearInterval(entry.audioTimer);
      streams.delete(sn);
      entry.readable.push(null);
      entry.audio.push(null);
      const device = devices.find((d) => d.getSerial() === sn);
      this.emit("station livestream stop", station, device);
    }

    close() {
      clearInterval(this.eventTimer);
      for (const sn of [...streams.keys()]) this.stopStationLivestream(sn);
      if (instance === this) instance = null;
    }
  }

  /** Simulates a recording: the event count rises; the cloud push follows a bit later. */
  function triggerEvent(sn) {
    const cam = cameras.find((c) => c.sn === sn);
    if (!cam) throw new RangeError(`unknown camera ${sn}`);
    cam.count += 1;
    const device = devices.find((d) => d.getSerial() === sn);
    setTimeout(() => instance?.emit("device person detected", device, true), 300);
  }

  /** Changes a setting the way the Eufy app does: silently; only a settings refresh shows it. */
  function appChangesSetting(sn, name, value) {
    const cam = cameras.find((c) => c.sn === sn);
    if (!cam) throw new RangeError(`unknown camera ${sn}`);
    cam.settings[name] = value;
  }

  return {
    lib: { EufySecurity, P2PConnectionType, GuardMode, PropertyName },
    simulator: { triggerEvent, appChangesSetting, cameras },
  };
}
