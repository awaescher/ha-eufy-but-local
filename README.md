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

Per camera: camera (still image = latest event thumbnail or the last live frame, whichever is
newer; live view on demand), event
"Activity" (`local_recording`, `person`, `motion`), binary sensor "Motion" (on for 30 s after a new recording), image
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
  and passes broadcasts. If discovery fails, set `HOMEBASE_IP` (and `HOMEBASE_SERIAL`) to skip it;
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
      # HOMEBASE_IP: "192.168.1.50"   # optional, if discovery fails
      # HOMEBASE_SERIAL: "T8010..."
    volumes:
      - ./eufy-bridge:/data # must be writable by uid 1000
```

```bash
mkdir -p homeassistant eufy-bridge && sudo chown 1000:1000 eufy-bridge
docker compose up -d
```

In the integration, enter host `127.0.0.1`, port `3080` and the token. If the bridge and Home
Assistant are on different hosts, enter the bridge host's LAN IP instead.

Settings (environment variables). None of them is strictly required: the bridge starts
with the defaults, and you log in from Home Assistant. In practice, set only
`BRIDGE_TOKEN`, and leave the rest alone unless you need them.

| Variable | Required? | Default | Meaning |
|---|---|---|---|
| `BRIDGE_TOKEN` | **recommended** | – | API token; enter the same value in the integration. Without it, anyone on the LAN can use the API |
| `BRIDGE_PORT` | optional | `3080` | HTTP port |
| `BRIDGE_HOST` | optional | `0.0.0.0` | listen address |
| `HOMEBASE_IP`, `HOMEBASE_SERIAL` | optional | – | pin the HomeBase address if discovery fails (serial is logged on first start) |
| `POLL_SEC` | optional | `2` | how often (seconds) the bridge asks the HomeBase's event database for new recordings (locally, over P2P; wakes no camera) |
| `PROPERTY_REFRESH_SEC` | optional | `60` | how often the bridge asks the HomeBase (locally, over P2P) for the current camera settings, so changes made in the Eufy app show up in Home Assistant; `0` = only when connecting |
| `LIVE_MAX_SEC` | optional | `120` | maximum livestream duration |
| `LIVE_IDLE_SEC` | optional | `10` | stop the stream this long after the last viewer left |
| `DATA_DIR` | optional | `/data` | session and credentials (file mode 600) |
| `EUFY_EMAIL`, `EUFY_PASSWORD`, `EUFY_COUNTRY` | optional | – | log in without Home Assistant; otherwise log in from the integration |
| `BRIDGE_DEBUG` | optional | – | `1` = also log every property value the HomeBase reports (battery, Wi-Fi signal, …) and every P2P message the library does not handle (otherwise the first three per command) |
| `EUFY_SIMULATOR` | development only | – | `1` = simulated HomeBase |

### 3. Integration (HACS)

[![Open your Home Assistant instance and open this repository in HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=awaescher&repository=ha-eufy-but-local&category=integration)

Or add `https://github.com/awaescher/ha-eufy-but-local` as a custom repository (type
*Integration*) in HACS. Install
"Eufy But Local", restart Home Assistant, then add the integration and enter the
bridge host, port and token. If the bridge is not logged in yet, the flow asks for the Eufy
account and the verification code.

## Apple HomeKit

