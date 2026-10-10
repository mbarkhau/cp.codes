import { CONTENT_TYPES, rawContentType } from "./content_type";
import { bundleFileResponse } from './bundle';
import * as paste from "./paste";
import { isDifficultyBits, MAX_POW_DIFFICULTY_BITS, powKeyStub } from "./pow";
import { staffUsers, verifyStaffCredentials, developmentStaffEnabled } from './staff';
import { getPowDifficultyState, type PowDifficultyState } from "./pow_settings";
import { layout, viewPage } from "./ui";
import { assetUrl } from './assets';
import {
	allowLoginAttempt, createSession, revokeSession, sessionCookie,
	sessionToken, sessionTransportAllowed, sessionUsername,
} from "./session";

export type StaffRole = "admin" | "mod";
export type StaffUser = { username: string; role: StaffRole };

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

export async function authenticateStaff(request: Request, env: Env): Promise<StaffUser | null> {
	const username = await sessionUsername(request, env);
	const user = staffUsers(env).find((candidate) => candidate.username === username);
	if (user) return { ...user };
	// Explicit Basic Auth remains supported for CLI/API clients; browsers use cookies.
	const credentials = parseBasicCredentials(request);
	if (!credentials) return null;
	if (!developmentStaffEnabled(env) && !await allowLoginAttempt(request, env)) return null;
	return verifyStaffCredentials(credentials.username, credentials.password, env);
}

function staffHeaders(contentType: string): Headers {
	return new Headers({
		"content-type": contentType,
		"cache-control": "no-store, private",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
		vary: "Cookie, Authorization",
	});
}

function unauthorized(api: boolean, request: Request): Response {
	const headers = staffHeaders(api ? "application/json; charset=utf-8" : "text/plain; charset=utf-8");
	// Do not prompt browser fetches for a password when their session expires.
	if (api && !sessionToken(request) && !request.headers.has("sec-fetch-site")) {
		headers.set("www-authenticate", `Basic realm="cp.codes staff", charset="UTF-8"`);
	}
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
export function hasValidMutationOrigin(request: Request, allowMissingOrigin = sessionToken(request) === null): boolean {
	const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
	if (fetchSite === "same-origin") return true;
	if (fetchSite === "same-site" || fetchSite === "cross-site") return false;

	const origin = request.headers.get("origin");
	if (!origin) return allowMissingOrigin;
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

function safeReturnTo(value: unknown, request: Request): string {
	if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\\\u0000-\u0020\u007f]/.test(value)) return "/admin/pastes";
	const target = new URL(value, request.url);
	if (target.origin !== new URL(request.url).origin || ["/login", "/logout"].includes(target.pathname.replace(/\/+$/, ""))) return "/admin/pastes";
	return target.pathname + target.search;
}

function authRedirect(location: string, cookie?: string): Response {
	const headers = staffHeaders("text/plain; charset=utf-8");
	headers.set("location", location);
	if (cookie !== undefined) headers.set("set-cookie", cookie);
	return new Response(null, { status: 303, headers });
}

