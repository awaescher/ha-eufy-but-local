# ADR 0003: Local-first events from the HomeBase event database

Status: accepted (2026-10-13)

## Context

All existing integrations (fuatakgun, mega-yfue/ha-eufy-sdk, Homebridge, Homey) receive motion
and person events from Eufy's cloud push (FCM). The Homey maintainer states events only work
via notifications. Without internet, HA receives no events at all.

The HomeBase keeps a local event database. `eufy-security-client` can query it over P2P
(`databaseQueryLatestInfo`, supported for HomeBase 2 = device type `STATION`), returning per
camera `event_count` and the path of the latest thumbnail.

## Decision

Poll `databaseQueryLatestInfo()` every `POLL_SEC` (default 5 s) over the local P2P session.
A rising `event_count` is a new recording -> event `local_recording`. Cloud pushes stay as a
supplementary source that tells *what* was detected (`person`, `motion`).

## Consequences

- Events work without the cloud as long as the P2P session is up (to be verified on hardware).
- Latency: recording must be written + up to one poll interval (a few seconds).
- We only learn "something was recorded", not the detection type, from the local path.
- The cameras must be in a recording mode; no recording, no event.
- Querying the station database should not wake battery cameras (data lives on the HomeBase);
  monitor battery levels during the first days.
