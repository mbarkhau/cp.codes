#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "qrcode[pil]",
#   "zxing-cpp",
# ]
# ///
"""Make a QR code whose payload is also drawn in its modules.

Install dependencies:
    python -m pip install "qrcode[pil]"

Optional but strongly recommended validation:
    python -m pip install zxing-cpp

Example:
    python qr_text.py "HELLO 2026" -o hello.png

Skip validation (when zxing-cpp is not installed):
    python qr_text.py "HELLO 2026" -o hello.png
"""

import sys
import math
import time
import zlib
import struct
import base64
import argparse
import typing as typ
import pathlib as pl

try:
    import qrcode
    from qrcode.constants import ERROR_CORRECT_H
    from qrcode.exceptions import DataOverflowError
    from PIL import Image
except ImportError as exc:
    errmsg = f"Missing dependency. Install it with: python -m pip install 'qrcode[pil]'\n({exc})"
    raise SystemExit(errmsg)

from cp_code import make_cp_code


# A "#" is an inked pixel, a "." is an non-inked/transparent pixel
# Each string labels one 8-row block in FONT_TEXT.  Keeping the final blank
# character in the last string lets the font include a real space glyph.

# Chars with 5x8 glyphs
GLYPH_CHARS_5X8 = (
    "0123456789",
    "ABCDEFGHIJ",
    "KLMNOPQRST",
    "UVWXYZ#+-.",
    ":=!?/",
)

FONT_TEXT_5X8 = """
.##.. ..#.. .##.. .##.. .#.#. ####. .##.. ####. .##.. .##..
#..#. .##.. #..#. #..#. .#.#. #.... #..#. ...#. #..#. #..#.
#..#. ..#.. ...#. ...#. #..#. #.... #.... ...#. #..#. #..#.
#.##. ..#.. ...#. .##.. #..#. ###.. ###.. ..#.. .##.. #..#.
##.#. ..#.. ..#.. ...#. ####. ...#. #..#. ..#.. #..#. .###.
#..#. ..#.. .#... ...#. ...#. ...#. #..#. ..#.. #..#. ...#.
#..#. ..#.. #.... #..#. ...#. #..#. #..#. .#... #..#. #..#.
.##.. .###. ####. .##.. ...#. .##.. .##.. .#... .##.. .##..

.##.. ###.. .##.. ###.. ####. ####. .##.. #..#. ###.. .###.
#..#. #..#. #..#. #..#. #.... #.... #..#. #..#. .#... ...#.
#..#. #..#. #.... #..#. #.... #.... #.... #..#. .#... ...#.
#..#. ###.. #.... #..#. ###.. ###.. #.##. ####. .#... ...#.
####. #..#. #.... #..#. #.... #.... #..#. #..#. .#... ...#.
#..#. #..#. #.... #..#. #.... #.... #..#. #..#. .#... ...#.
#..#. #..#. #..#. #..#. #.... #.... #..#. #..#. .#... #..#.
#..#. ###.. .##.. ###.. ####. #.... .##.. #..#. ###.. .##..

#..#. #.... #...# #...# .##.. ###.. .##.. ###.. .##.. #####
#.#.. #.... #...# ##..# #..#. #..#. #..#. #..#. #..#. ..#..
#.#.. #.... ##.## ##..# #..#. #..#. #..#. #..#. #.... ..#..
##... #.... #.#.# #.#.# #..#. #..#. #..#. #..#. .#... ..#..
##... #.... #...# #.#.# #..#. ###.. #..#. ###.. ..#.. ..#..
#.#.. #.... #...# #..## #..#. #.... #..#. #..#. ...#. ..#..
#.#.. #.... #...# #..## #..#. #.... .##.. #..#. #..#. ..#..
#..#. ####. #...# #...# .##.. #.... ...#. #..#. .##.. ..#..

#..#. #...# #...# #...# #...# ####. .#.#. ..... ..... .....
#..#. #...# #...# #...# #...# ...#. .#.#. ..... ..... .....
#..#. #...# #...# .#.#. .#.#. ..#.. ##### ..... ..... .....
#..#. #...# #...# ..#.. .#.#. ..#.. .#.#. ..... ..... .....
#..#. .#.#. #.#.# ..#.. ..#.. .#... .#.#. ..... .#... .....
#..#. .#.#. #.#.# .#.#. ..#.. .#... ##### ..... ###.. .....
#..#. .#.#. #.#.# #...# ..#.. #.... .#.#. ..... .#... .#...
.##.. ..#.. .#.#. #...# ..#.. ####. .#.#. ####. ..... .....

..... ..... .#... .##.. .#...
..... ..... ###.. #..#. .#...
..... ..... ###.. #..#. .#...
.#... ###.. ###.. ...#. .#...
..... ..... .#... ..#.. #....
..... ..... .#... ..#.. #....
.#... ###.. ..... ..... #....
..... ..... .#... ..#.. #....
"""


