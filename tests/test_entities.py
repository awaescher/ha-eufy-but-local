"""Entity behaviour: states, events, services, images and streams."""

from __future__ import annotations

from datetime import timedelta
from http import HTTPStatus
from unittest.mock import patch

from homeassistant.components.alarm_control_panel import (
    DOMAIN as ALARM_DOMAIN,
    AlarmControlPanelState,
)
from homeassistant.components.camera import async_get_image, async_get_stream_source
from homeassistant.components.select import (
    ATTR_OPTION,
    DOMAIN as SELECT_DOMAIN,
    SERVICE_SELECT_OPTION,
)
from homeassistant.const import (
    ATTR_ENTITY_ID,
    SERVICE_ALARM_ARM_AWAY,
    SERVICE_ALARM_ARM_HOME,
    SERVICE_ALARM_DISARM,
    STATE_OFF,
    STATE_ON,
    STATE_UNKNOWN,
)
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.util import dt as dt_util
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator

from custom_components.eufy_but_local.camera import h264_to_jpeg
from custom_components.eufy_but_local.const import EVENT_ACTIVE_SECONDS

from .conftest import CAM, JPEG, STATION, TOKEN, FakeBridge, stream_token, wait_for

CAMERA = "camera.front_door"
ACTIVITY = "binary_sensor.front_door_event_local"
EVENT = "event.front_door_activity"
LAST_EVENT = "sensor.front_door_last_event"
COUNT = "sensor.front_door_stored_events"
BATTERY = "sensor.front_door_battery"
IMAGE = "image.front_door_last_event_image"
P2P = "binary_sensor.homebase_2_local_p2p_connection"
ALARM = "alarm_control_panel.homebase_2"
GUARD_SELECT = "select.homebase_2_guard_mode"

pytestmark = pytest.mark.usefixtures("setup_integration")


async def test_initial_states(hass: HomeAssistant) -> None:
    assert hass.states.get(BATTERY).state == "87"
    assert hass.states.get(COUNT).state == "120"
    assert hass.states.get(LAST_EVENT).state == STATE_UNKNOWN
    assert hass.states.get(ACTIVITY).state == STATE_OFF
    assert hass.states.get(P2P).state == STATE_ON
    assert hass.states.get(P2P).attributes["cloud_connected"] is True
    assert hass.states.get(ALARM).state == AlarmControlPanelState.ARMED_HOME
    assert hass.states.get(EVENT).state == STATE_UNKNOWN


async def test_local_recording(hass: HomeAssistant, bridge: FakeBridge) -> None:
    # Real time instead of `freezer`: a frozen clock also stops asyncio.sleep() in wait_for().
    # The event lies just inside the active window, so the expiry is observable quickly.
    last = dt_util.utcnow() - timedelta(seconds=EVENT_ACTIVE_SECONDS - 1)
    bridge.state["cameras"][CAM].update(count=121, lastEventAt=last.isoformat())
    bridge.push_state()
    bridge.push_event({"type": "local_recording", "device_sn": CAM, "count": 121})
    await wait_for(lambda: hass.states.get(EVENT).state != STATE_UNKNOWN)
    await hass.async_block_till_done()

    assert hass.states.get(ACTIVITY).state == STATE_ON
    assert hass.states.get(COUNT).state == "121"
    # Timestamp sensor states are formatted to whole seconds.
    assert dt_util.parse_datetime(hass.states.get(LAST_EVENT).state) == last.replace(microsecond=0)
    event = hass.states.get(EVENT)
    assert event.attributes["event_type"] == "local_recording"
    assert event.attributes["source"] == "local"

    # The activity sensor turns off by itself after the active window.
    await wait_for(lambda: hass.states.get(ACTIVITY).state == STATE_OFF)


async def test_cloud_push_event(hass: HomeAssistant, bridge: FakeBridge) -> None:
    bridge.push_event({"type": "person", "device_sn": "OTHER", "source": "cloud"})
    bridge.push_event({"type": "unknown", "device_sn": CAM})
    bridge.push_event({"type": "person", "device_sn": CAM, "source": "cloud"})
    await wait_for(lambda: hass.states.get(EVENT).state != STATE_UNKNOWN)
    attrs = hass.states.get(EVENT).attributes
    assert attrs["event_type"] == "person"
    assert attrs["source"] == "cloud"


async def test_p2p_connection_lost(hass: HomeAssistant, bridge: FakeBridge) -> None:
    bridge.state["stations"][STATION]["p2p"] = False
    bridge.push_state()
    await wait_for(lambda: hass.states.get(P2P).state == STATE_OFF)
    # Without a local link there is no stream to offer.
    assert await async_get_stream_source(hass, CAMERA) is None


