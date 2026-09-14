/**
 * Paste view page: restore a cached CP-Code QR or generate it on the client.
 */

const QR_CACHE_KEY = "cp.codes.qr.png.v2";
const QR_DISPLAY_SCALE = 3;

const activateUrlCheckbox = document.getElementById("activate-url");
if (activateUrlCheckbox instanceof HTMLInputElement && activateUrlCheckbox.type === "checkbox") {
	activateUrlCheckbox.addEventListener("change", () => {
		const valueEl = document.getElementById("url-value");
		try {
			if (!(valueEl instanceof HTMLSpanElement || valueEl instanceof HTMLAnchorElement)) {
				throw new Error("URL is unavailable");
			}
			const value = valueEl.textContent.trim();
			let replacement;
			if (activateUrlCheckbox.checked) {
				const url = new URL(value);
				if (url.protocol !== "http:" && url.protocol !== "https:") {
					throw new Error("This paste does not contain a safe HTTP(S) URL");
				}
				replacement = Object.assign(document.createElement("a"), {
					id: "url-value",
					href: url.href,
					textContent: value,
					target: "_blank",
					rel: "nofollow noopener noreferrer",
				});
			} else {
				replacement = Object.assign(document.createElement("span"), {
					id: "url-value",
					textContent: value,
				});
			}
			valueEl.replaceWith(replacement);
			activateUrlCheckbox.setCustomValidity("");
		} catch (err) {
			activateUrlCheckbox.checked = valueEl instanceof HTMLAnchorElement;
			activateUrlCheckbox.setCustomValidity(err instanceof Error ? err.message : String(err));
			activateUrlCheckbox.reportValidity();
		}
	});
}

function firstPaintTiming(timestamp) {
	const firstPaint = performance.getEntriesByName("first-paint", "paint")[0];
	if (!firstPaint) return "";
	const delta = timestamp - firstPaint.startTime;
	return delta >= 0
		? `; ${delta.toFixed(2)} ms since first paint`
		: `; ${Math.abs(delta).toFixed(2)} ms before first paint`;
}

function waitForImage(image) {
	if (image.complete) {
		return image.naturalWidth > 0
			? Promise.resolve()
			: Promise.reject(new Error("Cached QR image could not be decoded"));
	}
	if (typeof image.decode === "function") return image.decode();
	return new Promise((resolve, reject) => {
		image.addEventListener("load", resolve, { once: true });
		image.addEventListener("error", () => reject(new Error("QR image could not be decoded")), { once: true });
	});
}

function blobToDataUrl(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener("load", () => resolve(reader.result), { once: true });
		reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not encode QR PNG")), { once: true });
		reader.readAsDataURL(blob);
	});
}

async function canvasToPngDataUrl(canvas) {
	if (canvas instanceof HTMLCanvasElement) return canvas.toDataURL("image/png");
	const blob = await canvas.convertToBlob({ type: "image/png" });
	const dataUrl = await blobToDataUrl(blob);
	if (typeof dataUrl !== "string") throw new Error("Could not encode QR PNG");
	return dataUrl;
}

function describePng(dataUrl) {
	try {
		const prefix = "data:image/png;base64,";
		if (!dataUrl.startsWith(prefix)) throw new Error("not a base64 PNG data URL");

		const base64 = dataUrl.slice(prefix.length);
		const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
		const sizeBytes = Math.floor(base64.length * 3 / 4) - padding;
		const header = atob(base64.slice(0, 40));
		const byteAt = (offset) => header.charCodeAt(offset);
		const signature = [137, 80, 78, 71, 13, 10, 26, 10];
		if (header.length < 26 || !signature.every((byte, offset) => byteAt(offset) === byte)) {
			throw new Error("invalid PNG header");
		}
		if (header.slice(12, 16) !== "IHDR") throw new Error("missing PNG IHDR");

		const uint32At = (offset) =>
			byteAt(offset) * 0x1000000 + byteAt(offset + 1) * 0x10000 + byteAt(offset + 2) * 0x100 + byteAt(offset + 3);
		const width = uint32At(16);
		const height = uint32At(20);
		const bitDepth = byteAt(24);
		const colorType = byteAt(25);
		const colorFormats = {
			0: ["grayscale", 1],
			2: ["RGB", 3],
			3: ["indexed color", 1],
			4: ["grayscale + alpha", 2],
			6: ["RGBA", 4],
		};
		const [colorFormat, channels] = colorFormats[colorType] ?? [`unknown type ${colorType}`, 1];
		const formattedSize = sizeBytes >= 1024
			? `${sizeBytes} bytes (${(sizeBytes / 1024).toFixed(2)} KiB)`
			: `${sizeBytes} bytes`;

		return `PNG metadata: size ${formattedSize}; resolution ${width}×${height} px; ` +
			`color depth ${bitDepth * channels} bits/pixel (${bitDepth}-bit ${colorFormat})`;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return `PNG metadata unavailable: ${message}`;
	}
}

