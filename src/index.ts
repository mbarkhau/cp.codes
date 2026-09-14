/**
 * CP-Codes — Cloudflare Worker entrypoint.
 *
 * Local:   npm run dev   → http://localhost:8787
 * Deploy:  npm run deploy
 * Types:   npm run cf-typegen  (after changing wrangler.jsonc bindings)
 *
 * Pages:
 *   GET  /              pastebin UI
 *   GET  /:id           HTML view of a paste
 *   GET  /:id.:ext      raw content with its content-type extension
 *
 * API:
 *   GET  /health
 *   GET  /debug
 *   POST /api/challenge  issue SHA-256 PoW challenge (bound to content hash)
 *   POST /api/paste      verify PoW, mint CP-Code, store paste
 *   GET  /api/paste/:id  JSON paste + metadata
 *   GET  /api/pastes     recent uploads (newest first)
 */

import * as cpCode from "./cp_code";
import * as region from "./region";
import * as clock from "./mono_clock";
import * as pow from "./pow";
import * as paste from "./paste";
import * as ui from "./ui";
import * as contentType from "./content_type";

export { MonoClock } from "./mono_clock";
export { PowKey } from "./pow";
export { PasteIndex } from "./paste";

const CP_ID_RE = /^CP[0-9A-Za-z]{6,7}$/;
const POW_RATE_WINDOW_MS = pow.POW_DEFAULTS.rateWindowSeconds * 1000;

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function error(message: string, status = 400): Response {
	return json({ error: message }, status);
}

function wantsHtml(request: Request): boolean {
	const accept = request.headers.get("accept") ?? "";
	if (accept.includes("text/html")) return true;
	// Navigations usually prefer HTML even with broad Accept.
	const mode = request.headers.get("sec-fetch-mode");
	return mode === "navigate";
}

/** Cloudflare sets this to the originating client address at the edge. */
function clientIpFromRequest(request: Request): string | null {
	const value = request.headers.get("cf-connecting-ip")?.trim();
	return value || null;
}

function monoClock(
	env: Env,
	resolved: region.ResolvedRegion,
): DurableObjectStub<clock.MonoClock> {
	return env.MONO_CLOCK.getByName(clock.clockName(resolved.location_hint), {
		locationHint: resolved.location_hint,
	});
}

async function mintId(env: Env, request: Request): Promise<{ id: string; parts: cpCode.CPCode; resolved: region.ResolvedRegion }> {
	const resolved = region.regionFromRequest(request);
	const maxCounter = 2 ** cpCode.COUNTER_BITS_BY_VERSION[cpCode.CURRENT_VERSION];
	const { timestamp, counter } = await monoClock(env, resolved).next(
		cpCode.TIME_RESOLUTION,
		maxCounter,
	);
	const parts = cpCode.generateCpCode(resolved.region_id, timestamp, counter);
	const id = cpCode.encodeCpCode(parts);
	return { id, parts, resolved };
}

function headersToObject(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of headers) {
		out[key] = key in out ? `${out[key]}, ${value}` : value;
	}
	return out;
}

function searchParamsToObject(params: URLSearchParams): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	for (const key of new Set(params.keys())) {
		const values = params.getAll(key);
		out[key] = values.length === 1 ? values[0]! : values;
	}
	return out;
}

function envBindingSummary(env: Env): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(env as object).sort()) {
		const value = (env as unknown as Record<string, unknown>)[key];
		const type = value === null ? "null" : typeof value;
		out[key] =
			type === "object" && value !== null
				? (Object.getPrototypeOf(value)?.constructor?.name ?? "object")
				: type;
	}
	return out;
}

function debugPayload(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	url: URL,
	path: string,
): Record<string, unknown> {
	return {
		service: "cp.codes",
		generated_at: new Date().toISOString(),
		worker_now_ms: Date.now(),
		pow: pow.powConfigFromEnv(env),
		request: {
			method: request.method,
			url: request.url,
			headers: headersToObject(request.headers),
			cf: request.cf ?? null,
		},
		url: {
			href: url.href,
			pathname: url.pathname,
			normalized_path: path,
			searchParams: searchParamsToObject(url.searchParams),
		},
		env_bindings: envBindingSummary(env),
		ctx: {
			props: ctx.props ?? null,
		},
	};
}

async function handleChallenge(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return error("invalid JSON body");
	}
	const rec = body as Record<string, unknown>;
	const contentHash = rec.content_hash;
	const byteLength = rec.byte_length;

	if (!pow.isContentHash(contentHash)) {
		return error("content_hash must be a 64-char sha256 hex digest");
	}
	if (typeof byteLength !== "number" || !Number.isInteger(byteLength) || byteLength < 1) {
		return error("byte_length must be a positive integer");
	}
	if (byteLength > paste.MAX_PASTE_BYTES) {
		return error(`byte_length exceeds ${paste.MAX_PASTE_BYTES}`);
	}

	const config = pow.powConfigFromEnv(env);
	const windowStart = Date.now() - POW_RATE_WINDOW_MS;
	const recentPasteCount = await paste.countPastesCreatedSince(env, windowStart);
	const difficulty = pow.difficultyForRecentPastes(
		config.difficultyBits,
		recentPasteCount,
	);
	const challenge = await pow.issueChallenge(env, {
		contentHash,
		byteLength,
		difficulty,
	});
	return json(challenge);
}