@pytest.mark.parametrize(
    ("service", "mode", "expected"),
    [
        (SERVICE_ALARM_ARM_AWAY, "AWAY", AlarmControlPanelState.ARMED_AWAY),
        (SERVICE_ALARM_ARM_HOME, "HOME", AlarmControlPanelState.ARMED_HOME),
        (SERVICE_ALARM_DISARM, "DISARMED", AlarmControlPanelState.DISARMED),
    ],
)
async def test_guard_mode_services(
    hass: HomeAssistant, bridge: FakeBridge, service: str, mode: str, expected: str
) -> None:
    await hass.services.async_call(ALARM_DOMAIN, service, {ATTR_ENTITY_ID: ALARM}, blocking=True)
    assert bridge.guard_requests == [(STATION, mode)]
    await wait_for(lambda: hass.states.get(ALARM).state == expected)
    assert hass.states.get(ALARM).attributes["eufy_mode"] == mode


async def test_guard_mode_failure(hass: HomeAssistant, bridge: FakeBridge) -> None:
    bridge.reject_guard = True
    with pytest.raises(HomeAssistantError, match="Could not set guard mode"):
        await hass.services.async_call(
            ALARM_DOMAIN, SERVICE_ALARM_ARM_AWAY, {ATTR_ENTITY_ID: ALARM}, blocking=True
        )


async def test_schedule_guard_mode(hass: HomeAssistant, bridge: FakeBridge) -> None:
    bridge.state["stations"][STATION]["guardModeName"] = "SCHEDULE"
    bridge.push_state()
    bypass = AlarmControlPanelState.ARMED_CUSTOM_BYPASS
    await wait_for(lambda: hass.states.get(ALARM).state == bypass)
    assert hass.states.get(ALARM).attributes["eufy_mode"] == "SCHEDULE"


async def test_unmapped_guard_mode(hass: HomeAssistant, bridge: FakeBridge) -> None:
    bridge.state["stations"][STATION]["guardModeName"] = "SOMETHING_NEW"
    bridge.push_state()
    await wait_for(lambda: hass.states.get(ALARM).state == STATE_UNKNOWN)
    assert hass.states.get(ALARM).attributes["eufy_mode"] == "SOMETHING_NEW"


async def test_camera_image_is_cached_until_a_new_thumbnail(
    hass: HomeAssistant, bridge: FakeBridge, setup_integration: MockConfigEntry
) -> None:
    image = await async_get_image(hass, CAMERA)
    assert image.content == JPEG
    requests = bridge.image_requests
    await async_get_image(hass, CAMERA)
    assert bridge.image_requests == requests  # unchanged imageAt -> cached

    bridge.images[CAM] = JPEG + b"new"
    bridge.state["cameras"][CAM]["imageAt"] = "2026-10-13T09:00:00.000Z"
    bridge.push_state()
    coordinator = setup_integration.runtime_data
    await wait_for(lambda: coordinator.cameras[CAM]["imageAt"] == "2026-10-13T09:00:00.000Z")
    image = await async_get_image(hass, CAMERA)
    assert image.content == JPEG + b"new"


async def test_camera_image_prefers_a_newer_live_frame(
    hass: HomeAssistant,
    bridge: FakeBridge,
    setup_integration: MockConfigEntry,
    caplog: pytest.LogCaptureFixture,
) -> None:
    coordinator = setup_integration.runtime_data
    frame_jpeg = b"\xff\xd8live-frame\xff\xd9"
    bridge.frames[CAM] = b"\x00\x00\x00\x01h264"

    async def push_frame(at: str) -> None:
        bridge.state["cameras"][CAM]["frameAt"] = at
        bridge.push_state()
        await wait_for(lambda: coordinator.cameras[CAM]["frameAt"] == at)

    with patch(
        "custom_components.eufy_but_local.camera.h264_to_jpeg", return_value=(frame_jpeg, "")
    ) as decode:
        # Older than the event thumbnail: the thumbnail wins, no decoding needed.
        await push_frame("2026-10-13T07:00:00.000Z")
        assert (await async_get_image(hass, CAMERA)).content == JPEG
        decode.assert_not_called()

        await push_frame("2026-10-13T09:30:00.000Z")
        assert (await async_get_image(hass, CAMERA)).content == frame_jpeg
        await async_get_image(hass, CAMERA)
        decode.assert_called_once()  # cached until the next frame
        assert decode.call_args.args[1] == bridge.frames[CAM]

        # Decoding fails: the event thumbnail, a warning, and no second attempt for this frame.
        decode.return_value = (None, "Invalid data found")
        await push_frame("2026-10-13T09:40:00.000Z")
        assert (await async_get_image(hass, CAMERA)).content == JPEG
        assert (await async_get_image(hass, CAMERA)).content == JPEG
        assert decode.call_count == 2
        assert "could not decode the last live frame (Invalid data found)" in caplog.text