# Chars with 4x7 glyphs
GLYPH_CHARS_4X7 = (
    "0123456789",
    "ABCDEFGHIJ",
    "KLPQRSUYZ_",
    "+-.:=!?/",
)

FONT_TEXT_4X7 = """
.##. .#.. .##. .##. #..# #### .##. #### .##. .##.
#..# ##.. #..# #..# #..# #... #..# ...# #..# #..#
#.## .#.. ...# ...# #..# #### #... ...# #..# #..#
##.# .#.. ..#. .### #### ...# #### ..#. .##. .###
#..# .#.. .#.. ...# ...# ...# #..# ..#. #..# ...#
#..# .#.. #... #..# ...# #..# #..# .#.. #..# #..#
.##. ###. #### .##. ...# .##. .##. .#.. .##. .##.

.##. ###. .##. ###. #### #### .##. #..# ###. .###
#..# #..# #..# #..# #... #... #... #..# .#.. ...#
#..# #..# #... #..# #... #... #... #..# .#.. ...#
#### ###. #... #..# ###. ###. #.## #### .#.. ...#
#..# #..# #... #..# #... #... #..# #..# .#.. ...#
#..# #..# #..# #..# #... #... #..# #..# .#.. #..#
#..# ###. .##. ###. #### #... .##. #..# ###. .##.

#..# #... ###. .##. ###. .##. #..# #.#. #### ....
#..# #... #..# #..# #..# #..# #..# #.#. ...# ....
#.#. #... #..# #..# #..# #... #..# #.#. ..#. ....
##.. #... ###. #..# ###. .##. #..# .#.. .#.. ....
#.#. #... #... #..# #..# ...# #..# .#.. #... ....
#..# #... #... .##. #..# #..# #..# .#.. #... ....
#..# #### #... ...# #..# .##. .##. .#.. #### ####

.... .... .... .... .... .#.. .##. ..#.
.... .... .... .... .... .#.. #..# ..#.
.... .... .... .#.. ###. .#.. ...# .#..
.#.. .... .... .... .... .#.. ..#. .#..
###. ###. .... .... .... .#.. ..#. .#..
.#.. .... .... .#.. ###. .... .... #...
.... .... .#.. .... .... .#.. ..#. #...
"""



GLYPH_CHARS_3X8 = (
    "0123456789",
    "ABCDEFHIJ",
    "LPQRSUVXYZ_",
    "+-.:=!?/ ",
)

