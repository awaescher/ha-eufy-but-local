"""Cameras: still image from the HomeBase or the last live view, live view via P2P."""

from __future__ import annotations

from datetime import timedelta

from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.components.ffmpeg import async_get_image
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import EufyCameraEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyLocalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    async_add_entities(EufyLocalCamera(coordinator, sn) for sn in coordinator.cameras)


class EufyLocalCamera(EufyCameraEntity, Camera):
    """A eufyCam attached to the HomeBase."""

    _attr_name = None  # use the device name
    _attr_brand = "eufy"
    _attr_supported_features = CameraEntityFeature.STREAM

    def __init__(self, coordinator: EufyLocalCoordinator, device_sn: str) -> None:
        EufyCameraEntity.__init__(self, coordinator, device_sn, "camera")
        Camera.__init__(self)
        self._image: bytes | None = None
        # ("event", imageAt) or ("frame", frameAt): what `_image` shows.
        self._image_key: tuple[str, str | None] | None = None

    @property
    def model(self) -> str | None:
        return self.cam.get("model")

    @property
    def is_streaming(self) -> bool:
        return bool(self.cam.get("live"))

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        return {"last_event": self.cam.get("lastEventAt"), "codec": self.cam.get("codec")}

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes | None:
        """The newer of the latest event thumbnail and the last live frame.

        Never wakes the battery-powered camera: both come from what the bridge already has.
        """
        frame_at = self.cam.get("frameAt")
        image_at = self.cam.get("imageAt")
        if frame_at and (image_at is None or frame_at > image_at):
            if self._image_key != ("frame", frame_at):
                # The bridge keeps the frame as H.264; ffmpeg turns it into a JPEG.
                image = await async_get_image(
                    self.hass, self.coordinator.client.frame_url(self.device_sn)
                )
                if image:
                    self._image, self._image_key = image, ("frame", frame_at)
            if self._image_key == ("frame", frame_at):
                return self._image
        if self._image is None or self._image_key != ("event", image_at):
            image = await self.coordinator.client.image(self.device_sn)
            if image:
                self._image, self._image_key = image, ("event", image_at)
        return self._image

    async def async_snooze(self, duration: timedelta) -> None:
        """Silence the camera's detection and notifications for `duration` (P2P)."""
        await self._command("snooze", max(1, int(duration.total_seconds())))

    async def stream_source(self) -> str | None:
        """FLV (video + audio) from the bridge; opening it wakes the camera."""
        if not self.p2p_connected:
            return None
        return self.coordinator.client.stream_url(self.device_sn)
