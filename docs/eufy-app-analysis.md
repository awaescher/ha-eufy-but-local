# Eufy app analysis: livestream behaviour and ideas for Eufy But Local

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

### Consequences for Eufy But Local

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
   (`movicPlay_First_IDR_Frame`, `AKVideoPlayer_State_FirstIDRFrame`). Eufy But Local has so far only
   been verified in HA through HLS, which needs a complete keyframe-aligned segment plus
   player buffering: several seconds. Most likely the largest factor. The equivalent in HA is
   WebRTC through the built-in go2rtc (open item in `STATUS.md`).
2. **Bounded latency.** The app drops buffered frames when its cache grows
   (`-[VideoLivePlayer dropFrame]`, `setFpsWithCacheNum:`, "drop p2p cached frame", debug
   overlay `delay … cache …` from `videoDelayTime`/`videoBufferCount`). Eufy But Local stamps each frame
   with `max(now, last + minStep)` (`LiveStreams.feed`); under repeated P2P bursts the
   timestamps can run ahead of the wall clock, so delay may accumulate instead of shrinking.
3. **Instant placeholder.** On leaving the view the app saves the last live frame
   (`saveLastVideoImage`) and shows it immediately the next time. Eufy But Local shows the latest event
   thumbnail, which may be old.
4. **No start-up trick.** The app does not pre-warm (`prepareToPlay` is empty) and no
   "request keyframe" command was found. Its start time is also "wake camera + first IDR".
   Eufy But Local keeps the P2P connection open permanently, while the app connects on demand, so here
   Eufy But Local has the edge.

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
   `connecttime/commandtime/videotime`). Eufy But Local measures none of this, so it is unknown where the
   seconds go.
8. **Robust switching.** Mirror the app's SN/channel check so stragglers of a displaced camera
   cannot end up in the next camera's stream. Check on hardware first whether it happens.

## Deeper analysis

### Local push notifications over P2P (event path without the cloud)

- The HomeBase sends unsolicited messages on the P2P notify channel (`zx_p2p_notify_read`),
  dispatched by `-[BCP2PClient notify_callback:type:cvalue:cvalue1:ivalue:ivalue2:ivalue3:]`.
- **Command 1312 (`0x520`, logged as `APP_CMD_NOTIFY_PUSH`)** is forwarded to the delegate
  selector `receiveNotificationRequest:` (resolved from the `__objc_selrefs` entry of the
  stub). `-[BCP2PClientConfig receiveNotificationRequest:]` hands it straight to
  `+[BCLocalP2PNotifyManager didReceiveNotificationRequest:]`, the same handler chain that
  processes cloud pushes (`handleEufyCamPushUserInfo:`, `handleNewPirPush:`, …).
- The payload is parsed into `BCBaseSCTNoti` (`MegaCommonFramework`) with the properties
  `a, n, s, c, t, type, deviceSN, needCustRingtone, rec_content, pic_content`, the short keys
  of Eufy's push payload. Local and cloud push therefore very likely share one format, and
  `eufy-security-client`'s push parser could be reused for it.
- Images for these notifications come from `pic_url` / `quryFaceUrlsBy:Thumb:sn:cb:`; logs
  are tagged `[push_p2p_img]` and `local push data`.
- `eufy-security-client` 3.8.0 does not define command 1312. Unknown control messages end up
  in its catch-all debug log ("Handle DATA … Not implemented", with `commandId` and hex data).
  The bridge passes a `quietLogger`, so they are currently invisible.
- Open: whether a HomeBase 2 sends 1312 to every connected P2P client, only to registered
  app clients, or not at all, and for which detections. **This is the most valuable hardware
  test**: it would make person/motion events local (ADR 0003).

Other unsolicited commands seen in the dispatcher:

| ID | Name (app / library) | Content |
|---|---|---|
| 1306 | event data sync / `CMD_DATABASE` | JSON `{table, cmd, transaction, data, start_id, end_id}`; handled by `reveiveHBEventData:…`, which syncs face/person/re-ID feature tables (HomeBase 3 AI), not motion events |
| 1308 | `KHB_DOWN_IMAGE_NOTI` / `CMD_DATABASE_IMAGE` | JSON with `device_sn`; image ready for download |
| 1103 | `BC_CAMERA_INFO_UPDATE_NOTI` / `CMD_CAMERA_INFO` | camera info (library already emits `camera info`) |

### RTSP ("NAS") mode in detail

Same command sequence in the app and in the library:

