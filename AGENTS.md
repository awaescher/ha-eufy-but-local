# AGENTS.md

Guidance for coding agents (Claude Code, Codex, …) working on this repository.
Read this file, then `docs/STATUS.md` (current state and open work), then the ADRs in `docs/adr/`.

## What this project is

A Home Assistant integration for **Eufy HomeBase 2** that delivers events, thumbnails and the
guard mode **locally** (LAN-only P2P), instead of relying on Eufy's cloud push like all other
existing integrations. It consists of two parts:

| Part | Path | Language | Role |
|---|---|---|---|
| Bridge | `bridge/` | Node.js (ESM) | Talks to the HomeBase via `eufy-security-client`, exposes a small HTTP/SSE API |
| Integration | `custom_components/eufy_local/` | Python | HACS custom integration, consumes the bridge API |

Why two parts: the reverse-engineered Eufy protocol only exists as a Node library; the HA
container has no Node runtime. See `docs/adr/0001-bridge-plus-integration.md`.

## Ground rules

1. **Honesty about "local".** Never claim something works locally or offline unless it is
   verified on real hardware and recorded in `docs/STATUS.md`. The cloud is still required for
   login and the device list at bridge start.
2. **Tested hardware only:** HomeBase 2 (T8010) with eufyCam 2C (T8113) and eufyCam 2C Pro
   (T8142). Nothing else has been tested. Do not advertise other models as supported.
3. **No secrets in the repo.** No real emails, passwords, tokens, serial numbers or IPs in code,
   tests, fixtures or docs. Use the simulator serials (`T8010SIM…`, `T8113SIM…`) and
   `example.com`/`192.168.1.x`. The maintainer's private values must never be committed.
4. **English** for code, comments, logs, commit messages and docs. German exists only in
   `custom_components/eufy_local/translations/de.json`.
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
  src/live.mjs          on-demand livestreams, viewer refcount, GOP cache
  src/h264.mjs          Annex-B helpers (SPS detection)
  src/http.mjs          HTTP + SSE API
  src/credentials.mjs   credential file (mode 0600)
  src/simulator.mjs     fake HomeBase implementing the used subset of eufy-security-client
  simulator-assets/     test video (H.264 Annex-B) and thumbnails, generated with ffmpeg
  test/                 node:test suites
custom_components/eufy_local/
  api.py                BridgeClient (REST + SSE parser)
  coordinator.py        DataUpdateCoordinator; SSE push with polling fallback
  config_flow.py        bridge -> login -> 2FA/captcha; reauth for the token
  camera.py event.py binary_sensor.py image.py sensor.py alarm_control_panel.py
  diagnostics.py
tests/                  pytest suites + FakeBridge (conftest.py)
devenv/                 Docker: Home Assistant + bridge simulator; stream_probe.py (HA stream worker)
.github/workflows/      ci.yml (tests, ruff, hassfest, HACS, image build), bridge-image.yml (GHCR on tags)
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
| GET | `/api/stream/{sn}[.h264]` | raw H.264 Annex-B; first viewer wakes the camera |
| POST | `/api/station/{sn}/guard` | `{mode}`: `AWAY`, `HOME`, `DISARMED`, … |
| POST | `/api/simulator/{sn}/event` | simulator only |

Auth: `Authorization: Bearer <BRIDGE_TOKEN>` or `?token=` (needed for stream URLs).

Snapshot shape:

```json
{
  "version": "0.1.0", "phase": "ok", "message": "", "cloud": true,
  "stations": { "<sn>": { "name": "", "model": "T8010", "p2p": true, "guardMode": 1, "guardModeName": "HOME" } },
  "cameras": { "<sn>": { "name": "", "model": "T8113", "station": "<sn>", "battery": 87, "count": 120,
                         "lastEventAt": null, "imageAt": null, "live": false, "codec": null,
                         "personAt": null, "motionAt": null } }
}
```

Event `type` values: `local_recording` (HomeBase database), `person` / `motion` (cloud push),
`image` (new thumbnail available).

## Conventions

- Bridge: ESM, no build step, no runtime dependencies besides `eufy-security-client`.
  Inject collaborators (the connector receives `lib`) so tests can use the simulator.
- Ignore late events from a replaced/closed client (see `#wire` in `eufy.mjs`); this prevented
  a real timer leak.
- Integration: follow current HA patterns (`entry.runtime_data`, `has_entity_name`,
  translation keys, `AddConfigEntryEntitiesCallback`). Minimum HA version is in `hacs.json`.
- Every behaviour change needs a test on the side it touches.
