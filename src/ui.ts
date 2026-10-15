/**
 * Minimal HTML shells for the pastebin UX (no build step).
 * Client PoW logic lives in /app.js (static asset).
 */

import { recentSection, pasteBody, pasteSkeleton } from "../public/pages.js";

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
	appShell?: boolean;
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
	<main id="page-content" tabindex="-1"${options.appShell ? ' data-app-shell' : ''}>${body}</main>
	${footer}
  </div>
  <script src="${assetUrl('/site.js')}"></script>
  ${script ?? ""}
</body>
</html>`;
}

type SitePage = "about" | "pastes" | "new";

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

export function aboutShellPage(): Response {
	return cacheableShell(aboutPage());
}

export function pastesPage(listing: PublicPastePage): Response {
	return sitePage("pastes", listing.items, listing);
}

export function newPage(): Response {
	return sitePage("new");
}

/** Static composer markup; staff display hints are resolved by site.js locally. */
export function newShellPage(): Response {
	return cacheableShell(newPage());
}

function cacheableShell(response: Response): Response {
	response.headers.set('cache-control', 'public, max-age=0, must-revalidate');
	response.headers.delete('vary');
	return response;
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

export function viewPage(paste: StoredPaste, hitCount: number, staffReview = false, offlineCacheable = false): Response {
	const contentUrl = staffReview ? `/admin/paste/${paste.id}/content` : `/api/paste/${paste.id}/content`;
	const resourceHints = `<link rel="preload" href="${contentUrl}" as="fetch" crossorigin="anonymous" />`;
	const body = pasteBody(paste, hitCount, {
		typeLabel: CONTENT_TYPE_LABELS[paste.content_type],
		rawUrl: staffReview ? `/admin/paste/${paste.id}/raw` : `/${paste.id}.${fileExtension(paste.content_type)}`,
		contentUrl, staffReview, offlineCacheable, reportCategories: REPORT_CATEGORIES, maxReportEmailChars: MAX_REPORT_EMAIL_CHARS,
	});
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

/** Generic, non-personalized shell used by the service worker for public routes. */
export function appShellPage(): Response {
	return new Response(layout('cp.codes', pasteSkeleton(),
		`<script type="module" src="${assetUrl('/navigation.js')}"></script>`, { appShell: true }), {
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate' },
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
