/** Bump this manifest and its importers whenever a shell dependency changes. */
export const CACHE_VERSION = '38';
export const SHELL_URL = '/app-shell?v=38';
export const COMPOSER_URL = '/new-shell?v=38';
export const ABOUT_URL = '/about-shell?v=38';
export const EDITOR_MANIFEST_URL = '/lib/codemirror/manifest.json';
export const SHELL_ASSETS = [
	'/style.css?v=21', '/site.js?v=18', '/navigation.js?v=13', '/pages.js?v=9',
	'/view.js?v=42', '/offline.js?v=2', '/media.js?v=1', '/markdown.js?v=2',
	'/highlight.js?v=4', '/highlight.css?v=2', '/view_dialogs.js?v=2', '/qr_text.js?v=2',
	'/lib/markdown-it-14.1.0.js', '/lib/uqr-0.1.2.js',
	'/favicon-32.png?v=1', '/favicon.svg?v=1',
	'/app.js?v=79', '/files.js?v=49', '/content_type.js?v=11', '/policy.js?v=1',
	'/delimited.js?v=1',
	'/pow_worker.js?v=2', '/lib/hash-wasm-4.12.0.js', EDITOR_MANIFEST_URL,
];
