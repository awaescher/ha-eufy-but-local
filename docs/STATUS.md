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
| `tests/test_config_flow.py` | 11 passing, 1 not re-run | `test_account_without_station` now expects abort `no_station`; re-run it |
| `tests/test_init.py` | 6 passing | |
| `tests/test_entities.py` | **hangs** | see open issue 1 |

## Open work, in priority order

1. **Fix hanging `tests/test_entities.py`.** Probable cause: the `freezer` fixture
   (freezegun) also freezes the clock used by the asyncio loop, so `wait_for()` in
   `tests/conftest.py` (which sleeps and checks `loop.time()`) never progresses in tests that
   request `freezer`. Options: drop `freezer` where only real-time waits are needed; in
   `test_local_recording` push the state, wait, and only then use `freezer.tick()` with
   `async_fire_time_changed`; or replace `wait_for` with `hass.async_block_till_done()` plus a
   short bounded loop. Run with `pytest -x -v --timeout 20` (install `pytest-timeout`).
   Also clean up two sloppy spots in that file: the no-op `wait_for(lambda: hass.data and True)`
   lines in `test_camera_image_is_cached_until_a_new_thumbnail`, and the pointless
   `now.replace(microsecond=...)` in `test_local_recording`.
2. Add `tests/test_api.py` for `BridgeClient`: SSE parsing (multi-line data, comments,
   malformed JSON), HTTP error mapping (401 -> `BridgeAuthError`, 5xx -> `BridgeError`).
3. Verify that Home Assistant can play `stream_source()` (raw H.264 over HTTP) with both the
   `stream` component (PyAV) and the built-in go2rtc. If either cannot probe raw Annex-B,
   have the bridge serve MPEG-TS or fMP4 instead (ADR 0006).
4. Dev environment: `devenv/docker-compose.yml` with Home Assistant (custom component
   mounted) and the bridge in simulator mode, plus a short `devenv/README.md`.
5. CI (GitHub Actions): `hassfest`, HACS validation, `pytest`, `npm test`, `ruff`.
6. Publish the bridge image (GHCR, multi-arch amd64/arm64).
7. Real-hardware validation of everything listed above, then update this file and the README.

## Known risks

- `eufy-security-client` (bropat) warns that Eufy is shutting down the legacy APIs it uses;
  the maintainer calls the current release a stopgap. Login may break at any time. The local
  part (P2P, database, thumbnails) is less affected. Migration path: ADR 0010.
- `eufy-security-ws` (the container used by the old fuatakgun integration) stopped finding
  devices in September 2026 according to the German HA community, attributed to Eufy's
  backend migration. That is one reason this project does not depend on it (ADR 0002).
- Livestreams drain the battery cameras. Defaults: max 120 s, stop 10 s after the last viewer.
