"""The camera's built-in spotlight; switched over P2P (ADR 0012)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.light import ATTR_BRIGHTNESS, ColorMode, LightEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import EufyCameraEntity

# The camera takes 40..100 %; Home Assistant uses 1..255.
MIN_PERCENT = 40


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyLocalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    async_add_entities(
        EufySpotlight(coordinator, sn)
        for sn, cam in coordinator.cameras.items()
        if "light" in (cam.get("properties") or {})
    )


class EufySpotlight(EufyCameraEntity, LightEntity):
    """Spotlight of a eufyCam."""

    _attr_translation_key = "spotlight"

    def __init__(self, coordinator: EufyLocalCoordinator, device_sn: str) -> None:
        super().__init__(coordinator, device_sn, "spotlight")
        dimmable = "lightSettingsBrightnessManual" in self.props
        self._attr_color_mode = ColorMode.BRIGHTNESS if dimmable else ColorMode.ONOFF
        self._attr_supported_color_modes = {self._attr_color_mode}

    @property
    def is_on(self) -> bool | None:
        value = self.props.get("light")
        return None if value is None else bool(value)

    @property
    def brightness(self) -> int | None:
        percent = self.props.get("lightSettingsBrightnessManual")
        return None if percent is None else round(percent * 255 / 100)

    async def async_turn_on(self, **kwargs: Any) -> None:
        if ATTR_BRIGHTNESS in kwargs and self._attr_color_mode is ColorMode.BRIGHTNESS:
            percent = max(MIN_PERCENT, round(kwargs[ATTR_BRIGHTNESS] * 100 / 255))
            await self._set("lightSettingsBrightnessManual", percent)
        await self._set("light", True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._set("light", False)
