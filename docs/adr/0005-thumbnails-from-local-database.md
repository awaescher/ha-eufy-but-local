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
