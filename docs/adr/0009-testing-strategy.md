# ADR 0009: Testing without hardware

Status: accepted (2026-10-13)

## Decision

- **Bridge:** `node:test` (no dependencies). `src/simulator.mjs` implements the subset of the
  `eufy-security-client` API the connector uses (2FA, station/devices, event database,
  thumbnails, livestream from a generated H.264 file, guard mode). The connector receives the
  library as a parameter, so the same code runs against the simulator or the real library.
  End-to-end tests drive the real HTTP API over sockets.
- **Integration:** `pytest-homeassistant-custom-component`. `tests/conftest.py` contains a
  `FakeBridge` aiohttp server that implements the bridge contract over real HTTP/SSE, so the
  integration's client, SSE parser and coordinator are exercised for real.
- **Dev environment:** the bridge has a simulator mode (`EUFY_SIMULATOR=1`, 2FA code
  `123456`, random events every `SIM_EVENT_INTERVAL` seconds) to run a full HA instance
  against it (planned: `devenv/`).
- **Hardware:** only the maintainer's HomeBase 2 setup; results go to `docs/STATUS.md`.

## Consequences

The fake bridge must be updated with every API change (it is the contract test for the
integration side).
