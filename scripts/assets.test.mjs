import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const compiled = await build({ entryPoints: ['src/assets.ts'], bundle: true, write: false, format: 'esm' });
const { CLIENT_ASSET_VERSIONS, assetUrl, withAssetCachePolicy } = await import(
	`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const immutable = 'public, max-age=31536000, immutable';
const revalidate = 'public, max-age=0, must-revalidate';
const editorManifest = JSON.parse(await readFile('public/lib/codemirror/manifest.json', 'utf8'));

test('every application JS/CSS asset has one version and all client references agree', async () => {
	for (const file of await readdir('public')) {
		if (!/\.(js|css)$/.test(file)) continue;
		assert.ok(CLIENT_ASSET_VERSIONS[`/${file}`], `Missing version: ${file}`);
		if (!file.endsWith('.js')) continue;
		const source = await readFile(`public/${file}`, 'utf8');
		for (const match of source.matchAll(/(['"])((?:\/|\.\/)[^'"\s]+\.(?:js|css)(?:\?[^'"\s]*)?)\1/g)) {
			const url = new URL(match[2], `https://cp.codes/${file}`);
			if (url.pathname.startsWith('/lib/')) continue;
			// The registration URL is stable; the browser must revalidate it for updates.
			if (file === 'offline.js' && match[2] === '/sw.js') continue;
			assert.equal(url.pathname + url.search, assetUrl(url.pathname), `${file}: ${match[2]}`);
		}
	}
});

test('offline shell manifest agrees with the asset registry and covers local imports', async () => {
	const { CACHE_VERSION, SHELL_URL, COMPOSER_URL, ABOUT_URL, EDITOR_MANIFEST_URL, SHELL_ASSETS } = await import('../public/offline_assets.js');
	assert.equal(CACHE_VERSION, CLIENT_ASSET_VERSIONS['/offline_assets.js']);
	assert.equal(SHELL_URL, `/app-shell?v=${CACHE_VERSION}`);
	assert.equal(COMPOSER_URL, `/new-shell?v=${CACHE_VERSION}`);
	assert.equal(ABOUT_URL, `/about-shell?v=${CACHE_VERSION}`);
	const cached = new Set(SHELL_ASSETS);
	assert.ok(cached.has(EDITOR_MANIFEST_URL));
	assert.ok(cached.has(assetUrl('/app.js')));
	for (const path of SHELL_ASSETS) {
		const url = new URL(path, 'https://cp.codes');
		if (!url.pathname.startsWith('/lib/')) assert.equal(path, assetUrl(url.pathname));
		if (!url.pathname.endsWith('.js')) continue;
		const source = await readFile(`public${url.pathname}`, 'utf8');
		for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)(['"])((?:\.\/|\/)[^'"\s]+\.(?:js|css)(?:\?[^'"\s]*)?)\1/g)) {
			const dependency = new URL(match[2], url);
			assert.ok(cached.has(dependency.pathname + dependency.search), `Offline dependency missing: ${path} -> ${match[2]}`);
		}
	}
});

