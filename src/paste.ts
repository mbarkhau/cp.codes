/**
 * Paste body storage (R2) + recent-upload index (Durable Object).
 *
 * Keys: pastes/{CP_CODE}
 * Only UTF-8 plaintext is accepted (no NULs). New bodies are stored as the
 * gzip bytes supplied by the client; R2 reads do not decompress them.
 */

import { DurableObject } from "cloudflare:workers";
import { isContentType, type ContentType } from "./content_type";
import { sha256Hex, timingSafeEqualHex } from "./pow";
import { initialModeration, type JevAssessment } from "./jev.mjs";

/** Paste bytes covered by the base proof-of-work difficulty. */
export const DEFAULT_PASTE_BYTES = 10 * 1024;
/** Each started block above the default allowance adds one difficulty bit. */
export const PASTE_DIFFICULTY_STEP_BYTES = 100 * 1024;
export const MAX_DESCRIPTION_CHARS = 1_000;
export const MAX_FILENAME_CHARS = 255;
export const PASTE_PREFIX = "pastes/";
/** How many uploads the public recent list keeps. */
export const RECENT_PASTE_LIMIT = 40;
/** Max chars stored/shown as a one-line preview. */
export const PREVIEW_CHARS = 96;
/** How long the creating client may delete its paste. */
export const DELETION_TOKEN_TTL_MS = 10 * 60 * 1000;
export const MAX_REPORT_EMAIL_CHARS = 320;

export const REPORT_CATEGORIES = [
	"copyright infringement",
	"CSAM",
	"terrorism or violent extremism",
	"threats or harassment",
	"personal information",
	"malware or phishing",
	"spam",
	"other illegal content",
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const MODERATION_DECISIONS = ["unreviewed", "approved", "restricted"] as const;
export type ModerationDecision = (typeof MODERATION_DECISIONS)[number];

export const REVIEW_REPORT_FILTERS = ["all", "pending", "reported", "unreported"] as const;
export type ReviewReportFilter = (typeof REVIEW_REPORT_FILTERS)[number];

export const PASTE_VISIBILITIES = ["visible", "hidden", "deleted"] as const;
export type PasteVisibility = (typeof PASTE_VISIBILITIES)[number];

export function isReportCategory(value: unknown): value is ReportCategory {
	return typeof value === "string" && REPORT_CATEGORIES.includes(value as ReportCategory);
}

export function isModerationDecision(value: unknown): value is ModerationDecision {
	return typeof value === "string" && MODERATION_DECISIONS.includes(value as ModerationDecision);
}

export function isReviewReportFilter(value: unknown): value is ReviewReportFilter {
	return typeof value === "string" && REVIEW_REPORT_FILTERS.includes(value as ReviewReportFilter);
}

export function isPasteVisibility(value: unknown): value is PasteVisibility {
	return typeof value === "string" && PASTE_VISIBILITIES.includes(value as PasteVisibility);
}

export type PasteDeletionGrant = {
	tokenHash: string;
	expiresAt: number;
};

export type DeletePasteResult = "deleted" | "not_found" | "expired" | "invalid_token";

export type PasteUploadMetadata = {
	"cf-connecting-ip": string | null;
	"x-real-ip": string | null;
	"cf-ipcountry": string | null;
	asn: number | null;
	asOrganization: string | null;
	country: string | null;
	isEUCountry: string | null;
	city: string | null;
	continent: string | null;
	region: string | null;
	regionCode: string | null;
	timezone: string | null;
	longitude: string | null;
	latitude: string | null;
	postalCode: string | null;
};

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
	description: string | null;
	filename: string | null;
	unlisted: boolean;
	/** Submission audit data. Never include this in public paste responses. */
	upload_metadata: PasteUploadMetadata;
	/** The verified proof which authorized this paste. */
	proof_of_work: PasteProofOfWork | null;
};

export type PasteContentEncoding = "gzip" | "identity";

/** Metadata available from an R2 HEAD; the body remains compressed in R2. */
export type StoredPaste = PasteMeta & {
	content_encoding: PasteContentEncoding;
	compressed_byte_length: number;
};

export type StoredPasteObject = {
	metadata: StoredPaste;
	body: ReadableStream<Uint8Array>;
};

/** Complete storage and application metadata shown only to authenticated staff. */
export type PasteModeration = {
	paste_id: string;
	decision: ModerationDecision;
	visibility: PasteVisibility;
	/** Staff classification. Reporter-provided reasons remain on PasteReport. */
	reason: ReportCategory | null;
	moderated_by: string | null;
	moderated_at: string | null;
	/** Highest immutable report event covered by the latest moderation action. */
	reviewed_through_report_id: number;
};

export type PasteReport = {
	id: number;
	paste_id: string;
	reported_at: string;
	category: ReportCategory | null;
	email: string | null;
};

/** Machine assessment is retained separately from staff decisions and user reports. */
export type PasteAutomoderation = JevAssessment & {
	requires_review: boolean;
	reviewed_at: string | null;
	reviewed_by: string | null;
};

export type RetainedPaste = {
	metadata: StoredPaste;
	moderation: PasteModeration;
	automoderation: PasteAutomoderation | null;
};

/** A report plus the retained paste metadata and current moderation decision. */
export type AdminPasteReport = PasteReport & {
	metadata: StoredPaste;
	moderation: PasteModeration;
};

export type AdminPaste = {
	metadata: StoredPaste;
	moderation: PasteModeration;
	automoderation: PasteAutomoderation | null;
	hit_count: number;
	storage: {
		key: string;
		version: string;
		size: number;
		etag: string;
		uploaded: string;
		storage_class: string;
		http_metadata: R2HTTPMetadata | null;
		custom_metadata: Record<string, string>;
	};
};

export type AdminPastePage = {
	items: AdminPaste[];
	cursor: string | null;
	truncated: boolean;
};

export type ReviewPaste = Pick<AdminPaste, "metadata" | "moderation" | "automoderation" | "hit_count"> & {
	reports: PasteReport[];
	report_count: number;
	pending_review: boolean;
};

export type ReviewPasteListOptions = {
	limit?: number;
	offset?: number;
	reports?: ReviewReportFilter;
	decision?: ModerationDecision;
	visibility?: PasteVisibility;
	reportReason?: ReportCategory;
	contentType?: ContentType;
	sort?: "created" | "hits" | "reported";
	order?: "asc" | "desc";
};

export type ReviewPastePage = {
	items: ReviewPaste[];
	total: number;
	offset: number;
	next_offset: number | null;
};

export type PasteAccessKind = "html" | "json" | "content" | "raw" | "redirect";

export type PasteAccessLocation = {
	city: string | null;
	region: string | null;
	region_code: string | null;
	country: string | null;
	continent: string | null;
	postal_code: string | null;
	timezone: string | null;
	latitude: string | null;
	longitude: string | null;
	colo: string | null;
};

