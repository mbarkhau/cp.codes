/**
 * Client port of prototype/qr_text.py
 * Renders a scannable QR for https://cp.codes/<id> with the CP-Code drawn
 * into the modules and a gray footer label underneath.
 */

import { encode as encodeQr } from "https://cdn.jsdelivr.net/npm/uqr@0.1.2/+esm";

const GLYPH_CHARS_5X8 = ["0123456789", "ABCDEFGHIJ", "KLMNOPQRST", "UVWXYZ#+-.", ":=!?/"];
const FONT_TEXT_5X8 = `
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
`;

const GLYPH_CHARS_4X7 = ["0123456789", "ABCDEFGHIJ", "KLPQRSUYZ_", "+-.:=!?/"];
const FONT_TEXT_4X7 = `
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
`;

const GLYPH_CHARS_3X8 = ["0123456789", "ABCDEFHIJ", "LPQRSUVXYZ_", "+-.:=!?/ "];
const FONT_TEXT_3X8 = `
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
`;

const GLYPH_CHARS_3X7 = ["0123456789", "ABCDEFGHIJ", "KLOPQRSTUV", "XYZ_+-.:=!", "?/"];
const FONT_TEXT_3X7 = `
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
`;

/** Fonts ordered smallest → largest, matching prototype select_font order. */
const FONT_DEFS = [
	{ chars: GLYPH_CHARS_3X7, text: FONT_TEXT_3X7 },
	{ chars: GLYPH_CHARS_3X8, text: FONT_TEXT_3X8 },
	{ chars: GLYPH_CHARS_4X7, text: FONT_TEXT_4X7 },
	{ chars: GLYPH_CHARS_5X8, text: FONT_TEXT_5X8 },
];