FONT_TEXT_3X8 = """
.#. .#. .#. .#. #.# ### .#. ### .##. .#.
#.# ##. #.# #.# #.# #.. #.# ..# #..# #.#
#.# .#. ..# ..# #.# #.. #.. ..# #..# #.#
### .#. ..# .#. #.# ### ##. ..# .##. #.#
#.# .#. .#. ..# ### ..# #.# .#. #..# .##
#.# .#. .#. ..# ..# ..# #.# .#. #..# ..#
#.# .#. #.. #.# ..# #.# #.# .#. #..# #.#
.#. ### ### .#. ..# .#. .#. .#. .##. .#.

.#. ##. .#. ##. ### ### #..# ### .##
#.# #.# #.# #.# #.. #.. #..# .#. ..#
#.# #.# #.. #.# #.. #.. #..# .#. ..#
#.# ##. #.. #.# ##. ##. #### .#. ..#
### #.# #.. #.# #.. #.. #..# .#. ..#
#.# #.# #.. #.# #.. #.. #..# .#. ..#
#.# #.# #.# #.# #.. #.. #..# .#. #.#
#.# ##. .#. ##. ### #.. #..# ### .#.

#.. ##. .#. ##. .#. #.# #.# #.# #.# ### .... 
#.. #.# #.# #.# #.# #.# #.# #.# #.# ..# .... 
#.. #.# #.# #.# #.. #.# #.# #.# #.# ..# .... 
#.. #.# #.# #.# .#. #.# #.# .#. .#. .#. .... 
#.. ##. #.# ##. .#. #.# #.# .#. .#. .#. .... 
#.. #.. #.# #.# ..# #.# #.# #.# .#. #.. .... 
#.. #.. .#. #.# #.# #.# #.# #.# .#. #.. .... 
### #.. ..# #.# .#. ### .#. #.# .#. ### #### 

... ... ... ... ... .#. .#. ..# ...
... ... ... ... ... ### #.# ..# ...
... ... ... ... ... ### ..# .#. ...
... ... ... .#. ### ### ..# .#. ...
.#. ... ... ... ... .#. .#. .#. ...
### ### ... ... ... .#. .#. .#. ...
.#. ... .#. .#. ### ... ... #.. ...
... ... ... ... ... .#. .#. #.. ...
"""


# Chars with 3x7 glyphs
GLYPH_CHARS_3X7 = (
    "0123456789",
    "ABCDEFGHIJ",
    "KLOPQRSTUV",
    "XYZ_+-.:=!",
    "?/",
)
# MNW GS

FONT_TEXT_3X7 = """
.#. .#. .#. .#. #.# ### .## ### .#. .#.
#.# ##. #.# #.# #.# #.. #.. ..# #.# #.#
#.# .#. ..# ..# #.# ##. ##. ..# .#. .##
### .#. .#. .#. ### ..# #.# .#. #.# ..#
#.# .#. #.. ..# ..# ..# #.# #.. #.# #.#
.#. ### ### ##. ..# ##. .#. #.. .#. .#.

.#. ##. .## ##. ### ### .## #.# ### ..#
#.# #.# #.. #.# #.. #.. #.. #.# .#. ..#
#.# #.# #.. #.# #.. #.. #.. ### .#. ..#
### ##. #.. #.# ### ### #.# #.# .#. ..#
#.# #.# #.. #.# #.. #.. #.# #.# .#. #.#
#.# ##. .## ##. ### #.. .## #.# ### .#.

#.# #.. .#. ##. .#. ##. .#. ### #.# #.#
#.# #.. #.# #.# #.# #.# #.# .#. #.# #.#
#.# #.. #.# #.# #.# #.# #.. .#. #.# #.#
##. #.. #.# ##. #.# ##. .#. .#. #.# #.#
#.# #.. #.# #.. .#. #.# ..# .#. #.# #.#
#.# ### .#. #.. ..# #.# ##. .#. ### .#.

#.# #.# ### ... ... ... ... ... ... .#.
#.# #.# ..# ... ... ... ... .#. ### .#.
.#. #.# .#. ... .#. ... ... ... ... .#.
.#. .#. .#. ... ### ### ... ... ... .#.
#.# .#. #.. ... .#. ... ... .#. ### ...
#.# .#. ### ### ... ... .#. ... ... .#.

.#. .#.
#.# .#.
..# .#.
.#. #..
... #..
.#. #..
"""


GLYPH_CHARS = {
    GLYPH_CHARS_3X7: FONT_TEXT_3X7,
    GLYPH_CHARS_3X8: FONT_TEXT_3X8,
    GLYPH_CHARS_4X7: FONT_TEXT_4X7,
    GLYPH_CHARS_5X8: FONT_TEXT_5X8,
}


