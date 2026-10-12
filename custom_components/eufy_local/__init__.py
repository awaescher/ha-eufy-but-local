"""Eufy HomeBase (local).

Talks to the eufy-local-bridge, which keeps a LAN-only P2P connection to the
HomeBase. Only tested with HomeBase 2 (T8010).
"""

from __future__ import annotations

from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import BridgeClient
from .const import CONF_TOKEN
from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator

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
    coordinator.start_listener()
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: EufyLocalConfigEntry) -> bool:
    """Unload a config entry; the background event task is cancelled automatically."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
