"""Switches for camera settings; written to the HomeBase over P2P (ADR 0012)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity, SwitchEntityDescription
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import EufyLocalConfigEntry, EufyLocalCoordinator
from .entity import EufyCameraEntity

CAMERA_SWITCHES: tuple[SwitchEntityDescription, ...] = (
    SwitchEntityDescription(key="enabled", translation_key="enabled"),
    SwitchEntityDescription(
        key="motionDetection",
        translation_key="motion_detection",
        entity_category=EntityCategory.CONFIG,
    ),
    SwitchEntityDescription(
        key="statusLed", translation_key="status_led", entity_category=EntityCategory.CONFIG
    ),
    SwitchEntityDescription(
        key="microphone", translation_key="microphone", entity_category=EntityCategory.CONFIG
    ),
    SwitchEntityDescription(
        key="speaker", translation_key="speaker", entity_category=EntityCategory.CONFIG
    ),
    SwitchEntityDescription(
        key="audioRecording",
        translation_key="audio_recording",
        entity_category=EntityCategory.CONFIG,
    ),
    SwitchEntityDescription(
        key="antitheftDetection",
        translation_key="antitheft_detection",
        entity_category=EntityCategory.CONFIG,
    ),
    SwitchEntityDescription(
        key="recordingEndClipMotionStops",
        translation_key="end_clip_motion_stops",
        entity_category=EntityCategory.CONFIG,
        entity_registry_enabled_default=False,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyLocalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    async_add_entities(
        EufyCameraSwitch(coordinator, sn, description)
        for sn, cam in coordinator.cameras.items()
        for description in CAMERA_SWITCHES
        if description.key in (cam.get("properties") or {})
    )


class EufyCameraSwitch(EufyCameraEntity, SwitchEntity):
    """A boolean camera setting."""

    def __init__(
        self,
        coordinator: EufyLocalCoordinator,
        device_sn: str,
        description: SwitchEntityDescription,
    ) -> None:
        super().__init__(coordinator, device_sn, description.key)
        self.entity_description = description

    @property
    def is_on(self) -> bool | None:
        value = self.props.get(self.entity_description.key)
        return None if value is None else bool(value)

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._set(self.entity_description.key, True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._set(self.entity_description.key, False)
