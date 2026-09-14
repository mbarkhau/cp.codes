/**
 * Minimal HTML shells for the pastebin UX (no build step).
 * Client PoW logic lives in /app.js (static asset).
 */

import MarkdownIt from "markdown-it";
import type { RecentPaste, StoredPaste } from "./paste";
import { MAX_PASTE_BYTES } from "./paste";
import { CONTENT_TYPES, CONTENT_TYPE_LABELS, fileExtension, type ContentType } from "./content_type";
import { POW_DEFAULTS } from "./pow";

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });
const defaultLinkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
	tokens[idx]!.attrSet("rel", "nofollow noopener noreferrer");
	return defaultLinkOpen
		? defaultLinkOpen(tokens, idx, options, env, self)
		: self.renderToken(tokens, idx, options);
};

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const SHELL_STYLE = `
:root {
  color-scheme: light dark;
  --bg: #0f1218;
  --fg: #e8ecf1;
  --muted: #8b95a8;
  --card: #171c26;
  --border: #2a3344;
  --accent: #6ee7b7;
  --accent-dim: #34d399;
  --danger: #f87171;
  --mono: "IBM Plex Mono", "ui-monospace", "SFMono-Regular", Menlo, Consolas, monospace;
  --sans: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--sans);
  background: radial-gradient(1200px 600px at 10% -10%, #1a2740 0%, var(--bg) 55%);
  color: var(--fg);
  min-height: 100vh;
  line-height: 1.5;
  overflow-y: scroll;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
header { display: flex; align-items: baseline; margin-bottom: 1.75rem; }
.logo { font-family: var(--mono); font-weight: 600; font-size: 1.25rem; letter-spacing: 0.04em; color: var(--fg); }
.logo a { color: inherit; }
.logo span { color: var(--accent); }
.card {
  background: color-mix(in srgb, var(--card) 92%, transparent);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.25rem;
  backdrop-filter: blur(6px);
}
label { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 0.4rem; }
textarea, input, select, button {
  font: inherit;
}
select {
  background: #0c0f14;
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.55rem 0.7rem;
}
textarea {
  width: 100%;
  min-height: 18rem;
  resize: vertical;
  background: #0c0f14;
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.9rem 1rem;
  font-family: var(--mono);
  font-size: 0.92rem;
  line-height: 1.45;
}
textarea:focus { outline: 2px solid color-mix(in srgb, var(--accent) 50%, transparent); border-color: var(--accent-dim); }
.row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin-top: 1rem; }
.row-publish {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
  justify-content: space-between;
  margin-top: 1rem;
}
.row-publish .meta { font-family: var(--mono); }
.type-control { display: flex; gap: 0.55rem; align-items: center; }
.type-control label { margin: 0; }
.type-badge {
  display: inline-block;
  padding: 0.08rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  font: 0.75rem var(--mono);
  min-width: 6.5em;
  text-align: center;
  vertical-align: middle;
}
button, .btn {
  appearance: none;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 28%, #122), #0d1a14);
  color: var(--fg);
  border-radius: 8px;
  padding: 0.65rem 1.1rem;
  font-weight: 600;
  cursor: pointer;
}
button:hover:not(:disabled), .btn:hover { filter: brightness(1.08); }
button:disabled { opacity: 0.55; cursor: not-allowed; }
.meta { color: var(--muted); font-size: 0.85rem; font-family: var(--mono); }
.meta strong { color: var(--fg); font-weight: 600; }
.mono { font-family: var(--mono); }
.status {
  margin-top: 1rem;
  font-family: var(--mono);
  font-size: 0.85rem;
  color: var(--muted);
  white-space: pre-wrap;
}
.status.err { color: var(--danger); }
.status.ok { color: var(--accent); }
.progress {
  margin-top: 0.75rem;
  height: 0.4rem;
  background: #0c0f14;
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
  display: none;
}
.progress > i {
  display: block;
  height: 100%;
  width: 30%;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  animation: slide 1.2s ease-in-out infinite;
}
@keyframes slide {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(400%); }
}
.notes { margin-top: 1.5rem; color: var(--muted); font-size: 0.9rem; }
.notes ul { padding-left: 1.2rem; }
.paste-head { margin-bottom: 1rem; }
.paste-main { min-width: 0; }
.paste-details {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 1.25rem;
  align-items: start;
  margin-top: 1.25rem;
}
/* modulePixels=2 produces a 91×92 PNG for the usual ID; display it at 3×. */
.paste-qr {
  --qr-w: 273px;
  --qr-h: 276px;
  --qr-pad: 12px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: var(--qr-pad);
  justify-self: start;
  line-height: 0;
  box-sizing: border-box;
  width: calc(var(--qr-w) + 2 * var(--qr-pad));
  height: calc(var(--qr-h) + 2 * var(--qr-pad));
}
.paste-qr a {
  display: block;
  width: var(--qr-w);
  height: var(--qr-h);
  line-height: 0;
  text-decoration: none;
  color: inherit;
}
.paste-qr a:hover { text-decoration: none; }
@media (min-width: 721px) {
  .paste-qr { filter: brightness(0.5); }
  .paste-qr:hover { filter: brightness(1); }
}
/* Nearest-neighbor scaling — keep QR modules and bitmap font crisp. */
.paste-qr img {
  display: block;
  width: var(--qr-w);
  height: var(--qr-h);
  image-rendering: -moz-crisp-edges;
  image-rendering: pixelated;
}
.paste-qr img:not([src]) { visibility: hidden; }
pre.paste {
  margin: 0;
  padding: 1rem 1.1rem;
  overflow: auto;
  background: #0c0f14;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: var(--mono);
  font-size: 0.9rem;
  white-space: pre-wrap;
  word-break: break-word;
}
.pow-info {
  margin: 0;
  padding: 0.85rem 1rem;
  color: var(--muted);
  background: transparent;
  border-color: color-mix(in srgb, var(--border) 65%, transparent);
  backdrop-filter: none;
}
.pow-info h2 {
  margin: 0 0 0.5rem;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.pow-fields {
  display: grid;
  grid-template-columns: minmax(7rem, auto) minmax(0, 1fr);
  margin: 0;
  font-family: var(--mono);
  font-size: 0.72rem;
}
.pow-fields dt, .pow-fields dd {
  margin: 0;
  padding: 0.3rem 0;
  border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
}
.pow-fields dt { padding-right: 1rem; }
.pow-fields dd { color: color-mix(in srgb, var(--muted) 85%, transparent); overflow-wrap: anywhere; }
.markdown-body { padding: 1rem 1.25rem; overflow-wrap: anywhere; }
.markdown-body > :first-child { margin-top: 0; }
.markdown-body > :last-child { margin-bottom: 0; }
.markdown-body pre { overflow: auto; padding: 0.85rem; border-radius: 6px; background: #0c0f14; }
.markdown-body code { font-family: var(--mono); }
.markdown-body :not(pre) > code { padding: 0.1rem 0.3rem; border-radius: 4px; background: #0c0f14; }
.markdown-body img { max-width: 100%; }
.markdown-body blockquote { margin-left: 0; padding-left: 1rem; border-left: 3px solid var(--border); color: var(--muted); }
.url-gate { padding: 1.25rem; }
.url-gate h2 { margin-top: 0; font-size: 1.05rem; }
.url-value { margin: 1rem 0; overflow-wrap: anywhere; font-family: var(--mono); }
.url-activate { display: inline-flex; align-items: center; gap: 0.5rem; margin: 0; color: var(--fg); cursor: pointer; }
.url-activate input { accent-color: var(--accent-dim); }
@media (max-width: 720px) {
  .paste-details { grid-template-columns: 1fr; }
  .paste-qr { margin: 0 auto; justify-self: center; }
}
.footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; }
.recent { margin-top: 1.75rem; }
.recent h2 {
  margin: 0 0 0.75rem;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.recent-list { list-style: none; margin: 0; padding: 0; }
.recent-list li {
  display: grid;
  grid-template-columns: 7.5rem 4.5rem 1fr auto;
  gap: 0.75rem 1rem;
  align-items: baseline;
  padding: 0.7rem 0;
  border-top: 1px solid var(--border);
}
.recent-list li:last-child { border-bottom: 1px solid var(--border); }
.recent-id { font-family: var(--mono); font-size: 0.9rem; font-weight: 600; }
.recent-bytes {
  font-family: var(--mono);
  font-size: 0.78rem;
  color: var(--muted);
  white-space: nowrap;
  text-align: right;
}
.recent-preview {
  font-family: var(--mono);
  font-size: 0.82rem;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.recent-meta {
  font-family: var(--mono);
  font-size: 0.78rem;
  color: var(--muted);
  white-space: nowrap;
}
.recent-empty { color: var(--muted); font-size: 0.9rem; margin: 0; }
@media (max-width: 640px) {
  .recent-list li { grid-template-columns: 7.5rem 4.5rem 1fr; gap: 0.35rem 0.75rem; }
  .recent-meta { grid-column: 1 / -1; }
}
`.trim();

