# ADR 0012: Feature set (maintainer decisions)

Status: accepted (2026-10-13). Basis: `docs/feature-decision.md`.

## Decisions

1. **Local package: yes.** Add the local entities of `feature-decision.md` section 4.1
   (switches, numbers, selects, spotlight, sirens, HomeBase reboot, diagnostic sensors).
   Rarely used ones are created disabled by default.
2. **Local person labelling: yes.** When a camera's motion detection type is "humans only",
   its local recordings are reported as `person` (source `local`).
3. **Recordings in the media browser: later.** First check whether the HomeBase 2 lists
   recordings locally and how often a cloud key would be needed. Any cloud part stays opt-in.
4. **Two-way audio: later.**
5. **Firmware: version only.** Show the installed firmware (from the login's device list) as a
   diagnostic sensor; no cloud update check.
6. **go2rtc crash** (nil codec when a WebRTC request arrives while the source is unreachable):
   not reported upstream; documented in `docs/STATUS.md`.

## Before enabling writable entities

Verify on hardware, with one camera's status LED: whether writing a setting wakes the camera,
and whether a change made in the Eufy app reaches the bridge while it runs.
