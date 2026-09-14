/**
 * Paste body storage (R2) + recent-upload index (Durable Object).
 *
 * Keys: pastes/{CP_CODE}
 * Only UTF-8 plaintext is accepted (no NULs). Bodies are public forever
 * unless operators purge the bucket.
 */

import { DurableObject } from "cloudflare:workers";
import { detectContentType, isContentType, type ContentType } from "./content_type";

export const MAX_PASTE_BYTES = 256_000;
export const PASTE_PREFIX = "pastes/";
/** How many uploads the public recent list keeps. */
export const RECENT_PASTE_LIMIT = 40;
/** Max chars stored/shown as a one-line preview. */
export const PREVIEW_CHARS = 96;

export type PasteProofOfWork = {
	challenge_id: string;
	nonce: string;
	solution: string;
	pow_hash: string;
	algorithm: "sha256";
	difficulty: number;
	leading_zero_bits: number;
};

export type PasteMeta = {
	id: string;
	byte_length: number;
	sha256: string;
	created_at: string;
	region_id: number;
	region: string | null;
	content_type: ContentType;
	/** Submission audit data. Never include this in public paste responses. */
	client_ip: string | null;
	/** The verified proof which authorized this paste. */
	proof_of_work: PasteProofOfWork | null;
};

export type StoredPaste = PasteMeta & {
	content: string;
};

/** Public recent-list row (no full body, client IP, or full proof). */
export type RecentPaste = Omit<PasteMeta, "client_ip" | "proof_of_work"> & {
	pow_difficulty: number | null;
	preview: string;
};

export function pasteObjectKey(id: string): string {
	return `${PASTE_PREFIX}${id.toUpperCase()}`;
}

/** Reject empty, oversized, NULs, and non-UTF8-looking binary. */
export function validatePlaintext(content: string): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
	if (typeof content !== "string") {
		return { ok: false, error: "content must be a UTF-8 string" };
	}
	if (content.length === 0) {
		return { ok: false, error: "content is empty" };
	}
	if (content.includes("\u0000")) {
		return { ok: false, error: "content must be plaintext (NUL byte rejected)" };
	}
	const bytes = new TextEncoder().encode(content);
	if (bytes.byteLength > MAX_PASTE_BYTES) {
		return { ok: false, error: `content exceeds ${MAX_PASTE_BYTES} bytes` };
	}
	// Cheap binary sniff: high ratio of non-text control chars (excluding tab/lf/cr).
	let weird = 0;
	for (let i = 0; i < Math.min(bytes.byteLength, 4096); i++) {
		const b = bytes[i]!;
		if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
		if (b < 0x20 || b === 0x7f) weird++;
	}
	if (weird > 8) {
		return { ok: false, error: "content must be plaintext" };
	}
	return { ok: true, bytes };
}

