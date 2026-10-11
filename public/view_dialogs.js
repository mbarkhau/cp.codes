/** Paste dialogs and QR rendering, loaded only when a dialog is opened. */
const PASTE_CACHE_KEY = "cp.codes.paste.v1";
const PASTE_CACHE_MAX_ENTRIES = 10;
const QR_DISPLAY_SCALE = 6;

function initializePasteReport(showActionFeedback) {
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

function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, character => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	})[character]);
}


function appendPasteDialog(id, headingId, heading, closeLabel, content, className = '') {
	const template = document.createElement('template');
	template.innerHTML = `<dialog class="paste-dialog ${className}" id="${id}" aria-labelledby="${headingId}">
  <div class="paste-dialog-head"><h2 id="${headingId}">${heading}</h2><button type="button" class="icon-action" data-close-dialog title="${closeLabel}" aria-label="${closeLabel}" data-icon="close"></button></div>
  ${content}
</dialog>`;
	document.body.append(template.content);
}

function fileMetadataSection(paste) {
	const files = paste.files ?? [{ name: paste.filename ?? 'Unnamed file', content_type: paste.content_type, byte_length: paste.byte_length, sha256: paste.sha256 }];
	return `<section><h3>File metadata</h3>${files.map(file => `<section class="paste-file-metadata" data-file-name="${escapeHtml(file.name)}">
      <h3>${escapeHtml(file.name)}${file.name === paste.primary ? ' · Main' : ''}</h3>
      <dl class="pow-fields"><dt>Content type</dt><dd>${escapeHtml(file.content_type)}</dd><dt>Size</dt><dd>${escapeHtml(file.byte_length)} bytes</dd><dt>SHA-256</dt><dd>${escapeHtml(file.sha256)}</dd></dl>
      ${paste.format === 'bundle-v1' ? `<div class="paste-file-links" hidden><a class="icon-action file-download" aria-label="Download ${escapeHtml(file.name)}" title="Download file" data-icon="download"></a><a class="icon-action" href="/${escapeHtml(paste.id)}/files/${escapeHtml(encodeURIComponent(file.name))}" aria-label="Permalink to ${escapeHtml(file.name)}" title="File permalink" data-icon="link"></a></div>` : ''}
    </section>`).join('')}</section>`;
}

function proofOfWorkSection(proof) {
	if (!proof) return '<section><h3>Upload proof &amp; integrity</h3><p class="meta">No proof-of-work details available.</p></section>';
	const fields = [
		['Algorithm', 'SHA-256'], ['Difficulty', `${proof.difficulty} leading zero bits`],
		['Result', `${proof.leading_zero_bits} leading zero bits`], ['Solution', proof.solution],
		['Challenge', proof.challenge_id], ['Server nonce', proof.nonce], ['Proof hash', proof.pow_hash],
	];
	return `<section><h3>Upload proof &amp; integrity</h3><dl class="pow-fields">${fields.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl></section>`;
}

function createPasteDialog(button, showActionFeedback) {
	const dialogId = button.dataset.dialog;
	const host = document.getElementById('paste-content');
	if (!(host instanceof HTMLElement)) return;
	const paste = {
		...JSON.parse(host.dataset.dialogMetadata),
		id: host.dataset.cpCode, content_type: host.dataset.contentType,
		byte_length: Number(host.dataset.byteLength), sha256: host.dataset.sha256,
		format: host.dataset.format, primary: host.dataset.primary,
	};
	const id = escapeHtml(paste.id);
	if (dialogId === 'report-dialog') {
		appendPasteDialog('report-dialog', 'report-heading', 'Report suspected illegal content', 'Close report', `
  <form id="report-paste" data-cp-code="${id}">
    <label><span>Reason (optional)</span><select name="category">
      <option value="">Select a reason</option>
      ${paste.report_categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('')}
    </select></label>
    <label><span>Email (optional)</span><input type="email" name="email" maxlength="${escapeHtml(paste.max_report_email_chars)}" autocomplete="email" /></label>
    <button type="submit">Submit report</button>
    <p class="status" role="status" aria-atomic="true"><span class="action-feedback" id="report-status"></span></p>
  </form>`, 'report-panel');
		initializePasteReport(showActionFeedback);
		return;
	}
	if (dialogId !== 'paste-details-dialog') return;
	const qrHref = `https://cp.codes/${paste.id.toUpperCase()}`;
	appendPasteDialog('paste-details-dialog', 'paste-details-heading', 'Paste details', 'Close details', `
  <div class="paste-details">
    <aside class="paste-qr" aria-label="QR code">
      <a id="qr-link" href="${escapeHtml(qrHref)}" title="${escapeHtml(qrHref)}">
        <img id="qr" data-cp-code="${id}" width="53" height="53" decoding="sync" draggable="false" alt="QR code linking to ${id}" />
      </a>
    </aside>
    <div>
      <dl class="pow-fields"><dt>Paste</dt><dd>${id}</dd><dt>Created</dt><dd>${escapeHtml(paste.created_at)}</dd><dt>Total size</dt><dd>${paste.byte_length} bytes</dd><dt>Stored size</dt><dd>${escapeHtml(paste.compressed_byte_length)} bytes (${escapeHtml(paste.content_encoding)})</dd><dt>Container SHA-256</dt><dd>${escapeHtml(paste.sha256)}</dd><dt>Visibility</dt><dd>${paste.unlisted ? 'Unlisted' : 'Listed'}</dd></dl>
      ${fileMetadataSection(paste)}
      ${proofOfWorkSection(paste.proof_of_work)}
    </div>
  </div>`);
}


