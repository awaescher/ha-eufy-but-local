"""Sensors: battery, latest local event, stored events, and diagnostic values from P2P."""

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
from homeassistant.const import (
    PERCENTAGE,
    SIGNAL_STRENGTH_DECIBELS_MILLIWATT,
    EntityCategory,
    UnitOfTemperature,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import EufyCameraEntity, EufyStationEntity


@dataclass(frozen=True, kw_only=True)
class EufySensorDescription(SensorEntityDescription):
    """Sensor description with a value extractor for the camera's state dict."""

    value_fn: Callable[[dict[str, Any]], Any]
    # Bridge property the sensor needs; the sensor is only created if the device reports it.
    property: str | None = None


def prop(name: str) -> Callable[[dict[str, Any]], Any]:
    return lambda data: (data.get("properties") or {}).get(name)


def diagnostic(key: str, translation_key: str, *, enabled: bool = True, **kwargs: Any):
    return EufySensorDescription(
        key=key,
        translation_key=translation_key,
        property=key,
        value_fn=prop(key),
        entity_category=EntityCategory.DIAGNOSTIC,
        entity_registry_enabled_default=enabled,
        **kwargs,
    )


CHARGING_OPTIONS = {0: "not_charging", 1: "charging"}


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
        value_fn=lambda cam: (
            dt_util.parse_datetime(cam["lastEventAt"]) if cam.get("lastEventAt") else None
        ),
    ),
    EufySensorDescription(
        key="event_count",
        translation_key="event_count",
        state_class=SensorStateClass.TOTAL_INCREASING,
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda cam: cam.get("count"),
    ),
    diagnostic(
        "wifiRssi",
        "wifi_rssi",
        device_class=SensorDeviceClass.SIGNAL_STRENGTH,
        native_unit_of_measurement=SIGNAL_STRENGTH_DECIBELS_MILLIWATT,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    diagnostic(
        "batteryTemperature",
        "battery_temperature",
        device_class=SensorDeviceClass.TEMPERATURE,
        native_unit_of_measurement=UnitOfTemperature.CELSIUS,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    EufySensorDescription(
        key="chargingStatus",
        translation_key="charging_status",
        property="chargingStatus",
        device_class=SensorDeviceClass.ENUM,
        options=list(CHARGING_OPTIONS.values()),
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda cam: CHARGING_OPTIONS.get(prop("chargingStatus")(cam)),
    ),
    diagnostic("softwareVersion", "firmware"),
    diagnostic(
        "batteryUsageLastWeek",
        "battery_usage_last_week",
        enabled=False,
        native_unit_of_measurement=PERCENTAGE,
    ),
    diagnostic("lastChargingDays", "days_since_charging", enabled=False),
    diagnostic("lastChargingRecordedEvents", "recorded_events_since_charging", enabled=False),
    diagnostic("lastChargingTotalEvents", "total_events_since_charging", enabled=False),
)

STATION_SENSORS: tuple[EufySensorDescription, ...] = (
    diagnostic("softwareVersion", "firmware"),
    diagnostic("lanIpAddress", "lan_ip", enabled=False),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyLocalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data

    def reported(data: dict[str, Any], description: EufySensorDescription) -> bool:
        return description.property is None or description.property in (
            data.get("properties") or {}
        )

    entities: list[SensorEntity] = [
        EufyCameraSensor(coordinator, sn, description)
        for sn, cam in coordinator.cameras.items()
        for description in SENSORS
        if reported(cam, description)
    ]
    entities += [
        EufyStationSensor(coordinator, sn, description)
        for sn, station in coordinator.stations.items()
        for description in STATION_SENSORS
        if reported(station, description)
    ]
    async_add_entities(entities)


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


class EufyStationSensor(EufyStationEntity, SensorEntity):
    """A value from the HomeBase's state."""

    entity_description: EufySensorDescription

    def __init__(
        self,
        coordinator: EufyLocalCoordinator,
        station_sn: str,
        description: EufySensorDescription,
    ) -> None:
        super().__init__(coordinator, station_sn, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> Any:
        return self.entity_description.value_fn(self.station)
