# AGENTS.md

Guidance for coding agents (Claude Code, Codex, …) working on this repository.
Read this file, then `docs/STATUS.md` (current state and open work), then the ADRs in `docs/adr/`.

## What this project is

**Eufy But Local**: a Home Assistant integration for **Eufy HomeBase 2** that delivers events, thumbnails and the
guard mode **locally** (LAN-only P2P), instead of relying on Eufy's cloud push like all other
existing integrations. It consists of two parts:

| Part | Path | Language | Role |
|---|---|---|---|
| Bridge | `bridge/` | Node.js (ESM) | Talks to the HomeBase via `eufy-security-client`, exposes a small HTTP/SSE API |
| Integration | `custom_components/eufy_but_local/` | Python | HACS custom integration, consumes the bridge API |

Why two parts: the reverse-engineered Eufy protocol only exists as a Node library; the HA
container has no Node runtime. See `docs/adr/0001-bridge-plus-integration.md`.

## Ground rules

0. **Local first – hard rule, negotiable only with the maintainer.** Everything that can work
   locally must work locally. The only accepted cloud use is the Eufy login and the device list
   it returns (at bridge start and on re-login). Any other cloud dependency – push
   notifications, cloud thumbnails, cloud event history, cloud polling, anything that keeps a
   connection to Eufy's servers – must be:
   - **off by default**,
   - switchable by the user, with an explanation in the UI of what it does, what works with
     and without it, and the trade-offs,
   - agreed with the maintainer *before* it is implemented, and recorded in an ADR.
   If a feature cannot be done locally, say so and ask; do not quietly fall back to the cloud.
1. **Honesty about "local".** Never claim something works locally or offline unless it is
   verified on real hardware and recorded in `docs/STATUS.md`. The cloud is still required for
   login and the device list at bridge start.
2. **Tested hardware only:** HomeBase 2 (T8010) with eufyCam 2C (T8113) and eufyCam 2C Pro
   (T8142). Nothing else has been tested. Do not advertise other models as supported.
3. **No secrets in the repo.** No real emails, passwords, tokens, serial numbers or IPs in code,
   tests, fixtures or docs. Use the simulator serials (`T8010SIM…`, `T8113SIM…`) and
   `example.com`/`192.168.1.x`. The maintainer's private values must never be committed.
4. **English** for code, comments, logs, commit messages and docs. German exists only in
   `custom_components/eufy_but_local/translations/de.json`.
5. Comments only where they explain *why*, not *what*.
6. Keep the bridge API contract in sync on both sides (see "API contract" below) and update
   `tests/conftest.py` (`FakeBridge`) when it changes.
## Commands

```bash
# Bridge
cd bridge
npm install
npm test                       # node:test, no extra dependencies
npm run simulator              # bridge with a simulated HomeBase (2FA code 123456)
                               # SIM_VIDEO_DELAY_MS=5000: audio before the first keyframe
                               # SIM_AUDIO_DELAY_MS=1500: audio late, library reports none
                               # SIM_RAW_AUDIO=1: audio without ADTS (older eufyCam 2C)
node --test --experimental-test-coverage test/*.test.mjs

# Integration
python3.14 -m venv .venv   # HA 2026.10 needs Python >= 3.14.2 && . .venv/bin/activate
pip install -r requirements-test.txt
pytest                         # uses pytest-homeassistant-custom-component (pinned)
ruff check . && ruff format --check .
pytest --cov --cov-report=term-missing
```

Python tests start a fake bridge on 127.0.0.1; fixtures that need sockets depend on
`socket_enabled` (the HA test harness blocks sockets by default).

## Layout

```
bridge/
  server.mjs            entry point (wires config, state, connector, HTTP)
  src/config.mjs        env -> config
  src/state.mjs         observable state (stations, cameras, phase) + discrete events
  src/eufy.mjs          EufyConnector: eufy-security-client events -> state
  src/images.mjs        serialized thumbnail downloads from the HomeBase database
  src/live.mjs          on-demand livestreams, viewer refcount, GOP cache, one camera per station
  src/flv.mjs           FLV muxer (H.264 + AAC), the integration's stream source (ADR 0013)
  src/mpegts.mjs        MPEG-TS muxer (H.264 + AAC/ADTS)
  src/properties.mjs    whitelist of camera/HomeBase properties exposed to Home Assistant
  src/image-v2.mjs      v2 thumbnail decoder (ported, see third-party/)
  src/h264.mjs          Annex-B helpers (SPS detection)
  src/http.mjs          HTTP + SSE API
  src/credentials.mjs   credential file (mode 0600)
  src/simulator.mjs     fake HomeBase implementing the used subset of eufy-security-client
  simulator-assets/     test video (H.264 Annex-B) and thumbnails, generated with ffmpeg
  test/                 node:test suites
custom_components/eufy_but_local/
  api.py                BridgeClient (REST + SSE parser)
  coordinator.py        DataUpdateCoordinator; SSE push with polling fallback
  config_flow.py        bridge -> login -> 2FA/captcha; reauth for the token
  camera.py event.py binary_sensor.py image.py sensor.py alarm_control_panel.py
  diagnostics.py
tests/                  pytest suites + FakeBridge (conftest.py)
devenv/                 Docker: Home Assistant + bridge simulator; stream_probe.py (HA stream worker)
.github/workflows/      ci.yml (tests, ruff, hassfest, HACS, image build; PRs and reused),
                        release.yml (every push to main: CI, next patch version, image to
                        GHCR + optional Docker Hub, tag, GitHub release with eufy_but_local.zip)
docs/                   STATUS.md, architecture.md, offline-test-plan.md, adr/
```