async def test_h264_to_jpeg(tmp_path) -> None:
    def script(name: str, body: str) -> str:
        path = tmp_path / name
        path.write_text(f"#!/bin/sh\n{body}\n")
        path.chmod(0o755)
        return str(path)

    ok = script("ok", "cat >/dev/null; printf JPEG")
    assert await h264_to_jpeg(ok, b"frame") == (b"JPEG", "")
    failing = script("failing", "cat >/dev/null; echo 'Invalid data found' >&2; exit 1")
    assert await h264_to_jpeg(failing, b"frame") == (None, "Invalid data found")
    image, reason = await h264_to_jpeg(str(tmp_path / "missing"), b"frame")
    assert image is None and "No such file" in reason
    slow = script("slow", "sleep 5")
    with patch("custom_components.eufy_but_local.camera.FRAME_TIMEOUT", 0.2):
        assert await h264_to_jpeg(slow, b"frame") == (None, "no picture within 0.2 s")


async def test_stream_source_carries_only_the_watch_token(
    hass: HomeAssistant, bridge: FakeBridge
) -> None:
    source = await async_get_stream_source(hass, CAMERA)
    assert (
        source == f"http://127.0.0.1:{bridge.port}/api/stream/{CAM}.flv?token={stream_token(TOKEN)}"
    )
    assert TOKEN not in source


async def test_streaming_state(hass: HomeAssistant, bridge: FakeBridge) -> None:
    bridge.state["cameras"][CAM].update(live=True, codec="h264")
    bridge.push_state()
    await wait_for(lambda: hass.states.get(CAMERA).state == "streaming")
    assert hass.states.get(CAMERA).attributes["codec"] == "h264"


async def test_image_entity(
    hass: HomeAssistant, hass_client: ClientSessionGenerator, setup_integration: MockConfigEntry
) -> None:
    state = hass.states.get(IMAGE)
    assert dt_util.parse_datetime(state.state) == dt_util.parse_datetime("2026-10-13T08:00:00Z")
    client = await hass_client()
    resp = await client.get(f"/api/image_proxy/{IMAGE}")
    assert resp.status == HTTPStatus.OK
    assert await resp.read() == JPEG


async def test_missing_thumbnail(hass: HomeAssistant, bridge: FakeBridge) -> None:
    bridge.images.clear()
    bridge.state["cameras"][CAM]["imageAt"] = None
    bridge.push_state()
    await wait_for(lambda: hass.states.get(IMAGE).state == STATE_UNKNOWN)


async def test_guard_mode_select_shows_eufy_modes(hass: HomeAssistant, bridge: FakeBridge) -> None:
    assert hass.states.get(GUARD_SELECT).state == "home"
    assert "schedule" in hass.states.get(GUARD_SELECT).attributes["options"]
    bridge.state["stations"][STATION]["guardModeName"] = "SCHEDULE"
    bridge.push_state()
    await wait_for(lambda: hass.states.get(GUARD_SELECT).state == "schedule")


async def test_guard_mode_select_sets_mode(hass: HomeAssistant, bridge: FakeBridge) -> None:
    await hass.services.async_call(
        SELECT_DOMAIN,
        SERVICE_SELECT_OPTION,
        {ATTR_ENTITY_ID: GUARD_SELECT, ATTR_OPTION: "geofencing"},
        blocking=True,
    )
    assert bridge.guard_requests == [(STATION, "GEO")]
    await wait_for(lambda: hass.states.get(GUARD_SELECT).state == "geofencing")


async def test_guard_mode_select_failure(hass: HomeAssistant, bridge: FakeBridge) -> None:
    bridge.reject_guard = True
    with pytest.raises(HomeAssistantError, match="Could not set guard mode"):
        await hass.services.async_call(
            SELECT_DOMAIN,
            SERVICE_SELECT_OPTION,
            {ATTR_ENTITY_ID: GUARD_SELECT, ATTR_OPTION: "away"},
            blocking=True,
        )
