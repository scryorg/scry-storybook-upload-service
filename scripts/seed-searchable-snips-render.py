#!/usr/bin/env python3
"""Render the three renditions of one seed snip (searchable-snips stage seed). Local, no network, no paid API.

usage: seed-searchable-snips-render.py OUT_DIR "words" "owner label"
Writes OUT_DIR/original.png (1280x720), preview.jpg, agent.webp. The words are drawn large so a vision
model can read them; the owner label and a few UI-ish shapes make every snip's bytes distinct.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def main(out_dir: str, words: str, label: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (1280, 720), (245, 246, 248))
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, 1280, 64), fill=(24, 26, 32))
    d.text((24, 20), f"Scry UAT sample  {label}", fill=(255, 255, 255), font=ImageFont.truetype(FONT, 24))
    d.rounded_rectangle((240, 140, 1040, 580), radius=24, fill=(255, 255, 255), outline=(200, 204, 212), width=3)
    d.text((300, 260), words, fill=(24, 26, 32), font=ImageFont.truetype(FONT, 72))
    d.rounded_rectangle((300, 460, 560, 530), radius=14, fill=(24, 26, 32))
    d.text((340, 478), "Continue", fill=(255, 255, 255), font=ImageFont.truetype(FONT, 30))
    img.save(out / "original.png", format="PNG")
    img.convert("RGB").save(out / "preview.jpg", format="JPEG", quality=80)
    img.resize((1280, 720)).save(out / "agent.webp", format="WEBP", quality=60)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