def parse_font(font_text: str, glyph_groups: tuple[str, ...]) -> dict[str, tuple[str, ...]]:
    """Parse a human-editable bitmap-font sheet into glyph rows.

    Blocks are separated by blank lines. Within a row, whitespace separates
    3-, 4-, or 5-pixel-wide glyphs. The matching GLYPH_CHARS string supplies
    the character for every column in its block.
    """
    blocks = [block.splitlines() for block in font_text.strip().split("\n\n")]
    if len(blocks) != len(glyph_groups):
        errmsg = f"FONT_TEXT block count {len(blocks)} does not match groups {len(glyph_groups)}"
        raise ValueError(errmsg)

    font: dict[str, tuple[str, ...]] = {}
    glyph_h: int | None = None
    for block_number, (rows, characters) in enumerate(zip(blocks, glyph_groups), start=1):
        if glyph_h is None:
            glyph_h = len(rows)
        elif len(rows) != glyph_h:
            raise ValueError(f"FONT_TEXT block {block_number} has an inconsistent glyph height")
        columns = [row.split() for row in rows]
        if any(len(row) != len(characters) for row in columns):
            raise ValueError(f"FONT_TEXT block {block_number} has the wrong number of glyphs")
        for row in columns:
            if any(len(glyph) not in (3, 4, 5) or set(glyph) - {"#", "."} for glyph in row):
                raise ValueError(f"FONT_TEXT block {block_number} contains an invalid glyph")
        for column, character in enumerate(characters):
            font[character] = tuple(tuple(int(ch == "#") for ch in row[column]) for row in columns)

    sample_glyph = next(iter(font.values()))
    font[" "] = tuple(tuple(0 for _ in row) for row in sample_glyph)
    return font


