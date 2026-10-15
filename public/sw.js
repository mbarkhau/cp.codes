/** Only public application navigations and versioned shell assets are intercepted. */
import { CACHE_VERSION, SHELL_URL, COMPOSER_URL, ABOUT_URL, EDITOR_MANIFEST_URL, SHELL_ASSETS } from './offline_assets.js?v=38';

const PREFIX = 'cp.codes.shell.';
const CACHE_NAME = PREFIX + CACHE_VERSION;
const assets = new Set(SHELL_ASSETS);
const assetPaths = new Set(SHELL_ASSETS.map(asset => new URL(asset, self.location.origin).pathname));

self.addEventListener('install', event => {
	// Switch only after the entire new shell is available, including when an old
	// worker is still controlling open tabs. A failed install keeps that worker.
	event.waitUntil((async () => {
		const existed = (await caches.keys()).includes(CACHE_NAME);
		const cache = await caches.open(CACHE_NAME);
		try {
			await cache.addAll([SHELL_URL, COMPOSER_URL, ABOUT_URL, ...SHELL_ASSETS]);
			const manifest = await (await cache.match(EDITOR_MANIFEST_URL)).json();
			if (!Array.isArray(manifest.files) || !manifest.files.length ||
				manifest.files.some(path => typeof path !== 'string' || !/^\/lib\/codemirror\/[^?#]+\.js$/.test(path)) ||
				!Array.isArray(manifest.precache) || !manifest.precache.length ||
				manifest.precache.some(path => !manifest.files.includes(path))) {
				throw new Error('Invalid editor asset manifest');
			}
			// Other grammars are downloaded and cached only when the editor uses them.
			await cache.addAll(manifest.precache);
		} catch (error) {
			// Do not leave an empty generation that a later update could retain
			// instead of the last complete shell. Never delete an existing cache.
			if (!existed) await caches.delete(CACHE_NAME);
			throw error;
		}
		await self.skipWaiting();
	})());
});

self.addEventListener('activate', event => {
	event.waitUntil((async () => {
		const previous = (await caches.keys()).filter(name => name.startsWith(PREFIX) && name !== CACHE_NAME);
		const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
		// Keep the previous assets during the switch. Pages with unsaved work are
		// not reloaded, so retain their older dependencies until a later update.
		if (clients.every(client => appNavigation(new URL(client.url)))) {
			for (const name of previous.slice(0, -1)) await caches.delete(name);
		}
		await self.clients.claim();
		if (previous.length) {
			for (const client of clients) {
				if (!appNavigation(new URL(client.url))) continue;
				// Dispatch without awaiting: the navigation's fetch waits for this
				// activate event to finish. Also upgrades pages running older JS.
				client.navigate(client.url).catch(() => {});
			}
		}
	})());
});

function appNavigation(url) {
	const path = url.pathname.replace(/\/+$/, '');
	if (aboutNavigation(url)) return true;
	if (path === '/pastes') return [...url.searchParams.keys()].every(key => key === 'page' || key === 'q');
	return !url.search && /^\/CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10})$/.test(path);
}

function aboutNavigation(url) {
	return !url.search && url.pathname.replace(/\/+$/, '') === '/about';
}

function composerNavigation(url) {
	const path = url.pathname.replace(/\/+$/, '');
	return !url.search && ['', '/new', '/index.html'].includes(path);
}

self.addEventListener('fetch', event => {
	const request = event.request;
	const url = new URL(request.url);
	if (request.method !== 'GET' || url.origin !== self.location.origin) return;
	const composer = request.mode === 'navigate' && composerNavigation(url);
	const about = request.mode === 'navigate' && aboutNavigation(url);
	const navigation = request.mode === 'navigate' && (composer || appNavigation(url));
	const currentAsset = assets.has(url.pathname + url.search);
	const previousAsset = assetPaths.has(url.pathname) && url.searchParams.has('v') &&
		[...url.searchParams.keys()].length === 1;
	const editorAsset = !url.search && /^\/lib\/codemirror\/[^?#]+\.js$/.test(url.pathname);
	if (!navigation && !currentAsset && !previousAsset && !editorAsset) return;
	event.respondWith((async () => {
		const cache = await caches.open(CACHE_NAME);
		const shell = composer ? COMPOSER_URL : about ? ABOUT_URL : SHELL_URL;
		const cached = await cache.match(navigation ? shell : request);
		if (cached) return cached;
		if (previousAsset || editorAsset) {
			for (const name of (await caches.keys()).reverse()) {
				if (!name.startsWith(PREFIX) || name === CACHE_NAME) continue;
				const oldAsset = await (await caches.open(name)).match(request);
				if (oldAsset) return oldAsset;
			}
		}
		const response = await fetch(request);
		if (editorAsset && response.ok) {
			// Keep a downloaded grammar available offline. Storage failure must not
			// prevent the editor from using a successful network response.
			event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
		}
		return response;
	})());
});
