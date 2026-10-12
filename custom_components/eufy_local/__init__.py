"""HALEC (Home Assistant Local Eufy Cams).

Talks to the eufy-local-bridge, which keeps a LAN-only P2P connection to the
HomeBase. Only tested with HomeBase 2 (T8010).
"""

from __future__ import annotations

from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import BridgeClient
from .const import CONF_TOKEN
from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import station_device_info

PLATFORMS: list[Platform] = [
    Platform.ALARM_CONTROL_PANEL,
    Platform.BINARY_SENSOR,
    Platform.CAMERA,
    Platform.EVENT,
    Platform.IMAGE,
    Platform.SENSOR,
]


async def async_setup_entry(hass: HomeAssistant, entry: EufyLocalConfigEntry) -> bool:
    """Set up the integration from a config entry."""
    client = BridgeClient(
        async_get_clientsession(hass),
        entry.data[CONF_HOST],
        entry.data[CONF_PORT],
        entry.data.get(CONF_TOKEN),
    )
    coordinator = EufyLocalCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    # Cameras reference their HomeBase by device id, so it must exist before any entity.
    devices = dr.async_get(hass)
    for station_sn, station in coordinator.stations.items():
        device = devices.async_get_or_create(
            config_entry_id=entry.entry_id, **station_device_info(station_sn, station)
        )
        coordinator.station_device_ids[station_sn] = device.id
    coordinator.start_listener()
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: EufyLocalConfigEntry) -> bool:
    """Unload a config entry; the background event task is cancelled automatically."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
