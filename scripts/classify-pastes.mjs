#!/usr/bin/env node
/** Read-only Jev classification CLI. Requires Node.js 22+ and DEFAPI_KEY. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { DECISIONS_URL, DEFAULT_MAX_BYTES, decisionRequest, validateDecision } from "../src/jev.mjs";
export { MODEL, CRITERIA, DEFAULT_MAX_BYTES, decisionRequest } from "../src/jev.mjs";
const TIMEOUT_MS = 60_000;
const ID_RE = /^CP(?:[0-9A-Z]{6,7}|[0-9A-Z]{10})$/;

const HELP = `Usage: npm run classify -- [PASTE_ID] [options]

Without PASTE_ID, classify the latest 20 public listed pastes.

Options:
  --base-url URL   Paste server (default: https://cp.codes)
  --max-bytes N    Skip bodies larger than N UTF-8 bytes (default: ${DEFAULT_MAX_BYTES})
  --help          Show this help

Default cap estimates a 64k-token context at 4 bytes/token with 2k tokens reserved.
Token-dense content may still exceed Jev's context; no chunking is performed.

Environment: DEFAPI_KEY (required; never sent to the paste server).
Output: one JSON object per paste; diagnostics go to stderr.
Read-only: no staff decisions are changed. Images are skipped.
`;

function normalizeId(value) {
	if (typeof value !== "string" || !ID_RE.test(value.toUpperCase())) {
		throw new Error("Expected a CP-Code paste ID (for example CP0A1B2C).");
	}
	return value.toUpperCase();
}

function optionsFromArgs(args) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			"base-url": { type: "string", default: "https://cp.codes" },
			"max-bytes": { type: "string", default: String(DEFAULT_MAX_BYTES) },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) return { help: true };
	if (positionals.length > 1) throw new Error("Pass at most one paste ID.");
	const baseUrl = new URL(values["base-url"]);
	if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password ||
		baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
		throw new Error("--base-url must be an HTTP(S) origin without credentials, a path, or a query.");
	}
	const maxBytes = Number(values["max-bytes"]);
	if (!/^\d+$/.test(values["max-bytes"]) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new Error("--max-bytes must be a positive integer.");
	}
	return { baseUrl: baseUrl.origin, maxBytes, id: positionals.length ? normalizeId(positionals[0]) : null };
}

/** Bound both response time and bytes; do not follow redirects with credentials. */
async function fetchBytes(fetchImpl, url, options, maxBytes, label) {
	let response;
	try {
		response = await fetchImpl(url, {
			...options,
			redirect: "error",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		const details = [...new Set([err.message ?? String(err), err.cause?.code, err.cause?.message].filter(Boolean))].join("; ");
		const hint = label === "Jev" ? "" : " Check --base-url; for local pastes, start make dev.";
		throw new Error(`${label} (${url}): ${details}.${hint}`);
	}
	if (!response.ok) {
		await response.body?.cancel();
		// Do not echo error bodies: they could contain paste content or credentials.
		throw new Error(`${label}: HTTP ${response.status}`);
	}
	if (!response.body) throw new Error(`${label}: empty response`);
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new Error(`${label}: response exceeds byte limit`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, size);
}

async function fetchJson(fetchImpl, url, options, label) {
	const bytes = await fetchBytes(fetchImpl, url, options, 128 * 1024, label);
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error(`${label}: invalid JSON response`);
	}
}

async function classifyPaste(id, { baseUrl, maxBytes, key, fetchImpl }) {
	const metadata = await fetchJson(fetchImpl, `${baseUrl}/api/paste/${id}`, {}, "Paste metadata");
	if (metadata?.id !== id || typeof metadata.content_type !== "string" ||
		!Number.isSafeInteger(metadata.byte_length) || metadata.byte_length < 0) {
		throw new Error("Paste metadata: invalid response");
	}
	if (metadata.content_type === "png" || metadata.content_type === "jpeg") {
		return { id, status: "skipped", reason: "image moderation is not supported by the documented Jev API" };
	}
	if (metadata.byte_length > maxBytes) {
		return { id, status: "skipped", reason: "paste exceeds --max-bytes", byte_length: metadata.byte_length };
	}
	if (!['gzip', 'identity'].includes(metadata.content_encoding)) {
		throw new Error("Paste metadata: unsupported content encoding");
	}
	// Construct the content route ourselves instead of trusting content_url from a server.
	const stored = await fetchBytes(fetchImpl, `${baseUrl}/api/paste/${id}/content`, {},
		maxBytes * 2 + 1024, "Paste content");
	const bytes = metadata.content_encoding === "gzip"
		? gunzipSync(stored, { maxOutputLength: maxBytes }) : stored;
	if (bytes.length !== metadata.byte_length ||
		createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) {
		throw new Error("Paste content: length or SHA-256 mismatch");
	}
	const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const result = await fetchJson(fetchImpl, DECISIONS_URL, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify(decisionRequest(metadata, content)),
	}, "Jev");
	return {
		id,
		status: "classified",
		...validateDecision(result),
	};
}

/** Injectable I/O for tests; no network calls occur merely by importing this module. */
export async function run({
	args = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch,
	stdout = (line) => console.log(line), stderr = (line) => console.error(line),
} = {}) {
	try {
		const options = optionsFromArgs(args);
		if (options.help) {
			stdout(HELP);
			return 0;
		}
		const key = env.DEFAPI_KEY?.trim();
		if (!key) throw new Error("DEFAPI_KEY is not set. Export it in your shell before running this command.");
		let ids;
		if (options.id) {
			ids = [options.id];
		} else {
			const page = await fetchJson(fetchImpl, `${options.baseUrl}/api/pastes?limit=20`, {}, "Recent pastes");
			if (!Array.isArray(page?.items)) throw new Error("Recent pastes: invalid response");
			ids = page.items.slice(0, 20).map((item) => normalizeId(item.id));
		}
		let failed = false;
		for (const id of ids) {
			try {
				stdout(JSON.stringify(await classifyPaste(id, { ...options, key, fetchImpl })));
			} catch (err) {
				failed = true;
				// Defensive redaction in case a network implementation includes headers in an error.
				const message = String(err.message ?? err).replaceAll(key, "[redacted]");
				stdout(JSON.stringify({ id, status: "error", error: message }));
				stderr(`${id}: ${message}`);
			}
		}
		return failed ? 1 : 0;
	} catch (err) {
		const key = env.DEFAPI_KEY?.trim();
		const message = String(err.message ?? err);
		stderr(key ? message.replaceAll(key, "[redacted]") : message);
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = await run();
}
