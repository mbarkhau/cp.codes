import { CONTENT_TYPES, rawContentType } from "./content_type";
import * as paste from "./paste";
import { hexToBytes, sha256Hex } from "./pow";
import { layout, viewPage } from "./ui";

export type StaffRole = "admin" | "mod";
export type StaffUser = { username: string; role: StaffRole };
type StoredStaffUser = StaffUser & { usernameHash: string; passwordHash: string };

// Keep credentials out of every serializable staff response. Production should
// replace this bootstrap account mechanism with a managed identity provider.
const STORED_USERS: readonly StoredStaffUser[] = [
	{
		username: "admin",
		role: "admin",
		usernameHash: "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918",
		passwordHash: "6a4e4054fa6e08046c40df5745530cdde6e4e091de831d04d7d902635b9350ac",
	},
	{
		username: "moderator",
		role: "mod",
		usernameHash: "cfde2ca5188afb7bdd0691c7bef887baba78b709aadde8e8c535329d5751e6fe",
		passwordHash: "f52fbd32b2b3b86ff88ef6c490628285f482af15ddcb29541f94bcf526a3f6c7",
	},
] as const;

export const STAFF_USERS: readonly StaffUser[] = STORED_USERS.map(({ username, role }) => ({ username, role }));

function parseBasicCredentials(request: Request): { username: string; password: string } | null {
	const authorization = request.headers.get("authorization");
	if (!authorization || authorization.length > 512) return null;
	const match = authorization.match(/^Basic ([A-Za-z0-9+/]*={0,2})$/i);
	if (!match) return null;
	try {
		const bytes = Uint8Array.from(atob(match[1]!), (char) => char.charCodeAt(0));
		const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		const separator = decoded.indexOf(":");
		if (separator < 0) return null;
		return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
	} catch {
		return null;
	}
}

function hashesEqual(actual: string, expected: string): boolean {
	return crypto.subtle.timingSafeEqual(hexToBytes(actual), hexToBytes(expected));
}

export async function authenticateStaff(request: Request): Promise<StaffUser | null> {
	const credentials = parseBasicCredentials(request);
	if (!credentials) return null;
	const [usernameHash, passwordHash] = await Promise.all([
		sha256Hex(credentials.username),
		sha256Hex(credentials.password),
	]);
	let authenticated: StaffUser | null = null;
	for (const user of STORED_USERS) {
		const usernameMatches = hashesEqual(usernameHash, user.usernameHash);
		const passwordMatches = hashesEqual(passwordHash, user.passwordHash);
		if (usernameMatches && passwordMatches) authenticated = { username: user.username, role: user.role };
	}
	return authenticated;
}

function staffHeaders(contentType: string): Headers {
	return new Headers({
		"content-type": contentType,
		"cache-control": "no-store, private",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
		vary: "Authorization",
	});
}

function unauthorized(api: boolean): Response {
	const headers = staffHeaders(api ? "application/json; charset=utf-8" : "text/plain; charset=utf-8");
	headers.set("www-authenticate", `Basic realm="cp.codes staff", charset="UTF-8"`);
	return new Response(api ? JSON.stringify({ error: "authentication required" }) : "Authentication required", {
		status: 401,
		headers,
	});
}

function methodNotAllowed(api: boolean): Response {
	return new Response(api ? JSON.stringify({ error: "Method Not Allowed" }) : "Method Not Allowed", {
		status: 405,
		headers: staffHeaders(api ? "application/json; charset=utf-8" : "text/plain; charset=utf-8"),
	});
}

function badRequest(message: string, api = true, status = 400): Response {
	return new Response(api ? JSON.stringify({ error: message }) : message, {
		status,
		headers: staffHeaders(api ? "application/json; charset=utf-8" : "text/plain; charset=utf-8"),
	});
}

/**
 * Validate browser mutation requests without relying solely on request.url.
 * Cloudflare/custom-domain routing can present a different internal URL origin
 * even though the browser correctly identifies the form as same-origin.
 * Sec-Fetch-Site is browser-controlled; Origin remains the fallback for clients
 * which do not send Fetch Metadata headers.
 */
