"""Config flow tests."""

from __future__ import annotations

from homeassistant.config_entries import SOURCE_USER
from homeassistant.const import CONF_EMAIL, CONF_HOST, CONF_PASSWORD, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.eufy_local.const import CONF_CODE, CONF_COUNTRY, CONF_TOKEN, DOMAIN

from .conftest import STATION, TOKEN, FakeBridge


def bridge_input(bridge: FakeBridge, token: str = TOKEN) -> dict:
    return {CONF_HOST: "127.0.0.1", CONF_PORT: bridge.port, CONF_TOKEN: token}


LOGIN = {CONF_EMAIL: "second@example.com", CONF_PASSWORD: "pw", CONF_COUNTRY: " de "}


async def start(hass: HomeAssistant) -> dict:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"
    return result


async def test_bridge_already_logged_in(hass: HomeAssistant, bridge: FakeBridge) -> None:
    result = await start(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], bridge_input(bridge))
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "HomeBase 2"
    assert result["result"].unique_id == STATION
    assert result["data"] == bridge_input(bridge)
    assert bridge.logins == []


async def test_cannot_connect(hass: HomeAssistant, bridge: FakeBridge) -> None:
    result = await start(hass)
    port = bridge.port
    await bridge.close()
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_HOST: "127.0.0.1", CONF_PORT: port, CONF_TOKEN: TOKEN}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


async def test_invalid_token(hass: HomeAssistant, bridge: FakeBridge) -> None:
    result = await start(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], bridge_input(bridge, token="wrong")
    )
    assert result["errors"] == {"base": "invalid_token"}


async def test_login_with_2fa(hass: HomeAssistant, bridge: FakeBridge) -> None:
    bridge.logged_out()
    bridge.login_result = "tfa"
    result = await start(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], bridge_input(bridge))
    assert result["step_id"] == "login"

    result = await hass.config_entries.flow.async_configure(result["flow_id"], LOGIN)
    assert result["step_id"] == "code"
    assert bridge.logins == [{"email": "second@example.com", "password": "pw", "country": "DE"}]

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_CODE: " 123456 "}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert bridge.codes == ["123456"]
    # Eufy credentials stay on the bridge; the entry only knows the bridge.
    assert set(result["data"]) == {CONF_HOST, CONF_PORT, CONF_TOKEN}


async def test_login_with_captcha(hass: HomeAssistant, bridge: FakeBridge) -> None:
    bridge.logged_out()
    bridge.login_result = "captcha"
    result = await start(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], bridge_input(bridge))
    result = await hass.config_entries.flow.async_configure(result["flow_id"], LOGIN)
    assert result["step_id"] == "captcha"
    assert result["description_placeholders"]["captcha_url"].endswith(f"/api/captcha?token={TOKEN}")
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_CODE: "123456"}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY


async def test_login_failed(hass: HomeAssistant, bridge: FakeBridge) -> None:
    bridge.logged_out()
    bridge.login_result = "error"
    result = await start(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], bridge_input(bridge))
    result = await hass.config_entries.flow.async_configure(result["flow_id"], LOGIN)
    assert result["step_id"] == "login"
    assert result["errors"] == {"base": "login_failed"}
    assert result["description_placeholders"]["message"] == "login error"


async def test_wrong_2fa_code(hass: HomeAssistant, bridge: FakeBridge) -> None:
    bridge.logged_out()
    bridge.login_result = "tfa"
    result = await start(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], bridge_input(bridge))
    result = await hass.config_entries.flow.async_configure(result["flow_id"], LOGIN)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_CODE: "000000"}
    )
    assert result["step_id"] == "login"
    assert result["errors"] == {"base": "login_failed"}


async def test_resumes_pending_2fa(hass: HomeAssistant, bridge: FakeBridge) -> None:
    """The bridge already waits for a code (e.g. after it restarted)."""
    bridge.logged_out()
    bridge.state["phase"] = "tfa"
    result = await start(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], bridge_input(bridge))
    assert result["step_id"] == "code"


async def test_login_times_out(hass: HomeAssistant, bridge: FakeBridge) -> None:
    bridge.logged_out()
    bridge.login_result = "connecting"
    result = await start(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], bridge_input(bridge))
    result = await hass.config_entries.flow.async_configure(result["flow_id"], LOGIN)
    assert result["errors"] == {"base": "login_failed"}


async def test_account_without_station(hass: HomeAssistant, bridge: FakeBridge) -> None:
    """Login succeeds, but the HomeBase was never shared with this account."""
    bridge.logged_out()
    bridge.login_result = "ok_without_devices"
    result = await start(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], bridge_input(bridge))
    result = await hass.config_entries.flow.async_configure(result["flow_id"], LOGIN)
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "no_station"


async def test_already_configured(hass: HomeAssistant, bridge: FakeBridge) -> None:
    MockConfigEntry(domain=DOMAIN, unique_id=STATION, data={}).add_to_hass(hass)
    result = await start(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], bridge_input(bridge))
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


async def test_reauth_updates_token(
    hass: HomeAssistant, bridge: FakeBridge, entry: MockConfigEntry
) -> None:
    entry.add_to_hass(hass)
    hass.config_entries.async_update_entry(entry, data={**entry.data, CONF_TOKEN: "old"})
    result = await entry.start_reauth_flow(hass)
    assert result["step_id"] == "reauth_confirm"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_TOKEN: "still-wrong"}
    )
    assert result["errors"] == {"base": "invalid_token"}

    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_TOKEN: TOKEN})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert entry.data[CONF_TOKEN] == TOKEN
    await hass.async_block_till_done()