export type PasteAccess = {
	accessed_at: string;
	ip: string | null;
	location: PasteAccessLocation;
	referer: string | null;
	kind: PasteAccessKind;
};

export type PasteAccessLogEntry = PasteAccess & {
	id: number;
	paste_id: string;
};

export type PasteAccessLogPage = {
	items: PasteAccessLogEntry[];
	next_before_id: number | null;
};

/** Public recent-list row (no full body, upload metadata, full proof, or unlisted flag). */
export type RecentPaste = Omit<
	PasteMeta,
	"upload_metadata" | "proof_of_work" | "unlisted"
> & {
	pow_difficulty: number | null;
	preview: string;
	hit_count: number;
};

export function pasteObjectKey(id: string): string {
	return `${PASTE_PREFIX}${id.toUpperCase()}`;
}

/** Extra PoW bits required for the paste's size, beyond the base allowance. */
export function pasteSizeDifficultyBits(byteLength: number): number {
	if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
		throw new Error("paste byte length out of range");
	}
	return Math.ceil(
		Math.max(0, byteLength - DEFAULT_PASTE_BYTES) / PASTE_DIFFICULTY_STEP_BYTES,
	);
}

/** Reject empty content, NULs, and non-UTF8-looking binary. */
export function validatePlaintext(
	content: string,
	encoded = new TextEncoder().encode(content),
): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
	if (typeof content !== "string") {
		return { ok: false, error: "content must be a UTF-8 string" };
	}
	if (content.length === 0) {
		return { ok: false, error: "content is empty" };
	}
	if (content.includes("\u0000")) {
		return { ok: false, error: "content must be plaintext (NUL byte rejected)" };
	}
	const bytes = encoded;
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
	compressedBytes: Uint8Array,
	deletionGrant: PasteDeletionGrant,
	preview: string,
	assessment: JevAssessment,
): Promise<void> {
	if (!/^[0-9a-f]{64}$/.test(deletionGrant.tokenHash)) {
		throw new Error("invalid deletion token hash");
	}
	if (!Number.isSafeInteger(deletionGrant.expiresAt) || deletionGrant.expiresAt <= Date.now()) {
		throw new Error("invalid deletion token expiry");
	}
	const entry: RecentPaste = {
		id: meta.id, byte_length: meta.byte_length, sha256: meta.sha256,
		created_at: meta.created_at, region_id: meta.region_id, region: meta.region,
		content_type: meta.content_type, description: meta.description, filename: meta.filename,
		pow_difficulty: meta.proof_of_work?.difficulty ?? null, hit_count: 0, preview,
	};
	const storedMetadata: StoredPaste = {
		...meta, content_encoding: "gzip", compressed_byte_length: compressedBytes.byteLength,
	};
	// Persist policy BEFORE publishing the R2 body: every read route must already
	// see the correct visibility, even if it races this upload. R2 write failures
	// can leave retained metadata, but never an unmoderated publicly readable body.
	await pasteIndexStub(env).record(entry, !meta.unlisted, RECENT_PASTE_LIMIT, storedMetadata, assessment);
	await env.PASTES.put(pasteObjectKey(meta.id), compressedBytes, {
		httpMetadata: {
			// This describes the stored representation. Raw routes apply the
			// paste's logical Content-Type and Content-Encoding themselves.
			contentType: "application/gzip",
		},
		customMetadata: {
			id: meta.id,
			byte_length: String(meta.byte_length),
			compressed_byte_length: String(compressedBytes.byteLength),
			content_encoding: "gzip",
			sha256: meta.sha256,
			created_at: meta.created_at,
			region_id: String(meta.region_id),
			region: meta.region ?? "",
			content_type: meta.content_type,
			description: meta.description ?? "",
			filename: meta.filename ?? "",
			unlisted: meta.unlisted ? "true" : "false",
			upload_cf_connecting_ip: meta.upload_metadata["cf-connecting-ip"] ?? "",
			upload_x_real_ip: meta.upload_metadata["x-real-ip"] ?? "",
			upload_cf_ipcountry: meta.upload_metadata["cf-ipcountry"] ?? "",
			upload_asn: meta.upload_metadata.asn == null ? "" : String(meta.upload_metadata.asn),
			upload_as_organization: meta.upload_metadata.asOrganization ?? "",
			upload_country: meta.upload_metadata.country ?? "",
			upload_is_eu_country: meta.upload_metadata.isEUCountry ?? "",
			upload_city: meta.upload_metadata.city ?? "",
			upload_continent: meta.upload_metadata.continent ?? "",
			upload_region: meta.upload_metadata.region ?? "",
			upload_region_code: meta.upload_metadata.regionCode ?? "",
			upload_timezone: meta.upload_metadata.timezone ?? "",
			upload_longitude: meta.upload_metadata.longitude ?? "",
			upload_latitude: meta.upload_metadata.latitude ?? "",
			upload_postal_code: meta.upload_metadata.postalCode ?? "",
			pow_challenge_id: meta.proof_of_work?.challenge_id ?? "",
			pow_nonce: meta.proof_of_work?.nonce ?? "",
			pow_solution: meta.proof_of_work?.solution ?? "",
			pow_hash: meta.proof_of_work?.pow_hash ?? "",
			pow_algorithm: meta.proof_of_work?.algorithm ?? "",
			pow_difficulty: meta.proof_of_work == null ? "" : String(meta.proof_of_work.difficulty),
			pow_leading_zero_bits: meta.proof_of_work == null ? "" : String(meta.proof_of_work.leading_zero_bits),
			deletion_token_hash: deletionGrant.tokenHash,
			deletion_expires_at: String(deletionGrant.expiresAt),
		},
	});

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

function uploadMetadataFromStorage(md: Record<string, string>): PasteUploadMetadata {
	const asn = Number(md.upload_asn);
	return {
		"cf-connecting-ip": md.upload_cf_connecting_ip || null,
		"x-real-ip": md.upload_x_real_ip || null,
		"cf-ipcountry": md.upload_cf_ipcountry || null,
		asn: /^\d+$/.test(md.upload_asn ?? "") && Number.isSafeInteger(asn) ? asn : null,
		asOrganization: md.upload_as_organization || null,
		country: md.upload_country || null,
		isEUCountry: md.upload_is_eu_country || null,
		city: md.upload_city || null,
		continent: md.upload_continent || null,
		region: md.upload_region || null,
		regionCode: md.upload_region_code || null,
		timezone: md.upload_timezone || null,
		longitude: md.upload_longitude || null,
		latitude: md.upload_latitude || null,
		postalCode: md.upload_postal_code || null,
	};
}

export function pasteMetadataFromObject(obj: R2Object, id: string): StoredPaste {
	const md = obj.customMetadata ?? {};
	const storedByteLength = Number(md.byte_length);
	const storedCompressedByteLength = Number(md.compressed_byte_length);
	return {
		id: (md.id || id).toUpperCase(),
		byte_length: Number.isSafeInteger(storedByteLength) && storedByteLength > 0
			? storedByteLength
			: obj.size,
		compressed_byte_length:
			Number.isSafeInteger(storedCompressedByteLength) && storedCompressedByteLength > 0
				? storedCompressedByteLength
				: obj.size,
		content_encoding: md.content_encoding === "gzip" ? "gzip" : "identity",
		sha256: md.sha256 || "",
		created_at: md.created_at || obj.uploaded.toISOString(),
		region_id: Number(md.region_id) || 0,
		region: md.region || null,
		content_type: isContentType(md.content_type) ? md.content_type : "plaintext",
		description: md.description || null,
		filename: md.filename || null,
		unlisted: md.unlisted === "true",
		upload_metadata: uploadMetadataFromStorage(md),
		proof_of_work: proofFromMetadata(md),
	};
}

/** List every paste, including unlisted entries and private upload metadata, for staff. */
export async function listPastesForAdmin(
	env: Env,
	options: { cursor?: string; limit?: number } = {},
): Promise<AdminPastePage> {
	const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 1_000);
	const listed = await env.PASTES.list({
		prefix: PASTE_PREFIX,
		limit,
		cursor: options.cursor,
		include: ["httpMetadata", "customMetadata"],
	});
	const metadata = listed.objects.map((object) =>
		pasteMetadataFromObject(object, object.key.slice(PASTE_PREFIX.length))
	);
	const ids = metadata.map((item) => item.id);
	const [hitCounts, moderations, automoderations] = await Promise.all([
		pasteIndexStub(env).getHitCounts(ids),
		pasteIndexStub(env).getModerations(ids),
		pasteIndexStub(env).getAutomoderations(ids),
	]);
	return {
		items: listed.objects.map((object, index) => {
			const itemMetadata = metadata[index]!;
			return {
				metadata: itemMetadata,
				moderation: moderations[itemMetadata.id] ?? defaultModeration(itemMetadata.id),
				automoderation: automoderations[itemMetadata.id] ?? null,
				hit_count: hitCounts[itemMetadata.id] ?? 0,
				storage: {
					key: object.key,
					version: object.version,
					size: object.size,
					etag: object.etag,
					uploaded: object.uploaded.toISOString(),
					storage_class: object.storageClass,
					http_metadata: object.httpMetadata ?? null,
					custom_metadata: object.customMetadata ?? {},
				},
			};
		}),
		cursor: listed.truncated ? listed.cursor : null,
		truncated: listed.truncated,
	};
}

