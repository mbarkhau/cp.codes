/**
 * Browser client: hash content → fetch challenge → search SHA-256 PoW → publish.
 * The nonce search is split across a Web Worker pool. Each worker uses native
 * Web Crypto when available and lazily loads hash-wasm as a fallback.
 */
import { detectContentType } from "./content_type.js?v=2";

const contentEl = document.getElementById("content");
const publishBtn = document.getElementById("publish");
const statusEl = document.getElementById("status");
const bytesEl = document.getElementById("bytes");
const progressEl = document.getElementById("progress");
const contentTypeEl = document.getElementById("content-type");
const detectedTypeEl = document.getElementById("detected-type");

const MAX_BYTES = 256_000;
const MAX_POW_SUBMISSION_ATTEMPTS = 2;

function setStatus(text, kind = "") {
	statusEl.textContent = text;
	statusEl.className = `status${kind ? ` ${kind}` : ""}`;
}

function setBusy(busy) {
	publishBtn.disabled = busy;
	contentEl.disabled = busy;
	contentTypeEl.disabled = busy;
	progressEl.style.display = busy ? "block" : "none";
	progressEl.setAttribute("aria-hidden", busy ? "false" : "true");
}

function updateDetection() {
	const type = contentTypeEl.value === "auto"
		? detectContentType(contentEl.value)
		: contentTypeEl.value;
	const option = [...contentTypeEl.options].find((item) => item.value === type);
	const label = option?.textContent ?? type;
	const autoOption = [...contentTypeEl.options].find((item) => item.value === "auto");
	if (autoOption) autoOption.textContent = `Auto detect (${label})`;
	detectedTypeEl.textContent = contentTypeEl.value === "auto"
		? `Detected: ${label}`
		: `Using: ${label}`;
	return type;
}

function updateBytes() {
	const n = new TextEncoder().encode(contentEl.value).byteLength;
	bytesEl.textContent = `${n.toLocaleString()} / ${MAX_BYTES.toLocaleString()} bytes`;
	updateDetection();
	return n;
}

contentEl.addEventListener("input", updateBytes);
contentTypeEl.addEventListener("change", updateDetection);
updateBytes();

let nativeSha256Available = typeof globalThis.crypto?.subtle?.digest === "function";
let wasmSha256Promise;

async function sha256Hex(text) {
	const data = new TextEncoder().encode(text);
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
	if (publishBtn.disabled) return;
	const content = contentEl.value;
	const byteLength = updateBytes();
	const contentType = updateDetection();
	if (byteLength === 0) {
		setStatus("Nothing to publish.", "err");
		return;
	}
	if (byteLength > MAX_BYTES) {
		setStatus(`Content exceeds ${MAX_BYTES} bytes.`, "err");
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

	setBusy(true);
	try {
		setStatus(`Detected ${contentType}. Hashing content…`);
		const content_hash = await sha256Hex(content);

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
					content,
					content_type: contentType,
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

		setStatus(`Published ${pasteBody.id}\n${pasteBody.url}`, "ok");
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
