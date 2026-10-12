// On-demand livestreams.
//
// The first viewer of a camera starts the P2P livestream (which wakes the camera),
// the stream is stopped `idleMs` after the last viewer left. Viewers receive units
// `{ kind: "video" | "audio", data, at, keyframe }` (`at` = arrival time in ms); late
// viewers get the cached GOP first, so they always begin with SPS/PPS + keyframe.
//
// A HomeBase streams one camera at a time. Starting another camera of the same station
// displaces the running one; the displaced camera is then refused for a while, because
// clients like Home Assistant reconnect on their own and would displace the new camera
// right back.

import { findSpsOffset } from "./h264.mjs";

const GOP_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
// The audio clock follows the sample count; if it drifts this far from arrival time (gaps,
// bursts), it is re-anchored.
const AUDIO_RESYNC_MS = 500;

/** Duration of an ADTS frame in ms, or null if `chunk` has no ADTS header. */
export function adtsDurationMs(chunk) {
  if (chunk.length < 7 || chunk[0] !== 0xff || (chunk[1] & 0xf6) !== 0xf0) return null;
  const rate = ADTS_SAMPLE_RATES[(chunk[2] >> 2) & 0x0f];
  if (!rate) return null;
  const blocks = (chunk[6] & 0x03) + 1;
  return (blocks * 1024 * 1000) / rate;
}
// Home Assistant stops an unwatched stream after 30 s (stream OUTPUT_IDLE_TIMEOUT).
const SWITCH_COOLDOWN_MS = 30_000;

export class LiveStreams {
  /**
   * @param {object} opts
   * @param {(sn: string) => Promise<void>} opts.start  starts the camera livestream
   * @param {(sn: string) => Promise<void>} opts.stop   stops the camera livestream
   * @param {number} opts.idleMs                         grace period after last viewer left
   * @param {(sn: string, live: boolean) => void} [opts.onChange]
   * @param {(msg: string) => void} [opts.log]
   * @param {(sn: string) => string} [opts.stationOf]   station serial of a camera
   * @param {number} [opts.switchCooldownMs]             how long a displaced camera is refused
   * @param {() => number} [opts.now]
   */
  constructor({
    start,
    stop,
    idleMs,
    onChange = () => {},
    log = () => {},
    stationOf = (sn) => sn,
    switchCooldownMs = SWITCH_COOLDOWN_MS,
    now = () => Date.now(),
  }) {
    this.startFn = start;
    this.stopFn = stop;
    this.idleMs = idleMs;
    this.onChange = onChange;
    this.log = log;
    this.stationOf = stationOf;
    this.switchCooldownMs = switchCooldownMs;
    this.now = now;
    this.streams = new Map();
    this.displacedAt = new Map(); // sn -> time another camera of its station took over
  }

