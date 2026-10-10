/**
 * CP-Codes — Cloudflare Worker entrypoint.
 *
 * Local:   npm run dev   → http://localhost:8787
 * Deploy:  npm run deploy
 * Types:   npm run cf-typegen  (after changing wrangler.jsonc bindings)
 *
 * Pages:
 *   GET  /              new-paste form
 *   GET  /about         service information
 *   GET  /pastes        recent public pastes
 *   GET  /new           new-paste form
 *   GET  /client-info   client metadata retained with an upload
 *   GET  /admin/reports authenticated report and moderation queue
 *   GET  /admin/users   authenticated staff account list
 *   GET  /admin/access-log  authenticated access log
 *   GET  /admin/pastes  authenticated complete paste metadata
 *   GET  /:id           HTML view of a paste
 *   GET  /:id.:ext      raw content with its content-type extension
 *
 * API:
 *   GET  /health
 *   GET  /debug
 *   POST /api/challenge  issue SHA-256 PoW challenge (bound to content hash)
 *   POST   /api/paste      verify PoW, mint CP-Code, store paste
 *   GET    /api/paste/:id          JSON metadata
 *   GET    /api/paste/:id/content  stored compressed body
 *   POST   /api/paste/:id/authorize verify a passcode/passphrase
 *   DELETE /api/paste/:id          delete with a passcode/passphrase at any time
 *   POST   /api/paste/:id/report   report suspected illegal content
 *   GET  /api/pastes     recent uploads (newest first)
 *   GET  /api/admin             authenticated full staff dataset
 *   GET  /api/admin/reports     authenticated report queue
 *   GET/PATCH /api/admin/paste/:id  retained metadata / moderation decision
 *   GET  /api/admin/access-log  authenticated paste access log
 */

import * as cpCode from "./cp_code";
import * as region from "./region";
import * as clock from "./mono_clock";
import * as pow from "./pow";
import * as paste from "./paste";
import * as ui from "./ui";
import * as contentType from "./content_type";
import * as admin from "./admin";
import { getPowDifficultyState } from "./pow_settings";
import { assessPaste, initialModeration } from "./jev.mjs";
import { MAX_UPLOAD_BYTES, MAX_REQUEST_BYTES, trafficDifficultyBits, shortIdDifficultyBits } from '../public/policy.js';
import { clientIp } from './identity';
import { boundedJson, boundedBytes, BodyLimitError } from './body';
import { normalizePasscode, passphraseFromPasscode } from '../public/authorization.js';
import { parseBundle, bundleManifest, bundleAssessmentText, bundleFileResponse, type Bundle } from './bundle';
import { withAssetCachePolicy } from './assets';

export { MonoClock } from "./mono_clock";
export { PowKey } from "./pow";
export { PasteIndex } from "./paste";
export { StaffSession } from "./session";

const CP_ID_RE = /^CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10})$/;
const MAX_REDIRECT_URL_BYTES = 64 * 1024;
const MAX_REDIRECT_STORED_BYTES = 256 * 1024;

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
	const responseHeaders = new Headers(headers);
	if (!responseHeaders.has('cache-control')) responseHeaders.set('cache-control', 'no-store, private');
	responseHeaders.set('referrer-policy', 'no-referrer');
	return Response.json(data, { status, headers: responseHeaders });
}

function error(message: string, status = 400): Response {
	return json({ error: message }, status);
}

