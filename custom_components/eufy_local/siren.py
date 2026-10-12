"""Alarm sound of the cameras and the HomeBase; triggered over P2P (ADR 0012)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.siren import ATTR_DURATION, SirenEntity, SirenEntityFeature
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import EufyCameraEntity, EufyStationEntity

DEFAULT_SECONDS = 10
FEATURES = SirenEntityFeature.TURN_ON | SirenEntityFeature.TURN_OFF | SirenEntityFeature.DURATION


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyLocalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    entities: list[SirenEntity] = [EufyCameraSiren(coordinator, sn) for sn in coordinator.cameras]
    entities += [EufyStationSiren(coordinator, sn) for sn in coordinator.stations]
    async_add_entities(entities)


class EufyCameraSiren(EufyCameraEntity, SirenEntity):
    """The camera's alarm sound. The bridge only knows that it was triggered, not when it ends."""

    _attr_translation_key = "siren"
    _attr_supported_features = FEATURES
    _attr_is_on = None

    def __init__(self, coordinator: EufyLocalCoordinator, device_sn: str) -> None:
        super().__init__(coordinator, device_sn, "siren")

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._command("alarm", int(kwargs.get(ATTR_DURATION) or DEFAULT_SECONDS))

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._command("stopAlarm")


class EufyStationSiren(EufyStationEntity, SirenEntity):
    """The HomeBase's alarm sound."""

    _attr_translation_key = "siren"
    _attr_supported_features = FEATURES

    def __init__(self, coordinator: EufyLocalCoordinator, station_sn: str) -> None:
        super().__init__(coordinator, station_sn, "siren")

    @property
    def is_on(self) -> bool | None:
        value = self.props.get("alarm")
        return None if value is None else bool(value)

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._command("alarm", int(kwargs.get(ATTR_DURATION) or DEFAULT_SECONDS))

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._command("stopAlarm")
