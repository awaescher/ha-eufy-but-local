"""Camera and HomeBase settings, siren, restart and snooze, all written through the bridge."""

from __future__ import annotations

from datetime import timedelta

from homeassistant.components.button import DOMAIN as BUTTON_DOMAIN, SERVICE_PRESS
from homeassistant.components.light import ATTR_BRIGHTNESS, DOMAIN as LIGHT_DOMAIN
from homeassistant.components.number import (
    ATTR_VALUE,
    DOMAIN as NUMBER_DOMAIN,
    SERVICE_SET_VALUE,
)
from homeassistant.components.select import (
    ATTR_OPTION,
    DOMAIN as SELECT_DOMAIN,
    SERVICE_SELECT_OPTION,
)
from homeassistant.components.siren import ATTR_DURATION, DOMAIN as SIREN_DOMAIN
from homeassistant.components.switch import DOMAIN as SWITCH_DOMAIN
from homeassistant.const import (
    ATTR_ENTITY_ID,
    SERVICE_TURN_OFF,
    SERVICE_TURN_ON,
    STATE_OFF,
    STATE_ON,
)
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
import pytest

from custom_components.eufy_local.const import DOMAIN

from .conftest import CAM, STATION, FakeBridge, wait_for

pytestmark = pytest.mark.usefixtures("setup_integration")


async def call(hass: HomeAssistant, domain: str, service: str, entity_id: str, **data) -> None:
    await hass.services.async_call(
        domain, service, {ATTR_ENTITY_ID: entity_id, **data}, blocking=True
    )


async def test_switch_writes_setting(hass: HomeAssistant, bridge: FakeBridge) -> None:
    entity = "switch.front_door_status_led"
    assert hass.states.get(entity).state == STATE_OFF
    await call(hass, SWITCH_DOMAIN, SERVICE_TURN_ON, entity)
    assert bridge.property_writes == [("device", CAM, "statusLed", True)]
    await wait_for(lambda: hass.states.get(entity).state == STATE_ON)


async def test_select_maps_options_to_values(hass: HomeAssistant, bridge: FakeBridge) -> None:
    entity = "select.front_door_night_vision"
    assert hass.states.get(entity).state == "infrared"
    await call(hass, SELECT_DOMAIN, SERVICE_SELECT_OPTION, entity, **{ATTR_OPTION: "color"})
    assert bridge.property_writes == [("device", CAM, "nightvision", 2)]
    await wait_for(lambda: hass.states.get(entity).state == "color")


async def test_number_writes_whole_values(hass: HomeAssistant, bridge: FakeBridge) -> None:
    await call(
        hass, NUMBER_DOMAIN, SERVICE_SET_VALUE, "number.homebase_2_alarm_volume", **{ATTR_VALUE: 12}
    )
    assert bridge.property_writes == [("station", STATION, "alarmVolume", 12)]


async def test_spotlight_brightness(hass: HomeAssistant, bridge: FakeBridge) -> None:
    entity = "light.front_door_spotlight"
    assert hass.states.get(entity).state == STATE_OFF
    # 10 % is below the camera's minimum of 40 %.
    await call(hass, LIGHT_DOMAIN, SERVICE_TURN_ON, entity, **{ATTR_BRIGHTNESS: 25})
    assert bridge.property_writes == [
        ("device", CAM, "lightSettingsBrightnessManual", 40),
        ("device", CAM, "light", True),
    ]
    await wait_for(lambda: hass.states.get(entity).state == STATE_ON)
    assert hass.states.get(entity).attributes[ATTR_BRIGHTNESS] == 102
    await call(hass, LIGHT_DOMAIN, SERVICE_TURN_OFF, entity)
    assert bridge.property_writes[-1] == ("device", CAM, "light", False)


async def test_sirens_and_restart(hass: HomeAssistant, bridge: FakeBridge) -> None:
    await call(hass, SIREN_DOMAIN, SERVICE_TURN_ON, "siren.front_door_siren", **{ATTR_DURATION: 5})
    await call(hass, SIREN_DOMAIN, SERVICE_TURN_OFF, "siren.front_door_siren")
    await call(hass, SIREN_DOMAIN, SERVICE_TURN_ON, "siren.homebase_2_siren")
    await call(hass, BUTTON_DOMAIN, SERVICE_PRESS, "button.homebase_2_restart")
    assert bridge.commands == [
        ("device", CAM, {"name": "alarm", "seconds": 5}),
        ("device", CAM, {"name": "stopAlarm"}),
        ("station", STATION, {"name": "alarm", "seconds": 10}),
        ("station", STATION, {"name": "reboot"}),
    ]


async def test_snooze_action(hass: HomeAssistant, bridge: FakeBridge) -> None:
    await hass.services.async_call(
        DOMAIN,
        "snooze",
        {ATTR_ENTITY_ID: "camera.front_door", "duration": timedelta(minutes=30)},
        blocking=True,
    )
    assert bridge.commands == [("device", CAM, {"name": "snooze", "seconds": 1800})]


async def test_station_alarm_and_diagnostics(hass: HomeAssistant, bridge: FakeBridge) -> None:
    assert hass.states.get("sensor.front_door_wi_fi_signal").state == "-64"
    assert hass.states.get("sensor.front_door_charging").state == "not_charging"
    assert hass.states.get("sensor.homebase_2_firmware").state == "3.2.4.6"
    assert hass.states.get("binary_sensor.homebase_2_alarm").state == STATE_OFF
    bridge.state["stations"][STATION]["properties"]["alarm"] = True
    bridge.push_state()
    await wait_for(lambda: hass.states.get("binary_sensor.homebase_2_alarm").state == STATE_ON)
    assert hass.states.get("siren.homebase_2_siren").state == STATE_ON


async def test_failed_write_raises(hass: HomeAssistant, bridge: FakeBridge) -> None:
    await bridge.close()
    with pytest.raises(HomeAssistantError, match="Could not set statusLed"):
        await call(hass, SWITCH_DOMAIN, SERVICE_TURN_ON, "switch.front_door_status_led")
