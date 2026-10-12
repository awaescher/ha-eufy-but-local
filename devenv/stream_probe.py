"""Feed a bridge stream URL through Home Assistant's real stream worker and report HLS segments.

Runs the same code path as HA's `stream` component (PyAV demuxing, timestamp validation,
fMP4 muxing) without a running Home Assistant. Use it against the simulator or real hardware:

    .venv/bin/python devenv/stream_probe.py "http://127.0.0.1:3080/api/stream/<sn>?token=<token>"

Pass --no-wallclock to see how the worker behaves without the option the camera entity sets.
"""

from __future__ import annotations

import argparse
import threading
from types import SimpleNamespace

from homeassistant.components.camera.prefs import DynamicStreamSettings
from homeassistant.components.stream import CONF_USE_WALLCLOCK_AS_TIMESTAMPS
from homeassistant.components.stream.core import STREAM_SETTINGS_NON_LL_HLS, KeyFrameConverter
from homeassistant.components.stream.diagnostics import Diagnostics
from homeassistant.components.stream.worker import StreamState, stream_worker


class CollectingOutput:
    """Stands in for the HLS output; stops the worker after enough segments."""

    def __init__(self, wanted: int, done: threading.Event) -> None:
        self.segments: list = []
        self._wanted = wanted
        self._done = done

    def put(self, segment) -> None:
        self.segments.append(segment)
        if len(self.segments) > self._wanted:  # the last one is still being filled
            self._done.set()

    def part_put(self) -> None:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("url")
    parser.add_argument("--segments", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--no-wallclock", action="store_true")
    args = parser.parse_args()

    done = threading.Event()
    output = CollectingOutput(args.segments, done)
    # The worker only touches the event loop to hand over parts and keyframes.
    hass = SimpleNamespace(loop=SimpleNamespace(call_soon_threadsafe=lambda f, *a: f(*a)))
    diagnostics = Diagnostics()
    state = StreamState(hass, lambda: {"hls": output}, diagnostics)
    converter = KeyFrameConverter(hass, STREAM_SETTINGS_NON_LL_HLS, DynamicStreamSettings())
    options = {"tls_verify": "0"}
    if not args.no_wallclock:
        options[CONF_USE_WALLCLOCK_AS_TIMESTAMPS] = "1"

    errors: list[str] = []

    def run() -> None:
        try:
            stream_worker(args.url, options, STREAM_SETTINGS_NON_LL_HLS, state, converter, done)
        except Exception as err:
            errors.append(repr(err))

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(args.timeout)
    done.set()

    print("diagnostics:", diagnostics.as_dict())
    complete = output.segments[: args.segments]
    for segment in complete:
        size = sum(len(part.data) for part in segment.parts)
        print(f"segment {segment.sequence}: {segment.duration:.2f} s, {size} bytes")
    if errors:
        print("error:", *errors)
    ok = not errors and len(complete) == args.segments
    print("OK" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
