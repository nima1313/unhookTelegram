#!/usr/bin/env python3
"""Generate Unhook-for-Telegram icons (16/32/48/128 px) with PIL.

Design: a white origami paper plane on a Telegram-blue gradient rounded
square, with a subtle "filter" dash to signal control/hiding. Rendered at
high resolution and downsampled for crisp edges.
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

S = 1024  # supersample canvas
TOP = (0x2A, 0xAB, 0xEE)     # Telegram light blue
BOT = (0x22, 0x8E, 0xD9)     # Telegram deeper blue


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def gradient(size, top, bottom):
    g = Image.new("RGB", (size, size), top)
    px = g.load()
    for y in range(size):
        t = y / (size - 1)
        r = round(top[0] + (bottom[0] - top[0]) * t)
        gg = round(top[1] + (bottom[1] - top[1]) * t)
        b = round(top[2] + (bottom[2] - top[2]) * t)
        for x in range(size):
            px[x, y] = (r, gg, b)
    return g


def build():
    bg = gradient(S, TOP, BOT)
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    canvas.paste(bg, (0, 0), rounded_mask(S, int(S * 0.22)))

    d = ImageDraw.Draw(canvas)

    def P(x, y):
        return (x * S, y * S)

    # Paper plane (classic "send" origami), shared tip.
    tip = P(0.90, 0.20)
    left = P(0.12, 0.46)
    crease = P(0.46, 0.585)
    tail = P(0.40, 0.86)

    white = (255, 255, 255, 255)
    soft = (255, 255, 255, 205)  # folded belly, slightly translucent

    d.polygon([left, tip, crease], fill=white)      # top wing
    d.polygon([crease, tip, tail], fill=soft)       # belly / bottom fold

    # Subtle "control" accent: a small notch line implying trim/filter.
    d.line([P(0.46, 0.585), P(0.63, 0.44)], fill=(255, 255, 255, 120),
           width=int(S * 0.010))

    for size in (128, 48, 32, 16):
        img = canvas.resize((size, size), Image.LANCZOS)
        img.save(os.path.join(OUT, f"icon{size}.png"))
        print("wrote", f"icon{size}.png")


if __name__ == "__main__":
    build()