function updateDownloadLinks(dialog, attachments) {
	for (const section of dialog.querySelectorAll('.paste-file-metadata')) {
		const attachment = attachments.get(section.dataset.fileName);
		const download = section.querySelector('.file-download');
		const links = section.querySelector('.paste-file-links');
		if (!attachment || !(download instanceof HTMLAnchorElement) || !(links instanceof HTMLElement)) continue;
		download.href = attachment.url;
		download.download = section.dataset.fileName;
		links.hidden = false;
	}
}

export function openPasteDialog(button, options) {
	const id = button.dataset.dialog;
	let dialog = document.getElementById(id);
	if (!(dialog instanceof HTMLDialogElement)) {
		createPasteDialog(button, options.showActionFeedback);
		dialog = document.getElementById(id);
		if (!(dialog instanceof HTMLDialogElement)) throw new Error('Dialog unavailable');
		dialog.querySelector('[data-close-dialog]')?.addEventListener('click', () => dialog.close());
		dialog.addEventListener('click', event => {
			if (event.target !== dialog) return;
			const bounds = dialog.getBoundingClientRect();
			if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
		});
		if (id === 'paste-details-dialog') {
			updateDownloadLinks(dialog, options.getAttachments());
			// Details can be opened while the preloaded body is still downloading.
			void options.contentPromise.then(() => updateDownloadLinks(dialog, options.getAttachments()));
		}
	}
	if (dialog.open) return;
	dialog.showModal();
	const image = dialog.querySelector('#qr');
	if (image instanceof HTMLImageElement && !image.dataset.qrInitialized) {
		image.dataset.qrInitialized = 'true';
		void initializeQrImage(image);
	}
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

function restoreCachedQrImage(image) {
	try {
		for (const key of ['cp.codes.qr.v1', 'cp.codes.qr.png.v1', 'cp.codes.qr.png.v2',
			'cp.codes.qr.png.v3', 'cp.codes.qr.png.v4', 'cp.codes.qr.png.v5', 'cp.codes.content.v1']) {
			localStorage.removeItem(key);
		}
		const qr = findCachedPaste(readPasteCache(), image.dataset.cpCode)?.qr;
		if (!qr || !Number.isInteger(qr.width) || qr.width < 1 || qr.width > 512 ||
			!Number.isInteger(qr.height) || qr.height < 1 || qr.height > 512 ||
			typeof qr.dataUrl !== 'string' || !qr.dataUrl.startsWith('data:image/png;base64,') ||
			qr.dataUrl.length > 200000) return;
		setQrDimensions(image, qr.width, qr.height);
		image.src = qr.dataUrl;
		image.dataset.qrCacheHit = 'true';
	} catch {
		// Storage can be unavailable; initializeQrImage will render a fresh PNG.
	}
}

async function initializeQrImage(image) {
	const cpCode = image.dataset.cpCode || "";
	const link = document.getElementById("qr-link");

	restoreCachedQrImage(image);
	// A valid cached PNG avoids rendering and encoding the QR again.
	if (image.dataset.qrCacheHit === "true") {
		try {
			await waitForImage(image);
			return;
		} catch {
			delete image.dataset.qrCacheHit;
			image.removeAttribute("src");
			removeCachedPastePart(cpCode, "qr");
		}
	}

	try {
		const { renderCpCodeToCanvas } = await import("./qr_text.js?v=2");
		const offscreen = typeof OffscreenCanvas === "function"
			? new OffscreenCanvas(1, 1)
			: document.createElement("canvas");
		const info = renderCpCodeToCanvas(offscreen, cpCode);
		const dataUrl = await canvasToPngDataUrl(offscreen);

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
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const fallback = Object.assign(document.createElement("p"), {
			className: "status err",
			textContent: `QR failed: ${message}`,
		});
		(link ?? image).replaceWith(fallback);
	}
}