The cameras are ordinary Home Assistant camera entities, so Home Assistant's built-in
[HomeKit Bridge](https://www.home-assistant.io/integrations/homekit/) can show them in the
Home app (iPhone, iPad, Mac, Apple TV). Nothing in this integration is HomeKit-specific.

### Setup

The simplest way: add the cameras to the HomeKit bridge you already use. Entities added to an
already paired bridge show up in the Home app by themselves, no new pairing needed.

```yaml
homekit:
  - name: HASS Bridge
    port: 21063
    filter:
      include_entities:
        - light.living_room          # your existing entities
        - camera.front_door
        - camera.garage
    entity_config:
      camera.front_door:
        support_audio: true
        video_codec: copy            # the bridge already delivers H.264, no transcoding
        linked_motion_sensor: binary_sensor.front_door_motion
      camera.garage:
        support_audio: true
        video_codec: copy
        linked_motion_sensor: binary_sensor.garage_motion
```

Alternatively, Home Assistant's docs suggest one HomeKit instance per camera in accessory
mode. A slow camera stream then cannot slow down the other devices of the shared bridge. The
catch: every camera is a separate HomeKit accessory. It does **not** appear on its own: add
each one in the Home app (*+ → Add Accessory → More options…*) with the code from Home
Assistant's notification, and open its port in the host firewall.

```yaml
homekit:
  - name: HASS Bridge                # your existing bridge, unchanged
    port: 21063
    filter:
      include_entities:
        - light.living_room
  - name: Front door camera          # one instance per camera
    port: 21064
    mode: accessory
    filter:
      include_entities:
        - camera.front_door
    entity_config:
      camera.front_door:
        support_audio: true
        video_codec: copy
        linked_motion_sensor: binary_sensor.front_door_motion
```

- **Entity IDs:** the camera entity is named after the device (Eufy app name), so a camera
  called "Garage" becomes `camera.garage`. Umlauts are dropped ("Haustüre" →
  `camera.hausture`). The motion sensor is the camera's "Motion" binary sensor (`…_motion`).
  Entity IDs are always English, whatever language Home Assistant runs in; IDs that older
  versions generated from German names (e.g. `…_ereignis_lokal`, `event.…_aktivitat`) are
  renamed on the first start of 0.1.15. Update automations and the HomeKit config that use
  them. Check the exact IDs under *Settings → Devices & services → Entities*.
- **One `homekit:` key:** keep a single `homekit:` key in `configuration.yaml` and add more
  bridges as further list items. A second `homekit:` key silently replaces the first (the log
  says `duplicate key "homekit"`), and the devices of the first bridge disappear from the
  Home app.
- **Networking:** Home Assistant needs host networking (`network_mode: host`) for HomeKit's
  mDNS discovery, the same as the bridge.
- **If the video stays black,** remove `video_codec: copy`; Home Assistant then transcodes
  with `libx264`, which costs CPU.

### Notifications with a picture

`linked_motion_sensor` adds the camera's "Motion" sensor to it in the Home app. It turns on when the
HomeBase stores a new recording (about 7 s after the motion on hardware) and stays on for 30 s.
Turn on notifications for it in the Home app: open the camera, tap the settings (gear) icon,
*Status and Notifications* (names vary a little between iOS versions). The notification shows the camera's still image, i.e. the
thumbnail of the recording.

- A second recording within the 30 s does not notify again.
- Away from home, notifications come through your home hub (HomePod or Apple TV).
- If a notification shows the previous recording's picture, the Home app asked before the
  bridge had fetched the new thumbnail; please report it.

### Start time in the Home app

Home Assistant's HomeKit Bridge reads the camera with the `ffmpeg` command line tool. The
integration hands it an FLV stream, which ffmpeg starts after 2.8 s against the simulator
(MPEG-TS: 5.4 s, ADR 0013). No HomeKit setting is needed for this. On real hardware, waking
the camera adds about 2 s.

### What it does with your cameras

- **Tiles in the Home app** show the camera's still image: the thumbnail of the latest event
  from the HomeBase, or the last frame of a live view if that is newer (the bridge keeps it
  and Home Assistant's ffmpeg turns it into a JPEG). Fetching it never wakes a camera. The age
  the Home app shows ("7 s") is when it last asked Home Assistant, not when the picture was
  taken.
- **An open Home app shows the large camera tile live** (seen on a Mac): it keeps that camera
  streaming, and a streaming camera records no motion. Close the Home app when you do not
  watch.
- **Opening a camera** starts a live view, which wakes the camera like any live view in Home
  Assistant: it drains the battery, stops 10 s after the last viewer and after at most
  120 s (`LIVE_IDLE_SEC`, `LIVE_MAX_SEC`). The HomeBase streams one camera at a time;
  opening a second camera stops the first.
- **Sound:** the older eufyCam 2C (T8113 without "-V") send audio in a format the bridge
  cannot pass on yet; their live view carries silence instead, so the picture still works.
- **No recording, no storage:** Home Assistant's HomeKit Bridge does not support HomeKit
  Secure Video, so HomeKit records nothing and stores nothing in iCloud, and neither does
  Home Assistant.
- **Apple:** at home, the Apple device fetches images and video directly from Home
  Assistant inside your network. Away from home, it goes through your home hub (HomePod or
  Apple TV) and Apple's relay, encrypted end to end between the hub and your device.

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
