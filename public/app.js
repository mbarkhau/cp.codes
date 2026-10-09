/**
 * Browser client: hash + gzip content → fetch challenge → solve PoW → publish.
 * The nonce search is split across a Web Worker pool. Each worker uses native
 * Web Crypto when available and lazily loads hash-wasm as a fallback.
 */
import { contentTypeForFilename, detectContentType } from "./content_type.js?v=4";

const contentEl = document.getElementById("content");
const descriptionEl = document.getElementById("description");
const filenameEl = document.getElementById("filename");
const listedEl = document.getElementById("listed");
const consentEl = document.getElementById("consent");
const moderationConsentEl = document.getElementById("consent-moderation");
const publishBtn = document.getElementById("publish");
const statusEl = document.getElementById("status");
const bytesEl = document.getElementById("bytes");
const sizeDifficultyEl = document.getElementById("size-difficulty");
const progressEl = document.getElementById("progress");
const contentTypeEl = document.getElementById("content-type");
const detectedTypeEl = document.getElementById("detected-type");
const fileInputEl = document.getElementById("file-input");
const fileButtonEl = document.getElementById("file-button");

// These mirror the server policy for immediate UI feedback. The signed
// challenge returned by the server remains authoritative.
const DEFAULT_BYTES = 10 * 1024;
const DIFFICULTY_STEP_BYTES = 100 * 1024;
const MAX_POW_SUBMISSION_ATTEMPTS = 2;
const DELETION_STORAGE_PREFIX = "cp.codes.deletion.v1:";

function removeExpiredDeletionGrants() {
	const expiredKeys = [];
	const now = Date.now();
	try {
		for (let index = 0; index < localStorage.length; index++) {
			const key = localStorage.key(index);
			if (!key?.startsWith(DELETION_STORAGE_PREFIX)) continue;
			let grant;
			try {
				grant = JSON.parse(localStorage.getItem(key) || "null");
			} catch {
				continue;
			}
			if (Number.isSafeInteger(grant?.expiresAt) && grant.expiresAt <= now) {
				expiredKeys.push(key);
			}
		}
		for (const key of expiredKeys) localStorage.removeItem(key);
	} catch {
		// Storage may be unavailable; paste creation can continue without cleanup.
	}
}

removeExpiredDeletionGrants();

function storeDeletionGrant(pasteBody) {
	const id = typeof pasteBody?.id === "string" ? pasteBody.id.toUpperCase() : "";
	const token = pasteBody?.deletion_token;
	const expiresAt = pasteBody?.deletion_expires_at;
	if (
		!/^CP(?:[0-9A-Z]{6,7}|[0-9A-Z]{10})$/.test(id) ||
		typeof token !== "string" ||
		!/^[0-9a-f]{64}$/.test(token) ||
		!Number.isSafeInteger(expiresAt) ||
		expiresAt <= Date.now()
	) {
		return false;
	}
	try {
		localStorage.setItem(
			`${DELETION_STORAGE_PREFIX}${id}`,
			JSON.stringify({ token, expiresAt }),
		);
		return true;
	} catch {
		return false;
	}
}

function setStatus(text, kind = "") {
	statusEl.textContent = text;
	statusEl.className = `status${kind ? ` ${kind}` : ""}`;
}

let isBusy = false;

function updatePublishState() {
	publishBtn.disabled = isBusy || !consentEl.checked || !moderationConsentEl.checked;
}

function setBusy(busy) {
	isBusy = busy;
	updatePublishState();
	contentEl.disabled = busy;
	descriptionEl.disabled = busy;
	filenameEl.disabled = busy;
	listedEl.disabled = busy;
	consentEl.disabled = busy;
	moderationConsentEl.disabled = busy;
	contentTypeEl.disabled = busy;
	fileInputEl.disabled = busy;
	fileButtonEl.disabled = busy;
	progressEl.style.display = busy ? "block" : "none";
	progressEl.setAttribute("aria-hidden", busy ? "false" : "true");
}

