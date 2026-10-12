# ADR 0011: Cloud features are off by default and switched in Home Assistant

Status: accepted (2026-10-13)

## Context

The maintainer's rule (AGENTS.md rule 0): everything that can work locally must; the Eufy login
and its device list are the only accepted cloud use. Exceptions are negotiated, off by default
and explained in the UI.

`eufy-security-client` opens two permanent cloud connections after every login, without an
option to skip them:

- **FCM push** (Google Firebase): Eufy's notifications, the only source that tells a person
  from general motion. A HomeBase 2 does not report this locally: `databaseQueryLatestInfo`
  only returns event counts and the thumbnail path, `databaseQueryLocal` returns no records and
  `databaseQueryByDate` gets no answer (verified on hardware 2026-10-13).
- **MQTT** to Eufy's servers: used for locks and appliances, not for cameras.

## Decision

- The bridge never starts Eufy's MQTT.
- Cloud push is off by default (`EUFY_CLOUD_PUSH`, default `0`). The integration's options
  ("Configure") have a "Cloud push for person/motion events" switch with an explanation of what
  works with and without it. The integration sends the option to the bridge
  (`POST /api/config {cloudPush}`) on every setup; the option is the source of truth.
- While push is off, the bridge ignores push events as well.

## Consequences

- Default operation needs the internet only for the login. New recordings, images, live view,
  guard mode and settings are local.
- Without push there are no "person" / "motion" event types; every new recording arrives as
  `local_recording`. Revisit if a local source for the detection type turns up (e.g. another
  database read of the HomeBase, as mega-yfue/eufy-sdk implements for `history_record_info`).
- Both connections are suppressed by wrapping library internals (`registerPushNotifications`,
  `mqttService.connect`); re-check this on every library upgrade (ADR 0010).
