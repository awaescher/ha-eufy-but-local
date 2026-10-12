# ADR 0010: Pin eufy-security-client; keep the login replaceable

Status: accepted (2026-10-13)

## Context

`eufy-security-client` 3.8.x works for the maintainer today, but its README warns that Eufy
is removing the legacy APIs and that the library will stop working once they are gone. A new
SDK targeting the current Eufy backend exists (mega-yfue/eufy-sdk, young, Node >= 24.5).

## Decision

- Pin `eufy-security-client` to `~3.8.0`; upgrade deliberately with a hardware check.
- Keep all library access inside `EufyConnector` (`bridge/src/eufy.mjs`). If the legacy login
  breaks, evaluate replacing the login/device-list part with the new SDK while keeping the
  local parts (P2P, database, thumbnails, stream) where they still work.