function parseFont(fontText, glyphGroups) {
	const blocks = fontText
		.trim()
		.split(/\n\n+/)
		.map((block) => block.split("\n").filter((line) => line.length > 0));
	if (blocks.length !== glyphGroups.length) {
		throw new Error(
			`FONT_TEXT block count ${blocks.length} does not match groups ${glyphGroups.length}`,
		);
	}

	const font = new Map();
	let glyphH = null;
	for (let bi = 0; bi < blocks.length; bi++) {
		const rows = blocks[bi];
		const characters = glyphGroups[bi];
		if (glyphH == null) glyphH = rows.length;
		else if (rows.length !== glyphH) {
			throw new Error(`FONT_TEXT block ${bi + 1} has an inconsistent glyph height`);
		}
		const columns = rows.map((row) => row.split(/\s+/).filter(Boolean));
		if (columns.some((row) => row.length !== characters.length)) {
			throw new Error(`FONT_TEXT block ${bi + 1} has the wrong number of glyphs`);
		}
		for (const row of columns) {
			for (const glyph of row) {
				if (![3, 4, 5].includes(glyph.length) || /[^#.]/.test(glyph)) {
					throw new Error(`FONT_TEXT block ${bi + 1} contains an invalid glyph`);
				}
			}
		}
		for (let column = 0; column < characters.length; column++) {
			const character = characters[column];
			font.set(
				character,
				rows.map((_, ri) => [...columns[ri][column]].map((ch) => (ch === "#" ? 1 : 0))),
			);
		}
	}

	const sample = font.values().next().value;
	font.set(
		" ",
		sample.map((row) => row.map(() => 0)),
	);
	return font;
}

class Font {
	spacing = 1;

	constructor(def) {
		this.glyphs = parseFont(def.text, def.chars);
		this.characters = new Set(this.glyphs.keys());
		this.cellWidth = 0;
		for (const glyph of this.glyphs.values()) {
			for (const row of glyph) this.cellWidth = Math.max(this.cellWidth, row.length);
		}
		this.glyphHeight = this.glyphs.values().next().value.length;
		this._bounds = new Map();

		for (const [char, rows] of this.glyphs) {
			const inked = [];
			for (let x = 0; x < rows[0].length; x++) {
				if (rows.some((row) => row[x])) inked.push(x);
			}
			if (inked.length) {
				const left = Math.min(...inked);
				const right = Math.max(...inked) + 1;
				this._bounds.set(char, [left, right, right - left]);
			} else {
				this._bounds.set(char, [0, 0, Math.max(1, Math.floor(this.cellWidth / 2))]);
			}
		}
	}

	glyphWidth(char) {
		return this._bounds.get(char)[2];
	}

	glyphAdvance(char, monospace = false) {
		const width = monospace ? this.cellWidth : this.glyphWidth(char);
		return width + this.spacing;
	}

	measureText(text, scale = 1, monospace = false) {
		if (scale < 1) throw new Error("scale must be a positive integer");
		if (!text) return [0, this.glyphHeight * scale];
		for (const char of text) {
			if (!this.glyphs.has(char)) {
				throw new Error(`character ${JSON.stringify(char)} is not available in this font`);
			}
		}
		const width =
			[...text].reduce((sum, char) => sum + this.glyphAdvance(char, monospace), 0) - this.spacing;
		return [width * scale, this.glyphHeight * scale];
	}

	/** Paint into a grayscale buffer (0=black … 255=white). */
	renderText(buf, bufW, text, x, y, scale = 1, monospace = false, color = 0) {
		if (scale < 1) throw new Error("scale must be a positive integer");
		let cursorX = x;
		for (const char of text) {
			if (!this.glyphs.has(char)) {
				throw new Error(`character ${JSON.stringify(char)} is not available in this font`);
			}
			const [boundL] = this._bounds.get(char);
			const glyphX = cursorX + (monospace ? boundL * scale : 0);
			const glyph = this.glyphs.get(char);
			for (let gy = 0; gy < glyph.length; gy++) {
				const glyphRow = glyph[gy];
				for (let gx = 0; gx < glyphRow.length; gx++) {
					if (!glyphRow[gx]) continue;
					const targetX = monospace
						? glyphX + gx * scale
						: glyphX + (gx - boundL) * scale;
					const targetY = y + gy * scale;
					for (let py = targetY; py < targetY + scale; py++) {
						for (let px = targetX; px < targetX + scale; px++) {
							if (px < 0 || py < 0 || px >= bufW) continue;
							buf[py * bufW + px] = color;
						}
					}
				}
			}
			cursorX += this.glyphAdvance(char, monospace) * scale;
		}
		return [cursorX, y];
	}
}

const fontCache = new Map();
function fontForDef(def) {
	let f = fontCache.get(def);
	if (!f) {
		f = new Font(def);
		fontCache.set(def, f);
	}
	return f;
}

function selectFont(visual) {
	const needed = new Set(visual);
	for (const def of FONT_DEFS) {
		const available = new Set(def.chars.join(""));
		let ok = true;
		for (const ch of needed) {
			if (ch !== " " && !available.has(ch)) {
				ok = false;
				break;
			}
		}
		if (ok) return fontForDef(def);
	}
	return fontForDef(FONT_DEFS[FONT_DEFS.length - 1]);
}

function displayText(text) {
	const valid = new Set(GLYPH_CHARS_5X8.join(""));
	return [...text.trim().toUpperCase()].map((ch) => (valid.has(ch) ? ch : "?")).join("");
}

function charsPerLine(text) {
	const n = text.length;
	if ([0, 1, 2, 3, 4, 5, 7, 11].includes(n)) return n;
	const sqrt = Math.sqrt(n);
	if (sqrt === Math.floor(sqrt)) return sqrt;
	for (let numCols = 7; numCols >= 3; numCols--) {
		if (numCols > sqrt) continue;
		const numLines = Math.floor(n / numCols);
		if (n === numLines * numCols) return numLines;
	}
	let numLines = 1;
	for (;;) {
		const visualWidth = Math.ceil(n / numLines) * 2;
		const visualHeight = numLines * 3;
		if (visualHeight >= visualWidth) return Math.ceil(n / (numLines - 1));
		numLines++;
	}
}

function wrapLabel(text) {
	const cpl = charsPerLine(text);
	const lines = [];
	for (let i = 0; i < text.length; i += cpl) lines.push(text.slice(i, i + cpl));
	return lines;
}

function labelSize(lines, font, fontPixelSize, monospace = false) {
	const width = Math.max(...lines.map((line) => font.measureText(line, fontPixelSize, monospace)[0]));
	const height =
		(font.glyphHeight * lines.length + Math.max(0, lines.length - 1)) * fontPixelSize;
	return [width, height];
}

function createBuffer(width, height, fill = 255) {
	const buf = new Uint8ClampedArray(width * height);
	buf.fill(fill);
	return buf;
}

function drawQrModules(buf, bufW, modules, modulePixels) {
	const size = modules.length;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (!modules[y][x]) continue;
			const x0 = x * modulePixels;
			const y0 = y * modulePixels;
			for (let py = 0; py < modulePixels; py++) {
				const row = (y0 + py) * bufW + x0;
				for (let px = 0; px < modulePixels; px++) buf[row + px] = 0;
			}
		}
	}
}

function drawQrLabel(buf, bufW, bufH, lines, font, fontPixelSize) {
	const [width, height] = labelSize(lines, font, fontPixelSize);
	const pad = fontPixelSize;
	const modulePixels = fontPixelSize * 2;
	const bannerWidth = width + 2 * pad;
	const bannerHeight = height + 2 * pad;

	const bannerX =
		(Math.floor((bufW - bannerWidth + modulePixels) / (2 * modulePixels))) * modulePixels;
	const bannerY =
		(Math.floor((bufH - bannerHeight + modulePixels) / (2 * modulePixels))) * modulePixels;
	const x0 = bannerX + pad;
	const y0 = bannerY + pad;

	for (let row = 0; row < lines.length; row++) {
		const line = lines[row];
		const xLine = x0;
		const yLine = y0 + row * (font.glyphHeight + 1) * fontPixelSize;
		const lineWidth = font.measureText(line, fontPixelSize)[0];

		for (let y = yLine - pad; y < yLine + font.glyphHeight * fontPixelSize + pad; y++) {
			for (let x = xLine - pad; x < xLine + lineWidth + pad; x++) {
				if (x < 0 || y < 0 || x >= bufW || y >= bufH) continue;
				buf[y * bufW + x] = 255;
			}
		}
		font.renderText(buf, bufW, line, xLine, yLine, fontPixelSize);
	}
}

