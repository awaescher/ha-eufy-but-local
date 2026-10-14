// HTTP API consumed by the Home Assistant integration.
//
//   GET  /api/health                     liveness, no auth
//   GET  /api/state                      full snapshot
//   GET  /api/events                     Server-Sent Events: "state" and "event"
//   POST /api/login  {email,password,country}
//   POST /api/code   {code}              2FA code or captcha answer
//   GET  /api/captcha                    captcha image (while requested)
//   GET  /api/image/:sn                  latest event thumbnail (local)
//   GET  /api/stream/:sn[.flv|.ts|.h264] livestream (starts camera): FLV or MPEG-TS with audio, or raw H.264
//   GET  /api/frame/:sn[.h264]           latest live keyframe as raw H.264 (never starts the camera)
//   POST /api/config {cloudPush}         switch optional cloud features (off by default)
//   POST /api/station/:sn/guard {mode}   AWAY | HOME | DISARMED | ...
//   GET  /api/device/:sn/properties      diagnostics: library properties of a device
//   POST /api/device/:sn/property {name,value}   write a camera property (P2P)
//   POST /api/station/:sn/property {name,value}  write a HomeBase property (P2P)
//   POST /api/device/:sn/command {name,seconds?} alarm | stopAlarm | snooze (P2P)
//   POST /api/station/:sn/command {name,seconds?} alarm | stopAlarm | reboot (P2P)
//   GET  /api/station/:sn/events?hours=  diagnostics: local event records (HomeBase database)
//   POST /api/simulator/:sn/event        simulator only: trigger an event

import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

import { FlvMuxer } from "./flv.mjs";
import { boundBacklog } from "./live.mjs";
import { TsMuxer } from "./mpegts.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const STATE_DEBOUNCE_MS = 200;
const KEEPALIVE_MS = 25_000;

/**
 * Token for stream and frame URLs, derived from the bridge token. Home Assistant logs stream
 * URLs (e.g. on stream errors); this token only lets someone watch, not use the API.
 */
export function streamToken(token) {
  return token ? createHmac("sha256", token).update("stream").digest("hex").slice(0, 32) : "";
}