/** One-line public preview from paste body (whitespace collapsed). */
export function makePreview(content: string, maxChars = PREVIEW_CHARS): string {
	const line = content.replace(/\s+/g, " ").trim();
	if (line.length <= maxChars) return line;
	return `${line.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export async function putPaste(
	env: Env,
	meta: PasteMeta,
	bytes: Uint8Array,
	contentForPreview?: string,
): Promise<void> {
	await env.PASTES.put(pasteObjectKey(meta.id), bytes, {
		httpMetadata: {
			contentType: "text/plain; charset=utf-8",
		},
		customMetadata: {
			id: meta.id,
			byte_length: String(meta.byte_length),
			sha256: meta.sha256,
			created_at: meta.created_at,
			region_id: String(meta.region_id),
			region: meta.region ?? "",
			content_type: meta.content_type,
			client_ip: meta.client_ip ?? "",
			pow_challenge_id: meta.proof_of_work?.challenge_id ?? "",
			pow_nonce: meta.proof_of_work?.nonce ?? "",
			pow_solution: meta.proof_of_work?.solution ?? "",
			pow_hash: meta.proof_of_work?.pow_hash ?? "",
			pow_algorithm: meta.proof_of_work?.algorithm ?? "",
			pow_difficulty: meta.proof_of_work == null ? "" : String(meta.proof_of_work.difficulty),
			pow_leading_zero_bits: meta.proof_of_work == null ? "" : String(meta.proof_of_work.leading_zero_bits),
		},
	});

	const previewSource =
		contentForPreview ?? new TextDecoder().decode(bytes);
	const entry: RecentPaste = {
		id: meta.id,
		byte_length: meta.byte_length,
		sha256: meta.sha256,
		created_at: meta.created_at,
		region_id: meta.region_id,
		region: meta.region,
		content_type: meta.content_type,
		pow_difficulty: meta.proof_of_work?.difficulty ?? null,
		preview: meta.content_type === "url"
			? "External URL (confirmation required)"
			: makePreview(previewSource),
	};
	// Index update is best-effort after the body is durable.
	await pasteIndexStub(env).record(entry);
}

function proofFromMetadata(md: Record<string, string>): PasteProofOfWork | null {
	const difficulty = Number(md.pow_difficulty);
	const leadingZeroBits = Number(md.pow_leading_zero_bits);
	if (
		!/^[0-9a-f]{32}$/.test(md.pow_challenge_id ?? "") ||
		!/^[0-9a-f]{32}$/.test(md.pow_nonce ?? "") ||
		!/^(0|[1-9][0-9]*)$/.test(md.pow_solution ?? "") ||
		!/^[0-9a-f]{64}$/.test(md.pow_hash ?? "") ||
		md.pow_algorithm !== "sha256" ||
		!/^[0-9]+$/.test(md.pow_difficulty ?? "") ||
		!/^[0-9]+$/.test(md.pow_leading_zero_bits ?? "") ||
		!Number.isInteger(difficulty) ||
		!Number.isInteger(leadingZeroBits)
	) {
		return null;
	}
	return {
		challenge_id: md.pow_challenge_id,
		nonce: md.pow_nonce,
		solution: md.pow_solution,
		pow_hash: md.pow_hash,
		algorithm: md.pow_algorithm,
		difficulty,
		leading_zero_bits: leadingZeroBits,
	};
}

export async function getPaste(env: Env, id: string): Promise<StoredPaste | null> {
	const obj = await env.PASTES.get(pasteObjectKey(id));
	if (!obj) return null;
	const content = await obj.text();
	const md = obj.customMetadata ?? {};
	return {
		id: (md.id || id).toUpperCase(),
		byte_length: Number(md.byte_length) || new TextEncoder().encode(content).byteLength,
		sha256: md.sha256 || "",
		created_at: md.created_at || obj.uploaded.toISOString(),
		region_id: Number(md.region_id) || 0,
		region: md.region || null,
		content_type: isContentType(md.content_type) ? md.content_type : detectContentType(content),
		client_ip: md.client_ip || null,
		proof_of_work: proofFromMetadata(md),
		content,
	};
}

export async function listRecentPastes(
	env: Env,
	limit = RECENT_PASTE_LIMIT,
): Promise<RecentPaste[]> {
	const n = Math.min(Math.max(1, Math.floor(limit)), RECENT_PASTE_LIMIT);
	const items = await pasteIndexStub(env).list(n);
	return items.map((item) => ({
		id: item.id,
		byte_length: item.byte_length,
		sha256: item.sha256,
		created_at: item.created_at,
		region_id: item.region_id,
		region: item.region,
		content_type: isContentType(item.content_type) ? item.content_type : "plaintext",
		pow_difficulty:
			typeof item.pow_difficulty === "number" && Number.isInteger(item.pow_difficulty)
				? item.pow_difficulty
				: null,
		preview: item.preview,
	}));
}

/**
 * Global recent-upload ledger (newest first).
 * Single DO keeps ordering simple for a basic public feed.
 */
export class PasteIndex extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS paste_rate_events (
				paste_id TEXT PRIMARY KEY,
				created_at_ms INTEGER NOT NULL
			)
		`);
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS paste_rate_events_created_at ON paste_rate_events(created_at_ms)",
		);
	}

	async record(entry: RecentPaste, limit = RECENT_PASTE_LIMIT): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			const recent = (await this.ctx.storage.get<RecentPaste[]>("recent")) ?? [];
			const next = [entry, ...recent.filter((p) => p.id !== entry.id)].slice(
				0,
				Math.max(1, limit),
			);
			await this.ctx.storage.put("recent", next);
			const createdAtMs = Date.parse(entry.created_at);
			if (!Number.isFinite(createdAtMs)) {
				throw new Error("invalid paste creation timestamp");
			}
			this.ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO paste_rate_events (paste_id, created_at_ms) VALUES (?, ?)",
				entry.id,
				createdAtMs,
			);
		});
	}

	/** Count all paste creations in the rolling window without mutating storage. */
	async countCreatedSince(sinceMs: number): Promise<number> {
		if (!Number.isFinite(sinceMs)) throw new Error("invalid paste window timestamp");
		return this.ctx.storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM paste_rate_events WHERE created_at_ms >= ?",
			sinceMs,
		).one().count;
	}

	async list(limit = RECENT_PASTE_LIMIT): Promise<RecentPaste[]> {
		const recent = (await this.ctx.storage.get<RecentPaste[]>("recent")) ?? [];
		return recent.slice(0, Math.max(1, limit));
	}
}

export function pasteIndexStub(env: Env): DurableObjectStub<PasteIndex> {
	return env.PASTE_INDEX.getByName("paste-index");
}

export async function countPastesCreatedSince(env: Env, sinceMs: number): Promise<number> {
	return pasteIndexStub(env).countCreatedSince(sinceMs);
}