/** Read paste metadata without downloading or decoding its body. */
export async function getPasteMetadata(env: Env, id: string): Promise<StoredPaste | null> {
	const obj = await env.PASTES.head(pasteObjectKey(id));
	return obj ? pasteMetadataFromObject(obj, id) : null;
}

/** Read the stored representation. The returned stream is gzip for new pastes. */
export async function getPasteObject(env: Env, id: string): Promise<StoredPasteObject | null> {
	const obj = await env.PASTES.get(pasteObjectKey(id));
	if (!obj) return null;
	return {
		metadata: pasteMetadataFromObject(obj, id),
		body: obj.body,
	};
}

export async function deletePasteWithToken(
	env: Env,
	id: string,
	token: string,
): Promise<DeletePasteResult> {
	if (!/^[0-9a-f]{64}$/.test(token)) return "invalid_token";

	const object = await env.PASTES.head(pasteObjectKey(id));
	if (!object) return "not_found";
	const metadata = object.customMetadata ?? {};
	const expiresAt = Number(metadata.deletion_expires_at);
	if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return "invalid_token";
	if (Date.now() >= expiresAt) return "expired";

	const tokenHash = await sha256Hex(token);
	if (
		!/^[0-9a-f]{64}$/.test(metadata.deletion_token_hash ?? "") ||
		!timingSafeEqualHex(tokenHash, metadata.deletion_token_hash)
	) {
		return "invalid_token";
	}

	// Make the paste inaccessible and persist its origin metadata before removing
	// the body. This way an R2 failure cannot accidentally expose content already
	// marked as deleted, and a successful deletion never loses its audit trail.
	await pasteIndexStub(env).markDeleted(id, pasteMetadataFromObject(object, id));
	await env.PASTES.delete(pasteObjectKey(id));
	return "deleted";
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
		description: typeof item.description === "string" && item.description ? item.description : null,
		filename: typeof item.filename === "string" && item.filename ? item.filename : null,
		pow_difficulty:
			typeof item.pow_difficulty === "number" && Number.isInteger(item.pow_difficulty)
				? item.pow_difficulty
				: null,
		preview: item.preview,
		hit_count:
			typeof item.hit_count === "number" && Number.isSafeInteger(item.hit_count)
				? Math.max(0, item.hit_count)
				: 0,
	}));
}

type ModerationRow = {
	paste_id: string;
	decision: string | null;
	visibility: string | null;
	reason: string | null;
	moderated_by: string | null;
	moderated_at_ms: number | null;
	reviewed_report_id: number | null;
};

export function defaultModeration(id: string): PasteModeration {
	return {
		paste_id: id.toUpperCase(),
		decision: "unreviewed",
		visibility: "visible",
		reason: null,
		moderated_by: null,
		moderated_at: null,
		reviewed_through_report_id: 0,
	};
}

function moderationFromRow(row: ModerationRow): PasteModeration {
	return {
		paste_id: row.paste_id,
		decision: isModerationDecision(row.decision) ? row.decision : "unreviewed",
		visibility: isPasteVisibility(row.visibility) ? row.visibility : "visible",
		reason: isReportCategory(row.reason) ? row.reason : null,
		moderated_by: row.moderated_by,
		moderated_at: row.moderated_at_ms === null ? null : new Date(row.moderated_at_ms).toISOString(),
		reviewed_through_report_id: row.reviewed_report_id ?? 0,
	};
}

type AutomoderationRow = {
	paste_id: string;
	assessment_json: string | null;
	requires_review: number | null;
	reviewed_at_ms: number | null;
	reviewed_by: string | null;
};

function automoderationFromRow(row: AutomoderationRow): PasteAutomoderation | null {
	if (row.assessment_json === null) return null;
	const assessment: JevAssessment = JSON.parse(row.assessment_json);
	return {
		...assessment,
		requires_review: row.requires_review === 1 && row.reviewed_at_ms === null,
		reviewed_at: row.reviewed_at_ms === null ? null : new Date(row.reviewed_at_ms).toISOString(),
		reviewed_by: row.reviewed_by,
	};
}

