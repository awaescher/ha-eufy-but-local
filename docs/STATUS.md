# Status and handoff

Last updated: 2026-10-13. Version 0.1.0, not released.

## Verified on real hardware (maintainer's HomeBase 2)

Verified with an earlier standalone prototype (same library and settings as `bridge/`):

- Login with a secondary account and 2FA via `eufy-security-client` 3.8.
- LAN-only P2P connection (`P2PConnectionType.ONLY_LOCAL`) to a HomeBase 2 (T8010).
  Notably the cloud reported **no** LAN IP for the station; the connection was found via local
  discovery.
- `databaseQueryLatestInfo()` answers with per-camera event counts for all 7 cameras
  (T8113, T8142 incl. "-R"/"-V" variants); battery levels arrive.

Not yet verified on hardware:

- A rising event count when someone walks past a camera (the core "local event" claim).
- Thumbnail download via `downloadImage()` from the local database.
- P2P livestream of these camera models, and its playback through Home Assistant.
- Guard mode switching via `setStationProperty(…, guardMode, …)`.
- Behaviour without internet (see `offline-test-plan.md`).
- The bridge and integration in this repository as a whole (only the prototype ran).

## Automated tests

| Suite | Result | Notes |
|---|---|---|
| `bridge`: `npm test` | 42 passing | ~97 % line coverage (node built-in coverage) |
| `tests/test_config_flow.py` | 12 passing | |
| `tests/test_init.py` | 6 passing | |
| `tests/test_entities.py` | 15 passing | |
| `tests/test_api.py` | 12 passing | `BridgeClient`: SSE parsing, error mapping (100 % of `api.py`) |

Python suites run against Home Assistant 2026.10.1 (Python 3.14), 98 % line coverage.
`ruff check` and `ruff format --check` are clean.

## Open work, in priority order

1. Verify HA's built-in go2rtc (WebRTC) with the raw H.264 source. The `stream` component
   (HLS) works against the simulator once the camera sets `use_wallclock_as_timestamps`
   (ADR 0006, `devenv/stream_probe.py`). If go2rtc fails, serve MPEG-TS or fMP4 instead.
2. Dev environment: `devenv/docker-compose.yml` with Home Assistant (custom component
   mounted) and the bridge in simulator mode, plus a short `devenv/README.md`.
3. CI (GitHub Actions): `hassfest`, HACS validation, `pytest`, `npm test`, `ruff`.
4. Publish the bridge image (GHCR, multi-arch amd64/arm64).
5. Real-hardware validation of everything listed above, then update this file and the README.

## Known risks

- `eufy-security-client` (bropat) warns that Eufy is shutting down the legacy APIs it uses;
  the maintainer calls the current release a stopgap. Login may break at any time. The local
  part (P2P, database, thumbnails) is less affected. Migration path: ADR 0010.
- `eufy-security-ws` (the container used by the old fuatakgun integration) stopped finding
  devices in September 2026 according to the German HA community, attributed to Eufy's
  backend migration. That is one reason this project does not depend on it (ADR 0002).
- Livestreams drain the battery cameras. Defaults: max 120 s, stop 10 s after the last viewer.
