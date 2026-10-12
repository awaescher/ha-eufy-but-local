"""HALEC (Home Assistant Local Eufy Cams).

Talks to the eufy-local-bridge, which keeps a LAN-only P2P connection to the
HomeBase. Only tested with HomeBase 2 (T8010).
"""

from __future__ import annotations

from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import BridgeClient, BridgeError
from .const import CONF_CLOUD_PUSH, CONF_TOKEN
from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import station_device_info

PLATFORMS: list[Platform] = [
    Platform.ALARM_CONTROL_PANEL,
    Platform.BINARY_SENSOR,
    Platform.CAMERA,
    Platform.EVENT,
    Platform.IMAGE,
    Platform.SELECT,
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
    try:
        # The integration's options are the source of truth for the bridge's cloud features.
        await client.set_config(cloud_push=entry.options.get(CONF_CLOUD_PUSH, False))
    except BridgeError as err:
        raise ConfigEntryNotReady(f"bridge rejected the configuration: {err}") from err
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
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    return True


async def _async_options_updated(hass: HomeAssistant, entry: EufyLocalConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: EufyLocalConfigEntry) -> bool:
    """Unload a config entry; the background event task is cancelled automatically."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
