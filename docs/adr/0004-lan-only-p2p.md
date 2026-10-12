# ADR 0004: LAN-only P2P, cloud only for login

Status: accepted (2026-10-13)

## Decision

Configure `eufy-security-client` with `p2pConnectionSetup: ONLY_LOCAL` (no relay through Eufy
servers) and `pollingIntervalMinutes: 0` (no periodic cloud refresh). Optionally pin the
station address with `HB_SN` + `HB_IP`. The bridge container runs with `network_mode: host`
because local discovery uses UDP broadcast/port 32108.

## Consequences

- Login and device list still need the cloud at start; a bridge restart without internet fails.
- (Re)connecting the P2P session calls `renewDSKKey()`, which needs the cloud once the
  cloud-issued key has expired. Reconnects during a long outage may therefore fail.
- On hardware the cloud reported no LAN IP for the HomeBase, yet local discovery found it.
