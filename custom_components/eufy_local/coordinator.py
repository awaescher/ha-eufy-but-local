"""Coordinator: keeps the bridge state current (SSE push, polling as fallback)."""

from __future__ import annotations

import asyncio
from datetime import timedelta
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import BridgeAuthError, BridgeClient, BridgeError
from .const import DOMAIN, SIGNAL_EVENT

_LOGGER = logging.getLogger(__name__)

POLL_INTERVAL = timedelta(seconds=60)
RECONNECT_MIN_SECONDS = 2
RECONNECT_MAX_SECONDS = 60

type EufyLocalConfigEntry = ConfigEntry[EufyLocalCoordinator]


class EufyLocalCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """State of the HomeBase and its cameras as reported by the bridge."""

    config_entry: EufyLocalConfigEntry

    def __init__(
        self, hass: HomeAssistant, entry: EufyLocalConfigEntry, client: BridgeClient
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=DOMAIN,
            update_interval=POLL_INTERVAL,
        )
        self.client = client
        # station serial -> device registry id, so cameras can link to their HomeBase
        self.station_device_ids: dict[str, str] = {}

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            return await self.client.state()
        except BridgeAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except BridgeError as err:
            raise UpdateFailed(f"bridge unreachable: {err}") from err

    def start_listener(self) -> None:
        self.config_entry.async_create_background_task(
            self.hass, self._listen(), f"{DOMAIN}_events"
        )

    async def _listen(self) -> None:
        """Follow the bridge's event stream; reconnect with backoff."""
        signal = SIGNAL_EVENT.format(entry_id=self.config_entry.entry_id)
        delay = RECONNECT_MIN_SECONDS
        while True:
            try:
                async for event, data in self.client.events():
                    delay = RECONNECT_MIN_SECONDS
                    if event == "state":
                        self.async_set_updated_data(data)
                    elif event == "event":
                        async_dispatcher_send(self.hass, signal, data)
            except BridgeAuthError:
                _LOGGER.error("The bridge rejected the token; event stream stopped")
                return
            except Exception as err:
                _LOGGER.debug("Event stream interrupted: %s", err)
            # Let the regular refresh decide whether the bridge is really gone.
            await self.async_request_refresh()
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_SECONDS)

    @property
    def stations(self) -> dict[str, dict[str, Any]]:
        return (self.data or {}).get("stations", {})

    @property
    def cameras(self) -> dict[str, dict[str, Any]]:
        return (self.data or {}).get("cameras", {})
