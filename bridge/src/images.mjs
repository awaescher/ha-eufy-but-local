// Event thumbnails fetched from the HomeBase's local event database.
// Downloads are serialized: the station answers one request at a time.

export class ImageStore {
  /**
   * @param {object} opts
   * @param {(path: string) => void} opts.download  requests a thumbnail by station path
   * @param {number} [opts.timeoutMs]               give up waiting for an answer after this
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ download, timeoutMs = 8000, log = () => {} }) {
    this.download = download;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.images = new Map(); // sn -> { data, mime }
    this.owner = new Map(); // station path -> sn
    this.lastPath = new Map(); // sn -> last requested path
    this.queue = [];
    this.busy = false;
    this.timer = null;
  }

  get(sn) {
    return this.images.get(sn) ?? null;
  }

  /** Requests the thumbnail at `path` for camera `sn` unless it was already fetched. */
  request(sn, path, { force = false } = {}) {
    if (!path || (!force && this.lastPath.get(sn) === path)) return;
    this.lastPath.set(sn, path);
    this.owner.set(path, sn);
    this.queue.push(path);
    this.#pump();
  }

  /** Stores a downloaded image. Returns the camera serial or null if unknown. */
  received(path, data, mime = "image/jpeg") {
    clearTimeout(this.timer);
    this.busy = false;
    const sn = this.owner.get(path) ?? null;
    if (sn && data?.length) this.images.set(sn, { data, mime });
    this.#pump();
    return sn;
  }

  #pump() {
    if (this.busy || this.queue.length === 0) return;
    const path = this.queue.shift();
    this.busy = true;
    try {
      this.download(path);
    } catch (err) {
      this.log(`image download failed: ${err.message}`);
      this.busy = false;
      this.#pump();
      return;
    }
    this.timer = setTimeout(() => {
      this.busy = false;
      this.#pump();
    }, this.timeoutMs);
    this.timer.unref?.();
  }

  close() {
    clearTimeout(this.timer);
  }
}
