import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { CACHE_VERSION, SHELL_URL, COMPOSER_URL, ABOUT_URL, EDITOR_MANIFEST_URL, SHELL_ASSETS } from '../public/offline_assets.js';
import { eligiblePaste, savePasteSnapshot } from '../public/offline.js';

const compiled = await build({ entryPoints: ['public/sw.js'], bundle: true, write: false, format: 'iife' });
const editorManifest = JSON.parse(await readFile('public/lib/codemirror/manifest.json', 'utf8'));
function serviceWorker({ windows = ['/CP000001', '/pastes?page=2#file-note.txt'] } = {}) {
	const handlers = new Map(), matches = [], fetched = [], removed = [], navigated = [];
	const stores = new Map([[`cp.codes.shell.${CACHE_VERSION}`, new Map([[SHELL_URL, new Response('generic shell')], [COMPOSER_URL, new Response('composer shell')], [ABOUT_URL, new Response('about shell')]])],
		['cp.codes.shell.ancient', new Map()], ['cp.codes.shell.old', new Map()], ['unrelated-cache', new Map()]]);
	let claimed = false, skippedWaiting = false, failInstall = false, failEditorInstall = false, failPut = false, networkStatus = 200;
	const caches = {
		keys: async () => [...stores.keys()],
		delete: async name => { removed.push(name); return stores.delete(name); },
		open: async name => {
			if (!stores.has(name)) stores.set(name, new Map());
			return {
				match: async request => {
					const key = typeof request === 'string' ? request : new URL(request.url).pathname + new URL(request.url).search;
					matches.push(key); return stores.get(name).get(key)?.clone();
				},
				put: async (request, response) => {
					if (failPut) throw new Error('Cache storage full');
					const url = new URL(request.url);
					stores.get(name).set(url.pathname + url.search, response.clone());
				},
				addAll: async urls => {
					if (failInstall || (failEditorInstall && urls.some(url => editorManifest.files.includes(url)))) throw new Error('Asset unavailable');
					for (const url of urls) stores.get(name).set(url, new Response(url === SHELL_URL ? 'generic shell' :
						url === COMPOSER_URL ? 'composer shell' : url === ABOUT_URL ? 'about shell' : url === EDITOR_MANIFEST_URL ? JSON.stringify(editorManifest) : 'asset'));
				},
			};
		},
	};
	vm.runInNewContext(compiled.outputFiles[0].text, { URL, caches,
		fetch: async request => { fetched.push(request.url); return new Response('network', { status: networkStatus }); },
		self: { location: { origin: 'https://cp.codes' }, skipWaiting: async () => { skippedWaiting = true; },
			clients: { claim: async () => { claimed = true; }, matchAll: async () => windows.map(path => ({
				url: new URL(path, 'https://cp.codes').href,
				navigate: async url => { assert.equal(claimed, true); navigated.push(url); },
			})) },
			addEventListener: (name, handler) => handlers.set(name, handler) },
	});
	return { stores, matches, fetched, removed, navigated, get claimed() { return claimed; },
		get skippedWaiting() { return skippedWaiting; },
		failInstall() { failInstall = true; },
		failEditorInstall() { failEditorInstall = true; },
		failPut() { failPut = true; },
		setNetworkStatus(status) { networkStatus = status; },
		lifecycle(name) { let promise; handlers.get(name)({ waitUntil: value => { promise = value; } }); return promise; },
		fetch(path, { method = 'GET', mode = 'navigate' } = {}) {
			let response;
			const pending = [];
			handlers.get('fetch')({ request: { url: new URL(path, 'https://cp.codes').href, method, mode },
				waitUntil: promise => pending.push(promise), respondWith: promise => { response = promise; } });
			return response?.then(async result => { await Promise.all(pending); return result; });
		},
	};
}

test('public document entry uses one generic shell and never fetches paste HTML', async () => {
	const sw = serviceWorker();
	for (const path of ['/CP00X1K1', '/CP000001/', '/CP0123456789', '/pastes', '/pastes/?page=2', '/pastes?q=CP00', '/pastes?page=2&q=CP00']) {
		assert.equal(await (await sw.fetch(path)).text(), 'generic shell', path);
	}
	assert.deepEqual(sw.fetched, []);
	assert.ok(sw.matches.every(key => key === SHELL_URL));
});