function storedPasteFromJson(value: string, id: string): StoredPaste {
	const parsed: unknown = JSON.parse(value);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`invalid retained metadata for ${id}`);
	}
	return parsed as StoredPaste;
}

/**
 * Global recent-upload ledger and moderation/reporting database.
 * Single DO keeps moderation decisions and body deletion ordering consistent.
 */
export class PasteIndex extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS paste_rate_events (
				paste_id TEXT PRIMARY KEY,
				created_at_ms INTEGER NOT NULL
			)
		`);
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS paste_rate_events_created_at ON paste_rate_events(created_at_ms)",
		);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS paste_hit_counts (
				paste_id TEXT PRIMARY KEY,
				hit_count INTEGER NOT NULL CHECK (hit_count >= 0)
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS paste_access_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				paste_id TEXT NOT NULL,
				accessed_at_ms INTEGER NOT NULL,
				kind TEXT NOT NULL,
				ip TEXT,
				referer TEXT,
				city TEXT,
				region TEXT,
				region_code TEXT,
				country TEXT,
				continent TEXT,
				postal_code TEXT,
				timezone TEXT,
				latitude TEXT,
				longitude TEXT,
				colo TEXT
			)
		`);
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS paste_access_log_paste_time ON paste_access_log(paste_id, accessed_at_ms DESC)",
		);
		// Paste identity/metadata, moderation decisions, and user reports are kept
		// separate. A report is an immutable event; it never overwrites a staff
		// classification. Pending review is derived from immutable report ids and
		// the highest id acknowledged by the newest moderation action.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS paste_records (
				paste_id TEXT PRIMARY KEY,
				metadata_json TEXT NOT NULL,
				listed INTEGER NOT NULL DEFAULT 0,
				recorded_at_ms INTEGER NOT NULL
			)
		`);
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS paste_records_content_type ON paste_records(json_extract(metadata_json, '$.content_type'))",
		);
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS paste_records_created_at ON paste_records(json_extract(metadata_json, '$.created_at'))",
		);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS paste_moderation_state (
				paste_id TEXT PRIMARY KEY,
				decision TEXT NOT NULL,
				visibility TEXT NOT NULL,
				reason TEXT,
				moderated_by TEXT,
				moderated_at_ms INTEGER,
				reviewed_report_id INTEGER NOT NULL DEFAULT 0
			)
		`);
		const moderationColumns = this.ctx.storage.sql.exec<{ name: string }>(
			"PRAGMA table_info(paste_moderation_state)",
		).toArray();
		if (!moderationColumns.some((column) => column.name === "reviewed_report_id")) {
			this.ctx.storage.sql.exec(
				"ALTER TABLE paste_moderation_state ADD COLUMN reviewed_report_id INTEGER NOT NULL DEFAULT 0",
			);
		}
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS paste_moderation_state_decision ON paste_moderation_state(decision)",
		);
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS paste_moderation_state_visibility ON paste_moderation_state(visibility)",
		);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS paste_automoderation (
				paste_id TEXT PRIMARY KEY,
				assessment_json TEXT NOT NULL,
				requires_review INTEGER NOT NULL CHECK (requires_review IN (0, 1)),
				reviewed_at_ms INTEGER,
				reviewed_by TEXT
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS paste_reports (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				paste_id TEXT NOT NULL,
				reported_at_ms INTEGER NOT NULL,
				category TEXT,
				email TEXT
			)
		`);
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS paste_reports_paste_time ON paste_reports(paste_id, reported_at_ms DESC)",
		);
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS paste_reports_time ON paste_reports(reported_at_ms DESC)",
		);

		// One-way compatibility migration from the original table, which mixed
		// retained metadata, reporter reasons, and staff decisions in one row.
		const legacy = this.ctx.storage.sql.exec<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'paste_moderation'",
		).toArray()[0];
		if (legacy) {
			this.ctx.storage.sql.exec(`
				INSERT OR IGNORE INTO paste_records (paste_id, metadata_json, listed, recorded_at_ms)
				SELECT paste_id, metadata_json, listed, updated_at_ms FROM paste_moderation
			`);
			this.ctx.storage.sql.exec(`
				INSERT OR IGNORE INTO paste_moderation_state (
					paste_id, decision, visibility, reason, moderated_by, moderated_at_ms,
					reviewed_report_id
				)
				SELECT paste_id,
					CASE
						WHEN reviewer IS NULL OR review_status = 'not reviewed' THEN 'unreviewed'
						WHEN category IS NULL THEN 'approved'
						ELSE 'restricted'
					END,
					visibility,
					CASE WHEN reviewer IS NOT NULL AND review_status != 'not reviewed' THEN category END,
					reviewer,
					CASE WHEN reviewer IS NOT NULL THEN updated_at_ms END,
					CASE WHEN reviewer IS NOT NULL AND review_status != 'not reviewed'
						THEN COALESCE((SELECT MAX(r.id) FROM paste_reports r WHERE r.paste_id = paste_moderation.paste_id), 0)
						ELSE 0
					END
				FROM paste_moderation
			`);
		}
		});
	}

	async record(
		entry: RecentPaste,
		includeInRecent = true,
		limit = RECENT_PASTE_LIMIT,
		metadata?: StoredPaste,
		assessment?: JevAssessment,
	): Promise<void> {
		const createdAtMs = Date.parse(entry.created_at);
		if (!Number.isFinite(createdAtMs)) throw new Error("invalid paste creation timestamp");
		const pasteId = entry.id.toUpperCase();
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO paste_rate_events (paste_id, created_at_ms) VALUES (?, ?)",
				pasteId, createdAtMs,
			);
			if (metadata) {
				this.ctx.storage.sql.exec(`
					INSERT INTO paste_records (paste_id, metadata_json, listed, recorded_at_ms)
					VALUES (?, ?, ?, ?)
					ON CONFLICT (paste_id) DO UPDATE SET
						metadata_json = excluded.metadata_json, listed = excluded.listed
				`, pasteId, JSON.stringify(metadata), includeInRecent ? 1 : 0, Date.now());
			}
			if (assessment) {
				const policy = initialModeration(assessment);
				this.ctx.storage.sql.exec(`
					INSERT OR IGNORE INTO paste_automoderation (paste_id, assessment_json, requires_review)
					VALUES (?, ?, ?)
				`, pasteId, JSON.stringify(assessment), policy.requires_review ? 1 : 0);
				// Initialization only: a duplicate/retried upload record must never
				// overwrite a human decision or resurrect a deleted paste.
				this.ctx.storage.sql.exec(`
					INSERT OR IGNORE INTO paste_moderation_state (
						paste_id, decision, visibility, reason, moderated_by, moderated_at_ms, reviewed_report_id
					) VALUES (?, ?, ?, ?, 'jev', ?, 0)
				`, pasteId, policy.decision, policy.visibility, policy.reason, Date.parse(assessment.assessed_at));
			}
		});
		if (includeInRecent) {
			const recent = (await this.ctx.storage.get<RecentPaste[]>("recent")) ?? [];
			await this.ctx.storage.put("recent", [entry, ...recent.filter((p) => p.id !== entry.id)].slice(0, Math.max(1, limit)));
		}
	}

	/** Remove a deleted paste from the public feed, while retaining its rate event. */
	async remove(id: string): Promise<void> {
		const normalizedId = id.toUpperCase();
		const recent = (await this.ctx.storage.get<RecentPaste[]>("recent")) ?? [];
		const next = recent.filter((entry) => entry.id !== normalizedId);
		if (next.length !== recent.length) await this.ctx.storage.put("recent", next);
		this.ctx.storage.sql.exec(
			"DELETE FROM paste_hit_counts WHERE paste_id = ?",
			normalizedId,
		);
	}

	/** Count all paste creations in the rolling window without mutating storage. */
	async countCreatedSince(sinceMs: number): Promise<number> {
		if (!Number.isFinite(sinceMs)) throw new Error("invalid paste window timestamp");
		return this.ctx.storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM paste_rate_events WHERE created_at_ms >= ?",
			sinceMs,
		).one().count;
	}

	incrementHitCount(id: string): number {
		return this.ctx.storage.sql.exec<{ hit_count: number }>(`
			INSERT INTO paste_hit_counts (paste_id, hit_count) VALUES (?, 1)
			ON CONFLICT (paste_id) DO UPDATE SET hit_count = hit_count + 1
			RETURNING hit_count
		`, id.toUpperCase()).one().hit_count;
	}

	recordAccess(id: string, access: PasteAccess, incrementHit = true): number {
		const pasteId = id.toUpperCase();
		const accessedAtMs = Date.parse(access.accessed_at);
		if (!Number.isFinite(accessedAtMs)) throw new Error("invalid access timestamp");
		if (
			access.kind !== "html" && access.kind !== "json" &&
			access.kind !== "content" && access.kind !== "raw" &&
			access.kind !== "redirect"
		) {
			throw new Error("invalid access kind");
		}
		const nullable = (value: string | null, maxLength: number): string | null =>
			typeof value === "string" && value.length > 0 ? value.slice(0, maxLength) : null;
		this.ctx.storage.sql.exec(`
			INSERT INTO paste_access_log (
				paste_id, accessed_at_ms, kind, ip, referer, city, region,
				region_code, country, continent, postal_code, timezone,
				latitude, longitude, colo
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
			pasteId,
			accessedAtMs,
			access.kind,
			nullable(access.ip, 128),
			nullable(access.referer, 8_192),
			nullable(access.location.city, 256),
			nullable(access.location.region, 256),
			nullable(access.location.region_code, 64),
			nullable(access.location.country, 64),
			nullable(access.location.continent, 64),
			nullable(access.location.postal_code, 64),
			nullable(access.location.timezone, 128),
			nullable(access.location.latitude, 64),
			nullable(access.location.longitude, 64),
			nullable(access.location.colo, 64),
		);
		return incrementHit ? this.incrementHitCount(pasteId) : this.getHitCount(pasteId);
	}

	listAccessLog(limit = 100, beforeId?: number): PasteAccessLogPage {
		const normalizedLimit = Math.min(Math.max(1, Math.floor(limit)), 1_000);
		if (beforeId !== undefined && (!Number.isSafeInteger(beforeId) || beforeId < 1)) {
			throw new Error("invalid access log cursor");
		}
		type AccessRow = {
			id: number;
			paste_id: string;
			accessed_at_ms: number;
			kind: string;
			ip: string | null;
			referer: string | null;
			city: string | null;
			region: string | null;
			region_code: string | null;
			country: string | null;
			continent: string | null;
			postal_code: string | null;
			timezone: string | null;
			latitude: string | null;
			longitude: string | null;
			colo: string | null;
		};
		const columns = `id, paste_id, accessed_at_ms, kind, ip, referer, city,
			region, region_code, country, continent, postal_code, timezone,
			latitude, longitude, colo`;
		const rows = beforeId === undefined
			? this.ctx.storage.sql.exec<AccessRow>(
				`SELECT ${columns} FROM paste_access_log ORDER BY id DESC LIMIT ?`,
				normalizedLimit + 1,
			).toArray()
			: this.ctx.storage.sql.exec<AccessRow>(
				`SELECT ${columns} FROM paste_access_log WHERE id < ? ORDER BY id DESC LIMIT ?`,
				beforeId,
				normalizedLimit + 1,
			).toArray();
		const pageRows = rows.slice(0, normalizedLimit);
		return {
			items: pageRows.map((row) => ({
				id: row.id,
				paste_id: row.paste_id,
				accessed_at: new Date(row.accessed_at_ms).toISOString(),
				kind: row.kind === "html" || row.kind === "json" || row.kind === "raw" || row.kind === "redirect"
					? row.kind
					: "content",
				ip: row.ip,
				referer: row.referer,
				location: {
					city: row.city,
					region: row.region,
					region_code: row.region_code,
					country: row.country,
					continent: row.continent,
					postal_code: row.postal_code,
					timezone: row.timezone,
					latitude: row.latitude,
					longitude: row.longitude,
					colo: row.colo,
				},
			})),
			next_before_id: rows.length > normalizedLimit
				? pageRows[pageRows.length - 1]!.id
				: null,
		};
	}

	getHitCount(id: string): number {
		return this.ctx.storage.sql.exec<{ hit_count: number }>(
			"SELECT hit_count FROM paste_hit_counts WHERE paste_id = ?",
			id.toUpperCase(),
		).toArray()[0]?.hit_count ?? 0;
	}

	getHitCounts(ids: string[]): Record<string, number> {
		const normalized = [...new Set(ids.map((id) => id.toUpperCase()))].slice(0, 1_000);
		if (normalized.length === 0) return {};
		const placeholders = normalized.map(() => "?").join(", ");
		const rows = this.ctx.storage.sql.exec<{ paste_id: string; hit_count: number }>(
			`SELECT paste_id, hit_count FROM paste_hit_counts WHERE paste_id IN (${placeholders})`,
			...normalized,
		).toArray();
		return Object.fromEntries(rows.map((row) => [row.paste_id, row.hit_count]));
	}

	async list(limit = RECENT_PASTE_LIMIT): Promise<RecentPaste[]> {
		const recent = (await this.ctx.storage.get<RecentPaste[]>("recent")) ?? [];
		if (recent.length === 0) return recent;

		const placeholders = recent.map(() => "?").join(", ");
		const ids = recent.map((item) => item.id.toUpperCase());
		const hitRows = this.ctx.storage.sql.exec<{ paste_id: string; hit_count: number }>(
			`SELECT paste_id, hit_count FROM paste_hit_counts WHERE paste_id IN (${placeholders})`,
			...ids,
		).toArray();
		const visibilityRows = this.ctx.storage.sql.exec<{ paste_id: string; visibility: string }>(
			`SELECT paste_id, visibility FROM paste_moderation_state WHERE paste_id IN (${placeholders})`,
			...ids,
		).toArray();
		const hitCounts = new Map(hitRows.map((row) => [row.paste_id, row.hit_count]));
		const visibilities = new Map(visibilityRows.map((row) => [row.paste_id, row.visibility]));
		return recent
			.filter((item) => (visibilities.get(item.id.toUpperCase()) ?? "visible") === "visible")
			.slice(0, Math.max(1, limit))
			.map((item) => ({
				...item,
				hit_count: hitCounts.get(item.id.toUpperCase()) ?? 0,
			}));
	}

	getModeration(id: string): PasteModeration {
		const pasteId = id.toUpperCase();
		const row = this.ctx.storage.sql.exec<ModerationRow>(
			`SELECT paste_id, decision, visibility, reason, moderated_by, moderated_at_ms, reviewed_report_id
			 FROM paste_moderation_state WHERE paste_id = ?`,
			pasteId,
		).toArray()[0];
		return row ? moderationFromRow(row) : defaultModeration(pasteId);
	}

	getModerations(ids: string[]): Record<string, PasteModeration> {
		const normalized = [...new Set(ids.map((id) => id.toUpperCase()))].slice(0, 1_000);
		if (normalized.length === 0) return {};
		const placeholders = normalized.map(() => "?").join(", ");
		const rows = this.ctx.storage.sql.exec<ModerationRow>(
			`SELECT paste_id, decision, visibility, reason, moderated_by, moderated_at_ms, reviewed_report_id
			 FROM paste_moderation_state WHERE paste_id IN (${placeholders})`,
			...normalized,
		).toArray();
		return Object.fromEntries(rows.map((row) => [row.paste_id, moderationFromRow(row)]));
	}

	getAutomoderations(ids: string[]): Record<string, PasteAutomoderation> {
		const normalized = [...new Set(ids.map((id) => id.toUpperCase()))].slice(0, 1_000);
		if (normalized.length === 0) return {};
		const rows = this.ctx.storage.sql.exec<AutomoderationRow>(`
			SELECT paste_id, assessment_json, requires_review, reviewed_at_ms, reviewed_by
			FROM paste_automoderation WHERE paste_id IN (${normalized.map(() => "?").join(", ")})
		`, ...normalized).toArray();
		return Object.fromEntries(rows.map((row) => [row.paste_id, automoderationFromRow(row)!]));
	}

	async reviewIndexNeedsBackfill(): Promise<boolean> {
		return !(await this.ctx.storage.get<boolean>("review-index-backfilled-v2"));
	}

	async backfillReviewIndex(items: StoredPaste[], complete: boolean): Promise<void> {
		this.ctx.storage.transactionSync(() => {
			for (const metadata of items) {
				this.ctx.storage.sql.exec(`
					INSERT OR IGNORE INTO paste_records (
						paste_id, metadata_json, listed, recorded_at_ms
					) VALUES (?, ?, ?, ?)
				`, metadata.id.toUpperCase(), JSON.stringify(metadata), metadata.unlisted ? 0 : 1, Date.now());
			}
		});
		if (complete) await this.ctx.storage.put("review-index-backfilled-v2", true);
	}

	listForReview(options: ReviewPasteListOptions = {}): ReviewPastePage {
		const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 1_000);
		const offset = Math.max(0, Math.floor(options.offset ?? 0));
		if (!Number.isSafeInteger(offset)) throw new Error("invalid review offset");
		const reports = options.reports ?? "pending";
		if (!isReviewReportFilter(reports)) throw new Error("invalid report filter");
		if (options.decision !== undefined && !isModerationDecision(options.decision)) {
			throw new Error("invalid moderation decision filter");
		}
		if (options.visibility !== undefined && !isPasteVisibility(options.visibility)) {
			throw new Error("invalid visibility filter");
		}
		if (options.reportReason !== undefined && !isReportCategory(options.reportReason)) {
			throw new Error("invalid report reason filter");
		}
		if (options.contentType !== undefined && !isContentType(options.contentType)) {
			throw new Error("invalid content type filter");
		}
		const sort = options.sort ?? "reported";
		const order = options.order ?? "desc";
		if (sort !== "created" && sort !== "hits" && sort !== "reported") {
			throw new Error("invalid review sort field");
		}
		if (order !== "asc" && order !== "desc") throw new Error("invalid review sort order");

		const where: string[] = [];
		const parameters: (string | number)[] = [];
		const hasReport = "EXISTS (SELECT 1 FROM paste_reports r WHERE r.paste_id = p.paste_id)";
		const hasPendingReport = `EXISTS (
			SELECT 1 FROM paste_reports r WHERE r.paste_id = p.paste_id
			AND r.id > COALESCE(s.reviewed_report_id, 0)
		)`;
		const hasPendingAutomoderation = "a.requires_review = 1 AND a.reviewed_at_ms IS NULL AND COALESCE(s.visibility, 'visible') != 'deleted'";
		if (reports === "pending") where.push(`(${hasPendingReport} OR (${hasPendingAutomoderation}))`);
		if (reports === "reported") where.push(hasReport);
		if (reports === "unreported") where.push(`NOT ${hasReport}`);
		if (options.decision !== undefined) {
			where.push("COALESCE(s.decision, 'unreviewed') = ?");
			parameters.push(options.decision);
		}
		if (options.visibility !== undefined) {
			where.push("COALESCE(s.visibility, 'visible') = ?");
			parameters.push(options.visibility);
		}
		if (options.reportReason !== undefined) {
			where.push("EXISTS (SELECT 1 FROM paste_reports rr WHERE rr.paste_id = p.paste_id AND rr.category = ?)");
			parameters.push(options.reportReason);
		}
		if (options.contentType !== undefined) {
			where.push("json_extract(p.metadata_json, '$.content_type') = ?");
			parameters.push(options.contentType);
		}
		const joins = `FROM paste_records p
			LEFT JOIN paste_moderation_state s ON s.paste_id = p.paste_id
			LEFT JOIN paste_hit_counts h ON h.paste_id = p.paste_id
			LEFT JOIN paste_automoderation a ON a.paste_id = p.paste_id`;
		const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
		const total = this.ctx.storage.sql.exec<{ count: number }>(
			`SELECT COUNT(*) AS count ${joins} ${whereSql}`,
			...parameters,
		).one().count;
		type ReviewRow = ModerationRow & AutomoderationRow & {
			metadata_json: string;
			hit_count: number;
			latest_reported_at_ms: number | null;
			report_count: number;
			latest_report_id: number | null;
		};
		const orderExpression = sort === "hits"
			? "COALESCE(h.hit_count, 0)"
			: sort === "reported"
				? "latest_reported_at_ms"
				: "json_extract(p.metadata_json, '$.created_at')";
		const rows = this.ctx.storage.sql.exec<ReviewRow>(`
			SELECT p.paste_id, s.decision, s.visibility, s.reason, s.moderated_by,
				s.moderated_at_ms, s.reviewed_report_id, p.metadata_json,
				a.assessment_json, a.requires_review, a.reviewed_at_ms, a.reviewed_by,
				COALESCE(h.hit_count, 0) AS hit_count,
				(SELECT MAX(r.reported_at_ms) FROM paste_reports r WHERE r.paste_id = p.paste_id) AS latest_reported_at_ms,
				(SELECT COUNT(*) FROM paste_reports r WHERE r.paste_id = p.paste_id) AS report_count,
				(SELECT MAX(r.id) FROM paste_reports r WHERE r.paste_id = p.paste_id) AS latest_report_id
			${joins}
			${whereSql}
			ORDER BY ${orderExpression} ${order.toUpperCase()}, p.paste_id ASC
			LIMIT ? OFFSET ?
		`, ...parameters, limit, offset).toArray();
		const ids = rows.map((row) => row.paste_id);
		const reportsByPaste = new Map<string, PasteReport[]>();
		if (ids.length > 0) {
			const placeholders = ids.map(() => "?").join(", ");
			const reportRows = this.ctx.storage.sql.exec<{
				id: number; paste_id: string; reported_at_ms: number; category: string | null; email: string | null;
			}>(`
				SELECT id, paste_id, reported_at_ms, category, email FROM (
					SELECT id, paste_id, reported_at_ms, category, email,
						ROW_NUMBER() OVER (PARTITION BY paste_id ORDER BY id DESC) AS report_rank
					FROM paste_reports WHERE paste_id IN (${placeholders})
				) WHERE report_rank <= 20 ORDER BY id DESC
			`, ...ids).toArray();
			for (const report of reportRows) {
				const item: PasteReport = {
					id: report.id,
					paste_id: report.paste_id,
					reported_at: new Date(report.reported_at_ms).toISOString(),
					category: isReportCategory(report.category) ? report.category : null,
					email: report.email,
				};
				const existing = reportsByPaste.get(report.paste_id) ?? [];
				existing.push(item);
				reportsByPaste.set(report.paste_id, existing);
			}
		}
		return {
			items: rows.map((row) => {
				const moderation = moderationFromRow(row);
				const automoderation = automoderationFromRow(row);
				return {
					metadata: storedPasteFromJson(row.metadata_json, row.paste_id),
					moderation,
					automoderation,
					hit_count: row.hit_count,
					reports: reportsByPaste.get(row.paste_id) ?? [],
					report_count: row.report_count,
					pending_review: (row.latest_report_id !== null && row.latest_report_id > moderation.reviewed_through_report_id) ||
						(automoderation?.requires_review === true && moderation.visibility !== "deleted"),
				};
			}),
			total,
			offset,
			next_offset: offset + rows.length < total ? offset + rows.length : null,
		};
	}

	getRetainedPaste(id: string): RetainedPaste | null {
		const pasteId = id.toUpperCase();
		const row = this.ctx.storage.sql.exec<ModerationRow & { metadata_json: string }>(`
			SELECT p.paste_id, s.decision, s.visibility, s.reason, s.moderated_by,
				s.moderated_at_ms, s.reviewed_report_id, p.metadata_json
			FROM paste_records p
			LEFT JOIN paste_moderation_state s ON s.paste_id = p.paste_id
			WHERE p.paste_id = ?
		`, pasteId).toArray()[0];
		return row ? {
			metadata: storedPasteFromJson(row.metadata_json, pasteId),
			moderation: moderationFromRow(row),
			automoderation: this.getAutomoderations([pasteId])[pasteId] ?? null,
		} : null;
	}

	submitReport(
		id: string,
		category: ReportCategory | null,
		email: string | null,
		metadata: StoredPaste,
	): PasteReport {
		if (category !== null && !isReportCategory(category)) throw new Error("invalid report category");
		if (email !== null && (email.length > MAX_REPORT_EMAIL_CHARS || email.includes("\u0000"))) {
			throw new Error("invalid report email");
		}
		const pasteId = id.toUpperCase();
		const now = Date.now();
		return this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(`
				INSERT INTO paste_records (paste_id, metadata_json, listed, recorded_at_ms)
				VALUES (?, ?, ?, ?)
				ON CONFLICT (paste_id) DO UPDATE SET metadata_json = excluded.metadata_json
			`, pasteId, JSON.stringify(metadata), metadata.unlisted ? 0 : 1, now);
			const reportId = this.ctx.storage.sql.exec<{ id: number }>(
				`INSERT INTO paste_reports (paste_id, reported_at_ms, category, email)
				 VALUES (?, ?, ?, ?) RETURNING id`,
				pasteId, now, category, email,
			).one().id;
			return {
				id: reportId,
				paste_id: pasteId,
				reported_at: new Date(now).toISOString(),
				category,
				email,
			};
		});
	}

	updateModeration(
		id: string,
		input: { decision: ModerationDecision; visibility: PasteVisibility; moderatedBy: string; reason: ReportCategory | null },
		metadata?: StoredPaste,
	): PasteModeration {
		if (!isModerationDecision(input.decision)) throw new Error("invalid moderation decision");
		if (!isPasteVisibility(input.visibility)) throw new Error("invalid paste visibility");
		if (!input.moderatedBy || input.moderatedBy.length > 128) throw new Error("invalid moderator");
		if (input.reason !== null && !isReportCategory(input.reason)) throw new Error("invalid reason");
		if (input.decision === "restricted" && input.reason === null) {
			throw new Error("restricted decisions require a reason");
		}
		if (input.decision !== "restricted" && input.reason !== null) {
			throw new Error("only restricted decisions may have a reason");
		}
		const pasteId = id.toUpperCase();
		const existing = this.ctx.storage.sql.exec<{ paste_id: string }>(
			"SELECT paste_id FROM paste_records WHERE paste_id = ?",
			pasteId,
		).toArray()[0];
		if (metadata) {
			this.ctx.storage.sql.exec(`
				INSERT INTO paste_records (paste_id, metadata_json, listed, recorded_at_ms)
				VALUES (?, ?, ?, ?)
				ON CONFLICT (paste_id) DO UPDATE SET metadata_json = excluded.metadata_json
			`, pasteId, JSON.stringify(metadata), metadata.unlisted ? 0 : 1, Date.now());
		} else if (!existing) {
			throw new Error("paste metadata is required");
		}
		const now = Date.now();
		const reviewedReportId = this.ctx.storage.sql.exec<{ id: number }>(
			"SELECT COALESCE(MAX(id), 0) AS id FROM paste_reports WHERE paste_id = ?",
			pasteId,
		).one().id;
		this.ctx.storage.sql.exec(`
			INSERT INTO paste_moderation_state (
				paste_id, decision, visibility, reason, moderated_by, moderated_at_ms,
				reviewed_report_id
			) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (paste_id) DO UPDATE SET
				decision = excluded.decision,
				visibility = excluded.visibility,
				reason = excluded.reason,
				moderated_by = excluded.moderated_by,
				moderated_at_ms = excluded.moderated_at_ms,
				reviewed_report_id = excluded.reviewed_report_id
		`, pasteId, input.decision, input.visibility, input.reason, input.moderatedBy, now, reviewedReportId);
		// A staff action acknowledges the machine-review task, not its original
		// immutable assessment. Future user reports still reopen pending review.
		this.ctx.storage.sql.exec(`
			UPDATE paste_automoderation SET reviewed_at_ms = ?, reviewed_by = ?
			WHERE paste_id = ?
		`, now, input.moderatedBy, pasteId);
		return {
			paste_id: pasteId,
			decision: input.decision,
			visibility: input.visibility,
			reason: input.reason,
			moderated_by: input.moderatedBy,
			moderated_at: new Date(now).toISOString(),
			reviewed_through_report_id: reviewedReportId,
		};
	}

	markDeleted(id: string, metadata: StoredPaste): PasteModeration {
		const current = this.getModeration(id);
		const pasteId = id.toUpperCase();
		const now = Date.now();
		this.ctx.storage.sql.exec(`
			INSERT INTO paste_records (paste_id, metadata_json, listed, recorded_at_ms)
			VALUES (?, ?, ?, ?)
			ON CONFLICT (paste_id) DO UPDATE SET metadata_json = excluded.metadata_json
		`, pasteId, JSON.stringify(metadata), metadata.unlisted ? 0 : 1, now);
		this.ctx.storage.sql.exec(`
			INSERT INTO paste_moderation_state (
				paste_id, decision, visibility, reason, moderated_by, moderated_at_ms,
				reviewed_report_id
			) VALUES (?, ?, 'deleted', ?, ?, ?, ?)
			ON CONFLICT (paste_id) DO UPDATE SET visibility = 'deleted'
		`, pasteId, current.decision, current.reason, current.moderated_by,
			current.moderated_at ? Date.parse(current.moderated_at) : null,
			current.reviewed_through_report_id);
		return { ...current, visibility: "deleted" };
	}

	listReports(limit = 100): AdminPasteReport[] {
		const normalizedLimit = Math.min(Math.max(1, Math.floor(limit)), 1_000);
		type ReportRow = ModerationRow & {
			id: number;
			reported_at_ms: number;
			report_category: string | null;
			email: string | null;
			metadata_json: string;
		};
		const rows = this.ctx.storage.sql.exec<ReportRow>(`
			SELECT r.id, r.paste_id, r.reported_at_ms, r.category AS report_category,
				r.email, s.decision, s.visibility, s.reason, s.moderated_by,
				s.moderated_at_ms, s.reviewed_report_id, p.metadata_json
			FROM paste_reports r
			JOIN paste_records p ON p.paste_id = r.paste_id
			LEFT JOIN paste_moderation_state s ON s.paste_id = r.paste_id
			ORDER BY r.id DESC LIMIT ?
		`, normalizedLimit).toArray();
		return rows.map((row) => ({
			id: row.id,
			paste_id: row.paste_id,
			reported_at: new Date(row.reported_at_ms).toISOString(),
			category: isReportCategory(row.report_category) ? row.report_category : null,
			email: row.email,
			metadata: storedPasteFromJson(row.metadata_json, row.paste_id),
			moderation: moderationFromRow(row),
		}));
	}
}

