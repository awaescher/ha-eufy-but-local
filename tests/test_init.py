"""Setup, unload, availability and diagnostics."""

from __future__ import annotations

from collections import Counter
from datetime import timedelta

from freezegun.api import FrozenDateTimeFactory
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import STATE_UNAVAILABLE
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_fire_time_changed,
)

from custom_components.eufy_local.const import CONF_CLOUD_PUSH, CONF_TOKEN, DOMAIN
from custom_components.eufy_local.diagnostics import async_get_config_entry_diagnostics

from .conftest import CAM, STATION, FakeBridge, wait_for


async def test_setup_creates_devices_and_entities(
    hass: HomeAssistant, setup_integration: MockConfigEntry
) -> None:
    assert setup_integration.state is ConfigEntryState.LOADED

    devices = dr.async_get(hass)
    entry_id = setup_integration.entry_id
    station = devices.async_get_device_by_identifier((DOMAIN, STATION), entry_id)
    camera = devices.async_get_device_by_identifier((DOMAIN, CAM), entry_id)
    assert station.model == "T8010"
    assert camera.name == "Front door"
    assert camera.via_device_id == station.id

    entities = er.async_entries_for_config_entry(er.async_get(hass), setup_integration.entry_id)
    assert Counter(e.domain for e in entities) == {
        "alarm_control_panel": 1,
        "binary_sensor": 3,
        "button": 1,
        "camera": 1,
        "event": 1,
        "image": 1,
        "light": 1,
        "number": 4,
        "select": 6,
        "sensor": 8,
        "siren": 2,
        "switch": 3,
    }
    # Settings that only matter for the Eufy app are created disabled.
    disabled = {e.entity_id for e in entities if e.disabled_by}
    assert disabled == {"select.homebase_2_time_format"}


async def test_not_ready_when_bridge_is_down(
    hass: HomeAssistant, bridge: FakeBridge, entry: MockConfigEntry
) -> None:
    await bridge.close()
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    assert entry.state is ConfigEntryState.SETUP_RETRY


async def test_wrong_token_starts_reauth(
    hass: HomeAssistant, bridge: FakeBridge, entry: MockConfigEntry
) -> None:
    entry.add_to_hass(hass)
    hass.config_entries.async_update_entry(entry, data={**entry.data, CONF_TOKEN: "wrong"})
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_ERROR
    flows = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
    assert [f["context"]["source"] for f in flows] == ["reauth"]


async def test_unload_closes_event_stream(
    hass: HomeAssistant, bridge: FakeBridge, setup_integration: MockConfigEntry
) -> None:
    assert await hass.config_entries.async_unload(setup_integration.entry_id)
    assert setup_integration.state is ConfigEntryState.NOT_LOADED
    await wait_for(lambda: bridge.sse_clients == 0)


async def test_entities_unavailable_while_bridge_is_down(
    hass: HomeAssistant,
    bridge: FakeBridge,
    setup_integration: MockConfigEntry,
    freezer: FrozenDateTimeFactory,
) -> None:
    sensor = "sensor.front_door_battery"
    assert hass.states.get(sensor).state == "87"

    port = bridge.port
    await bridge.close()
    freezer.tick(timedelta(seconds=61))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert hass.states.get(sensor).state == STATE_UNAVAILABLE

    # The bridge restarts on the same port; the next refresh recovers.
    await bridge.start(port)
    freezer.tick(timedelta(seconds=61))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert hass.states.get(sensor).state == "87"


async def test_diagnostics_redact_token(
    hass: HomeAssistant, setup_integration: MockConfigEntry
) -> None:
    diag = await async_get_config_entry_diagnostics(hass, setup_integration)
    assert diag["entry"][CONF_TOKEN] == "**REDACTED**"
    assert diag["bridge_state"]["stations"][STATION]["p2p"] is True
    assert diag["last_update_success"] is True


async def test_bridge_without_login_starts_reauth(
    hass: HomeAssistant, bridge: FakeBridge, entry: MockConfigEntry
) -> None:
    bridge.logged_out()
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_ERROR
    flows = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
    assert [f["step_id"] for f in flows] == ["login"]


async def test_lost_login_at_runtime_starts_reauth(
    hass: HomeAssistant, bridge: FakeBridge, setup_integration: MockConfigEntry
) -> None:
    # Eufy asks for a new verification code while the integration is running.
    bridge.state.update(phase="tfa", message="Verification code required")
    bridge.push_state()
    await wait_for(lambda: hass.config_entries.flow.async_progress_by_handler(DOMAIN))
    await hass.async_block_till_done()
    flows = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
    assert [(f["context"]["source"], f["step_id"]) for f in flows] == [("reauth", "code")]


async def test_setup_sends_cloud_push_off_by_default(
    bridge: FakeBridge, setup_integration: MockConfigEntry
) -> None:
    assert bridge.config_requests == [{"cloudPush": False}]


async def test_options_switch_cloud_push(
    hass: HomeAssistant, bridge: FakeBridge, setup_integration: MockConfigEntry
) -> None:
    result = await hass.config_entries.options.async_init(setup_integration.entry_id)
    assert result["step_id"] == "init"
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {CONF_CLOUD_PUSH: True}
    )
    await hass.async_block_till_done()
    assert setup_integration.options == {CONF_CLOUD_PUSH: True}
    # The entry reloads and hands the new setting to the bridge.
    assert bridge.config_requests[-1] == {"cloudPush": True}
    assert setup_integration.state is ConfigEntryState.LOADED


async def test_not_ready_when_bridge_rejects_the_configuration(
    hass: HomeAssistant, bridge: FakeBridge, entry: MockConfigEntry
) -> None:
    bridge.reject_config = True  # e.g. a bridge too old to know /api/config
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    assert entry.state is ConfigEntryState.SETUP_RETRY