class Font:
    """A bitmap font with metrics derived from its actual inked pixels."""

    spacing = 1  # logical pixels between adjacent glyphs

    def __init__(self, glyph_chars: tuple[str, ...]):
        font_text = GLYPH_CHARS[glyph_chars]
        self.glyphs = parse_font(font_text, glyph_chars)
        self.characters = frozenset(self.glyphs)
        self.cell_width = max(len(row) for glyph in self.glyphs.values() for row in glyph)
        self.glyph_height = len(next(iter(self.glyphs.values())))
        self._bounds: dict[str, tuple[int, int, int]] = {}

        for char, rows in self.glyphs.items():
            inked_columns = [
                x for x in range(len(rows[0]))
                if any(row[x] for row in rows)
            ]
            if inked_columns:
                left, right = min(inked_columns), max(inked_columns) + 1
                self._bounds[char] = left, right, right - left
            else:
                # A blank glyph still needs an intentional, readable advance.
                self._bounds[char] = 0, 0, max(1, self.cell_width // 2)

    def glyph_width(self, char: str) -> int:
        """Return the ink width of char (or the advance width for blanks)."""
        return self._bounds[char][2]

    def glyph_advance(self, char: str, monospace: bool = False) -> int:
        width = self.cell_width if monospace else self.glyph_width(char)
        return width + self.spacing

    def measure_text(self, text: str, scale: int = 1, monospace: bool = False) -> tuple[int, int]:
        """Return the rendered bounding width and height, excluding trailing spacing."""
        if scale < 1:
            raise ValueError("scale must be a positive integer")
        if not text:
            return 0, self.glyph_height * scale
        for char in text:
            if char not in self.glyphs:
                raise ValueError(f"character {char!r} is not available in this font")
        width = sum(self.glyph_advance(char, monospace) for char in text) - self.spacing
        return width * scale, self.glyph_height * scale

    def render_text(
        self,
        image: Image.Image,
        text: str,
        x: int,
        y: int,
        scale: int = 1,
        monospace: bool = False,
        color: int = 0,
    ) -> tuple[int, int]:
        """Render text in a grayscale value and return the cursor position."""
        if scale < 1:
            raise ValueError("scale must be a positive integer")

        cursor_x = x
        for char in text:
            if char not in self.glyphs:
                raise ValueError(f"character {char!r} is not available in this font")
            bound_l, bound_r, _width = self._bounds[char]
            glyph_x = cursor_x + (bound_l * scale if monospace else 0)

            for gy, glyph_row in enumerate(self.glyphs[char]):
                for gx, pixel in enumerate(glyph_row):
                    if not pixel:
                        continue

                    if monospace:
                        target_x = glyph_x + gx * scale
                    else:
                        target_x = glyph_x + (gx - bound_l) * scale
                    target_y = y + gy * scale

                    for py in range(target_y, target_y + scale):
                        for px in range(target_x, target_x + scale):
                            image.putpixel((px, py), color)
            cursor_x += self.glyph_advance(char, monospace) * scale
        return cursor_x, y


def select_font(visual: str) -> Font:
    for chars in GLYPH_CHARS.keys():
        if set(visual) <= set("".join(chars)):
            return Font(chars)

    return Font(GLYPH_CHARS_5X8)


def display_text(text: str) -> str:
    """Make a visual label, preserving the original text in the QR data."""
    valid_chars = set("".join(GLYPH_CHARS_5X8))
    return "".join(ch if ch in valid_chars else "?" for ch in text.strip().upper())


def chars_per_line(text: str) -> int:
    if len(text) in (0, 1, 2, 3, 4, 5, 7, 11):
        return len(text)

    sqrt = len(text) ** 0.5
    if sqrt == int(sqrt):
        return int(sqrt)

    for num_cols in range(7, 2, -1):
        if num_cols > sqrt:
            continue

        num_lines = len(text) // num_cols
        if len(text) == num_lines * num_cols:
            return num_lines

    num_lines = 1
    while True:
        visual_width = math.ceil(len(text) / num_lines) * 2
        visual_height = num_lines * 3
        if visual_height >= visual_width:
            return math.ceil(len(text) / (num_lines - 1))

        num_lines = num_lines + 1


def wrap_label(text: str) -> list[str]:
    """Wrap only between glyphs, never changing the encoded data."""
    cpl = chars_per_line(text)
    return [text[i : i + cpl] for i in range(0, len(text), cpl)]


assert wrap_label("ABCD") == ["ABCD"]
assert wrap_label("ABCDEF") == ["ABCDEF"]
assert wrap_label("ABCDEFGHI") == ["ABC", "DEF", "GHI"]
assert wrap_label("0123456789ABCDEF") == ["0123", "4567", "89AB", "CDEF"]
assert wrap_label("0123456789ABCDEFGHIJKLMN") == ["012345", "6789AB", "CDEFGH", "IJKLMN"]


def label_size(lines: list[str], font: Font, font_pixel_size: int, monospace: bool = False) -> tuple[int, int]:
    """Return label dimensions using the selected font's measured glyph widths."""
    width = max(font.measure_text(line, font_pixel_size, monospace)[0] for line in lines)
    height = (font.glyph_height * len(lines) + max(0, len(lines) - 1)) * font_pixel_size
    return width, height


def make_qr(payload: str, version: int, module_pixels: int) -> qrcode.QRCode:
    qr = qrcode.QRCode(
        version=version,
        error_correction=ERROR_CORRECT_H,
        box_size=module_pixels,
        border=4,
    )
    qr.add_data(payload)
    qr.make(fit=False)
    return qr


def render_qr(qr: qrcode.QRCode) -> Image.Image:
    """Let qrcode render the QR image, including its quiet zone."""
    return qr.make_image(fill_color="black", back_color="white").get_image().convert("1")


def draw_qr_label(image: Image.Image, lines: list[str], font: Font, font_pixel_size: int) -> Image.Image:
    """Paint the bitmap font onto the rendered QR image.

    Each character pixel in FONT_TEXT is a solid square exactly half as wide
    and high as one QR module. No resampling is performed.
    """
    width, height = label_size(lines, font, font_pixel_size)
    pad = font_pixel_size
    module_pixels = font_pixel_size * 2
    banner_width = width + 2 * pad
    banner_height = height + 2 * pad

    # Snap the outer (white-padded) label rectangle to the nearest module grid
    # boundary. The image's quiet zone is an integral number of modules, so
    # pixel coordinate 0 is already a module boundary.
    banner_x = ((image.width - banner_width + module_pixels) // (2 * module_pixels)) * module_pixels
    banner_y = ((image.height - banner_height + module_pixels) // (2 * module_pixels)) * module_pixels
    x0 = banner_x + pad
    y0 = banner_y + pad

    for row, line in enumerate(lines):
        x_line = x0
        y_line = y0 + row * (font.glyph_height + 1) * font_pixel_size
        line_width = font.measure_text(line, font_pixel_size)[0]

        # Clear only the padded rectangle required by this line. This avoids
        # damaging QR pixels beside short final lines of wrapped text.
        for y in range(y_line - pad, y_line + font.glyph_height * font_pixel_size + pad):
            for x in range(x_line - pad, x_line + line_width + pad):
                image.putpixel((x, y), 1)

        font.render_text(image, line, x_line, y_line, font_pixel_size)

    return image


def draw_cp_link(image: Image.Image, cp_code: str, module_pixels: int) -> Image.Image:
    """Render the full link in gray text below the QR code."""
    font = Font(GLYPH_CHARS_5X8)
    font_pixel_size = 2
    pad_x = font_pixel_size * 2
    pad_y = font_pixel_size * 3

    link_text = "CP.CODES / " + " ".join(wrap_label(cp_code))
    # link_text = "CP.CODES/" + cp_code

    canvas_width = image.width
    canvas_height = image.height
    text_w, text_h = label_size([link_text], font, font_pixel_size)

    canvas_width = max(canvas_width, text_w + pad_x * 2)
    canvas_height = canvas_height + ((text_h + pad_y * 2) * 1)

    # Use grayscale so the QR stays black and white while the non-QR footer is
    # visually quieter. Center both components if the URL is wider than the QR.
    canvas = Image.new("L", (canvas_width, canvas_height), 255)
    canvas.paste(image.convert("L"), ((canvas_width - image.width) // 2, 0))

    text_w, _ = label_size([link_text], font, font_pixel_size)
    x_start = (canvas_width - text_w) // 2
    y_start = canvas_height - (text_h + pad_y) * 2
    font.render_text(canvas, link_text, x_start, y_start, font_pixel_size, color=120)

    return canvas


def verify(image: Image.Image, payload: str) -> bool:
    """Scan the completed image with the optional zxing-cpp dependency."""
    try:
        import zxingcpp
    except ImportError as exc:
        errmsg = (
            "Verification requires the optional dependency zxing-cpp. "
            "Install it with: python -m pip install zxing-cpp"
        ) 
        raise RuntimeError(errmsg) from exc

    result = zxingcpp.read_barcode(
        image,
        formats=zxingcpp.BarcodeFormat.QRCode,
        is_pure=True,
    )
    return result is not None and result.text == payload


def render_cp_code(cp_code: str, module_pixels: int):
    qr_payload = "https://cp.codes/" + cp_code.lower()
    visual = display_text(cp_code)

    font = select_font(visual)
    lines = wrap_label(visual)
    font_pixel_size = module_pixels // 2

    # A larger QR leaves the fixed-size pixel label affecting a smaller
    # portion of the symbol.  Binary search finds the smallest version the
    # scanner can recover, while also skipping versions too small for data.
    lo_version = 1
    hi_version = 40
    best: tuple[qrcode.QRCode, Image.Image, int] | None = None
    while lo_version <= hi_version:
        version = (lo_version + hi_version) // 2
        try:
            qr = make_qr(qr_payload, version, module_pixels)
        except DataOverflowError:
            lo_version = version + 1
            continue

        image = render_qr(qr)

        image = draw_qr_label(image, lines, font, font_pixel_size)
        try:
            valid = verify(image, qr_payload)
        except RuntimeError as exc:
            raise SystemExit(str(exc))

        if valid:
            best = qr, image, version
            hi_version = version - 1
        else:
            lo_version = version + 1

    if best is None:
        raise SystemExit("Validation failed: no QR version could recover the original payload.")

    qr, image, version = best
    image = draw_cp_link(image, cp_code, module_pixels)
    label = " ".join(wrap_label(visual))
    print(f"Created (version {version}; {len(qr.modules)}x{len(qr.modules)} modules; label: {label})")
    return image


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("text", help="Exact UTF-8 payload to encode")
    parser.add_argument("-o", "--output", type=pl.Path, default=pl.Path("qr_text.png"))
    parser.add_argument("--module-pixels", type=int, default=12, help="PNG pixels per QR module (default: 12)")
    args = parser.parse_args()

    if args.module_pixels < 2 or args.module_pixels % 2:
        parser.error("module pixels must be a positive even number")

    # image = render_cp_code(cp_code=args.text, module_pixels=args.module_pixels)
    image = render_cp_code(cp_code=make_cp_code(), module_pixels=args.module_pixels)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    image.save(args.output)


if __name__ == "__main__":
    main()
