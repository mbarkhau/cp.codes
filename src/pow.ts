/**
 * SHA-256 Hashcash-style proof-of-work (challenge / response).
 *
 *   1. Client SHA-256s the plaintext and POSTs /api/challenge.
 *   2. Server returns a signed, stateless challenge bound to that digest.
 *   3. Client tries solution = 0,1,2,… until SHA-256 of the bound challenge
 *      input has `difficulty` leading zero bits.
 *   4. Client returns the signed challenge with the proof.
 *   5. Server authenticates the challenge, validates one SHA-256 digest, and
 *      records only the successful redemption to prevent replay.
 *
 * At the base difficulty of 16 bits, a proof takes 65,536 attempts on average
 * and about 45,426 attempts for a 50% chance of success. The difficulty rises
 * with recent paste volume and with paste size.
 */

import { DurableObject } from "cloudflare:workers";

/** A SHA-256 digest cannot have more than 256 leading zero bits. */
export const MAX_POW_DIFFICULTY_BITS = 256;

export const POW_DEFAULTS = {
	/** Base number of leading zero bits required on the SHA-256 digest. */
	difficultyBits: 18,
	/** Rolling window used to increase difficulty under upload load. */
	rateWindowSeconds: 10 * 60,
	/** The paste count at which the first extra difficulty bit applies. */
	rateThreshold: 12,
	/** Challenge lifetime. */
	ttlSeconds: 600,
} as const;

const CHALLENGE_VERSION = 1 as const;
const KEY_HEX_STORAGE_NAME = "hmac-key:v1";
const KEY_BYTE_LENGTH = 32;
const SIGNING_DOMAIN = "cp.codes:pow-challenge:v1:";
const CHALLENGE_FIELD_NAMES = [
	"version",
	"challenge_id",
	"nonce",
	"difficulty",
	"content_hash",
	"byte_length",
	"algorithm",
	"created_at",
	"expires_at",
	"expected_attempts_p50",
	"signature",
] as const;

/** The complete signed challenge returned by the API and submitted with a proof. */
export type PublicChallenge = {
	version: typeof CHALLENGE_VERSION;
	challenge_id: string;
	/** Server-issued random nonce (hex). */
	nonce: string;
	/** Required leading zero bits on the SHA-256 output. */
	difficulty: number;
	content_hash: string;
	byte_length: number;
	algorithm: "sha256";
	created_at: number;
	expires_at: number;
	/** Expected attempts for a 50% chance of success (geometric). */
	expected_attempts_p50: number;
	/** Base64url HMAC-SHA-256 over all other fields. */
	signature: string;
};

type UnsignedChallenge = Omit<PublicChallenge, "signature">;

export type PowConfig = {
	difficultyBits: number;
};

export function powConfigFromEnv(env: Env): PowConfig {
	return {
		difficultyBits: parseNonNegInt(env.POW_DIFFICULTY_BITS, POW_DEFAULTS.difficultyBits),
	};
}

function parseNonNegInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw === "") return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The 15th recent paste adds one bit, the 16th adds two, and so on. */
export function difficultyForRecentPastes(
	baseDifficultyBits: number,
	recentPasteCount: number,
): number {
	if (!Number.isInteger(baseDifficultyBits) || baseDifficultyBits < 0) {
		throw new Error("base difficulty out of range");
	}
	if (!Number.isInteger(recentPasteCount) || recentPasteCount < 0) {
		throw new Error("recent paste count out of range");
	}
	const extraBits = Math.max(
		0,
		recentPasteCount - POW_DEFAULTS.rateThreshold + 1,
	);
	return baseDifficultyBits + extraBits;
}

/**
 * Attempts needed for a 50% chance of at least one success under geometric
 * success probability p = 2^-difficulty.
 */
export function expectedAttemptsP50(difficultyBits: number): number {
	if (difficultyBits <= 0) return 1;
	if (difficultyBits >= 52) {
		return Math.ceil(Math.LN2 * 2 ** difficultyBits);
	}
	const p = 2 ** -difficultyBits;
	return Math.max(1, Math.ceil(Math.log(0.5) / Math.log(1 - p)));
}

export function isContentHash(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

export function isChallengeId(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value);
}

export function isPowHash(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

/** Client solution counter / nonce: non-negative integer as decimal string. */
export function isPowSolution(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 24) return false;
	if (!/^[0-9]+$/.test(value)) return false;
	if (value.length > 1 && value.startsWith("0")) return false;
	return true;
}

/** Bind the paste, challenge, server nonce, and client solution unambiguously. */
export function powInput(
	contentHash: string,
	challengeId: string,
	nonceHex: string,
	solution: string,
): string {
	return `${contentHash.toLowerCase()}:${challengeId.toLowerCase()}:${nonceHex.toLowerCase()}:${solution}`;
}