export function createApi({ state, connector, credentials, simulator = null, token = "", log = () => {} }) {
  const sse = new Set();
  let pending = null;

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sse) res.write(frame);
  };
  const onChange = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      broadcast("state", state.snapshot());
    }, STATE_DEBOUNCE_MS);
  };
  const onEvent = (evt) => broadcast("event", evt);
  state.on("change", onChange);
  state.on("event", onEvent);
  const keepalive = setInterval(() => { for (const res of sse) res.write(": ping\n\n"); }, KEEPALIVE_MS);
  keepalive.unref();

  const watchToken = streamToken(token);
  const matches = (given, expected) => {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const authorized = (req, url, route) => {
    if (!token) return true;
    const given = (req.headers.authorization ?? "").replace(/^Bearer /, "") || url.searchParams.get("token") || "";
    if (matches(given, token)) return true;
    return (route === "stream" || route === "frame") && req.method === "GET" && matches(given, watchToken);
  };


  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://bridge");
    const [prefix, route, id, action] = url.pathname.split("/").filter(Boolean);
    if (prefix !== "api") return send(res, 404, { error: "not found" });
    if (route === "health") {
      return send(res, 200, { ok: true, version: state.version, phase: state.phase, auth: Boolean(token), simulator: Boolean(simulator) });
    }
    if (!authorized(req, url, route)) return send(res, 401, { error: "unauthorized" });

    try {
      const handler = routes[`${req.method} ${route}`];
      if (!handler) return send(res, 404, { error: "not found" });
      return await handler({ req, res, url, id, action });
    } catch (err) {
      const status = err instanceof RangeError ? 400 : 500;
      log("http", `${req.method} ${url.pathname}: ${err.message}`);
      return send(res, status, { error: err.message });
    }
  });

  const routes = {
    "GET state": ({ res }) => send(res, 200, state.snapshot()),

    "GET events": ({ req, res }) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`event: state\ndata: ${JSON.stringify(state.snapshot())}\n\n`);
      sse.add(res);
      req.on("close", () => sse.delete(res));
    },

    "POST login": async ({ req, res }) => {
      const body = await readJson(req);
      if (!body.email || !body.password) throw new RangeError("email and password are required");
      const cred = { email: String(body.email), password: String(body.password), country: String(body.country || "DE").toUpperCase() };
      credentials.save(cred);
      connector.start(cred); // async; progress is reported through the state
      return send(res, 202, { ok: true });
    },

    "POST code": async ({ req, res }) => {
      const body = await readJson(req);
      const code = String(body.code ?? "").trim();
      if (!code) throw new RangeError("code is required");
      connector.submitCode(code).catch((err) => state.setPhase("error", err.message));
      return send(res, 202, { ok: true });
    },

    "GET captcha": ({ res }) => {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(connector.captcha ?? "");
      if (!m) return send(res, 404, { error: "no captcha requested" });
      res.writeHead(200, { "content-type": m[1], "cache-control": "no-store" });
      res.end(Buffer.from(m[2], "base64"));
    },

    "GET image": ({ res, id }) => {
      const img = connector.images.get(id);
      if (!img) return send(res, 404, { error: "no image" });
      res.writeHead(200, { "content-type": img.mime, "cache-control": "no-store" });
      res.end(img.data);
    },

    "GET stream": async ({ req, res, id }) => {
      // {sn}.flv: FLV, {sn} or {sn}.ts: MPEG-TS, both with video and audio; {sn}.h264: raw video only.
      const format = /\.(flv|h264|ts)$/.exec(String(id ?? ""))?.[1] ?? "ts";
      const raw = format === "h264";
      const sn = String(id ?? "").replace(/\.(flv|h264|ts)$/, "");
      if (!state.cameras[sn]) return send(res, 404, { error: "unknown camera" });
      if (!connector.connected) return send(res, 503, { error: "not connected" });
      if (!connector.live.admits(sn)) {
        return send(res, 409, { error: "another camera of this HomeBase took over the livestream" });
      }
      const contentType = { flv: "video/x-flv", h264: "video/h264", ts: "video/mp2t" }[format];
      res.writeHead(200, { "content-type": contentType, "cache-control": "no-store", connection: "close" });
      let muxer = null;
      const accept = boundBacklog(() => res.writableLength, {
        onSkip: () => {
          connector.live.skipped(sn);
          log("local", `livestream ${state.cameras[sn]?.name ?? sn}: a viewer fell behind, skipping to the next keyframe`);
        },
      });
      const viewer = {
        push(unit) {
          if (!accept(unit)) return;
          if (raw) {
            if (unit.kind === "video") res.write(unit.data);
            return;
          }
          // Created on the first unit: by then the stream has started and says whether it has audio.
          if (!muxer) {
            const opts = { audio: connector.live.hasAudio(sn), fps: connector.live.fps(sn) };
            muxer = format === "flv" ? new FlvMuxer(opts) : new TsMuxer(opts);
          }
          res.write(muxer.mux(unit));
        },
        end: () => res.end(),
      };
      req.on("close", () => connector.live.removeViewer(sn, viewer));
      await connector.live.addViewer(sn, viewer);
    },

    "GET frame": ({ res, id }) => {
      const frame = connector.live.lastFrame(String(id ?? "").replace(/\.h264$/, ""));
      if (!frame) return send(res, 404, { error: "no frame" });
      res.writeHead(200, { "content-type": "video/h264", "cache-control": "no-store", "x-frame-at": frame.at });
      res.end(frame.data);
    },

    // Read-only diagnostics: what the library knows about a device, and the local event list.
    "GET device": async ({ res, id, action }) => {
      if (action !== "properties") return send(res, 404, { error: "not found" });
      if (!state.cameras[id]) return send(res, 404, { error: "unknown camera" });
      return send(res, 200, await connector.deviceInfo(id));
    },

    "GET station": async ({ res, id, action, url }) => {
      if (action !== "events") return send(res, 404, { error: "not found" });
      if (!state.stations[id]) return send(res, 404, { error: "unknown station" });
      const hours = Number(url.searchParams.get("hours") ?? 24);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 31) return send(res, 400, { error: "hours: 1..744" });
      const end = new Date();
      return send(res, 200, await connector.stationEvents(id, new Date(end - hours * 3_600_000), end));
    },

    "POST config": async ({ req, res }) => {
      const body = await readJson(req);
      if (typeof body.cloudPush !== "boolean") throw new RangeError("cloudPush must be true or false");
      await connector.setCloudPush(body.cloudPush);
      return send(res, 200, { cloudPush: state.cloudPush });
    },

    "POST station": async ({ req, res, id, action }) => {
      if (!state.stations[id]) return send(res, 404, { error: "unknown station" });
      const body = await readJson(req);
      if (action === "guard") {
        await connector.setGuardMode(id, body.mode);
        return send(res, 202, { ok: true });
      }
      if (action === "property") return send(res, 200, await connector.setProperty("station", id, body.name, body.value));
      if (action === "command") return send(res, 200, await connector.command("station", id, body.name, body));
      return send(res, 404, { error: "not found" });
    },

    "POST device": async ({ req, res, id, action }) => {
      if (action !== "property" && action !== "command") return send(res, 404, { error: "not found" });
      if (!state.cameras[id]) return send(res, 404, { error: "unknown camera" });
      const body = await readJson(req);
      if (action === "command") return send(res, 200, await connector.command("device", id, body.name, body));
      return send(res, 200, await connector.setProperty("device", id, body.name, body.value));
    },

    "POST simulator": ({ res, id }) => {
      if (!simulator) return send(res, 404, { error: "not found" });
      simulator.triggerEvent(id);
      return send(res, 202, { ok: true });
    },
  };

  server.on("close", () => {
    clearInterval(keepalive);
    clearTimeout(pending);
    state.off("change", onChange);
    state.off("event", onEvent);
    for (const res of sse) res.end();
  });
  return server;
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RangeError("request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new RangeError("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
