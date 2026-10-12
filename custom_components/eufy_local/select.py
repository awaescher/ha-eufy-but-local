"""Selects: guard mode with every Eufy mode, and enumerated camera/HomeBase settings (P2P)."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.components.select import SelectEntity, SelectEntityDescription
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .api import BridgeError
from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import EufyCameraEntity, EufyStationEntity

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


@dataclass(frozen=True, kw_only=True)
class EufySelectDescription(SelectEntityDescription):
    """A setting with fixed values: option key (translated) -> value on the device."""

    values: dict[str, int]
    entity_category: EntityCategory | None = EntityCategory.CONFIG


CAMERA_SELECTS: tuple[EufySelectDescription, ...] = (
    EufySelectDescription(
        key="motionDetectionType",
        translation_key="motion_detection_type",
        values={"humans_only": 0, "all_motions": 2},
    ),
    EufySelectDescription(
        key="nightvision",
        translation_key="night_vision",
        values={"off": 0, "infrared": 1, "color": 2},
    ),
    EufySelectDescription(
        key="speakerVolume",
        translation_key="speaker_volume",
        values={"low": 90, "medium": 92, "high": 93},
    ),
    EufySelectDescription(
        key="powerWorkingMode",
        translation_key="power_mode",
        values={"optimal_battery": 0, "optimal_surveillance": 1, "custom": 2},
    ),
    EufySelectDescription(
        key="videoStreamingQuality",
        translation_key="streaming_quality",
        values={"auto": 0, "low": 1, "medium": 2, "high": 3},
    ),
    EufySelectDescription(
        key="videoRecordingQuality",
        translation_key="recording_quality",
        values={"2k": 1, "full_hd": 2},
    ),
    # Only relevant for Eufy's app or rarely changed.
    EufySelectDescription(
        key="watermark",
        translation_key="watermark",
        values={"off": 0, "timestamp": 1, "timestamp_and_logo": 2},
        entity_registry_enabled_default=False,
    ),
    EufySelectDescription(
        key="notificationType",
        translation_key="notification_type",
        values={"most_efficient": 1, "include_thumbnail": 2, "full_effect": 3},
        entity_registry_enabled_default=False,
    ),
    EufySelectDescription(
        key="powerSource",
        translation_key="power_source",
        values={"battery": 0, "solar_panel": 1},
        entity_registry_enabled_default=False,
    ),
)

STATION_SELECTS: tuple[EufySelectDescription, ...] = (
    EufySelectDescription(
        key="alarmTone", translation_key="alarm_tone", values={"tone_1": 1, "tone_2": 2}
    ),
    EufySelectDescription(
        key="timeFormat",
        translation_key="time_format",
        values={"12h": 0, "24h": 1},
        entity_registry_enabled_default=False,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyLocalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    entities: list[SelectEntity] = [
        EufyGuardModeSelect(coordinator, sn) for sn in coordinator.stations
    ]
    entities += [
        EufyCameraSelect(coordinator, sn, description)
        for sn, cam in coordinator.cameras.items()
        for description in CAMERA_SELECTS
        if description.key in (cam.get("properties") or {})
    ]
    entities += [
        EufyStationSelect(coordinator, sn, description)
        for sn, station in coordinator.stations.items()
        for description in STATION_SELECTS
        if description.key in (station.get("properties") or {})
    ]
    async_add_entities(entities)


def _option(description: EufySelectDescription, value: object) -> str | None:
    return next((key for key, v in description.values.items() if v == value), None)


class EufyCameraSelect(EufyCameraEntity, SelectEntity):
    """An enumerated camera setting."""

    entity_description: EufySelectDescription

    def __init__(
        self, coordinator: EufyLocalCoordinator, device_sn: str, description: EufySelectDescription
    ) -> None:
        super().__init__(coordinator, device_sn, description.key)
        self.entity_description = description
        self._attr_options = list(description.values)

    @property
    def current_option(self) -> str | None:
        return _option(self.entity_description, self.props.get(self.entity_description.key))

    async def async_select_option(self, option: str) -> None:
        await self._set(self.entity_description.key, self.entity_description.values[option])


class EufyStationSelect(EufyStationEntity, SelectEntity):
    """An enumerated HomeBase setting."""

    entity_description: EufySelectDescription

    def __init__(
        self, coordinator: EufyLocalCoordinator, station_sn: str, description: EufySelectDescription
    ) -> None:
        super().__init__(coordinator, station_sn, description.key)
        self.entity_description = description
        self._attr_options = list(description.values)

    @property
    def current_option(self) -> str | None:
        return _option(self.entity_description, self.props.get(self.entity_description.key))

    async def async_select_option(self, option: str) -> None:
        await self._set(self.entity_description.key, self.entity_description.values[option])


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
