import editorManifest from '../public/lib/codemirror/manifest.json';

/** Bump a changed asset and every module that imports it before deployment. */
export const CLIENT_ASSET_VERSIONS = {
	'/app.js': '62',
	'/authorization.js': '2',
	'/authorization_storage.js': '1',
	'/content_type.js': '8',
	'/files.js': '34',
	'/highlight.js': '2',
	'/markdown.js': '2',
	'/media.js': '1',
	'/policy.js': '1',
	'/pow_worker.js': '2',
	'/qr_text.js': '2',
	'/site.js': '5',
	'/view.js': '35',
	'/view_dialogs.js': '1',
	'/wordlist.js': '1',
	'/admin.css': '1',
	'/highlight.css': '2',
	'/style.css': '4',
	'/favicon-32.png': '1',
	'/favicon.svg': '1',
} as const;

export type ClientAssetPath = keyof typeof CLIENT_ASSET_VERSIONS;

export function assetUrl(path: ClientAssetPath): string {
	return `${path}?v=${CLIENT_ASSET_VERSIONS[path]}`;
}

const VENDOR_ASSETS = new Set([
	'/lib/uqr-0.1.2.js',
	'/lib/markdown-it-14.1.0.js',
	'/lib/hash-wasm-4.12.0.js',
	...editorManifest.files,
]);

export function withAssetCachePolicy(request: Request, response: Response): Response {
	if (response.status !== 200 && response.status !== 304) return response;
	const url = new URL(request.url);
	const version = CLIENT_ASSET_VERSIONS[url.pathname as ClientAssetPath];
	const versioned = (version !== undefined && url.searchParams.get('v') === version &&
		url.searchParams.getAll('v').length === 1) || VENDOR_ASSETS.has(url.pathname);
	const headers = new Headers(response.headers);
	headers.set('cache-control', versioned
		? 'public, max-age=31536000, immutable'
		: 'public, max-age=0, must-revalidate');
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