function drawCpLink(buf, bufW, bufH, cpCode, modulePixels = 2) {
	// Keep the footer bitmap as compact as possible; CSS scales the final PNG.
	const font = fontForDef(FONT_DEFS[FONT_DEFS.length - 1]);
	const fontPixelSize = 1;
	const padX = fontPixelSize * 2;
	// Quiet zone is 4 modules; leave a 3-module gap under the module grid,
	// plus 2 modules of padding below the footer text.
	const quiet = 4 * modulePixels;
	const gap = 3 * modulePixels;
	const padBottom = 2 * modulePixels;

	const linkText = "CP.CODES / " + wrapLabel(cpCode).join(" ");
	const [textW, textH] = labelSize([linkText], font, fontPixelSize);

	// modulesBottom = bufH - quiet; footer starts gap below that (still in quiet zone).
	const yStart = bufH - quiet + gap;
	const canvasW = Math.max(bufW, textW + padX * 2);
	const canvasH = Math.max(bufH, yStart + textH) + padBottom;
	const canvas = createBuffer(canvasW, canvasH, 255);

	const ox = Math.floor((canvasW - bufW) / 2);
	for (let y = 0; y < bufH; y++) {
		canvas.set(buf.subarray(y * bufW, y * bufW + bufW), y * canvasW + ox);
	}

	const xStart = Math.floor((canvasW - textW) / 2);
	font.renderText(canvas, canvasW, linkText, xStart, yStart, fontPixelSize, false, 120);

	return { buf: canvas, width: canvasW, height: canvasH };
}

function bufferToImageData(buf, width, height) {
	const rgba = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < buf.length; i++) {
		const v = buf[i];
		const o = i * 4;
		rgba[o] = v;
		rgba[o + 1] = v;
		rgba[o + 2] = v;
		rgba[o + 3] = 255;
	}
	return new ImageData(rgba, width, height);
}

/**
 * Encode payload at a fixed QR version (ecc H, quiet zone 4).
 * modules[y][x] === true → black.
 */
function makeModules(payload, version) {
	const qr = encodeQr(payload, {
		ecc: "H",
		minVersion: version,
		maxVersion: version,
		border: 4,
		boostEcc: false,
	});
	return qr.data;
}

/**
 * Render a CP-Code QR into an offscreen grayscale buffer.
 * Always encodes https://cp.codes/<id> (production URL), matching the prototype.
 */
export function renderCpCode(cpCode, modulePixels = 2) {
	if (!Number.isInteger(modulePixels) || modulePixels < 1) {
		throw new Error("module pixels must be a positive integer");
	}

	const id = String(cpCode).trim().toUpperCase();
	// QR payload uses a lowercase path; the page link/title use uppercase (see href).
	const qrPayload = "https://cp.codes/" + id.toLowerCase();
	const href = "https://cp.codes/" + id;
	const visual = displayText(id);
	const font = selectFont(visual);
	const lines = wrapLabel(visual);
	// Center label: half-module font pixels (prototype: module_pixels // 2).
	const fontPixelSize = Math.max(1, Math.floor(modulePixels / 2));

	// Fixed-length production URL → version 4 is the prototype's answer and
	// still scans with the center label (ecc H). Try 4..8 if 4 cannot fit.
	let modules = null;
	let version = null;
	for (let v = 4; v <= 8; v++) {
		try {
			modules = makeModules(qrPayload, v);
			version = v;
			break;
		} catch {
			// data overflow at this version
		}
	}
	if (!modules) {
		throw new Error("QR encode failed for all candidate versions");
	}

	const size = modules.length;
	const px = size * modulePixels;
	const buf = createBuffer(px, px, 255);
	drawQrModules(buf, px, modules, modulePixels);
	drawQrLabel(buf, px, px, lines, font, fontPixelSize);
	const linked = drawCpLink(buf, px, px, id, modulePixels);

	return {
		...linked,
		version,
		label: lines.join(" "),
		payload: qrPayload,
		href,
	};
}

/** Paint a CP-Code QR onto an HTML or offscreen canvas (resizes the canvas). */
export function renderCpCodeToCanvas(canvas, cpCode, modulePixels = 2) {
	const { buf, width, height, version, label, payload, href } = renderCpCode(cpCode, modulePixels);
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	ctx.putImageData(bufferToImageData(buf, width, height), 0, 0);
	return { version, label, payload, href, width, height };
}