function decodeBase64(value: unknown): Uint8Array | null {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(value)
	) {
		return null;
	}
	try {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

/** Inflate one gzip stream, rejecting output beyond the signed expected size. */
async function decompressGzipExact(
	compressed: Uint8Array,
	expectedByteLength: number,
): Promise<Uint8Array> {
	const input = new Response(compressed).body;
	if (!input) throw new Error("compressed content is empty");
	const reader = input.pipeThrough(new DecompressionStream("gzip")).getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > expectedByteLength) {
				await reader.cancel("decompressed content exceeds signed byte_length");
				throw new Error("decompressed content exceeds signed byte_length");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	if (byteLength !== expectedByteLength) {
		throw new Error("decompressed content length does not match challenge");
	}
	const result = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

/** Only a server-generated representation may be published. Client gzip header
 * comments/extra fields/padding are not committed by the plaintext digest. */
async function canonicalGzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Response(bytes).body!.pipeThrough(new CompressionStream('gzip'));
	return boundedBytes(stream, bytes.length + Math.ceil(bytes.length / 4) + 1024);
}

function wantsHtml(request: Request): boolean {
	const accept = request.headers.get("accept") ?? "";
	if (accept.includes("text/html")) return true;
	// Navigations usually prefer HTML even with broad Accept.
	const mode = request.headers.get("sec-fetch-mode");
	return mode === "navigate";
}

function headerValue(request: Request, name: string): string | null {
	const value = request.headers.get(name)?.trim();
	return value || null;
}

function cfString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Capture the edge and forwarding metadata attached to this upload request. */
function uploadMetadataFromRequest(request: Request): paste.PasteUploadMetadata {
	const cf = request.cf;
	return {
		"cf-connecting-ip": clientIp(request),
		"x-real-ip": headerValue(request, "x-real-ip"),
		"cf-ipcountry": headerValue(request, "cf-ipcountry"),
		asn:
			typeof cf?.asn === "number" && Number.isSafeInteger(cf.asn) && cf.asn >= 0
				? cf.asn
				: null,
		asOrganization: cfString(cf?.asOrganization),
		country: cfString(cf?.country),
		isEUCountry: cfString(cf?.isEUCountry),
		city: cfString(cf?.city),
		continent: cfString(cf?.continent),
		region: cfString(cf?.region),
		regionCode: cfString(cf?.regionCode),
		timezone: cfString(cf?.timezone),
		longitude: cfString(cf?.longitude),
		latitude: cfString(cf?.latitude),
		postalCode: cfString(cf?.postalCode),
	};
}

function pasteAccessFromRequest(
	request: Request,
	kind: paste.PasteAccessKind,
): paste.PasteAccess {
	const cf = request.cf;
	return {
		accessed_at: new Date().toISOString(),
		ip: clientIp(request),
		referer: headerValue(request, "referer"),
		kind,
		location: {
			city: cfString(cf?.city),
			region: cfString(cf?.region),
			region_code: cfString(cf?.regionCode),
			country: cfString(cf?.country) ?? headerValue(request, "cf-ipcountry"),
			continent: cfString(cf?.continent),
			postal_code: cfString(cf?.postalCode),
			timezone: cfString(cf?.timezone),
			latitude: cfString(cf?.latitude),
			longitude: cfString(cf?.longitude),
			colo: cfString(cf?.colo),
		},
	};
}

function contentRequestFollowsHtmlView(request: Request, id: string): boolean {
	const referer = headerValue(request, "referer");
	if (!referer) return false;
	try {
		const requestUrl = new URL(request.url);
		const refererUrl = new URL(referer);
		return refererUrl.origin === requestUrl.origin &&
			refererUrl.pathname.replace(/\/+$/, "").toUpperCase() === `/${id.toUpperCase()}`;
	} catch {
		return false;
	}
}

function monoClock(
	env: Env,
	resolved: region.ResolvedRegion,
): DurableObjectStub<clock.MonoClock> {
	return env.MONO_CLOCK.getByName(clock.clockName(resolved.location_hint), {
		locationHint: resolved.location_hint,
	});
}

async function mintId(
	env: Env,
	request: Request,
	version: typeof cpCode.VERSION_0 | typeof cpCode.VERSION_2,
): Promise<{ id: string; parts: cpCode.CPCode; resolved: region.ResolvedRegion }> {
	const resolved = region.regionFromRequest(request);
	const maxCounter = 2 ** cpCode.COUNTER_BITS_BY_VERSION[version];
	const { timestamp, counter } = await monoClock(env, resolved).next(
		cpCode.TIME_RESOLUTION,
		maxCounter,
	);
	const parts = cpCode.generateCpCode(resolved.region_id, timestamp, counter, version);
	const id = cpCode.encodeCpCode(parts);
	return { id, parts, resolved };
}

function headersToObject(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of headers) {
		out[key] = ["authorization", "cookie", "proxy-authorization"].includes(key.toLowerCase())
			? "[redacted]" : key in out ? `${out[key]}, ${value}` : value;
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

/** Current regional difficulty for a byte length. Does not issue or reserve a challenge. */
async function uploadDifficulty(request: Request, env: Env, byteLength: number): Promise<number | null> {
	const ip = clientIp(request);
	if (!ip) return null;
	const resolved = region.regionFromRequest(request);
	const gate = pow.powKeyStub(env);
	const [state, ipUnits, shortIds] = await Promise.all([
		getPowDifficultyState(env),
		gate.getAdmissionUnits(await pow.sha256Hex(ip)),
		monoClock(env, resolved).shortIdCount(cpCode.TIME_RESOLUTION),
	]);
	const sizeBits = byteLength > 0 ? paste.pasteSizeDifficultyBits(byteLength) : 0;
	return Math.min(
		pow.MAX_POW_DIFFICULTY_BITS,
		state.current_difficulty_bits + trafficDifficultyBits(ipUnits) + sizeBits +
			shortIdDifficultyBits(shortIds, state.short_id_increment),
	);
}

async function handlePowQuote(request: Request, env: Env): Promise<Response> {
	const raw = new URL(request.url).searchParams.get('byte_length');
	const byteLength = Number(raw);
	if (raw === null || !/^[0-9]+$/.test(raw) || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_UPLOAD_BYTES) {
		return error('byte_length must be an integer from 0 to the upload limit');
	}
	const difficulty = await uploadDifficulty(request, env, byteLength);
	if (difficulty === null) return error('Trusted edge IP identity is unavailable. Check the service proxy configuration.', 403);
	return json({
		difficulty,
		expected_attempts: difficulty <= 0 ? 1 : 2 ** difficulty,
		expected_attempts_p50: pow.expectedAttemptsP50(difficulty),
	});
}

async function handleChallenge(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try {
		body = await boundedJson(request, 4096);
	} catch (err) {
		return error('invalid JSON body', err instanceof BodyLimitError ? 413 : 400);
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) return error('body must be an object');
	const rec = body as Record<string, unknown>;
	const contentHash = rec.content_hash;
	const byteLength = rec.byte_length;

	if (!pow.isContentHash(contentHash)) {
		return error("content_hash must be a 64-char sha256 hex digest");
	}
	if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 1) {
		return error("byte_length must be a positive safe integer");
	}

	if (byteLength > MAX_UPLOAD_BYTES) return error(`Upload exceeds ${MAX_UPLOAD_BYTES} bytes`, 413);
	const ip = clientIp(request);
	if (!ip) return error('Trusted edge IP identity is unavailable. Check the service proxy configuration.', 403);
	const requesterHash = await pow.sha256Hex(ip);
	const gate = pow.powKeyStub(env);
	if (!await gate.allowChallenge(requesterHash)) return json({ error: 'Too many challenges. Try again in ten minutes.' }, 429, { 'retry-after': '600' });
	if (!await gate.canAffordUpload(byteLength, requesterHash)) return json({ error: 'Upload cost budget reached. Try again in ten minutes.' }, 429, { 'retry-after': '600' });
	const difficulty = await uploadDifficulty(request, env, byteLength);
	if (difficulty === null) return error('Trusted edge IP identity is unavailable. Check the service proxy configuration.', 403);
	const challenge = await pow.issueChallenge(env, {
		contentHash,
		byteLength,
		difficulty,
		requesterHash,
	});
	return json(challenge);
}

async function handleCreatePaste(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try {
		body = await boundedJson(request, MAX_REQUEST_BYTES);
	} catch (err) {
		return error('invalid JSON body', err instanceof BodyLimitError ? 413 : 400);
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return error("body must be an object");
	}
	const rec = body as Record<string, unknown>;
	const encodedContent = rec.content_gzip;
	const compression = rec.compression;
	const signedChallenge = rec.challenge;
	const solution = rec.solution;
	const powHash = rec.pow_hash;
	const contentTypeChoice = rec.content_type;
	const filenameValue = rec.filename;
	const unlistedValue = rec.unlisted ?? false;
	const consentValue = rec.consent;
	const moderationConsentValue = rec.consent_moderation;

	if (consentValue !== true) {
		return error("consent to collecting and storing IP and location data is required", 403);
	}
	if (moderationConsentValue !== true) {
		return error("consent to automated moderation with DefAPI/TypeSafe is required", 403);
	}
	if (compression !== "gzip") {
		return error("compression must be gzip");
	}
	if (typeof encodedContent !== 'string' || !encodedContent.length) {
		return error("content_gzip must be non-empty base64-encoded gzip data");
	}
	if (Object.hasOwn(rec, 'description')) return error('descriptions are not supported');
	if (filenameValue != null && typeof filenameValue !== "string") {
		return error("filename must be a string");
	}
	if (typeof unlistedValue !== "boolean") {
		return error("unlisted must be a boolean");
	}
	const filename = typeof filenameValue === "string" ? filenameValue.trim() || null : null;
	if (filename && filename.length > paste.MAX_FILENAME_CHARS) {
		return error(`filename exceeds ${paste.MAX_FILENAME_CHARS} characters`);
	}
	if (filename && /[\u0000-\u001f\u007f]/.test(filename)) {
		return error("filename must not contain control characters");
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
	if (challenge.byte_length > MAX_UPLOAD_BYTES) return error('Upload exceeds the size limit', 413);
	const maximumCompressedBytes = challenge.byte_length + Math.ceil(challenge.byte_length / 4) + 1024;
	if (encodedContent.length > 4 * Math.ceil(maximumCompressedBytes / 3)) {
		return error('Compressed input has excessive overhead or padding', 413);
	}
	if (challenge.requester_hash !== await pow.sha256Hex(clientIp(request) ?? 'unknown')) return error('Challenge belongs to a different IP', 403);

	// Content detection and URL interpretation are client responsibilities. The
	// server stores only the client's resolved type and never renders content.
	if (!contentType.isContentType(contentTypeChoice)) {
		return error(`content_type must be one of: ${contentType.CONTENT_TYPES.join(", ")}`);
	}
	const resolvedContentType = contentTypeChoice;

	// Check the proof before spending CPU and memory inflating client data.
	let expected: string;
	try {
		expected = await pow.computePowHash(
			challenge.content_hash,
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

	// Reserve before expensive inflation and paid moderation. Atomic revalidation
	// makes prefetched cheap challenges unusable after traffic/cost increases.
	const admitted = await pow.powKeyStub(env).admit(challenge, pow.powConfigFromEnv(env).difficultyBits);
	if (admitted === 'budget') return json({ error: 'Upload cost budget reached. Try again in ten minutes.' }, 429, { 'retry-after': '600' });
	if (admitted === 'replay') return error('challenge already used', 409);
	if (admitted === 'stale') return error('Upload price changed; request a fresh challenge', 409);

	const compressedContent = decodeBase64(encodedContent);
	if (!compressedContent) return error('content_gzip must be non-empty base64-encoded gzip data');
	if (compressedContent.length > maximumCompressedBytes) return error('Compressed input has excessive overhead or padding', 413);
	let uncompressedBytes: Uint8Array;
	try {
		uncompressedBytes = await decompressGzipExact(compressedContent, challenge.byte_length);
	} catch (err) {
		const message = err instanceof Error ? err.message : "gzip decompression failed";
		return error(`invalid compressed content: ${message}`);
	}
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(uncompressedBytes);
	} catch {
		return error("decompressed content must be valid UTF-8 text");
	}
	const validated = paste.validatePlaintext(content, uncompressedBytes);
	if (!validated.ok) return error(validated.error);

	const contentHash = await pow.sha256Hex(uncompressedBytes);
	if (challenge.content_hash !== contentHash) {
		return error("content does not match challenge content_hash", 400);
	}

	let bundle: Bundle | null = null;
	if (rec.format != null && rec.format !== 'bundle-v1') return error('Unsupported upload format');
	if (rec.format === 'bundle-v1') {
		try { bundle = parseBundle(content); } catch (err) { return error(err instanceof Error ? err.message : 'Invalid file bundle'); }
	}

	// Strip every client-controlled gzip side channel before publication.
	const storedGzip = await canonicalGzip(uncompressedBytes);
	const leadingZeroBits = pow.leadingZeroBits(expected);
	const idVersion = unlistedValue ? cpCode.VERSION_2 : cpCode.VERSION_0;
	const { id, parts, resolved } = await mintId(env, request, idVersion);
	const uploadMetadata = uploadMetadataFromRequest(request);
	const meta: paste.PasteMeta = {
		id,
		byte_length: uncompressedBytes.byteLength,
		sha256: contentHash,
		created_at: new Date().toISOString(),
		region_id: parts.region_id,
		region: region.idToHint(parts.region_id),
		content_type: bundle?.files.find(file => file.name === bundle.primary)!.content_type ?? resolvedContentType,
		description: null,
		filename: bundle?.primary ?? filename,
		...(bundle ? { format: 'bundle-v1' as const, primary: bundle.primary, files: await bundleManifest(bundle) } : {}),
		unlisted: unlistedValue,
		upload_metadata: uploadMetadata,
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
	// Evaluate the already verified/decompressed buffer once, before publishing.
	// Failures, uncertain results, images, and over-context pastes are held for
	// staff review. No external I/O occurs inside a DO concurrency block.
	const combined = bundle ? bundleAssessmentText(bundle) : null;
	const assessmentText = combined?.content ?? content;
	const assessment = await assessPaste({ ...meta, content_type: combined?.unsupported ? 'png' : meta.content_type,
		byte_length: new TextEncoder().encode(assessmentText).length }, assessmentText, env.DEFAPI_KEY);
	const moderation = initialModeration(assessment);
	const passcode = await paste.pasteIndexStub(env).createPasscode(id);
	await paste.putPaste(
		env,
		meta,
		storedGzip,
		paste.makePreview(bundle?.files.find(file => file.name === bundle.primary)?.content ?? content),
		assessment,
	);

	const url = new URL(request.url);
	return json(
		{
			id,
			url: `${url.origin}/${id}`,
			raw_url: `${url.origin}/${id}.${contentType.fileExtension(meta.content_type)}`,
			content_url: `${url.origin}/api/paste/${id}/content`,
			version: parts.version,
			timestamp: parts.timestamp,
			counter: parts.counter,
			region_id: parts.region_id,
			region: meta.region,
			byte_length: meta.byte_length,
			compressed_byte_length: storedGzip.byteLength,
			content_encoding: "gzip",
			sha256: meta.sha256,
			created_at: meta.created_at,
			content_type: meta.content_type,
			description: meta.description,
			filename: meta.filename,
			unlisted: meta.unlisted,
			hit_count: 0,
			format: meta.format ?? 'single',
			files: meta.files,
			primary: meta.primary,
			moderation: {
				state: moderation.visibility === 'visible' ? 'limited' : 'review',
				message: moderation.visibility === 'visible' ? 'Ready for you and three other IPs. Wider sharing requires human review.' : 'Stored safely; waiting for human review.',
				visibility: moderation.visibility,
				requires_review: moderation.requires_review,
				assessment_status: assessment.status,
			},
			passcode,
			passphrase: passphraseFromPasscode(passcode),
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
		{ "cache-control": "no-store" },
	);
}

async function unavailablePasteResponse(
	request: Request,
	env: Env,
	moderation: paste.PasteModeration,
	mode: "html" | "raw" | "json",
	bodyRequest = false,
): Promise<Response | null> {
	const staff = await admin.authenticateStaff(request, env);
	if (moderation.visibility !== 'deleted' && staff) return null;
	const retained = await paste.getRetainedPaste(env, moderation.paste_id);
	const access = await paste.pasteIndexStub(env).authorizeAccess(moderation.paste_id, clientIp(request),
		bodyRequest && request.method === 'GET' ? retained?.metadata.byte_length ?? 0 : 0, request.method === 'GET');
	if (access.allowed) return null;
	const status = moderation.visibility === 'visible' && retained ? 423 : 404;
	if (mode === 'html') return ui.reviewRequiredPage(moderation.paste_id, access.reason, status);
	return json({ error: status === 404 ? 'paste not found' : access.reason, moderation: { state: access.state } }, status,
		{ 'cache-control': 'no-store, private', vary: 'Cookie, Authorization', 'referrer-policy': 'no-referrer' });
}

async function redirectTargetFromPaste(object: paste.StoredPasteObject): Promise<URL> {
	const stored = object.metadata;
	if (
		stored.byte_length < 1 || stored.byte_length > MAX_REDIRECT_URL_BYTES ||
		stored.compressed_byte_length < 1 || stored.compressed_byte_length > MAX_REDIRECT_STORED_BYTES
	) {
		throw new Error("approved URL is too large to redirect");
	}
	let stream: ReadableStream<Uint8Array> = object.body;
	if (stored.content_encoding === "gzip") {
		stream = stream.pipeThrough(new DecompressionStream("gzip"));
	}
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > stored.byte_length || byteLength > MAX_REDIRECT_URL_BYTES) {
				await reader.cancel("redirect URL exceeds stored length");
				throw new Error("approved URL length does not match its metadata");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	if (byteLength !== stored.byte_length) {
		throw new Error("approved URL length does not match its metadata");
	}
	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).trim();
	const target = new URL(value);
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		throw new Error("approved URL must use HTTP or HTTPS");
	}
	return target;
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
		if (mode === "html") return ui.notFoundPage(message, Boolean(await admin.authenticateStaff(request, env)));
		return error(message, 400);
	}

	const moderation = await paste.getPasteModeration(env, id);
	const unavailable = await unavailablePasteResponse(request, env, moderation, mode, mode === 'raw');
	if (unavailable) return unavailable;

	const object = mode === "raw" && request.method === "GET"
		? await paste.getPasteObject(env, id)
		: null;
	const stored = object?.metadata ?? await paste.getPasteMetadata(env, id);
	if (!stored) {
		if (mode === "html") return ui.notFoundPage(`No paste for ${id}`, Boolean(await admin.authenticateStaff(request, env)));
		return error("paste not found", 404);
	}

	if (mode === "raw" && requestedContentType && requestedContentType !== stored.content_type) {
		return error("paste not found for this file extension", 404);
	}

	// An approved URL paste acts as a short URL at its canonical CP-Code path.
	// Explicit raw-extension and JSON API requests still expose paste data.
	if (
		(request.method === "GET" || request.method === "HEAD") &&
		mode !== "json" &&
		requestedContentType === undefined &&
		!stored.format && stored.content_type === "url" &&
		moderation.decision === "approved"
	) {
		const redirectObject = object ?? await paste.getPasteObject(env, id);
		if (!redirectObject) {
			if (mode === "html") return ui.notFoundPage(`No paste for ${id}`, Boolean(await admin.authenticateStaff(request, env)));
			return error("paste not found", 404);
		}
		let target: URL;
		try {
			target = await redirectTargetFromPaste(redirectObject);
		} catch (err) {
			const message = err instanceof Error ? err.message : "approved URL is invalid";
			return error(message, 422);
		}
		const hitCount = request.method === "GET"
			? await paste.recordPasteAccess(env, id, pasteAccessFromRequest(request, "redirect"))
			: await paste.getPasteHitCount(env, id);
		return new Response(null, {
			status: 302,
			headers: {
				location: target.href,
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
				"x-cp-code": id,
				"x-hit-count": String(hitCount),
			},
		});
	}

	// Browser and JSON metadata views are logged without affecting hit counts.
	// Logging HTML here retains the external Referer before the content fetch.
	let hitCount: number;
	if (request.method === "GET" && mode === "raw") {
		hitCount = await paste.recordPasteAccess(env, id, pasteAccessFromRequest(request, "raw"));
	} else if (request.method === "GET" && (mode === "html" || mode === "json")) {
		hitCount = await paste.recordPasteAccess(
			env,
			id,
			pasteAccessFromRequest(request, mode),
			false,
		);
	} else {
		hitCount = await paste.getPasteHitCount(env, id);
	}

	if (mode === 'raw' && stored.format === 'bundle-v1') {
		return bundleFileResponse(request, object, stored, stored.primary ?? '', hitCount);
	}

	if (mode === "raw") {
		const headers = new Headers({
			"content-type": contentType.rawContentType(stored.content_type),
			"content-length": String(stored.byte_length),
			"cache-control": "no-store",
			"content-security-policy": "sandbox; default-src 'none'",
			"x-content-type-options": "nosniff",
			"x-cp-code": id,
			"x-content-type": stored.content_type,
			"x-hit-count": String(hitCount),
		});
		const body = object?.body && stored.content_encoding === "gzip"
			? object.body.pipeThrough(new DecompressionStream("gzip"))
			: object?.body ?? null;
		return new Response(body, { headers });
	}

	if (mode === "json") {
		return json({
			id: stored.id,
			format: stored.format ?? 'single', files: stored.files, primary: stored.primary,
			moderation: { state: moderation.decision === 'approved' ? 'approved' : 'limited', ...(await paste.pasteIndexStub(env).getSharing(id)) },
			content_url: `/api/paste/${stored.id}/content`,
			content_encoding: stored.content_encoding,
			compressed_byte_length: stored.compressed_byte_length,
			byte_length: stored.byte_length,
			sha256: stored.sha256,
			created_at: stored.created_at,
			region_id: stored.region_id,
			region: stored.region,
			content_type: stored.content_type,
			description: stored.description,
			filename: stored.filename,
			unlisted: stored.unlisted,
			hit_count: hitCount,
			decoded: parts,
		}, 200, { "cache-control": "no-store" });
	}

	return ui.viewPage(stored, hitCount, Boolean(await admin.authenticateStaff(request, env)), moderation.visibility === "hidden");
}

/** Serve the exact R2 representation for client-side decompression. */
async function handleGetPasteContent(request: Request, env: Env, id: string): Promise<Response> {
	try {
		cpCode.parseCpCode(id);
	} catch (err) {
		return error(err instanceof Error ? err.message : "invalid id", 400);
	}
	const moderation = await paste.getPasteModeration(env, id);
	const unavailable = await unavailablePasteResponse(request, env, moderation, "raw", true);
	if (unavailable) return unavailable;
	const object = request.method === "GET" ? await paste.getPasteObject(env, id) : null;
	const stored = object?.metadata ?? await paste.getPasteMetadata(env, id);
	if (!stored) return error("paste not found", 404);

	// This endpoint is the point at which the HTML client actually loads the
	// body. Its HTML request was already logged with the external Referer, so the
	// follow-up only increments the hit. Direct content API access is logged here.
	let hitCount: number;
	if (request.method !== "GET") {
		hitCount = await paste.getPasteHitCount(env, id);
	} else if (contentRequestFollowsHtmlView(request, id)) {
		hitCount = await paste.incrementPasteHitCount(env, id);
	} else {
		hitCount = await paste.recordPasteAccess(env, id, pasteAccessFromRequest(request, "content"));
	}

	return new Response(object?.body ?? null, {
		headers: {
			"content-type": stored.content_encoding === "gzip"
				? "application/gzip"
				: "text/plain; charset=utf-8",
			'content-security-policy': "sandbox; default-src 'none'",
			"content-length": String(stored.compressed_byte_length),
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"x-content-encoding": stored.content_encoding,
			"x-uncompressed-content-length": String(stored.byte_length),
			"x-content-sha256": stored.sha256,
			"x-hit-count": String(hitCount),
		},
	});
}

async function handleBundleFile(request: Request, env: Env, id: string, encodedName: string): Promise<Response> {
	let name: string;
	try { cpCode.parseCpCode(id); name = decodeURIComponent(encodedName); } catch { return error('File not found', 404); }
	const retained = await paste.getRetainedPaste(env, id);
	if (!retained?.metadata.files?.some(file => file.name === name)) return error('File not found', 404);
	const unavailable = await unavailablePasteResponse(request, env, retained.moderation, 'raw', true);
	if (unavailable) return unavailable;
	const object = request.method === 'GET' ? await paste.getPasteObject(env, id) : null;
	const stored = object?.metadata ?? (request.method === 'HEAD' ? await paste.getPasteMetadata(env, id) : null);
	if (!stored) return error('Paste not found', 404);
	const hits = request.method === 'GET' ? await paste.recordPasteAccess(env, id, pasteAccessFromRequest(request, 'raw')) : await paste.getPasteHitCount(env, id);
	return bundleFileResponse(request, object, stored, name, hits);
}

async function handleReportPaste(request: Request, env: Env, id: string): Promise<Response> {
	const requester = await pow.sha256Hex(`report:${clientIp(request) ?? 'unknown'}`);
	if (!await pow.powKeyStub(env).allowChallenge(requester)) return json({ error: 'Too many reports' }, 429, { 'retry-after': '600' });
	let body: unknown;
	try {
		body = await boundedJson(request, 4096);
	} catch {
		return error("invalid JSON body");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return error("body must be an object");
	}
	const rec = body as Record<string, unknown>;
	const categoryValue = rec.category;
	const emailValue = rec.email;
	if (categoryValue != null && categoryValue !== "" && !paste.isReportCategory(categoryValue)) {
		return error(`category must be one of: ${paste.REPORT_CATEGORIES.join(", ")}`);
	}
	if (emailValue != null && typeof emailValue !== "string") {
		return error("email must be a string");
	}
	const email = typeof emailValue === "string" ? emailValue.trim() || null : null;
	if (email && (email.length > paste.MAX_REPORT_EMAIL_CHARS || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
		return error("email must be a valid email address");
	}
	const metadata = await paste.getPasteMetadata(env, id);
	if (!metadata) return error("paste not found", 404);
	const report = await paste.submitPasteReport(env, id, {
		category: paste.isReportCategory(categoryValue) ? categoryValue : null,
		email,
	}, metadata);
	return json({
		reported: true,
		report_id: report.id,
		paste_id: report.paste_id,
		category: report.category,
		reported_at: report.reported_at,
	}, 201, { "cache-control": "no-store" });
}

async function handleDeletePaste(request: Request, env: Env, id: string): Promise<Response> {
	if (!admin.hasValidMutationOrigin(request)) return error('Invalid request origin', 403);
	let body: unknown;
	try {
		body = await boundedJson(request, 4096);
	} catch (err) {
		return error("invalid JSON body", err instanceof BodyLimitError ? 413 : 400);
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return error("body must be an object");
	}
	const rec = body as Record<string, unknown>;
	const passcode = normalizePasscode(rec.passcode ?? rec.passphrase);
	if (!passcode) return error('A valid passcode or passphrase is required', 403);
	const result = await paste.deleteAuthorizedPaste(env, id, passcode);
	if (result === "not_found") return error("paste not found", 404);
	if (result === "unauthorized") return error("Invalid passcode or passphrase", 403);
	return json({ deleted: true, id });
}

async function handleAuthorizePaste(request: Request, env: Env, id: string): Promise<Response> {
	if (!admin.hasValidMutationOrigin(request)) return error('Invalid request origin', 403);
	const requester = clientIp(request);
	if (!requester) return error('Trusted edge IP identity is unavailable', 403);
	if (!await pow.powKeyStub(env).allowChallenge(await pow.sha256Hex(`authorization:${requester}`))) {
		return json({ error: 'Too many authorization attempts. Try again in ten minutes.' }, 429, { 'retry-after': '600' });
	}
	let body: unknown;
	try { body = await boundedJson(request, 4096); }
	catch (err) { return error('Invalid JSON body', err instanceof BodyLimitError ? 413 : 400); }
	if (!body || typeof body !== 'object' || Array.isArray(body)) return error('Body must be an object');
	const rec = body as Record<string, unknown>;
	const passcode = normalizePasscode(rec.passcode ?? rec.passphrase);
	const retained = await paste.getRetainedPaste(env, id);
	if (!retained || retained.moderation.visibility === 'deleted') return error('Paste not found', 404);
	if (!await paste.pasteIndexStub(env).hasPasscode(id)) return error('This older paste has no passcode. Staff can delete it.', 403);
	if (!passcode || !await paste.pasteIndexStub(env).verifyPasscode(id, passcode)) return error('Invalid passcode or passphrase', 403);
	return json({ authorized: true, id });
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

async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/+$/, "") || "/";
		const method = request.method;

		if (method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "GET, HEAD, POST, DELETE, OPTIONS",
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
			return json(debugPayload(request, env, ctx, url, path), 200, { "cache-control": "no-store, private", vary: "Cookie, Authorization" });
		}

		if (path === "/login") return admin.handleLogin(request, env);
		if (path === "/logout") return admin.handleLogout(request, env);

		if (
			path === "/admin/reports" ||
			path === "/admin/users" ||
			path === "/admin/pow" ||
			path === "/api/admin/pow" ||
			path === "/admin/access-log" ||
			path === "/admin/pastes" ||
			path === "/admin/api" ||
			path === "/api/admin" ||
			path === "/api/admin/data" ||
			path === "/api/admin/users" ||
			path === "/api/admin/access-log" ||
			path === "/api/admin/reports" ||
			/^\/(?:api\/)?admin\/paste\/CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10})$/.test(path) ||
			/^\/admin\/paste\/CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10})\/(?:view|raw|content)$/.test(path)
		) {
			return admin.handleAdminRequest(request, env, url, path);
		}

			if (path === "/api/pow") {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			return handlePowQuote(request, env);
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

		const fileRoute = path.match(/^\/(CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10}))\/files\/([^/]+)$/);
		if (fileRoute) {
			if (method !== 'GET' && method !== 'HEAD') return error('Method Not Allowed', 405);
			return handleBundleFile(request, env, fileRoute[1]!.toUpperCase(), fileRoute[2]!);
		}

		const apiPasteAuthorize = path.match(/^\/api\/paste\/(CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10}))\/authorize$/);
		if (apiPasteAuthorize) {
			if (method !== 'POST') return error('Method Not Allowed', 405);
			return handleAuthorizePaste(request, env, apiPasteAuthorize[1]!.toUpperCase());
		}

		const apiPasteReport = path.match(/^\/api\/paste\/(CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10}))\/report$/);
		if (apiPasteReport) {
			if (method !== "POST") return error("Method Not Allowed", 405);
			return handleReportPaste(request, env, apiPasteReport[1]!.toUpperCase());
		}

		const apiPasteContent = path.match(/^\/api\/paste\/(CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10}))\/content$/);
		if (apiPasteContent) {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			return handleGetPasteContent(request, env, apiPasteContent[1]!.toUpperCase());
		}

		const apiPaste = path.match(/^\/api\/paste\/(CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10}))$/);
		if (apiPaste) {
			const id = apiPaste[1]!.toUpperCase();
			if (method === "DELETE") return handleDeletePaste(request, env, id);
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			return handleGetPaste(request, env, id, "json");
		}

		if (path === "/" || path === "/index.html") {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			return ui.newPage(Boolean(await admin.authenticateStaff(request, env)));
		}

		if (path === "/about") {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			return ui.aboutPage(Boolean(await admin.authenticateStaff(request, env)));
		}

		if (path === "/pastes") {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			const rawPage = url.searchParams.get('page') ?? '1';
			const page = Number(rawPage);
			if (!/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(page)) return error('page must be a positive safe integer');
			const listing = await paste.listPublicPastesPage(env, page);
			return ui.pastesPage(listing, Boolean(await admin.authenticateStaff(request, env)));
		}

		if (path === "/client-info") {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			return ui.clientInfoPage(uploadMetadataFromRequest(request), Boolean(await admin.authenticateStaff(request, env)));
		}

		if (path === "/new") {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			return ui.newPage(Boolean(await admin.authenticateStaff(request, env)));
		}

		// Static client bundle
		if (path === "/app.js") {
			if (method !== "GET" && method !== "HEAD") return error("Method Not Allowed", 405);
			if (env.ASSETS) {
				return withAssetCachePolicy(request, await env.ASSETS.fetch(request));
			}
			return error("app.js not available", 404);
		}

		const rawMatch = path.match(/^\/(CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10}))\.([A-Za-z0-9]+)$/);
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

		const idMatch = path.match(/^\/(CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10}))$/);
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
			if (assetResp.status !== 404) return withAssetCachePolicy(request, assetResp);
		}

		if (wantsHtml(request)) return ui.notFoundPage("Not found", Boolean(await admin.authenticateStaff(request, env)));
		return error("Not Found", 404);
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		try { return await routeRequest(request, env, ctx); }
		catch {
			// Never log request bodies, credentials, or arbitrary provider errors.
			console.error(JSON.stringify({ service: 'cp.codes', event: 'request_failed', method: request.method }));
			return error('The service could not complete this request. Please try again.', 503);
		}
	},
} satisfies ExportedHandler<Env>;