async function handleCreatePaste(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return error("invalid JSON body");
	}
	const rec = body as Record<string, unknown>;
	const content = rec.content;
	const signedChallenge = rec.challenge;
	const solution = rec.solution;
	const powHash = rec.pow_hash;
	const contentTypeChoice = rec.content_type ?? "auto";

	if (typeof content !== "string") {
		return error("content must be a string");
	}
	if (typeof signedChallenge !== "object" || signedChallenge === null || Array.isArray(signedChallenge)) {
		return error("challenge must be the signed challenge returned by /api/challenge");
	}
	if (!pow.isPowSolution(solution)) {
		return error("solution must be a non-negative decimal integer string");
	}
	if (!pow.isPowHash(powHash)) {
		return error("pow_hash must be a 64-char hex digest");
	}

	let challenge: pow.PublicChallenge | null;
	try {
		// Authenticate the challenge before trusting its content metadata.
		challenge = await pow.verifyChallenge(env, signedChallenge);
	} catch (err) {
		const message = err instanceof Error ? err.message : "challenge verification failed";
		return error(`challenge verification error: ${message}`, 503);
	}
	if (!challenge) {
		return error("challenge is invalid, forged, or expired", 403);
	}

	if (!contentType.isContentTypeChoice(contentTypeChoice)) {
		return error(`content_type must be auto or one of: ${contentType.CONTENT_TYPES.join(", ")}`);
	}
	const resolvedContentType = contentType.resolveContentType(content, contentTypeChoice);
	if (resolvedContentType === "url" && !contentType.parseHttpUrl(content)) {
		return error("URL content must be exactly one absolute http:// or https:// URL");
	}
	const validated = paste.validatePlaintext(content);
	if (!validated.ok) {
		return error(validated.error);
	}

	const contentHash = await pow.sha256Hex(validated.bytes);
	if (challenge.content_hash !== contentHash) {
		return error("content does not match challenge content_hash", 400);
	}
	if (challenge.byte_length !== validated.bytes.byteLength) {
		return error("content length does not match challenge", 400);
	}

	let expected: string;
	try {
		expected = await pow.computePowHash(
			contentHash,
			challenge.challenge_id,
			solution,
			challenge.nonce,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : "pow verification failed";
		return error(`pow verification error: ${message}`, 503);
	}

	if (!pow.timingSafeEqualHex(expected, powHash)) {
		return error("pow_hash does not match solution", 403);
	}
	if (!pow.meetsDifficulty(expected, challenge.difficulty)) {
		return error(
			`proof does not meet difficulty (${pow.leadingZeroBits(expected)} < ${challenge.difficulty} bits)`,
			403,
		);
	}

	const claimed = await pow.powKeyStub(env).redeem(challenge.challenge_id, challenge.expires_at);
	if (!claimed) {
		return error("challenge already used", 409);
	}

	const leadingZeroBits = pow.leadingZeroBits(expected);
	const { id, parts, resolved } = await mintId(env, request);
	const meta: paste.PasteMeta = {
		id,
		byte_length: validated.bytes.byteLength,
		sha256: contentHash,
		created_at: new Date().toISOString(),
		region_id: parts.region_id,
		region: region.idToHint(parts.region_id),
		content_type: resolvedContentType,
		client_ip: clientIpFromRequest(request),
		proof_of_work: {
			challenge_id: challenge.challenge_id,
			nonce: challenge.nonce,
			solution,
			pow_hash: expected,
			algorithm: challenge.algorithm,
			difficulty: challenge.difficulty,
			leading_zero_bits: leadingZeroBits,
		},
	};
	await paste.putPaste(env, meta, validated.bytes, content);

	const url = new URL(request.url);
	return json(
		{
			id,
			url: `${url.origin}/${id}`,
			raw_url: `${url.origin}/${id}.${contentType.fileExtension(meta.content_type)}`,
			version: parts.version,
			timestamp: parts.timestamp,
			counter: parts.counter,
			region_id: parts.region_id,
			region: meta.region,
			byte_length: meta.byte_length,
			sha256: meta.sha256,
			created_at: meta.created_at,
			content_type: meta.content_type,
			pow: {
				challenge_id: challenge.challenge_id,
				solution,
				difficulty: challenge.difficulty,
				leading_zero_bits: leadingZeroBits,
				algorithm: challenge.algorithm,
			},
			placement: {
				location_hint: resolved.location_hint,
				used_default: resolved.used_default,
				colo: resolved.colo,
			},
		},
		201,
	);
}

