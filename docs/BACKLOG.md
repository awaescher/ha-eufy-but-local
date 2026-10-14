# Backlog

Things worth doing, roughly in priority order. What is verified and what is not lives in
`STATUS.md`; decisions in `adr/`. Move an item out of here once it is done or decided.

## Livestream

1. **Real audio for the older eufyCam 2C (T8113 without "-V").** They send audio frames without
   ADTS headers (130–144 bytes, first bytes e.g. `717a…`, `707a…`, `7a79…`); the library reports
   a codec from 0.1.8 on (log line `livestream … running (…, with audio, <codec>)`), probably
   AAC-ELD. The bridge sends silence instead so HomeKit shows the picture. Next steps:
   - take a sample from `DATA_DIR/audio-samples/<serial>.bin` (2-byte big-endian length +
     frame, 300 frames; it stays on the maintainer's host, never commit it);
   - work out the format (try ffmpeg with AAC-ELD AudioSpecificConfigs for 16 kHz mono, frame
     length 480 and 512);
   - if ffmpeg decodes it: carry it in FLV/MPEG-TS with the right AudioSpecificConfig (FLV can
     signal any AAC object type; ADTS cannot signal ELD), and check that Home Assistant's
     stream worker, go2rtc and HomeKit's ffmpeg (`-c:a libopus`) accept it;
   - otherwise transcode in the bridge only if it needs no new runtime dependency (AGENTS.md).
2. **Verify on hardware** what is only verified against the simulator: automatic restart of
   a stream the HomeBase stopped (weak Wi-Fi, Hof), silence for non-ADTS audio, still image
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