function hasValidMutationOrigin(request: Request): boolean {
	const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
	if (fetchSite === "same-origin") return true;
	if (fetchSite === "same-site" || fetchSite === "cross-site") return false;

	const origin = request.headers.get("origin");
	if (!origin) return true;
	if (origin === "null") return false;
	try {
		const originUrl = new URL(origin);
		if (originUrl.origin === new URL(request.url).origin) return true;
		// Preserve the browser-facing Host across TLS termination or custom-domain
		// routing, where request.url may contain a different internal origin.
		const host = request.headers.get("host")?.toLowerCase();
		return host !== undefined && originUrl.host.toLowerCase() === host;
	} catch {
		return false;
	}
}

function escapeHtml(value: unknown): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function parseListOptions(url: URL): { cursor?: string; limit: number } | Response {
	const cursor = url.searchParams.get("cursor") || undefined;
	if (cursor && cursor.length > 2_048) return badRequest("cursor is too long");
	const rawLimit = url.searchParams.get("limit");
	const limit = rawLimit == null || rawLimit === "" ? 100 : Number(rawLimit);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
		return badRequest("limit must be an integer from 1 to 1000");
	}
	return { cursor, limit };
}

type ReviewListOptions = {
	limit: number;
	offset: number;
	reports: paste.ReviewReportFilter;
	decision?: paste.ModerationDecision;
	visibility?: paste.PasteVisibility;
	reportReason?: paste.ReportCategory;
	contentType?: (typeof CONTENT_TYPES)[number];
	sort: "created" | "hits" | "reported";
	order: "asc" | "desc";
};

function parseReviewListOptions(url: URL): ReviewListOptions | Response {
	const limit = Number(url.searchParams.get("limit") || 100);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
		return badRequest("limit must be an integer from 1 to 1000");
	}
	const offset = Number(url.searchParams.get("offset") || 0);
	if (!Number.isSafeInteger(offset) || offset < 0) return badRequest("offset must be a non-negative integer");
	const reportsValue = url.searchParams.get("reports") || "pending";
	if (!paste.isReviewReportFilter(reportsValue)) return badRequest("invalid reports filter");
	const decisionValue = url.searchParams.get("decision") || undefined;
	if (decisionValue !== undefined && !paste.isModerationDecision(decisionValue)) return badRequest("invalid decision filter");
	const visibilityValue = url.searchParams.get("visibility") || undefined;
	if (visibilityValue !== undefined && !paste.isPasteVisibility(visibilityValue)) return badRequest("invalid visibility filter");
	const reasonValue = url.searchParams.get("reason") || undefined;
	if (reasonValue !== undefined && !paste.isReportCategory(reasonValue)) return badRequest("invalid report reason filter");
	const typeValue = url.searchParams.get("type") || undefined;
	const contentType = typeValue === undefined ? undefined : CONTENT_TYPES.find((type) => type === typeValue);
	if (typeValue !== undefined && contentType === undefined) return badRequest("invalid content type filter");
	const sort = url.searchParams.get("sort") || "reported";
	if (sort !== "created" && sort !== "hits" && sort !== "reported") return badRequest("invalid sort field");
	const order = url.searchParams.get("order") || "desc";
	if (order !== "asc" && order !== "desc") return badRequest("invalid sort order");
	return {
		limit,
		offset,
		reports: reportsValue,
		decision: decisionValue,
		visibility: visibilityValue,
		reportReason: reasonValue,
		contentType,
		sort,
		order,
	};
}

function parseAccessLogOptions(url: URL, dedicatedEndpoint = false): { beforeId?: number; limit: number } | Response {
	const limitName = dedicatedEndpoint ? "limit" : "access_limit";
	const beforeName = dedicatedEndpoint ? "before_id" : "access_before";
	const limit = Number(url.searchParams.get(limitName) || 100);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
		return badRequest(`${limitName} must be an integer from 1 to 1000`);
	}
	const rawBefore = url.searchParams.get(beforeName);
	if (!rawBefore) return { limit };
	const beforeId = Number(rawBefore);
	if (!Number.isSafeInteger(beforeId) || beforeId < 1) return badRequest(`${beforeName} must be a positive integer`);
	return { beforeId, limit };
}

