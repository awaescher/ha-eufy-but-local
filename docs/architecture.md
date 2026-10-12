# Architecture

```
 Eufy cloud ──(login, device list, optional push)──┐
                                                    │
 HomeBase 2 ◄──── P2P, LAN only (UDP) ────► eufy-local-bridge (Node, Docker, host network)
   │  event database                         │  HTTP + SSE API (token)
   │  thumbnails                             ▼
   └─ cameras (battery)            Home Assistant ── custom_components/eufy_local
```

## Data flows

| What | Path | Cloud involved |
|---|---|---|
| Login, device list | bridge -> Eufy cloud (once at start) | yes |
| Local events | bridge polls `databaseQueryLatestInfo()` every 5 s; rising `event_count` = new recording | no |
| Thumbnails | `crop_local_path` from the database -> `downloadImage()` | no |
| Live view | HA opens `/api/stream/{sn}` -> bridge starts P2P livestream -> raw H.264 | no |
| Guard mode | HA service -> bridge -> `setStationProperty(guardMode)` via P2P | no |
| Person/motion type | Eufy push notification (FCM) -> bridge | yes (supplementary) |
| Battery | device list at start, then property updates | partly |

## Home Assistant entities (per camera unless noted)

- `camera`: still image = latest event thumbnail (never wakes the camera), stream on demand
- `event` "Activity": `local_recording`, `person` (cloud), `motion` (cloud)
- `binary_sensor` "Event (local)": on for 30 s after a new local recording
- `image` "Last event image": for notifications via `/api/image_proxy/...`
- `sensor`: battery, last event (timestamp), stored events (diagnostic)
- HomeBase: `alarm_control_panel` (Away/Home/Disarmed), `binary_sensor` "Local P2P connection"

## Bridge internals

`server.mjs` wires: `BridgeState` (observable snapshot + events) <- `EufyConnector`
(eufy-security-client events) -> `ImageStore` and `LiveStreams`; `createApi()` serves the
snapshot and forwards state changes (debounced 200 ms) and events over SSE.

Livestream lifecycle: first viewer -> `startStationLivestream`; frames are fanned out to all
viewers; a GOP cache (from the last SPS) lets late viewers start at a keyframe; when the last
viewer leaves, the stream stops after `LIVE_IDLE_SEC`; the library enforces `LIVE_MAX_SEC`.

Integration internals: `EufyLocalCoordinator` keeps one SSE connection (reconnect with
backoff 2 s -> 60 s) and also polls `/api/state` every 60 s; a failed poll marks entities
unavailable. Discrete events are dispatched to event entities via a dispatcher signal.