  #get(sn) {
    let s = this.streams.get(sn);
    if (!s) {
      s = { viewers: new Set(), running: false, starting: false, gop: [], gopBytes: 0, idleTimer: null };
      this.streams.set(sn, s);
    }
    return s;
  }

  isRunning(sn) {
    return this.streams.get(sn)?.running ?? false;
  }

  /** Whether the running stream of `sn` carries audio (known once it started). */
  hasAudio(sn) {
    return this.streams.get(sn)?.audio ?? false;
  }

  viewerCount(sn) {
    return this.streams.get(sn)?.viewers.size ?? 0;
  }

  /** False while `sn` was recently displaced by another camera of its station. */
  admits(sn) {
    const at = this.displacedAt.get(sn);
    return at === undefined || this.now() - at >= this.switchCooldownMs;
  }

  /** Registers a viewer (`push(unit)`, `end()`); starts the camera if needed. */
  async addViewer(sn, viewer) {
    const s = this.#get(sn);
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
    s.viewers.add(viewer);
    if (s.running) {
      for (const unit of s.gop) viewer.push(unit);
      return;
    }
    if (s.starting) return;
    s.starting = true;
    this.displacedAt.delete(sn);
    await this.#displaceOthers(sn);
    try {
      await this.startFn(sn);
    } catch (err) {
      this.log(`livestream start failed for ${sn}: ${err.message}`);
      this.ended(sn);
    }
  }

  async #displaceOthers(sn) {
    const station = this.stationOf(sn);
    for (const [other, o] of this.streams) {
      if (other === sn || !(o.running || o.starting) || this.stationOf(other) !== station) continue;
      this.log(`livestream ${other} displaced by ${sn}`);
      this.displacedAt.set(other, this.now());
      this.ended(other);
      await this.stopFn(other).catch((err) => this.log(`livestream stop failed: ${err.message}`));
    }
  }

  removeViewer(sn, viewer) {
    const s = this.streams.get(sn);
    if (!s) return;
    s.viewers.delete(viewer);
    if (s.viewers.size > 0 || !(s.running || s.starting)) return;
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      if (s.viewers.size === 0) this.stopFn(sn).catch((err) => this.log(`livestream stop failed: ${err.message}`));
    }, this.idleMs);
    s.idleTimer.unref?.();
  }

  /** Called when the camera actually started streaming. */
  started(sn, { audio = false, fps = 15 } = {}) {
    const s = this.#get(sn);
    s.audio = audio;
    // P2P delivers frames in bursts; timestamps must still advance for every frame.
    s.minVideoStepMs = 500 / (fps > 0 ? fps : 15);
    s.lastVideoAt = null;
    s.lastAudioAt = null;
    s.running = true;
    s.starting = false;
    s.gop = [];
    s.gopBytes = 0;
    this.onChange(sn, true);
  }

  /** Feeds one frame of raw H.264 (Annex-B) to all viewers and the GOP cache. */
  feed(sn, chunk) {
    const s = this.streams.get(sn);
    if (!s) return;
    const now = this.now();
    const at = s.lastVideoAt === null ? now : Math.max(now, s.lastVideoAt + s.minVideoStepMs);
    s.lastVideoAt = at;
    const sps = findSpsOffset(chunk);
    const unit = sps >= 0
      ? { kind: "video", data: chunk.subarray(sps), at, keyframe: true }
      : { kind: "video", data: chunk, at, keyframe: false };
    this.#deliver(sn, unit);
  }

  /** Feeds one AAC frame (ADTS) to all viewers and the GOP cache. */
  feedAudio(sn, chunk) {
    const s = this.streams.get(sn);
    if (!s) return;
    const now = this.now();
    const frameMs = adtsDurationMs(chunk) ?? 64;
    let at = s.lastAudioAt === null ? now : s.lastAudioAt + frameMs;
    if (Math.abs(at - now) > AUDIO_RESYNC_MS) at = Math.max(now, (s.lastAudioAt ?? -Infinity) + frameMs);
    s.lastAudioAt = at;
    this.#deliver(sn, { kind: "audio", data: chunk, at });
  }

  #deliver(sn, unit) {
    const s = this.streams.get(sn);
    if (!s) return;
    if (unit.keyframe) {
      s.gop = [unit];
      s.gopBytes = unit.data.length;
    } else if (s.gop.length > 0 && s.gopBytes < GOP_CACHE_MAX_BYTES) {
      s.gop.push(unit);
      s.gopBytes += unit.data.length;
    }
    for (const v of s.viewers) v.push(unit);
  }

  /** Called when the camera stopped streaming (for whatever reason). */
  ended(sn) {
    const s = this.streams.get(sn);
    if (!s || (!s.running && !s.starting && s.viewers.size === 0)) return;
    const wasRunning = s.running;
    s.running = false;
    s.starting = false;
    s.gop = [];
    s.gopBytes = 0;
    clearTimeout(s.idleTimer);
    for (const v of s.viewers) v.end();
    s.viewers.clear();
    if (wasRunning) this.onChange(sn, false);
  }

  close() {
    for (const sn of this.streams.keys()) this.ended(sn);
  }
}