export async function computePowHash(
	contentHash: string,
	challengeId: string,
	solution: string,
	nonceHex: string,
): Promise<string> {
	const nonce = hexToBytes(nonceHex);
	if (nonce.length < 8) {
		throw new Error("challenge nonce too short");
	}
	return sha256Hex(powInput(contentHash, challengeId, nonceHex, solution));
}

/** Count leading zero bits of a hex digest (MSB-first). */
export function leadingZeroBits(hashHex: string): number {
	const bytes = hexToBytes(hashHex);
	let bits = 0;
	for (const b of bytes) {
		if (b === 0) {
			bits += 8;
			continue;
		}
		for (let mask = 0x80; mask !== 0; mask >>= 1) {
			if ((b & mask) !== 0) return bits;
			bits++;
		}
		return bits;
	}
	return bits;
}

export function meetsDifficulty(hashHex: string, difficulty: number): boolean {
	if (difficulty <= 0) return true;
	return leadingZeroBits(hashHex) >= difficulty;
}

export function timingSafeEqualHex(a: string, b: string): boolean {
	const aa = a.toLowerCase();
	const bb = b.toLowerCase();
	if (aa.length !== bb.length) return false;
	let out = 0;
	for (let i = 0; i < aa.length; i++) {
		out |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
	}
	return out === 0;
}

export function randomHex(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return bytesToHex(bytes);
}

export function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

export function hexToBytes(hex: string): Uint8Array {
	const clean = hex.toLowerCase();
	if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) {
		throw new Error("invalid hex");
	}
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

/** Workers provides a native Web Crypto SHA-256 implementation. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return bytesToHex(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
		throw new Error("invalid base64url");
	}
	const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Canonical encoding avoids relying on JSON object property order. */
function signingInput(challenge: UnsignedChallenge): Uint8Array {
	const fields = [
		challenge.version,
		challenge.challenge_id,
		challenge.nonce,
		challenge.difficulty,
		challenge.content_hash,
		challenge.byte_length,
		challenge.algorithm,
		challenge.created_at,
		challenge.expires_at,
		challenge.expected_attempts_p50,
	];
	return new TextEncoder().encode(`${SIGNING_DOMAIN}${JSON.stringify(fields)}`);
}

function parsePublicChallenge(value: unknown): PublicChallenge | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const rec = value as Record<string, unknown>;
	const keys = Object.keys(rec);
	if (
		keys.length !== CHALLENGE_FIELD_NAMES.length ||
		CHALLENGE_FIELD_NAMES.some((name) => !Object.hasOwn(rec, name)) ||
		rec.version !== CHALLENGE_VERSION ||
		typeof rec.challenge_id !== "string" ||
		!/^[0-9a-f]{32}$/.test(rec.challenge_id) ||
		typeof rec.nonce !== "string" ||
		!/^[0-9a-f]{32}$/.test(rec.nonce) ||
		typeof rec.difficulty !== "number" ||
		!Number.isInteger(rec.difficulty) ||
		rec.difficulty < 0 ||
		rec.difficulty > MAX_POW_DIFFICULTY_BITS ||
		typeof rec.content_hash !== "string" ||
		!/^[0-9a-f]{64}$/.test(rec.content_hash) ||
		typeof rec.byte_length !== "number" ||
		!Number.isSafeInteger(rec.byte_length) ||
		rec.byte_length < 1 ||
		rec.algorithm !== "sha256" ||
		typeof rec.created_at !== "number" ||
		!Number.isInteger(rec.created_at) ||
		typeof rec.expires_at !== "number" ||
		!Number.isInteger(rec.expires_at) ||
		rec.expires_at <= rec.created_at ||
		rec.expires_at - rec.created_at > POW_DEFAULTS.ttlSeconds * 1000 ||
		typeof rec.expected_attempts_p50 !== "number" ||
		!Number.isFinite(rec.expected_attempts_p50) ||
		rec.expected_attempts_p50 < 1 ||
		typeof rec.signature !== "string" ||
		!/^[A-Za-z0-9_-]{43}$/.test(rec.signature)
	) {
		return null;
	}
	return rec as PublicChallenge;
}

/**
 * The imported, non-extractable key is immutable and may be cached only within
 * this isolate. A new isolate retrieves the same durable key again.
 */
let signingKeyPromise: Promise<CryptoKey> | undefined;