## API contract (bridge <-> integration)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | no auth; `{ok, version, phase, auth, simulator}` |
| GET | `/api/state` | snapshot, see below |
| GET | `/api/events` | SSE; `event: state` (full snapshot) and `event: event` (`{type, device_sn, source?, count?, at}`) |
| POST | `/api/login` | `{email, password, country}` -> 202; progress via `phase` |
| POST | `/api/code` | `{code}` 2FA code or captcha answer |
| GET | `/api/captcha` | image while `phase == "captcha"` |
| GET | `/api/image/{sn}` | latest event thumbnail (JPEG) or 404 |
| GET | `/api/frame/{sn}[.h264]` | latest live keyframe (SPS/PPS + IDR, raw H.264), kept after the stream ended; 404 if none; never starts the camera |
| GET | `/api/stream/{sn}[.flv\|.ts\|.h264]` | FLV (used by the integration, ADR 0013) or MPEG-TS (H.264 + AAC; default without extension) or `.h264` raw video; first viewer wakes the camera; 409 while displaced by another camera of the station |
| POST | `/api/station/{sn}/guard` | `{mode}`: `AWAY`, `HOME`, `DISARMED`, … |
| POST | `/api/device/{sn}/property` | `{name, value}`: write a camera property over P2P; answers `{returnCode, ms}` once the HomeBase confirms |
| POST | `/api/station/{sn}/property` | `{name, value}`: same for the HomeBase |
| POST | `/api/device/{sn}/command` | `{name, seconds?}`: `alarm`, `stopAlarm`, `snooze` (P2P) |
| POST | `/api/station/{sn}/command` | `{name, seconds?}`: `alarm`, `stopAlarm`, `reboot` (P2P) |
| POST | `/api/config` | `{cloudPush: bool}`; sent by the integration on every setup (ADR 0011) |
| GET | `/api/device/{sn}/properties` | diagnostics: library property values, writable names, commands |
| GET | `/api/station/{sn}/events?hours=24` | diagnostics: local event records from the HomeBase database (P2P) |
| POST | `/api/simulator/{sn}/event` | simulator only |

Auth: `Authorization: Bearer <BRIDGE_TOKEN>` or `?token=` (needed for stream URLs).

Snapshot shape:

```json
{
  "version": "0.1.0", "phase": "ok", "message": "", "cloud": true, "cloudPush": false,
  "stations": { "<sn>": { "name": "", "model": "T8010", "p2p": true, "guardMode": 1, "guardModeName": "HOME",
                          "properties": { "alarmVolume": 26, "...": "see bridge/src/properties.mjs" } } },
  "cameras": { "<sn>": { "name": "", "model": "T8113", "station": "<sn>", "battery": 87, "count": 120,
                         "lastEventAt": null, "imageAt": null, "frameAt": null, "live": false, "codec": null,
                         "personAt": null, "motionAt": null, "properties": { "statusLed": false, "...": "" } } }
}
```

Event `type` values: `local_recording` (HomeBase database), `person` (`source: local` for
humans-only cameras, or `cloud`), `motion` (cloud push),
`image` (new thumbnail available).

## Conventions

- Bridge: ESM, no build step, runtime dependencies only `eufy-security-client` and `jpeg-js`
  (v2 thumbnails, ADR 0005). Ported third-party code is listed in `bridge/third-party/`.
  Inject collaborators (the connector receives `lib`) so tests can use the simulator.
- Ignore late events from a replaced/closed client (see `#wire` in `eufy.mjs`); this prevented
  a real timer leak.
- Integration: follow current HA patterns (`entry.runtime_data`, `has_entity_name`,
  translation keys, `AddConfigEntryEntitiesCallback`). Minimum HA version is in `hacs.json`.
- Every behaviour change needs a test on the side it touches.
