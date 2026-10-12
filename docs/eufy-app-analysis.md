# Eufy app analysis: livestream behaviour and ideas for HALEC

Static analysis of the official Eufy iOS app (Anker eufy 6.1.11, Apple Silicon wrapper) with
REA and Ghidra 12.1.4, 2026-10-13. Everything below comes from decompiled code and strings,
**not from measurements on hardware**. Per ground rule 1 in `AGENTS.md`, none of it counts as
verified until it was tested on the HomeBase and recorded in `STATUS.md`.

Analysed frameworks (not encrypted, unlike the main binary): `BC_P2PClient` (P2P commands),
`BC_VideoSDK` (frame reader, decoder), `BCMega_Player` (new live player),
`MegaMainFramework` (classic live view, routing, remote config), `ESIotMegaKit`
(Kotlin/Native core for newer devices).

## How the app streams and switches cameras

### P2P layer (`BC_P2PClient`)

- One P2P connection per station (`sessionWith:` by station DID); the camera is only the
  `channel` parameter of each command.
- Start: `StartRTVideoStream:` sends `CMD_START_REALTIME_MEDIA` (1003, `0x3eb`) with a stream
  type per channel. Stop: `StopVideoStream:` sends `CMD_STOP_REALTIME_MEDIA` (1004, `0x3ec`);
  stations with 64-bit IDs (`hbUse64Id4EventsNFacesBy:`) get
  `APP_CMD_STOP_REALTIME_MEDIA_payload` through `CMD_SET_PAYLOAD` instead.
- `_checkStreamCommandTypeAndValue` classifies outgoing commands as live (1003, also nested in
  1350 or 1700 with `commandType` 1000), record view (1025) and download (1024).
  `_zx_p2p_send_command` stores a single "is live" flag per connection. There is **no
  client-side "one camera at a time" lock**.

### Classic live view (`BCCameraDeviceBaseVideoVC`, `MegaMainFramework`)

- `viewWillDisappear:` → `videoPlayOrStop:` → `stopLive`: sends 1004 for the station
  DID/SN and the camera's channel, resets the frame buffer.
- `startLive`: sets SN and channel on the player, starts a 1 s `checkStreamTimer`, then
  `sendRealTimeVideoCommandWithConnType:` → `BCP2PTask(sn, chl)` → `StartRTVideoStream`
  (stations that are not T9000/T8N00/T7000 and not "platform V2", i.e. the HomeBase 2 path).
- No delay or cooldown between stopping one camera and starting the next.
- `onVideoData:…` drops every frame whose station SN differs from `connectSN` or whose channel
  differs from the camera's `chl`. `BC_VideoSDK` (`_zx_p2p_media_read_video_manager`)
  additionally drops frames by device SN (`_gSNID`). The app therefore expects frames of
  other channels on the same connection, e.g. stragglers after a switch.
- `checkStreamStatus:` (the 1 s timer) only drives UI: weak Wi-Fi/repeater hint, a
  "keep watching?" dialog after ~180 s, auto-close around 194/314 s.

### New live player with camera switcher (`BCMega_Player`)

- `MegaLivePlayer.stopLive` → `livePlayer.stopPlay`; `destroyPlayer` → `livePlayer.release`;
  a switch builds a new player for the next device. `handleDeviceSwitchSuccess:` only
  rebuilds the UI.
- Which player a camera gets is decided by `+[BCJumpUtil gotoLiveVideoVC:]` →
  `-[BCRemoteConfigManager supportThingPlayer:parentSN:]`, i.e. by the **remote config** key
  `support_thing_player_pair` (station PN → camera PNs) plus an A/B test. Whether HomeBase 2 +
  eufyCam 2C use it cannot be read from the binary.
- Simultaneous streams of several cameras ("multiple live") are gated by the device
  property `is_support_multi_live_stream` of the newer thing model (`ESIMKMegaDeviceManager`).
  Devices outside that model return false; for HomeBase 2 this is likely, not verified.

### Consequences for HALEC

- The "one stream per station" limit observed so far comes from `eufy-security-client`: it
  keeps a single video slot per P2P session and, when another channel starts, ends the running
  stream **locally without sending 1004**. Whether the HomeBase 2 itself could serve two
  channels is open.
