"""Shared fixtures: a fake eufy-local-bridge served over real HTTP."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
import copy
import json
from typing import Any

from aiohttp import web
from aiohttp.test_utils import TestServer
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.eufy_local import config_flow
from custom_components.eufy_local.const import CONF_TOKEN, DOMAIN

TOKEN = "secret-token"
STATION = "T8010TEST0000001"
CAM = "T8113TEST0000001"
JPEG = b"\xff\xd8\xff\xe0fake-jpeg\xff\xd9"

LOGGED_IN_STATE: dict[str, Any] = {
    "version": "test",
    "phase": "ok",
    "message": "Logged in",
    "cloud": True,
    "stations": {
        STATION: {
            "name": "HomeBase 2",
            "model": "T8010",
            "p2p": True,
            "guardMode": 1,
            "guardModeName": "HOME",
        }
    },
    "cameras": {
        CAM: {
            "name": "Front door",
            "model": "T8113",
            "station": STATION,
            "battery": 87,
            "count": 120,
            "lastEventAt": None,
            "imageAt": "2026-10-13T08:00:00.000Z",
            "live": False,
            "codec": None,
            "personAt": None,
            "motionAt": None,
        }
    },
}


class FakeBridge:
    """In-memory stand-in for the Node bridge with the same HTTP contract."""

    def __init__(self, token: str = TOKEN) -> None:
        self.token = token
        self.state: dict[str, Any] = copy.deepcopy(LOGGED_IN_STATE)
        # Result of POST /api/login: "ok", "ok_without_devices", "tfa", "captcha",
        # "connecting" (never finishes) or "error".
        self.login_result = "ok"
        self.tfa_code = "123456"
        self.logins: list[dict[str, Any]] = []
        self.codes: list[str] = []
        self.guard_requests: list[tuple[str, str]] = []
        self.images: dict[str, bytes] = {CAM: JPEG}
        self.image_requests = 0
        self.reject_guard = False
        self._queues: set[asyncio.Queue] = set()
        self.server: TestServer | None = None

    # ---------------------------------------------------------------- control
    @property
    def port(self) -> int:
        assert self.server
        return self.server.port

    def logged_out(self) -> None:
        self.state.update(phase="idle", message="", stations={}, cameras={})

    def push_state(self) -> None:
        self._push("state", self.state)

    def push_event(self, event: dict[str, Any]) -> None:
        self._push("event", event)

    def _push(self, name: str, data: Any) -> None:
        frame = f"event: {name}\ndata: {json.dumps(data)}\n\n"
        for queue in self._queues:
            queue.put_nowait(frame)

    @property
    def sse_clients(self) -> int:
        return len(self._queues)

    # ---------------------------------------------------------------- server
    def _authorized(self, request: web.Request) -> bool:
        if not self.token:
            return True
        header = request.headers.get("Authorization", "")
        return header == f"Bearer {self.token}" or request.query.get("token") == self.token

    @web.middleware
    async def _auth(self, request: web.Request, handler):
        if request.path != "/api/health" and not self._authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        return await handler(request)

    async def _health(self, request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "version": "test", "phase": self.state["phase"]})

    async def _state(self, request: web.Request) -> web.Response:
        return web.json_response(self.state)

    async def _events(self, request: web.Request) -> web.StreamResponse:
        resp = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await resp.prepare(request)
        queue: asyncio.Queue = asyncio.Queue()
        self._queues.add(queue)
        try:
            await resp.write(f"event: state\ndata: {json.dumps(self.state)}\n\n".encode())
            await resp.write(b": ping\n\n")
            while request.transport is not None and not request.transport.is_closing():
                try:
                    frame = await asyncio.wait_for(queue.get(), 0.1)
                except TimeoutError:
                    continue
                if frame is None:
                    break
                await resp.write(frame.encode())
        except ConnectionResetError, asyncio.CancelledError:
            pass
        finally:
            self._queues.discard(queue)
        return resp

    async def _login(self, request: web.Request) -> web.Response:
        body = await request.json()
        self.logins.append(body)
        if self.login_result == "ok":
            self.state = copy.deepcopy(LOGGED_IN_STATE)
        elif self.login_result == "ok_without_devices":
            self.state.update(phase="ok", message="Logged in", stations={}, cameras={})
        else:
            self.state.update(phase=self.login_result, message=f"login {self.login_result}")
        return web.json_response({"ok": True}, status=202)

    async def _code(self, request: web.Request) -> web.Response:
        code = (await request.json())["code"]
        self.codes.append(code)
        if code == self.tfa_code:
            self.state = copy.deepcopy(LOGGED_IN_STATE)
        else:
            self.state.update(phase="error", message="wrong code")
        return web.json_response({"ok": True}, status=202)

    async def _image(self, request: web.Request) -> web.Response:
        self.image_requests += 1
        data = self.images.get(request.match_info["sn"])
        if data is None:
            return web.json_response({"error": "no image"}, status=404)
        return web.Response(body=data, content_type="image/jpeg")

    async def _guard(self, request: web.Request) -> web.Response:
        if self.reject_guard:
            return web.json_response({"error": "station busy"}, status=500)
        sn = request.match_info["sn"]
        mode = (await request.json())["mode"]
        self.guard_requests.append((sn, mode))
        self.state["stations"][sn]["guardModeName"] = mode
        self.push_state()
        return web.json_response({"ok": True}, status=202)

    async def start(self, port: int | None = None) -> None:
        app = web.Application(middlewares=[self._auth])
        app.router.add_get("/api/health", self._health)
        app.router.add_get("/api/state", self._state)
        app.router.add_get("/api/events", self._events)
        app.router.add_post("/api/login", self._login)
        app.router.add_post("/api/code", self._code)
        app.router.add_get("/api/image/{sn}", self._image)
        app.router.add_post("/api/station/{sn}/guard", self._guard)
        self.server = TestServer(app, host="127.0.0.1", port=port)
        await self.server.start_server()

    async def close(self) -> None:
        for queue in self._queues:
            queue.put_nowait(None)
        if self.server:
            await self.server.close()


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Allow loading custom_components in every test."""


@pytest.fixture(autouse=True)
def fast_login_polling(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config_flow, "LOGIN_POLL_SECONDS", 0.01)
    monkeypatch.setattr(config_flow, "LOGIN_TIMEOUT_SECONDS", 1)


@pytest.fixture
async def bridge(socket_enabled: None) -> AsyncGenerator[FakeBridge]:
    """A fake bridge on 127.0.0.1 (the HA test harness blocks sockets by default)."""
    fake = FakeBridge()
    await fake.start()
    yield fake
    await fake.close()


@pytest.fixture
def entry(bridge: FakeBridge) -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN,
        title="HomeBase 2",
        unique_id=STATION,
        data={CONF_HOST: "127.0.0.1", CONF_PORT: bridge.port, CONF_TOKEN: TOKEN},
    )


@pytest.fixture
async def setup_integration(
    hass: HomeAssistant, entry: MockConfigEntry, bridge: FakeBridge
) -> AsyncGenerator[MockConfigEntry]:
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    await wait_for(lambda: bridge.sse_clients == 1)
    yield entry
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()


async def wait_for(condition, timeout: float = 3.0) -> None:
    """Wait until `condition()` is true (for effects that cross real sockets).

    Hangs under the `freezer` fixture: it freezes the loop clock, so asyncio.sleep() never ends.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not condition():
        if loop.time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.02)
