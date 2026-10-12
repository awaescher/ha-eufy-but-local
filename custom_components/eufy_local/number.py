"""Numeric settings of cameras and the HomeBase; written over P2P (ADR 0012)."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.components.number import NumberEntity, NumberEntityDescription, NumberMode
from homeassistant.const import EntityCategory, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import EufyCameraEntity, EufyStationEntity


@dataclass(frozen=True, kw_only=True)
class EufyNumberDescription(NumberEntityDescription):
    entity_category: EntityCategory | None = EntityCategory.CONFIG
    native_step: float | None = 1
    mode: NumberMode = NumberMode.SLIDER


CAMERA_NUMBERS: tuple[EufyNumberDescription, ...] = (
    EufyNumberDescription(
        key="motionDetectionSensitivity",
        translation_key="motion_sensitivity",
        native_min_value=1,
        native_max_value=7,
    ),
    EufyNumberDescription(
        key="recordingClipLength",
        translation_key="clip_length",
        native_min_value=5,
        native_max_value=120,
        native_unit_of_measurement=UnitOfTime.SECONDS,
        mode=NumberMode.BOX,
    ),
    EufyNumberDescription(
        key="recordingRetriggerInterval",
        translation_key="retrigger_interval",
        native_min_value=5,
        native_max_value=60,
        native_unit_of_measurement=UnitOfTime.SECONDS,
        mode=NumberMode.BOX,
    ),
)

STATION_NUMBERS: tuple[EufyNumberDescription, ...] = (
    EufyNumberDescription(
        key="alarmVolume", translation_key="alarm_volume", native_min_value=1, native_max_value=26
    ),
    EufyNumberDescription(
        key="promptVolume", translation_key="prompt_volume", native_min_value=0, native_max_value=26
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyLocalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    entities: list[NumberEntity] = [
        EufyCameraNumber(coordinator, sn, description)
        for sn, cam in coordinator.cameras.items()
        for description in CAMERA_NUMBERS
        if description.key in (cam.get("properties") or {})
    ]
    entities += [
        EufyStationNumber(coordinator, sn, description)
        for sn, station in coordinator.stations.items()
        for description in STATION_NUMBERS
        if description.key in (station.get("properties") or {})
    ]
    async_add_entities(entities)


class EufyCameraNumber(EufyCameraEntity, NumberEntity):
    """A numeric camera setting."""

    def __init__(
        self, coordinator: EufyLocalCoordinator, device_sn: str, description: EufyNumberDescription
    ) -> None:
        super().__init__(coordinator, device_sn, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> float | None:
        return self.props.get(self.entity_description.key)

    async def async_set_native_value(self, value: float) -> None:
        await self._set(self.entity_description.key, round(value))


class EufyStationNumber(EufyStationEntity, NumberEntity):
    """A numeric HomeBase setting."""

    def __init__(
        self, coordinator: EufyLocalCoordinator, station_sn: str, description: EufyNumberDescription
    ) -> None:
        super().__init__(coordinator, station_sn, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> float | None:
        return self.props.get(self.entity_description.key)

    async def async_set_native_value(self, value: float) -> None:
        await self._set(self.entity_description.key, round(value))
