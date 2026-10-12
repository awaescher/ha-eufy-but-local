"""Alarm panel: the HomeBase guard mode, switched locally via P2P."""

from __future__ import annotations

from homeassistant.components.alarm_control_panel import (
    AlarmControlPanelEntity,
    AlarmControlPanelEntityFeature,
    AlarmControlPanelState,
)
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .api import BridgeError
from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import EufyStationEntity

# Eufy guard modes without an equivalent (SCHEDULE, GEO) map to an unknown state.
STATE_MAP: dict[str, AlarmControlPanelState] = {
    "AWAY": AlarmControlPanelState.ARMED_AWAY,
    "HOME": AlarmControlPanelState.ARMED_HOME,
    "DISARMED": AlarmControlPanelState.DISARMED,
    "OFF": AlarmControlPanelState.DISARMED,
    "CUSTOM1": AlarmControlPanelState.ARMED_CUSTOM_BYPASS,
    "CUSTOM2": AlarmControlPanelState.ARMED_CUSTOM_BYPASS,
    "CUSTOM3": AlarmControlPanelState.ARMED_CUSTOM_BYPASS,
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyLocalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    async_add_entities(EufyGuardMode(coordinator, sn) for sn in coordinator.stations)


class EufyGuardMode(EufyStationEntity, AlarmControlPanelEntity):
    """Away / Home / Disarmed."""

    _attr_name = None
    _attr_code_arm_required = False
    _attr_supported_features = (
        AlarmControlPanelEntityFeature.ARM_AWAY | AlarmControlPanelEntityFeature.ARM_HOME
    )

    def __init__(self, coordinator: EufyLocalCoordinator, station_sn: str) -> None:
        super().__init__(coordinator, station_sn, "guard_mode")

    @property
    def alarm_state(self) -> AlarmControlPanelState | None:
        return STATE_MAP.get(self.station.get("guardModeName") or "")

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        return {"eufy_mode": self.station.get("guardModeName")}

    async def _set_mode(self, mode: str) -> None:
        try:
            await self.coordinator.client.set_guard_mode(self.station_sn, mode)
        except BridgeError as err:
            raise HomeAssistantError(f"Could not set guard mode: {err}") from err

    async def async_alarm_arm_away(self, code: str | None = None) -> None:
        await self._set_mode("AWAY")

    async def async_alarm_arm_home(self, code: str | None = None) -> None:
        await self._set_mode("HOME")

    async def async_alarm_disarm(self, code: str | None = None) -> None:
        await self._set_mode("DISARMED")