export function pasteIndexStub(env: Env): DurableObjectStub<PasteIndex> {
	return env.PASTE_INDEX.getByName("paste-index");
}

export async function incrementPasteHitCount(env: Env, id: string): Promise<number> {
	return pasteIndexStub(env).incrementHitCount(id);
}

export async function recordPasteAccess(
	env: Env,
	id: string,
	access: PasteAccess,
	incrementHit = true,
): Promise<number> {
	return pasteIndexStub(env).recordAccess(id, access, incrementHit);
}

export async function listPasteAccessLog(
	env: Env,
	options: { limit?: number; beforeId?: number } = {},
): Promise<PasteAccessLogPage> {
	return pasteIndexStub(env).listAccessLog(options.limit, options.beforeId);
}

export async function getPasteHitCount(env: Env, id: string): Promise<number> {
	return pasteIndexStub(env).getHitCount(id);
}

export async function countPastesCreatedSince(env: Env, sinceMs: number): Promise<number> {
	return pasteIndexStub(env).countCreatedSince(sinceMs);
}

export async function getPasteModeration(env: Env, id: string): Promise<PasteModeration> {
	return pasteIndexStub(env).getModeration(id);
}

export async function getRetainedPaste(env: Env, id: string): Promise<RetainedPaste | null> {
	return pasteIndexStub(env).getRetainedPaste(id);
}

