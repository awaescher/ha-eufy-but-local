"""Cameras: still image from the HomeBase event database, live view via P2P."""

from __future__ import annotations

from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.components.stream import CONF_USE_WALLCLOCK_AS_TIMESTAMPS
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
        # Raw Annex-B carries no timestamps; without this the stream worker gives up with
        # "No dts in 7 consecutive packets". Arrival time is the right clock for live P2P.
        self.stream_options[CONF_USE_WALLCLOCK_AS_TIMESTAMPS] = True
        self._image: bytes | None = None
        self._image_at: str | None = None

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
        """Thumbnail of the latest event. Never wakes the battery-powered camera."""
        image_at = self.cam.get("imageAt")
        if self._image is None or image_at != self._image_at:
            image = await self.coordinator.client.image(self.device_sn)
            if image:
                self._image, self._image_at = image, image_at
        return self._image

    async def stream_source(self) -> str | None:
        """Raw H.264 from the bridge; opening it wakes the camera."""
        if not self.p2p_connected:
            return None
        return self.coordinator.client.stream_url(self.device_sn)
