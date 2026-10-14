// Event thumbnails fetched from the HomeBase's local event database.
// Downloads are serialized: the station answers one request at a time.

/**
 * When the picture was taken, from a HomeBase thumbnail path such as
 * `/media/mmcblk0p1/Camera00/20261013112255_c00.jpg` (HomeBase local time, taken to be the
 * bridge's time zone); null if the name has no time stamp.
 */
export function pictureTime(path) {
  const m = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_c\d+\.\w+$/.exec(String(path ?? ""));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// A download the HomeBase did not answer is tried again after this long (the poller asks for
// the latest thumbnail every few seconds). Before, it was never retried until the next event.
const RETRY_MS = 60_000;

export class ImageStore {
  /**
   * @param {object} opts
   * @param {(path: string) => void} opts.download  requests a thumbnail by station path
   * @param {number} [opts.timeoutMs]               give up waiting for an answer after this
   * @param {(msg: string) => void} [opts.log]
   * @param {(sn: string) => string} [opts.nameOf]  camera name for log lines
   * @param {() => number} [opts.now]
   */
  constructor({ download, timeoutMs = 8000, log = () => {}, nameOf = (sn) => sn, now = () => Date.now() }) {
    this.download = download;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.nameOf = nameOf;
    this.now = now;
    this.images = new Map(); // sn -> { data, mime }
    this.owner = new Map(); // station path -> sn
    this.fetched = new Map(); // sn -> path of the stored image
    this.pending = new Set(); // paths queued or being downloaded
    this.retryAt = new Map(); // path -> earliest retry after a failed download
    this.undecodable = new Set(); // paths whose image could not be decoded; not retried
    this.queue = [];
    this.current = null;
    this.timer = null;
  }

  get(sn) {
    return this.images.get(sn) ?? null;
  }

  /** Requests the thumbnail at `path` for camera `sn` unless it is stored, pending or failed recently. */
  request(sn, path, { force = false } = {}) {
    if (!path || this.pending.has(path)) return;
    if (!force && (this.fetched.get(sn) === path || this.undecodable.has(path))) return;
    if (!force && (this.retryAt.get(path) ?? 0) > this.now()) return;
    this.owner.set(path, sn);
    this.pending.add(path);
    this.queue.push(path);
    this.#pump();
  }

  /** Stores a downloaded image (`data` null: it could not be decoded). Returns the camera serial or null. */
  received(path, data, mime = "image/jpeg") {
    if (path === this.current) {
      clearTimeout(this.timer);
      this.current = null;
    }
    this.pending.delete(path);
    const sn = this.owner.get(path) ?? null;
    if (sn && data?.length) {
      this.images.set(sn, { data, mime });
      this.fetched.set(sn, path);
      this.retryAt.delete(path);
    } else if (sn) {
      this.undecodable.add(path);
    }
    this.#pump();
    return sn;
  }

  #failed(path, why) {
    this.pending.delete(path);
    this.retryAt.set(path, this.now() + RETRY_MS);
    const sn = this.owner.get(path);
    this.log(`thumbnail of ${sn ? this.nameOf(sn) : path}: ${why}; trying again in ${RETRY_MS / 1000} s`);
  }

  #pump() {
    if (this.current !== null || this.queue.length === 0) return;
    const path = this.queue.shift();
    this.current = path;
    try {
      this.download(path);
    } catch (err) {
      this.current = null;
      this.#failed(path, `download failed (${err.message})`);
      this.#pump();
      return;
    }
    this.timer = setTimeout(() => {
      this.current = null;
      this.#failed(path, `no answer from the HomeBase within ${Math.round(this.timeoutMs / 1000)} s`);
      this.#pump();
    }, this.timeoutMs);
    this.timer.unref?.();
  }

  close() {
    clearTimeout(this.timer);
  }
}
