// Browser integration using real Worker routes and browser assets with local storage fixtures.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const editorManifest = JSON.parse(await readFile('public/lib/codemirror/manifest.json', 'utf8'));
const compiled = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', plugins: [{
	name: 'workers-stub', setup(build) {
		build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}' }));
	},
}] });
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const fixtures = new Map();
const denied = new Set();
const requests = [];
const held = new Map();
const publicRoot = resolve('public');
let origin;

function paste(number, content, extra = {}) {
	const id = `CP${String(number).padStart(6, '0')}`;
	const bytes = Buffer.from(content), body = gzipSync(bytes);
	const metadata = {
		id, created_at: '2026-10-11T00:00:00Z', content_type: 'plaintext', filename: `note${number}.txt`,
		byte_length: bytes.length, compressed_byte_length: body.length, content_encoding: 'gzip',
		sha256: createHash('sha256').update(bytes).digest('hex'), unlisted: false, region_id: 0, region: null,
		upload_metadata: { 'cf-connecting-ip': 'private-audit-marker' }, proof_of_work: null, ...extra,
	};
	fixtures.set(id, { metadata, body });
	return id;
}

const first = paste(1, 'First paste');
const bundleFiles = [
	{ name: 'readme.md', content_type: 'markdown', content: '# Bundle\n\n[Note](note.txt)' },
	{ name: 'note.txt', content_type: 'plaintext', content: 'Second file' },
];
const second = paste(2, JSON.stringify({ format: 'bundle-v1', primary: 'readme.md', files: bundleFiles }), {
	format: 'bundle-v1', primary: 'readme.md', filename: 'readme.md', content_type: 'markdown',
	files: bundleFiles.map(file => ({ name: file.name, content_type: file.content_type, byte_length: Buffer.byteLength(file.content),
		sha256: createHash('sha256').update(file.content).digest('hex') })),
});
const slow = paste(3, 'Old response must not replace the current page');
const blocked = paste(5, 'Blocked paste');
denied.add(blocked);
const corrupt = paste(6, 'Corrupt body', { sha256: '0'.repeat(64) });
const identity = paste(7, 'Legacy identity body', { content_encoding: 'identity', compressed_byte_length: 20 });
fixtures.get(identity).body = Buffer.from('Legacy identity body');

const row = id => {
	const { upload_metadata, proof_of_work, unlisted, ...metadata } = fixtures.get(id).metadata;
	return { ...metadata, hit_count: 7, pow_difficulty: null, preview: '' };
};
const index = {
	getReadState: async id => ({ moderation: { paste_id: id, visibility: denied.has(id) && id !== blocked ? 'hidden' : 'visible', decision: 'approved' }, hit_count: 7 }),
	getRetainedPaste: async id => fixtures.has(id) ? { metadata: fixtures.get(id).metadata } : null,
	authorizeAccess: async id => ({ allowed: fixtures.has(id) && !denied.has(id), state: denied.has(id) ? 'review_required' : 'approved', reason: 'Held for review' }),
	getSharing: async () => ({ escalated: null, recipients: 0, requests: 0, bytes: 0 }),
	completeRead: async () => {},
	listPublicPage: async (requested, q = '') => {
		if (q && q !== 'CP') {
			const matches = [...fixtures.keys()].filter(id => id.startsWith(q));
			return { items: matches.map(row), page: 1, page_size: 50, total: matches.length, total_pages: 1, q };
		}
		const page = Math.min(requested, 2);
		return { items: (page === 1 ? [first, second, slow, blocked, corrupt, identity, 'CP000004'] : [identity]).map(row),
			page, page_size: 50, total: 51, total_pages: 2, ...(q ? { q } : {}) };
	},
};
const env = {
	PASTE_INDEX: { getByName: () => index },
	PASTES: {
		head: async key => fixtures.has(key.split('/').at(-1)) ? { customMetadata: {}, size: fixtures.get(key.split('/').at(-1)).body.length, uploaded: new Date() } : null,
		get: async key => fixtures.has(key.split('/').at(-1)) ? { customMetadata: {}, size: fixtures.get(key.split('/').at(-1)).body.length, uploaded: new Date(), body: new Response(fixtures.get(key.split('/').at(-1)).body).body } : null,
	},
};
const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url, origin);
		requests.push(url.pathname + url.search);
		const gate = held.get(url.pathname + url.search) || held.get(url.pathname);
		if (gate) await gate.promise;
		if (request.destroyed) return;
		if (extname(url.pathname) && !url.pathname.startsWith('/api/')) {
			const path = resolve(publicRoot, '.' + decodeURIComponent(url.pathname));
			if (!path.startsWith(publicRoot + '/')) throw new Error('Invalid asset path');
			response.writeHead(200, { 'content-type': ({ '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' })[extname(path)] || 'application/octet-stream',
				'cache-control': 'public, max-age=31536000, immutable' });
			response.end(await readFile(path)); return;
		}
		const pending = [];
		const result = await worker.fetch(new Request(url, { headers: request.headers }), env, { waitUntil: promise => pending.push(promise) });
		response.writeHead(result.status, Object.fromEntries(result.headers));
		response.end(Buffer.from(await result.arrayBuffer()));
		await Promise.all(pending);
	} catch (error) { response.writeHead(500); response.end(error.message); }
});

