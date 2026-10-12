"""Binary sensors: local activity per camera, P2P link of the HomeBase."""

from __future__ import annotations

from datetime import datetime, timedelta

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.const import EntityCategory
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.event import async_call_later
from homeassistant.util import dt as dt_util

from .const import EVENT_ACTIVE_SECONDS
from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import EufyCameraEntity, EufyStationEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyLocalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    entities: list[BinarySensorEntity] = [
        EufyLocalActivity(coordinator, sn) for sn in coordinator.cameras
    ]
    entities += [EufyP2PConnected(coordinator, sn) for sn in coordinator.stations]
    async_add_entities(entities)


class EufyLocalActivity(EufyCameraEntity, BinarySensorEntity):
    """On for EVENT_ACTIVE_SECONDS after a new recording appeared in the local database."""

    _attr_translation_key = "local_activity"
    _attr_device_class = BinarySensorDeviceClass.MOTION

    def __init__(self, coordinator: EufyLocalCoordinator, device_sn: str) -> None:
        super().__init__(coordinator, device_sn, "local_activity")
        self._cancel_expiry: CALLBACK_TYPE | None = None

    def _last_event(self) -> datetime | None:
        value = self.cam.get("lastEventAt")
        return dt_util.parse_datetime(value) if value else None

    @property
    def is_on(self) -> bool:
        last = self._last_event()
        return last is not None and dt_util.utcnow() - last < timedelta(seconds=EVENT_ACTIVE_SECONDS)

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._schedule_expiry()

    @callback
    def _handle_coordinator_update(self) -> None:
        self._schedule_expiry()
        super()._handle_coordinator_update()

    @callback
    def _schedule_expiry(self) -> None:
        """Re-evaluate the state when the active window ends."""
        if self._cancel_expiry:
            self._cancel_expiry()
            self._cancel_expiry = None
        last = self._last_event()
        if last is None or not self.is_on:
            return
        remaining = EVENT_ACTIVE_SECONDS - (dt_util.utcnow() - last).total_seconds()
        self._cancel_expiry = async_call_later(self.hass, remaining + 0.1, self._expired)

    @callback
    def _expired(self, _now: datetime) -> None:
        self._cancel_expiry = None
        self.async_write_ha_state()

    async def async_will_remove_from_hass(self) -> None:
        if self._cancel_expiry:
            self._cancel_expiry()
        await super().async_will_remove_from_hass()


class EufyP2PConnected(EufyStationEntity, BinarySensorEntity):
    """Whether the bridge holds a local (LAN-only) P2P connection to the HomeBase."""

    _attr_translation_key = "p2p_local"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: EufyLocalCoordinator, station_sn: str) -> None:
        super().__init__(coordinator, station_sn, "p2p_local")

    @property
    def is_on(self) -> bool:
        return bool(self.station.get("p2p"))

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        return {"cloud_connected": bool((self.coordinator.data or {}).get("cloud"))}