export async function listPastesForReview(
	env: Env,
	options: ReviewPasteListOptions = {},
): Promise<ReviewPastePage> {
	const index = pasteIndexStub(env);
	if (await index.reviewIndexNeedsBackfill()) {
		let cursor: string | undefined;
		do {
			const listed = await env.PASTES.list({
				prefix: PASTE_PREFIX,
				limit: 100,
				cursor,
				include: ["httpMetadata", "customMetadata"],
			});
			const metadata = listed.objects.map((object) =>
				pasteMetadataFromObject(object, object.key.slice(PASTE_PREFIX.length))
			);
			await index.backfillReviewIndex(metadata, !listed.truncated);
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);
	}
	return index.listForReview(options);
}

export async function submitPasteReport(
	env: Env,
	id: string,
	input: { category: ReportCategory | null; email: string | null },
	metadata: StoredPaste,
): Promise<PasteReport> {
	return pasteIndexStub(env).submitReport(id, input.category, input.email, metadata);
}

export async function updatePasteModeration(
	env: Env,
	id: string,
	input: { decision: ModerationDecision; visibility: PasteVisibility; moderatedBy: string; reason: ReportCategory | null },
	metadata?: StoredPaste,
): Promise<PasteModeration> {
	return pasteIndexStub(env).updateModeration(id, input, metadata);
}

export async function listPasteReports(env: Env, limit = 100): Promise<AdminPasteReport[]> {
	return pasteIndexStub(env).listReports(limit);
}