- `LiveStreams.#displaceOthers` (`bridge/src/live.mjs`) matches the app: explicit stop of the
  old camera, then start of the new one.
- The library does not check the channel of incoming video frames, unlike the app.

## Why the app shows live video faster

1. **No segmenting, picture from the first keyframe.** The app feeds every P2P frame straight
   into a hardware decoder (`AkHardDecoder`, `IDCHardDecoder`) and renders from the first IDR
   (`movicPlay_First_IDR_Frame`, `AKVideoPlayer_State_FirstIDRFrame`). HALEC has so far only
   been verified in HA through HLS, which needs a complete keyframe-aligned segment plus
   player buffering: several seconds. Most likely the largest factor. The equivalent in HA is
   WebRTC through the built-in go2rtc (open item in `STATUS.md`).
2. **Bounded latency.** The app drops buffered frames when its cache grows
   (`-[VideoLivePlayer dropFrame]`, `setFpsWithCacheNum:`, "drop p2p cached frame", debug
   overlay `delay … cache …` from `videoDelayTime`/`videoBufferCount`). HALEC stamps each frame
   with `max(now, last + minStep)` (`LiveStreams.feed`); under repeated P2P bursts the
   timestamps can run ahead of the wall clock, so delay may accumulate instead of shrinking.
3. **Instant placeholder.** On leaving the view the app saves the last live frame
   (`saveLastVideoImage`) and shows it immediately the next time. HALEC shows the latest event
   thumbnail, which may be old.
4. **No start-up trick.** The app does not pre-warm (`prepareToPlay` is empty) and no
   "request keyframe" command was found. Its start time is also "wake camera + first IDR".
   HALEC keeps the P2P connection open permanently, while the app connects on demand, so here
   HALEC has the edge.

## Further opportunities

5. **RTSP ("NAS") mode.** `eufy-security-client` lists `rtspStream`/`rtspStreamUrl` for T8113
   and T8142; the app has `setRTSPUserName:pwd:mode:task:`, `getCameraNSAURLSwitch:…` and
   `APP_CMD_NAS_SWITCH`. If the HomeBase 2 serves its cameras over RTSP on the LAN, go2rtc could
   read them directly, without the bridge's muxer and timestamp logic. Unknown: availability on
   HomeBase 2, battery drain, wake behaviour. Architecture decision (new ADR) after a hardware
   test.
6. **Streaming quality.** The app sends a per-channel `streamtype` and offers "Streaming
   Quality"; the library knows `videoStreamingQuality` for T8142 (not T8113). Smaller frames
   could bring the first keyframe sooner over a weak camera-to-HomeBase link. Possible `select`
   entity, only for models that report the property.
7. **Measure like the app.** The app separately tracks P2P connect, command and first picture
   (`p2pStartConnectTime`, `startLiveTime`, `firstPictureTime`; overlay
   `connecttime/commandtime/videotime`). HALEC measures none of this, so it is unknown where the
   seconds go.
8. **Robust switching.** Mirror the app's SN/channel check so stragglers of a displaced camera
   cannot end up in the next camera's stream. Check on hardware first whether it happens.

## Suggested order (not implemented)

1. **Measure** (no behaviour change): in `LiveStreams`, record start command (`addViewer`
   before `startFn`), `started()`, first frame and first keyframe in `feed()`, and the maximum
   `at - now`; log one line per start through the existing `log` callback. Unit test with an
   injected `now`.
2. **Verify WebRTC** on a real HA install with host networking: time to first picture, HLS vs.
   WebRTC. AAC would need transcoding to Opus by go2rtc for audio. Record in `STATUS.md` and
   ADR 0006.
3. **Bound latency** (only if step 1 shows drift): in `feed()`, if `at` runs more than ~1 s
   ahead of `now`, drop non-keyframes until the next keyframe and re-anchor there; the GOP
   cache in `#deliver` stays as is.
4. **Live still image**: in `EufyLocalCamera.async_camera_image`, use
   `self.stream.async_get_image(...)` while an HA stream is running, else the event
   thumbnail. Do **not** set `use_stream_for_stills = True`: HA's `_async_get_image` would then
   create a stream for every still and wake the camera.
5. **Hardware exploration** before any code: RTSP/NAS (5), streaming quality (6), channel
   stragglers after a switch (8).
