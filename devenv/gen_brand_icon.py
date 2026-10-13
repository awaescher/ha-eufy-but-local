"""Generate the integration icon (custom_components/eufy_but_local/brand/).

Own artwork, not the Eufy logo (trademark): a house with a camera lens, i.e. "local camera".
The lens is drawn as a smiling eye (sparkles, lower lid curving up) so it looks friendly
rather than watchful.
Drawn at 4x and downscaled for smooth edges. Run from the repo root:

    .venv/bin/python devenv/gen_brand_icon.py custom_components/eufy_but_local/brand
"""

from pathlib import Path
import sys

from PIL import Image, ImageDraw

BLUE = (0, 145, 234, 255)
LIGHT = (90, 190, 255, 255)
WHITE = (255, 255, 255, 255)
DARK = (16, 42, 67, 255)
CLEAR = (0, 0, 0, 0)

RING = 5  # lens ring thickness; the lower lid uses the same stroke


def circle(d: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill) -> None:
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=fill)


def draw(size: int) -> Image.Image:
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = s / 100

    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=22 * u, fill=BLUE)

    # House: roof and body
    d.polygon([(50 * u, 14 * u), (88 * u, 46 * u), (12 * u, 46 * u)], fill=WHITE)
    d.rounded_rectangle((20 * u, 40 * u, 80 * u, 86 * u), radius=6 * u, fill=WHITE)

    # Lens on its own layer, clipped to the outer ring, so the lid only changes lens pixels.
    lens = Image.new("RGBA", (s, s), CLEAR)
    ld = ImageDraw.Draw(lens)
    cx, cy, r = 50 * u, 58 * u, 17 * u
    circle(ld, cx, cy, r, DARK)
    circle(ld, cx, cy, r - RING * u, LIGHT)
    circle(ld, cx, cy, 6 * u, DARK)
    circle(ld, cx - 5 * u, cy - 5 * u, 3.2 * u, WHITE)
    circle(ld, cx + 4 * u, cy + 3 * u, 1.6 * u, WHITE)

    # Lower lid curving up into the lens, edged with the ring's stroke: the eye smiles.
    lid = (cx - 30 * u, 70 * u, cx + 30 * u, 110 * u)
    ring = RING * u
    ld.ellipse((lid[0] - ring, lid[1] - ring, lid[2] + ring, lid[3] + ring), fill=DARK)
    ld.ellipse(lid, fill=CLEAR)

    mask = Image.new("L", (s, s), 0)
    circle(ImageDraw.Draw(mask), cx, cy, r, 255)
    alpha = Image.composite(lens.getchannel("A"), mask, mask)
    lens.putalpha(alpha)
    img.alpha_composite(lens)

    return img.resize((size, size), Image.LANCZOS)


out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
draw(256).save(out / "icon.png", optimize=True)
draw(512).save(out / "icon@2x.png", optimize=True)