function loginPage(returnTo: string, message = "", status = 200): Response {
	const html = layout("Staff login — cp.codes", `<section class="card">
<h1>Staff login</h1>
${message ? `<p class="status err" role="alert">${escapeHtml(message)}</p>` : ""}
<form method="post" action="/login">
<input type="hidden" name="next" value="${escapeHtml(returnTo)}" />
<label for="username">Username</label><input id="username" name="username" type="text" autocomplete="username" maxlength="100" required autofocus />
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required />
<p><button type="submit">Log in</button></p>
</form><p>Staff sessions expire after eight hours. No login is needed to publish a paste.</p>
</section>`, undefined, undefined, { currentPath: "/login" });
	const headers = staffHeaders("text/html; charset=utf-8");
	headers.set("content-security-policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
	return new Response(html, { status, headers });
}

async function readLoginForm(request: Request): Promise<URLSearchParams> {
	if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") || !request.body) {
		throw new Error("expected a login form");
	}
	const reader = request.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > 4096) {
				await reader.cancel("login form is too large");
				throw new Error("login form is too large");
			}
			text += decoder.decode(value, { stream: true });
		}
		return new URLSearchParams(text + decoder.decode());
	} finally {
		reader.releaseLock();
	}
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
	if (!sessionTransportAllowed(request)) return badRequest("staff login requires HTTPS (except loopback development)", false, 400);
	const url = new URL(request.url);
	if (request.method === "GET" || request.method === "HEAD") {
		const next = safeReturnTo(url.searchParams.get("next"), request);
		return await authenticateStaff(request, env) ? authRedirect(next) : loginPage(next);
	}
	if (request.method !== "POST") return methodNotAllowed(false);
	if (!hasValidMutationOrigin(request, false)) return badRequest("invalid request origin", false, 403);
	let form: URLSearchParams;
	try {
		form = await readLoginForm(request);
	} catch {
		return badRequest("invalid login form", false);
	}
	const next = safeReturnTo(form.get("next"), request);
	if (!await allowLoginAttempt(request, env)) {
		const response = loginPage(next, "Too many login attempts. Try again in ten minutes.", 429);
		response.headers.set("retry-after", "600");
		return response;
	}
	const username = form.get("username");
	const password = form.get("password");
	const user = typeof username === "string" && typeof password === "string"
		? await verifyStaffCredentials(username, password, env) : null;
	if (!user) return loginPage(next, "Invalid username or password.", 401);
	const token = await createSession(env, user.username);
	await revokeSession(request, env); // Rotate any previous session after successful authentication.
	return authRedirect(next, sessionCookie(request, token));
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") return methodNotAllowed(false);
	if (!sessionTransportAllowed(request) || !hasValidMutationOrigin(request, false)) return badRequest("invalid request origin", false, 403);
	await revokeSession(request, env);
	return authRedirect("/login", sessionCookie(request, "", 0));
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
			: `<form class="cell-action" method="post" action="/admin/paste/${id}">${common}<input type="hidden" name="action" value="approve" /><button type="submit"${deleted ? " disabled" : ""}>Approve public access</button></form>`,
		classification: `<form class="classify-form classification-action" method="post" action="/admin/paste/${id}">${common}<input type="hidden" name="action" value="classify" /><label><span class="sr-only">Classify ${escapeHtml(item.metadata.id)}</span><select name="reason"${deleted ? " disabled" : ""}><option value="">Classify…</option>${paste.REPORT_CATEGORIES.map((reason) => `<option value="${escapeHtml(reason)}">${escapeHtml(reason)}</option>`).join("")}</select></label><button type="submit">Restrict &amp; hide</button></form>`,
		visibility: `<form class="cell-action" method="post" action="/admin/paste/${id}">${common}<input type="hidden" name="action" value="toggle_visibility" /><button class="secondary" type="submit"${deleted ? " disabled" : ""}>${hidden ? "Restore visibility (still gated)" : "Hide"}</button></form>`,
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
<thead><tr><th>Paste</th><th>Why review?</th><th>Visibility</th><th>Decision</th><th>Classification</th><th>Last moderated</th><th>Info</th></tr></thead>
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
	<td>${item.sharing.escalated ? `<strong class="flag pending">Traffic review</strong><p class="small">${escapeHtml(item.sharing.escalated)}</p>` : ''}${item.automoderation?.requires_review ? `<strong class="flag pending">AI / media review</strong>` : ''}${reportsCell(item)}<p class="small">${item.sharing.recipients}/3 recipients · ${item.sharing.requests} body requests</p></td>
	<td><span class="visibility visibility-${escapeHtml(moderation.visibility)}">${moderation.visibility === 'visible' ? moderation.decision === 'approved' ? 'Public access' : item.sharing.escalated ? 'Uploader only' : 'Limited sharing' : escapeHtml(moderation.visibility)}</span>${metadata.unlisted ? `<br><span class="small">unlisted</span>` : ""}${forms.visibility}</td>
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
<label>Queue<select name="reports">${paste.REVIEW_REPORT_FILTERS.map((value) => `<option value="${value}"${selected(options.reports, value)}>${value === "pending" ? "Pending review" : value === "reported" ? "All reported" : value === "unreported" ? "Never reported" : "All pastes"}</option>`).join("")}</select></label>
<label>Reporter reason<select name="reason"><option value="">All reasons</option>${paste.REPORT_CATEGORIES.map((reason) => `<option value="${escapeHtml(reason)}"${selected(options.reportReason, reason)}>${escapeHtml(reason)}</option>`).join("")}</select></label>
<label>Decision<select name="decision"><option value="">All decisions</option>${paste.MODERATION_DECISIONS.map((decision) => `<option value="${decision}"${selected(options.decision, decision)}>${decision}</option>`).join("")}</select></label>
<label>Visibility<select name="visibility"><option value="">All visibility</option>${paste.PASTE_VISIBILITIES.map((visibility) => `<option value="${visibility}"${selected(options.visibility, visibility)}>${visibility}</option>`).join("")}</select></label>
<label>Type<select name="type"><option value="">All types</option>${CONTENT_TYPES.map((type) => `<option value="${type}"${selected(options.contentType, type)}>${type}</option>`).join("")}</select></label>
<label>Sort<select name="sort"><option value="reported"${selected(options.sort, "reported")}>Latest report</option><option value="created"${selected(options.sort, "created")}>Created</option><option value="hits"${selected(options.sort, "hits")}>Hits</option></select></label>
<label>Order<select name="order"><option value="desc"${selected(options.order, "desc")}>Descending</option><option value="asc"${selected(options.order, "asc")}>Ascending</option></select></label>
<input type="hidden" name="limit" value="${options.limit}" />
</form>`;
}

function userTable(env: Env): string {
	return staffUsers(env).map((user) => `<tr><td class="mono">${escapeHtml(user.username)}</td><td>${escapeHtml(user.role)}</td></tr>`).join("");
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
  document.querySelectorAll('.classify-form').forEach((form) => form.addEventListener('submit', (event) => {
    if (!form.querySelector('select').value) { event.preventDefault(); alert('Choose a restriction reason first.'); }
  }));
})();
</script>`;

