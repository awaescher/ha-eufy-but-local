# Backlog

Things worth doing, roughly in priority order. What is verified and what is not lives in
`STATUS.md`; decisions in `adr/`. Move an item out of here once it is done or decided.

## Livestream

1. **Real audio for the older eufyCam 2C (T8113 without "-V").** They send raw AAC-ELD access
   units (no ADTS header, 118–171 bytes; the first byte is the global gain, the second is
   almost always `0x7a`). The library says AAC_ELD; its codec name is not reliable otherwise
   (it also said AAC_ELD for Haustüre and Wärmepumpe, whose frames are ADTS AAC-LC). The bridge
   sends silence instead so HomeKit shows the picture (verified on hardware 2026-10-15).
   Findings from a 300-frame sample of Häusle (2026-10-15):
   - ffmpeg 8.1.2 (Home Assistant image) decodes the frames as AAC-ELD (object type 39,
     mono, no data resilience, no LD-SBR) without errors and the
     spectrogram shows real sound, but only for sample rates it has 480/512-sample band
     tables for (22.05 kHz and up). For 16 and 8 kHz it fails with "Internal bug" (empty
     `ff_aac_num_swb_480/512` entries in `decode_ics_info`).
   - The 300 frames arrived in at most 7.9 s, so at least 38 frames/s: at least 19 kHz with
     512 samples per frame. The bridge logs the arrival rate from 0.1.10 on
     (`unsupported audio arrives at … frames/s`); that settles the sample rate
     (rate = frames/s × 480 or 512).
   - Passing ELD through as is would be risky even with the right rate: Home Assistant's HLS
     would put ELD into fMP4, which browsers may not play; WebRTC (go2rtc → Opus) and HomeKit
     (ffmpeg → Opus) transcode and would probably work.
   Next steps: read the frame rate from the log; build the AudioSpecificConfig from it; test
   ELD in FLV against HA's stream worker in a browser, go2rtc and HomeKit. If HLS breaks,
   transcoding to AAC-LC needs ffmpeg in the bridge image (a new dependency: maintainer
   decision and an ADR).
2. **Verify on hardware** what is only verified against the simulator: the start watchdog
   (a restart after a weak-Wi-Fi stop brought no stream and hung until 0.1.9), still image
   from the last live frame (Home app tiles).
3. **HomeKit and 2K streams.** Hof sometimes streams 2304x1296; with `video_codec: copy` the
   Home app gets a resolution it does not offer. Check whether that is why HomeKit's ffmpeg
   ended after one second (enable `homeassistant.components.homekit.type_cameras: debug` to
   see ffmpeg's output); options: document a streaming quality setting, or note that copy
   needs ≤1080p.
4. **One stream per HomeBase.** Several live views at once (dashboard cards in live mode plus
   the Home app) displace each other; a displaced camera is refused for 45 s. Consider
   telling the user in Home Assistant (e.g. an attribute or a repair issue) instead of only
   a 409 in the log.
5. **WebRTC (go2rtc) on a real install**: time to first picture compared with HLS; audio
   would need AAC → Opus.
6. **HLS start with FLV** is about 1.2 s slower than with MPEG-TS (ffmpeg analyses 40 frames
   for the frame rate with FLV's millisecond time base, ADR 0013). Only matters when WebRTC
   is not used.

## Events and local operation

7. **Local push (P2P command 1312).** Not seen on hardware so far. Walk past a camera with no
   livestream running and look for `unhandled P2P message 1312`; if it shows up, decode it
   with the library's push parser and emit person/motion locally (ADR 0003).
8. **Unhandled P2P command 6246** (`{"cmd":6246,"payload":{"num":1}}`, seen right before a
   livestream starts). Probably harmless; find out what it means or stop logging it.
9. **Start without internet**: cache the station/device records after a successful cloud
   start and create the stations from the cache when the cloud is unreachable. Needs an ADR.
10. **RTSP ("NAS") mode of the HomeBase**: hardware test first (availability on HomeBase 2,
    battery, wake behaviour), then an ADR.
11. **Legacy cloud endpoints** used by `eufy-security-client` 3.8.0 (`v2/house/station_list`,
    `v2/house/device_list`, `v1/app/equipment/get_dsk_keys`) may be shut down; newer clients
    use `v3/app/get_hub_list`, `v3/app/get_devs_list` and `v2/app/get_p2pconn`. Capture one
    response of the v3 lists before the old ones disappear (ADR 0010).

## Housekeeping

12. Submit to the HACS default list and home-assistant/brands.
13. go2rtc's nil pointer in `Codec.Match` (fixed on our side for audio before the first
    keyframe): check whether it still happens when a stream is refused with 409; report
    upstream if so.