function layout(title: string, body: string, script?: string, headerPath?: string): string {
	const headerLogo = headerPath
		? `<span class="logo"><a href="/">cp<span>.codes</span></a><a href="/${escapeHtml(headerPath)}"><span>/</span>${escapeHtml(headerPath)}</a></span>`
		: `<a class="logo" href="/">cp<span>.codes/</span></a>`;
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${SHELL_STYLE}</style>
</head>
<body>
  <div class="wrap">
    <header>
      ${headerLogo}
    </header>
    ${body}
    <p class="footer">All pastes are public. Uploads require a SHA-256 proof of work. Operators may purge content at any time.</p>
  </div>
  ${script ?? ""}
</body>
</html>`;
}

function formatWhen(iso: string): string {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return escapeHtml(iso);
	return escapeHtml(new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z"));
}

function recentSection(recent: RecentPaste[]): string {
	const items =
		recent.length === 0
			? `<p class="recent-empty">No uploads yet.</p>`
			: `<ul class="recent-list">
${recent
	.map(
		(p) => `  <li>
    <a class="recent-id" href="/${escapeHtml(p.id)}">${escapeHtml(p.id)}</a>
    <span class="recent-bytes">${p.byte_length} B</span>
    <span class="recent-preview" title="${escapeHtml(p.preview)}"><span class="type-badge">${escapeHtml(CONTENT_TYPE_LABELS[p.content_type ?? "plaintext"])}</span> ${escapeHtml(p.preview) || "…"}</span>
    <span class="recent-meta">${p.pow_difficulty == null ? "" : `<span title="Proof-of-work difficulty">PoW ${p.pow_difficulty} bits</span> · `}${formatWhen(p.created_at)}</span>
  </li>`,
	)
	.join("\n")}
</ul>`;

	return `
<section class="recent card">
  <h2>Recent uploads</h2>
  ${items}
</section>`;
}

export function homePage(recent: RecentPaste[] = []): Response {
	const d = POW_DEFAULTS.difficultyBits;
	const p50 = Math.ceil(Math.LN2 * 2 ** d);
	const average = 2 ** d;
	const body = `
<section class="card">
  <label for="content">Content</label>
  <textarea id="content" placeholder="Paste text, code, Markdown, or a URL…" maxlength="${MAX_PASTE_BYTES}" spellcheck="false"></textarea>
  <div class="row-publish">
    <span class="meta" id="bytes">0 / ${MAX_PASTE_BYTES} bytes · <span id="detected-type">Detected: Plaintext</span></span>
    <div class="type-control">
      <label for="content-type">Type</label>
      <select id="content-type">
        <option value="auto">Auto detect</option>
        ${CONTENT_TYPES.map((type) => `<option value="${type}">${escapeHtml(CONTENT_TYPE_LABELS[type])}</option>`).join("\n        ")}
      </select>
      <button type="button" id="publish">Publish</button>
    </div>
  </div>
  <div class="progress" id="progress" aria-hidden="true"><i></i></div>
  <div class="status" id="status" role="status"></div>
</section>
<section class="notes">
  <ul>
    <li>No login. Uploads need a <strong>SHA-256</strong> search PoW: base difficulty ${d} (~${p50.toLocaleString()} attempts for a 50% chance; ${average.toLocaleString()} average). It rises by one bit for each paste from the 15th onward in the previous 10 minutes.</li>
    <li>Each paste gets a short <strong>cp.code</strong> id (e.g. <code>CP0A1B2C</code>).</li>
    <li>Max size ${MAX_PASTE_BYTES.toLocaleString()} bytes. Text only; type detection runs locally and can be overridden.</li>
    <li>Press <strong>Ctrl/⌘+P</strong> to detect and publish.</li>
  </ul>
</section>
${recentSection(recent)}`;
	const html = layout("cp.codes — paste", body, `<script type="module" src="/app.js"></script>`);
	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function pasteBody(content: string, contentType: ContentType): string {
	if (contentType === "markdown") {
		return `<article class="markdown-body">${markdown.render(content)}</article>`;
	}
	if (contentType === "url") {
		return `<div class="url-gate" id="url-gate">
        <h2>External link</h2>
        <p>This URL leads to an <b>external website</b>.<br><strong>cp.codes is not responsible for any external content on other websites.</strong></p>
        <label class="url-activate"><input type="checkbox" id="activate-url" /> I understand — activate link</label>
        <p class="url-value"><span id="url-value">${escapeHtml(content.trim())}</span></p>
      </div>`;
	}
	return `<pre class="paste"><code class="language-${escapeHtml(contentType)}">${escapeHtml(content)}</code></pre>`;
}

function proofOfWorkSection(proof: StoredPaste["proof_of_work"]): string {
	if (!proof) return "";
	return `
    <section class="pow-info card">
      <h2>Proof of work</h2>
      <dl class="pow-fields">
        <dt>Algorithm</dt><dd>SHA-256</dd>
        <dt>Difficulty</dt><dd>${proof.difficulty} leading zero bits</dd>
        <dt>Result</dt><dd>${proof.leading_zero_bits} leading zero bits</dd>
        <dt>Solution</dt><dd>${escapeHtml(proof.solution)}</dd>
        <dt>Challenge</dt><dd>${escapeHtml(proof.challenge_id)}</dd>
        <dt>Server nonce</dt><dd>${escapeHtml(proof.nonce)}</dd>
        <dt>Proof hash</dt><dd>${escapeHtml(proof.pow_hash)}</dd>
      </dl>
    </section>`;
}

export function viewPage(paste: StoredPaste): Response {
	const id = escapeHtml(paste.id);
	const qrHref = `https://cp.codes/${paste.id.toUpperCase()}`;
	const typeLabel = CONTENT_TYPE_LABELS[paste.content_type];
	const rawLink = paste.content_type === "url"
		? ""
		: ` · <a href="/${id}.${fileExtension(paste.content_type)}">raw</a>`;

	const body = `
<div class="paste-main">
  <section class="paste-head">
    <div class="meta">${formatWhen(paste.created_at)} · ${paste.byte_length} bytes · <span class="type-badge">${escapeHtml(typeLabel)}</span>${rawLink}</div>
  </section>
  <section class="card" style="padding:0; overflow:hidden;">
    ${pasteBody(paste.content, paste.content_type)}
  </section>
</div>
<div class="paste-details">
  <aside class="paste-qr" aria-label="QR code">
    <a id="qr-link" href="${escapeHtml(qrHref)}" title="${escapeHtml(qrHref)}">
      <img id="qr" data-cp-code="${id}" width="91" height="92" decoding="sync" draggable="false" alt="QR code linking to ${id}" />
      <script>
        (() => {
          const image = document.getElementById("qr");
          if (!(image instanceof HTMLImageElement)) return;
          try {
            localStorage.removeItem("cp.codes.qr.v1");
            localStorage.removeItem("cp.codes.qr.png.v1");
            const cached = JSON.parse(localStorage.getItem("cp.codes.qr.png.v2") || "null");
            const validDimensions = cached
              && Number.isInteger(cached.width) && cached.width > 0 && cached.width <= 512
              && Number.isInteger(cached.height) && cached.height > 0 && cached.height <= 512;
            const validDataUrl = cached
              && typeof cached.dataUrl === "string"
              && cached.dataUrl.startsWith("data:image/png;base64,")
              && cached.dataUrl.length <= 200000;
            if (!validDimensions || !validDataUrl || cached.id !== image.dataset.cpCode) return;

            const displayScale = 3;
            const displayWidth = cached.width * displayScale;
            const displayHeight = cached.height * displayScale;
            image.width = cached.width;
            image.height = cached.height;
            image.style.width = displayWidth + "px";
            image.style.height = displayHeight + "px";
            const host = image.closest(".paste-qr");
            if (host instanceof HTMLElement) {
              host.style.setProperty("--qr-w", displayWidth + "px");
              host.style.setProperty("--qr-h", displayHeight + "px");
            }
            image.src = cached.dataUrl;
            image.dataset.qrCacheHit = "true";
            performance.mark("qr-cache-restored");
          } catch {
            // Cache access failed; view.js will render a fresh PNG.
          }
        })();
      </script>
    </a>
  </aside>
  ${proofOfWorkSection(paste.proof_of_work)}
</div>`;
	const html = layout(
		`cp.codes/${paste.id}`,
		body,
		`<script type="module" src="/view.js"></script>`,
		paste.id,
	);
	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "public, max-age=60",
		},
	});
}

export function notFoundPage(message = "Not found"): Response {
	const html = layout(
		"Not found — cp.codes",
		`<section class="card"><p class="status err">${escapeHtml(message)}</p><p><a href="/">← new paste</a></p></section>`,
	);
	return new Response(html, {
		status: 404,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}
