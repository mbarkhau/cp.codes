/**
 * Minimal HTML shells for the pastebin UX (no build step).
 * Client PoW logic lives in /app.js (static asset).
 */

import type { PasteUploadMetadata, PublicPastePage, RecentPaste, StoredPaste } from "./paste";
import {
	DEFAULT_PASTE_BYTES,
	MAX_REPORT_EMAIL_CHARS,
	REPORT_CATEGORIES,
} from "./paste";
import { CONTENT_TYPE_LABELS, fileExtension } from "./content_type";
import { POW_DEFAULTS } from "./pow";
import { assetUrl } from './assets';
import editorManifest from '../public/lib/codemirror/manifest.json';

const EDITOR_IMPORT_MAP = JSON.stringify({ imports: editorManifest.imports });

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export type LayoutOptions = {
	wide?: boolean;
	extraStylesheet?: string;
	showFooter?: boolean;
	resourceHints?: string;
};

export function layout(
	title: string,
	body: string,
	script?: string,
	options: LayoutOptions = {},
): string {
	const footer = options.showFooter === false ? "" : '<ul class="footer"></ul>';
	return `<!doctype html>
<html lang="en" data-theme="light">
<head>
	<meta charset="utf-8" />
	<title>${escapeHtml(title)}</title>
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	${options.resourceHints ?? ""}
	<link rel="stylesheet" href="${assetUrl('/style.css')}" />
	<script type="text/javascript">
		try {
			const theme = localStorage.getItem('cp.codes.theme') || 'light';
			document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
		} catch {}
	</script>
	${options.extraStylesheet ? `<link rel="stylesheet" href="${escapeHtml(options.extraStylesheet)}" />` : ""}
	<link rel="icon" type="image/png" sizes="32x32" href="${assetUrl('/favicon-32.png')}" />
	<link rel="icon" type="image/svg+xml" sizes="any" href="${assetUrl('/favicon.svg')}" />
</head>
<body>
	<div class="wrap${options.wide ? " wide" : ""}">
	<header></header>
	${body}
	${footer}
  </div>
  <script src="${assetUrl('/site.js')}"></script>
  ${script ?? ""}
</body>
</html>`;
}