function updateDetection() {
	const filename = filenameEl.value.trim();
	const automaticType = filename
		? contentTypeForFilename(filename)
		: detectContentType(contentEl.value);
	const type = contentTypeEl.value === "auto" ? automaticType : contentTypeEl.value;
	const option = [...contentTypeEl.options].find((item) => item.value === type);
	const label = option?.textContent ?? type;
	const autoOption = [...contentTypeEl.options].find((item) => item.value === "auto");
	if (autoOption) autoOption.textContent = `Auto detect (${label})`;
	detectedTypeEl.textContent = contentTypeEl.value === "auto"
		? `${filename ? "Filename" : "Detected"}: ${label}`
		: `Using: ${label}`;
	return type;
}

function updateBytes() {
	const n = new TextEncoder().encode(contentEl.value).byteLength;
	const extraDifficultyBits = Math.ceil(
		Math.max(0, n - DEFAULT_BYTES) / DIFFICULTY_STEP_BYTES,
	);
	bytesEl.textContent = `${n.toLocaleString()} bytes`;
	sizeDifficultyEl.textContent = extraDifficultyBits === 0
		? "Base-size PoW"
		: `Size PoW +${extraDifficultyBits} ${extraDifficultyBits === 1 ? "bit" : "bits"}`;
	updateDetection();
	return n;
}

contentEl.addEventListener("input", updateBytes);
filenameEl.addEventListener("input", updateDetection);
contentTypeEl.addEventListener("change", updateDetection);
consentEl.addEventListener("change", updatePublishState);
moderationConsentEl.addEventListener("change", updatePublishState);
updateBytes();
updatePublishState();

const IMAGE_MEDIA_TYPES = {
	png: "image/png",
	jpeg: "image/jpeg",
};

function imageTypeHint(file) {
	const mediaType = file.type.toLowerCase().split(";", 1)[0];
	if (mediaType === "image/png") return "png";
	if (mediaType === "image/jpeg") return "jpeg";
	const extension = file.name.split(".").pop()?.toLowerCase();
	if (extension === "png") return "png";
	if (extension === "jpg" || extension === "jpeg") return "jpeg";
	return null;
}

function imageTypeFromBytes(bytes) {
	if (
		bytes.byteLength >= 8 &&
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
			.every((value, index) => bytes[index] === value)
	) return "png";
	if (
		bytes.byteLength >= 4 &&
		bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
		bytes[bytes.byteLength - 2] === 0xff && bytes[bytes.byteLength - 1] === 0xd9
	) return "jpeg";
	return null;
}

function imageDataUrlType(content) {
	const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(content.trim());
	if (!match || match[2].length % 4 !== 0) return null;
	try {
		const binary = atob(match[2]);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		const actualType = imageTypeFromBytes(bytes);
		return actualType === match[1] ? actualType : null;
	} catch {
		return null;
	}
}

async function verifyDecodableImage(dataUrl) {
	const image = new Image();
	image.src = dataUrl;
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
}

const TEXT_FILE_EXTENSIONS = new Set([
	"txt", "text", "url", "md", "markdown",
	"js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx",
	"py", "java", "json", "jsonl", "html", "htm", "css",
	"sh", "bash", "zsh", "fish", "sql", "yaml", "yml", "xml",
	"c", "h", "cpp", "cc", "cxx", "hh", "hpp", "hxx", "cs",
	"go", "rs", "rb", "php",
]);
const TEXT_APPLICATION_TYPES = new Set([
	"application/json",
	"application/ld+json",
	"application/sql",
	"application/xml",
	"application/yaml",
	"application/x-httpd-php",
	"application/x-javascript",
	"application/x-sh",
]);

function isTextFile(file) {
	const mediaType = file.type.toLowerCase().split(";", 1)[0];
	const dot = file.name.lastIndexOf(".");
	const extension = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
	return mediaType.startsWith("text/") ||
		TEXT_APPLICATION_TYPES.has(mediaType) ||
		TEXT_FILE_EXTENSIONS.has(extension) ||
		mediaType === "";
}