function setQrDimensions(image, width, height) {
	const displayWidth = width * QR_DISPLAY_SCALE;
	const displayHeight = height * QR_DISPLAY_SCALE;
	image.width = width;
	image.height = height;
	image.style.width = `${displayWidth}px`;
	image.style.height = `${displayHeight}px`;
	const host = image.closest(".paste-qr");
	if (host instanceof HTMLElement) {
		host.style.setProperty("--qr-w", `${displayWidth}px`);
		host.style.setProperty("--qr-h", `${displayHeight}px`);
	}
}

function cacheQrImage(cpCode, width, height, dataUrl) {
	try {
		localStorage.setItem(QR_CACHE_KEY, JSON.stringify({ id: cpCode, width, height, dataUrl }));
	} catch {
		// localStorage can be unavailable or full; displaying the image still succeeds.
	}
}

async function initializeQrImage(image) {
	const cpCode = image.dataset.cpCode || "";
	const link = document.getElementById("qr-link");

	// The inline script assigns a cached data URL before this module runs. A cache
	// hit therefore avoids importing qr_text.js and its QR encoder dependency.
	if (image.dataset.qrCacheHit === "true") {
		try {
			await waitForImage(image);
			const readyAt = performance.now();
			const restored = performance.getEntriesByName("qr-cache-restored").at(-1);
			const decodeMs = restored ? `; decoded in ${(readyAt - restored.startTime).toFixed(2)} ms` : "";
			console.info(
				`[QR] Cached PNG image ready at ${readyAt.toFixed(2)} ms since navigation start` +
					`${decodeMs}${firstPaintTiming(readyAt)}; ${describePng(image.currentSrc || image.src)}`,
			);
			return;
		} catch {
			delete image.dataset.qrCacheHit;
			image.removeAttribute("src");
			try {
				localStorage.removeItem(QR_CACHE_KEY);
			} catch {
				// Continue by generating a fresh image.
			}
		}
	}

	try {
		const moduleLoadStartedAt = performance.now();
		const { renderCpCodeToCanvas } = await import("./qr_text.js");
		const renderStartedAt = performance.now();
		const offscreen = typeof OffscreenCanvas === "function"
			? new OffscreenCanvas(1, 1)
			: document.createElement("canvas");
		const info = renderCpCodeToCanvas(offscreen, cpCode);
		const qrRenderedAt = performance.now();
		const dataUrl = await canvasToPngDataUrl(offscreen);
		const pngEncodedAt = performance.now();

		const href = info.href || `https://cp.codes/${cpCode.toUpperCase()}`;
		image.title = href;
		if (link instanceof HTMLAnchorElement) {
			link.href = href;
			link.title = href;
		}
		setQrDimensions(image, info.width, info.height);
		cacheQrImage(cpCode, info.width, info.height, dataUrl);
		image.src = dataUrl;
		await waitForImage(image);
		const imageReadyAt = performance.now();

		console.info(
			`[QR] PNG image ready in ${(imageReadyAt - renderStartedAt).toFixed(2)} ms ` +
				`(module load ${(renderStartedAt - moduleLoadStartedAt).toFixed(2)} ms; ` +
				`QR render ${(qrRenderedAt - renderStartedAt).toFixed(2)} ms; ` +
				`PNG encode ${(pngEncodedAt - qrRenderedAt).toFixed(2)} ms; ` +
				`image decode ${(imageReadyAt - pngEncodedAt).toFixed(2)} ms; ` +
				`${imageReadyAt.toFixed(2)} ms since navigation start${firstPaintTiming(imageReadyAt)}); ` +
				describePng(dataUrl),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const fallback = Object.assign(document.createElement("p"), {
			className: "status err",
			textContent: `QR failed: ${message}`,
		});
		(link ?? image).replaceWith(fallback);
	}
}

const image = document.getElementById("qr");
if (image instanceof HTMLImageElement) void initializeQrImage(image);
