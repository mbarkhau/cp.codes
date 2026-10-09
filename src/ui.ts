/**
 * Minimal HTML shells for the pastebin UX (no build step).
 * Client PoW logic lives in /app.js (static asset).
 */

import type { PasteUploadMetadata, RecentPaste, StoredPaste } from "./paste";
import {
	DEFAULT_PASTE_BYTES,
	MAX_DESCRIPTION_CHARS,
	MAX_FILENAME_CHARS,
	MAX_REPORT_EMAIL_CHARS,
	PASTE_DIFFICULTY_STEP_BYTES,
	REPORT_CATEGORIES,
} from "./paste";
import { CONTENT_TYPES, CONTENT_TYPE_LABELS, fileExtension } from "./content_type";
import { POW_DEFAULTS } from "./pow";

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
  --bg: #f3f3f2;
  --fg: #080808;
  --muted: #444443;
  --card: #ffffff;
  --surface: #f8f8f7;
  --border: #858585;
  --accent: #181818;
  --accent-hover: #000000;
  --accent-contrast: #ffffff;
  --focus: #3f3f3f;
  --danger: #694f4d;
  --success: #4f5d54;
  --shadow: 0 1px 2px rgb(0 0 0 / 0.08), 0 8px 24px rgb(0 0 0 / 0.07);
  --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #10100f;
  --fg: #e4e4e0;
  --muted: #a4a49f;
  --card: #20201e;
  --surface: #171716;
  --border: #575753;
  --accent: #d7d7d2;
  --accent-hover: #efefec;
  --accent-contrast: #20201e;
  --focus: #a9a9a4;
  --danger: #c1aaa8;
  --success: #acb9b0;
  --shadow: 0 1px 2px rgb(0 0 0 / 0.24), 0 12px 32px rgb(0 0 0 / 0.2);
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
.wrap { max-width: 54rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
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
  border-radius: 10px;
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
  border-radius: 7px;
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
  background: var(--surface);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 0.9rem 1rem;
  font-family: var(--mono);
  font-size: 0.92rem;
  line-height: 1.45;
}
textarea.file-drag-active {
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
.check-control { display: flex; gap: 0.4rem; align-items: flex-start; color: var(--fg); cursor: pointer; }
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
  border-radius: 7px;
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
.paste-description { margin: 0.45rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.paste-card { position: relative; min-height: 5rem; }
.paste-loading { margin: 0; padding: 1.25rem; color: var(--muted); }
.paste-load-error { margin: 0; padding: 1.25rem; color: var(--danger); white-space: pre-wrap; }
.paste-actions {
  position: absolute;
  right: 0.75rem;
  bottom: 0.75rem;
  z-index: 1;
  display: flex;
  gap: 0.55rem;
  align-items: center;
}
.paste-actions button { box-shadow: 0 2px 8px color-mix(in srgb, var(--bg) 70%, transparent); }
#copy-paste { min-width: 5.5rem; }
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
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 7px;
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
.report-panel { margin-top: 1.25rem; }
.report-panel summary { cursor: pointer; color: var(--danger); font-size: 0.85rem; }
.report-panel form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 0.75rem; align-items: end; margin-top: 1rem; }
.report-panel label { margin: 0; }
.report-panel label > span { display: block; margin-bottom: 0.35rem; }
.report-panel .status { grid-column: 1 / -1; margin: 0; }
@media (max-width: 640px) { .report-panel form { grid-template-columns: 1fr; } }
.markdown-body { padding: 1rem 1.25rem; overflow-wrap: anywhere; }
.markdown-body > :first-child { margin-top: 0; }
.markdown-body > :last-child { margin-bottom: 0; }
.markdown-body pre { overflow: auto; padding: 0.85rem; border-radius: 6px; background: var(--surface); }
.markdown-body code { font-family: var(--mono); }
.markdown-body :not(pre) > code { padding: 0.1rem 0.3rem; border-radius: 4px; background: var(--surface); }
.markdown-body img { max-width: 100%; }
.markdown-body blockquote { margin-left: 0; padding-left: 1rem; border-left: 3px solid var(--border); color: var(--muted); }
.url-gate { padding: 1.25rem; }
.url-gate h2 { margin-top: 0; font-size: 1.05rem; }
.url-value { margin: 1rem 0; overflow-wrap: anywhere; font-family: var(--mono); }
.url-activate { display: inline-flex; align-items: center; gap: 0.5rem; margin: 0; color: var(--fg); cursor: pointer; }
.url-activate input { accent-color: var(--accent); }
.paste-image-wrap { padding: 1rem; text-align: center; background: var(--surface); }
.paste-image { display: block; max-width: 100%; max-height: 75vh; margin: 0 auto; }
.paste-media-wrap { padding: 1rem; background: var(--surface); }
.paste-media { display: block; width: 100%; max-height: 75vh; margin: 0 auto; }
@media (max-width: 720px) {
  .paste-details { grid-template-columns: 1fr; }
  .paste-qr { margin: 0 auto; justify-self: center; }
}
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
		: link("/login", "staff login");
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
      <li>All visible pastes are public, even if they're not listed.</li>
      <li>Operators may hide or delete content at any time for any reason.</li>
      <li>Access to your paste may be limited until its legality has been verified.</li>
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

	return `<span class="recent-preview" title="${escapeHtml(paste.description ?? paste.filename ?? paste.preview)}"><span class="type-badge">${escapeHtml(badge)}</span> ${filenameDetail}${escapeHtml(paste.description ?? paste.preview) || "…"}</span>`;
}