test('offline about shell is generic and matches the ordinary about page', async () => {
	const anonymous = await mf.dispatchFetch('https://cp.codes/about-shell?v=1');
	const staff = await mf.dispatchFetch('https://cp.codes/about-shell?v=1', {
		headers: { cookie: 'cp_staff_nav=1; cp_staff_session=private-token' },
	});
	assert.equal(anonymous.status, 200);
	assert.equal(anonymous.headers.get('cache-control'), revalidate);
	assert.equal(anonymous.headers.get('vary'), null);
	const html = await anonymous.text();
	assert.equal(await staff.text(), html);
	assert.equal(await (await mf.dispatchFetch('https://cp.codes/about')).text(), html);
	assert.ok(html.includes('id="service-providers"'));
	assert.doesNotMatch(html, /private-token|data-app-shell|data-cp-code|\/admin\//);
	const head = await mf.dispatchFetch('https://cp.codes/about-shell', { method: 'HEAD' });
	assert.equal(head.status, 200);
	assert.equal(await head.text(), '');
	assert.equal((await mf.dispatchFetch('https://cp.codes/about-shell', { method: 'POST' })).status, 405);
});

test('offline composer shell is generic and preserves the complete editor markup and import map', async () => {
	const anonymous = await mf.dispatchFetch('https://cp.codes/new-shell?v=1');
	const staff = await mf.dispatchFetch('https://cp.codes/new-shell?v=1', {
		headers: { cookie: 'cp_staff_nav=1; cp_staff_session=private-token' },
	});
	assert.equal(anonymous.status, 200);
	assert.equal(anonymous.headers.get('cache-control'), revalidate);
	assert.equal(anonymous.headers.get('vary'), null);
	const html = await anonymous.text();
	assert.equal(await staff.text(), html);
	assert.ok(html.includes('id="file-editors"'));
	assert.ok(html.includes(`src="${assetUrl('/app.js')}"`));
	assert.ok(html.includes('<script type="importmap">'));
	assert.doesNotMatch(html, /private-token|data-app-shell|data-cp-code|\/admin\//);
	assert.equal(await (await mf.dispatchFetch('https://cp.codes/new-shell', { method: 'HEAD' })).text(), '');
	assert.equal((await mf.dispatchFetch('https://cp.codes/new-shell', { method: 'POST' })).status, 405);
});

test('current versions and pinned vendors receive a year of immutable caching', () => {
	for (const path of [...Object.keys(CLIENT_ASSET_VERSIONS).map(assetUrl),
		'/lib/uqr-0.1.2.js', '/lib/markdown-it-14.1.0.js', '/lib/hash-wasm-4.12.0.js', ...editorManifest.files]) {
		for (const status of [200, 304]) {
			const response = withAssetCachePolicy(new Request(`https://cp.codes${path}`),
				new Response(null, { status, headers: { etag: '"asset"', 'content-type': 'text/javascript' } }));
			assert.equal(response.headers.get('cache-control'), immutable, path);
			assert.equal(response.headers.get('etag'), '"asset"');
			assert.equal(response.status, status);
		}
	}
});

test('unversioned, old, duplicate and unknown asset versions revalidate', () => {
	for (const path of ['/sw.js', '/app.js', '/app.js?v=old', `${assetUrl('/app.js')}&v=old`, '/unknown.js?v=1']) {
		const response = withAssetCachePolicy(new Request(`https://cp.codes${path}`), new Response('asset'));
		assert.equal(response.headers.get('cache-control'), revalidate, path);
	}
});

test('offline entry shell is generic, does not authenticate, and contains no paste or staff data', async () => {
	const anonymous = await mf.dispatchFetch('https://cp.codes/app-shell?v=1');
	const staff = await mf.dispatchFetch('https://cp.codes/app-shell?v=1', {
		headers: { cookie: 'cp_staff_nav=1; cp_staff_session=private-token' },
	});
	assert.equal(anonymous.status, 200);
	assert.equal(anonymous.headers.get('cache-control'), revalidate);
	const html = await anonymous.text();
	assert.equal(await staff.text(), html);
	assert.ok(html.includes('data-app-shell'));
	assert.ok(html.includes(`src="${assetUrl('/navigation.js')}"`));
	assert.doesNotMatch(html, /private-token|data-cp-code|\/admin\/|name="action"/);
	const head = await mf.dispatchFetch('https://cp.codes/app-shell', { method: 'HEAD' });
	assert.equal(head.status, 200);
	assert.equal(await head.text(), '');
	const post = await mf.dispatchFetch('https://cp.codes/app-shell', { method: 'POST' });
	assert.equal(post.status, 405);
});

test('development hosts use immutable caching for current versions and pinned libraries', () => {
	for (const host of ['localhost:8787', '127.0.0.1:8787', '127.0.0.2:8787', '[::1]:8787', 'dev.localhost:8787']) {
		for (const path of [assetUrl('/app.js'), '/lib/hash-wasm-4.12.0.js']) {
			const response = withAssetCachePolicy(new Request(`http://${host}${path}`), new Response('asset'));
			assert.equal(response.headers.get('cache-control'), immutable);
		}
	}
});

test('redirects and missing assets never gain an immutable policy', () => {
	for (const status of [302, 404, 500]) {
		const response = new Response(null, { status, headers: { 'cache-control': 'no-store' } });
		assert.equal(withAssetCachePolicy(new Request(`https://cp.codes${assetUrl('/app.js')}`), response), response);
	}
});

let mf;
before(async () => {
	const worker = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false,
		format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
	mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: worker.outputFiles[0].text,
		compatibilityDate: '2026-09-05', serviceBindings: { ASSETS: async request => {
			return new Response(request.method === 'HEAD' ? null : 'export const asset = true;', {
				headers: { 'content-type': 'text/javascript', etag: '"test-asset"', 'cache-control': revalidate },
			});
		} },
	}));
});
after(async () => { await mf?.dispose(); });