test('API, staff, raw, authentication, mutations and unsupported routes bypass the worker', () => {
	const sw = serviceWorker();
	for (const path of ['/api/paste/CP000001', '/api/paste/CP000001/content', '/admin/paste/CP000001/view',
		'/CP000001.txt', '/login', '/logout', '/client-info', '/?staff=1', '/new?staff=1', '/about?staff=1', '/pastes?limit=40', '/CP000001?staff=1',
		'/CP000001a-long-invalid-id', 'https://elsewhere.example/CP000001']) assert.equal(sw.fetch(path), undefined, path);
	assert.equal(sw.fetch('/CP000001', { method: 'POST' }), undefined);
	assert.equal(sw.fetch('/CP000001', { method: 'HEAD' }), undefined);
	assert.equal(sw.fetch('/CP000001', { mode: 'cors' }), undefined);
	assert.deepEqual(sw.matches, []);
});

test('root and new-page aliases load the separate local composer shell', async () => {
	const sw = serviceWorker();
	for (const path of ['/', '/new', '/new/', '/index.html']) {
		assert.equal(await (await sw.fetch(path)).text(), 'composer shell', path);
	}
	assert.deepEqual(sw.fetched, []);
	assert.ok(sw.matches.every(key => key === COMPOSER_URL));
	assert.equal(sw.fetch('/', { method: 'POST' }), undefined);
});

test('about entry and section links use the cached static page without fetching HTML', async () => {
	const sw = serviceWorker();
	for (const path of ['/about', '/about/', '/about#service-providers']) {
		assert.equal(await (await sw.fetch(path)).text(), 'about shell', path);
	}
	assert.deepEqual(sw.fetched, []);
	assert.ok(sw.matches.every(key => key === ABOUT_URL));
	assert.equal(sw.fetch('/about', { method: 'POST' }), undefined);
});

test('only exact manifest assets are cached; a missing entry falls back to the network', async () => {
	const sw = serviceWorker();
	await sw.lifecycle('install');
	for (const path of [...SHELL_ASSETS, ...editorManifest.precache]) {
		const response = await sw.fetch(path, { mode: 'cors' });
		if (path === EDITOR_MANIFEST_URL) assert.deepEqual(await response.json(), editorManifest);
		else assert.equal(await response.text(), 'asset', path);
	}
	assert.equal(await (await sw.fetch('/view.js?v=old', { mode: 'cors' })).text(), 'network');
	const [asset] = SHELL_ASSETS;
	sw.stores.get(`cp.codes.shell.${CACHE_VERSION}`).delete(asset);
	assert.equal(await (await sw.fetch(asset, { mode: 'cors' })).text(), 'network');
	assert.equal(sw.fetched.length, 2);
});

test('non-default grammars are downloaded on demand and cached for subsequent offline use', async () => {
	const sw = serviceWorker();
	await sw.lifecycle('install');
	const cache = sw.stores.get(`cp.codes.shell.${CACHE_VERSION}`);
	const deferred = editorManifest.files.filter(path => !editorManifest.precache.includes(path));
	assert.ok(deferred.length);
	for (const path of deferred) assert.equal(cache.has(path), false, path);
	const path = editorManifest.imports['@codemirror/lang-rust'];
	assert.equal(await (await sw.fetch(path, { mode: 'cors' })).text(), 'network');
	assert.equal(cache.has(path), true);
	sw.setNetworkStatus(503);
	assert.equal(await (await sw.fetch(path, { mode: 'cors' })).text(), 'network');
	assert.deepEqual(sw.fetched, [`https://cp.codes${path}`]);
});

test('failed grammar downloads are not cached and storage failures do not block successful loads', async () => {
	const sw = serviceWorker();
	await sw.lifecycle('install');
	const cache = sw.stores.get(`cp.codes.shell.${CACHE_VERSION}`);
	const path = editorManifest.imports['@codemirror/lang-rust'];
	sw.setNetworkStatus(503);
	assert.equal((await sw.fetch(path, { mode: 'cors' })).status, 503);
	assert.equal(cache.has(path), false);
	sw.setNetworkStatus(200); sw.failPut();
	assert.equal((await sw.fetch(path, { mode: 'cors' })).status, 200);
	assert.equal(cache.has(path), false);
});

test('complete installation immediately requests activation', async () => {
	const sw = serviceWorker();
	await sw.lifecycle('install');
	assert.equal(sw.skippedWaiting, true);
});