function staffPage(user: StaffUser, currentPath: string, title: string, content: string, script?: string): Response {
	const body = `<div class="staff-heading"><h1>${escapeHtml(title)}</h1><div class="identity">signed in as <strong>${escapeHtml(user.username)}</strong> · ${escapeHtml(user.role)}</div></div>${content}`;
	const html = layout(`${title} — cp.codes`, body, script, undefined, {
		currentPath,
		showStaffNavigation: true,
		wide: true,
		extraStylesheet: assetUrl('/admin.css'),
	});
	const headers = staffHeaders("text/html; charset=utf-8");
	headers.set("content-security-policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
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

function powSettingsPage(user: StaffUser, state: PowDifficultyState): Response {
	const disabled = user.role !== "admin" ? " disabled" : "";
	return staffPage(user, "/admin/pow", "Proof of work", `<section class="card">
<h2>Current difficulty</h2>
<dl class="pow-fields">
<dt>Minimum difficulty</dt><dd>${state.minimum_difficulty_bits} leading zero bits</dd>
<dt>Current difficulty for a base-size paste</dt><dd>${state.current_difficulty_bits} leading zero bits</dd>
<dt>Traffic adjustment</dt><dd>+${state.rate_extra_bits} bits · ${state.recent_paste_count} pastes in the last ${state.rate_window_seconds / 60} minutes</dd>
<dt>Short ID increment</dt><dd>${state.short_id_increment} bits per version-0 ID consumed in the requester's current regional five-minute tick</dd>
<dt>Deployment default</dt><dd>${state.configured_default_bits} bits · ${state.override_difficulty_bits === null ? "using deployment default" : "admin override active"}</dd>
${state.updated_at ? `<dt>Last changed</dt><dd>${escapeHtml(state.updated_at)} by ${escapeHtml(state.updated_by)}</dd>` : ""}
</dl>
<p>The current difficulty applies to pastes up to ${paste.DEFAULT_PASTE_BYTES.toLocaleString("en-US")} bytes. Expected work scales with the estimated cost of each upload, rounded up to a power of two. The uncompressed container is limited to 8 MiB. Per-IP and global cost budgets apply even with a zero-bit minimum.</p>
<p><a href="/admin/pow">Refresh current difficulty</a></p>
</section>
<section class="card"><h2>Set minimum difficulty</h2>
${disabled ? `<p>Only admins can change this setting.</p>` : ""}
<form method="post" action="/admin/pow">
<label for="minimum-difficulty">Minimum leading zero bits (0–${MAX_POW_DIFFICULTY_BITS})</label>
<input id="minimum-difficulty" name="minimum_difficulty_bits" type="number" min="0" max="${MAX_POW_DIFFICULTY_BITS}" step="1" value="${state.minimum_difficulty_bits}" required${disabled} />
<label for="short-id-increment">Version-0 regional ID increment</label>
<input id="short-id-increment" name="short_id_increment" type="number" min="0" max="64" step="0.1" value="${state.short_id_increment}" required${disabled} />
<p><button type="submit"${disabled}>Save difficulty settings</button></p>
</form>
<form method="post" action="/admin/pow"><input type="hidden" name="action" value="reset" /><button type="submit"${disabled}>Use deployment default (${state.configured_default_bits} bits)</button></form>
<p>Each extra bit doubles expected work. Zero bits disables the minimum work requirement; very high values effectively prevent uploads.</p>
<p>Changes persist across restarts and apply to newly issued challenges. Existing challenges are authenticated until they expire, but a higher current price requires a fresh proof at redemption. Traffic and size adjustments still apply.</p>
</section>`);
}

async function handlePowSettings(request: Request, env: Env, user: StaffUser, api: boolean): Promise<Response> {
	const reading = request.method === "GET" || request.method === "HEAD";
	if (!reading) {
		if (request.method !== "POST" && !(api && request.method === "PATCH")) return methodNotAllowed(api);
		if (user.role !== "admin") return badRequest("admin role required", api, 403);
		if (!hasValidMutationOrigin(request)) return badRequest("invalid request origin", api, 403);
		let value: unknown;
		let increment: unknown = 1;
		try {
			if (api) {
				const body: unknown = await request.json();
				if (typeof body !== "object" || body === null || Array.isArray(body)) return badRequest("body must be an object");
				value = (body as Record<string, unknown>).minimum_difficulty_bits;
				increment = (body as Record<string, unknown>).short_id_increment ?? 1;
			} else {
				const form = await request.formData();
				const raw = form.get("minimum_difficulty_bits");
				const rawIncrement = form.get('short_id_increment');
				value = form.get("action") === "reset" ? null
					: typeof raw === "string" && /^[0-9]+$/.test(raw) ? Number(raw) : undefined;
				increment = form.get('action') === 'reset' || rawIncrement == null ? 1 : Number(rawIncrement);
			}
		} catch {
			return badRequest("invalid request body", api);
		}
		if (value !== null && !isDifficultyBits(value)) {
			return badRequest(`minimum_difficulty_bits must be an integer from 0 to ${MAX_POW_DIFFICULTY_BITS}, or null to use the deployment default`, api);
		}
		if (typeof increment !== 'number' || !Number.isFinite(increment) || increment < 0 || increment > 64) {
			return badRequest('short_id_increment must be a number from 0 to 64', api);
		}
		await powKeyStub(env).setDifficultySettings(value, user.username, increment);
		if (!api) return new Response(null, { status: 303, headers: { location: "/admin/pow", "cache-control": "no-store" } });
	}
	const state = await getPowDifficultyState(env);
	return api ? new Response(JSON.stringify(state), { headers: staffHeaders("application/json; charset=utf-8") })
		: powSettingsPage(user, state);
}

function usersPage(user: StaffUser, env: Env): Response {
	return staffPage(user, "/admin/users", "Staff users", `<section class="card"><div class="table-wrap"><table><thead><tr><th>Username</th><th>Role</th></tr></thead><tbody>${userTable(env)}</tbody></table></div></section>`);
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
	if (raw && stored.format === 'bundle-v1') return bundleFileResponse(request, object, stored, stored.primary ?? '', hitCount);
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
	const user = await authenticateStaff(request, env);
	if (!user) {
		const dataRoute = /\/(raw|content)$/.test(path) || /^\/admin\/paste\/CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10})$/.test(path);
		if (!api && !dataRoute && (request.method === "GET" || request.method === "HEAD")) {
			return authRedirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
		}
		return unauthorized(api, request);
	}
	if (path === "/admin/pow" || path === "/api/admin/pow") return handlePowSettings(request, env, user, api);

	const contentMatch = path.match(/^\/admin\/paste\/(CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10}))\/(view|raw|content)$/);
	if (contentMatch) {
		if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(false);
		return handleStaffPasteContent(request, env, contentMatch[1]!.toUpperCase(), contentMatch[2]!);
	}
	const moderationMatch = path.match(/^\/(api\/)?admin\/paste\/(CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10}))$/);
	if (moderationMatch) return handleModerationUpdate(request, env, user, moderationMatch[2]!.toUpperCase(), Boolean(moderationMatch[1]));
	if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(api);

	if (path === "/admin/reports") return Response.redirect(new URL("/admin/pastes?reports=reported", request.url).toString(), 302);
	if (path === "/admin/users") return usersPage(user, env);
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
		return new Response(JSON.stringify({ authenticated_user: user, users: staffUsers(env) }), { headers: staffHeaders("application/json; charset=utf-8") });
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
		users: staffUsers(env),
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
