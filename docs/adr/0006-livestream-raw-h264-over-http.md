# ADR 0006: Livestream as raw H.264 over HTTP, on demand

Status: accepted; `stream` component verified against the simulator, go2rtc open (2026-10-13)

## Context

The library emits the P2P livestream as a Node stream of H.264 Annex-B frames. Home
Assistant needs a `stream_source()` URL. Bundling go2rtc in the bridge (like mega-yfue's
bridge) would give RTSP/WebRTC, but go2rtc could not be built in the development sandbox and
HA already ships go2rtc and the PyAV-based `stream` component.

## Decision

Serve `GET /api/stream/{sn}` as raw H.264. The first viewer starts the camera; frames fan out
to all viewers; late viewers receive a GOP cache starting at the last SPS; the stream stops
`LIVE_IDLE_SEC` after the last viewer left; `LIVE_MAX_SEC` caps the duration.

## Consequences / open question

- HA's `stream` component (PyAV) detects raw Annex-B over HTTP as `h264`, but the packets have
  no timestamps and the worker aborts ("No dts in 7 consecutive packets"). The camera entity
  therefore sets the stream option `use_wallclock_as_timestamps`; with it, HA's real stream
  worker produces regular 2 s HLS segments from the simulator stream
  (`devenv/stream_probe.py`). Arrival time is an acceptable clock for a live P2P feed.
- Still open: HA's built-in go2rtc (WebRTC) with this source, and both paths on real hardware.
  Fallback if go2rtc fails: remux to MPEG-TS or fMP4 in the bridge, or bundle go2rtc.
- H.265 cameras would need transcoding; the tested models report H.264 (prototype metadata).
- Verified in tests: late viewers start exactly at an SPS; streams stop after the idle period.
