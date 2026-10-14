# Offline test plan

Goal: find out what keeps working when the house loses internet, and only then write
"works locally" into the README. Record results in `STATUS.md`.

Preparation: bridge and Home Assistant running, integration set up, all cameras visible,
`Local P2P connection` = on. Guard mode set to a recording mode (e.g. Away).

Block internet for the **HomeBase only** first (router: block WAN for its IP), later for the
whole network including the bridge host.

| # | Scenario | Expectation (from code reading) | Result |
|---|---|---|---|
| 1 | HomeBase offline, walk past a camera | Local event count rises, `New recording` turns on, no `person` push | |
| 2 | Same, check thumbnail | New thumbnail via local database | |
| 3 | Same, open live view | Stream via LAN-only P2P | |
| 4 | Same, switch guard mode in HA | Mode changes via P2P | |
| 5 | Restart only the bridge while offline | Fails: login and device list need the cloud | |
| 6 | Pull the HomeBase network cable for 1 min, reconnect (internet still blocked) | Reconnect works only while the cloud-issued DSK key has not expired | |
| 7 | HomeBase offline for several hours | Unknown: community reports disagree on whether the HomeBase still records without internet | |
| 8 | Restore internet | Cloud push resumes, nothing needs a restart | |

Notes:
- The P2P session derives its command key locally from serial number and P2P DID, but a
  (re)connect first calls `renewDSKKey()`, which needs the cloud once the key has expired.
- Keep the bridge console output (`docker logs -f eufy-but-local`) with the results.
