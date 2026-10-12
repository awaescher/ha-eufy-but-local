"""Constants for the Eufy HomeBase (local) integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "eufy_local"
MANUFACTURER: Final = "eufy"

CONF_TOKEN: Final = "token"
CONF_COUNTRY: Final = "country"
CONF_CODE: Final = "code"

DEFAULT_PORT: Final = 3080

# Dispatcher signal for discrete bridge events (local recording, cloud push, new image).
SIGNAL_EVENT: Final = f"{DOMAIN}_event_{{entry_id}}"

# How long the "event" binary sensor stays on after a new local recording.
EVENT_ACTIVE_SECONDS: Final = 30

EVENT_LOCAL_RECORDING: Final = "local_recording"
EVENT_PERSON: Final = "person"
EVENT_MOTION: Final = "motion"
EVENT_TYPES: Final = [EVENT_LOCAL_RECORDING, EVENT_PERSON, EVENT_MOTION]
