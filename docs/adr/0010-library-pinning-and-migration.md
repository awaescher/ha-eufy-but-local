# ADR 0010: Pin eufy-security-client; keep the login replaceable

Status: accepted (2026-10-13)

## Context

`eufy-security-client` 3.8.x works for the maintainer today, but its README warns that Eufy
is removing the legacy APIs and that the library will stop working once they are gone. A new
SDK targeting the current Eufy backend exists (mega-yfue/eufy-sdk, young, Node >= 24.5).

Update 2026-10-13: the author archived `bropat/eufy-security-client` on 2026-09-12 and
deprecated every version on npm ("Package no longer supported"); the README names
mega-yfue/eufy-sdk as the successor. 3.8.0 still installs (pinned in `package-lock.json` with
its integrity hash) and gets no further fixes. This makes the migration below a question of
when, not if.

## Decision

- Pin `eufy-security-client` to `~3.8.0`; upgrade deliberately with a hardware check.
- Keep all library access inside `EufyConnector` (`bridge/src/eufy.mjs`). If the legacy login
  breaks, evaluate replacing the login/device-list part with the new SDK while keeping the
  local parts (P2P, database, thumbnails, stream) where they still work.

## Evaluation of the successor (2026-10-13)

Source review (read only, not run) of `@mega-yfue/eufy-sdk` 0.4.0 (commit `7d1f016`,
2026-10-06; Apache-2.0; Node >= 24.5; pre-1.0, actively developed). Findings relevant to a
local-first bridge:

| Need | eufy-security-client 3.8.0 | eufy-sdk 0.4.0 |
|---|---|---|
| Events | local event database polled over P2P | FCM push (cloud) by design |
| P2P connect | `ONLY_LOCAL` | direct UDP; local lookup (broadcast / LAN IP) **and** cloud lookup race in parallel, no public local-only switch |
| Keys | from the cloud at start | DSK key and level-2 cipher key from the cloud on each session open, cached in memory |
| Event database | `databaseQueryLatestInfo()` | `P2PSession.queryDatabase/readDatabase` exist internally (tables incl. `history_record_info`); `CMD_DATABASE_QUERY_LATEST_INFO` only defined as a constant; not public API |
| Event thumbnails | `downloadImage()` from the database | internal `CMD_DATABASE_IMAGE` support; public API returns the push thumbnail |
| Live stream | P2P | P2P, one session per camera |
| Tested models | HomeBase 2, 2C, 2C Pro (prototype) | no model list; HomeBase 2 not confirmed |

Consequence: used as intended, the SDK would turn this project back into a cloud-push
integration. Staying local with it requires (1) its login, device list and key retrieval, (2) a
local-only P2P option (omit the cloud lookup addresses), and (3) the event database and image
commands, which are currently internal. (2) and (3) need an upstream change or a fork.

Decision: stay on 3.8.0 for now. If the legacy login fails on hardware, migrate in two steps:
first login/device list/keys through the SDK with P2P and database access unchanged where
possible, then move P2P to the SDK once it offers local-only connect and a public database API
(ask upstream before forking).