async function loadFile(file) {
	const hintedImageType = imageTypeHint(file);
	setStatus(`Reading “${file.name}”…`);
	let bytes;
	try {
		bytes = new Uint8Array(await file.arrayBuffer());
	} catch {
		setStatus(`Could not read “${file.name}”.`, "err");
		return;
	}

	let text;
	const actualImageType = imageTypeFromBytes(bytes);
	if (actualImageType) {
		if (hintedImageType && actualImageType !== hintedImageType) {
			setStatus(`File “${file.name}” does not match its PNG/JPEG type.`, "err");
			return;
		}
		text = `data:${IMAGE_MEDIA_TYPES[actualImageType]};base64,${bytesToBase64(bytes)}`;
		try {
			await verifyDecodableImage(text);
		} catch {
			setStatus(`File “${file.name}” could not be decoded as an image.`, "err");
			return;
		}
	} else {
		if (hintedImageType || !isTextFile(file)) {
			setStatus(`File “${file.name}” is not supported. Use UTF-8 text, PNG, or JPEG.`, "err");
			return;
		}
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			setStatus(`File “${file.name}” is not valid UTF-8 text.`, "err");
			return;
		}
		if (text.includes("\0")) {
			setStatus(`File “${file.name}” appears to be binary, not text.`, "err");
			return;
		}
	}

	contentEl.value = text;
	if (file.name.length <= filenameEl.maxLength) filenameEl.value = file.name;
	const storedByteLength = updateBytes();
	contentEl.focus();
	contentEl.setSelectionRange(0, 0);
	const detail = actualImageType
		? `${bytes.byteLength.toLocaleString()} image bytes; ${storedByteLength.toLocaleString()} data-URL bytes`
		: `${storedByteLength.toLocaleString()} bytes`;
	setStatus(`Loaded “${file.name}” (${detail}).`, "ok");
}

fileButtonEl.addEventListener("click", () => fileInputEl.click());
fileInputEl.addEventListener("change", () => {
	const file = fileInputEl.files?.[0];
	fileInputEl.value = "";
	if (file) void loadFile(file);
});

function dragHasFiles(event) {
	return Array.from(event.dataTransfer?.types ?? []).includes("Files") ||
		(event.dataTransfer?.files?.length ?? 0) > 0;
}

contentEl.addEventListener("dragenter", (event) => {
	if (!dragHasFiles(event) || contentEl.disabled) return;
	event.preventDefault();
	contentEl.classList.add("file-drag-active");
});
contentEl.addEventListener("dragover", (event) => {
	if (!dragHasFiles(event) || contentEl.disabled) return;
	event.preventDefault();
	if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
	contentEl.classList.add("file-drag-active");
});
contentEl.addEventListener("dragleave", () => {
	contentEl.classList.remove("file-drag-active");
});
contentEl.addEventListener("drop", (event) => {
	if (!dragHasFiles(event) || contentEl.disabled) return;
	event.preventDefault();
	contentEl.classList.remove("file-drag-active");
	const files = event.dataTransfer?.files;
	if (!files || files.length === 0) return;
	if (files.length !== 1) {
		setStatus("Drop one file at a time.", "err");
		return;
	}
	void loadFile(files[0]);
});

contentEl.addEventListener("paste", (event) => {
	let files = Array.from(event.clipboardData?.files ?? []);
	if (files.length === 0) {
		files = Array.from(event.clipboardData?.items ?? [])
			.map((item) => item.kind === "file" ? item.getAsFile() : null)
			.filter((file) => file !== null);
	}
	const images = files.filter((file) => imageTypeHint(file));
	if (images.length === 0) return;
	event.preventDefault();
	if (images.length !== 1 || files.length !== 1) {
		setStatus("Paste one PNG or JPEG image at a time.", "err");
		return;
	}
	void loadFile(images[0]);
});

let nativeSha256Available = typeof globalThis.crypto?.subtle?.digest === "function";
let wasmSha256Promise;

async function sha256Hex(input) {
	const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
	if (nativeSha256Available) {
		try {
			const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
			return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
		} catch {
			// Some older browsers expose SubtleCrypto without supporting SHA-256.
			nativeSha256Available = false;
		}
	}

	wasmSha256Promise ??= import("https://cdn.jsdelivr.net/npm/hash-wasm@4.12.0/+esm")
		.then((module) => module.sha256);
	const wasmSha256 = await wasmSha256Promise;
	return wasmSha256(data);
}