test('activation reloads public windows and retains the previous generation for the switch', async () => {
	const sw = serviceWorker({ windows: ['/CP000001', '/pastes?page=2#file-note.txt', '/about#service-providers'] });
	await sw.lifecycle('activate');
	assert.deepEqual(sw.removed, ['cp.codes.shell.ancient']);
	assert.ok(sw.stores.has('cp.codes.shell.old'));
	assert.ok(sw.stores.has('unrelated-cache'));
	assert.equal(sw.claimed, true);
	assert.deepEqual(sw.navigated, ['https://cp.codes/CP000001', 'https://cp.codes/pastes?page=2#file-note.txt', 'https://cp.codes/about#service-providers']);
});

test('first installation claims windows without reloading them', async () => {
	const sw = serviceWorker();
	sw.stores.delete('cp.codes.shell.old'); sw.stores.delete('cp.codes.shell.ancient');
	await sw.lifecycle('activate');
	assert.equal(sw.claimed, true);
	assert.deepEqual(sw.navigated, []);
});

test('editor/staff windows keep their document and older exact assets', async () => {
	const sw = serviceWorker({ windows: ['/CP000001', '/', '/admin/paste/CP000001/view', '/CP000001?staff=1'] });
	sw.stores.get('cp.codes.shell.ancient').set('/view.js?v=old', new Response('old viewer'));
	await sw.lifecycle('activate');
	assert.deepEqual(sw.removed, []);
	assert.deepEqual(sw.navigated, ['https://cp.codes/CP000001']);
	assert.equal(await (await sw.fetch('/view.js?v=old', { mode: 'cors' })).text(), 'old viewer');
	assert.deepEqual(sw.fetched, []);
});

test('incomplete installation fails without removing the previous shell or claiming clients', async () => {
	const sw = serviceWorker(); sw.failInstall();
	await assert.rejects(sw.lifecycle('install'), /Asset unavailable/);
	assert.deepEqual(sw.removed, []);
	assert.equal(sw.claimed, false);
	assert.equal(sw.skippedWaiting, false);
	assert.ok(sw.stores.has('cp.codes.shell.old'));
});

test('a failed new generation is removed without touching the last working shell', async () => {
	const sw = serviceWorker();
	sw.stores.delete(`cp.codes.shell.${CACHE_VERSION}`); sw.failInstall();
	await assert.rejects(sw.lifecycle('install'), /Asset unavailable/);
	assert.deepEqual(sw.removed, [`cp.codes.shell.${CACHE_VERSION}`]);
	assert.ok(sw.stores.has('cp.codes.shell.old'));
	assert.equal(sw.skippedWaiting, false);
});

test('a missing editor dependency prevents activation and removes the partial new shell', async () => {
	const sw = serviceWorker();
	sw.stores.delete(`cp.codes.shell.${CACHE_VERSION}`); sw.failEditorInstall();
	await assert.rejects(sw.lifecycle('install'), /Asset unavailable/);
	assert.deepEqual(sw.removed, [`cp.codes.shell.${CACHE_VERSION}`]);
	assert.ok(sw.stores.has('cp.codes.shell.old'));
	assert.equal(sw.skippedWaiting, false);
});

const approved = { offline_cacheable: true, staff_review: false, moderation: { state: 'approved' },
	format: 'single', content_type: 'plaintext', byte_length: 5, sha256: 'a'.repeat(64), content_encoding: 'gzip' };
test('only bounded, human-approved public viewer copies are eligible', () => {
	assert.equal(eligiblePaste(approved), true);
	for (const change of [{ offline_cacheable: false }, { staff_review: true }, { moderation: { state: 'limited' } },
		{ content_type: 'url' }, { byte_length: 0 }, { byte_length: 8 * 1024 * 1024 + 1 }, { sha256: '' }, { content_encoding: 'br' }]) {
		assert.equal(eligiblePaste({ ...approved, ...change }), false, JSON.stringify(change));
	}
	assert.equal(eligiblePaste(null), false);
});

test('a no-store or failed content response is never persisted', async () => {
	assert.equal(await savePasteSnapshot(approved, new Response('Hello', { headers: { 'cache-control': 'no-store' } })), false);
	assert.equal(await savePasteSnapshot(approved, new Response('Hello', { status: 423 })), false);
});
