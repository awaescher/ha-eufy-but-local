"""Base entities for the HomeBase and its cameras."""

from __future__ import annotations

from typing import Any

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, MANUFACTURER
from .coordinator import EufyLocalCoordinator


class EufyStationEntity(CoordinatorEntity[EufyLocalCoordinator]):
    """An entity belonging to the HomeBase."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: EufyLocalCoordinator, station_sn: str, key: str) -> None:
        super().__init__(coordinator)
        self.station_sn = station_sn
        self._attr_unique_id = f"{station_sn}_{key}"
        station = coordinator.stations.get(station_sn, {})
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, station_sn)},
            name=station.get("name") or "HomeBase",
            manufacturer=MANUFACTURER,
            model=station.get("model"),
            serial_number=station_sn,
        )

    @property
    def station(self) -> dict[str, Any]:
        return self.coordinator.stations.get(self.station_sn, {})

    @property
    def available(self) -> bool:
        return super().available and self.station_sn in self.coordinator.stations


class EufyCameraEntity(CoordinatorEntity[EufyLocalCoordinator]):
    """An entity belonging to a camera; the device hangs off the HomeBase."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: EufyLocalCoordinator, device_sn: str, key: str) -> None:
        super().__init__(coordinator)
        self.device_sn = device_sn
        self._attr_unique_id = f"{device_sn}_{key}"
        cam = coordinator.cameras.get(device_sn, {})
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, device_sn)},
            name=cam.get("name") or device_sn,
            manufacturer=MANUFACTURER,
            model=cam.get("model"),
            serial_number=device_sn,
            via_device=(DOMAIN, cam["station"]) if cam.get("station") else None,
        )

    @property
    def cam(self) -> dict[str, Any]:
        return self.coordinator.cameras.get(self.device_sn, {})

    @property
    def p2p_connected(self) -> bool:
        """Whether the bridge has a local P2P connection to this camera's HomeBase."""
        station = self.coordinator.stations.get(self.cam.get("station") or "", {})
        return bool(station.get("p2p"))

    @property
    def available(self) -> bool:
        return super().available and self.device_sn in self.coordinator.cameras
