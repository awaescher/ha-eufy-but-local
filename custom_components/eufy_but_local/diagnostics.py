"""Diagnostics download (secrets redacted)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.core import HomeAssistant

from .const import CONF_TOKEN
from .coordinator import EufyLocalConfigEntry

TO_REDACT = {CONF_TOKEN, "password", "email"}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: EufyLocalConfigEntry
) -> dict[str, Any]:
    coordinator = entry.runtime_data
    return {
        "entry": async_redact_data(dict(entry.data), TO_REDACT),
        "bridge_state": coordinator.data,
        "last_update_success": coordinator.last_update_success,
    }