async function signingKey(env: Env): Promise<CryptoKey> {
	if (signingKeyPromise) return signingKeyPromise;
	const loading = (async () => {
		const keyHex = await powKeyStub(env).getKeyHex();
		if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error("invalid durable PoW key");
		return crypto.subtle.importKey(
			"raw",
			hexToBytes(keyHex),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign", "verify"],
		);
	})();
	signingKeyPromise = loading;
	try {
		return await loading;
	} catch (error) {
		if (signingKeyPromise === loading) signingKeyPromise = undefined;
		throw error;
	}
}

export async function issueChallenge(
	env: Env,
	input: { contentHash: string; byteLength: number; difficulty: number },
): Promise<PublicChallenge> {
	if (!isContentHash(input.contentHash)) throw new Error("invalid content hash");
	if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1) {
		throw new Error("byte length out of range");
	}
	if (
		!Number.isInteger(input.difficulty) ||
		input.difficulty < 0 ||
		input.difficulty > MAX_POW_DIFFICULTY_BITS
	) {
		throw new Error("difficulty out of range");
	}
	const now = Date.now();
	const unsigned: UnsignedChallenge = {
		version: CHALLENGE_VERSION,
		challenge_id: randomHex(16),
		nonce: randomHex(16),
		difficulty: input.difficulty,
		content_hash: input.contentHash.toLowerCase(),
		byte_length: input.byteLength,
		algorithm: "sha256",
		created_at: now,
		expires_at: now + POW_DEFAULTS.ttlSeconds * 1000,
		expected_attempts_p50: expectedAttemptsP50(input.difficulty),
	};
	const signature = new Uint8Array(
		await crypto.subtle.sign("HMAC", await signingKey(env), signingInput(unsigned)),
	);
	return { ...unsigned, signature: base64UrlEncode(signature) };
}

/** Validate and authenticate a client-supplied challenge before trusting it. */
export async function verifyChallenge(env: Env, value: unknown): Promise<PublicChallenge | null> {
	const challenge = parsePublicChallenge(value);
	if (!challenge) return null;
	let signature: Uint8Array;
	try {
		signature = base64UrlDecode(challenge.signature);
	} catch {
		return null;
	}
	if (signature.byteLength !== 32) return null;
	const authentic = await crypto.subtle.verify(
		"HMAC",
		await signingKey(env),
		signature,
		signingInput(challenge),
	);
	if (!authentic) return null;
	if (
		Date.now() >= challenge.expires_at ||
		challenge.expected_attempts_p50 !== expectedAttemptsP50(challenge.difficulty)
	) {
		return null;
	}
	return challenge;
}

/**
 * Stores one automatically generated signing key and successful redemptions.
 * Issuance never stores challenge records; first access only initializes the key.
 */
export class PowKey extends DurableObject<Env> {
	readonly #keyHex: string;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS pow_key (
				name TEXT PRIMARY KEY,
				key_hex TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pow_redemptions (
				challenge_id TEXT PRIMARY KEY,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS pow_redemptions_expires_at
				ON pow_redemptions(expires_at);
		`);
		const existing = this.ctx.storage.sql
			.exec<{ key_hex: string }>("SELECT key_hex FROM pow_key WHERE name = ?", KEY_HEX_STORAGE_NAME)
			.toArray()[0];
		if (existing) {
			if (!/^[0-9a-f]{64}$/.test(existing.key_hex)) {
				throw new Error("stored PoW key is invalid");
			}
			this.#keyHex = existing.key_hex;
		} else {
			const keyHex = randomHex(KEY_BYTE_LENGTH);
			this.ctx.storage.sql.exec(
				"INSERT INTO pow_key (name, key_hex) VALUES (?, ?)",
				KEY_HEX_STORAGE_NAME,
				keyHex,
			);
			this.#keyHex = keyHex;
		}
	}

	getKeyHex(): string {
		return this.#keyHex;
	}

	/** Atomically claim a successfully verified challenge and reject replays. */
	redeem(challengeId: string, expiresAt: number): boolean {
		if (!isChallengeId(challengeId) || !Number.isInteger(expiresAt)) return false;
		const now = Date.now();
		if (expiresAt <= now) return false;
		this.ctx.storage.sql.exec("DELETE FROM pow_redemptions WHERE expires_at <= ?", now);
		const inserted = this.ctx.storage.sql.exec<{ challenge_id: string }>(
			"INSERT OR IGNORE INTO pow_redemptions (challenge_id, expires_at) VALUES (?, ?) RETURNING challenge_id",
			challengeId.toLowerCase(),
			expiresAt,
		);
		return inserted.toArray().length === 1;
	}
}

export function powKeyStub(env: Env): DurableObjectStub<PowKey> {
	return env.POW_KEY.getByName("pow-key");
}
