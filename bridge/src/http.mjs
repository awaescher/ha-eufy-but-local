// HTTP API consumed by the Home Assistant integration.
//
//   GET  /api/health                     liveness, no auth
//   GET  /api/state                      full snapshot
//   GET  /api/events                     Server-Sent Events: "state" and "event"
//   POST /api/login  {email,password,country}
//   POST /api/code   {code}              2FA code or captcha answer
//   GET  /api/captcha                    captcha image (while requested)
//   GET  /api/image/:sn                  latest event thumbnail (local)
//   GET  /api/stream/:sn[.ts|.h264]      livestream (starts camera): MPEG-TS with audio, or raw H.264
//   POST /api/station/:sn/guard {mode}   AWAY | HOME | DISARMED | ...
//   GET  /api/device/:sn/properties      diagnostics: library properties of a device
//   GET  /api/station/:sn/events?hours=  diagnostics: local event records (HomeBase database)
//   POST /api/simulator/:sn/event        simulator only: trigger an event

import http from "node:http";
import { timingSafeEqual } from "node:crypto";

import { TsMuxer } from "./mpegts.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const STATE_DEBOUNCE_MS = 200;
const KEEPALIVE_MS = 25_000;

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

  const authorized = (req, url) => {
    if (!token) return true;
    const given = (req.headers.authorization ?? "").replace(/^Bearer /, "") || url.searchParams.get("token") || "";
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://bridge");
    const [prefix, route, id, action] = url.pathname.split("/").filter(Boolean);
    if (prefix !== "api") return send(res, 404, { error: "not found" });
    if (route === "health") {
      return send(res, 200, { ok: true, version: state.version, phase: state.phase, auth: Boolean(token), simulator: Boolean(simulator) });
    }
    if (!authorized(req, url)) return send(res, 401, { error: "unauthorized" });

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
      // {sn} or {sn}.ts: MPEG-TS with video and audio; {sn}.h264: raw video only.
      const raw = String(id ?? "").endsWith(".h264");
      const sn = String(id ?? "").replace(/\.(h264|ts)$/, "");
      if (!state.cameras[sn]) return send(res, 404, { error: "unknown camera" });
      if (!connector.connected) return send(res, 503, { error: "not connected" });
      if (!connector.live.admits(sn)) {
        return send(res, 409, { error: "another camera of this HomeBase took over the livestream" });
      }
      res.writeHead(200, { "content-type": raw ? "video/h264" : "video/mp2t", "cache-control": "no-store", connection: "close" });
      let muxer = null;
      const viewer = {
        push(unit) {
          if (raw) {
            if (unit.kind === "video") res.write(unit.data);
            return;
          }
          // Created on the first unit: by then the stream has started and says whether it has audio.
          muxer ??= new TsMuxer({ audio: connector.live.hasAudio(sn) });
          res.write(muxer.mux(unit));
        },
        end: () => res.end(),
      };
      req.on("close", () => connector.live.removeViewer(sn, viewer));
      await connector.live.addViewer(sn, viewer);
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

    "POST station": async ({ req, res, id, action }) => {
      if (action !== "guard") return send(res, 404, { error: "not found" });
      if (!state.stations[id]) return send(res, 404, { error: "unknown station" });
      const body = await readJson(req);
      await connector.setGuardMode(id, body.mode);
      return send(res, 202, { ok: true });
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
