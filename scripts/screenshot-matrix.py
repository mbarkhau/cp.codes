"""Assemble the viewport captures without modifying the app screenshots."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'doc/design-review/2026-10-12')
manifest = json.loads((root / 'manifest.json').read_text())
font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
font = lambda size: ImageFont.truetype(font_path, size)
columns = [('desktop', 'light'), ('desktop', 'dark'), ('mobile', 'light'), ('mobile', 'dark')]
screens = [('editor', 'Editor'), ('list', 'Public paste list'), ('viewer-markdown', 'Viewer / Markdown'), ('viewer-code', 'Viewer / Code')]
margin, gap, cell_w, image_h = 40, 20, 540, 610
row_h = 704
width = margin * 2 + cell_w * 4 + gap * 3
height = 170 + row_h * 4 + 56
canvas = Image.new('RGB', (width, height), '#edf0f4')
draw = ImageDraw.Draw(canvas)
draw.text((margin, 30), 'cp.codes / Design review', fill='#18202c', font=font(36))
draw.text((margin, 83), '4 screens × 2 themes × 2 devices  |  12 October 2026  |  Current working tree + sample data', fill='#526071', font=font(21))
draw.text((margin, 117), 'Viewport captures: desktop 1440 × 1000 / mobile 390 × 844. Full-page PNGs included in the gallery.', fill='#526071', font=font(20))
for row, (screen, label) in enumerate(screens):
    top = 170 + row * row_h
    draw.text((margin, top), label, fill='#18202c', font=font(26))
    for col, (device, theme) in enumerate(columns):
        capture = next(c for c in manifest['captures'] if (c['screen'], c['device'], c['theme']) == (screen, device, theme))
        left = margin + col * (cell_w + gap)
        card_top = top + 42
        draw.rounded_rectangle((left, card_top, left + cell_w, card_top + image_h + 34), radius=8, fill='#ffffff', outline='#c6ced9', width=1)
        draw.text((left + 14, card_top + 9), f'{device.title()} / {theme.title()}  ·  {capture["width"]} × {capture["height"]}', fill='#263243', font=font(18))
        image = Image.open(root / capture['viewport']).convert('RGB')
        image.thumbnail((cell_w - 2, image_h - 2), Image.Resampling.LANCZOS)
        x = left + (cell_w - image.width) // 2
        y = card_top + 34
        canvas.paste(image, (x, y))
draw.text((margin, height - 38), '16 combinations. Screenshots are unmodified; white card surrounds are only the review sheet.', fill='#526071', font=font(18))
canvas.save(root / 'matrix.png', optimize=True)
print(f'Saved {root / "matrix.png"}: {width} × {height}')
