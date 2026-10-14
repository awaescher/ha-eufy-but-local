# Feature set: decision basis

Status: decided 2026-10-13, see `adr/0012-feature-set.md`.

The maintainer's rule (AGENTS.md rule 0): everything that can be local must be local; the Eufy
login is the only accepted cloud use; every exception is negotiated, off by default and
explained in the UI.

Scope: HomeBase 2 (T8010), eufyCam 2C (T8113), eufyCam 2C Pro (T8142), the only tested hardware.

## 1. What exists today

| Platform | Entities |
|---|---|
| camera | live view (MPEG-TS, H.264 + AAC audio), still image = last event thumbnail |
| event | "Activity": `local_recording` (local), `person` / `motion` (cloud push, off by default) |
| binary_sensor | "Motion" per camera, "Local P2P connection" per HomeBase |
| image | "Last event image" |
| sensor | battery, last event, stored events |
| alarm_control_panel | HomeBase guard mode (fixed HA states) |
| select | "Guard mode" with every Eufy mode |

## 2. What the hardware offers, and where it runs

Source: `eufy-security-client` 3.8.0 property tables for these models, read-only diagnostics on
the maintainer's hardware (`/api/device/{sn}/properties`), and a static check of which library
methods call Eufy's cloud API.

**Local (P2P to the HomeBase):** every writable camera and HomeBase property below, guard mode,
siren, snooze, talkback, reboot, livestream, event thumbnails. The setters in
`http/station.js` contain no cloud calls. Property values are read from the device list at
login and updated over P2P afterwards (no cloud polling).

**Needs the cloud:**

| Capability | Cloud part | Note |
|---|---|---|
| Person vs. motion per event | FCM push | HomeBase 2 does not answer the detailed local database queries (`databaseQueryLocal`: 0 records, `databaseQueryByDate`: no answer) |
| Download of recordings | `getCipher` per download (decryption key) | key could be cached per `cipher_id`; not verified |
| Firmware version check / updates | cloud | the installed version is in the device list (login) |

**Camera (T8113, T8142)** – 21 writable (23 on the 2C Pro):

| Property | Type | Values |
|---|---|---|
| enabled | bool | camera on/off |
| motionDetection | bool | |
| motionDetectionSensitivity | 1–7 | |
| motionDetectionType | select | humans only / all motions |
| light, lightSettingsBrightnessManual | bool, 40–100 | built-in spotlight |
| nightvision | select | off / black & white / colour |
| statusLed, microphone, speaker, audioRecording, antitheftDetection | bool | |
| speakerVolume | select | low / medium / high |
| recordingClipLength | 5–120 s | |
| recordingRetriggerInterval | 5–60 s | |
| recordingEndClipMotionStops | bool | |
| powerWorkingMode | select | optimal battery / optimal surveillance / custom |
| notificationType | select | affects Eufy's app notifications only |
| watermark | select | off / timestamp / timestamp and logo |
| videoStreamingQuality, videoRecordingQuality | select | 2C Pro only |
| powerSource | select | battery / solar panel |
| rtspStream | bool | camera RTSP stream (see 5.3) |

Read-only: battery, battery temperature, charging status, Wi-Fi RSSI and signal level,
battery statistics (last week usage, events since last charge), snooze state, firmware version.

Commands: livestream, trigger alarm sound (siren), snooze, start/stop talkback, download.

**HomeBase 2 (T8010)** – 14 writable: guard mode, alarm volume (1–26), prompt volume (0–26),
alarm tone (2 sounds), arm delay, alarm delay, notification switches per mode change source,
time format. Read-only: alarm active, alarm type, current mode, SD card status/capacity/free
space, LAN IP, firmware. Commands: reboot, trigger alarm sound, chime.

## 3. What comparable integrations offer

