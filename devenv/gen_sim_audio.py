"""Generate the simulator audio: 4 s AAC-LC, 16 kHz mono (ADTS) like the real cameras.

A soft beep per second. Run from the repo root:

    .venv/bin/python devenv/gen_sim_audio.py bridge/simulator-assets/audio.aac
"""

import sys

import av
import numpy as np

out = av.open(sys.argv[1], "w", format="adts")
stream = out.add_stream("aac", rate=16000, layout="mono")
stream.bit_rate = 32000
rate, samples = 16000, 1024
t = np.arange(rate * 4) / rate
signal = np.where((t % 1.0) < 0.15, 0.2 * np.sin(2 * np.pi * 440 * t), 0.0).astype(np.float32)
for i in range(0, len(signal), samples):
    chunk = signal[i : i + samples]
    if len(chunk) < samples:
        chunk = np.pad(chunk, (0, samples - len(chunk)))
    frame = av.AudioFrame.from_ndarray(chunk.reshape(1, -1), format="fltp", layout="mono")
    frame.sample_rate = rate
    frame.pts = i
    for packet in stream.encode(frame):
        out.mux(packet)
for packet in stream.encode(None):
    out.mux(packet)
out.close()
