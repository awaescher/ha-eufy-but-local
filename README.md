# HALEC – Home Assistant Local Eufy Cams

**HALEC** brings events, thumbnails, live view and guard mode of **Eufy HomeBase 2** cameras to
Home Assistant, delivered over a **LAN-only P2P connection** instead of Eufy's cloud push.

> **Status: early development, not released.**
> What is and is not verified on real hardware is tracked in [docs/STATUS.md](docs/STATUS.md).

## Tested hardware

Only tested with a **HomeBase 2 (T8010)** with **eufyCam 2C (T8113)** and **eufyCam 2C Pro
(T8142)** cameras. Other HomeBase or camera models may work, but nothing else has been tested.

## Why another Eufy integration?

Every existing integration receives motion/person events through Eufy's cloud push. This one
reads them from the HomeBase's **local event database** over P2P inside your network and uses
the cloud push only as an optional extra (to tell a person from generic motion).

| | Cloud-push integrations | This project |
|---|---|---|
| Events | Eufy cloud push | HomeBase event database (local), push optional |
| Thumbnails | from the push | from the HomeBase (local) |
| P2P | may relay through Eufy servers | LAN only |
| Login / device list | cloud | cloud (same) |

## How it works

```
HomeBase 2 ◄── P2P (LAN only) ──► eufy-local-bridge (Docker) ◄── HTTP/SSE ──► Home Assistant
                                        │
                                        └── Eufy cloud: login + device list at start
```

The protocol is only available as a Node library, so a small bridge container runs next to
Home Assistant. Details: [docs/architecture.md](docs/architecture.md),
decisions: [docs/adr/](docs/adr/README.md).

## What is local, and what is not

| Function | Needs internet? | Verified on hardware |
|---|---|---|
| Bridge start (login, device list) | **yes** | yes |
| P2P connection to the HomeBase | no | yes |
| Event counts from the local database | no | yes (counts read) |
| New-event detection | no | not yet |
| Thumbnails | no | not yet |
| Live view | no | not yet |
| Guard mode | no | not yet |
| Person vs. motion | **yes** (cloud push) | not yet |
| Keeps working during an internet outage | partly, see [offline test plan](docs/offline-test-plan.md) | not yet |

## Entities

Per camera: camera (still image = latest event thumbnail, live view on demand), event
"Activity" (`local_recording`, `person`, `motion`), binary sensor "Event (local)", image
"Last event image", battery, last event, stored events.
Per HomeBase: alarm panel, select "Guard mode", "Local P2P connection".

The alarm panel offers Home Assistant's fixed states. Eufy modes without an equivalent
(schedule, geofencing, custom 1-3) show as "armed custom bypass"; the select "Guard mode" shows
and sets every Eufy mode by its own name.

The integration is translated into English and German; Home Assistant picks the language of
the user interface.

## Network

"LAN-only" describes the path, not the cable: the bridge talks to the HomeBase directly inside
your network instead of through Eufy's servers. Ethernet or Wi-Fi makes no difference as long as:

- the bridge host and the HomeBase are in the same IP network (the bridge finds the HomeBase by
  UDP broadcast);
- the Wi-Fi does not isolate clients from each other (guest networks, "AP/client isolation")
  and passes broadcasts. If discovery fails, set `HB_IP` (and `HB_SN`) to skip it;
- in Docker the bridge uses host networking (`network_mode: host`).

Tested so far with the bridge host on Ethernet; Wi-Fi for the bridge host is untested.

## Installation

### 1. Secondary Eufy account

Eufy allows one session per account. Create a second account (same country as your main
account), share the HomeBase with it **with admin rights**, and accept the invitation once in
the Eufy app.

### 2. Bridge (Docker)

The bridge must be on the same LAN as the HomeBase and use host networking.

```bash
cd bridge
# edit docker-compose.yml: set BRIDGE_TOKEN to a long random value
docker compose up -d --build
docker logs -f eufy-local-bridge
```

Settings (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_PORT` | `3080` | HTTP port |
| `BRIDGE_TOKEN` | – | API token (strongly recommended) |
| `HB_IP`, `HB_SN` | – | pin the HomeBase address (serial is logged on first start) |
| `POLL_SEC` | `5` | event database poll interval |
| `LIVE_MAX_SEC` | `120` | maximum livestream duration |
| `LIVE_IDLE_SEC` | `10` | stop the stream this long after the last viewer left |
| `DATA_DIR` | `/data` | session and credentials (file mode 600) |
| `EUFY_EMAIL`, `EUFY_PASSWORD`, `EUFY_COUNTRY` | – | optional; otherwise log in from Home Assistant |
| `EUFY_SIMULATOR` | – | `1` = simulated HomeBase for development |

### 3. Integration (HACS)

Add `https://github.com/awaescher/ha-local-eufy-cams` as a custom repository (type
*Integration*) in HACS, install
"HALEC – Home Assistant Local Eufy Cams", restart Home Assistant, then add the integration and enter the
bridge host, port and token. If the bridge is not logged in yet, the flow asks for the Eufy
account and the verification code.

## Development

See [AGENTS.md](AGENTS.md) for commands, layout and the bridge API contract.

```bash
cd bridge && npm install && npm test        # bridge tests (simulator, no hardware)
pip install -r requirements-test.txt && pytest
cd bridge && npm run simulator              # bridge with a simulated HomeBase, 2FA code 123456
```

[devenv/](devenv/README.md) runs Home Assistant with this integration and the simulated
HomeBase in Docker, no Eufy account or hardware needed.

## Disclaimer

Not affiliated with Anker or Eufy. Uses the unofficial, reverse-engineered
[eufy-security-client](https://github.com/bropat/eufy-security-client), whose author warns that
Eufy is shutting down the legacy APIs it relies on.

## License

[MIT](LICENSE) © Andreas Wäscher
