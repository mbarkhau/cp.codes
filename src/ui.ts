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

const EDITOR_PACKAGES: Record<string, string> = {
	"@codemirror/autocomplete": "6.20.3/dist/index.js",
	"@codemirror/commands": "6.11.1/dist/index.js",
	"@codemirror/lang-cpp": "6.0.3/dist/index.js",
	"@codemirror/lang-css": "6.3.1/dist/index.js",
	"@codemirror/lang-go": "6.0.1/dist/index.js",
	"@codemirror/lang-html": "6.4.12/dist/index.js",
	"@codemirror/lang-java": "6.0.2/dist/index.js",
	"@codemirror/lang-javascript": "6.2.5/dist/index.js",
	"@codemirror/lang-json": "6.0.2/dist/index.js",
	"@codemirror/lang-markdown": "6.5.2/dist/index.js",
	"@codemirror/lang-php": "6.0.2/dist/index.js",
	"@codemirror/lang-python": "6.2.1/dist/index.js",
	"@codemirror/lang-rust": "6.0.2/dist/index.js",
	"@codemirror/lang-sql": "6.10.0/dist/index.js",
	"@codemirror/lang-xml": "6.1.0/dist/index.js",
	"@codemirror/lang-yaml": "6.1.3/dist/index.js",
	"@codemirror/language": "6.13.1/dist/index.js",
	"@codemirror/lint": "6.9.7/dist/index.js",
	"@codemirror/state": "6.7.6/dist/index.js",
	"@codemirror/streamparser": "6.0.0/dist/index.js",
	"@codemirror/view": "6.43.14/dist/index.js",
	"@lezer/common": "1.5.3/dist/index.js",
	"@lezer/cpp": "1.1.6/dist/index.js",
	"@lezer/css": "1.3.9/dist/index.js",
	"@lezer/go": "1.0.1/dist/index.js",
	"@lezer/highlight": "1.2.5/dist/index.js",
	"@lezer/html": "1.3.13/dist/index.js",
	"@lezer/java": "1.1.5/dist/index.js",
	"@lezer/javascript": "1.5.6/dist/index.js",
	"@lezer/json": "1.0.3/dist/index.js",
	"@lezer/lr": "1.4.11/dist/index.js",
	"@lezer/markdown": "1.8.0/dist/index.js",
	"@lezer/php": "1.0.6/dist/index.js",
	"@lezer/python": "1.1.19/dist/index.js",
	"@lezer/rust": "1.0.3/dist/index.js",
	"@lezer/xml": "1.0.6/dist/index.js",
	"@lezer/yaml": "1.0.4/dist/index.js",
	"@marijn/find-cluster-break": "1.0.4/src/index.js",
	crelt: "1.0.7/index.js",
	"style-mod": "4.1.4/src/style-mod.js",
	"w3c-keyname": "2.2.8/index.js",
};
const EDITOR_IMPORT_MAP = JSON.stringify({
	imports: Object.fromEntries(Object.entries(EDITOR_PACKAGES).map(([name, path]) => [name, `https://cdn.jsdelivr.net/npm/${name}@${path}`])),
});

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
  color-scheme: light;
  /* Primary content has the strongest contrast; surfaces soften outward. */
  --bg: #e8edf3;
  --fg: #263449;
  --muted: #596980;
  --card: #f2f5f8;
  --surface: #f8fafc;
  --content-bg: #ffffff;
  --content-fg: #000000;
  --border: #d1dbe8;
  --accent: #2458cf;
  --accent-hover: #1743a3;
  --accent-contrast: #ffffff;
  --focus: #3f3f3f;
  --danger: #a52c43;
  --report-hover: #9b4f59;
  --success: #1e715b;
  --shadow: 1px 1px 10px rgba(100, 100, 100, 0.5);
  --syntax-comment: #59636e;
  --syntax-keyword: #cf222e;
  --syntax-string: #0a3069;
  --syntax-number: #0550ae;
  --syntax-title: #6639ba;
  --syntax-type: #953800;
  --syntax-tag: #116329;
  --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #1b2431;
  --fg: #ccd5e2;
  --muted: #a0b2cd;
  --card: #111a26;
  --surface: #080f18;
  --content-bg: #000000;
  --content-fg: #ffffff;
  --border: #344864;
  --accent: #a2bfff;
  --accent-hover: #c6d8ff;
  --accent-contrast: #101927;
  --focus: #a9a9a4;
  --danger: #c1aaa8;
  --success: #acb9b0;
  --shadow: 1px 1px 10px rgba(100, 100, 100, 0.5);
  --syntax-comment: #919ba5;
  --syntax-keyword: #ff7b72;
  --syntax-string: #a5d6ff;
  --syntax-number: #79c0ff;
  --syntax-title: #d2a8ff;
  --syntax-type: #ffa657;
  --syntax-tag: #7ee787;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--sans);
  background: var(--bg);
  color: var(--fg);
  min-height: 100vh;
  line-height: 1.55;
  overflow-y: scroll;
}
a { color: var(--accent); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent) 65%, transparent); text-underline-offset: 0.18em; }
a:hover { color: var(--accent-hover); text-decoration-color: currentColor; }
.wrap { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
.wrap.wide { max-width: 96rem; }
header { display: flex; align-items: center; min-height: 2.5rem; margin-bottom: 2rem; }
.logo { font-family: var(--mono); font-weight: 650; font-size: 1.15rem; letter-spacing: -0.02em; color: var(--fg); white-space: nowrap; }
.logo a { color: inherit; text-decoration: none; }
.logo span { color: var(--muted); }
.site-nav {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem 1.25rem;
  margin-left: auto;
  font-family: var(--mono);
  font-size: 0.85rem;
}
.site-nav a { color: var(--muted); text-decoration: none; white-space: nowrap; }
.site-nav .staff-nav-start { margin-left: 0.25rem; padding-left: 1.25rem; border-left: 1px solid var(--border); }
.site-nav a:hover, .site-nav a[aria-current="page"] { color: var(--fg); }
.site-nav a[aria-current="page"] { font-weight: 650; }
.site-nav .nav-logout { margin: 0; display: inline; }
.site-nav .nav-logout button { font: inherit; color: var(--muted); background: transparent; border: 0; border-radius: 0; padding: 0; box-shadow: none; }
.site-nav .nav-logout button:hover { color: var(--fg); filter: none; }
.theme-toggle {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 2.35rem;
  height: 2.35rem;
  margin-left: 0.85rem;
  padding: 0;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  box-shadow: none;
}
.theme-toggle:hover:not(:disabled) { color: var(--fg); background: var(--card); filter: none; }
.theme-toggle:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.theme-toggle svg { width: 1.05rem; height: 1.05rem; stroke: currentColor; }
.theme-icon-moon { display: none; }
:root[data-theme="dark"] .theme-icon-sun { display: none; }
:root[data-theme="dark"] .theme-icon-moon { display: block; }
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1.35rem;
  box-shadow: var(--shadow);
}
h1, h2, h3 { line-height: 1.25; }
.card > h1:first-child { margin-top: 0; font-size: 1.35rem; letter-spacing: -0.02em; }
label { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 0.4rem; }
.content-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.4rem;
}
.content-heading label { margin: 0; }
.file-input { display: none; }
.file-button {
  padding: 0.35rem 0.7rem;
  border-color: var(--border);
  background: var(--surface);
  color: var(--muted);
  font-size: 0.82rem;
  font-weight: 500;
}
.file-button:hover:not(:disabled) { border-color: var(--focus); background: var(--card); color: var(--fg); }
textarea, input, select, button {
  font: inherit;
}
select, input[type="text"], input[type="email"], input[type="password"] {
  background: var(--surface);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.55rem 0.7rem;
}
input[type="text"], input[type="email"], input[type="password"] { width: 100%; }
input[type="text"]:focus, input[type="email"]:focus, input[type="password"]:focus, textarea:focus, select:focus {
  outline: 2px solid color-mix(in srgb, var(--focus) 75%, transparent);
  outline-offset: 1px;
  border-color: var(--focus);
}
.paste-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
textarea {
  width: 100%;
  min-height: 18rem;
  resize: vertical;
  background: var(--content-bg);
  color: var(--content-fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.9rem 1rem;
  font-family: var(--mono);
  font-size: 0.92rem;
  line-height: 1.45;
}
textarea.file-drag-active, #new.file-drag-active {
  border-color: var(--focus);
  outline: 2px solid color-mix(in srgb, var(--focus) 75%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
}
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
.consent-publish {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.75rem;
  margin-top: 1rem;
}
.consent-control { margin: 0; }
.type-control { display: flex; flex-wrap: wrap; gap: 0.55rem; align-items: center; }
.type-control label { margin: 0; }
.check-control { display: flex; gap: 0.4rem; align-items: flex-start; margin: 0; color: var(--fg); cursor: pointer; }
.check-control input {
  flex: 0 0 auto;
  margin: 0.25em 0 0;
  accent-color: var(--accent);
}
.check-control > span { min-width: 0; }
.client-info-fields {
  display: grid;
  grid-template-columns: minmax(11rem, auto) minmax(0, 1fr);
  margin: 1rem 0 0;
  font-family: var(--mono);
  font-size: 0.82rem;
}
.client-info-fields dt, .client-info-fields dd {
  margin: 0;
  padding: 0.45rem 0;
  border-top: 1px solid var(--border);
}
.client-info-fields dt { padding-right: 1rem; color: var(--muted); }
.client-info-fields dd { overflow-wrap: anywhere; }
.client-info-null { color: var(--muted); }
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
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
  border-radius: 4px;
  padding: 0.65rem 1.1rem;
  font-weight: 650;
  cursor: pointer;
}
button:hover:not(:disabled), .btn:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
button:focus-visible, .btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
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
.status.ok { color: var(--success); }
.progress {
  margin-top: 0.75rem;
  height: 0.4rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
  display: none;
}
.progress > i {
  display: block;
  height: 100%;
  width: 30%;
  background: linear-gradient(90deg, transparent, var(--muted), transparent);
  animation: slide 1.2s ease-in-out infinite;
}
@keyframes slide {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(400%); }
}
.notes { margin-top: 1.5rem; color: var(--muted); font-size: 0.92rem; }
.notes.about-page { margin-top: 0; padding: 0.25rem 0; }
.notes h1 { margin: 0 0 0.75rem; color: var(--fg); font-size: 1.35rem; letter-spacing: -0.02em; }
.notes ul { padding-left: 1.2rem; }
.paste-head { margin-bottom: 1rem; }
.paste-card { position: relative; min-height: 5rem; }
#paste-content { background: var(--content-bg); color: var(--content-fg); }
.paste-loading { margin: 0; padding: 1.25rem; color: var(--muted); }
.paste-load-error { margin: 0; padding: 1.25rem; color: var(--danger); white-space: pre-wrap; }
.paste-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.75rem; align-items: center; margin-top: 1rem; }
.paste-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.4rem; align-items: center; }
.paste-toolbar .paste-action-status { position: relative; min-width: 0; height: 2.75rem; margin: 0; }
.paste-toolbar .paste-action-status > span { position: absolute; inset: 0; display: flex; justify-content: flex-end; align-items: center; }
.paste-toolbar .paste-action-status .action-feedback { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.action-feedback { opacity: 1; transition: none; }
.action-feedback.is-fading { opacity: 0; transition: opacity 1s ease; }
@media (max-width: 640px) {
  .paste-toolbar { grid-template-columns: minmax(0, 1fr); gap: 0.35rem; }
  .paste-toolbar .paste-action-status { height: 1.5rem; }
}
@media (prefers-reduced-motion: reduce) { .action-feedback.is-fading { transition: none; } }
.icon-action {
  display: inline-grid; place-items: center; width: 2.75rem; height: 2.75rem; padding: 0;
  border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--muted);
  text-decoration: none; flex: 0 0 auto;
}
.icon-action svg { width: 1.2rem; height: 1.2rem; }
.icon-action:hover:not(:disabled) { color: var(--fg); background: var(--card); border-color: var(--focus); }
.icon-action:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.icon-action.danger { color: var(--danger); background: var(--surface); border-color: var(--border); }
.icon-action.danger:hover:not(:disabled) { color: var(--danger); background: var(--card); border-color: var(--danger); filter: none; }
.icon-action.report:hover:not(:disabled) { color: #fff; background: var(--report-hover); border-color: var(--report-hover); filter: none; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.paste-dialog { color: var(--fg); background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 1.25rem; width: min(58rem, calc(100% - 2rem)); max-height: calc(100dvh - 2rem); overflow: auto; box-shadow: var(--shadow); }
.paste-dialog::backdrop { background: rgb(0 0 0 / 0.55); }
.paste-dialog-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.paste-dialog-head h2 { margin: 0; font-size: 1.2rem; }
.paste-dialog h3 { font-size: 0.9rem; margin: 1rem 0 0.5rem; }
.paste-file-metadata + .paste-file-metadata { margin-top: 1rem; }
.paste-file-metadata h3 { overflow-wrap: anywhere; }
.paste-file-links { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
.paste-file-links[hidden] { display: none; }
.paste-delete { display: flex; gap: 0.55rem; align-items: center; }
.paste-delete[hidden] { display: none; }
.paste-delete .status { margin: 0; }
#delete-countdown {
  display: inline-block;
  width: 5ch;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  text-align: center;
}
button.danger {
  border-color: var(--danger);
  background: var(--danger);
  color: #fff;
}
button.danger:hover:not(:disabled) { border-color: var(--danger); background: var(--danger); filter: brightness(0.9); }
.paste-main { min-width: 0; }
.paste-details {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 1.25rem;
  align-items: start;
  margin-top: 1.25rem;
}
/* The conservative area check selects a 53×53 PNG; display it at 6×. */
.paste-qr {
  --qr-w: 294px;
  --qr-h: 294px;
  --qr-pad: 12px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: var(--qr-pad);
  justify-self: start;
  line-height: 0;
  box-sizing: border-box;
  width: calc(var(--qr-w) + 2 * var(--qr-pad));
  max-width: 100%;
  height: auto;
}
.paste-qr a {
  display: block;
  width: 100%;
  height: auto;
  line-height: 0;
  text-decoration: none;
  color: inherit;
}
.paste-qr a:hover { text-decoration: none; }
/* Nearest-neighbor scaling — keep QR modules and bitmap font crisp. */
.paste-qr img {
  display: block;
  width: var(--qr-w);
  max-width: 100%;
  height: auto !important;
  image-rendering: -moz-crisp-edges;
  image-rendering: pixelated;
}
.paste-qr img:not([src]) { visibility: hidden; }
pre.paste {
  margin: 0;
  padding: 1rem 1.1rem;
  overflow: auto;
  background: var(--content-bg);
  color: var(--content-fg);
  border: 1px solid var(--border);
  border-radius: 4px;
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
  border-color: var(--border);
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
  border-top: 1px solid var(--border);
}
.pow-fields dt { padding-right: 1rem; }
.pow-fields dd { color: var(--muted); overflow-wrap: anywhere; }
.report-panel form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 0.75rem; align-items: end; margin-top: 1rem; }
.report-panel label { margin: 0; }
.report-panel label > span { display: block; margin-bottom: 0.35rem; }
.report-panel .status { grid-column: 1 / -1; position: relative; height: 2.75rem; margin: 0; }
.report-panel .status > span { position: absolute; inset: 0; overflow: auto; }
@media (max-width: 640px) { .report-panel form { grid-template-columns: 1fr; } }
.markdown-body { padding: 1rem 1.25rem; overflow-wrap: anywhere; background: var(--content-bg); color: var(--content-fg); }
.markdown-body > :first-child { margin-top: 0; }
.markdown-body > :last-child { margin-bottom: 0; }
.markdown-body pre { overflow: auto; padding: 0.85rem; border-radius: 4px; background: var(--surface); }
.markdown-body code { font-family: var(--mono); }
.markdown-body :not(pre) > code { padding: 0.1rem 0.3rem; border-radius: 4px; background: var(--surface); }
.markdown-body img { max-width: 100%; }
.markdown-body blockquote { margin-left: 0; padding-left: 1rem; border-left: 3px solid var(--border); color: var(--muted); }
.url-gate { padding: 1.25rem; }
.url-gate h2 { margin-top: 0; font-size: 1.05rem; }
.url-value { margin: 1rem 0; overflow-wrap: anywhere; font-family: var(--mono); }
.url-activate { display: inline-flex; align-items: center; gap: 0.5rem; margin: 0; color: var(--fg); cursor: pointer; }
.url-activate input { accent-color: var(--accent); }
.paste-image-wrap { padding: 1rem; text-align: center; background: var(--content-bg); }
.paste-image { display: block; max-width: 100%; max-height: 75vh; margin: 0 auto; }
.paste-media-wrap { padding: 1rem; background: var(--content-bg); }
.paste-media { display: block; width: 100%; max-height: 75vh; margin: 0 auto; }
@media (max-width: 720px) {
  .paste-details { grid-template-columns: minmax(0, 1fr); }
  .paste-qr { margin: 0 auto; justify-self: center; }
}
.hero { margin: 1rem 0 2rem; max-width: 48rem; }
.hero .eyebrow { color: var(--accent); font: 650 .75rem var(--mono); letter-spacing: .12em; text-transform: uppercase; }
.hero h1 { font-size: clamp(2rem, 5vw, 3.2rem); letter-spacing: -.05em; margin: .4rem 0 .75rem; }
.hero p { color: var(--muted); margin: .5rem 0; }
#file-editors, .editor-placeholder { min-height: 320px; }
.editor-placeholder .editor-toolbar { min-height: calc(32px + 1.1rem + 1px); }
.editor-card { border: 1px solid var(--border); border-radius: 4px; background: var(--surface); overflow: hidden; }
.editor-card + .editor-card { margin-top: .85rem; }
.editor-toolbar { --editor-control: 32px; display: flex; gap: .5rem; align-items: center; padding: .55rem; border-bottom: 1px solid var(--border); background: var(--surface); }
.editor-name { display: flex; flex: 1 1 16rem; gap: .5rem; min-width: 0; align-items: center; }
.editor-options { display: flex; align-items: center; gap: .5rem; margin-left: auto; }
.editor-toolbar .editor-filename,
.editor-toolbar .editor-type,
.editor-toolbar .editor-toggle,
.editor-toolbar button.editor-remove {
  box-sizing: border-box; height: var(--editor-control); min-height: var(--editor-control); margin: 0;
  border-width: 1px; border-style: solid; border-radius: 4px; font-size: .875rem; line-height: calc(var(--editor-control) - 2px);
}
.editor-toolbar .editor-filename { flex: 1 1 8rem; min-width: 0; padding: 0 .7rem; }
.editor-toolbar .editor-type { flex: 0 0 10.5rem; width: 10.5rem; padding: 0 1.6rem 0 .7rem; }
.editor-toolbar .editor-toggle,
.editor-toolbar button.editor-remove {
  display: inline-flex; align-items: center; justify-content: center; width: var(--editor-control); min-width: var(--editor-control); padding: 0; line-height: 0;
}
.editor-toolbar svg { stroke-linecap: butt; stroke-linejoin: miter; }
.editor-toolbar .editor-toggle svg,
.editor-toolbar button.editor-remove svg { display: block; flex: none; }
.editor-toolbar .editor-toggle svg { width: 20px; height: 20px; }
.editor-toolbar button.editor-remove svg { width: 24px; height: 24px; }
#preview-file { background: var(--surface); color: var(--fg); border-color: var(--border); }
#preview-file:hover:not(:disabled), #preview-file[aria-pressed="true"] { background: var(--card); color: var(--fg); border-color: var(--focus); }
button.editor-remove { color: var(--danger); background: transparent; border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
button.editor-remove:hover:not(:disabled) { color: #fff; background: var(--danger); border-color: var(--danger); }
button.editor-remove svg { color: currentColor; }
.editor-mount, .editor-fallback, .cm-editor { min-height: 16rem; }
.editor-mount { padding: 3px; background: var(--content-bg); color: var(--content-fg); }
.editor-card .cm-editor.cm-focused { outline: 2px solid var(--focus); outline-offset: 2px; }
.editor-card .cm-content { caret-color: var(--content-fg); }
.editor-card .cm-editor.cm-focused .cm-cursor, .editor-card .cm-editor.cm-focused .cm-dropCursor { border-left: 2px solid var(--content-fg); }
.editor-card .cm-gutters, .editor-card .cm-gutter, .editor-card .cm-activeLineGutter { background: var(--content-bg); color: var(--muted); border: 0; }
.editor-card .cm-lineNumbers, .editor-card .cm-lineNumbers .cm-gutterElement { min-width: 3ch; text-align: right; }
.editor-fallback { display: block; width: 100%; border: 0; border-radius: 0; resize: vertical; }
.editor-preview { width: 100%; margin-top: .85rem; padding: .85rem 0 0; border-top: 1px solid var(--border); }
.composer-actions { display: flex; justify-content: space-between; gap: .75rem; align-items: center; margin-top: .85rem; }
.composer-actions > div { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
#upload-result { margin-top: 1.25rem; border-color: var(--accent); }
#upload-result[hidden], [hidden] { display: none !important; }
.share-link { font: 600 1.1rem var(--mono); overflow-wrap: anywhere; }
.btn { display: inline-block; text-decoration: none; }
.paste-file-nav { display: flex; margin: 0; background: var(--surface); border-bottom: 1px solid var(--border); }
.paste-file-nav button {
  flex: 1 1 auto; min-width: 0; margin: 0; padding: .65rem 0; overflow: hidden;
  border: 0; border-top: 2px solid transparent; border-right: 1px solid var(--border); border-radius: 0;
  background: transparent; color: var(--muted); font: .85rem var(--mono);
}
.paste-file-nav button:last-child { border-right: 0; }
.paste-file-nav button > span { display: block; padding: 0 .75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.paste-file-nav button:hover { background: var(--card); color: var(--fg); border-color: var(--border); }
.paste-file-nav.tabs-overflowing button { flex: 1 1 0; }
.paste-file-nav button[aria-selected="true"] { background: var(--content-bg); color: var(--content-fg); border-top-color: var(--accent); }
.paste-file-nav.tabs-overflowing button[aria-selected="true"] { flex: 0 1 auto; }
.paste-file-nav button[aria-selected="true"] > span { white-space: normal; overflow-wrap: anywhere; text-overflow: clip; }
.paste-file-nav button:focus-visible { outline-offset: -3px; }
@media(max-width:760px) { .editor-toolbar { align-items: stretch; flex-wrap: wrap; } .editor-options { margin-left: 0; } }
@media(prefers-reduced-motion:reduce) { *, *::before, *::after { animation: none !important; scroll-behavior: auto !important; } }
.footer { margin: 2.25rem 0 0; padding: 1.25rem 0 0 1.15rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.78rem; }
.recent { margin-top: 1.75rem; }
.recent-page { margin-top: 0; }
.recent h2 {
  margin: 0 0 0.75rem;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.recent-list { list-style: none; margin: 0; padding: 0; border-radius: 4px; background: var(--content-bg); color: var(--content-fg); }
.recent-list li {
  display: grid;
  grid-template-columns: 7.5rem 4.5rem 1fr auto;
  gap: 0.75rem 1rem;
  align-items: baseline;
  padding: 0.7rem 0.75rem;
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
  color: var(--content-fg);
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
.paste-pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 1rem; margin: 1.5rem 0; }
.paste-pagination a { padding: .5rem .75rem; border: 1px solid var(--border); border-radius: 4px; text-decoration: none; }
.paste-pagination [aria-disabled] { color: var(--muted); }
@media (max-width: 640px) {
  .wrap { padding: 1rem 1rem 3rem; }
  header { flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1.5rem; }
  .site-nav { order: 3; width: 100%; margin-left: 0; padding-top: 0.75rem; border-top: 1px solid var(--border); }
  .site-nav .staff-nav-start { margin-left: 0; padding-left: 0; border-left: 0; }
  .theme-toggle { margin-left: auto; }
  .paste-fields { grid-template-columns: 1fr; }
  .recent-list li { grid-template-columns: 7.5rem 4.5rem 1fr; gap: 0.35rem 0.75rem; }
  .recent-meta { grid-column: 1 / -1; }
}
`.trim();

const THEME_SCRIPT = `<script>
(() => {
  const storageKey = "cp.codes.theme";
  let theme;
  try { theme = localStorage.getItem(storageKey); } catch {}
  if (theme !== "light" && theme !== "dark") theme = "light";
  const applyTheme = (nextTheme) => {
    document.documentElement.dataset.theme = nextTheme;
    const toggle = document.getElementById("theme-toggle");
    if (!(toggle instanceof HTMLButtonElement)) return;
    const dark = nextTheme === "dark";
    toggle.setAttribute("aria-pressed", String(dark));
    toggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    toggle.title = dark ? "Switch to light mode" : "Switch to dark mode";
  };
  applyTheme(theme);
  addEventListener("DOMContentLoaded", () => {
    applyTheme(document.documentElement.dataset.theme || theme);
    const toggle = document.getElementById("theme-toggle");
    toggle?.addEventListener("click", () => {
      const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(nextTheme);
      try { localStorage.setItem(storageKey, nextTheme); } catch {}
    });
  });
})();
</script>`;

export type LayoutOptions = {
	currentPath?: string;
	showStaffNavigation?: boolean;
	wide?: boolean;
	extraStyle?: string;
	showFooter?: boolean;
};

function navigation(currentPath: string, showStaffNavigation: boolean): string {
	const link = (href: string, label: string, className = "") =>
		`<a${className ? ` class="${className}"` : ""} href="${href}"${currentPath === href ? ` aria-current="page"` : ""}>${label}</a>`;
	const staffLinks = showStaffNavigation
		? `${link("/admin/pastes", "moderation", "staff-nav-start")}
        ${link("/admin/pow", "proof of work")}
        ${link("/admin/users", "users")}
        ${link("/admin/access-log", "access log")}
        <form class="nav-logout" method="post" action="/logout"><button type="submit">log out</button></form>`
		: "";
	return `<nav class="site-nav" aria-label="Primary navigation">
        ${link("/", "new")}
        ${link("/pastes", "pastes")}
        ${link("/about", "about")}
        ${staffLinks}
      </nav>`;
}

export function layout(
	title: string,
	body: string,
	script?: string,
	headerPath?: string,
	options: LayoutOptions = {},
): string {
	const headerLogo = headerPath
		? `<span class="logo"><a href="/">cp<span>.codes</span></a><a href="/${escapeHtml(headerPath)}"><span>/</span>${escapeHtml(headerPath)}</a></span>`
		: `<a class="logo" href="/">cp<span>.codes/</span></a>`;
	const currentPath = options.currentPath ?? (headerPath ? `/${headerPath}` : "");
	const footer = options.showFooter === false ? "" : `<ul class="footer">
      <li>AI-cleared pastes are limited to their uploader and three other IPs. Human approval is required for public distribution. Unlisted links are not secret storage.</li>
      <li>Operators may hide or delete content at any time for any reason.</li>
      <li>Access to your paste may be limited until a moderator approves wider distribution.</li>
      <li>IP and location metadata are logged for paste uploads and accesses; access logs also retain the HTTP Referer. They are used for abuse prevention and made available upon lawful request.</li>
    </ul>`;
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  ${THEME_SCRIPT}
  <style>${SHELL_STYLE}${options.extraStyle ? `\n${options.extraStyle}` : ""}</style>
</head>
<body>
  <div class="wrap${options.wide ? " wide" : ""}">
    <header>
      ${headerLogo}
      ${navigation(currentPath, options.showStaffNavigation === true)}
      <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Switch color theme" aria-pressed="false">
        <svg class="theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/>
        </svg>
        <svg class="theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20.2 15.2A8.5 8.5 0 0 1 8.8 3.8a8.5 8.5 0 1 0 11.4 11.4Z"/>
        </svg>
      </button>
    </header>
    ${body}
    ${footer}
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

function formatHitCount(hitCount: number): string {
	const count = Number.isSafeInteger(hitCount) && hitCount >= 0 ? hitCount : 0;
	return `${count.toLocaleString("en-US")} ${count === 1 ? "hit" : "hits"}`;
}

function recentPasteSummary(paste: RecentPaste): string {
	const filename = paste.filename ?? "";
	const useFilenameAsBadge = filename.length > 0 && filename.length < 10;
	const badge = useFilenameAsBadge
		? filename
		: `.${fileExtension(paste.content_type ?? "plaintext")}`;
	const filenameDetail = filename && !useFilenameAsBadge
		? `<strong>${escapeHtml(filename)}</strong> · `
		: "";

	return `<span class="recent-preview" title="${escapeHtml(paste.filename ?? paste.preview)}"><span class="type-badge">${escapeHtml(badge)}</span> ${filenameDetail}${escapeHtml(paste.preview) || "…"}</span>`;
}

function recentSection(recent: RecentPaste[], standalone = false, listing?: PublicPastePage): string {
	const items =
		recent.length === 0
			? `<p class="recent-empty">No public pastes yet.</p>`
			: `<ul class="recent-list">
${recent
	.map(
		(p) => `  <li>
    <a class="recent-id" href="/${escapeHtml(p.id)}">${escapeHtml(p.id)}</a>
    <span class="recent-bytes">${p.byte_length} B</span>
    ${recentPasteSummary(p)}
    <span class="recent-meta"><span title="Paste hit count">${formatHitCount(p.hit_count)}</span> · ${p.pow_difficulty == null ? "" : `<span title="Proof-of-work difficulty">PoW ${p.pow_difficulty} bits</span> · `}${formatWhen(p.created_at)}</span>
  </li>`,
	)
	.join("\n")}
</ul>`;

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

function sitePage(page: SitePage, recent: RecentPaste[] = [], showStaffNavigation = false, listing?: PublicPastePage): Response {
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
    <div class="row"><button type="button" id="publish" disabled>Publish</button><button type="button" id="preview-file" aria-pressed="false">Preview</button></div>
    <p class="meta"><span id="bytes">0 bytes</span> (max. 8 MiB) · <span id="proof-estimate">estimating…</span></p>
    <div id="draft-preview" class="editor-preview" hidden></div>
  </div>
  <div class="progress" id="progress" aria-hidden="true"><i></i></div>
  <div class="status" id="status" role="status" aria-live="polite"></div>
</section>
<section class="card" id="upload-result" tabindex="-1" hidden aria-live="polite"></section>`;
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
<script type="module" src="/app.js?v=54"></script>`
		: undefined;
	const html = layout(titles[page], body, script, page, { showStaffNavigation });
	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store, private",
			vary: "Cookie, Authorization",
		},
	});
}

export function aboutPage(showStaffNavigation = false): Response {
	return sitePage("about", [], showStaffNavigation);
}

export function pastesPage(listing: PublicPastePage, showStaffNavigation = false): Response {
	return sitePage("pastes", listing.items, showStaffNavigation, listing);
}

export function newPage(showStaffNavigation = false): Response {
	return sitePage("new", [], showStaffNavigation);
}

export function clientInfoPage(metadata: PasteUploadMetadata, showStaffNavigation = false): Response {
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
	return new Response(layout("Client info — cp.codes", body, undefined, "client-info", { showStaffNavigation }), {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store, private",
			vary: "Cookie, Authorization",
		},
	});
}

function pasteIcon(name: "raw" | "copy" | "delete" | "report" | "link" | "details" | "close" | "download"): string {
	const shapes = {
		raw: '<path d="M 7 6 L 2 12 L 7 18 M 17 6 L 22 12 L 17 18 M 14 4 L 10 20"/>',
		copy: '<path d="M 8 4 H 6 A 2 2 0 0 0 4 6 V 19 A 2 2 0 0 0 6 21 H 8 M 14 4 H 16 A 2 2 0 0 1 18 6 V 7 M 8 2 H 14 V 6 H 8 Z M 13 12 H 17 M 13 15 H 17 M 13 18 H 16 M 10 9 H 20 V 21 H 10 Z"/>',
		delete: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
		report: '<path d="M5 21V3m0 1h14l-3 4 3 4H5"/>',
		link: '<path d="M 16 12 L 7 12 M 9 16 L 8 17 A 4 4 0 0 1 2 11 L 6 7 A 4 4 0 0 1 12 7 M 14 8 L 15 7 A 4 4 0 0 1 21 13 L 17 17 A 4 4 0 0 1 11 17"/>',
		details: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>',
		close: '<path d="m6 6 12 12M6 18 18 6"/>',
		download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
	};
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shapes[name]}</svg>`;
}

function fileMetadataSection(paste: StoredPaste): string {
	const files = paste.files ?? [{ name: paste.filename ?? "Unnamed file", content_type: paste.content_type, byte_length: paste.byte_length, sha256: paste.sha256 }];
	return `<section><h3>File metadata</h3>${files.map(file => `<section class="paste-file-metadata" data-file-name="${escapeHtml(file.name)}">
      <h3>${escapeHtml(file.name)}${file.name === paste.primary ? ' · Main' : ''}</h3>
      <dl class="pow-fields"><dt>Content type</dt><dd>${escapeHtml(file.content_type)}</dd><dt>Size</dt><dd>${file.byte_length} bytes</dd><dt>SHA-256</dt><dd>${escapeHtml(file.sha256)}</dd></dl>
      ${paste.format ? `<div class="paste-file-links" hidden><a class="icon-action file-download" aria-label="Download ${escapeHtml(file.name)}" title="Download file">${pasteIcon("download")}</a><a class="icon-action" href="/${escapeHtml(paste.id)}/files/${encodeURIComponent(file.name)}" aria-label="Permalink to ${escapeHtml(file.name)}" title="File permalink">${pasteIcon("link")}</a></div>` : ''}
    </section>`).join('')}</section>`;
}

function proofOfWorkSection(proof: StoredPaste["proof_of_work"]): string {
	if (!proof) return '<section><h3>Upload proof &amp; integrity</h3><p class="meta">No proof-of-work details available.</p></section>';
	return `
    <section>
      <h3>Upload proof &amp; integrity</h3>
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

export function viewPage(paste: StoredPaste, hitCount: number, showStaffNavigation = false, staffReview = false): Response {
	const id = escapeHtml(paste.id);
	const qrHref = `https://cp.codes/${paste.id.toUpperCase()}`;
	const typeLabel = CONTENT_TYPE_LABELS[paste.content_type];
	const rawUrl = staffReview ? `/admin/paste/${id}/raw` : `/${id}.${fileExtension(paste.content_type)}`;
	const contentUrl = staffReview ? `/admin/paste/${id}/content` : `/api/paste/${id}/content`;
	const filename = paste.filename ? ` · <strong>${escapeHtml(paste.filename)}</strong>` : "";
	const visibility = paste.unlisted ? " · unlisted" : "";
	const body = `
<div class="paste-main">
  <section class="paste-head">
    ${staffReview ? `<p class="status">Staff review — content remains subject to its current visibility. <a href="/admin/pastes">← moderation</a></p><div class="row"><form method="post" action="/admin/paste/${id}"><input type="hidden" name="action" value="approve"/><button type="submit">Approve public access</button></form><form method="post" action="/admin/paste/${id}"><input type="hidden" name="action" value="classify"/><select name="reason" aria-label="Restriction reason" required><option value="">Restriction reason…</option>${REPORT_CATEGORIES.map(reason => `<option>${escapeHtml(reason)}</option>`).join('')}</select> <button class="danger" type="submit">Restrict &amp; hide</button></form></div>` : ""}
    <div class="meta">${formatWhen(paste.created_at)} · ${paste.byte_length} bytes · <span id="paste-hit-count">${formatHitCount(hitCount)}</span> · <span class="type-badge">${escapeHtml(typeLabel)}</span>${filename}${visibility}</div>
    <div class="paste-toolbar">
    <p class="status paste-action-status" role="status" aria-atomic="true"><span><span class="action-feedback" id="paste-action-status"></span></span></p>
    <nav class="paste-actions" aria-label="Paste actions">
      <button class="icon-action" type="button" id="copy-link" title="Copy link" aria-label="Copy link">${pasteIcon("link")}</button>
      <a class="icon-action" id="raw-paste" href="${rawUrl}" title="View raw content" aria-label="View raw content">${pasteIcon("raw")}</a>
      <button class="icon-action" type="button" id="copy-paste" data-cp-code="${id}" title="Copy content" aria-label="Copy content" disabled>${pasteIcon("copy")}</button>
      <button class="icon-action" type="button" id="open-details" data-dialog="paste-details-dialog" aria-haspopup="dialog" aria-controls="paste-details-dialog" title="Paste details" aria-label="Paste details">${pasteIcon("details")}</button>
      <button class="icon-action report" type="button" id="open-report" data-dialog="report-dialog" aria-haspopup="dialog" aria-controls="report-dialog" title="Report paste" aria-label="Report paste">${pasteIcon("report")}</button>
      <div class="paste-delete" id="paste-delete" hidden>
        <button type="button" class="icon-action danger" id="delete-paste" data-cp-code="${id}" title="Delete paste" aria-label="Delete paste">${pasteIcon("delete")}<span class="sr-only">Time remaining: <span id="delete-countdown">9:59</span></span></button>
      </div>
    </nav>
    </div>
  </section>
  <section class="card paste-card" style="padding:0; overflow:hidden;">
    ${paste.format && (paste.files?.length ?? 0) > 1 ? `<nav class="paste-file-nav" id="paste-file-nav" role="tablist" aria-label="Paste files" hidden></nav>` : ''}
    <div id="paste-content" data-cp-code="${id}" data-content-url="${contentUrl}" data-staff-review="${staffReview}" data-format="${paste.format ?? 'single'}" data-primary="${escapeHtml(paste.primary ?? '')}" data-content-type="${escapeHtml(paste.content_type)}" data-byte-length="${paste.byte_length}" data-sha256="${escapeHtml(paste.sha256)}" aria-busy="true">
      <p class="paste-loading" role="status">Loading and decompressing paste…</p>
    </div>
  </section>
</div>
<dialog class="paste-dialog report-panel" id="report-dialog" aria-labelledby="report-heading">
  <div class="paste-dialog-head"><h2 id="report-heading">Report suspected illegal content</h2><button type="button" class="icon-action" data-close-dialog title="Close" aria-label="Close report">${pasteIcon("close")}</button></div>
    <form id="report-paste" data-cp-code="${id}">
      <label><span>Reason (optional)</span><select name="category">
        <option value="">Select a reason</option>
        ${REPORT_CATEGORIES.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("\n        ")}
      </select></label>
      <label><span>Email (optional)</span><input type="email" name="email" maxlength="${MAX_REPORT_EMAIL_CHARS}" autocomplete="email" /></label>
      <button type="submit">Submit report</button>
      <p class="status" role="status" aria-atomic="true"><span class="action-feedback" id="report-status"></span></p>
    </form>
</dialog>
<dialog class="paste-dialog" id="paste-details-dialog" aria-labelledby="paste-details-heading">
  <div class="paste-dialog-head"><h2 id="paste-details-heading">Paste details</h2><button type="button" class="icon-action" data-close-dialog title="Close" aria-label="Close details">${pasteIcon("close")}</button></div>
<div class="paste-details">
  <aside class="paste-qr" aria-label="QR code">
    <a id="qr-link" href="${escapeHtml(qrHref)}" title="${escapeHtml(qrHref)}">
      <img id="qr" data-cp-code="${id}" width="53" height="53" decoding="sync" draggable="false" alt="QR code linking to ${id}" />
      <script>
        (() => {
          const image = document.getElementById("qr");
          if (!(image instanceof HTMLImageElement)) return;
          try {
            localStorage.removeItem("cp.codes.qr.v1");
            localStorage.removeItem("cp.codes.qr.png.v1");
            localStorage.removeItem("cp.codes.qr.png.v2");
            localStorage.removeItem("cp.codes.qr.png.v3");
            localStorage.removeItem("cp.codes.qr.png.v4");
            localStorage.removeItem("cp.codes.qr.png.v5");
            localStorage.removeItem("cp.codes.content.v1");
            const entries = JSON.parse(localStorage.getItem("cp.codes.paste.v1") || "[]");
            if (!Array.isArray(entries)) return;
            const cached = entries
              .slice(-10)
              .reverse()
              .find((entry) => entry && entry.id === image.dataset.cpCode);
            const qr = cached && cached.qr;
            const validDimensions = qr
              && Number.isInteger(qr.width) && qr.width > 0 && qr.width <= 512
              && Number.isInteger(qr.height) && qr.height > 0 && qr.height <= 512;
            const validDataUrl = qr
              && typeof qr.dataUrl === "string"
              && qr.dataUrl.startsWith("data:image/png;base64,")
              && qr.dataUrl.length <= 200000;
            if (!validDimensions || !validDataUrl) return;

            const displayScale = 6;
            const displayWidth = qr.width * displayScale;
            const displayHeight = qr.height * displayScale;
            image.width = qr.width;
            image.height = qr.height;
            image.style.width = displayWidth + "px";
            image.style.height = displayHeight + "px";
            const host = image.closest(".paste-qr");
            if (host instanceof HTMLElement) {
              host.style.setProperty("--qr-w", displayWidth + "px");
              host.style.setProperty("--qr-h", displayHeight + "px");
            }
            image.src = qr.dataUrl;
            image.dataset.qrCacheHit = "true";
            performance.mark("qr-cache-restored");
          } catch {
            // Cache access failed; view.js will render a fresh PNG.
          }
        })();
      </script>
    </a>
  </aside>
  <div>
    <dl class="pow-fields"><dt>Paste</dt><dd>${id}</dd><dt>Created</dt><dd>${escapeHtml(paste.created_at)}</dd><dt>Total size</dt><dd>${paste.byte_length} bytes</dd><dt>Stored size</dt><dd>${paste.compressed_byte_length} bytes (${escapeHtml(paste.content_encoding)})</dd><dt>Container SHA-256</dt><dd>${escapeHtml(paste.sha256)}</dd><dt>Visibility</dt><dd>${paste.unlisted ? 'Unlisted' : 'Listed'}</dd></dl>
    ${fileMetadataSection(paste)}
    ${proofOfWorkSection(paste.proof_of_work)}
  </div>
</div>
</dialog>`;
	const html = layout(
		`cp.codes/${paste.id}`,
		body,
		`<script type="module" src="/view.js?v=23"></script>`,
		paste.id,
		{ showStaffNavigation },
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
	const body = `<section class="hero"><p class="eyebrow">${escapeHtml(id)}</p><h1>Human review is needed.</h1><p>${escapeHtml(message)}</p></section><section class="card"><p>The paste is stored, but this connection cannot access its content yet. This can happen when its sharing budget is reached, the AI is uncertain, or a file needs manual inspection.</p><p>No repeated upload is needed. A moderator can approve the same link.</p><p><a href="/${escapeHtml(id)}">Check again</a> · <a href="/">Create another paste</a></p><div class="paste-delete" id="paste-delete" hidden><button type="button" class="danger" id="delete-paste" data-cp-code="${escapeHtml(id)}">Delete (<span id="delete-countdown">9:59</span>)</button><span class="status" id="delete-status" role="status"></span></div></section>`;
	return new Response(layout('Review required — cp.codes', body, '<script type="module" src="/view.js?v=23"></script>'), {
		status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, private', 'referrer-policy': 'no-referrer', vary: 'Cookie, Authorization' },
	});
}

export function notFoundPage(message = "Not found", showStaffNavigation = false): Response {
	const html = layout(
		"Not found — cp.codes",
		`<section class="card"><p class="status err">${escapeHtml(message)}</p><p><a href="/">← new paste</a></p></section>`,
		undefined,
		undefined,
		{ showStaffNavigation },
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
