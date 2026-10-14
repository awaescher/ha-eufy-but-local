"""BridgeClient: SSE parsing and HTTP error mapping against a raw aiohttp server."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Awaitable, Callable

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer
import pytest

from custom_components.eufy_but_local.api import BridgeAuthError, BridgeClient, BridgeError

type Handler = Callable[[web.Request], Awaitable[web.StreamResponse]]


class RawServer:
    """Serves whatever the test registers, so edge cases can be produced byte by byte."""

    def __init__(self) -> None:
        self.app = web.Application()
        self.server: TestServer | None = None
        self.headers: list[dict[str, str]] = []

    def route(self, method: str, path: str, handler: Handler) -> None:
        async def recording(request: web.Request) -> web.StreamResponse:
            self.headers.append(dict(request.headers))
            return await handler(request)

        self.app.router.add_route(method, path, recording)

    def sse(self, payload: bytes) -> None:
        async def handler(request: web.Request) -> web.StreamResponse:
            resp = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
            await resp.prepare(request)
            await resp.write(payload)
            await resp.write_eof()
            return resp

        self.route("GET", "/api/events", handler)

    def status(self, method: str, path: str, status: int, body: str = "") -> None:
        async def handler(request: web.Request) -> web.Response:
            return web.Response(status=status, text=body)

        self.route(method, path, handler)

    async def start(self) -> None:
        self.server = TestServer(self.app, host="127.0.0.1")
        await self.server.start_server()

    @property
    def port(self) -> int:
        assert self.server
        return self.server.port


@pytest.fixture
async def session() -> AsyncGenerator[aiohttp.ClientSession]:
    async with aiohttp.ClientSession() as session:
        yield session


@pytest.fixture
def raw(socket_enabled: None) -> RawServer:
    return RawServer()


@pytest.fixture
async def client(
    raw: RawServer, session: aiohttp.ClientSession
) -> AsyncGenerator[Callable[[], Awaitable[BridgeClient]]]:
    """Start the raw server only after the test registered its routes."""

    async def make(token: str | None = "tok") -> BridgeClient:
        await raw.start()
        return BridgeClient(session, "127.0.0.1", raw.port, token)

    yield make
    if raw.server:
        await raw.server.close()


async def collect(client: BridgeClient) -> list[tuple[str, object]]:
    return [item async for item in client.events()]


async def test_sse_frames(raw: RawServer, client) -> None:
    raw.sse(
        b": keep-alive comment\n\n"
        b"event: state\n"
        b'data: {"phase": "ok"}\n\n'
        b'data: {"no_event_name": true}\n\n'
        b"event: event\r\n"
        b'data: {"type": "local_recording",\r\n'
        b'data:  "count": 2}\r\n\r\n'
        b"event: event\n"
        b"data: {not json\n\n"
        b"event: event\n"
        b'data:{"type": "image"}\n\n'
        b"event: ignored-without-data\n\n"
        b'data: {"trailing": "frame without blank line"}\n'
    )
    # Malformed JSON is dropped; an unterminated frame at the end is discarded (SSE spec).
    assert await collect(await client()) == [
        ("state", {"phase": "ok"}),
        ("message", {"no_event_name": True}),
        ("event", {"type": "local_recording", "count": 2}),
        ("event", {"type": "image"}),
    ]


async def test_sse_event_name_resets_after_each_frame(raw: RawServer, client) -> None:
    raw.sse(b"event: event\ndata: {not json\n\ndata: 1\n\n")
    assert await collect(await client()) == [("message", 1)]


async def test_sse_sends_token(raw: RawServer, client) -> None:
    raw.sse(b"data: 1\n\n")
    await collect(await client("tok"))
    assert raw.headers[0]["Authorization"] == "Bearer tok"


async def test_sse_without_token_sends_no_header(raw: RawServer, client) -> None:
    raw.sse(b"data: 1\n\n")
    await collect(await client(None))
    assert "Authorization" not in raw.headers[0]


@pytest.mark.parametrize(("status", "error"), [(401, BridgeAuthError), (503, BridgeError)])
async def test_sse_http_errors(raw: RawServer, client, status: int, error: type[Exception]) -> None:
    raw.status("GET", "/api/events", status)
    with pytest.raises(error):
        await collect(await client())


async def test_request_401_is_auth_error(raw: RawServer, client) -> None:
    raw.status("GET", "/api/state", 401)
    with pytest.raises(BridgeAuthError):
        await (await client()).state()


async def test_request_5xx_carries_status_and_body(raw: RawServer, client) -> None:
    raw.status("POST", "/api/station/{sn}/guard", 500, "station busy")
    with pytest.raises(BridgeError, match="HTTP 500 station busy") as err:
        await (await client()).set_guard_mode("T8010SIM0000001", "AWAY")
    assert not isinstance(err.value, BridgeAuthError)


async def test_unreachable_bridge(session: aiohttp.ClientSession, socket_enabled: None) -> None:
    probe = TestServer(web.Application(), host="127.0.0.1")
    await probe.start_server()
    port = probe.port
    await probe.close()  # nothing listens on this port any more
    with pytest.raises(BridgeError):
        await BridgeClient(session, "127.0.0.1", port, None).health()


async def test_json_and_binary_bodies(raw: RawServer, client) -> None:
    async def state(request: web.Request) -> web.Response:
        return web.json_response({"phase": "ok"})

    async def image(request: web.Request) -> web.Response:
        return web.Response(body=b"\xff\xd8jpeg", content_type="image/jpeg")

    raw.route("GET", "/api/state", state)
    raw.route("GET", "/api/image/{sn}", image)
    bridge = await client()
    assert await bridge.state() == {"phase": "ok"}
    assert await bridge.image("T8113SIM0000001") == b"\xff\xd8jpeg"


async def test_missing_image_is_none_but_auth_errors_propagate(raw: RawServer, client) -> None:
    raw.status("GET", "/api/image/missing", 404)
    raw.status("GET", "/api/image/forbidden", 401)
    bridge = await client()
    assert await bridge.image("missing") is None
    with pytest.raises(BridgeAuthError):
        await bridge.image("forbidden")


async def test_urls(session: aiohttp.ClientSession) -> None:
    with_token = BridgeClient(session, "192.168.1.10", 3080, "tok")
    without = BridgeClient(session, "192.168.1.10", 3080, None)
    # Watch-only token: HMAC-SHA256("tok", "stream"), first 32 hex digits; same as the bridge.
    assert with_token.stream_token == "259165c6bd815926492a664ac5faa34c"
    assert (
        with_token.stream_url("CAM")
        == f"http://192.168.1.10:3080/api/stream/CAM.flv?token={with_token.stream_token}"
    )
    assert without.stream_url("CAM") == "http://192.168.1.10:3080/api/stream/CAM.flv"
    assert with_token.captcha_url() == "http://192.168.1.10:3080/api/captcha?token=tok"


async def test_set_config_posts_cloud_push(raw: RawServer, client) -> None:
    bodies = []

    async def config(request: web.Request) -> web.Response:
        bodies.append(await request.json())
        return web.json_response({"cloudPush": True})

    raw.route("POST", "/api/config", config)
    await (await client()).set_config(cloud_push=True)
    assert bodies == [{"cloudPush": True}]
