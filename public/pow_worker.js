/**
 * SHA-256 PoW worker. Each worker searches one interleaved nonce range:
 * start + workerId, start + workerId + workerCount, ...
 */

let nativeSha256Available = typeof globalThis.crypto?.subtle?.digest === "function";
let wasmSha256Promise;
let implementation = nativeSha256Available ? "Web Crypto" : "WASM";

async function sha256Hex(text) {
	const data = new TextEncoder().encode(text);
	if (nativeSha256Available) {
		try {
			const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
			return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		} catch {
			nativeSha256Available = false;
			implementation = "WASM";
		}
	}

	wasmSha256Promise ??= import("https://cdn.jsdelivr.net/npm/hash-wasm@4.12.0/+esm")
		.then((module) => module.sha256);
	const wasmSha256 = await wasmSha256Promise;
	return wasmSha256(data);
}

function leadingZeroBits(hashHex) {
	let bits = 0;
	for (let i = 0; i < hashHex.length; i += 2) {
		const byte = Number.parseInt(hashHex.slice(i, i + 2), 16);
		if (byte === 0) {
			bits += 8;
			continue;
		}
		for (let mask = 0x80; mask !== 0; mask >>= 1) {
			if ((byte & mask) !== 0) return bits;
			bits++;
		}
		return bits;
	}
	return bits;
}

async function search(message) {
	const { workerId, start, stride, contentHash, challengeId, nonce, difficulty } = message;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(stride) || stride < 1) {
		throw new Error("invalid worker nonce range");
	}

	let solution = start;
	let attempts = 0;
	for (;;) {
		const solutionString = String(solution);
		const input = `${contentHash}:${challengeId}:${nonce}:${solutionString}`;
		const powHash = await sha256Hex(input);
		attempts++;

		if (leadingZeroBits(powHash) >= difficulty) {
			globalThis.postMessage({
				type: "result",
				workerId,
				solution: solutionString,
				powHash,
				attempts,
				implementation,
			});
			return;
		}

		solution += stride;
		if (!Number.isSafeInteger(solution)) throw new Error("solution counter exhausted");
		if (attempts % 512 === 0) {
			globalThis.postMessage({ type: "progress", workerId, attempts, implementation });
		}
	}
}

globalThis.addEventListener("message", (event) => {
	if (event.data?.type !== "start") return;
	void search(event.data).catch((error) => {
		globalThis.postMessage({
			type: "error",
			workerId: event.data.workerId,
			message: error instanceof Error ? error.message : String(error),
		});
	});
});
