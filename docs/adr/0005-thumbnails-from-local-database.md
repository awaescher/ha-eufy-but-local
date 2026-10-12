# ADR 0005: Thumbnails from the local database; camera still image never wakes the camera

Status: accepted (2026-10-13)

## Decision

Download the latest event thumbnail (`crop_local_path`) with `station.downloadImage()` over
P2P, one request at a time (the station answers sequentially; 8 s timeout per request).
The camera entity's still image *is* this thumbnail; it is fetched again only when `imageAt`
changes. A separate `image` entity exposes it for notifications.

## Consequences

- Snapshots show the last event, not the current scene. A live frame requires opening the
  stream (which wakes the camera and costs battery). This is intentional for battery cameras.

## Update 2026-10-13: v2 thumbnails

On the maintainer's HomeBase 2 the database thumbnails arrive as `v2_eufysecurity:` blobs.
`eufy-security-client` 3.8.0 only decrypts the older `eufysecurity:` format and passes v2 on
unchanged. The bridge decodes v2 itself with a keyless decoder ported from mega-yfue/eufy-sdk
(`bridge/src/image-v2.mjs`, Apache-2.0): only the JPEG head is obfuscated, so a standard head
is rebuilt and spliced onto the plaintext scan. Colours and contrast are approximated; the
height is rounded up to a whole MCU (e.g. 640x368 for a 640x360 picture). This adds `jpeg-js`
(BSD-3-Clause, no dependencies) as the bridge's second runtime dependency.