function hold(path) {
	let release;
	const promise = new Promise(resolve => { release = resolve; });
	held.set(path, { promise, release });
	return () => { held.delete(path); release(); };
}

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
paste(4, origin + '/about', { content_type: 'url', filename: null });
let browser;
try {
	browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
	// Isolate controlled timer checks from the normal navigation/offline profile.
	const filterContext = await browser.newContext();
	const filterPage = await filterContext.newPage();
	await filterPage.clock.install({ time: new Date() });
	await filterPage.goto(origin + '/pastes');
	await filterPage.waitForFunction(() => document.documentElement.dataset.navigationReady === 'true');
	await filterPage.clock.pauseAt(await filterPage.evaluate(() => Date.now() + 1000));
	const focusedId = () => filterPage.evaluate(() => document.activeElement?.classList.contains('recent-id') ? document.activeElement.textContent : null);
	assert.equal(await focusedId(), first, 'the archive defaults to its first paste');
	await filterPage.keyboard.press('k');
	assert.equal(await focusedId(), first, 'k at the first paste does not wrap');
	await filterPage.keyboard.press('j');
	assert.equal(await focusedId(), second);
	await filterPage.keyboard.press('k');
	assert.equal(await focusedId(), first);
	for (let step = 0; step < 10; step++) await filterPage.keyboard.press('j');
	assert.equal(await focusedId(), 'CP000004', 'j stops at the last paste');
	await filterPage.keyboard.press('k');
	assert.equal(await focusedId(), identity);
	await filterPage.keyboard.press('/');
	assert.equal(await filterPage.evaluate(() => document.activeElement.id), 'paste-id-search');
	assert.equal(await filterPage.locator('#paste-id-search').inputValue(), '', 'the shortcut does not type a slash');
	await filterPage.keyboard.type('jk');
	assert.equal(await filterPage.locator('#paste-id-search').inputValue(), 'jk', 'j/k remain normal characters in search');
	await filterPage.locator('#paste-id-search').fill('');
	const keyboardStart = requests.length;
	await filterPage.keyboard.press('Enter');
	assert.equal(await focusedId(), first, 'Enter in an unchanged search focuses its first paste immediately');
	await filterPage.clock.runFor(500);
	assert.ok(!requests.slice(keyboardStart).some(path => path.startsWith('/api/pastes?')), 'an unchanged query does not need another request');
	const archiveRequests = since => requests.slice(since).filter(path => path.startsWith('/api/pastes?'));
	const setSearch = async value => filterPage.evaluate(value => {
		const input = document.getElementById('paste-id-search');
		input.focus(); input.value = value; input.dispatchEvent(new InputEvent('input', { bubbles: true }));
	}, value);
	const shownIds = () => filterPage.locator('.recent-id').allTextContents();
	const waitForIds = expected => assertEventually(async () => JSON.stringify(await shownIds()) === JSON.stringify(expected));
	let filterStart = requests.length;
	await setSearch('CP0000');
	await filterPage.clock.runFor(400);
	assert.deepEqual(archiveRequests(filterStart), []);
	await setSearch(first.toLowerCase());
	await filterPage.evaluate(() => {
		window.originalSearchInput = document.getElementById('paste-id-search');
		window.originalSearchInput.setSelectionRange(3, 3);
	});
	await filterPage.clock.runFor(499);
	assert.deepEqual(archiveRequests(filterStart), [], 'each keystroke restarts the full 500 ms delay');
	await filterPage.clock.runFor(1);
	await waitForIds([first]);
	assert.deepEqual(archiveRequests(filterStart), [`/api/pastes?page=1&q=${first}`]);
	assert.deepEqual(await filterPage.evaluate(() => {
		const input = document.getElementById('paste-id-search');
		return { same: input === window.originalSearchInput, focused: document.activeElement === input,
			value: input.value, selection: input.selectionStart };
	}), { same: true, focused: true, value: first.toLowerCase(), selection: 3 });

	const releaseSearch = hold(`/api/pastes?page=1&q=${corrupt}`);
	await setSearch(corrupt);
	await filterPage.clock.runFor(500);
	await assertEventually(() => requests.includes(`/api/pastes?page=1&q=${corrupt}`));
	await setSearch(second);
	await filterPage.clock.runFor(500);
	await waitForIds([second]);
	releaseSearch();
	await new Promise(resolve => setTimeout(resolve, 50));
	assert.deepEqual(await shownIds(), [second], 'a response for an older draft must not replace the latest results');
	assert.equal(await filterPage.locator('#paste-id-search').inputValue(), second);

	filterStart = requests.length;
	await setSearch('');
	await filterPage.clock.runFor(499);
	assert.deepEqual(archiveRequests(filterStart), []);
	await filterPage.clock.runFor(1);
	await assertEventually(async () => (await shownIds()).length > 1);
	assert.equal(new URL(filterPage.url()).search, '');
	assert.deepEqual(archiveRequests(filterStart), ['/api/pastes?page=1']);

	filterStart = requests.length;
	await filterPage.evaluate(id => {
		const input = document.getElementById('paste-id-search');
		input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
		input.value = id;
		input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
	}, first);
	await filterPage.clock.runFor(1000);
	assert.deepEqual(archiveRequests(filterStart), [], 'composition does not issue a partial query');
	await filterPage.evaluate(() => document.getElementById('paste-id-search').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
	await filterPage.clock.runFor(499);
	assert.deepEqual(archiveRequests(filterStart), []);
	await filterPage.clock.runFor(1);
	await waitForIds([first]);
	await assertEventually(() => archiveRequests(filterStart).length === 1);
	const liveUrl = filterPage.url();
	await filterPage.evaluate(() => document.querySelector('.recent-id').click());
	await assertEventually(() => new URL(filterPage.url()).pathname === `/${first}`);
	await filterPage.goBack();
	await waitForIds([first]);
	assert.equal(filterPage.url(), liveUrl);
	assert.equal(await filterPage.locator('#paste-id-search').inputValue(), first, 'Back restores the applied live query as well as its results');

	filterStart = requests.length;
	await setSearch(second);
	await filterPage.locator('#paste-id-search').press('Enter');
	await waitForIds([second]);
	await assertEventually(() => archiveRequests(filterStart).length === 1);
	await filterPage.clock.runFor(500);
	assert.deepEqual(archiveRequests(filterStart), [`/api/pastes?page=1&q=${second}`], 'Enter searches immediately and cancels the pending timer');
	assert.equal(await focusedId(), second, 'Enter in a pending search focuses the first filtered paste');
	await filterPage.keyboard.press('j');
	await filterPage.keyboard.press('k');
	assert.equal(await focusedId(), second, 'one-result lists do not wrap');
	await filterPage.keyboard.press('/');
	await setSearch('CPXYZ');
	await filterPage.clock.runFor(500);
	await waitForIds([]);
	await filterPage.keyboard.press('Enter');
	assert.equal(await filterPage.evaluate(() => document.activeElement.id), 'paste-id-search', 'an empty result list keeps search available');
	await setSearch(second);
	await filterPage.keyboard.press('Enter');
	await waitForIds([second]);
	await assertEventually(async () => await focusedId() === second);
	filterStart = requests.length;
	await setSearch('CPXYZ');
	await filterPage.locator('.recent-id').focus();
	await filterPage.keyboard.press('Enter');
	await assertEventually(() => new URL(filterPage.url()).pathname === `/${second}`);
	await filterPage.clock.runFor(500);
	assert.deepEqual(archiveRequests(filterStart), [], 'leaving the archive cancels pending live filtering');
	await filterContext.close();
	console.log('Archive keyboard focus, bounded j/k navigation, slash search, Enter-to-results, empty results and Enter-to-open passed');
	console.log('Live ID filtering waits 500 ms after the last edit, preserves the input, cancels stale work, handles clearing/composition, and keeps Enter immediate');
	const context = await browser.newContext();
	await context.addInitScript(() => {
		window.documentToken = crypto.randomUUID();
		window.copied = [];
		Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => window.copied.push(text) } });
		window.createdUrls = []; window.revokedUrls = [];
		const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
		URL.createObjectURL = blob => { const url = create(blob); window.createdUrls.push(url); return url; };
		URL.revokeObjectURL = url => { window.revokedUrls.push(url); revoke(url); };
	});
	const page = await context.newPage();
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(origin + '/pastes');
	await page.waitForFunction(() => document.documentElement.dataset.navigationReady === 'true');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.waitForFunction(() => !!navigator.serviceWorker.controller);
	const token = await page.evaluate(() => window.documentToken);
	await page.locator('#paste-id-search').fill(first.toLowerCase());
	await page.locator('[data-paste-search] button').click();
	await page.waitForFunction(id => document.querySelector('#paste-id-search')?.value === id && document.querySelectorAll('.recent-id').length === 1, first);
	assert.equal(new URL(page.url()).searchParams.get('q'), first.toLowerCase());
	assert.ok(requests.includes(`/api/pastes?page=1&q=${first}`));
	assert.equal(await page.evaluate(() => window.documentToken), token);
	await page.waitForFunction(async id => !!(await (await import('/offline.js?v=2')).getArchiveSnapshot(1, id)), first);
	await page.goBack();
	await page.waitForFunction(() => document.querySelector('#paste-id-search')?.value === '' && document.querySelectorAll('.recent-id').length > 1);
	await page.goForward();
	await page.waitForFunction(id => document.querySelector('#paste-id-search')?.value === id, first);
	await page.locator('#paste-id-search').fill('CP');
	await page.locator('[data-paste-search] button').click();
	await page.waitForFunction(() => document.querySelector('#paste-id-search')?.value === 'CP');
	await page.locator('a[rel="next"]').first().click();
	await page.waitForFunction(() => document.querySelector('.paste-pagination')?.textContent.includes('Page 2 of 2'));
	assert.equal(new URL(page.url()).searchParams.get('q'), 'CP');
	assert.ok(requests.includes('/api/pastes?page=2&q=CP'));
	await page.locator('[data-paste-search] a').click();
	await page.waitForFunction(() => document.querySelector('#paste-id-search')?.value === '' && document.querySelectorAll('.recent-id').length > 1);
	assert.equal(new URL(page.url()).search, '');
	console.log('ID search submits without reloading, preserves pagination, restores history and clears the query');
	await page.locator('#theme-toggle').click();
	const start = requests.length;
	const release = hold(`/api/paste/${first}`);
	await page.evaluate(id => {
		document.getElementById('page-content').style.minHeight = '2500px';
		scrollTo(0, 500);
		document.querySelector(`a.recent-id[href="/${id}"]`).click();
	}, first);
	await page.waitForFunction(() => document.getElementById('page-content').getAttribute('aria-busy') === 'true');
	// Metadata has not returned, but both API requests must already have arrived.
	await assertEventually(() => requests.slice(start).includes(`/api/paste/${first}`) && requests.slice(start).includes(`/api/paste/${first}/content`));
	assert.ok(!requests.slice(start).includes(`/${first}`));
	release();
	await page.waitForFunction(() => document.getElementById('paste-content')?.getAttribute('aria-busy') === 'false');
	assert.equal(await page.locator('#paste-content').innerText(), 'First paste');
	await page.waitForSelector('#paste-content[data-offline-saved="true"]');
	assert.equal(await page.evaluate(() => window.documentToken), token);
	assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
	assert.equal(await page.locator('#theme-toggle').count(), 1);
	assert.equal(requests.slice(start).filter(path => path === `/api/paste/${first}/content`).length, 1);
	await page.locator('#copy-paste').click();
	assert.equal(await page.evaluate(() => window.copied.at(-1)), 'First paste');
	await page.locator('#open-details').click();
	await page.waitForSelector('#paste-details-dialog[open]');
	assert.ok(await page.locator('#paste-details-dialog').isVisible());
	await page.locator('#paste-details-dialog [data-close-dialog]').click();
	await page.locator('#open-report').click();
	await page.waitForSelector('#report-dialog[open]');
	assert.ok(await page.locator('#report-dialog select option').count() > 1);
	await page.locator('#report-dialog [data-close-dialog]').click();
	console.log('Concurrent metadata/body, verification, clipboard and dialogs passed');

	const beforeBack = requests.length;
	await page.goBack();
	await page.waitForSelector('.recent-list');
	await page.waitForFunction(() => scrollY === 500);
	assert.equal(await page.evaluate(() => window.documentToken), token);
	assert.equal(requests.length, beforeBack, 'archive back navigation should use its snapshot');
	await page.goForward();
	await page.waitForSelector('#paste-content pre');
	await assertEventually(() => requests.slice(beforeBack).includes(`/api/paste/${first}`));
	assert.equal(requests.slice(beforeBack).filter(path => path === `/api/paste/${first}`).length, 1);
	assert.equal(requests.slice(beforeBack).filter(path => path === `/api/paste/${first}/content`).length, 0, 'native HTTP cache should supply the repeated body');
	assert.equal(await page.locator('.paste-dialog').count(), 0);
	await page.evaluate(() => { document.getElementById('page-content').style.minHeight = ''; });
	console.log('Back/forward, dialog disposal and saved body caching passed');

	await page.locator('.site-nav a[href="/pastes"]').click();
	await page.waitForSelector('.recent-list');
	await page.locator(`a.recent-id[href="/${second}"]`).click();
	await page.waitForSelector('#paste-content .markdown-body');
	await page.waitForSelector('#paste-content[data-offline-saved="true"]');
	await page.getByRole('tab', { name: 'note.txt', exact: true }).click();
	assert.equal(await page.locator('#paste-content').innerText(), 'Second file');
	await page.locator('#copy-link').click();
	assert.equal(await page.evaluate(() => window.copied.at(-1)), `${origin}/${second}#file-note.txt`);
	await page.locator('#open-details').click();
	await page.waitForSelector('#paste-details-dialog[open]');
	assert.ok(await page.locator('#paste-details-dialog').innerText().then(text => text.includes('readme.md')));
	await page.locator('#paste-details-dialog [data-close-dialog]').click();
	await page.locator('.site-nav a[href="/pastes"]').click();
	await page.waitForSelector('.recent-list');
	assert.deepEqual(await page.evaluate(() => window.revokedUrls), await page.evaluate(() => window.createdUrls));
	assert.equal(await page.locator('.paste-dialog').count(), 0);
	console.log('Bundle selection, fragments, fresh dialog metadata and attachment disposal passed');

	const releaseSlow = hold(`/api/paste/${slow}`);
	await page.locator(`a.recent-id[href="/${slow}"]`).click();
	await assertEventually(() => requests.includes(`/api/paste/${slow}`));
	await page.locator('.site-nav a[href="/pastes"]').click();
	await page.waitForSelector('.recent-list');
	releaseSlow();
	await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
	assert.equal(await page.locator('#paste-content').count(), 0);
	assert.equal(new URL(page.url()).pathname, '/pastes');
	console.log('Cancelled navigation cannot replace the current page');

	await page.locator('a[rel="next"]').first().click();
	await page.waitForFunction(() => document.querySelector('.paste-pagination')?.textContent.includes('Page 2 of 2'));
	assert.equal(await page.locator('.recent-id').count(), 1);
	await page.locator(`a.recent-id[href="/${identity}"]`).click();
	await page.waitForSelector('#paste-content pre');
	assert.equal(await page.locator('#paste-content').innerText(), 'Legacy identity body');
	await page.locator('.site-nav a[href="/pastes"]').click();
	await page.waitForSelector('.recent-list');
	await page.locator(`a.recent-id[href="/${blocked}"]`).click();
	await page.waitForSelector('h1');
	assert.equal(await page.locator('h1').innerText(), 'Human review is needed.');
	await page.locator('.site-nav a[href="/pastes"]').click();
	await page.waitForSelector('.recent-list');
	await page.locator(`a.recent-id[href="/${corrupt}"]`).click();
	await page.waitForSelector('.paste-load-error');
	assert.match(await page.locator('.paste-load-error').innerText(), /hash check failed/);
	console.log('Archive pagination, identity bodies, access denial and corrupt-body handling passed');

	await page.goto(`${origin}/${second}#file-note.txt`);
	await page.waitForSelector('#paste-content pre');
	assert.equal(await page.locator('#paste-content').innerText(), 'Second file');
	await page.waitForFunction(() => document.documentElement.dataset.navigationReady === 'true');
	await page.locator('.site-nav a[href="/pastes"]').click();
	await page.waitForSelector('.recent-list');
	// Check link behavior at the browser event boundary without opening tabs or downloads.
	for (const attributes of [{ target: '_blank' }, { download: 'paste.txt' }, { rel: 'noreferrer' }, { referrerpolicy: 'no-referrer' }, {}]) {
		const prevented = await page.evaluate(({ attributes, id }) => {
			const link = document.createElement('a'); link.href = `/${id}`;
			for (const [key, value] of Object.entries(attributes)) link.setAttribute(key, value);
			document.body.append(link);
			let intercepted;
			document.addEventListener('click', event => { intercepted = event.defaultPrevented; event.preventDefault(); }, { once: true });
			link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: Object.keys(attributes).length === 0 }));
			link.remove(); return intercepted;
		}, { attributes, id: first });
		assert.equal(prevented, false);
	}
	await page.locator('a.recent-id[href="/CP000004"]').click();
	await page.waitForURL(origin + '/about');
	assert.equal(await page.locator('h1').innerText(), 'About cp.codes');
	assert.deepEqual(errors, []);
	console.log('Direct file-fragment entry, native link behaviors and approved URL redirects passed');

	// A warm address-bar entry displays its local copy while metadata is held.
	const warmStart = requests.length;
	const savedAt = await page.evaluate(async id => (await (await import('/offline.js?v=2')).getPasteSnapshot(id)).saved_at, first);
	const releaseRefresh = hold(`/api/paste/${first}`);
	await page.goto(`${origin}/${first}`);
	await page.waitForSelector('#paste-content pre');
	assert.equal(await page.locator('#paste-content').innerText(), 'First paste');
	await assertEventually(() => requests.slice(warmStart).includes(`/api/paste/${first}`));
	assert.ok(!requests.slice(warmStart).includes(`/${first}`), 'canonical HTML must come from the service worker');
	assert.ok(!requests.slice(warmStart).includes(`/api/paste/${first}/content`), 'saved body must not be fetched');
	releaseRefresh();
	await page.waitForFunction(async ({ id, savedAt }) =>
		(await (await import('/offline.js?v=2')).getPasteSnapshot(id))?.saved_at > savedAt, { id: first, savedAt });
	console.log('Warm direct URL entry renders locally before the background check completes');

	// Corrupt local bytes are discarded; the unchanged concurrent APIs repair them.
	await changeSnapshot(page, `paste:${first}`, entry => { entry.body = new Uint8Array([1, 2, 3]).buffer; });
	const repairStart = requests.length;
	await page.goto(`${origin}/${first}`);
	await page.waitForSelector('#paste-content[data-offline-saved="true"]');
	assert.equal(await page.locator('#paste-content').innerText(), 'First paste');
	assert.ok(requests.slice(repairStart).includes(`/api/paste/${first}`));
	// The HTTP cache can supply the body, but a fresh snapshot must now be valid.
	assert.ok(await page.evaluate(async id => !!(await (await import('/offline.js?v=2')).getPasteSnapshot(id)), first));
	await changeSnapshot(page, `paste:${first}`, entry => { entry.schema = 999; });
	await page.goto(`${origin}/${first}`);
	await page.waitForSelector('#paste-content[data-offline-saved="true"]');
	assert.equal(await page.locator('#paste-content').innerText(), 'First paste');
	assert.equal(await page.evaluate(async id => (await (await import('/offline.js?v=2')).getPasteSnapshot(id)).schema, first), 1);
	assert.equal(await page.evaluate(async id => await (await import('/offline.js?v=2')).getPasteSnapshot(id), corrupt), null);
	console.log('Corrupt and obsolete saved copies recover online; failed verification never persists');

	// A known denial removes both the rendered copy and its persistent record.
	denied.add(first);
	const releaseDenial = hold(`/api/paste/${first}`);
	await page.goto(`${origin}/${first}`);
	await page.waitForSelector('#paste-content pre');
	assert.equal(await page.locator('#paste-content').innerText(), 'First paste');
	releaseDenial();
	await page.waitForSelector('h1');
	assert.equal(await page.locator('h1').innerText(), 'Paste not found.');
	assert.equal(await page.evaluate(async id => await (await import('/offline.js?v=2')).getPasteSnapshot(id), first), null);
	denied.delete(first);
	await page.locator('a:has-text("Check again")').click();
	await page.waitForSelector('#paste-content[data-offline-saved="true"]');
	console.log('Moderation denial evicts the saved body and replaces the visible copy');

	// Storage denial is a cache miss, not a broken online application.
	const unavailable = await browser.newContext();
	await unavailable.addInitScript(() => Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Storage disabled'); } }));
	const onlineOnly = await unavailable.newPage();
	await onlineOnly.goto(`${origin}/${first}`);
	await onlineOnly.waitForSelector('#paste-content pre');
	assert.equal(await onlineOnly.locator('#paste-content').innerText(), 'First paste');
	await unavailable.close();
	console.log('Online viewing survives unavailable local storage');

	// Cache limits and expiration use real IndexedDB in an isolated browser profile.
	const boundedContext = await browser.newContext();
	const boundedPage = await boundedContext.newPage(); await boundedPage.goto(origin + '/about');
	const storageResult = await boundedPage.evaluate(async () => {
		const { saveArchiveSnapshot, getArchiveSnapshot } = await import('/offline.js?v=2');
		for (let page = 1; page <= 41; page++) await saveArchiveSnapshot({ page, page_size: 50, total: 0, total_pages: 41, items: [] });
		const oldest = await getArchiveSnapshot(1), newest = await getArchiveSnapshot(41);
		// Each listing has about 9 MiB of metadata, exceeding 32 MiB together.
		for (let page = 42; page <= 45; page++) await saveArchiveSnapshot({ page, page_size: 50, total: 0, total_pages: 45,
			items: [], padding: 'x'.repeat(9 * 1024 * 1024) });
		return { oldest, newest: !!newest, evictedByBytes: await getArchiveSnapshot(42), latest: !!(await getArchiveSnapshot(45)) };
	});
	assert.deepEqual(storageResult, { oldest: null, newest: true, evictedByBytes: null, latest: true });
	await changeSnapshot(boundedPage, 'archive:45', entry => { entry.saved_at = Date.now() - 31 * 86400000; });
	assert.equal(await boundedPage.evaluate(async () => (await import('/offline.js?v=2')).getArchiveSnapshot(45)), null);
	await boundedContext.close();
	console.log('Persistent cache enforces entry count, byte budget and expiration');

	const cachedEditorFiles = await page.evaluate(async () => {
		const keys = await caches.keys();
		const cache = await caches.open(keys.find(name => name.startsWith('cp.codes.shell.')));
		return (await cache.keys()).map(request => new URL(request.url).pathname)
			.filter(path => path.startsWith('/lib/codemirror/') && path.endsWith('.js')).sort();
	});
	assert.deepEqual(cachedEditorFiles, editorManifest.precache, 'installation must defer other grammars');
	const warmEditor = await context.newPage();
	await warmEditor.goto(origin + '/new');
	await warmEditor.waitForSelector('.cm-editor');
	await warmEditor.locator('.editor-type').selectOption('rust');
	await warmEditor.waitForFunction(async () => {
		const { language } = await import('@codemirror/language');
		return document.querySelector('.editor-card').editorView.state.facet(language)?.name === 'rust';
	});
	await warmEditor.waitForFunction(async paths => {
		return (await Promise.all(paths.map(path => caches.match(path)))).every(Boolean);
	}, [editorManifest.imports['@codemirror/lang-rust'], editorManifest.imports['@lezer/rust']]);
	await warmEditor.close();

	// Fresh documents in the same profile work with networking disabled.
	await context.setOffline(true);
	await page.close();
	const offlinePage = await context.newPage(); offlinePage.on('pageerror', error => errors.push(error.message));
	const offlineStart = requests.length;
	const composerResponse = await offlinePage.goto(origin + '/');
	assert.equal(composerResponse.fromServiceWorker(), true);
	await offlinePage.waitForSelector('.cm-editor');
	await offlinePage.locator('.cm-content').fill('const offlineDraft = 42;');
	await offlinePage.locator('.editor-filename').fill('offline.js');
	// Default languages work on their first import offline; Rust was cached on demand.
	for (const [type, packageName, factory, options] of [
		['javascript', 'javascript', 'javascript'], ['typescript', 'javascript', 'javascript', { typescript: true }],
		['python', 'python', 'python'], ['json', 'json', 'json'],
		['html', 'html', 'html'], ['css', 'css', 'css'], ['markdown', 'markdown', 'markdown'],
		['rust', 'rust', 'rust'],
	]) {
		await offlinePage.locator('.editor-type').selectOption(type);
		await offlinePage.waitForFunction(async ([packageName, factory, options]) => {
			const module = await import(`@codemirror/lang-${packageName}`);
			const { language } = await import('@codemirror/language');
			return document.querySelector('.editor-card').editorView.state.facet(language)?.name === module[factory](options).language.name;
		}, [packageName, factory, options]);
	}
	await offlinePage.locator('.editor-type').selectOption('yaml');
	await offlinePage.waitForFunction(async () => {
		const { language } = await import('@codemirror/language');
		return !document.querySelector('.editor-card').editorView.state.facet(language);
	});
	await offlinePage.locator('.cm-content').fill('Editing without an uncached grammar');
	assert.equal(await offlinePage.locator('.cm-content').innerText(), 'Editing without an uncached grammar');
	await offlinePage.locator('.cm-content').fill('const offlineDraft = 42;');
	await offlinePage.locator('#add-text').click();
	await offlinePage.locator('.cm-content').nth(1).fill('Second offline file');
	await offlinePage.locator('#file-input').setInputFiles({ name: 'local.png', mimeType: 'image/png',
		buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGOcAAAAASUVORK5CYII=', 'base64') });
	await offlinePage.waitForSelector('.editor-card img');
	assert.equal(await offlinePage.locator('.editor-card').count(), 3);
	await offlinePage.locator('#consent').check();
	await offlinePage.locator('#consent-moderation').check();
	await offlinePage.locator('#publish').click();
	assert.equal(await offlinePage.locator('#status').innerText(), 'Connect to publish this paste.');
	assert.equal(await offlinePage.locator('.cm-content').first().innerText(), 'const offlineDraft = 42;');
	assert.equal(requests.length, offlineStart, 'offline composition must not reach the server');
	for (const path of ['/new', '/index.html']) {
		assert.equal((await offlinePage.goto(origin + path)).fromServiceWorker(), true);
		await offlinePage.waitForSelector('.cm-editor');
	}
	console.log('Offline editor, default and previously loaded languages, plaintext fallback, files and aliases passed');
	assert.equal((await offlinePage.goto(origin + '/about#service-providers')).fromServiceWorker(), true);
	await offlinePage.waitForSelector('#service-providers');
	assert.equal(await offlinePage.locator('.site-nav a[aria-current="page"]').innerText(), 'about');
	const aboutTheme = await offlinePage.locator('html').getAttribute('data-theme');
	await offlinePage.locator('#theme-toggle').click();
	assert.notEqual(await offlinePage.locator('html').getAttribute('data-theme'), aboutTheme);
	assert.equal((await offlinePage.reload()).fromServiceWorker(), true);
	await offlinePage.waitForSelector('#service-providers');
	assert.equal(offlinePage.url(), origin + '/about#service-providers');
	assert.equal((await offlinePage.goto(origin + '/about/')).fromServiceWorker(), true);
	assert.equal(requests.length, offlineStart, 'offline about entry and refresh must not reach the server');
	console.log('Offline about page, section fragments, theme toggle and normal refresh passed');
	await offlinePage.goto(`${origin}/${first}`);
	await offlinePage.waitForSelector('#paste-content pre');
	assert.equal(await offlinePage.locator('#paste-content').innerText(), 'First paste');
	await offlinePage.locator('#open-details').click();
	await offlinePage.waitForSelector('#paste-details-dialog[open]');
	await offlinePage.locator('#paste-details-dialog [data-close-dialog]').click();
	await offlinePage.goto(`${origin}/${identity}`);
	await offlinePage.waitForSelector('#paste-content pre');
	assert.equal(await offlinePage.locator('#paste-content').innerText(), 'Legacy identity body');
	await offlinePage.goto(`${origin}/${second}#file-note.txt`);
	await offlinePage.waitForSelector('#paste-content pre');
	assert.equal(await offlinePage.locator('#paste-content').innerText(), 'Second file');
	await offlinePage.getByRole('tab', { name: 'readme.md', exact: true }).click();
	await offlinePage.waitForSelector('#paste-content .markdown-body');
	await offlinePage.goto(`${origin}/pastes?page=2`);
	await offlinePage.waitForSelector('.recent-list');
	assert.equal(await offlinePage.locator('.recent-id').count(), 1);
	assert.equal((await offlinePage.goto(`${origin}/pastes?q=${first.toLowerCase()}`)).fromServiceWorker(), true);
	await offlinePage.waitForSelector('.recent-list');
	assert.equal(await offlinePage.locator('#paste-id-search').inputValue(), first);
	assert.deepEqual(await offlinePage.locator('.recent-id').allTextContents(), [first]);
	await offlinePage.locator('[data-paste-search] a').click();
	await offlinePage.waitForFunction(() => document.querySelector('#paste-id-search')?.value === '' && document.querySelectorAll('.recent-id').length > 1);
	console.log('Saved ID search stays separate from the full archive and reloads offline');
	await offlinePage.goto(`${origin}/CP000099`);
	await offlinePage.waitForSelector('h1');
	assert.equal(await offlinePage.locator('h1').innerText(), 'Not saved for offline use.');
	assert.deepEqual(errors, []);
	console.log('Offline direct entry, bundles, file fragments, dialogs, archive and unseen-paste message passed');

	// Also prove this is local, without relying on an emulated offline flag.
	await context.setOffline(false);
	server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
	const stoppedPage = await context.newPage();
	const failedRefresh = stoppedPage.waitForEvent('requestfailed', request => new URL(request.url()).pathname === `/api/paste/${second}`);
	await stoppedPage.goto(`${origin}/${second}#file-note.txt`);
	await stoppedPage.waitForSelector('#paste-content pre');
	assert.equal(await stoppedPage.locator('#paste-content').innerText(), 'Second file');
	await failedRefresh;
	console.log('Saved paste loads in a fresh document with the HTTP server stopped');
	await stoppedPage.goto(origin + '/');
	await stoppedPage.waitForSelector('.cm-editor');
	await stoppedPage.locator('.cm-content').fill('Draft with the server stopped');
	assert.equal(await stoppedPage.locator('.cm-content').innerText(), 'Draft with the server stopped');
	console.log('New-paste editor loads and accepts content with the HTTP server stopped');
	assert.equal((await stoppedPage.goto(origin + '/about#service-providers')).fromServiceWorker(), true);
	await stoppedPage.waitForSelector('#service-providers');
	console.log('About page loads with the HTTP server stopped');
	await context.close();
} finally {
	for (const entry of held.values()) entry.release();
	await browser?.close();
	if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

async function changeSnapshot(page, key, mutate) {
	await page.evaluate(({ key, source }) => new Promise((resolve, reject) => {
		const open = indexedDB.open('cp.codes.offline.v1', 1);
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const db = open.result, tx = db.transaction('snapshots', 'readwrite'), store = tx.objectStore('snapshots');
			const request = store.get(key);
			request.onsuccess = () => { const entry = request.result; (0, eval)(`(${source})`)(entry); store.put(entry); };
			tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
		};
	}), { key, source: mutate.toString() });
}

async function assertEventually(predicate) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	assert.ok(await predicate(), 'Expected browser state or API requests did not arrive');
}
