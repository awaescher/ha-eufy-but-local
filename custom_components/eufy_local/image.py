"""Image entity: thumbnail of the latest event, fetched locally from the HomeBase.

Handy for notifications, e.g. `image: /api/image_proxy/image.front_door_last_event_image`.
"""

from __future__ import annotations

from homeassistant.components.image import ImageEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import EufyCameraEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyLocalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    async_add_entities(EufyLastEventImage(hass, coordinator, sn) for sn in coordinator.cameras)


class EufyLastEventImage(EufyCameraEntity, ImageEntity):
    """Latest event thumbnail."""

    _attr_translation_key = "last_event_image"
    _attr_content_type = "image/jpeg"

    def __init__(self, hass: HomeAssistant, coordinator: EufyLocalCoordinator, device_sn: str) -> None:
        EufyCameraEntity.__init__(self, coordinator, device_sn, "last_event_image")
        ImageEntity.__init__(self, hass)
        self._sync_timestamp()

    def _sync_timestamp(self) -> None:
        value = self.cam.get("imageAt")
        self._attr_image_last_updated = dt_util.parse_datetime(value) if value else None

    @callback
    def _handle_coordinator_update(self) -> None:
        self._sync_timestamp()
        super()._handle_coordinator_update()

    async def async_image(self) -> bytes | None:
        return await self.coordinator.client.image(self.device_sn)
