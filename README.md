# Eufy But Local

[![Release](https://img.shields.io/github/v/release/awaescher/ha-eufy-but-local?sort=semver)](https://github.com/awaescher/ha-eufy-but-local/releases/latest)
[![Release workflow](https://github.com/awaescher/ha-eufy-but-local/actions/workflows/release.yml/badge.svg)](https://github.com/awaescher/ha-eufy-but-local/actions/workflows/release.yml)
[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz/docs/faq/custom_repositories)
[![Bridge image](https://img.shields.io/badge/ghcr.io-eufy--but--local-blue?logo=docker)](https://github.com/awaescher/ha-eufy-but-local/pkgs/container/eufy-but-local)
[![License: MIT](https://img.shields.io/github/license/awaescher/ha-eufy-but-local)](LICENSE)

**Eufy But Local** brings events, thumbnails, live view and guard mode of **Eufy HomeBase 2** cameras to
Home Assistant, delivered over a **LAN-only P2P connection** instead of Eufy's cloud push.

> **Status: early development, pre-release (0.x).**
> What is and is not verified on real hardware is tracked in [docs/STATUS.md](docs/STATUS.md).

## Tested hardware

Only tested with a **HomeBase 2 (T8010)** with **eufyCam 2C (T8113)** and **eufyCam 2C Pro
(T8142)** cameras. Other HomeBase or camera models may work, but nothing else has been tested.

## Why another Eufy integration?

Every existing integration receives motion/person events through Eufy's cloud push. This one
reads them from the HomeBase's **local event database** over P2P inside your network and uses
the cloud push only as an optional extra (to tell a person from generic motion), which is off
by default and switched in the integration's options.

| | Cloud-push integrations | This project |
|---|---|---|
| Events | Eufy cloud push | HomeBase event database (local), push optional (off by default) |
| Thumbnails | from the push | from the HomeBase (local) |
| P2P | may relay through Eufy servers | LAN only |
| Login / device list | cloud | cloud (same) |

## How it works

```
HomeBase 2 ◄── P2P (LAN only) ──► eufy-but-local (Docker) ◄── HTTP/SSE ──► Home Assistant
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
| Person vs. motion | **yes** (cloud push, off by default) | not yet |
| Keeps working during an internet outage | partly, see [offline test plan](docs/offline-test-plan.md) | not yet |

## Entities

Per camera: camera (still image = latest event thumbnail, live view on demand), event
"Activity" (`local_recording`, `person`, `motion`), binary sensor "Event (local)", image
"Last event image", battery, last event, stored events.
Per HomeBase: alarm panel, select "Guard mode", "Local P2P connection".

Settings, all changed locally over P2P (only what a device reports is created; settings that
only matter for Eufy's app are created disabled):

- Camera: on/off, motion detection, sensitivity, detection type (humans only / all motions),
  spotlight with brightness, night vision, status LED, microphone, speaker and volume, audio
  recording, anti-theft detection, clip length, retrigger interval, power mode, streaming and
  recording quality (2C Pro), siren; diagnostics: Wi-Fi signal, battery temperature, charging,
  firmware. Action `eufy_but_local.snooze`.
- HomeBase: alarm volume, prompt volume, alarm tone, siren, alarm sensor, restart, firmware.

A camera set to detect humans only reports each new local recording also as a `person` event
(source `local`).

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

The bridge must be on the same LAN as the HomeBase and use host networking (a Linux host;
Docker Desktop on macOS/Windows does not give the container the host's network).

Images for amd64 and arm64 are published to `ghcr.io/awaescher/eufy-but-local` on every
release: `latest` and version tags (`0.1.3`, `0.1`, `0`).

```bash
cd bridge
mkdir -p data && sudo chown 1000:1000 data   # the container runs as uid 1000
# edit docker-compose.yml: set BRIDGE_TOKEN to a long random value (e.g. openssl rand -hex 32)
docker compose up -d
docker logs -f eufy-but-local
```

To build the image yourself, replace the `image:` line in `docker-compose.yml` with `build: .`
and run `docker compose up -d --build`.

#### Side by side with Home Assistant

If Home Assistant runs in Docker too, one `docker-compose.yml` can hold both. Both containers
use host networking, so Home Assistant reaches the bridge at `127.0.0.1:3080`.

```yaml
services:
  homeassistant:
    image: ghcr.io/home-assistant/home-assistant:stable
    container_name: homeassistant
    restart: unless-stopped
    network_mode: host
    environment:
      TZ: "Europe/Berlin"
    volumes:
      - ./homeassistant:/config
      - /etc/localtime:/etc/localtime:ro
      - /run/dbus:/run/dbus:ro

  eufy-but-local:
    image: ghcr.io/awaescher/eufy-but-local:latest
    container_name: eufy-but-local
    restart: unless-stopped
    network_mode: host # required for the local UDP/P2P connection to the HomeBase
    environment:
      TZ: "Europe/Berlin"
      BRIDGE_PORT: "3080"
      BRIDGE_TOKEN: "change-me" # long random value, e.g. openssl rand -hex 32
      # HB_IP: "192.168.1.50"   # optional, if discovery fails
      # HB_SN: "T8010..."
    volumes:
      - ./eufy-bridge:/data # must be writable by uid 1000
```

```bash
mkdir -p homeassistant eufy-bridge && sudo chown 1000:1000 eufy-bridge
docker compose up -d
```

In the integration, enter host `127.0.0.1`, port `3080` and the token. If the bridge and Home
Assistant are on different hosts, enter the bridge host's LAN IP instead.

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

[![Open your Home Assistant instance and open this repository in HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=awaescher&repository=ha-eufy-but-local&category=integration)

Or add `https://github.com/awaescher/ha-eufy-but-local` as a custom repository (type
*Integration*) in HACS. Install
"Eufy But Local", restart Home Assistant, then add the integration and enter the
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

### Releases

Every push to `main` is a release (`.github/workflows/release.yml`); pushes that only touch
docs, `devenv/` or Markdown files are skipped. The workflow runs the CI, then:

- picks the next version: major and minor from `bridge/package.json`, patch = highest
  existing `v<major>.<minor>.*` tag + 1. To start a new minor or major version, set it in
  `bridge/package.json` and `manifest.json` (e.g. `0.2.0`);
- publishes the bridge image (`0.1.3`, `0.1`, `0`, `latest`);
- tags `v0.1.3` and creates a GitHub release with `eufy_but_local.zip`, which HACS installs.

The version is stamped into the image and the zip; nothing is committed back to `main`.

The image goes to GHCR. To also publish to Docker Hub, add the repository variable
`DOCKERHUB_USERNAME` and the secret `DOCKERHUB_TOKEN` (a Docker Hub access token).

## Disclaimer

Not affiliated with Anker or Eufy. Uses the unofficial, reverse-engineered
[eufy-security-client](https://github.com/bropat/eufy-security-client), whose author warns that
Eufy is shutting down the legacy APIs it relies on.

## License

[MIT](LICENSE) © Andreas Wäscher
