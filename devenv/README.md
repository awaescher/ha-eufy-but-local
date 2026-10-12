# Development environment

Home Assistant with this integration mounted, plus the bridge with a simulated HomeBase
(three cameras, test video, thumbnails). No Eufy account or hardware needed.

```bash
cd devenv
docker compose up -d --build
```

1. Open <http://127.0.0.1:8123> and create a user (onboarding).
2. *Settings → Devices & services → Add integration → HALEC – Home Assistant Local Eufy Cams*:
   host `bridge`, port `3080`, token `dev-token`.
3. Log in with any email and password, verification code `123456`.

Trigger a new "local" event on a simulated camera:

```bash
curl -X POST -H "Authorization: Bearer dev-token" http://127.0.0.1:3080/api/simulator/T8113SIM0000001/event
```

After changing the integration, restart Home Assistant: `docker compose restart homeassistant`.
After changing the bridge: `docker compose up -d --build bridge`. The bridge keeps its session
in memory only, so after a bridge restart Home Assistant asks to reconfigure the integration:
log in again with code `123456`.

Everything Home Assistant writes to `config/` is git-ignored except `configuration.yaml`.

## Checking the live view without Home Assistant

`stream_probe.py` runs Home Assistant's real stream worker against a bridge stream URL and
reports the HLS segments it produces. It works against the simulator and against real hardware:

```bash
.venv/bin/python devenv/stream_probe.py "http://127.0.0.1:3080/api/stream/T8113SIM0000001?token=dev-token"
```

## Known limitation

WebRTC (go2rtc) does not connect in this setup on Docker Desktop: go2rtc runs inside the
container and offers ICE candidates the browser cannot reach. Home Assistant falls back to HLS,
which works. Check WebRTC on a real Home Assistant installation with host networking.