async function gzip(bytes) {
	if (typeof CompressionStream !== "function") {
		throw new Error("this browser does not support gzip compression");
	}
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bytesToBase64(bytes) {
	const chunkSize = 0x8000;
	const parts = [];
	for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
		const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
		let binary = "";
		for (let i = 0; i < chunk.byteLength; i++) binary += String.fromCharCode(chunk[i]);
		parts.push(binary);
	}
	return btoa(parts.join(""));
}

/**
 * Split the nonce range across a worker pool. Worker i searches
 * start + i, start + i + workerCount, ... so no two workers overlap.
 */
async function solvePow(challenge) {
	const { challenge_id, nonce, content_hash, difficulty, algorithm, expected_attempts_p50 } = challenge;
	if (typeof challenge.signature !== "string" || challenge.signature.length === 0) {
		throw new Error("server returned an unsigned proof-of-work challenge");
	}
	if (algorithm !== "sha256") {
		throw new Error("server returned an unsupported proof-of-work algorithm");
	}
	if (typeof Worker !== "function") {
		throw new Error("this browser does not support Web Workers");
	}

	const p50 = expected_attempts_p50 ?? Math.ceil(Math.LN2 * 2 ** difficulty);
	const average = 2 ** difficulty;
	const logicalCores = navigator.hardwareConcurrency || 4;
	const workerCount = Math.max(2, Math.min(logicalCores, 16));
	const attemptsByWorker = new Array(workerCount).fill(0);
	const implementations = new Set();
	const workers = [];
	const t0 = performance.now();
	const random = new Uint32Array(1);
	if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(random);
	else random[0] = Math.floor(Math.random() * 0x1_0000_0000);
	const rangeStart = random[0];

	setStatus(
		`Searching SHA-256 proof with ${workerCount} workers (${difficulty} zero bits)…\n` +
			`~${p50.toLocaleString()} attempts for a 50% chance ` +
			`(${average.toLocaleString()} average).`,
	);

	return new Promise((resolve, reject) => {
		let settled = false;
		const totalAttempts = () => attemptsByWorker.reduce((sum, count) => sum + count, 0);
		const stopWorkers = () => {
			for (const worker of workers) worker.terminate();
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			stopWorkers();
			reject(error);
		};
		const updateProgress = () => {
			const attempts = totalAttempts();
			const ms = Math.round(performance.now() - t0);
			const backend = implementations.size > 0 ? ` · ${[...implementations].join("/")}` : "";
			setStatus(
				`Searching SHA-256 proof… ${attempts.toLocaleString()} attempts ` +
					`(p50≈${p50.toLocaleString()}), ${(ms / 1000).toFixed(1)}s elapsed\n` +
					`${workerCount} workers${backend} · need ${difficulty} leading zero bits`,
			);
			if (attempts > p50 * 64) fail(new Error("proof search exceeded safety limit; retry publish"));
		};

		try {
			for (let workerId = 0; workerId < workerCount; workerId++) {
				const worker = new Worker("/pow_worker.js?v=1", { type: "module" });
				workers.push(worker);
				worker.addEventListener("message", (event) => {
					if (settled) return;
					const message = event.data;
					if (message?.implementation) implementations.add(message.implementation);
					if (message?.type === "progress") {
						attemptsByWorker[message.workerId] = message.attempts;
						updateProgress();
						return;
					}
					if (message?.type === "error") {
						fail(new Error(`proof worker failed: ${message.message}`));
						return;
					}
					if (message?.type === "result") {
						attemptsByWorker[message.workerId] = message.attempts;
						const attempts = totalAttempts();
						const ms = Math.round(performance.now() - t0);
						settled = true;
						stopWorkers();
						setStatus(
							`Proof found after ~${attempts.toLocaleString()} attempts across ` +
								`${workerCount} workers in ${(ms / 1000).toFixed(1)}s. Uploading…`,
						);
						resolve({
							solution: message.solution,
							pow_hash: message.powHash,
							attempts,
							ms,
						});
					}
				});
				worker.addEventListener("error", (event) => {
					event.preventDefault();
					fail(new Error(`proof worker failed: ${event.message || "unknown error"}`));
				});
			}

			for (let workerId = 0; workerId < workerCount; workerId++) {
				workers[workerId].postMessage({
					type: "start",
					workerId,
					start: rangeStart + workerId,
					stride: workerCount,
					contentHash: content_hash,
					challengeId: challenge_id,
					nonce,
					difficulty,
				});
			}
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

async function publish() {
	if (isBusy || !consentEl.checked || !moderationConsentEl.checked) return;
	const content = contentEl.value;
	const description = descriptionEl.value.trim();
	const filename = filenameEl.value.trim();
	const unlisted = !listedEl.checked;
	const byteLength = updateBytes();
	const contentType = updateDetection();
	if (byteLength === 0) {
		setStatus("Nothing to publish.", "err");
		return;
	}
	if (contentType === "url") {
		try {
			const url = new URL(content.trim());
			if ((url.protocol !== "http:" && url.protocol !== "https:") || /\s/.test(content.trim())) throw new Error();
		} catch {
			setStatus("URL content must be exactly one absolute http:// or https:// URL.", "err");
			return;
		}
	}
	if ((contentType === "png" || contentType === "jpeg") && imageDataUrlType(content) !== contentType) {
		setStatus(`Image content must be a valid base64 ${contentType.toUpperCase()} data URL.`, "err");
		return;
	}

	setBusy(true);
	try {
		if (contentType === "png" || contentType === "jpeg") {
			setStatus(`Validating ${contentType.toUpperCase()} image…`);
			await verifyDecodableImage(content.trim());
		}
		const contentBytes = new TextEncoder().encode(content);
		setStatus(`Detected ${contentType}. Hashing and compressing content…`);
		const [content_hash, compressedBytes] = await Promise.all([
			sha256Hex(contentBytes),
			gzip(contentBytes),
		]);
		const contentGzip = bytesToBase64(compressedBytes);

		let pasteBody;
		for (let attempt = 1; attempt <= MAX_POW_SUBMISSION_ATTEMPTS; attempt++) {
			setStatus(attempt === 1
				? "Requesting challenge…"
				: "Proof rejected; requesting a fresh challenge…");
			const chalRes = await fetch("/api/challenge", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content_hash, byte_length: byteLength }),
			});
			const chalBody = await chalRes.json();
			if (!chalRes.ok) {
				throw new Error(chalBody.error || `challenge failed (${chalRes.status})`);
			}

			const proof = await solvePow(chalBody);
			const pasteRes = await fetch("/api/paste", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					content_gzip: contentGzip,
					compression: "gzip",
					content_type: contentType,
					description: description || undefined,
					filename: filename || undefined,
					unlisted,
					consent: consentEl.checked,
					consent_moderation: moderationConsentEl.checked,
					challenge: chalBody,
					solution: proof.solution,
					pow_hash: proof.pow_hash,
				}),
			});
			pasteBody = await pasteRes.json();
			if (pasteRes.ok) break;

			// A forbidden proof is invalid/expired; a conflict was already used.
			// In either case, retry once with a newly issued challenge and proof.
			const retryableProofRejection = pasteRes.status === 403 || pasteRes.status === 409;
			if (!retryableProofRejection || attempt === MAX_POW_SUBMISSION_ATTEMPTS) {
				throw new Error(pasteBody.error || `upload failed (${pasteRes.status})`);
			}
		}

		const deletionGrantStored = storeDeletionGrant(pasteBody);
		if (pasteBody.moderation?.visibility === "hidden") {
			setStatus(
				`Stored ${pasteBody.id}\n${pasteBody.url}\nHidden pending moderation review; this URL is not publicly available yet.` +
					(deletionGrantStored ? "" : "\nWarning: this browser could not save the deletion token."),
			);
			return;
		}
		setStatus(
			`Published ${pasteBody.id}\n${pasteBody.url}` +
				(deletionGrantStored ? "" : "\nWarning: this browser could not save the deletion token."),
			"ok",
		);
		window.location.href = `/${pasteBody.id}`;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		setStatus(message, "err");
	} finally {
		setBusy(false);
	}
}

publishBtn.addEventListener("click", () => {
	void publish();
});

contentEl.addEventListener("keydown", (ev) => {
	if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
		ev.preventDefault();
		void publish();
	}
});

document.addEventListener("keydown", (ev) => {
	if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "p") {
		ev.preventDefault();
		updateDetection();
		void publish();
	}
});
