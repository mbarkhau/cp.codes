#!/usr/bin/env python3
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
import struct
import binascii
import argparse
import pathlib as pl

try:
    import qrcode
    from qrcode.constants import ERROR_CORRECT_H
    from qrcode.exceptions import DataOverflowError
    from PIL import Image
except ImportError as exc:
    errmsg = f"Missing dependency. Install it with: python -m pip install 'qrcode[pil]'\n({exc})"
    raise SystemExit(errmsg)



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
#.##. ..#.. ...#. .##.. #..#. ####. ###.. ..#.. .##.. #..#.
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
#..#. #...# #...# .#.#. #...# ..#.. ##### ..... ..... .....
#..#. #...# #...# ..#.. .#.#. ..#.. .#.#. ..... ..... .....
#..#. .#.#. #.#.# ..#.. .#.#. .#... .#.#. ..... .#... .....
#..#. .#.#. #.#.# .#.#. ..#.. .#... ##### ..... ###.. .....
#..#. .#.#. #.#.# #...# ..#.. #.... .#.#. ..... .#... .#...
.##.. ..#.. .#.#. #...# ..#.. ####. .#.#. ####. ..... .....

..... ..... .#... .##.. ...#.
..... ..... ###.. #..#. ...#.
..... ..... ###.. #..#. ..#..
.#... ###.. ###.. ...#. ..#..
..... ..... .#... ..#.. .#...
..... ..... .#... ..#.. .#...
.#... ###.. ..... ..... #....
..... ..... .#... ..#.. #....
"""


# Chars with 4x7 glyphs
GLYPH_CHARS_4X7 = (
    "0123456789",
    "ABCDEFGHIJ",
    "KLPQRSUZ_+",
    "-.:=!?/",
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

#..# #... ###. .##. ###. .##. #..# #### .... ....
#..# #... #..# #..# #..# #..# #..# ...# .... ....
#.#. #... #..# #..# #..# #... #..# ..#. .... ....
##.. #... ###. #..# ###. .##. #..# .#.. .... .#..
#.#. #... #... #..# #..# ...# #..# #... .... ###.
#..# #... #... .##. #..# #..# #..# #... .... .#..
#..# #### #... ...# #..# .##. .##. #### #### ....

.... .... .... .... .#.. .##. ...#
.... .... .... .... .#.. #..# ...#
.... .... .#.. ###. .#.. ...# ..#.
.... .... .... .... .#.. ..#. .#..
###. .... .... .... .#.. ..#. .#..
.... .... .#.. ###. .... .... #...
.... .#.. .... .... .#.. ..#. #...
"""



