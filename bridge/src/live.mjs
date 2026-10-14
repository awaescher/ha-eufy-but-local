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
//
// The bridge keeps delay bounded: a viewer that cannot keep up skips to the
// next keyframe (`boundBacklog`) instead of falling further behind. The latest keyframe of each
// camera is kept after the stream ended, as a still image of what the camera saw last.

import { findSpsOffset, hasIdrSlice } from "./h264.mjs";

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
const AAC_PROFILES = ["Main", "LC", "SSR", "LTP"];
// 64 ms of AAC-LC silence, 16 kHz mono, as ADTS (made with ffmpeg's aac encoder).
export const SILENT_AAC = Buffer.from("fff16040017ffc01182007", "hex");
const SILENT_AAC_MS = 64;
const RAW_AUDIO_MEASURE_MS = 10_000;

export function isAdts(chunk) {
  return chunk.length >= 7 && chunk[0] === 0xff && (chunk[1] & 0xf6) === 0xf0;
}

/** What an audio frame is, for the log: e.g. "AAC-LC 16000 Hz, 1 channel(s) (ADTS)". */
export function describeAudio(chunk) {
  if (!isAdts(chunk)) {
    return `not ADTS (${chunk.length} bytes, starts ${chunk.subarray(0, 8).toString("hex")})`;
  }
  const profile = AAC_PROFILES[(chunk[2] >> 6) & 0x03];
  const rate = ADTS_SAMPLE_RATES[(chunk[2] >> 2) & 0x0f] ?? "?";
  const channels = ((chunk[2] & 0x01) << 2) | (chunk[3] >> 6);
  return `AAC-${profile} ${rate} Hz, ${channels} channel(s) (ADTS)`;
}

// Home Assistant's stream worker retries 10, 30 and 60 s after its stream ended
// (STREAM_RESTART_INCREMENT) and stops an unwatched stream after 30 s (OUTPUT_IDLE_TIMEOUT).
// With exactly 30 s, its second retry took the HomeBase back from the camera opened in the
// Home app (seen on hardware); 45 s refuses it, and the stream is gone before the third.
const SWITCH_COOLDOWN_MS = 45_000;
// A few seconds of video at the bitrates seen so far; above this a viewer is too far behind.
export const MAX_VIEWER_BACKLOG_BYTES = 512 * 1024;
// How often a running stream reports a newer still frame; Apple Home asks about every 10 s.
const FRAME_NOTIFY_MS = 10_000;
// The library stops a stream after 5 s without data (weak Wi-Fi, seen on hardware). While
// someone watches, the bridge starts it again this often per session instead of ending them.
const MAX_RESTARTS = 2;
// A start that brings no stream within this time is given up (or retried). Waking a camera
// with weak Wi-Fi took up to 9 s on hardware. The library reports no end for a stream that
// never started, so without this the camera stayed "starting" and accepted no new start.
const START_TIMEOUT_MS = 15_000;

/**
 * Returns `accept(unit)`, which drops a slow viewer's units while its unsent data (`pending()`)
 * exceeds `maxBytes`, and resumes at the next keyframe once it caught up.
 */
