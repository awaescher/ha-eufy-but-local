"""Eufy But Local.

Talks to the eufy-but-local bridge, which keeps a LAN-only P2P connection to the
HomeBase. Only tested with HomeBase 2 (T8010).
"""

from __future__ import annotations

import logging

from homeassistant.components.camera import DOMAIN as CAMERA_DOMAIN
from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import (
    config_validation as cv,
    device_registry as dr,
    entity_registry as er,
    service,
)
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.translation import async_get_translations
from homeassistant.helpers.typing import ConfigType
from homeassistant.util import slugify
import voluptuous as vol

from .api import BridgeClient, BridgeError
from .const import CONF_CLOUD_PUSH, CONF_TOKEN, DOMAIN
from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import english_name, station_device_info

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [
    Platform.ALARM_CONTROL_PANEL,
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.CAMERA,
    Platform.EVENT,
    Platform.IMAGE,
    Platform.LIGHT,
    Platform.NUMBER,
    Platform.SELECT,
    Platform.SENSOR,
    Platform.SIREN,
    Platform.SWITCH,
]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
SERVICE_SNOOZE = "snooze"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the integration's actions."""
    service.async_register_platform_entity_service(
        hass,
        DOMAIN,
        SERVICE_SNOOZE,
        entity_domain=CAMERA_DOMAIN,
        schema={vol.Required("duration"): cv.positive_time_period},
        func="async_snooze",
    )
    return True


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
    await _async_english_entity_ids(hass, entry)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    return True


# Names entities had in earlier versions; their generated IDs are renamed too.
FORMER_NAMES: dict[str, tuple[str, ...]] = {
    "local_activity": ("Event (local)", "Ereignis (lokal)", "New recording", "Neue Aufnahme"),
}


async def _async_english_entity_ids(hass: HomeAssistant, entry: EufyLocalConfigEntry) -> None:
    """Rename entity IDs Home Assistant derived from a translated name to English ones.

    Before 0.1.15 a German Home Assistant created IDs like `event.terrasse_aktivitat`. IDs the
    user chose are left alone: only an ID generated from the device name and one of the
    entity's names (current in any shipped language, or a former one) is renamed.
    """
    entities = er.async_get(hass)
    devices = dr.async_get(hass)
    english = await async_get_translations(hass, "en", "entity", {DOMAIN})
    translated = [
        await async_get_translations(hass, language, "entity", {DOMAIN})
        for language in {"de", hass.config.language}
    ]
    for reg in er.async_entries_for_config_entry(entities, entry.entry_id):
        device = devices.async_get(reg.device_id) if reg.device_id else None
        if device is None or not device.name:
            continue
        domain, object_id = reg.entity_id.split(".", 1)
        if reg.translation_key:
            key = f"component.{DOMAIN}.entity.{domain}.{reg.translation_key}.name"
            name = english.get(key)
            known = {reg.original_name, *(t.get(key) for t in translated)}
            known.update(FORMER_NAMES.get(reg.translation_key, ()))
        elif reg.original_device_class:
            name = english_name(reg.original_device_class)
            known = {reg.original_name}
        else:
            continue
        generated = {slugify(f"{device.name} {n}") for n in known if n}
        if not name or object_id not in generated:
            continue  # chosen by the user
        new_id = f"{domain}.{slugify(f'{device.name} {name}')}"
        if new_id == reg.entity_id or entities.async_get(new_id):
            continue
        _LOGGER.info("Renaming %s to %s (English entity IDs)", reg.entity_id, new_id)
        entities.async_update_entity(reg.entity_id, new_entity_id=new_id)


async def _async_options_updated(hass: HomeAssistant, entry: EufyLocalConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: EufyLocalConfigEntry) -> bool:
    """Unload a config entry; the background event task is cancelled automatically."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