GLYPH_CHARS_3X8 = (
    "0123456789",
    "ABCDEFHIJ",
    "LPQRSUZ#_",
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

#.. ##. .#. ##. .#. #.# ### .... 
#.. #.# #.# #.# #.# #.# ..# .... 
#.. #.# #.# #.# #.. #.# ..# .... 
#.. #.# #.# #.# .#. #.# .#. .... 
#.. ##. #.# ##. .#. #.# .#. .... 
#.. #.. #.# #.# ..# #.# #.. .... 
#.. #.. .#. #.# #.# #.# #.. .... 
### #.. ..# #.# .#. .#. ### #### 

... ... ... ... ... .#. .#. ..# ...
... ... ... ... ... ### #.# ..# ...
... ... ... ... ... ### ..# ... ...
... ... ... .#. ### ### ..# ... ...
.#. ... ... ... ... .#. .#. .#. ...
### ### ... ... ... .#. .#. .#. ...
.#. ... .#. .#. ### ... ... #.. ...
... ... ... ... ... .#. .#. #.. ...
"""


# Chars with 3x7 glyphs
GLYPH_CHARS_3X7 = (
    "0123456789",
    "ABCDEFHIJK",
    "LPQRTUVXYZ",
    "_+-.:=!?/",
)

FONT_TEXT_3X7 = """
.#. .#. .#. .#. #.# ### .## ### .#. .#.
#.# ##. #.# #.# #.# #.. #.. ..# #.# #.#
#.# .#. ..# ..# #.# ##. ##. ..# .#. .##
#.# .#. .#. .#. ### ..# #.# .#. #.# ..#
#.# .#. #.. ..# ..# ..# #.# #.. #.# #.#
.#. ### ### ##. ..# ##. .#. #.. .#. .#.

.#. ##. .## ##. ### ### #.# ### ..# #.#
#.# #.# #.. #.# #.. #.. #.# .#. ..# #.#
#.# #.# #.. #.# #.. #.. ### .#. ..# #.#
### ##. #.. #.# ### ### #.# .#. ..# ##.
#.# #.# #.. #.# #.. #.. #.# .#. #.# #.#
#.# ##. .## ##. ### #.. #.# ### .#. #.#

#.. ##. .#. ##. ### #.# #.# #.# #.# ### 
#.. #.# #.# #.# .#. #.# #.# #.# #.# ..# 
#.. #.# #.# #.# .#. #.# #.# .#. #.# .#. 
#.. ##. #.# ##. .#. #.# #.# .#. .#. .#. 
#.. #.. .#. #.# .#. #.# #.# #.# .#. #.. 
### #.. ..# #.# .#. ### .#. #.# .#. ### 

... ... ... ... ... ... .#. .#. ..#
... ... ... ... .#. ### .#. #.# ..#
... .#. ... ... ... ... .#. ..# .#.
... ### ### ... ... ... .#. .#. .#.
... .#. ... ... .#. ### ... ... #..
### ... ... .#. ... ... .#. .#. #..
"""

GLYPH_CHARS = {
    GLYPH_CHARS_3X7: (FONT_TEXT_3X7, 3, 7),
    GLYPH_CHARS_3X8: (FONT_TEXT_3X8, 3, 8),
    GLYPH_CHARS_4X7: (FONT_TEXT_4X7, 4, 7),
    GLYPH_CHARS_5X8: (FONT_TEXT_5X8, 5, 8),
}


def select_font(visual: str):
    for chars, (glyphs, glyph_w, glyph_h) in GLYPH_CHARS.items():
        if set(visual) <= set("".join(chars)):
            font_map = parse_font(glyphs, chars)
            return (font_map, glyph_w, glyph_h)

    glyphs, glyph_w, glyph_h = GLYPH_CHARS[GLYPH_CHARS_5X8]
    font_map = parse_font(glyphs, GLYPH_CHARS_5X8)
    return (font_map, glyph_w, glyph_h)


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

    num_lines = 1
    while True:
        visual_width = math.ceil(len(text) / num_lines) * 2
        visual_height = num_lines * 3
        # print("???", text, num_lines, visual_width, visual_height)
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
assert wrap_label("0123456789ABCDEFGHIJKLMN") == ["01234567", "89ABCDEF", "GHIJKLMN"]


def label_size(lines: list[str], glyph_w: int, glyph_h: int, font_pixel_size: int) -> tuple[int, int]:
    """Return label dimensions when one font pixel is font_pixel_size pixels."""
    width = max(glyph_w * len(line) + max(0, len(line) - 1) for line in lines) * font_pixel_size
    height = (glyph_h * len(lines) + max(0, len(lines) - 1)) * font_pixel_size
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


def draw_qr_label(image: Image.Image, lines: list[str], font_map: dict[str, list[bool]], glyph_w: int, glyph_h: int, font_pixel_size: int) -> Image.Image:
    """Paint the bitmap font onto the rendered QR image.

    Each character pixel in FONT_TEXT is a solid square exactly half as wide
    and high as one QR module. No resampling is performed.
    """
    width, height = label_size(lines, glyph_w, glyph_h, font_pixel_size)
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
        y_line = y0 + row * (glyph_h + 1) * font_pixel_size
        line_width = (glyph_w * len(line) + max(0, len(line) - 1)) * font_pixel_size

        # Clear only the padded rectangle required by this line. This avoids
        # damaging QR pixels beside short final lines of wrapped text.
        for y in range(y_line - pad, y_line + glyph_h * font_pixel_size + pad):
            for x in range(x_line - pad, x_line + line_width + pad):
                image.putpixel((x, y), 1)

        for index, char in enumerate(line):
            glyph_x = x_line + index * (glyph_w + 1) * font_pixel_size
            for gy, glyph_row in enumerate(font_map[char]):
                for gx, pixel in enumerate(glyph_row):
                    if pixel:
                        glyph_x0 = glyph_x + gx * font_pixel_size
                        glyph_y0 = y_line + gy * font_pixel_size
                        for y in range(glyph_y0, glyph_y0 + font_pixel_size):
                            for x in range(glyph_x0, glyph_x0 + font_pixel_size):
                                image.putpixel((x, y), 0)

    return image


def draw_cp_link(image: Image.Image, cp_code: str, module_pixels: int) -> Image.Image:
    """Render the full link in gray text below the QR code."""
    link_text = "HTTPS://CP.CODES/" + cp_code
    font_map, glyph_w, glyph_h = select_font(link_text)
    font_pixel_size = 2
    text_w, text_h = label_size([link_text], glyph_w, glyph_h, font_pixel_size)
    pad_x = font_pixel_size * 2
    pad_y = font_pixel_size * 3
    canvas_width = max(image.width, text_w + 2 * pad_x)
    canvas_height = image.height + 2 * text_h + 2 * pad_y

    # Use grayscale so the QR stays black and white while the non-QR footer is
    # visually quieter. Center both components if the URL is wider than the QR.
    canvas = Image.new("L", (canvas_width, canvas_height), 255)
    canvas.paste(image.convert("L"), ((canvas_width - image.width) // 2, 0))
    x_start = (image.width // 2) - (text_w // 2)
    y_start = image.height - module_pixels * 3 + pad_y

    font_color = 150
    glyph_x = x_start
    glyph_y = y_start

    for index, char in enumerate(link_text):
        if index == 17:
            font_color = int(font_color * 0.7)
            # glyph_x = x_start + glyph_w + pad_x
            # glyph_y = glyph_y + (glyph_h * font_pixel_size) + pad_y
            continue

        glyph_x = glyph_x + (glyph_w + pad_x)
        for gy, glyph_row in enumerate(font_map[char]):
            for gx, pixel in enumerate(glyph_row):
                if pixel:
                    x0 = glyph_x + gx * font_pixel_size
                    y0 = glyph_y + gy * font_pixel_size
                    for y in range(y0, y0 + font_pixel_size):
                        for x in range(x0, x0 + font_pixel_size):
                            canvas.putpixel((x, y), font_color)

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


DATA_ALPHABET = "0123456789ABCDEFHIJKLPQRTUVXYZ"
CHECKSUM_WIDTH = 4


def encode_data(data: bytes | bytearray | memoryview) -> str:
    """Encode bytes as Base-30 text using only DATA_ALPHABET characters.

    Leading zero bytes are represented by leading ``0`` characters, so the
    result retains all information needed to recover the original byte string.
    """
    raw = bytes(data)
    if not raw:
        return ""

    leading_zeros = len(raw) - len(raw.lstrip(b"\0"))
    value = int.from_bytes(raw, byteorder="big")
    encoded: list[str] = []
    while value:
        value, digit = divmod(value, len(DATA_ALPHABET))
        encoded.append(DATA_ALPHABET[digit])
    return DATA_ALPHABET[0] * leading_zeros + "".join(reversed(encoded))


def checksum(data: bytes) -> str:
    """Return a fixed-width Base-30 CRC-16/CCITT checksum for data."""
    crc = binascii.crc_hqx(data, 0xFFFF)
    return encode_data(struct.pack(">H", crc)).rjust(CHECKSUM_WIDTH, DATA_ALPHABET[0])



_last_time = 0
_increment = 0


def make_cp_code(node_id: int = 0) -> str:
    """Return a compact, chronologically sortable ``CP`` code.

    The Base-30 payload contains, in big-endian order: Unix time in milliseconds
    (48 bits), a per-millisecond sequence number (16 bits), and node_id (48 bits),
    followed by a four-character CRC-16/CCITT checksum.
    """
    global _last_time
    global _increment

    if not isinstance(node_id, int) or not 0 <= node_id <= 0xFFFF:
        raise ValueError("node_id must be an integer between 0 and 65535")

    new_time = int(time.time() * 1000)
    if not 0 <= new_time <= 0xFFFFFFFFFFFF:
        raise ValueError("current Unix timestamp does not fit in 48 bits")

    if _last_time >= new_time:
        _increment = _increment + 1
        if _increment > 0xFFFF:
            # overflow into the future
            _last_time = _last_time + 1
            _increment = 0
    else:
        _increment = 0
        _last_time = new_time

    data = (
        new_time.to_bytes(6, byteorder="big") +
        struct.pack(">H", _increment) +
        node_id.to_bytes(6, byteorder="big")
    )
    return "CP" + encode_data(data) + checksum(data)


def render_cp_code(cp_code: str, module_pixels: int):
    qr_payload = "https://cp.codes/" + cp_code.lower()
    visual = display_text(cp_code)

    font_map, glyph_w, glyph_h = select_font(visual)
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

        image = draw_qr_label(image, lines, font_map, glyph_w, glyph_h, font_pixel_size)
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
    print(f"Created (version {version}; {len(qr.modules)}x{len(qr.modules)} modules; label: {visual!r})")
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
