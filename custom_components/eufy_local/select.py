"""Guard mode as a select: every Eufy mode, including those the alarm panel cannot name."""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .api import BridgeError
from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import EufyStationEntity

# Option key (translated in strings.json) -> Eufy guard mode name on the bridge.
OPTIONS: dict[str, str] = {
    "home": "HOME",
    "away": "AWAY",
    "schedule": "SCHEDULE",
    "geofencing": "GEO",
    "custom1": "CUSTOM1",
    "custom2": "CUSTOM2",
    "custom3": "CUSTOM3",
    "disarmed": "DISARMED",
}
EUFY_TO_OPTION = {mode: option for option, mode in OPTIONS.items()} | {"OFF": "disarmed"}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyLocalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    async_add_entities(EufyGuardModeSelect(coordinator, sn) for sn in coordinator.stations)


class EufyGuardModeSelect(EufyStationEntity, SelectEntity):
    """The HomeBase guard mode with Eufy's own names (schedule, geofencing, custom modes)."""

    _attr_translation_key = "guard_mode"

    def __init__(self, coordinator: EufyLocalCoordinator, station_sn: str) -> None:
        super().__init__(coordinator, station_sn, "guard_mode_select")
        self._attr_options = list(OPTIONS)

    @property
    def current_option(self) -> str | None:
        return EUFY_TO_OPTION.get(self.station.get("guardModeName") or "")

    async def async_select_option(self, option: str) -> None:
        try:
            await self.coordinator.client.set_guard_mode(self.station_sn, OPTIONS[option])
        except BridgeError as err:
            raise HomeAssistantError(f"Could not set guard mode: {err}") from err
