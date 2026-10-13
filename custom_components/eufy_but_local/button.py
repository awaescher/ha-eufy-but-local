"""HomeBase restart; sent over P2P (ADR 0012)."""

from __future__ import annotations

from homeassistant.components.button import ButtonDeviceClass, ButtonEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import EufyStationEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyLocalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    async_add_entities(EufyRestartButton(coordinator, sn) for sn in coordinator.stations)


class EufyRestartButton(EufyStationEntity, ButtonEntity):
    """Restarts the HomeBase."""

    _attr_device_class = ButtonDeviceClass.RESTART
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: EufyLocalCoordinator, station_sn: str) -> None:
        super().__init__(coordinator, station_sn, "restart")

    async def async_press(self) -> None:
        await self._command("reboot")
