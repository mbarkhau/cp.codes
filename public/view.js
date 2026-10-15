/**
 * Paste view page: fetch/decompress/render content and initialize paste actions.
 */

import { savePasteSnapshot } from './offline.js?v=2';

function loadMedia() { return import('./media.js?v=1'); }

const PASTE_CACHE_KEY = "cp.codes.paste.v1";
const PASTE_CACHE_MAX_ENTRIES = 10;

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
		const { markdownElement } = await import('./markdown.js?v=2');
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
	const { MEDIA_MIME_TYPES, mediaTypeFromBytes } = await loadMedia();
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

function removeCachedPasteContent(cpCode) {
	try {
		const parsed = JSON.parse(localStorage.getItem(PASTE_CACHE_KEY) || '[]');
		if (!Array.isArray(parsed)) return;
		const entries = parsed.filter(entry => entry && typeof entry.id === 'string').slice(-PASTE_CACHE_MAX_ENTRIES);
		const entry = entries.findLast(entry => entry.id === cpCode);
		if (!entry || !('content' in entry)) return;
		delete entry.content;
		const retained = entries.filter(candidate => candidate.id !== cpCode);
		if (entry.qr) retained.push(entry);
		localStorage.setItem(PASTE_CACHE_KEY, JSON.stringify(retained));
	} catch { /* Legacy cache cleanup is optional. */ }
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

/** Decode the existing gzip/identity response with the same bounds and integrity checks. */
export async function decodePasteResponse(response, expectedByteLength, expectedHash) {
	if (!response.ok || !response.body) throw new Error(`Could not load paste content (${response.status})`);
	if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 1 || expectedByteLength > 8 * 1024 * 1024) throw new Error('Paste metadata is invalid');
	const encoding = response.headers.get('x-content-encoding') || 'identity';
	let stream = response.body;
	if (encoding === 'gzip') {
		if (typeof DecompressionStream !== 'function') throw new Error('This browser does not support gzip decompression');
		stream = stream.pipeThrough(new DecompressionStream('gzip'));
	} else if (encoding !== 'identity') throw new Error(`Unsupported content encoding: ${encoding}`);
	const bytes = await readPasteBytes(stream, expectedByteLength);
	if (bytes.byteLength !== expectedByteLength) throw new Error(`Paste length check failed (${bytes.byteLength} != ${expectedByteLength})`);
	if (/^[0-9a-f]{64}$/.test(expectedHash) && await sha256Hex(bytes) !== expectedHash) throw new Error('Paste hash check failed');
	return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

let activePasteView = null;

export function disposePasteView() {
	activePasteView?.dispose();
	activePasteView = null;
}

/** Mount one viewer. Each mount owns its state, requests, listeners and attachment URLs. */
export function mountPasteView({ contentResponse, saveOffline = true } = {}) {
	disposePasteView();
	const controller = new AbortController();
	const signal = controller.signal;
	const cleanup = [];
	const ensureActive = () => signal.throwIfAborted();
	signal.addEventListener('abort', () => { for (const dispose of cleanup) dispose(); }, { once: true });
	let currentCopyContent = null;
	let currentCopyFile = null;
	let currentCopyType = null;
	let currentAttachments = new Map();

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
			cleanup.push(() => observer.disconnect());
		} else addEventListener('resize', update, { signal });
	}

	async function renderBundle(container, host) {
		const bundle = JSON.parse(container);
		if (bundle.format !== 'bundle-v1' || !Array.isArray(bundle.files) || bundle.files.length > 16) throw new Error('Invalid bundle');
		const attachments = new Map();
		const media = bundle.files.some(file => ['png', 'jpeg', 'webp', 'gif', 'mp3', 'mp4'].includes(file.content_type))
			? await loadMedia() : null;
		ensureActive();
		for (const file of bundle.files) {
			let blob;
			const image = ['png', 'jpeg', 'webp', 'gif'].includes(file.content_type);
			if (media?.MEDIA_MIME_TYPES[file.content_type]) {
				const match = /^data:([^;]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(file.content);
				if (!match || match[1] !== media.MEDIA_MIME_TYPES[file.content_type]) throw new Error('Invalid media file');
				blob = new Blob([Uint8Array.from(atob(match[2]), c => c.charCodeAt(0))], { type: match[1] });
			} else blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
			const url = URL.createObjectURL(blob);
			cleanup.push(() => URL.revokeObjectURL(url));
			attachments.set(file.name, { url, image, link: fileFragment(file.name) });
		}
		currentAttachments = attachments;
		const primary = bundle.files.find(file => file.name === bundle.primary);
		if (!primary) throw new Error('Primary file missing');
		const nav = document.getElementById('paste-file-nav');
		const tabs = [];
		let selection = 0;
		async function select(file, updateFragment = false) {
			const version = ++selection;
			const rendered = await renderPasteContent(file.content, file.content_type, attachments);
			if (signal.aborted || version !== selection) return;
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
			if (rendered.querySelector("pre > code[class*='language-']:not(.language-plaintext)")) {
				void import('./highlight.js?v=4').then(({ highlightPaste }) => highlightPaste(rendered)).catch(() => {});
			}
		}
		const choose = (file, updateFragment = false) => {
			void select(file, updateFragment).catch(error => {
				if (signal.aborted) return;
				const failure = document.createElement('p');
				failure.className = 'paste-load-error'; failure.setAttribute('role', 'alert');
				failure.textContent = error.message; host.replaceChildren(failure);
			});
		};
		if (nav) {
			nav.replaceChildren();
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
		}, { signal });
		const initial = fileForFragment(bundle.files) ?? primary;
		await select(initial);
		return initial.content;
	}

	async function initializePasteContent() {
		const host = document.getElementById("paste-content");
		const copyButton = document.getElementById("copy-paste");
		if (!(host instanceof HTMLElement)) return null;
		let savedResponse = null;
		const save = () => {
			if (!savedResponse) return;
			const response = savedResponse; savedResponse = null;
			const paste = {
				...JSON.parse(host.dataset.dialogMetadata), id: host.dataset.cpCode,
				format: host.dataset.format, primary: host.dataset.primary, content_type: host.dataset.contentType,
				byte_length: Number(host.dataset.byteLength), sha256: host.dataset.sha256,
				content_url: host.dataset.contentUrl, raw_url: host.dataset.rawUrl,
				type_label: host.closest('.paste-main').querySelector('.type-badge').textContent,
				hit_count: Number(response.headers.get('x-hit-count') || 0),
				moderation: { state: 'approved' }, staff_review: false, offline_cacheable: true,
			};
			void savePasteSnapshot(paste, response).then(saved => {
				if (saved && !signal.aborted) host.dataset.offlineSaved = 'true';
			});
		};
		try {
			const cpCode = host.dataset.cpCode;
			const contentUrl = host.dataset.contentUrl;
			const contentType = host.dataset.contentType || "plaintext";
			const expectedByteLength = Number(host.dataset.byteLength);
			const expectedHash = host.dataset.sha256 || "";
			if (!cpCode || !contentUrl || !Number.isSafeInteger(expectedByteLength) || expectedByteLength < 1) {
				throw new Error("Paste metadata is invalid");
			}

			// Fetch respects the endpoint's HTTP cache policy. Server access checks run
			// only when a request reaches the server; clients can retain downloaded
			// content, which cannot be revoked.
			let content = null;
			const cacheHit = content !== null;
			if (!cacheHit) {
				const response = await (contentResponse ?? fetch(contentUrl, { headers: { accept: "application/gzip" }, signal }));
				if (!response.ok || !response.body) {
					throw new Error(`Could not load paste content (${response.status})`);
				}
				ensureActive();
				updateHitCount(response);
				if (saveOffline && host.dataset.offlineCacheable === 'true' && host.dataset.staffReview !== 'true') savedResponse = response.clone();
				content = await decodePasteResponse(response, expectedByteLength, expectedHash);
			}

			ensureActive();
			if (host.dataset.format === 'bundle-v1') {
				const primaryContent = await renderBundle(content, host);
				ensureActive();
				host.setAttribute('aria-busy', 'false');
				if (copyButton instanceof HTMLButtonElement) copyButton.disabled = false;
				save();
				return primaryContent;
			}
			const rendered = await renderPasteContent(content, contentType);
			ensureActive();
			host.replaceChildren(rendered);
			currentCopyContent = content;
			currentCopyType = contentType;
			updatePasteCopyLabel(currentCopyType);
			host.setAttribute("aria-busy", "false");
			if (copyButton instanceof HTMLButtonElement) copyButton.disabled = false;
			// Enhance after plaintext is visible; CDN availability must not block the viewer.
			if (rendered.querySelector("pre > code[class*='language-']:not(.language-plaintext)")) {
				void import("./highlight.js?v=4")
					.then(({ highlightPaste }) => highlightPaste(rendered))
					.catch((error) => console.warn("Syntax highlighting unavailable", error));
			}
			removeCachedPasteContent(cpCode);
			save();
			return content;
		} catch (error) {
			void savedResponse?.body?.cancel().catch(() => {});
			if (signal.aborted) return null;
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

	const actionFeedbackTimers = new Map();
	cleanup.push(() => {
		for (const timers of actionFeedbackTimers.values()) {
			clearTimeout(timers.fade); clearTimeout(timers.clear);
		}
		actionFeedbackTimers.clear();
	});

	function showActionFeedback(status, message, kind = '') {
		if (signal.aborted || !(status instanceof HTMLElement)) return;
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

	function escapeHtml(value) {
		return String(value).replace(/[&<>"']/g, character => ({
			'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
		})[character]);
	}


	function createPasteToolbar() {
		const host = document.getElementById('paste-content');
		const toolbar = host?.closest('.paste-main')?.querySelector('.paste-head > .paste-toolbar');
		if (!(toolbar instanceof HTMLElement)) return;
		const id = escapeHtml(host.dataset.cpCode);
		toolbar.innerHTML = `
	    <p class="status paste-action-status" role="status" aria-atomic="true"><span><span class="action-feedback" id="paste-action-status"></span></span></p>
	    <nav class="paste-actions" aria-label="Paste actions">
	      <button class="icon-action" type="button" id="copy-link" title="Copy link" aria-label="Copy link" data-icon="link"></button>
	      <a class="icon-action" id="raw-paste" href="${escapeHtml(host.dataset.rawUrl)}" title="View raw content" aria-label="View raw content" data-icon="raw"></a>
	      <button class="icon-action" type="button" id="copy-paste" data-cp-code="${id}" title="Copy content" aria-label="Copy content" disabled data-icon="copy"></button>
	      <button class="icon-action" type="button" id="open-details" data-dialog="paste-details-dialog" aria-haspopup="dialog" aria-controls="paste-details-dialog" title="Paste details" aria-label="Paste details" data-icon="qr"></button>
	      <button class="icon-action report" type="button" id="open-report" data-dialog="report-dialog" aria-haspopup="dialog" aria-controls="report-dialog" title="Report paste" aria-label="Report paste" data-icon="report"></button>
	    </nav>`;
	}

	function initializePasteDialogs(contentPromise) {
		for (const button of document.querySelectorAll('[data-dialog]')) {
			let pending = false;
			button.addEventListener('click', async () => {
				if (pending) return;
				pending = true;
				try {
					const { openPasteDialog } = await import('./view_dialogs.js?v=2');
					ensureActive();
					openPasteDialog(button, { contentPromise, getAttachments: () => currentAttachments, showActionFeedback });
				} catch {
					if (signal.aborted) return;
					const status = document.getElementById('paste-action-status');
					if (status) showActionFeedback(status, 'Could not open dialog. Reload the page and try again.', 'err');
				} finally { pending = false; }
			});
		}
	}

	createPasteToolbar();

	document.getElementById('copy-link')?.addEventListener('click', async () => {
		const status = document.getElementById('paste-action-status');
		const id = document.getElementById('paste-content')?.dataset.cpCode;
		if (!(status instanceof HTMLElement) || !id) return;
		try {
			await pasteContentPromise;
			ensureActive();
			await writeToClipboard(pasteShareLink(id));
			showActionFeedback(status, 'Link copied.', 'ok');
		} catch {
			showActionFeedback(status, 'Clipboard unavailable; copy the address bar.', 'err');
		}
	});

	const pasteContentPromise = initializePasteContent();
	initializePasteCopy(pasteContentPromise);
	initializePasteDialogs(pasteContentPromise);

	const dispose = () => {
		if (signal.aborted) return;
		controller.abort();
		for (const dialog of document.querySelectorAll('.paste-dialog')) dialog.remove();
		for (const player of document.querySelectorAll('#paste-content audio, #paste-content video')) {
			player.pause(); player.removeAttribute('src'); player.load();
		}
	};
	activePasteView = { ready: pasteContentPromise, dispose };
	return activePasteView;
}

// Preserve server-rendered public and authenticated staff entry points.
if (document.getElementById('paste-content')) mountPasteView();
addEventListener('pagehide', event => { if (!event.persisted) disposePasteView(); });