| Step | App | Library (3.8.0) |
|---|---|---|
| Enable RTSP for a channel, station answers with the URL | `getCameraNSAURLSwitch:` → 1145 | `setRTSPStream()` → `CMD_NAS_SWITCH`, event `rtsp url` → property `rtspStreamUrl` |
| Start the RTSP stream (wakes the camera) | `getCameraNSAOpenSwitch:` → 1146 | `startRTSPStream()` → `CMD_NAS_TEST` value 1, event `rtsp livestream started` |
| RTSP credentials and mode | `setRTSPUserName:pwd:mode:task:` → 1287, JSON `{username, passwd, …}` | `CMD_SET_NAS_PASSWD` (defined, no high-level method) |

So the building blocks exist in the library already. An RTSP URL served by the HomeBase would let
Home Assistant's go2rtc read the camera natively (low-latency WebRTC, no muxer in the
bridge); the bridge would only need to start/stop it. Open: the URL format and whether it
points at the HomeBase or the camera, whether the stream needs `CMD_NAS_TEST` before every
viewer, authentication, and battery impact.

### Latency control of the app's player (`VideoLivePlayer`, `MegaMainFramework`)

The frame buffer is a list of GOPs. Concrete rules from the decompiled code:

- **Sampling** (`dropFrame`): every `fps/2` frames the number of buffered frames is sampled;
  after 9 samples (~4.5 s) mean and standard deviation are computed.
- **Steady backlog**: mean ≥ `2 × fps` (≥ 2 s buffered), standard deviation ≤ 5, more than
  one GOP buffered and the newest GOP has more than 5 frames → all GOPs except the newest
  are dropped (jump to the latest keyframe). Log: `didDropFrame videoBuf count …`.
- **Hard limit**: buffer ≥ `5 × fps` (≥ 5 s) and more than two GOPs → older GOPs are dropped
  immediately.
- **Catch-up speed** (`setFpsWithCacheNum:`): display rate follows the backlog: about
  `fps − 2/3` while the buffer is small, `1.5 × fps` above `2 × fps` frames, `1.67 × fps` above
  `3 × fps`, `2 × fps` above `4 × fps`.
- **Pacing** (`displayVideo1`): frames are shown at their timestamp gap; gaps ≥ 200 ms are
  replaced by 66 ms, so a burst after a stall plays quickly instead of in real time.
- **Stall detection** (`displayTimeOut:`): no frame for `3 × fps` ticks → delegate notified;
  `16 × fps` ticks → player paused.

Transferable to the bridge: drop to the newest GOP instead of letting delay grow. Two places
fit. One is a viewer whose HTTP response backs up (`res.writableLength`): skip to the next
keyframe. The other is the timestamp drift in `LiveStreams.feed`: re-anchor at a keyframe
once it exceeds ~2 s.

## Cloud: login, device list, keys

Eufy But Local still needs the cloud at bridge start for login, the station/device list and keys
(`STATUS.md`, `offline-test-plan.md` rows 5 and 6). Compared with the app:

### Endpoints: library 3.8.0 vs. app 6.1.11

