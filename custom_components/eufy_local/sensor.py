"""Sensors: battery, time of the latest local event, stored event count."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import PERCENTAGE, EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import EufyCameraEntity


@dataclass(frozen=True, kw_only=True)
class EufySensorDescription(SensorEntityDescription):
    """Sensor description with a value extractor for the camera's state dict."""

    value_fn: Callable[[dict[str, Any]], Any]


SENSORS: tuple[EufySensorDescription, ...] = (
    EufySensorDescription(
        key="battery",
        device_class=SensorDeviceClass.BATTERY,
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda cam: cam.get("battery"),
    ),
    EufySensorDescription(
        key="last_event",
        translation_key="last_event",
        device_class=SensorDeviceClass.TIMESTAMP,
        value_fn=lambda cam: dt_util.parse_datetime(cam["lastEventAt"])
        if cam.get("lastEventAt")
        else None,
    ),
    EufySensorDescription(
        key="event_count",
        translation_key="event_count",
        state_class=SensorStateClass.TOTAL_INCREASING,
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda cam: cam.get("count"),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyLocalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    async_add_entities(
        EufyCameraSensor(coordinator, sn, description)
        for sn in coordinator.cameras
        for description in SENSORS
    )


class EufyCameraSensor(EufyCameraEntity, SensorEntity):
    """A value from the camera's state."""

    entity_description: EufySensorDescription

    def __init__(
        self,
        coordinator: EufyLocalCoordinator,
        device_sn: str,
        description: EufySensorDescription,
    ) -> None:
        super().__init__(coordinator, device_sn, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> Any:
        return self.entity_description.value_fn(self.cam)
