# ADR 0001: Node bridge plus Python HACS integration

Status: accepted (2026-10-13)

## Context

The only working implementation of the Eufy protocol (cloud login, P2P discovery and
encryption, station event database, image download, livestream) is the reverse-engineered Node
library `eufy-security-client`. HACS integrations run as Python inside Home Assistant; the HA
container (the maintainer runs HA in Docker on a Synology) has no Node runtime and no add-ons.

Options considered:
1. HACS integration + small Node sidecar container.
2. Pure Python integration by porting the needed protocol subset.
3. Extending an MQTT bridge (no HACS, no real camera stream entity).

## Decision

Option 1. The bridge is a thin, versioned Node service; the integration does the HA work.

## Consequences

- Two artifacts to ship (container image + HACS repo), one HTTP contract to keep in sync.
- Protocol fixes from the library community arrive via a dependency update in the bridge.
- A Python port (option 2) stays possible later; the integration would then talk to an
  in-process client instead of HTTP.
