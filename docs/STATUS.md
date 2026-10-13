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

With this repository (bridge natively on macOS, Home Assistant 2026.10.1 from `devenv/`),
2026-10-13:

- Login with 2FA through the config flow; `eufy-security-client` 3.8.0 still logs in.
- Device list: HomeBase 2 plus 7 cameras (T8113, T8113-V, T8142-R); LAN-only P2P connects.
- Initial event counts and battery levels per camera.
- P2P livestream of a T8113 (H.264, 1920x1080) plays in Home Assistant (HLS).
- Thumbnails from the local database arrive, but in the `v2_eufysecurity:` format that 3.8.0
  does not decrypt; the bridge now decodes v2 itself (ADR 0005). A real thumbnail decoded to
  640x368 (camera: 640x360, the last 8 rows are padding).
- The HomeBase streams one camera at a time: starting a second camera stopped the first, and
  Home Assistant's reconnects made them displace each other. The bridge now arbitrates
  (`bridge/src/live.mjs`); re-test on hardware.
- Guard mode `SCHEDULE` is reported; it showed as unknown and now maps to "armed custom bypass".
- Audio: the cameras send AAC-LC 16 kHz mono over P2P; the bridge's MPEG-TS carries it.
- Writing a camera setting over P2P (status LED, via `POST /api/device/{sn}/property`): the
  HomeBase confirms in 0.3–0.5 s, so it most likely does not wake the camera (a livestream wake
  takes ~1.9 s).
- Changes made in the Eufy app while the bridge runs: the spotlight (`light`) arrives locally in
  real time; night vision (`nightvision`) does not, so Home Assistant shows the old value until
  the bridge reconnects. On every P2P connect the HomeBase reports current values (battery,
  battery temperature, Wi-Fi, some recording settings) by itself.
- The HomeBase 2 does not answer the detailed local event queries (`databaseQueryLocal`: 0
  records, `databaseQueryByDate`: no answer), so person vs. motion is not available locally
  (ADR 0011).

Not yet verified on hardware:

- A rising event count when someone walks past a camera (the core "local event" claim).
- v2 thumbnails and stream switching in the running bridge (fixed after the first test).
- Livestream of the T8142 (2C Pro) cameras; WebRTC (go2rtc) on a real HA install.
- Guard mode switching via `setStationProperty(…, guardMode, …)`.
- Behaviour without internet (see `offline-test-plan.md`).

## Verified against the simulator in a real Home Assistant (2026.10.1, `devenv/`)

- Config flow: bridge -> Eufy login -> 2FA code -> entry with HomeBase and three cameras.
- Simulated local event: event entity fires, "Event (local)" turns on, stored-events counter
  and last-event image update.
- Live view in the browser via HLS (`stream` component). go2rtc reads the raw H.264 source and
  decodes frames; a WebRTC session could not be tested under Docker Desktop (see
  `devenv/README.md`).
- Guard mode: arming away from HA sets `AWAY` on the bridge.
- Bridge loses its login: HA shows the integration as needing reconfiguration; logging in again
  from the UI restores all entities.

## Automated tests

| Suite | Result | Notes |
|---|---|---|
| `bridge`: `npm test` | 42 passing | ~97 % line coverage (node built-in coverage) |
| `tests/test_config_flow.py` | 16 passing | |
| `tests/test_init.py` | 8 passing | |
| `tests/test_entities.py` | 15 passing | |
| `tests/test_api.py` | 12 passing | `BridgeClient`: SSE parsing, error mapping (100 % of `api.py`) |

Python suites run against Home Assistant 2026.10.1 (Python 3.14), 98 % line coverage.
`ruff check` and `ruff format --check` are clean.

## Open work, in priority order

1. Verify HA's built-in go2rtc (WebRTC) with the raw H.264 source. The `stream` component
   (HLS) works against the simulator once the camera sets `use_wallclock_as_timestamps`
   (ADR 0006, `devenv/stream_probe.py`). If go2rtc fails, serve MPEG-TS or fMP4 instead.
2. Real-hardware validation of everything listed above, then update this file and the README.
3. Optional: submit to the HACS default list and to home-assistant/brands (icon/logo; the
   HACS check currently ignores `brands`). Docker Hub is optional (variable
   `DOCKERHUB_USERNAME`, secret `DOCKERHUB_TOKEN`).

Done: the first release (v0.1.0) went through `release.yml` on GitHub: CI including hassfest
and the HACS check, the image (amd64 + arm64, public), the tag, and the GitHub release.
v0.1.0 still used the old names (image `ghcr.io/awaescher/eufy-local-bridge`, domain
`eufy_local`, `eufy_local.zip`); from v0.1.1 on they are `ghcr.io/awaescher/eufy-but-local`,
`eufy_but_local` and `eufy_but_local.zip`. The bridge still registers with Eufy as trusted
device `eufy-local-bridge` so existing sessions need no new 2FA code.

## Known risks

- go2rtc 1.9.14 (bundled with Home Assistant) crashed several times with a nil pointer in
  `Codec.Match` when a WebRTC request arrived while the bridge stream was unreachable (bridge
  restart, or a camera refused with 409). Home Assistant restarts go2rtc automatically. Not
  reproducible on demand; not reported upstream (ADR 0012).

- `eufy-security-client` (bropat) is archived (2026-09-12) and deprecated on npm; the author
  points to mega-yfue/eufy-sdk. Eufy is shutting down the legacy APIs it uses, so login may
  break at any time. The first hardware test shows whether 3.8.0 still logs in today. The local
  part (P2P, database, thumbnails) is less affected. Migration path: ADR 0010.
- `eufy-security-ws` (the container used by the old fuatakgun integration) stopped finding
  devices in September 2026 according to the German HA community, attributed to Eufy's
  backend migration. That is one reason this project does not depend on it (ADR 0002).
- Livestreams drain the battery cameras. Defaults: max 120 s, stop 10 s after the last viewer.