function selected(value: string | undefined, candidate: string): string {
	return value === candidate ? " selected" : "";
}

function moderationFormParts(item: paste.ReviewPaste, returnTo: string): {
	approve: string;
	classification: string;
	visibility: string;
} {
	const id = encodeURIComponent(item.metadata.id);
	const hidden = item.moderation.visibility === "hidden";
	const deleted = item.moderation.visibility === "deleted";
	const common = `<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />`;
	return {
		approve: item.moderation.decision === "approved"
			? ""
			: `<form class="cell-action" method="post" action="/admin/paste/${id}">${common}<input type="hidden" name="action" value="approve" /><button type="submit"${deleted ? " disabled" : ""}>Approve</button></form>`,
		classification: `<form class="classify-form classification-action" method="post" action="/admin/paste/${id}">${common}<input type="hidden" name="action" value="classify" /><label><span class="sr-only">Classify ${escapeHtml(item.metadata.id)}</span><select name="reason"${deleted ? " disabled" : ""}><option value="">Classify…</option>${paste.REPORT_CATEGORIES.map((reason) => `<option value="${escapeHtml(reason)}">${escapeHtml(reason)}</option>`).join("")}</select></label></form>`,
		visibility: `<form class="cell-action" method="post" action="/admin/paste/${id}">${common}<input type="hidden" name="action" value="toggle_visibility" /><button class="secondary" type="submit"${deleted ? " disabled" : ""}>${hidden ? "Show" : "Hide"}</button></form>`,
	};
}

function reportsCell(item: paste.ReviewPaste): string {
	if (item.reports.length === 0) return "";
	const reports = item.reports.map((report) => `<li><strong>${escapeHtml(report.category ?? "reason not supplied")}</strong><br><span class="small">${escapeHtml(report.reported_at)}${report.email ? ` · ${escapeHtml(report.email)}` : ""}</span></li>`).join("");
	const label = `${item.report_count} ${item.report_count === 1 ? "report" : "reports"}`;
	const truncated = item.reports.length < item.report_count
		? `<p class="small">Showing the latest ${item.reports.length.toLocaleString("en-US")} reports.</p>`
		: "";
	return `<span class="flag${item.pending_review ? " pending" : ""}">${item.pending_review ? "pending · " : ""}${label}</span><details><summary>reasons</summary><ul class="report-list">${reports}</ul>${truncated}</details>`;
}

