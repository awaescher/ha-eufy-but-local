# ADR 0002: Own bridge instead of eufy-security-ws

Status: accepted (2026-10-13)

## Context

`eufy-security-ws` (bropat) already wraps `eufy-security-client` and even exposes the needed
commands (`station.database_query_latest_info`, `station.download_image`, livestream).
However, in September 2026 it stopped finding devices for many users (attributed to Eufy's
backend migration), the HA integration built on it (fuatakgun/eufy_security) is no longer
maintained, and its generic API pushes livestream frames over WebSocket.

## Decision

Write a small purpose-built bridge on top of `eufy-security-client` directly.

## Consequences

- We control the few things that matter here: LAN-only P2P, database polling, serialized
  thumbnail downloads, on-demand HTTP livestreams with GOP cache, token auth.
- We do not inherit eufy-security-ws' WebSocket schema versioning.
- We own maintenance of ~600 lines of Node.
