"""Event entities: new local recording (HomeBase database) and cloud person/motion pushes."""

from __future__ import annotations

from typing import Any

from homeassistant.components.event import EventDeviceClass, EventEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import EVENT_TYPES, SIGNAL_EVENT
from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import EufyCameraEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyLocalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    async_add_entities(EufyActivityEvent(coordinator, sn) for sn in coordinator.cameras)


class EufyActivityEvent(EufyCameraEntity, EventEntity):
    """Fires for every new recording on the HomeBase and for cloud pushes."""

    _attr_translation_key = "activity"
    _attr_device_class = EventDeviceClass.MOTION
    _attr_event_types = EVENT_TYPES

    def __init__(self, coordinator: EufyLocalCoordinator, device_sn: str) -> None:
        super().__init__(coordinator, device_sn, "activity")

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        signal = SIGNAL_EVENT.format(entry_id=self.coordinator.config_entry.entry_id)
        self.async_on_remove(async_dispatcher_connect(self.hass, signal, self._handle_event))

    @callback
    def _handle_event(self, event: dict[str, Any]) -> None:
        if event.get("device_sn") != self.device_sn or event.get("type") not in EVENT_TYPES:
            return
        self._trigger_event(event["type"], {"source": event.get("source", "local")})
        self.async_write_ha_state()
