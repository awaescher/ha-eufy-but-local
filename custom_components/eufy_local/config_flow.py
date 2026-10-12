"""Config flow: bridge address, then (if needed) Eufy login with 2FA or captcha."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_EMAIL, CONF_HOST, CONF_PASSWORD, CONF_PORT
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import BridgeAuthError, BridgeClient, BridgeError
from .const import CONF_CODE, CONF_COUNTRY, CONF_TOKEN, DEFAULT_PORT, DOMAIN

_LOGGER = logging.getLogger(__name__)

# Upper bound for waiting on the bridge after login/code submission.
LOGIN_TIMEOUT_SECONDS = 45
LOGIN_POLL_SECONDS = 1.0

FINAL_PHASES = ("ok", "tfa", "captcha", "error")


class EufyLocalConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Eufy HomeBase (local)."""

    VERSION = 1

    def __init__(self) -> None:
        self._client: BridgeClient | None = None
        self._data: dict[str, Any] = {}

    def _make_client(self, data: Mapping[str, Any]) -> BridgeClient:
        return BridgeClient(
            async_get_clientsession(self.hass),
            data[CONF_HOST],
            data[CONF_PORT],
            data.get(CONF_TOKEN),
        )

    async def _wait_for_login(self) -> tuple[str, str]:
        """Poll the bridge until the login reached a final phase (with devices)."""
        assert self._client
        phase, message = "connecting", ""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + LOGIN_TIMEOUT_SECONDS
        while loop.time() < deadline:
            state = await self._client.state()
            phase, message = state.get("phase", ""), state.get("message", "")
            # After "ok" the device list arrives a moment later.
            if phase in FINAL_PHASES and not (phase == "ok" and not state.get("stations")):
                return phase, message
            await asyncio.sleep(LOGIN_POLL_SECONDS)
        return phase, message

    async def _continue_login(self) -> ConfigFlowResult:
        try:
            phase, message = await self._wait_for_login()
        except BridgeError:
            return self.async_abort(reason="cannot_connect")
        if phase == "tfa":
            return await self.async_step_code()
        if phase == "captcha":
            return await self.async_step_captcha()
        if phase == "ok":
            return await self._create_entry()
        _LOGGER.warning("Eufy login failed (%s): %s", phase, message)
        return self._show_login({"base": "login_failed"}, message)

    async def _create_entry(self) -> ConfigFlowResult:
        assert self._client
        stations = (await self._client.state()).get("stations", {})
        if not stations:
            return self.async_abort(reason="no_station")
        station_sn, station = next(iter(stations.items()))
        await self.async_set_unique_id(station_sn)
        self._abort_if_unique_id_configured(updates=self._data)
        return self.async_create_entry(title=station.get("name") or "HomeBase", data=self._data)

    # ------------------------------------------------------------------ steps
    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            client = self._make_client(user_input)
            try:
                await client.health()
                state = await client.state()
            except BridgeAuthError:
                errors["base"] = "invalid_token"
            except BridgeError:
                errors["base"] = "cannot_connect"
            else:
                self._client = client
                self._data = {
                    CONF_HOST: user_input[CONF_HOST],
                    CONF_PORT: user_input[CONF_PORT],
                    CONF_TOKEN: user_input.get(CONF_TOKEN, ""),
                }
                phase = state.get("phase")
                if phase == "ok" and state.get("stations"):
                    return await self._create_entry()
                if phase in ("connecting", "tfa", "captcha"):
                    return await self._continue_login()
                return self._show_login()

        defaults = user_input or {}
        schema = vol.Schema(
            {
                vol.Required(CONF_HOST, default=defaults.get(CONF_HOST, "")): str,
                vol.Required(CONF_PORT, default=defaults.get(CONF_PORT, DEFAULT_PORT)): int,
                vol.Optional(CONF_TOKEN, default=defaults.get(CONF_TOKEN, "")): str,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    def _show_login(
        self, errors: dict[str, str] | None = None, message: str = ""
    ) -> ConfigFlowResult:
        schema = vol.Schema(
            {
                vol.Required(CONF_EMAIL): str,
                vol.Required(CONF_PASSWORD): str,
                vol.Required(CONF_COUNTRY, default="DE"): str,
            }
        )
        return self.async_show_form(
            step_id="login",
            data_schema=schema,
            errors=errors or {},
            description_placeholders={"message": message or "-"},
        )

    async def async_step_login(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is None:
            return self._show_login()
        assert self._client
        try:
            await self._client.login(
                user_input[CONF_EMAIL],
                user_input[CONF_PASSWORD],
                user_input[CONF_COUNTRY].strip().upper(),
            )
        except BridgeError:
            return self._show_login({"base": "cannot_connect"})
        return await self._continue_login()

    async def _submit_code(self, step_id: str, user_input: dict[str, Any] | None) -> ConfigFlowResult:
        assert self._client
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                await self._client.submit_code(user_input[CONF_CODE].strip())
            except BridgeError:
                errors["base"] = "cannot_connect"
            else:
                return await self._continue_login()
        placeholders = {"captcha_url": self._client.captcha_url()} if step_id == "captcha" else None
        return self.async_show_form(
            step_id=step_id,
            data_schema=vol.Schema({vol.Required(CONF_CODE): str}),
            errors=errors,
            description_placeholders=placeholders,
        )

    async def async_step_code(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return await self._submit_code("code", user_input)

    async def async_step_captcha(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return await self._submit_code("captcha", user_input)

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        """The bridge rejected the token (e.g. BRIDGE_TOKEN was changed)."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        entry = self._get_reauth_entry()
        if user_input is not None:
            data = {**entry.data, CONF_TOKEN: user_input[CONF_TOKEN]}
            try:
                await self._make_client(data).state()
            except BridgeAuthError:
                errors["base"] = "invalid_token"
            except BridgeError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_update_reload_and_abort(entry, data=data)
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema({vol.Required(CONF_TOKEN): str}),
            errors=errors,
        )
