/**
 * Paste view page: fetch/decompress/render content, deletion controls, and QR.
 */

import { MEDIA_MIME_TYPES, mediaTypeFromBytes } from "./media.js?v=1";

const PASTE_CACHE_KEY = "cp.codes.paste.v1";
const PASTE_CACHE_MAX_ENTRIES = 10;
const QR_DISPLAY_SCALE = 6;
const DELETION_STORAGE_PREFIX = "cp.codes.deletion.v1:";

async function writeToClipboard(text) {
	if (typeof navigator.clipboard?.writeText === "function") {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch {
			// Fall back for browsers that expose the API but deny access to it.
		}
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.append(textarea);
	textarea.select();
	const copied = document.execCommand("copy");
	textarea.remove();
	if (!copied) throw new Error("Clipboard access was denied");
}

function isCopyableImage(contentType) {
	return ['png', 'jpeg', 'webp', 'gif'].includes(contentType);
}

function updatePasteCopyLabel(contentType) {
	const button = document.getElementById('copy-paste');
	if (!(button instanceof HTMLButtonElement)) return;
	const image = isCopyableImage(contentType);
	button.title = image ? 'Copy image as PNG' : 'Copy content';
	button.setAttribute('aria-label', image ? 'Copy image' : 'Copy content');
}

async function imageClipboardBlob(content, contentType, image) {
	// PNG can be copied directly, preserving its original resolution and transparency.
	if (contentType === 'png') {
		const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(content.trim());
		if (!match) throw new Error('PNG image content is unavailable');
		const bytes = Uint8Array.from(atob(match[1]), character => character.charCodeAt(0));
		return new Blob([bytes], { type: 'image/png' });
	}
	if (!image?.naturalWidth || !image.naturalHeight) throw new Error('Image content is unavailable');
	const canvas = document.createElement('canvas');
	canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
	try {
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Image conversion is unavailable in this browser');
		context.drawImage(image, 0, 0);
		return await new Promise((resolve, reject) => {
			canvas.toBlob(blob => {
				if (blob) resolve(blob);
				else reject(new Error('Image could not be encoded for the clipboard'));
			}, 'image/png');
		});
	} finally {
		canvas.width = 0; canvas.height = 0;
	}
}

async function writeImageToClipboard(content, contentType, image) {
	if (typeof navigator.clipboard?.write !== 'function' || typeof ClipboardItem !== 'function' ||
		(typeof ClipboardItem.supports === 'function' && !ClipboardItem.supports('image/png'))) {
		throw new Error('Image copying is unavailable in this browser. Save the image instead.');
	}
	// Start the clipboard write inside the click gesture, before asynchronous PNG encoding.
	const png = imageClipboardBlob(content, contentType, image);
	png.catch(() => {}); // A denied write may never consume the image promise.
	await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

async function sha256Hex(bytes) {
	if (typeof globalThis.crypto?.subtle?.digest !== "function") {
		throw new Error("This browser cannot verify the paste hash");
	}
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function renderMarkdown(content, attachments = new Map()) {
	try {
		const { markdownElement } = await import('./markdown.js?v=1');
		return await markdownElement(content, attachments);
	} catch {
		const pre = document.createElement('pre'); pre.className = 'paste';
		pre.textContent = content; pre.title = 'Markdown preview unavailable; showing source instead';
		return pre;
	}
}

function renderUrl(content) {
	const gate = document.createElement("div");
	gate.className = "url-gate";
	gate.id = "url-gate";

	const heading = document.createElement("h2");
	heading.textContent = "External link";
	const warning = document.createElement("p");
	warning.append("This URL leads to an ");
	const bold = document.createElement("b");
	bold.textContent = "external website";
	warning.append(bold, ".", document.createElement("br"));
	const strong = document.createElement("strong");
	strong.textContent = "cp.codes is not responsible for any external content on other websites.";
	warning.append(strong);

	const label = document.createElement("label");
	label.className = "url-activate";
	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	label.append(checkbox, " I understand — activate link");

	const valueHost = document.createElement("p");
	valueHost.className = "url-value";
	let valueElement = document.createElement("span");
	valueElement.id = "url-value";
	valueElement.textContent = content.trim();
	valueHost.append(valueElement);

	checkbox.addEventListener("change", () => {
		try {
			let replacement;
			if (checkbox.checked) {
				const url = new URL(content.trim());
				if (url.protocol !== "http:" && url.protocol !== "https:") {
					throw new Error("This paste does not contain a safe HTTP(S) URL");
				}
				replacement = Object.assign(document.createElement("a"), {
					id: "url-value",
					href: url.href,
					textContent: content.trim(),
					target: "_blank",
					rel: "nofollow noopener noreferrer",
				});
			} else {
				replacement = Object.assign(document.createElement("span"), {
					id: "url-value",
					textContent: content.trim(),
				});
			}
			valueElement.replaceWith(replacement);
			valueElement = replacement;
			checkbox.setCustomValidity("");
		} catch (error) {
			checkbox.checked = valueElement instanceof HTMLAnchorElement;
			checkbox.setCustomValidity(error instanceof Error ? error.message : String(error));
			checkbox.reportValidity();
		}
	});

	gate.append(heading, warning, label, valueHost);
	return gate;
}

async function renderMedia(content, contentType) {
	const match = /^data:(image\/(?:png|jpeg|webp|gif)|audio\/mpeg|video\/mp4);base64,([A-Za-z0-9+/]+={0,2})$/.exec(content.trim());
	const kind = contentType === "mp3" || contentType === "mp4" ? "media" : "image";
	if (!match || match[1] !== MEDIA_MIME_TYPES[contentType] || match[2].length % 4 !== 0) {
		throw new Error(`Invalid ${contentType.toUpperCase()} ${kind} data URL`);
	}
	let binary;
	try {
		binary = atob(match[2]);
	} catch {
		throw new Error(`Invalid ${contentType.toUpperCase()} ${kind} encoding`);
	}
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	if (mediaTypeFromBytes(bytes) !== contentType) {
		throw new Error(`${kind === "image" ? "Image" : "Media"} bytes are not valid ${contentType.toUpperCase()}`);
	}
	const wrapper = document.createElement("div");
	if (kind === "media") {
		wrapper.className = "paste-media-wrap";
		const player = document.createElement(contentType === "mp3" ? "audio" : "video");
		player.className = "paste-media";
		player.controls = true;
		player.preload = "metadata";
		if (contentType === "mp4") player.playsInline = true;
		player.setAttribute("aria-label", `${contentType.toUpperCase()} paste`);
		player.src = content.trim();
		wrapper.append(player);
		return wrapper;
	}
	wrapper.className = "paste-image-wrap";
	const image = document.createElement("img");
	image.className = "paste-image";
	image.src = content.trim();
	image.alt = `${contentType.toUpperCase()} paste`;
	image.decoding = "async";
	if (typeof image.decode === "function") {
		await image.decode();
	} else {
		await new Promise((resolve, reject) => {
			image.addEventListener("load", resolve, { once: true });
			image.addEventListener("error", () => reject(new Error("Image could not be decoded")), { once: true });
		});
	}
	if (image.naturalWidth < 1 || image.naturalHeight < 1) {
		throw new Error("Image has invalid dimensions");
	}
	wrapper.append(image);
	return wrapper;
}

async function renderPasteContent(content, contentType, attachments) {
	if (contentType === "markdown") return renderMarkdown(content, attachments);
	if (contentType === "url") return renderUrl(content);
	if (["png", "jpeg", "webp", "gif", "mp3", "mp4"].includes(contentType)) return renderMedia(content, contentType);
	const pre = document.createElement("pre");
	pre.className = "paste";
	const code = document.createElement("code");
	code.className = `language-${contentType}`;
	code.textContent = content;
	pre.append(code);
	return pre;
}

function readPasteCache() {
	try {
		const parsed = JSON.parse(localStorage.getItem(PASTE_CACHE_KEY) || "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((entry) => typeof entry === "object" && entry !== null && typeof entry.id === "string")
			.slice(-PASTE_CACHE_MAX_ENTRIES);
	} catch {
		return [];
	}
}

function writePasteCache(entries) {
	try {
		localStorage.setItem(PASTE_CACHE_KEY, JSON.stringify(entries));
		return true;
	} catch {
		// localStorage can be unavailable or full; viewing the paste still succeeds.
		return false;
	}
}

function findCachedPaste(entries, cpCode) {
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index].id === cpCode) return entries[index];
	}
	return null;
}

function updateCachedPaste(cpCode, patch) {
	let entries = readPasteCache();
	const existing = findCachedPaste(entries, cpCode) || { id: cpCode };
	entries = entries.filter((entry) => entry.id !== cpCode);
	entries.push({ ...existing, ...patch, id: cpCode });
	entries = entries.slice(-PASTE_CACHE_MAX_ENTRIES);
	if (writePasteCache(entries)) return;

	// Prefer the new/updated entry if the browser's storage quota is tight.
	while (entries.length > 1) {
		entries.shift();
		if (writePasteCache(entries)) return;
	}
}

function removeCachedPastePart(cpCode, part) {
	let entries = readPasteCache();
	const entry = findCachedPaste(entries, cpCode);
	if (!entry || !(part in entry)) return;
	entries = entries.filter((candidate) => candidate.id !== cpCode);
	delete entry[part];
	if (entry.content || entry.qr) entries.push(entry);
	writePasteCache(entries);
}

async function getCachedPasteContent(cpCode, contentType, expectedByteLength, expectedHash) {
	const entries = readPasteCache();
	const entry = findCachedPaste(entries, cpCode);
	const cached = entry?.content;
	if (
		typeof cached !== "object" || cached === null ||
		cached.contentType !== contentType || cached.byteLength !== expectedByteLength ||
		cached.sha256 !== expectedHash || typeof cached.value !== "string"
	) {
		return null;
	}

	const bytes = new TextEncoder().encode(cached.value);
	const validLength = bytes.byteLength === expectedByteLength;
	const validHash = !/^[0-9a-f]{64}$/.test(expectedHash) ||
		await sha256Hex(bytes) === expectedHash;
	if (validLength && validHash) return cached.value;

	// Drop corrupt content while retaining a valid QR image for this paste.
	removeCachedPastePart(cpCode, "content");
	return null;
}

function cachePasteContent(cpCode, contentType, byteLength, sha256, content) {
	updateCachedPaste(cpCode, {
		content: { contentType, byteLength, sha256, value: content },
	});
}

function updateHitCount(response) {
	const header = response.headers.get("x-hit-count");
	const count = header === null ? NaN : Number(header);
	const host = document.getElementById("paste-hit-count");
	if (!(host instanceof HTMLElement) || !Number.isSafeInteger(count) || count < 0) return;
	host.textContent = `${count.toLocaleString("en-US")} ${count === 1 ? "hit" : "hits"}`;
}

async function readPasteBytes(stream, maximum) {
	const reader = stream.getReader(); const chunks = []; let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read(); if (done) break;
			length += value.byteLength;
			if (length > maximum) { await reader.cancel(); throw new Error('Paste exceeds its declared byte length'); }
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	const result = new Uint8Array(length); let offset = 0;
	for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
	return result;
}

let currentCopyContent = null;
let currentCopyFile = null;
let currentCopyType = null;

function fileFragment(name) {
	return `#file-${encodeURIComponent(name)}`;
}

function fileForFragment(files, fragment = location.hash) {
	if (!fragment.startsWith('#file-')) return null;
	try {
		const name = decodeURIComponent(fragment.slice(6));
		return files.find(file => file.name === name) ?? null;
	} catch {
		return null;
	}
}

function pasteShareLink(id) {
	return `${location.origin}/${id}${currentCopyFile === null ? '' : fileFragment(currentCopyFile)}`;
}

function initializePasteTabsLayout(nav) {
	const measure = document.createElement('canvas').getContext('2d');
	const update = () => {
		if (!measure) { nav.classList.add('tabs-overflowing'); return; }
		let requiredWidth = 0;
		for (const button of nav.querySelectorAll('[role="tab"]')) {
			const style = getComputedStyle(button);
			const labelStyle = getComputedStyle(button.firstElementChild);
			measure.font = style.font;
			requiredWidth += measure.measureText(button.textContent).width +
				parseFloat(labelStyle.paddingLeft) + parseFloat(labelStyle.paddingRight) +
				parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
		}
		nav.classList.toggle('tabs-overflowing', Math.ceil(requiredWidth) > nav.clientWidth);
	};
	update();
	if (typeof ResizeObserver === 'function') {
		const observer = new ResizeObserver(update);
		observer.observe(nav);
		addEventListener('pagehide', event => { if (!event.persisted) observer.disconnect(); }, { once: true });
	} else addEventListener('resize', update);
}

async function renderBundle(container, host) {
	const bundle = JSON.parse(container);
	if (bundle.format !== 'bundle-v1' || !Array.isArray(bundle.files) || bundle.files.length > 16) throw new Error('Invalid bundle');
	const attachments = new Map();
	const urls = [];
	for (const file of bundle.files) {
		let blob;
		const image = ['png', 'jpeg', 'webp', 'gif'].includes(file.content_type);
		if (MEDIA_MIME_TYPES[file.content_type]) {
			const match = /^data:([^;]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(file.content);
			if (!match || match[1] !== MEDIA_MIME_TYPES[file.content_type]) throw new Error('Invalid media file');
			blob = new Blob([Uint8Array.from(atob(match[2]), c => c.charCodeAt(0))], { type: match[1] });
		} else blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
		const url = URL.createObjectURL(blob); urls.push(url);
		attachments.set(file.name, { url, image, link: fileFragment(file.name) });
	}
	for (const section of document.querySelectorAll('.paste-file-metadata')) {
		const attachment = attachments.get(section.dataset.fileName);
		const download = section.querySelector('.file-download');
		const links = section.querySelector('.paste-file-links');
		if (!attachment || !(download instanceof HTMLAnchorElement) || !(links instanceof HTMLElement)) continue;
		download.href = attachment.url;
		download.download = section.dataset.fileName;
		links.hidden = false;
	}
	addEventListener('pagehide', (event) => { if (!event.persisted) urls.forEach(url => URL.revokeObjectURL(url)); }, { once: true });
	const primary = bundle.files.find(file => file.name === bundle.primary);
	if (!primary) throw new Error('Primary file missing');
	const nav = document.getElementById('paste-file-nav');
	const tabs = [];
	let selection = 0;
	async function select(file, updateFragment = false) {
		const version = ++selection;
		const rendered = await renderPasteContent(file.content, file.content_type, attachments);
		if (version !== selection) return;
		host.replaceChildren(rendered);
		currentCopyContent = file.content;
		currentCopyFile = file.name;
		currentCopyType = file.content_type;
		updatePasteCopyLabel(currentCopyType);
		for (const button of tabs) {
			const selected = button.dataset.index === String(bundle.files.indexOf(file));
			button.setAttribute('aria-selected', String(selected));
			button.tabIndex = selected ? 0 : -1;
			if (selected) host.setAttribute('aria-labelledby', button.id);
		}
		if (updateFragment) history.replaceState(history.state, '', fileFragment(file.name));
		const raw = document.getElementById('raw-paste');
		if (raw instanceof HTMLAnchorElement) {
			raw.href = host.dataset.staffReview === 'true' ? attachments.get(file.name).url : `/${host.dataset.cpCode}/files/${encodeURIComponent(file.name)}`;
			raw.title = `View raw content: ${file.name}`;
			raw.setAttribute('aria-label', raw.title);
		}
		void import('./highlight.js?v=2').then(({ highlightPaste }) => highlightPaste(rendered)).catch(() => {});
	}
	const choose = (file, updateFragment = false) => {
		void select(file, updateFragment).catch(error => {
			const failure = document.createElement('p');
			failure.className = 'paste-load-error'; failure.setAttribute('role', 'alert');
			failure.textContent = error.message; host.replaceChildren(failure);
		});
	};
	if (nav && bundle.files.length > 1) {
		for (const [index, file] of bundle.files.entries()) {
			const button = document.createElement('button');
			button.type = 'button'; button.id = `paste-file-tab-${index}`;
			button.title = file.name || 'Unnamed'; button.dataset.name = file.name; button.dataset.index = String(index);
			button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', host.id);
			button.setAttribute('aria-selected', 'false'); button.tabIndex = -1;
			const label = document.createElement('span'); label.textContent = button.title; button.append(label);
			button.addEventListener('click', () => choose(file, true));
			nav.append(button); tabs.push(button);
		}
		host.setAttribute('role', 'tabpanel'); host.tabIndex = 0;
		nav.hidden = false;
		initializePasteTabsLayout(nav);
		nav.addEventListener('keydown', event => {
			let index = tabs.indexOf(event.target.closest?.('[role="tab"]'));
			if (index < 0) return;
			if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
			else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
			else if (event.key === 'Home') index = 0;
			else if (event.key === 'End') index = tabs.length - 1;
			else return;
			event.preventDefault(); tabs[index].focus(); choose(bundle.files[index], true);
		});
	}
	addEventListener('hashchange', () => {
		const file = fileForFragment(bundle.files) ?? (!location.hash || location.hash.startsWith('#file-') ? primary : null);
		if (file) choose(file);
	});
	const initial = fileForFragment(bundle.files) ?? primary;
	await select(initial);
	return initial.content;
}

async function initializePasteContent() {
	const host = document.getElementById("paste-content");
	const copyButton = document.getElementById("copy-paste");
	if (!(host instanceof HTMLElement)) return null;
	try {
		const cpCode = host.dataset.cpCode;
		const contentUrl = host.dataset.contentUrl;
		const contentType = host.dataset.contentType || "plaintext";
		const expectedByteLength = Number(host.dataset.byteLength);
		const expectedHash = host.dataset.sha256 || "";
		if (!cpCode || !contentUrl || !Number.isSafeInteger(expectedByteLength) || expectedByteLength < 1) {
			throw new Error("Paste metadata is invalid");
		}

		// Staff-only bodies must not enter the public viewer's persistent cache.
		const staffReview = host.dataset.staffReview === "true";
		// Always reauthorize at the server. A persistent content cache would let a
		// browser bypass a later restriction or traffic escalation.
		let content = null;
		const cacheHit = content !== null;
		if (!cacheHit) {
			const response = await fetch(contentUrl, { headers: { accept: "application/gzip" } });
			if (!response.ok || !response.body) {
				throw new Error(`Could not load paste content (${response.status})`);
			}
			updateHitCount(response);
			const encoding = response.headers.get("x-content-encoding") || "identity";
			let stream = response.body;
			if (encoding === "gzip") {
				if (typeof DecompressionStream !== "function") {
					throw new Error("This browser does not support gzip decompression");
				}
				stream = stream.pipeThrough(new DecompressionStream("gzip"));
			} else if (encoding !== "identity") {
				throw new Error(`Unsupported content encoding: ${encoding}`);
			}

			const bytes = await readPasteBytes(stream, expectedByteLength);
			if (bytes.byteLength !== expectedByteLength) {
				throw new Error(`Paste length check failed (${bytes.byteLength} != ${expectedByteLength})`);
			}
			if (/^[0-9a-f]{64}$/.test(expectedHash)) {
				const actualHash = await sha256Hex(bytes);
				if (actualHash !== expectedHash) throw new Error("Paste hash check failed");
			}
			content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		}

		if (host.dataset.format === 'bundle-v1') {
			const primaryContent = await renderBundle(content, host);
			host.setAttribute('aria-busy', 'false');
			if (copyButton instanceof HTMLButtonElement) copyButton.disabled = false;
			return primaryContent;
		}
		const rendered = await renderPasteContent(content, contentType);
		host.replaceChildren(rendered);
		currentCopyContent = content;
		currentCopyType = contentType;
		updatePasteCopyLabel(currentCopyType);
		host.setAttribute("aria-busy", "false");
		if (copyButton instanceof HTMLButtonElement) copyButton.disabled = false;
		// Enhance after plaintext is visible; CDN availability must not block the viewer.
		if (rendered.querySelector("code[class*='language-']")) {
			void import("./highlight.js?v=2")
				.then(({ highlightPaste }) => highlightPaste(rendered))
				.catch((error) => console.warn("Syntax highlighting unavailable", error));
		}
		removeCachedPastePart(cpCode, 'content');
		return content;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const failure = document.createElement("p");
		failure.className = "paste-load-error";
		failure.setAttribute("role", "alert");
		failure.textContent = `Paste could not be loaded: ${message}`;
		host.replaceChildren(failure);
		host.setAttribute("aria-busy", "false");
		return null;
	}
}

const actionFeedbackTimers = new WeakMap();

function showActionFeedback(status, message, kind = '') {
	if (!(status instanceof HTMLElement)) return;
	const previous = actionFeedbackTimers.get(status);
	if (previous) {
		clearTimeout(previous.fade);
		clearTimeout(previous.clear);
	}
	const region = status.closest('[role="status"]') ?? status;
	region.classList.toggle('ok', kind === 'ok');
	region.classList.toggle('err', kind === 'err');
	status.classList.add('action-feedback');
	status.classList.remove('is-fading');
	status.textContent = message;
	status.title = message;
	actionFeedbackTimers.set(status, {
		fade: setTimeout(() => status.classList.add('is-fading'), 5000),
		clear: setTimeout(() => {
			status.textContent = '';
			status.removeAttribute('title');
			actionFeedbackTimers.delete(status);
		}, 6000),
	});
}

function initializePasteCopy(contentPromise) {
	const button = document.getElementById("copy-paste");
	const status = document.getElementById("paste-action-status");
	if (!(button instanceof HTMLButtonElement) || !(status instanceof HTMLElement)) return;

	button.addEventListener("click", async () => {
		button.disabled = true;
		try {
			if (isCopyableImage(currentCopyType)) {
				if (typeof currentCopyContent !== 'string') throw new Error('Image content is unavailable');
				const image = document.querySelector('#paste-content img.paste-image');
				await writeImageToClipboard(currentCopyContent, currentCopyType, image);
				showActionFeedback(status, 'Image copied.', 'ok');
			} else {
				const initialContent = await contentPromise;
				const content = currentCopyContent ?? initialContent;
				if (typeof content !== "string") throw new Error("Paste content is unavailable");
				await writeToClipboard(content);
				showActionFeedback(status, 'Content copied.', 'ok');
			}
		} catch (error) {
			showActionFeedback(status, error instanceof Error ? error.message : String(error), 'err');
		} finally {
			button.disabled = false;
		}
	});
}

function initializePasteDeletion() {
	const host = document.getElementById("paste-delete");
	const button = document.getElementById("delete-paste");
	const countdown = document.getElementById("delete-countdown");
	const status = document.getElementById("paste-action-status") ?? document.getElementById("delete-status");
	if (
		!(host instanceof HTMLElement) ||
		!(button instanceof HTMLButtonElement) ||
		!(countdown instanceof HTMLElement) ||
		!(status instanceof HTMLElement)
	) {
		return;
	}

	const cpCode = button.dataset.cpCode || "";
	const storageKey = `${DELETION_STORAGE_PREFIX}${cpCode}`;
	let grant;
	try {
		grant = JSON.parse(localStorage.getItem(storageKey) || "null");
	} catch {
		return;
	}
	if (
		typeof grant !== "object" ||
		grant === null ||
		typeof grant.token !== "string" ||
		!/^[0-9a-f]{64}$/.test(grant.token) ||
		!Number.isSafeInteger(grant.expiresAt)
	) {
		try {
			localStorage.removeItem(storageKey);
		} catch {
			// Ignore unavailable storage; the invalid grant is not used.
		}
		return;
	}

	const removeGrant = () => {
		try {
			localStorage.removeItem(storageKey);
		} catch {
			// The in-memory expiry still prevents use on this page.
		}
	};
	let countdownTimer;
	const updateCountdown = () => {
		const seconds = Math.ceil((grant.expiresAt - Date.now()) / 1000);
		if (seconds <= 0) {
			if (countdownTimer !== undefined) clearInterval(countdownTimer);
			removeGrant();
			host.hidden = true;
			return false;
		}
		const minutes = Math.floor(seconds / 60);
		countdown.textContent = `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
		button.title = `Delete paste (${countdown.textContent} remaining)`;
		return true;
	};

	if (!updateCountdown()) return;
	host.hidden = false;
	countdownTimer = setInterval(updateCountdown, 250);

	button.addEventListener("click", async () => {
		if (!updateCountdown()) return;
		if (!confirm(`Delete ${cpCode}? This cannot be undone.`)) return;
		button.disabled = true;
		showActionFeedback(status, 'Deleting…');
		try {
			const response = await fetch(`/api/paste/${encodeURIComponent(cpCode)}`, {
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ deletion_token: grant.token }),
			});
			let result = null;
			try {
				result = await response.json();
			} catch {
				// Fall back to the HTTP status below.
			}
			if (!response.ok) {
				throw new Error(result?.error || `delete failed (${response.status})`);
			}
			clearInterval(countdownTimer);
			removeGrant();
			window.location.replace("/");
		} catch (error) {
			showActionFeedback(status, error instanceof Error ? error.message : String(error), 'err');
			button.disabled = false;
		}
	});
}

function initializePasteReport() {
	const form = document.getElementById("report-paste");
	const status = document.getElementById("report-status");
	if (!(form instanceof HTMLFormElement) || !(status instanceof HTMLElement)) return;
	const cpCode = form.dataset.cpCode || "";
	const submit = form.querySelector('button[type="submit"]');

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!form.reportValidity()) return;
		if (submit instanceof HTMLButtonElement) submit.disabled = true;
		showActionFeedback(status, 'Submitting…');
		const data = new FormData(form);
		try {
			const response = await fetch(`/api/paste/${encodeURIComponent(cpCode)}/report`, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({
					category: String(data.get("category") || "") || null,
					email: String(data.get("email") || "") || null,
				}),
			});
			let result = null;
			try {
				result = await response.json();
			} catch {
				// Fall back to the HTTP status below.
			}
			if (!response.ok) throw new Error(result?.error || `report failed (${response.status})`);
			form.reset();
			showActionFeedback(status, 'Report submitted. Thank you.', 'ok');
		} catch (error) {
			showActionFeedback(status, error instanceof Error ? error.message : String(error), 'err');
			if (submit instanceof HTMLButtonElement) submit.disabled = false;
		}
	});
}

function initializePasteDialogs() {
	for (const button of document.querySelectorAll('[data-dialog]')) {
		const dialog = document.getElementById(button.dataset.dialog);
		if (!(dialog instanceof HTMLDialogElement)) continue;
		button.addEventListener('click', () => dialog.showModal());
	}
	for (const dialog of document.querySelectorAll('dialog.paste-dialog')) {
		dialog.querySelector('[data-close-dialog]')?.addEventListener('click', () => dialog.close());
		dialog.addEventListener('click', (event) => {
			if (event.target !== dialog) return;
			const bounds = dialog.getBoundingClientRect();
			if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
		});
	}
}

document.getElementById('copy-link')?.addEventListener('click', async () => {
	const status = document.getElementById('paste-action-status');
	const id = document.getElementById('paste-content')?.dataset.cpCode;
	if (!(status instanceof HTMLElement) || !id) return;
	try {
		await pasteContentPromise;
		await writeToClipboard(pasteShareLink(id));
		showActionFeedback(status, 'Link copied.', 'ok');
	} catch {
		showActionFeedback(status, 'Clipboard unavailable; copy the address bar.', 'err');
	}
});

const pasteContentPromise = initializePasteContent();
initializePasteCopy(pasteContentPromise);
initializePasteDeletion();
initializePasteReport();
initializePasteDialogs();

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
	updateCachedPaste(cpCode, {
		qr: { width, height, dataUrl },
	});
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
			removeCachedPastePart(cpCode, "qr");
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
