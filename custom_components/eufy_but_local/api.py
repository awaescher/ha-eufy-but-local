"""Client for the eufy-but-local bridge HTTP API."""

from __future__ import annotations

from collections.abc import AsyncIterator
import json
import logging
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)


class BridgeError(Exception):
    """The bridge is unreachable or returned an error."""


class BridgeAuthError(BridgeError):
    """The bridge rejected the token."""


class BridgeClient:
    """REST and Server-Sent Events access to the bridge."""

    def __init__(
        self, session: aiohttp.ClientSession, host: str, port: int, token: str | None
    ) -> None:
        self._session = session
        self.host = host
        self.port = port
        self._token = token or ""

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"} if self._token else {}

    def url(self, path: str, with_token: bool = False) -> str:
        """Build a URL; the token goes into the query for consumers without headers."""
        url = f"{self.base_url}{path}"
        if with_token and self._token:
            url += f"?token={self._token}"
        return url

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        timeout: float = 10,
    ) -> Any:
        try:
            async with self._session.request(
                method,
                f"{self.base_url}{path}",
                json=payload,
                headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as resp:
                if resp.status == 401:
                    raise BridgeAuthError("token rejected")
                if resp.status >= 400:
                    text = await resp.text()
                    raise BridgeError(f"{method} {path}: HTTP {resp.status} {text[:200]}")
                if resp.content_type == "application/json":
                    return await resp.json()
                return await resp.read()
        except (aiohttp.ClientError, TimeoutError) as err:
            raise BridgeError(f"{method} {path}: {err}") from err

    async def health(self) -> dict[str, Any]:
        return await self._request("GET", "/api/health")

    async def state(self) -> dict[str, Any]:
        return await self._request("GET", "/api/state")

    async def login(self, email: str, password: str, country: str) -> None:
        await self._request(
            "POST",
            "/api/login",
            {"email": email, "password": password, "country": country},
        )

    async def submit_code(self, code: str) -> None:
        await self._request("POST", "/api/code", {"code": code})

    async def set_property(self, kind: str, sn: str, name: str, value: Any) -> None:
        """Write a property of a camera (`kind` "device") or HomeBase ("station") over P2P."""
        await self._request(
            "POST", f"/api/{kind}/{sn}/property", {"name": name, "value": value}, timeout=20
        )

    async def command(self, kind: str, sn: str, name: str, seconds: int | None = None) -> None:
        """Run a P2P command: siren (`alarm`, `stopAlarm`), `snooze`, `reboot`."""
        payload: dict[str, Any] = {"name": name}
        if seconds is not None:
            payload["seconds"] = seconds
        await self._request("POST", f"/api/{kind}/{sn}/command", payload, timeout=20)

    async def set_config(self, *, cloud_push: bool) -> None:
        await self._request("POST", "/api/config", {"cloudPush": cloud_push})

    async def set_guard_mode(self, station_sn: str, mode: str) -> None:
        await self._request("POST", f"/api/station/{station_sn}/guard", {"mode": mode})

    async def image(self, device_sn: str) -> bytes | None:
        """Latest event thumbnail, or None if the bridge has none yet."""
        try:
            return await self._request("GET", f"/api/image/{device_sn}")
        except BridgeAuthError:
            raise
        except BridgeError:
            return None

    def stream_url(self, device_sn: str) -> str:
        """MPEG-TS with video and audio, timestamped by the bridge."""
        return self.url(f"/api/stream/{device_sn}.ts", with_token=True)

    def captcha_url(self) -> str:
        return self.url("/api/captcha", with_token=True)

    async def events(self) -> AsyncIterator[tuple[str, Any]]:
        """Yield (event, data) tuples from the SSE channel until it closes."""
        async with self._session.get(
            f"{self.base_url}/api/events",
            headers=self._headers(),
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=90),
        ) as resp:
            if resp.status == 401:
                raise BridgeAuthError("token rejected")
            if resp.status != 200:
                raise BridgeError(f"events: HTTP {resp.status}")
            event, data = "message", []
            async for raw in resp.content:
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if not line:
                    if data:
                        try:
                            yield event, json.loads("\n".join(data))
                        except json.JSONDecodeError:
                            _LOGGER.debug("Dropping malformed SSE frame")
                    event, data = "message", []
                elif line.startswith(":"):
                    continue  # keep-alive comment
                else:
                    key, _, value = line.partition(":")
                    value = value.removeprefix(" ")
                    if key == "event":
                        event = value
                    elif key == "data":
                        data.append(value)
