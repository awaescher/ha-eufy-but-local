// On-demand livestreams.
//
// The first viewer of a camera starts the P2P livestream (which wakes the camera),
// the stream is stopped `idleMs` after the last viewer left. Late viewers receive
// the cached GOP so they always begin with SPS/PPS + keyframe.

import { findSpsOffset } from "./h264.mjs";

const GOP_CACHE_MAX_BYTES = 4 * 1024 * 1024;

export class LiveStreams {
  /**
   * @param {object} opts
   * @param {(sn: string) => Promise<void>} opts.start  starts the camera livestream
   * @param {(sn: string) => Promise<void>} opts.stop   stops the camera livestream
   * @param {number} opts.idleMs                         grace period after last viewer left
   * @param {(sn: string, live: boolean) => void} [opts.onChange]
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ start, stop, idleMs, onChange = () => {}, log = () => {} }) {
    this.startFn = start;
    this.stopFn = stop;
    this.idleMs = idleMs;
    this.onChange = onChange;
    this.log = log;
    this.streams = new Map();
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

  viewerCount(sn) {
    return this.streams.get(sn)?.viewers.size ?? 0;
  }

  /** Registers a writable viewer; starts the camera if needed. */
  async addViewer(sn, viewer) {
    const s = this.#get(sn);
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
    s.viewers.add(viewer);
    if (s.running) {
      for (const chunk of s.gop) viewer.write(chunk);
      return;
    }
    if (s.starting) return;
    s.starting = true;
    try {
      await this.startFn(sn);
    } catch (err) {
      this.log(`livestream start failed for ${sn}: ${err.message}`);
      this.ended(sn);
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
  started(sn) {
    const s = this.#get(sn);
    s.running = true;
    s.starting = false;
    s.gop = [];
    s.gopBytes = 0;
    this.onChange(sn, true);
  }

  /** Feeds a chunk of raw H.264 to all viewers and the GOP cache. */
  feed(sn, chunk) {
    const s = this.streams.get(sn);
    if (!s) return;
    const sps = findSpsOffset(chunk);
    if (sps >= 0) {
      const head = chunk.subarray(sps);
      s.gop = [head];
      s.gopBytes = head.length;
    } else if (s.gop.length > 0 && s.gopBytes < GOP_CACHE_MAX_BYTES) {
      s.gop.push(chunk);
      s.gopBytes += chunk.length;
    }
    for (const v of s.viewers) v.write(chunk);
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