function formatWhen(iso: string): string {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return escapeHtml(iso);
	return escapeHtml(new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z"));
}

function formatHitCount(hitCount: number): string {
	const count = Number.isSafeInteger(hitCount) && hitCount >= 0 ? hitCount : 0;
	return `${count.toLocaleString("en-US")} ${count === 1 ? "hit" : "hits"}`;
}

function recentSection(recent: RecentPaste[], standalone = false, listing?: PublicPastePage): string {
	const items =
		recent.length === 0
			? `<p class="recent-empty">No public pastes yet.</p>`
			: `<div class="recent-table-scroll"><table class="recent-list">
  <thead><tr><th scope="col">id</th><th scope="col">filename</th><th scope="col" class="recent-hits">hits</th><th scope="col" class="recent-bytes">bytes</th><th scope="col">timestamp</th></tr></thead>
  <tbody>
${recent
	.map(
		(p) => `  <tr>
	<td><a class="recent-id" href="/${escapeHtml(p.id)}">${escapeHtml(p.id)}</a></td>
	<td class="recent-filename" title="${escapeHtml(p.primary ?? p.filename ?? '')}">${escapeHtml(p.primary ?? p.filename ?? '—')}</td>
	<td class="recent-hits">${Number.isSafeInteger(p.hit_count) && p.hit_count >= 0 ? p.hit_count.toLocaleString("en-US") : '0'}</td>
	<td class="recent-bytes">${p.byte_length.toLocaleString("en-US")}</td>
	<td class="recent-meta">${formatWhen(p.created_at)}</td>
  </tr>`,
	)
	.join("\n")}
  </tbody>
</table></div>`;

	return `
<section class="recent card${standalone ? " recent-page" : ""}" id="pastes">
  <h2>${standalone ? 'Public pastes' : 'Recent uploads'}</h2>
  ${listing ? publicPasteNavigation(listing) : ''}
  ${items}
  ${listing ? publicPasteNavigation(listing) : ''}
</section>`;
}

type SitePage = "about" | "pastes" | "new";

function publicPasteNavigation(listing: PublicPastePage): string {
	if (!listing.total) return '';
	const previous = listing.page > 1
		? `<a href="/pastes?page=${listing.page - 1}" rel="prev">← Previous</a>`
		: '<span aria-disabled="true">← Previous</span>';
	const next = listing.page < listing.total_pages
		? `<a href="/pastes?page=${listing.page + 1}" rel="next">Next →</a>`
		: '<span aria-disabled="true">Next →</span>';
	const first = (listing.page - 1) * listing.page_size + 1;
	const last = first + listing.items.length - 1;
	return `<nav class="paste-pagination" aria-label="Paste pages">${previous}<span class="meta">Page ${listing.page} of ${listing.total_pages} · ${first}–${last} of ${listing.total} pastes</span>${next}</nav>`;
}

function sitePage(page: SitePage, recent: RecentPaste[] = [], listing?: PublicPastePage): Response {
	const d = POW_DEFAULTS.difficultyBits;
	const p50 = Math.ceil(Math.LN2 * 2 ** d);
	const average = 2 ** d;
	const newSection = `
<section class="card" id="new">
  <div id="file-editors" aria-label="Paste files">
    <article class="editor-card editor-placeholder" aria-hidden="true">
      <div class="editor-toolbar"></div>
      <div class="editor-mount"></div>
    </article>
  </div>
  <div class="composer-actions">
    <div>
      <button class="file-button" type="button" id="add-text">Add file</button>
      <input class="file-input" type="file" id="file-input" multiple />
      <button class="file-button" type="button" id="file-button" aria-controls="file-input">Upload</button>
    </div>
  </div>
  <div class="consent-publish">
    <label class="check-control"><input type="checkbox" id="listed" checked /><span>List publicly on <a href="/pastes">cp.codes/pastes</a>. All pastes are public and can be accessed to anyone who has (or can guess) its link.</span></label>
    <label class="check-control consent-control"><input type="checkbox" id="consent" /><span>I consent to the collection and storage of <a href="/client-info">my IP and location data</a>.</span></label>
    <label class="check-control consent-control"><input type="checkbox" id="consent-moderation" /><span>I consent to sending paste data to <a href="/about#service-providers">service providers</a> for automated moderation. Uncertain content and media need human review before access.</span></label>
    <div class="row"><button type="button" id="publish" disabled>Publish</button></div>
    <p class="meta"><span id="bytes">0 bytes</span> (max. 8 MiB) · <span id="proof-estimate">estimating…</span></p>
  </div>
  <div class="progress" id="progress" aria-hidden="true"><i></i></div>
  <div class="status" id="status" role="status" aria-live="polite"></div>
</section>`;
	const aboutSection = `
<section class="notes${page === "about" ? " about-page" : ""}" id="about">
  <h1>About cp.codes</h1>
  <p>cp.codes is a public pastebin and document store with no accounts or registration.</p>
  <ul>
    <li>No login. Uploads need a <strong>SHA-256</strong> search PoW: base difficulty ${d} (~${p50.toLocaleString()} attempts for a 50% chance; ${average.toLocaleString()} average). Expected work scales with estimated storage, operations, and moderation costs. Per-IP and global rolling budgets limit abuse; upload prices are rechecked atomically at redemption.</li>
    <li>Listed pastes get short version 0 ids; unlisted pastes stay out of recent uploads and use longer version 2 ids.</li>
    <li>Up to 16 files per paste and 8 MiB of uncompressed container data. UTF-8 text plus PNG/JPEG/WebP/GIF images and MP3/MP4 media; browsers gzip content before upload. Markdown can reference named sibling files.</li>
    <li>AI-cleared text is available to the uploader and three other IPs, subject to request and byte budgets. Wider distribution requires human approval. Only human-approved listed pastes appear in the public feed.</li>
    <li>Every upload is assessed for spam, phishing, CSAM, and other unsafe content before access. Limited sharing requires an aggregate harmful model score of at most 0.01, not a certification of legality. Paste text and public descriptive metadata are sent to the moderation service providers listed below. Images, audio, video, over-context pastes, uncertain results, and assessment failures are held for staff review. Automated classification is not a verification of legality.</li>
    <li>Press <strong>Ctrl/⌘+P</strong> to detect and publish.</li>
  </ul>
  <h2 id="service-providers">Service providers</h2>
  <ul>
    <li><strong>Cloudflare</strong> hosts cp.codes and stores pastes and upload metadata, including IP and location data.</li>
    <li><strong>DefAPI</strong> provides the API used for automated moderation. Paste text, filename, and content type are sent to this service.</li>
    <li><strong>TypeSafe</strong> supplies the Jev model used for automated moderation through DefAPI.</li>
    <li><strong>jsDelivr</strong> serves browser libraries for the paste editor, Markdown rendering, and fallback proof-of-work hashing. When loading these libraries, your browser sends IP and request metadata to the CDN, not paste contents.</li>
  </ul>
  <p>Private IP/location metadata and proof-of-work details are not sent to the automated moderation service.</p>
</section>`;
	const body = page === "new"
		? newSection
		: page === "about"
			? aboutSection
			: recentSection(recent, true, listing);
	const titles: Record<SitePage, string> = {
		about: "About — cp.codes",
		pastes: "Pastes — cp.codes",
		new: "New paste — cp.codes",
	};
	const script = page === "new"
		? `<script type="importmap">${EDITOR_IMPORT_MAP}</script>
<script type="module" src="${assetUrl('/app.js')}"></script>`
		: undefined;
	const resourceHints = page === "new"
		? (['/content_type.js', '/files.js', '/policy.js'] as const)
			.map(path => `<link rel="modulepreload" href="${assetUrl(path)}" />`).join("\n  ")
		: undefined;
	const html = layout(titles[page], body, script, { resourceHints });
	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store, private",
			vary: "Cookie, Authorization",
		},
	});
}