function pasteTable(items: paste.ReviewPaste[], returnTo: string): string {
	if (items.length === 0) return `<p class="empty">No pastes match these filters.</p>`;
	return `<div class="table-wrap"><table class="review-table">
<thead><tr><th>Paste</th><th>User reports</th><th>Visibility</th><th>Decision</th><th>Classification</th><th>Last moderated</th><th>Info</th></tr></thead>
<tbody>${items.map((item) => {
	const metadata = item.metadata;
	const moderation = item.moderation;
	const forms = moderationFormParts(item, returnTo);
	const reviewUrl = `/admin/paste/${encodeURIComponent(metadata.id)}`;
	const decision = moderation.decision === "restricted" && moderation.reason
		? `${moderation.decision}<br><span class="small">${escapeHtml(moderation.reason)}</span>`
		: moderation.decision;
	return `<tr${item.pending_review ? ` class="pending-row"` : ""}>
	<td><a class="mono strong" href="${reviewUrl}/view">${escapeHtml(metadata.id)}</a><br><span class="small">${escapeHtml(metadata.created_at)} · ${metadata.byte_length.toLocaleString("en-US")} B · ${item.hit_count.toLocaleString("en-US")} hits</span></td>
	<td>${reportsCell(item)}</td>
	<td><span class="visibility visibility-${escapeHtml(moderation.visibility)}">${escapeHtml(moderation.visibility)}</span>${metadata.unlisted ? `<br><span class="small">unlisted</span>` : ""}${forms.visibility}</td>
	<td>${decision}${forms.approve}</td>
	<td>${item.automoderation ? `<span class="flag${item.automoderation.requires_review ? " pending" : ""}">Jev: ${escapeHtml(item.automoderation.category ?? item.automoderation.status)}</span>${item.automoderation.probabilities && item.automoderation.category ? `<br><span class="small">${Math.round(item.automoderation.probabilities[item.automoderation.category] * 100)}% model score</span>` : ""}${item.automoderation.detail ? `<br><span class="small">${escapeHtml(item.automoderation.detail)}</span>` : ""}` : ""}${forms.classification}</td>
	<td>${moderation.moderated_by ? `<strong>${escapeHtml(moderation.moderated_by)}</strong><br><span class="small">${escapeHtml(moderation.moderated_at ?? "")}</span>` : `<span class="muted">never</span>`}</td>
	<td><details><summary>details</summary><p><a href="${reviewUrl}/raw">raw content</a> · <a href="${reviewUrl}/content">stored content</a></p><pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre></details></td>
</tr>`;
}).join("\n")}</tbody></table></div>`;
}

function reviewQuery(options: ReviewListOptions, offset: number): string {
	const query = new URLSearchParams({ limit: String(options.limit), reports: options.reports, sort: options.sort, order: options.order });
	if (offset > 0) query.set("offset", String(offset));
	if (options.decision) query.set("decision", options.decision);
	if (options.visibility) query.set("visibility", options.visibility);
	if (options.reportReason) query.set("reason", options.reportReason);
	if (options.contentType) query.set("type", options.contentType);
	return `/admin/pastes?${query.toString()}`;
}

function reviewFilters(options: ReviewListOptions): string {
	return `<form class="review-filters card" id="review-filters" method="get" action="/admin/pastes">
<label>Reports<select name="reports">${paste.REVIEW_REPORT_FILTERS.map((value) => `<option value="${value}"${selected(options.reports, value)}>${value === "pending" ? "Pending review" : value === "reported" ? "All reported" : value === "unreported" ? "Never reported" : "All pastes"}</option>`).join("")}</select></label>
<label>Reporter reason<select name="reason"><option value="">All reasons</option>${paste.REPORT_CATEGORIES.map((reason) => `<option value="${escapeHtml(reason)}"${selected(options.reportReason, reason)}>${escapeHtml(reason)}</option>`).join("")}</select></label>
<label>Decision<select name="decision"><option value="">All decisions</option>${paste.MODERATION_DECISIONS.map((decision) => `<option value="${decision}"${selected(options.decision, decision)}>${decision}</option>`).join("")}</select></label>
<label>Visibility<select name="visibility"><option value="">All visibility</option>${paste.PASTE_VISIBILITIES.map((visibility) => `<option value="${visibility}"${selected(options.visibility, visibility)}>${visibility}</option>`).join("")}</select></label>
<label>Type<select name="type"><option value="">All types</option>${CONTENT_TYPES.map((type) => `<option value="${type}"${selected(options.contentType, type)}>${type}</option>`).join("")}</select></label>
<label>Sort<select name="sort"><option value="reported"${selected(options.sort, "reported")}>Latest report</option><option value="created"${selected(options.sort, "created")}>Created</option><option value="hits"${selected(options.sort, "hits")}>Hits</option></select></label>
<label>Order<select name="order"><option value="desc"${selected(options.order, "desc")}>Descending</option><option value="asc"${selected(options.order, "asc")}>Ascending</option></select></label>
<input type="hidden" name="limit" value="${options.limit}" />
</form>`;
}

function userTable(): string {
	return STAFF_USERS.map((user) => `<tr><td class="mono">${escapeHtml(user.username)}</td><td>${escapeHtml(user.role)}</td></tr>`).join("");
}