| Feature | this project | fuatakgun/eufy_security (archived) | mega-yfue/ha-eufy-sdk | Reolink (core) | UniFi Protect (core) |
|---|---|---|---|---|---|
| Event source | local DB | cloud push | not stated (SDK: cloud push) | local push/ONVIF | local |
| Person/vehicle/pet events | cloud push, opt-in | binary sensors (cloud) | event entities | binary sensors (local AI) | event entities |
| Camera settings | – | many switches/selects | switches/selects/numbers | very many, some disabled by default | many |
| Siren | – | service | – | siren entity (volume, duration) | siren entity |
| Spotlight | – | – | light entity | light entity | light entity |
| Recordings in media browser | – | – | – | yes (1 month) | yes (clips + thumbnails) |
| Two-way audio | – | – | – | – | speaker via media player |
| Firmware update entity | – | – | – | yes | – |
| Diagnostic sensors (Wi-Fi, storage) | – | some | signal | Wi-Fi, CPU, storage | many |
| Snooze | – | service | – | – | – |
| Reboot | – | – | – | button | – |
| Live view | MPEG-TS, HLS/WebRTC | RTSP or P2P via go2rtc | go2rtc WebRTC/HLS | RTSP/RTMP/FLV | RTSPS |

Home Assistant platforms relevant here: switch, number, select, light, siren, button, sensor
(entity category `diagnostic`, disabled by default for rarely used ones), event, image,
media source (recording browser), update, repairs, diagnostics, device triggers.

## 4. Proposal

### 4.1 Local, add (recommended)

| Platform | Per camera | Per HomeBase |
|---|---|---|
| switch | camera enabled, motion detection, status LED, microphone, speaker, audio recording, anti-theft detection, stop clip when motion stops | – |
| number | motion sensitivity, clip length, retrigger interval | alarm volume, prompt volume, arm delay, alarm delay |
| select | motion detection type, night vision, speaker volume, power mode, watermark, streaming/recording quality (2C Pro) | alarm tone |
| light | spotlight (on/off, brightness) | – |
| siren | camera alarm sound | HomeBase alarm sound |
| button | – | reboot |
| sensor (diagnostic) | Wi-Fi signal, battery temperature, charging, firmware | SD card status/free space, firmware, LAN IP |
| binary_sensor | – | alarm triggered (local alarm event) |
| action | snooze (duration) | – |

Settings that only matter for Eufy's app (`notificationType`, the HomeBase's notification
switches, `timeFormat`, `powerSource`) are added disabled by default or left out.

### 4.2 Local, larger effort (decide later)

- **Two-way audio.** The P2P talkback exists, but Home Assistant has no talk UI for custom
  cameras; it would need a go2rtc backchannel. High effort, uncertain UX.
- **Local person detection by configuration.** With `motionDetectionType = humans only` every
  local recording is a person. The integration could label `local_recording` as `person` when
  that mode is set. Cheap, fully local, but only covers that one mode.
- **A further database read** (`history_record_info` full-table read, as mega-yfue/eufy-sdk
  implements) might return the detection type locally. Unknown whether a HomeBase 2 answers.

### 4.3 Needs the cloud (rule 0: off by default, needs agreement)

- **Recordings in the media browser.** Listing works locally (event counts and thumbnails);
  playback needs a cloud key per recording. Option: fetch the key once per `cipher_id` and cache.
- **Firmware update entity** (checking for new versions).

### 4.4 Not proposed

- PTZ (not supported by these cameras), cloud thumbnails, cloud event history, cloud polling.

## 5. Open points and risks

1. **Battery.** Reading values does not wake cameras; whether writing a setting wakes a camera
   is unverified. Verify on hardware before enabling many writable entities by default.
2. **Value freshness.** Values come from the login's device list and P2P updates. If a value is
   changed in the Eufy app while the bridge runs, it may only show after the next login unless
   the HomeBase reports it over P2P. To verify per property.
3. **RTSP.** `rtspStream` turns on the camera's own RTSP stream. It could start faster than P2P
   but keeps a battery camera busier; Eufy recommends it for powered cameras. Evaluate
   separately, not part of this proposal.
4. Every new property must be checked on hardware once (set in HA, compare in the Eufy app).

## 6. Questions for the maintainer

1. Add the local set in 4.1, with rarely used entities disabled by default?
2. Implement local person labelling via "humans only" (4.2)?
3. Recordings in the media browser with a cached cloud key (4.3): yes as opt-in, or no?
4. Two-way audio: later, or not at all?
5. Firmware update check via the cloud as opt-in: yes or no?