export function aboutPage(): Response {
	return sitePage("about");
}

export function pastesPage(listing: PublicPastePage): Response {
	return sitePage("pastes", listing.items, listing);
}

export function newPage(): Response {
	return sitePage("new");
}

export function clientInfoPage(metadata: PasteUploadMetadata): Response {
	const rows = Object.entries(metadata).map(([name, value]) => {
		const displayed = value == null
			? `<span class="client-info-null">not available</span>`
			: escapeHtml(String(value));
		return `    <dt>${escapeHtml(name)}</dt><dd>${displayed}</dd>`;
	}).join("\n");
	const body = `<section class="card">
  <h1>Client info stored with a paste</h1>
  <p>These are your IP, network, and location values that are stored with your uploads. Values can differ on a later upload request.</p>
  <dl class="client-info-fields">
${rows}
  </dl>
</section>`;
	return new Response(layout("Client info — cp.codes", body), {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store, private",
			vary: "Cookie, Authorization",
		},
	});
}


const VIEW_MODULE_URL = assetUrl('/view.js');

export function viewPage(paste: StoredPaste, hitCount: number, staffReview = false): Response {
	const id = escapeHtml(paste.id);
	const typeLabel = CONTENT_TYPE_LABELS[paste.content_type];
	const rawUrl = staffReview ? `/admin/paste/${id}/raw` : `/${id}.${fileExtension(paste.content_type)}`;
	const contentUrl = staffReview ? `/admin/paste/${id}/content` : `/api/paste/${id}/content`;
	const dialogMetadata = escapeHtml(JSON.stringify({
		created_at: paste.created_at,
		compressed_byte_length: paste.compressed_byte_length,
		content_encoding: paste.content_encoding,
		filename: paste.filename,
		unlisted: paste.unlisted,
		files: paste.files,
		proof_of_work: paste.proof_of_work,
		report_categories: REPORT_CATEGORIES,
		max_report_email_chars: MAX_REPORT_EMAIL_CHARS,
	}));
	// Discover content early, but let the site module and CSS win bandwidth for the shell's first paint.
	// Keep these after the site module and CSS, within the first KiB.
	// Anonymous CORS matches fetch()'s default mode and same-origin credentials.
	const resourceHints = `<link rel="preload" href="${contentUrl}" as="fetch" crossorigin="anonymous" />`;
	const filename = paste.filename ? ` · <strong>${escapeHtml(paste.filename)}</strong>` : "";
	const visibility = paste.unlisted ? " · unlisted" : "";
	const body = `
<div class="paste-main">
  <section class="paste-head">
    ${staffReview ? `<p class="status">Staff review — content remains subject to its current visibility. <a href="/admin/pastes">← moderation</a></p><div class="row"><form method="post" action="/admin/paste/${id}"><input type="hidden" name="action" value="approve"/><button type="submit">Approve public access</button></form><form method="post" action="/admin/paste/${id}"><input type="hidden" name="action" value="classify"/><select name="reason" aria-label="Restriction reason" required><option value="">Restriction reason…</option>${REPORT_CATEGORIES.map(reason => `<option>${escapeHtml(reason)}</option>`).join('')}</select> <button class="danger" type="submit">Restrict &amp; hide</button></form></div>` : ""}
    <div class="meta">${formatWhen(paste.created_at)} · ${paste.byte_length} bytes · <span id="paste-hit-count">${formatHitCount(hitCount)}</span> · <span class="type-badge">${escapeHtml(typeLabel)}</span>${filename}${visibility}</div>
    <div class="paste-toolbar"></div>
  </section>
  <section class="card paste-card" style="padding:0; overflow:hidden;">
    ${paste.format && (paste.files?.length ?? 0) > 1 ? `<nav class="paste-file-nav" id="paste-file-nav" role="tablist" aria-label="Paste files" hidden></nav>` : ''}
    <div id="paste-content" data-cp-code="${id}" data-content-url="${contentUrl}" data-raw-url="${rawUrl}" data-staff-review="${staffReview}" data-format="${paste.format ?? 'single'}" data-primary="${escapeHtml(paste.primary ?? '')}" data-content-type="${escapeHtml(paste.content_type)}" data-byte-length="${paste.byte_length}" data-sha256="${escapeHtml(paste.sha256)}" data-dialog-metadata="${dialogMetadata}" aria-busy="true">
      <p class="paste-loading" role="status">Loading and decompressing paste…</p>
    </div>
  </section>
</div>`;
	const html = layout(
		`cp.codes/${paste.id}`,
		body,
		`<script type="module" src="${VIEW_MODULE_URL}"></script>`,
		{ resourceHints },
	);
	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store, private",
			vary: "Cookie, Authorization",
		},
	});
}

export function reviewRequiredPage(id: string, message: string, status = 423): Response {
	const body = `<section class="hero"><p class="eyebrow">${escapeHtml(id)}</p><h1>Human review is needed.</h1><p>${escapeHtml(message)}</p></section><section class="card"><p>The paste is stored, but this connection cannot access its content yet. This can happen when its sharing budget is reached, the AI is uncertain, or a file needs manual inspection.</p><p>No repeated upload is needed. A moderator can approve the same link.</p><p><a href="/${escapeHtml(id)}">Check again</a> · <a href="/">Create another paste</a></p></section>`;
	return new Response(layout('Review required — cp.codes', body), {
		status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, private', 'referrer-policy': 'no-referrer', vary: 'Cookie, Authorization' },
	});
}

export function notFoundPage(message = "Not found"): Response {
	const html = layout(
		"Not found — cp.codes",
		`<section class="card"><p class="status err">${escapeHtml(message)}</p><p><a href="/">← new paste</a></p></section>`,
		undefined,
	);
	return new Response(html, {
		status: 404,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store, private",
			vary: "Cookie, Authorization",
		},
	});
}