| Purpose | `eufy-security-client` 3.8.0 | Eufy app 6.1.11 |
|---|---|---|
| API domain | `extend.eufylife.com/domain/{country}` | same string present; login picks the domain per account (`loginSetDomain:`, `getDomainWithEmail:`) |
| Login | `v2/passport/login_sec` | **`passport/login`** (`-[BCHttpHandler doLoginWith:pwd:loginId:verifyCode:captchaId:answer:encText:cb:]`, domain type 9); `v2/passport/login_sec` is still in the binary |
| Station list | `v2/house/station_list` | **`v3/app/get_hub_list`** (`listStationsBy:cb:`; body `device_sn, num, orderby, page, station_sn, time_zone`, same as the library's) |
| Device list | `v2/house/device_list` | **`v3/app/get_devs_list`**; the Kotlin stack also uses `app/house/get_devs_list`, `app/devicerelation/get_device_list` |
| House list | `v1/house/list` | `app/house/get_house_list` |
| P2P keys (DSK) | `v1/app/equipment/get_dsk_keys` | **`v2/app/get_p2pconn`** with `{station_sn, with_dsk_key}` (`getHubConn:by:withDsk:cb:`); Kotlin stack: `app/devicerelation/get_dsk_keys` |
| Client identity | `App_version: v4.6.0_1630`, `Os_type: android` | 6.1.11 iOS; requests carry `X-Encryption-Info: algo_ecdh`, `X-Request-Ts`; the Kotlin stack adds `X-Signature`, `X-Key-Ident`, `X-Replay-Info` |

**`v2/house/station_list`, `v2/house/device_list`, `v1/house/list` and
`v1/app/equipment/get_dsk_keys` no longer occur anywhere in the app** (all 237 frameworks and
the main binary searched). These are most likely the legacy APIs Eufy is shutting down. They
are exactly the calls 3.8.0 needs after login. The login endpoint the library uses is still
present.

App login request body (field names from the decompiled code, values not observed): `ab`
(country), `client_secret_info.public_key` (client ECDH key), `email`, password encrypted with
ECDH against a server key built into the app (`+[BCECDHManager serverPresetPublicKey]`;
the library also ships a fixed server key), `login_id`, `verify_code`, `captcha_id`, `answer`,
`time_zone`. Same scheme as `login_sec`, new path.

The response formats of `v3/app/get_hub_list`, `v3/app/get_devs_list` and `v2/app/get_p2pconn`
were not decoded. The app's models contain `p2p_did`, `app_conn`, `p2p_conn`, `dsk_key` and
`dsk_expiration`. A request log from a real login would settle the shapes.

### What the local P2P connection actually needs from the cloud

From the library's code (`p2p/session.js`, `http/station.js`):

- Used from the cloud station record: `station_sn`, `p2p_did`, `member.admin_user_id` (sent
  inside many commands), the device list (serial, type, channel), `params`, `time_zone`.
  All static and cacheable. Store them in the bridge's data dir, never in the repo.
- The **DSK key is only used for the cloud lookup** (`LOOKUP_WITH_KEY`). The local lookup sends
  an empty payload, `CHECK_CAM` only the `p2p_did`. `connect()` still calls `renewDSKKey()`,
  but a failure there is logged, not thrown.
- The P2P session key is negotiated locally per session (RSA, `session.js` around line 3229).
- So the expectation in `offline-test-plan.md` row 6 ("reconnect works only while the DSK key
  has not expired") is probably too pessimistic for `ONLY_LOCAL`. Re-test it.
- The library persists the cloud token and ECDH keys (`persistent.json`), **but not the
  station/device list**. That is why every bridge start needs the cloud.

The app itself caches DSK keys with expiration (`getDskCacheSn:`, `updateDskCache:key:`,
`putCacheManualConnectSn:dskKey:`). Its P2P layer (CS2 PPCS) connects with
`PPCS_ConnectByServer(DID, mode, port, ServerString)`; of the observed modes `0x7E`, `0x5E` and
`0x3F`, only `0x3F` has bit 0 (LAN search) set.

### Consequences

1. **Offline start is feasible without new protocol work**: after a successful cloud start,
   save the raw station/device records the library received. On a later start without cloud,
   create the stations from that cache and connect `ONLY_LOCAL`. This needs a way to feed
   cached records into the library (it fetches them inside `EufySecurity`), i.e. a small
   wrapper or patch. That calls for an ADR. Combined with the local push (1312) this would
   make the bridge independent of the cloud after the first setup.
2. **When the legacy device list fails**, the replacement endpoints are known
   (`v3/app/get_hub_list`, `v3/app/get_devs_list`, `v2/app/get_p2pconn`). Their response
   formats are not. Before writing code, compare them with `@mega-yfue/eufy-sdk` (ADR 0010),
   which targets the current backend.
3. The library's client identity (`v4.6.0`, Android) is years old. If Eufy starts rejecting
   old clients, that is a likely failure point independent of the endpoints.

## Suggested order (not implemented)

0. **Local push test** (highest value, tiny change): make the library's P2P debug log
   visible behind an env switch (e.g. `EUFY_DEBUG=p2p` instead of `quietLogger`), walk past a
   camera, and look for `commandId: 1312`. If it arrives, decode it with the library's push
   parser and emit `person`/`motion` locally.

1. **Measure** (no behaviour change): in `LiveStreams`, record start command (`addViewer`
   before `startFn`), `started()`, first frame and first keyframe in `feed()`, and the maximum
   `at - now`; log one line per start through the existing `log` callback. Unit test with an
   injected `now`.
2. **Verify WebRTC** on a real HA install with host networking: time to first picture, HLS vs.
   WebRTC. AAC would need transcoding to Opus by go2rtc for audio. Record in `STATUS.md` and
   ADR 0006.
3. **Bound latency** (only if step 1 shows drift): follow the app's rules above: re-anchor
   at the newest keyframe once the backlog (timestamp drift or a viewer's unsent bytes)
   exceeds ~2 s; the GOP cache in `#deliver` stays as is.
4. **Live still image**: in `EufyLocalCamera.async_camera_image`, use
   `self.stream.async_get_image(...)` while an HA stream is running, else the event
   thumbnail. Do **not** set `use_stream_for_stills = True`: HA's `_async_get_image` would then
   create a stream for every still and wake the camera.
5. **Hardware exploration** before any code: RTSP/NAS (5), streaming quality (6), channel
   stragglers after a switch (8).