test('Worker applies the policy through both asset routes for GET and HEAD', async () => {
	for (const origin of ['https://cp.codes', 'http://localhost:8787']) {
		for (const path of [assetUrl('/app.js'), assetUrl('/view_dialogs.js'), '/lib/markdown-it-14.1.0.js', editorManifest.imports['@codemirror/view']]) {
			for (const method of ['GET', 'HEAD']) {
				const response = await mf.dispatchFetch(`${origin}${path}`, { method });
				assert.equal(response.status, 200);
				assert.equal(response.headers.get('cache-control'), immutable);
				assert.equal(response.headers.get('etag'), '"test-asset"');
				assert.equal(await response.text(), method === 'HEAD' ? '' : 'export const asset = true;');
			}
		}
	}
});

test('application HTML stays private and uses registry versions', async () => {
	const response = await mf.dispatchFetch('https://cp.codes/new');
	assert.equal(response.headers.get('cache-control'), 'no-store, private');
	const html = await response.text();
	assert.ok(html.includes(`src="${assetUrl('/app.js')}"`));
	assert.ok(html.includes(`<link rel="stylesheet" href="${assetUrl('/style.css')}" />`));
	assert.ok(html.includes(`<script src="${assetUrl('/site.js')}"></script>`));
	assert.doesNotMatch(html, /data-site-style|data-site-script/);
	const importMap = JSON.parse(html.match(/<script type="importmap">(.*?)<\/script>/s)[1]);
	assert.deepEqual(importMap.imports, editorManifest.imports);
	assert.ok(Object.values(importMap.imports).every(path => path.startsWith('/lib/codemirror/')));
	assert.ok(html.includes(`<script type="module" src="${assetUrl('/app.js')}"></script>`));
	const firstKilobyte = Buffer.from(html).subarray(0, 1024).toString();
	const sitePosition = html.indexOf('<script src="/site.js?');
	const stylePosition = html.indexOf('<link rel="stylesheet" href="/style.css?');
	assert.ok(html.indexOf('rel="modulepreload"') < stylePosition && stylePosition < html.indexOf('</head>'));
	assert.ok(sitePosition > html.indexOf('<header>') && sitePosition < html.indexOf(`src="${assetUrl('/app.js')}"`));
	for (const path of ['/content_type.js', '/files.js', '/policy.js']) {
		assert.ok(firstKilobyte.includes(`<link rel="modulepreload" href="${assetUrl(path)}" />`), `${path} preload appears in the first kilobyte`);
	}
	assert.doesNotMatch(html, /rel="modulepreload"[^>]*(?:authorization|wordlist|media|markdown|highlight|qr_text)\.js/);
	assert.ok(html.includes("localStorage.getItem('cp.codes.theme') || 'light'"));
	assert.doesNotMatch(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, ''), /theme-toggle|theme-icon-sun|theme-icon-moon/);
});