function accessLogTable(items: paste.PasteAccessLogEntry[]): string {
	if (items.length === 0) return `<p class="empty">No paste accesses logged yet.</p>`;
	return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Paste</th><th>Access</th><th>IP</th><th>Location</th><th>HTTP Referer</th></tr></thead><tbody>${items.map((entry) => {
		const location = [entry.location.city, entry.location.region_code ?? entry.location.region, entry.location.country].filter(Boolean).join(", ") || "not available";
		return `<tr><td class="mono small">${escapeHtml(entry.accessed_at)}</td><td><a class="mono strong" href="/admin/paste/${encodeURIComponent(entry.paste_id)}/view">${escapeHtml(entry.paste_id)}</a></td><td>${escapeHtml(entry.kind)}</td><td class="mono">${escapeHtml(entry.ip ?? "not available")}</td><td>${escapeHtml(location)}</td><td class="referer">${escapeHtml(entry.referer ?? "direct / not supplied")}</td></tr>`;
	}).join("")}</tbody></table></div>`;
}

const REVIEW_SCRIPT = `<script>
(() => {
  const filters = document.getElementById("review-filters");
  if (filters instanceof HTMLFormElement) filters.addEventListener("change", () => filters.requestSubmit());
  document.querySelectorAll(".classify-form select").forEach((select) => {
    select.addEventListener("change", () => {
      if (select instanceof HTMLSelectElement && select.value && select.form) select.form.requestSubmit();
    });
  });
})();
</script>`;

const ADMIN_STYLE = `
.staff-heading{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.75rem;margin-bottom:1rem}.staff-heading h1{margin:0;font-size:1.35rem}.identity,.muted,.small{color:var(--muted)}.small{font-size:.75rem}.mono,pre{font-family:var(--mono)}.strong{font-weight:700}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:.7rem .65rem;border-top:1px solid var(--border);text-align:left;vertical-align:top}th{color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}.review-table td{min-width:8rem}.review-table th:nth-child(3),.review-table th:nth-child(4),.review-table td:nth-child(3),.review-table td:nth-child(4){text-align:center}.review-table td:nth-child(5){min-width:10rem}.pending-row{background:color-mix(in srgb,var(--danger) 7%,transparent)}.flag{display:inline-block;font-size:.75rem;font-weight:650}.flag.pending{color:var(--danger)}.report-list{max-width:24rem;margin:.4rem 0;padding-left:1.2rem}.report-list li+li{margin-top:.5rem}.cell-action,.classification-action{margin:.45rem 0 0}.cell-action button,.classification-action select{width:100%;min-height:2.25rem;padding:.35rem .55rem;font:inherit}.cell-action .secondary{color:var(--fg);background:var(--surface);border-color:var(--border)}.visibility{font-weight:650}.visibility-hidden,.visibility-deleted{color:var(--danger)}.review-filters{display:grid;grid-template-columns:repeat(7,minmax(8rem,1fr));gap:.7rem;align-items:end}.review-filters label{margin:0}.review-filters select{display:block;width:100%;margin-top:.25rem}.pager{display:flex;justify-content:flex-end;align-items:center;gap:.75rem;margin-top:1rem}.button{padding:.5rem .8rem;border:1px solid var(--border);border-radius:6px;text-decoration:none}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}details summary{cursor:pointer;color:var(--accent)}pre{max-height:28rem;overflow:auto;padding:1rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:.75rem;white-space:pre-wrap;overflow-wrap:anywhere}.referer{max-width:32rem;overflow-wrap:anywhere}@media(max-width:1100px){.review-filters{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:700px){.review-filters{grid-template-columns:1fr 1fr}.card{padding:.8rem}}
`.trim();

function staffPage(user: StaffUser, currentPath: string, title: string, content: string, script?: string): Response {
	const body = `<div class="staff-heading"><h1>${escapeHtml(title)}</h1><div class="identity">signed in as <strong>${escapeHtml(user.username)}</strong> · ${escapeHtml(user.role)}</div></div>${content}`;
	const html = layout(`${title} — cp.codes`, body, script, undefined, {
		currentPath,
		showStaffNavigation: true,
		wide: true,
		extraStyle: ADMIN_STYLE,
	});
	const headers = staffHeaders("text/html; charset=utf-8");
	headers.set("content-security-policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
	return new Response(html, { headers });
}

function reviewPage(user: StaffUser, page: paste.ReviewPastePage, options: ReviewListOptions, returnTo: string): Response {
	const previous = options.offset > 0 ? `<a class="button" href="${escapeHtml(reviewQuery(options, Math.max(0, options.offset - options.limit)))}">← Previous</a>` : "";
	const next = page.next_offset !== null ? `<a class="button" href="${escapeHtml(reviewQuery(options, page.next_offset))}">Next →</a>` : "";
	const start = page.total === 0 ? 0 : page.offset + 1;
	const end = page.offset + page.items.length;
	const pager = `<div class="pager">${previous}<span class="muted">${start.toLocaleString("en-US")}–${end.toLocaleString("en-US")} of ${page.total.toLocaleString("en-US")}</span>${next}</div>`;
	return staffPage(user, "/admin/pastes", "Moderation review", `${reviewFilters(options)}<section class="card">${pasteTable(page.items, returnTo)}${pager}</section>`, REVIEW_SCRIPT);
}

function usersPage(user: StaffUser): Response {
	return staffPage(user, "/admin/users", "Staff users", `<section class="card"><div class="table-wrap"><table><thead><tr><th>Username</th><th>Role</th></tr></thead><tbody>${userTable()}</tbody></table></div></section>`);
}

function accessLogPage(user: StaffUser, accessLog: paste.PasteAccessLogPage, limit: number): Response {
	const older = accessLog.next_before_id ? `<a class="button" href="/admin/access-log?limit=${limit}&amp;before_id=${accessLog.next_before_id}">Older events →</a>` : `<span class="muted">End of access log</span>`;
	return staffPage(user, "/admin/access-log", "Access log", `<section class="card">${accessLogTable(accessLog.items)}<div class="pager">${older}</div></section>`);
}

type ModerationRequest = {
	action?: unknown;
	decision?: unknown;
	visibility?: unknown;
	reason?: unknown;
	return_to?: unknown;
};

async function readModerationRequest(request: Request): Promise<ModerationRequest> {
	if (request.headers.get("content-type")?.includes("application/json")) {
		const value: unknown = await request.json();
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("body must be an object");
		return value as ModerationRequest;
	}
	const form = await request.formData();
	return {
		action: form.get("action"),
		decision: form.get("decision"),
		visibility: form.get("visibility"),
		reason: form.get("reason"),
		return_to: form.get("return_to"),
	};
}

async function handleModerationUpdate(request: Request, env: Env, user: StaffUser, id: string, api: boolean): Promise<Response> {
	if (request.method === "GET" || request.method === "HEAD") {
		const retained = await paste.getRetainedPaste(env, id);
		const metadata = retained?.metadata ?? await paste.getPasteMetadata(env, id);
		if (!metadata) return badRequest("paste not found", true, 404);
		return new Response(JSON.stringify({ metadata, moderation: retained?.moderation ?? paste.defaultModeration(id), automoderation: retained?.automoderation ?? null }), {
			headers: staffHeaders("application/json; charset=utf-8"),
		});
	}
	if (request.method !== "POST" && request.method !== "PATCH") return methodNotAllowed(api);
	if (!hasValidMutationOrigin(request)) return badRequest("invalid request origin", api, 403);

	let input: ModerationRequest;
	try {
		input = await readModerationRequest(request);
	} catch (error) {
		return badRequest(error instanceof Error ? error.message : "invalid request body", api);
	}
	const current = await paste.getPasteModeration(env, id);
	const metadata = await paste.getPasteMetadata(env, id);
	const retained = metadata ? true : await paste.getRetainedPaste(env, id);
	if (!retained) return badRequest("paste not found", true, 404);

	let decision = current.decision;
	let visibility = current.visibility;
	let reason = current.reason;
	const action = typeof input.action === "string" ? input.action : "";
	if (action === "approve") {
		decision = "approved";
		visibility = "visible";
		reason = null;
	} else if (action === "classify") {
		if (!paste.isReportCategory(input.reason)) return badRequest("a valid classification reason is required", api);
		decision = "restricted";
		visibility = "hidden";
		reason = input.reason;
	} else if (action === "toggle_visibility") {
		if (visibility === "deleted") return badRequest("deleted paste content cannot be restored", api, 409);
		visibility = visibility === "hidden" ? "visible" : "hidden";
	} else if (action) {
		return badRequest("invalid moderation action", api);
	} else {
		let changed = false;
		const decisionProvided = input.decision !== undefined && input.decision !== null && input.decision !== "";
		if (decisionProvided) {
			if (!paste.isModerationDecision(input.decision)) return badRequest("invalid decision", api);
			decision = input.decision;
			changed = true;
		}
		if (input.visibility !== undefined && input.visibility !== null && input.visibility !== "") {
			if (!paste.isPasteVisibility(input.visibility)) return badRequest("invalid visibility", api);
			visibility = input.visibility;
			changed = true;
		}
		if (input.reason !== undefined) {
			if (input.reason === null || input.reason === "") reason = null;
			else if (paste.isReportCategory(input.reason)) reason = input.reason;
			else return badRequest("invalid reason", api);
			changed = true;
		}
		if (!changed) return badRequest("a moderation action or state change is required", api);
		if (decision === "restricted" && reason === null) return badRequest("restricted decisions require a reason", api);
		if (decision !== "restricted") {
			if (input.reason !== undefined && input.reason !== null && input.reason !== "") {
				return badRequest("only restricted decisions may have a reason", api);
			}
			if (decisionProvided) reason = null;
		}
	}
	if (current.visibility === "deleted" && visibility !== "deleted") {
		return badRequest("deleted paste content cannot be restored", api, 409);
	}
	const moderation = await paste.updatePasteModeration(env, id, {
		decision,
		visibility,
		moderatedBy: user.username,
		reason,
	}, metadata ?? undefined);
	if (visibility === "deleted" && metadata) await env.PASTES.delete(paste.pasteObjectKey(id));

	if (!api) {
		let location = "/admin/pastes";
		if (typeof input.return_to === "string" && input.return_to.startsWith("/")) {
			const candidate = new URL(input.return_to, request.url);
			if (candidate.origin === new URL(request.url).origin && candidate.pathname === "/admin/pastes") {
				location = `${candidate.pathname}${candidate.search}`;
			}
		}
		return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
	}
	return new Response(JSON.stringify({ moderation }), { headers: staffHeaders("application/json; charset=utf-8") });
}

/** Inspect retained bodies without publishing them or counting staff review as hits. */
async function handleStaffPasteContent(request: Request, env: Env, id: string, mode: string): Promise<Response> {
	const moderation = await paste.getPasteModeration(env, id);
	if (moderation.visibility === "deleted") return badRequest("paste not found", false, 404);
	const object = mode !== "view" && request.method === "GET" ? await paste.getPasteObject(env, id) : null;
	const stored = object?.metadata ?? await paste.getPasteMetadata(env, id);
	if (!stored) return badRequest("paste not found", false, 404);
	const hitCount = await paste.getPasteHitCount(env, id);
	if (mode === "view") {
		// Unlike the canonical URL, review always displays URL pastes, never redirects.
		const response = viewPage(stored, hitCount, true, true);
		response.headers.set("cache-control", "no-store, private");
		response.headers.set("referrer-policy", "no-referrer");
		response.headers.set("x-content-type-options", "nosniff");
		return response;
	}
	const raw = mode === "raw";
	const headers = staffHeaders(raw ? rawContentType(stored.content_type)
		: stored.content_encoding === "gzip" ? "application/gzip" : "text/plain; charset=utf-8");
	headers.set("content-length", String(raw ? stored.byte_length : stored.compressed_byte_length));
	headers.set("content-security-policy", "sandbox; default-src 'none'");
	headers.set("x-cp-code", id);
	headers.set("x-content-type", stored.content_type);
	headers.set("x-content-encoding", stored.content_encoding);
	headers.set("x-uncompressed-content-length", String(stored.byte_length));
	headers.set("x-content-sha256", stored.sha256);
	headers.set("x-hit-count", String(hitCount));
	const body = raw && stored.content_encoding === "gzip"
		? object?.body.pipeThrough(new DecompressionStream("gzip")) ?? null
		: object?.body ?? null;
	return new Response(body, { headers });
}

/** Handle authenticated staff HTML and JSON endpoints. */
export async function handleAdminRequest(request: Request, env: Env, url: URL, path: string): Promise<Response> {
	const api = path.startsWith("/api/admin") || path === "/admin/api";
	const user = await authenticateStaff(request);
	if (!user) return unauthorized(api);

	const contentMatch = path.match(/^\/admin\/paste\/(CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10}))\/(view|raw|content)$/);
	if (contentMatch) {
		if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(false);
		return handleStaffPasteContent(request, env, contentMatch[1]!.toUpperCase(), contentMatch[2]!);
	}
	const moderationMatch = path.match(/^\/(api\/)?admin\/paste\/(CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10}))$/);
	if (moderationMatch) return handleModerationUpdate(request, env, user, moderationMatch[2]!.toUpperCase(), Boolean(moderationMatch[1]));
	if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(api);

	if (path === "/admin/reports") return Response.redirect(new URL("/admin/pastes?reports=reported", request.url).toString(), 302);
	if (path === "/admin/users") return usersPage(user);
	if (path === "/admin/access-log") {
		const options = parseAccessLogOptions(url, true);
		if (options instanceof Response) return options;
		return accessLogPage(user, await paste.listPasteAccessLog(env, options), options.limit);
	}
	if (path === "/admin/pastes") {
		const options = parseReviewListOptions(url);
		if (options instanceof Response) return options;
		const page = await paste.listPastesForReview(env, options);
		return reviewPage(user, page, options, `${url.pathname}${url.search}`);
	}
	if (path === "/api/admin/users") {
		return new Response(JSON.stringify({ authenticated_user: user, users: STAFF_USERS }), { headers: staffHeaders("application/json; charset=utf-8") });
	}
	if (path === "/api/admin/reports") {
		const options = parseListOptions(url);
		if (options instanceof Response) return options;
		return new Response(JSON.stringify({ authenticated_user: user, reports: await paste.listPasteReports(env, options.limit) }), { headers: staffHeaders("application/json; charset=utf-8") });
	}
	if (path === "/api/admin/access-log") {
		const options = parseAccessLogOptions(url, true);
		if (options instanceof Response) return options;
		const result = await paste.listPasteAccessLog(env, options);
		return new Response(JSON.stringify({ authenticated_user: user, access_log: result.items, pagination: { limit: options.limit, next_before_id: result.next_before_id } }), { headers: staffHeaders("application/json; charset=utf-8") });
	}

	const options = parseListOptions(url);
	if (options instanceof Response) return options;
	const accessOptions = parseAccessLogOptions(url);
	if (accessOptions instanceof Response) return accessOptions;
	const [page, accessLog, reports] = await Promise.all([
		paste.listPastesForAdmin(env, options),
		paste.listPasteAccessLog(env, accessOptions),
		paste.listPasteReports(env, 100),
	]);
	return new Response(JSON.stringify({
		authenticated_user: user,
		users: STAFF_USERS,
		pastes: page.items,
		access_log: accessLog.items,
		reports,
		pagination: {
			limit: options.limit,
			truncated: page.truncated,
			next_cursor: page.cursor,
			access_log: { limit: accessOptions.limit, next_before_id: accessLog.next_before_id },
		},
	}), { headers: staffHeaders("application/json; charset=utf-8") });
}