function recentSection(recent: RecentPaste[], standalone = false): string {
	const items =
		recent.length === 0
			? `<p class="recent-empty">No uploads yet.</p>`
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
  <h2>Recent uploads</h2>
  ${items}
</section>`;
}

type SitePage = "about" | "pastes" | "new";

function sitePage(page: SitePage, recent: RecentPaste[] = [], showStaffNavigation = false): Response {
	const d = POW_DEFAULTS.difficultyBits;
	const p50 = Math.ceil(Math.LN2 * 2 ** d);
	const average = 2 ** d;
	const newSection = `
<section class="card" id="new">
  <div class="paste-fields">
    <div>
      <label for="description">Description (optional)</label>
      <input type="text" id="description" maxlength="${MAX_DESCRIPTION_CHARS}" placeholder="What is this paste?" />
    </div>
    <div>
      <label for="filename">Filename (optional)</label>
      <input type="text" id="filename" maxlength="${MAX_FILENAME_CHARS}" placeholder="example.py" spellcheck="false" />
    </div>
  </div>
  <div class="content-heading">
    <label for="content">Content</label>
    <div>
      <input class="file-input" type="file" id="file-input" />
      <button class="file-button" type="button" id="file-button" aria-controls="file-input">Upload file</button>
    </div>
  </div>
  <textarea id="content" placeholder="Paste text, code, Markdown, a URL, or drop text, PNG/JPEG/WebP/GIF, MP3, or MP4…" spellcheck="false"></textarea>
  <div class="row-publish">
    <span class="meta"><span id="bytes">0 bytes</span> · <span id="size-difficulty">Base-size PoW</span> · <span id="detected-type">Detected: Plaintext</span></span>
    <div class="type-control">
      <label for="content-type">Type</label>
      <select id="content-type">
        <option value="auto">Auto detect</option>
        ${CONTENT_TYPES.map((type) => `<option value="${type}">${escapeHtml(CONTENT_TYPE_LABELS[type])}</option>`).join("\n        ")}
      </select>
    </div>
  </div>
  <div class="consent-publish">
    <label class="check-control"><input type="checkbox" id="listed" checked /><span>Public listing. (Only affects visibility in cp.codes/pastes listing. Visible pastes are publicly accessible via their URL regardless of listing status.)</span></label>
    <label class="check-control consent-control"><input type="checkbox" id="consent" /><span>I consent to the collection and storage of <a href="/client-info">my IP and location data</a>.</span></label>
    <label class="check-control consent-control"><input type="checkbox" id="consent-moderation" /><span>I consent to sending paste data to <a href="/about#service-providers">service providers</a> for automated moderation. Your paste may remain private until moderation is complete.</span></label>
    <button type="button" id="publish" disabled>Publish</button>
  </div>
  <div class="progress" id="progress" aria-hidden="true"><i></i></div>
  <div class="status" id="status" role="status"></div>
</section>`;
	const aboutSection = `
<section class="notes${page === "about" ? " about-page" : ""}" id="about">
  <h1>About cp.codes</h1>
  <p>cp.codes is a public pastebin and document store with no accounts or registration.</p>
  <ul>
    <li>No login. Uploads need a <strong>SHA-256</strong> search PoW: base difficulty ${d} (~${p50.toLocaleString()} attempts for a 50% chance; ${average.toLocaleString()} average). It rises by one bit for each paste from the 15th onward in the previous 10 minutes.</li>
    <li>Listed pastes get short version 0 ids; unlisted pastes stay out of recent uploads and use longer version 2 ids.</li>
    <li>No application size cap. Base difficulty covers ${DEFAULT_PASTE_BYTES.toLocaleString()} bytes; each additional started ${PASTE_DIFFICULTY_STEP_BYTES.toLocaleString()}-byte block adds one bit, up to SHA-256's 256-bit maximum. UTF-8 text plus PNG/JPEG/WebP/GIF images and MP3/MP4 media encoded as base64 data URLs; browsers gzip content before upload and decompress it when viewed.</li>
    <li>Every upload is assessed for spam, phishing, and CSAM before publication. Paste text and public descriptive metadata are sent to the moderation service providers listed below. Images, audio, video, over-context pastes, uncertain results, and assessment failures are held for staff review. Automated classification is not a verification of legality.</li>
    <li>Press <strong>Ctrl/⌘+P</strong> to detect and publish.</li>
  </ul>
  <h2 id="service-providers">Service providers</h2>
  <ul>
    <li><strong>Cloudflare</strong> hosts cp.codes and stores pastes and upload metadata, including IP and location data.</li>
    <li><strong>DefAPI</strong> provides the API used for automated moderation. Paste text, description, filename, and content type are sent to this service.</li>
    <li><strong>TypeSafe</strong> supplies the Jev model used for automated moderation through DefAPI.</li>
    <li><strong>jsDelivr</strong> serves browser libraries for Markdown rendering and fallback proof-of-work hashing. When loading these libraries, your browser sends IP and request metadata to the CDN, not paste contents.</li>
  </ul>
  <p>Private IP/location metadata and proof-of-work details are not sent to the automated moderation service.</p>
</section>`;
	const body = page === "new"
		? newSection
		: page === "about"
			? aboutSection
			: recentSection(recent, true);
	const titles: Record<SitePage, string> = {
		about: "About — cp.codes",
		pastes: "Pastes — cp.codes",
		new: "New paste — cp.codes",
	};
	const script = page === "new"
		? `<script type="module" src="/app.js?v=21"></script>`
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

export function pastesPage(recent: RecentPaste[], showStaffNavigation = false): Response {
	return sitePage("pastes", recent, showStaffNavigation);
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

export function viewPage(paste: StoredPaste, hitCount: number, showStaffNavigation = false, staffReview = false): Response {
	const id = escapeHtml(paste.id);
	const qrHref = `https://cp.codes/${paste.id.toUpperCase()}`;
	const typeLabel = CONTENT_TYPE_LABELS[paste.content_type];
	const rawUrl = staffReview ? `/admin/paste/${id}/raw` : `/${id}.${fileExtension(paste.content_type)}`;
	const contentUrl = staffReview ? `/admin/paste/${id}/content` : `/api/paste/${id}/content`;
	const rawLink = ` · <a href="${rawUrl}">raw</a>`;
	const filename = paste.filename ? ` · <strong>${escapeHtml(paste.filename)}</strong>` : "";
	const visibility = paste.unlisted ? " · unlisted" : "";
	const description = paste.description
		? `<p class="paste-description">${escapeHtml(paste.description)}</p>`
		: "";

	const body = `
<div class="paste-main">
  <section class="paste-head">
    ${staffReview ? `<p class="status">Staff review — content remains subject to its current visibility. <a href="/admin/pastes">← moderation</a></p>` : ""}
    <div class="meta">${formatWhen(paste.created_at)} · ${paste.byte_length} bytes · <span id="paste-hit-count">${formatHitCount(hitCount)}</span> · <span class="type-badge">${escapeHtml(typeLabel)}</span>${filename}${visibility}${rawLink}</div>
    ${description}
  </section>
  <section class="card paste-card" style="padding:0; overflow:hidden;">
    <div id="paste-content" data-cp-code="${id}" data-content-url="${contentUrl}" data-staff-review="${staffReview}" data-content-type="${escapeHtml(paste.content_type)}" data-byte-length="${paste.byte_length}" data-sha256="${escapeHtml(paste.sha256)}" aria-busy="true">
      <p class="paste-loading" role="status">Loading and decompressing paste…</p>
    </div>
    <div class="paste-actions">
      <div class="paste-delete" id="paste-delete" hidden>
        <button type="button" class="danger" id="delete-paste" data-cp-code="${id}">Delete (<span id="delete-countdown">9:59</span>)</button>
        <span class="status" id="delete-status" role="status"></span>
      </div>
      <button type="button" id="copy-paste" data-cp-code="${id}" disabled>Copy</button>
    </div>
  </section>
</div>
<section class="card report-panel">
  <details>
    <summary>Report suspected illegal content</summary>
    <form id="report-paste" data-cp-code="${id}">
      <label><span>Reason (optional)</span><select name="category">
        <option value="">Select a reason</option>
        ${REPORT_CATEGORIES.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("\n        ")}
      </select></label>
      <label><span>Email (optional)</span><input type="email" name="email" maxlength="${MAX_REPORT_EMAIL_CHARS}" autocomplete="email" /></label>
      <button type="submit">Submit report</button>
      <p class="status" id="report-status" role="status"></p>
    </form>
  </details>
</section>
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
  ${proofOfWorkSection(paste.proof_of_work)}
</div>`;
	const html = layout(
		`cp.codes/${paste.id}`,
		body,
		`<script type="module" src="/view.js?v=15"></script>`,
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
