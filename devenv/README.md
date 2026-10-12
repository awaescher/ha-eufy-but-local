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

## Testing real cameras with this Home Assistant

The bridge for the real HomeBase runs **natively on the Mac**, not in Docker: under Docker Desktop
a container is not on your LAN, so the local P2P discovery (UDP broadcast) would not reach the
HomeBase. The Home Assistant container reaches the native bridge at `host.docker.internal`.

Prerequisites: the Mac is on the same network as the HomeBase, and a secondary Eufy account has
the HomeBase shared with admin rights (see the main README).

```bash
cd bridge
npm ci
mkdir -p data && [ -f data/token ] || openssl rand -hex 24 > data/token   # once
BRIDGE_PORT=3081 BRIDGE_TOKEN="$(cat data/token)" DATA_DIR=./data node server.mjs
```

Port 3081 keeps it apart from the simulator on 3080; `bridge/data/` (session, credentials,
token) is git-ignored. On the first start macOS may ask whether the terminal may access devices
on the local network, and whether `node` may accept incoming connections: allow both, P2P
needs them.

Then in Home Assistant: *Add integration → HALEC*, host `host.docker.internal`, port `3081`,
the token from `bridge/data/token`. Log in with the secondary account and enter the code Eufy
sends. The real HomeBase appears as a second entry next to the simulated one.

What to look at, in this order (record results in `docs/STATUS.md`):

1. Bridge log: login, device list, `P2P connected … (LAN only)`.
2. Walk past a camera: does "Stored events" rise and "Event (local)" turn on?
3. Does "Last event image" show the new thumbnail?
4. Live view of one camera (HLS works here; WebRTC needs a real HA install, see below).
   `.venv/bin/python devenv/stream_probe.py "http://127.0.0.1:3081/api/stream/<sn>?token=<token>"`
   checks the stream without the browser.
5. Switch the guard mode from Home Assistant and check it in the Eufy app.

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
