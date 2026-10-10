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

test('every application JS/CSS asset has one version and all client references agree', async () => {
	for (const file of await readdir('public')) {
		if (!/\.(js|css)$/.test(file)) continue;
		assert.ok(CLIENT_ASSET_VERSIONS[`/${file}`], `Missing version: ${file}`);
		if (!file.endsWith('.js')) continue;
		const source = await readFile(`public/${file}`, 'utf8');
		for (const match of source.matchAll(/(['"])((?:\/|\.\/)[^'"\s]+\.(?:js|css)(?:\?[^'"\s]*)?)\1/g)) {
			const url = new URL(match[2], `https://cp.codes/${file}`);
			if (url.pathname.startsWith('/lib/')) continue;
			assert.equal(url.pathname + url.search, assetUrl(url.pathname), `${file}: ${match[2]}`);
		}
	}
});

test('current versions and pinned vendors receive a year of immutable caching', () => {
	for (const path of [...Object.keys(CLIENT_ASSET_VERSIONS).map(assetUrl),
		'/lib/uqr-0.1.2.js', '/lib/markdown-it-14.1.0.js', '/lib/hash-wasm-4.12.0.js']) {
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
	for (const path of ['/app.js', '/app.js?v=old', `${assetUrl('/app.js')}&v=old`, '/unknown.js?v=1']) {
		const response = withAssetCachePolicy(new Request(`https://cp.codes${path}`), new Response('asset'));
		assert.equal(response.headers.get('cache-control'), revalidate, path);
	}
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
		for (const path of [assetUrl('/app.js'), assetUrl('/wordlist.js'), '/lib/markdown-it-14.1.0.js']) {
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
	assert.ok(html.includes(`href="${assetUrl('/style.css')}"`));
	assert.ok(html.includes(`<script type="module" src="${assetUrl('/theme.js')}" blocking="render"></script>`));
	const firstKilobyte = Buffer.from(html).subarray(0, 1024).toString();
	const themePosition = html.indexOf(`src="${assetUrl('/theme.js')}"`);
	const stylePosition = html.indexOf(`href="${assetUrl('/style.css')}"`);
	assert.ok(themePosition < stylePosition && stylePosition < html.indexOf('rel="modulepreload"'));
	for (const path of ['/authorization.js', '/content_type.js', '/media.js', '/files.js', '/policy.js', '/wordlist.js']) {
		assert.ok(firstKilobyte.includes(`<link rel="modulepreload" href="${assetUrl(path)}" />`), `${path} preload appears in the first kilobyte`);
	}
	assert.doesNotMatch(html, /cp\.codes\.theme/);
	assert.doesNotMatch(html, /theme-toggle|theme-icon-sun|theme-icon-moon/);
});
