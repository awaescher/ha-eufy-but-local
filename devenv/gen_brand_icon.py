"""Generate the integration icon (custom_components/eufy_but_local/brand/).

Own artwork, not the Eufy logo (trademark): a house with a camera lens, i.e. "local camera".
Drawn at 4x and downscaled for smooth edges. Run from the repo root:

    .venv/bin/python devenv/gen_brand_icon.py custom_components/eufy_but_local/brand
"""

from pathlib import Path
import sys

from PIL import Image, ImageDraw

BLUE = (0, 145, 234, 255)
WHITE = (255, 255, 255, 255)
DARK = (16, 42, 67, 255)


def draw(size: int) -> Image.Image:
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = s / 100

    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=22 * u, fill=BLUE)

    # House: roof and body
    d.polygon([(50 * u, 14 * u), (88 * u, 46 * u), (12 * u, 46 * u)], fill=WHITE)
    d.rounded_rectangle((20 * u, 40 * u, 80 * u, 86 * u), radius=6 * u, fill=WHITE)

    # Camera lens
    cx, cy = 50 * u, 62 * u
    for r, color in ((19, DARK), (12, BLUE), (6, DARK)):
        d.ellipse((cx - r * u, cy - r * u, cx + r * u, cy + r * u), fill=color)
    d.ellipse((cx - 9 * u, cy - 10 * u, cx - 4 * u, cy - 5 * u), fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
draw(256).save(out / "icon.png", optimize=True)
draw(512).save(out / "icon@2x.png", optimize=True)
