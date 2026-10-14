# ADR 0013: FLV as the default live container

Status: accepted (2026-10-14); measured against the simulator, not yet on hardware

## Context

The Home app (HomeKit) showed "No response" when opening a camera. Home Assistant's HomeKit
Bridge reads `stream_source()` with the `ffmpeg` command line tool. For MPEG-TS input the
command line sets `scan_all_pmts`, so ffmpeg keeps the "no header" flag and analyses the full
`analyzeduration` (5 s) before it outputs anything. PyAV (Home Assistant's `stream`) does not
set it. Users could pass `-scan_all_pmts 0` through `entity_config.stream_source`, but that
needs the camera serial and the bridge token per camera.

Time until the consumer has the first video frame (simulator, 15 fps, no camera wake-up;
consumers from the Home Assistant 2026.10.1 image):

| Container | ffmpeg CLI (HomeKit) | PyAV (HA `stream`, HLS) | go2rtc (WebRTC) |
|---|---|---|---|
| MPEG-TS | 5.4 s | 1.6 s | 3.1 s* |
| FLV | 2.8 s | 2.8 s | 3.0 s* |
| Matroska | ~0.5 s (16 frames analysed) | | cannot read it |
| fragmented MP4 | | | cannot read it |

\* measured through go2rtc's RTSP output, which adds ffmpeg's own RTSP probing.

FLV announces its tracks in the header, so ffmpeg stops analysing as soon as it has seen
them. It still estimates the frame rate from 40 frames (millisecond time base); MPEG-TS needs
20 (90 kHz time base), which is why PyAV is slower with FLV.

## Decision

The bridge muxes FLV itself (`bridge/src/flv.mjs`, no ffmpeg) and serves it as
`GET /api/stream/{sn}.flv`; the integration uses it as `stream_source()`. MPEG-TS (`.ts`,
also the default without extension) and raw H.264 (`.h264`) stay available.

## Consequences

- HomeKit starts about 2.6 s sooner without any configuration.
- HLS (Home Assistant's `stream`, the fallback when WebRTC is not used) starts about 1.2 s
  later. WebRTC through go2rtc is unchanged.
- FLV needs SPS/PPS before the first frame, so each viewer starts at a keyframe (the GOP
  cache in `live.mjs` already delivers one to late viewers).
- Verified against the simulator: HA's stream worker produces HLS segments with H.264 and
  AAC from the FLV; go2rtc reads H.264 and AAC from it.