export function boundBacklog(pending, { maxBytes = MAX_VIEWER_BACKLOG_BYTES, onSkip = () => {} } = {}) {
  let skipping = false;
  return (unit) => {
    if (!skipping && pending() <= maxBytes) return true;
    if (!skipping) {
      skipping = true;
      onSkip();
      return false;
    }
    if (!unit.keyframe || pending() > maxBytes) return false;
    skipping = false;
    return true;
  };
}

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
   * @param {(sn: string, at: string) => void} [opts.onFrame] a newer still frame is available
   * @param {(sn: string) => string} [opts.nameOf]       camera name for log lines
   * @param {number} [opts.maxMs]                        the library's maximum stream duration
   * @param {number} [opts.startTimeoutMs]               give up a start that brings no stream
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
    onFrame = () => {},
    nameOf = (sn) => sn,
    maxMs = Infinity,
    startTimeoutMs = START_TIMEOUT_MS,
    now = () => Date.now(),
  }) {
    this.startFn = start;
    this.stopFn = stop;
    this.idleMs = idleMs;
    this.onChange = onChange;
    this.log = log;
    this.stationOf = stationOf;
    this.switchCooldownMs = switchCooldownMs;
    this.onFrame = onFrame;
    this.nameOf = nameOf;
    this.maxMs = maxMs;
    this.startTimeoutMs = startTimeoutMs;
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

  /** Whether the running stream's audio is replaced by silence (format not supported). */
  silenced(sn) {
    return this.streams.get(sn)?.silenced ?? false;
  }

  /** Frame rate the camera reported when the stream started. */
  fps(sn) {
    return this.streams.get(sn)?.fps ?? 15;
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
    s.restarts = 0;
    s.stopRequested = false;
    s.requestedAt = this.now();
    this.displacedAt.delete(sn);
    await this.#displaceOthers(sn);
    await this.#start(sn);
  }

  async #start(sn) {
    const s = this.streams.get(sn);
    clearTimeout(s.startTimer);
    s.startTimer = setTimeout(() => this.#startTimedOut(sn), this.startTimeoutMs);
    s.startTimer.unref?.();
    try {
      await this.startFn(sn);
    } catch (err) {
      this.log(`livestream start failed for ${sn}: ${err.message}`);
      this.ended(sn);
    }
  }

  #startTimedOut(sn) {
    const s = this.streams.get(sn);
    if (!s?.starting) return;
    this.log(`livestream ${this.nameOf(sn)} did not start within ${Math.round(this.startTimeoutMs / 1000)} s`);
    this.stopFn(sn).catch(() => {});
    if (s.viewers.size > 0 && s.restarts < MAX_RESTARTS) {
      s.restarts += 1;
      this.log(`livestream ${this.nameOf(sn)}: trying again for its viewers (${s.restarts}/${MAX_RESTARTS})`);
      s.requestedAt = this.now();
      this.#start(sn);
      return;
    }
    this.ended(sn);
  }

  /**
   * Called when the stream stopped without the bridge asking for it (`session` from
   * `started()`, to ignore late events of an earlier session). Restarts it while someone
   * watches, unless it reached the maximum duration; otherwise ends it.
   */
  interrupted(sn, session = this.streams.get(sn)?.session) {
    const s = this.streams.get(sn);
    if (!s || !s.running || session !== s.session) return;
    const ranMs = this.now() - s.startedAt;
    if (s.stopRequested || s.viewers.size === 0 || ranMs >= this.maxMs - 2000 || s.restarts >= MAX_RESTARTS) {
      this.ended(sn);
      return;
    }
    s.restarts += 1;
    this.log(`livestream ${this.nameOf(sn)} stopped by the HomeBase after ${Math.round(ranMs / 1000)} s, restarting for its viewers (${s.restarts}/${MAX_RESTARTS})`);
    s.running = false;
    s.starting = true;
    s.restarting = true;
    s.requestedAt = this.now();
    this.#start(sn);
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

  /** The latest keyframe (SPS/PPS + IDR) of `sn` with its time, also after the stream ended. */
  lastFrame(sn) {
    return this.streams.get(sn)?.lastFrame ?? null;
  }

  /** Counts a viewer that fell behind and skipped to the next keyframe. */
  skipped(sn) {
    const s = this.streams.get(sn);
    if (s) s.skips = (s.skips ?? 0) + 1;
  }

  removeViewer(sn, viewer) {
    const s = this.streams.get(sn);
    if (!s) return;
    s.viewers.delete(viewer);
    if (s.viewers.size > 0 || !(s.running || s.starting)) return;
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      if (s.viewers.size > 0) return;
      s.stopRequested = true;
      this.stopFn(sn).catch((err) => this.log(`livestream stop failed: ${err.message}`));
    }, this.idleMs);
    s.idleTimer.unref?.();
  }

  /** Called when the camera actually started streaming; returns the session for `interrupted`. */
  started(sn, { audio = false, fps = 15 } = {}) {
    const s = this.#get(sn);
    s.session = (s.session ?? 0) + 1;
    s.restarting = false;
    clearTimeout(s.startTimer);
    s.audio = audio;
    s.fps = fps > 0 ? fps : 15;
    // P2P delivers frames in bursts; timestamps must still advance for every frame.
    s.minVideoStepMs = 500 / (fps > 0 ? fps : 15);
    s.lastVideoAt = null;
    s.lastAudioAt = null;
    s.startedAt = this.now();
    s.firstVideoAt = null;
    s.firstKeyframeAt = null;
    s.audioLogged = false;
    s.silenced = false;
    s.rawAudio = null;
    s.maxLeadMs = 0;
    s.skips = 0;
    s.frameNotifiedAt = null;
    s.running = true;
    s.starting = false;
    s.gop = [];
    s.gopBytes = 0;
    this.onChange(sn, true);
    return s.session;
  }

  /** Feeds one frame of raw H.264 (Annex-B) to all viewers and the GOP cache. */
  feed(sn, chunk) {
    const s = this.streams.get(sn);
    if (!s) return;
    const now = this.now();
    const at = s.lastVideoAt === null ? now : Math.max(now, s.lastVideoAt + s.minVideoStepMs);
    s.lastVideoAt = at;
    s.maxLeadMs = Math.max(s.maxLeadMs ?? 0, at - now);
    s.firstVideoAt ??= now;
    const sps = findSpsOffset(chunk);
    const unit = sps >= 0
      ? { kind: "video", data: chunk.subarray(sps), at, keyframe: true }
      : { kind: "video", data: chunk, at, keyframe: false };
    this.#deliver(sn, unit);
  }

  /** Feeds one AAC frame (ADTS) to all viewers and the GOP cache. */
  feedAudio(sn, chunk) {
    const s = this.streams.get(sn);
    // A camera often joins mid-GOP and the library drops video until the next keyframe, while
    // audio already flows (seen for seconds). Readers that probe the stream then give up on
    // the video track (go2rtc fails, Home Assistant's stream worker cannot mux), so audio waits.
    if (!s || s.firstKeyframeAt == null) return;
    const adts = isAdts(chunk);
    if (!s.audioLogged) {
      s.audioLogged = true;
      this.log(`livestream ${this.nameOf(sn)}: audio ${describeAudio(chunk)}${adts ? "" : ", sending silence instead"}`);
    }
    if (adts) {
      this.#pushAudio(sn, s, chunk);
      return;
    }
    // Some cameras (older eufyCam 2C) send audio in a format the bridge cannot pass on yet.
    // HomeKit's ffmpeg needs an audio track, so silence keeps pace with the camera's audio.
    s.silenced = true;
    const now = this.now();
    // The frame rate tells the sample rate (AAC-ELD frames hold 480 or 512 samples), which the
    // library does not report.
    s.rawAudio ??= { since: now, frames: 0, logged: false };
    s.rawAudio.frames += 1;
    if (!s.rawAudio.logged && now - s.rawAudio.since >= RAW_AUDIO_MEASURE_MS) {
      s.rawAudio.logged = true;
      const fps = (s.rawAudio.frames - 1) / ((now - s.rawAudio.since) / 1000);
      this.log(`livestream ${this.nameOf(sn)}: unsupported audio arrives at ${fps.toFixed(1)} frames/s`);
    }
    while (s.lastAudioAt === null || s.lastAudioAt + SILENT_AAC_MS <= now) this.#pushAudio(sn, s, SILENT_AAC);
  }

  #pushAudio(sn, s, chunk) {
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
      this.#keyframe(sn, s, unit);
    } else if (s.firstKeyframeAt == null) {
      return; // nothing before the first keyframe can be decoded
    } else {
      if (s.gop.length > 0 && s.gopBytes < GOP_CACHE_MAX_BYTES) {
        s.gop.push(unit);
        s.gopBytes += unit.data.length;
      }
      if (unit.kind === "video" && s.pendingFrame) {
        // SPS/PPS and the IDR slice may arrive as separate frames; the still needs both.
        s.pendingFrame.data = Buffer.concat([s.pendingFrame.data, unit.data]);
        if (hasIdrSlice(unit.data)) this.#completeFrame(sn, s);
      }
    }
    for (const v of s.viewers) v.push(unit);
  }

  #keyframe(sn, s, unit) {
    const now = this.now();
    s.pendingFrame = { data: unit.data, at: new Date(now).toISOString() };
    if (s.firstKeyframeAt == null) {
      s.firstKeyframeAt = now;
      // Where the start-up time goes: waking the camera vs. waiting for a keyframe.
      const since = (t) => (t == null || s.requestedAt == null ? "?" : `${t - s.requestedAt} ms`);
      this.log(`livestream ${this.nameOf(sn)}: started after ${since(s.startedAt)}, first frame after ${since(s.firstVideoAt)}, first keyframe after ${since(now)}`);
    }
    if (hasIdrSlice(unit.data)) this.#completeFrame(sn, s);
  }

  #completeFrame(sn, s) {
    s.lastFrame = s.pendingFrame;
    s.pendingFrame = null;
    const now = this.now();
    if (s.frameNotifiedAt == null || now - s.frameNotifiedAt >= FRAME_NOTIFY_MS) {
      s.frameNotifiedAt = now;
      this.onFrame(sn, s.lastFrame.at);
    }
  }

  /** Called when the camera stopped streaming (for whatever reason). */
  ended(sn) {
    const s = this.streams.get(sn);
    if (!s || (!s.running && !s.starting && s.viewers.size === 0)) return;
    const wasRunning = s.running || s.restarting;
    s.restarting = false;
    if (s.running) {
      const secs = Math.round((this.now() - s.startedAt) / 1000);
      this.log(`livestream ${this.nameOf(sn)} ended after ${secs} s (timestamps at most ${Math.round(s.maxLeadMs)} ms ahead, slow viewers skipped ${s.skips} times)`);
      // Report the final still frame if the throttle held it back.
      if (s.lastFrame && s.frameNotifiedAt != null && Date.parse(s.lastFrame.at) > s.frameNotifiedAt) this.onFrame(sn, s.lastFrame.at);
    }
    s.running = false;
    s.starting = false;
    s.gop = [];
    s.gopBytes = 0;
    clearTimeout(s.idleTimer);
    clearTimeout(s.startTimer);
    for (const v of s.viewers) v.end();
    s.viewers.clear();
    if (wasRunning) this.onChange(sn, false);
  }

  close() {
    for (const sn of this.streams.keys()) this.ended(sn);
  }
}
