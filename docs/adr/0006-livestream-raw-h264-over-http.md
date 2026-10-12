# ADR 0006: Livestream as raw H.264 over HTTP, on demand

Status: accepted, needs verification (2026-10-13)

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

- Must be verified that both PyAV and HA's go2rtc probe raw Annex-B over HTTP reliably.
  Fallback: remux to MPEG-TS or fMP4 in the bridge (ffmpeg or a small muxer), or bundle go2rtc.
- H.265 cameras would need transcoding; the tested models report H.264 (prototype metadata).
- Verified in tests: late viewers start exactly at an SPS; streams stop after the idle period.