async function handleGetPaste(
	request: Request,
	env: Env,
	id: string,
	mode: "html" | "raw" | "json",
	requestedContentType?: contentType.ContentType,
): Promise<Response> {
	let parts: cpCode.CPCode;
	try {
		parts = cpCode.parseCpCode(id);
	} catch (err) {
		const message = err instanceof Error ? err.message : "invalid id";
		if (mode === "html") return ui.notFoundPage(message);
		return error(message, 400);
	}

	const stored = await paste.getPaste(env, id);
	if (!stored) {
		if (mode === "html") return ui.notFoundPage(`No paste for ${id}`);
		return error("paste not found", 404);
	}

	if (mode === "raw") {
		if (requestedContentType && requestedContentType !== stored.content_type) {
			return error("paste not found for this file extension", 404);
		}
		return new Response(stored.content, {
			headers: {
				"content-type": contentType.rawContentType(stored.content_type),
				"cache-control": "public, max-age=60",
				"content-security-policy": "sandbox; default-src 'none'",
				"x-content-type-options": "nosniff",
				"x-cp-code": id,
				"x-content-type": stored.content_type,
			},
		});
	}

	if (mode === "json") {
		return json({
			id: stored.id,
			content: stored.content,
			byte_length: stored.byte_length,
			sha256: stored.sha256,
			created_at: stored.created_at,
			region_id: stored.region_id,
			region: stored.region,
			content_type: stored.content_type,
			decoded: parts,
		});
	}

	return ui.viewPage(stored);
}

async function handleListPastes(url: URL, env: Env): Promise<Response> {
	const rawLimit = url.searchParams.get("limit");
	let limit = paste.RECENT_PASTE_LIMIT;
	if (rawLimit != null && rawLimit !== "") {
		const n = Number.parseInt(rawLimit, 10);
		if (!Number.isFinite(n) || n < 1) {
			return error("limit must be a positive integer");
		}
		limit = Math.min(n, paste.RECENT_PASTE_LIMIT);
	}
	const items = await paste.listRecentPastes(env, limit);
	return json({
		items,
		count: items.length,
		limit,
	});
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/+$/, "") || "/";
		const method = request.method;

		if (method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
					"access-control-allow-headers": "content-type, accept",
					"access-control-max-age": "86400",
				},
			});
		}

		if (path === "/health") {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			return json({ service: "cp.codes", status: "ok" });
		}

		if (path === "/debug") {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			return json(debugPayload(request, env, ctx, url, path));
		}

		if (path === "/api/challenge") {
			if (method !== "POST") return error("Method Not Allowed", 405);
			return handleChallenge(request, env);
		}

		if (path === "/api/paste") {
			if (method !== "POST") return error("Method Not Allowed", 405);
			return handleCreatePaste(request, env);
		}

		if (path === "/api/pastes") {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			return handleListPastes(url, env);
		}

		const apiPaste = path.match(/^\/api\/paste\/(CP[0-9A-Za-z]{6,7})$/);
		if (apiPaste) {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			return handleGetPaste(request, env, apiPaste[1]!.toUpperCase(), "json");
		}

		if (path === "/" || path === "/index.html") {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			const recent = await paste.listRecentPastes(env);
			return ui.homePage(recent);
		}

		// Static client bundle
		if (path === "/app.js") {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			if (env.ASSETS) {
				return env.ASSETS.fetch(request);
			}
			return error("app.js not available", 404);
		}

		const rawMatch = path.match(/^\/(CP[0-9A-Za-z]{6,7})\.([A-Za-z0-9]+)$/);
		if (rawMatch) {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			const requestedContentType = contentType.contentTypeForExtension(rawMatch[2]!);
			if (!requestedContentType) return error("Not Found", 404);
			return handleGetPaste(
				request,
				env,
				rawMatch[1]!.toUpperCase(),
				"raw",
				requestedContentType,
			);
		}

		const idMatch = path.match(/^\/(CP[0-9A-Za-z]{6,7})$/);
		if (idMatch) {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			const id = idMatch[1]!.toUpperCase();
			if (!CP_ID_RE.test(id)) return error("invalid id", 400);
			const mode = wantsHtml(request) ? "html" : "raw";
			return handleGetPaste(request, env, id, mode);
		}

		// Fall through to static assets (if any)
		if (env.ASSETS && (method === "GET" || method === "HEAD")) {
			const assetResp = await env.ASSETS.fetch(request);
			if (assetResp.status !== 404) return assetResp;
		}

		if (wantsHtml(request)) return ui.notFoundPage();
		return error("Not Found", 404);
	},
} satisfies ExportedHandler<Env>;
