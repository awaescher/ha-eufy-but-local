# Backlog

Things worth doing, roughly in priority order. What is verified and what is not lives in
`STATUS.md`; decisions in `adr/`. Move an item out of here once it is done or decided.

## Livestream

1. **Real audio for the older eufyCam 2C (T8113 without "-V") – parked.** They send raw AAC-ELD
   access units (no ADTS header, 118–171 bytes; first byte = global gain, second almost
   always `0x7a`). Measured on hardware (2026-10-15): 33.2 frames/s, i.e. 16 kHz with 480
   samples per frame. ffmpeg (8.1.2 in the Home Assistant image) has no AAC-ELD band tables
   for 16 kHz (empty `ff_aac_num_swb_480` entry; "Internal bug" in `decode_ics_info`), so no
   consumer could decode it. Maintainer decision: no extra software (no ffmpeg in the bridge)
   for this; the bridge sends silence so the picture works. Revisit if ffmpeg gains 16 kHz
   ELD support (then: AudioSpecificConfig for ELD, 16 kHz, 480 samples, carried in FLV).
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

7. **Local push (P2P command 1312).** Not seen on hardware: a recording made while no stream
   ran (2026-10-15) brought no 1312, so the HomeBase most likely does not send it to the
   bridge. Events come from polling the event database (about 7 s after the motion).
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
