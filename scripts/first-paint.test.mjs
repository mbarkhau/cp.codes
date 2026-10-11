// Optional browser regression: run with the same Playwright setup as browser-smoke.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const compiled = await build({ entryPoints: ['src/ui.ts'], bundle: true, write: false, format: 'esm',
	plugins: [{ name: 'workers-stub', setup(build) {
		build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}' }));
	} }],
});
const ui = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const content = 'Hello';
const paste = { id: 'CP000000', created_at: '2026-10-10T00:00:00Z', content_type: 'plaintext',
	byte_length: 5, compressed_byte_length: 5, content_encoding: 'identity', sha256: createHash('sha256').update(content).digest('hex') };
const escapedHeaderPath = '"/><img src=x onerror="window.headerInjected=true">&';
const minimalPath = '/' + encodeURIComponent(escapedHeaderPath);
const shellPages = new Map([
	['/about', await ui.aboutPage().text()],
	['/new', await ui.newPage().text()],
	['/admin/pow', ui.layout('Staff', '')],
	[minimalPath, ui.layout('Minimal', '', undefined, { showFooter: false })],
]);
const server = createServer(async (request, response) => {
	const path = new URL(request.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
	if (shellPages.has(path)) {
		response.setHeader('content-type', 'text/html'); response.end(shellPages.get(path));
	} else if (path === '/' || path === '/CP000000') {
		response.setHeader('content-type', 'text/html');
		response.end(await (path === '/' ? ui.newPage() : ui.viewPage(paste, 0)).text());
	} else if (path === '/api/paste/CP000000/content') {
		response.setHeader('content-type', 'text/plain'); response.end(content);
	} else if (path === '/api/pow') {
		response.setHeader('content-type', 'application/json'); response.end('{"difficulty":0}');
	} else if (/^\/[a-z_]+\.(js|css)$/.test(path)) {
		response.setHeader('content-type', path.endsWith('.js') ? 'application/javascript' : 'text/css');
		response.end(await readFile(new URL('../public' + path, import.meta.url)));
	} else { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
	browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
	for (const path of shellPages.keys()) {
		const context = await browser.newContext();
		const page = await context.newPage();
		try {
			if (path === '/admin/pow') await context.addCookies([{ name: 'cp_staff_nav', value: '1', url: origin }]);
			await page.goto(origin + path + (path === '/about' ? '/?page=2#details' : ''));
			assert.equal(await page.locator('header[data-header-path], header[data-current-path], header[data-staff-navigation]').count(), 0);
			assert.equal(await page.locator('.site-nav').count(), 1);
			assert.equal(await page.locator('#theme-toggle').count(), 1);
			assert.equal(await page.locator('.footer li').count(), path === minimalPath ? 0 : 4);
			assert.equal(await page.locator('.staff-nav-start, .nav-logout').count(), path === '/admin/pow' ? 2 : 0);
			assert.equal(await page.locator('.logo a').last().getAttribute('href'), path);
			if (path === '/admin/pow') {
				assert.equal(await page.locator('.site-nav a[aria-current="page"]').getAttribute('href'), '/admin/pow');
				assert.equal(await page.locator('.nav-logout').getAttribute('method'), 'post');
				assert.equal(await page.locator('.nav-logout').getAttribute('action'), '/logout');
			} else if (path === '/about' || path === '/new') {
				assert.equal(await page.locator('.site-nav a[aria-current="page"]').getAttribute('href'), path === '/new' ? '/' : '/about');
			} else {
				assert.equal(await page.locator('.logo a').last().textContent(), minimalPath);
				assert.equal(await page.locator('header img').count(), 0);
				assert.equal(await page.evaluate(() => window.headerInjected), undefined);
			}
			console.log(`Shared shell passed: ${path}`);
		} finally { await context.close(); }
	}
	for (const scenario of [
		{ cookie: '1', visible: true },
		{ cookie: 'invalid', visible: false },
		{ cookie: '1', expired: true, visible: false },
		{ blocked: true, visible: false },
	]) {
		const context = await browser.newContext();
		const page = await context.newPage();
		try {
			if (scenario.cookie) await context.addCookies([{ name: 'cp_staff_nav', value: scenario.cookie, url: origin,
				expires: Math.floor(Date.now() / 1000) + (scenario.expired ? -60 : 3600) }]);
			if (scenario.blocked) await context.addInitScript(() => {
				Object.defineProperty(document, 'cookie', { get() { throw new Error('Cookies unavailable'); } });
			});
			await page.goto(origin + '/about');
			assert.equal(await page.locator('.staff-nav-start, .nav-logout').count(), scenario.visible ? 2 : 0);
			assert.equal(await page.locator('#theme-toggle').count(), 1);
			if (scenario.visible) {
				// Cookies carry the display hint into independently opened tabs.
				const otherTab = await context.newPage();
				await otherTab.goto(origin + '/new');
				assert.equal(await otherTab.locator('.staff-nav-start').count(), 1);
				await context.clearCookies();
				await page.reload();
				assert.equal(await page.locator('.staff-nav-start, .nav-logout').count(), 0);
			}
		} finally { await context.close(); }
	}
	console.log('Staff navigation hints passed: valid, invalid, expired, unavailable, cross-tab, and cleared');
	for (const [path, module] of [['/', 'app'], ['/CP000000', 'view']]) {
		for (const theme of ['light', 'dark']) {
			for (const held of (path === '/' ? [module, 'files'] : [module])) {
				const context = await browser.newContext();
				await context.addInitScript(theme => localStorage.setItem('cp.codes.theme', theme), theme);
				const page = await context.newPage();
				const session = await context.newCDPSession(page);
				await session.send('Network.enable');
				const priorities = new Map();
				session.on('Network.requestWillBeSent', ({ request }) => {
					priorities.set(new URL(request.url).pathname, request.initialPriority);
				});
				let release;
				const ready = new Promise(resolve => { release = resolve; });
				let requested;
				const requestStarted = new Promise(resolve => { requested = resolve; });
				await page.route(`**/${held}.js?*`, async route => {
					requested();
					await ready;
					await route.abort();
				});
				try {
					await page.goto(origin + path, { waitUntil: 'commit' });
				await Promise.race([requestStarted, new Promise((_, reject) => setTimeout(() => reject(new Error(`${held}.js was never requested`)), 3000))]);
					await page.waitForFunction(() => performance.getEntriesByName('first-contentful-paint').length > 0, null, { timeout: 3000 });
					assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
					assert.equal(priorities.has('/site.js'), true, 'Shared script is requested as an asset');
					assert.equal(priorities.has('/style.css'), true, 'Shared CSS is requested as an asset');
					await page.locator('.logo').waitFor({ state: 'visible' });
					assert.equal(await page.locator('.logo').textContent(), path === '/' ? 'cp.codes/' : 'cp.codes/CP000000');
					if (path === '/') assert.equal(await page.locator('.site-nav a[aria-current="page"]').getAttribute('href'), '/');
					await page.getByRole('navigation', { name: 'Primary navigation' }).waitFor({ state: 'visible' });
					assert.equal(await page.locator('.footer li').count(), 4);
					const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
					assert.equal(background, theme === 'dark' ? 'rgb(27, 36, 49)' : 'rgb(232, 237, 243)');
					const next = theme === 'dark' ? 'light' : 'dark';
					await page.getByRole('button', { name: `Switch to ${next} mode` }).click();
					assert.equal(await page.locator('html').getAttribute('data-theme'), next);
					console.log(`First paint passed: ${path}, ${theme}, ${held}.js still pending`);
				} finally { release(); await context.close(); }
			}
		}
	}
	// The toolbar shell reserves its space before the viewer populates its controls.
	for (const width of [1280, 390]) {
		const context = await browser.newContext({ viewport: { width, height: 900 } });
		const page = await context.newPage();
		let release;
		const ready = new Promise(resolve => { release = resolve; });
		await page.route('**/view.js?*', async route => { await ready; await route.continue(); });
		try {
			await page.goto(origin + '/CP000000', { waitUntil: 'commit' });
			await page.waitForFunction(() => performance.getEntriesByName('first-contentful-paint').length > 0);
			assert.equal(await page.locator('.paste-toolbar').evaluate(toolbar => toolbar.childElementCount), 0);
			assert.equal(await page.locator('.paste-toolbar').evaluate(toolbar => getComputedStyle(toolbar).minHeight), '44px');
			const before = await page.locator('.paste-card').boundingBox();
			release();
			await page.locator('#copy-link').waitFor();
			const after = await page.locator('.paste-card').boundingBox();
			assert.equal(after.y, before.y, 'Toolbar initialization must not move the paste card');
			assert.equal(await page.locator('.paste-toolbar').count(), 1);
			console.log(`Toolbar layout passed: ${width}px`);
		} finally { release(); await context.close(); }
	}
	// Hold every optional module: the editor and plaintext viewer must still initialize.
	const optional = new Set(['media', 'qr_text', 'markdown', 'highlight', 'view_dialogs']);
	for (const path of ['/', '/CP000000']) {
		const context = await browser.newContext();
		const page = await context.newPage();
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		const requested = [];
		let release;
		const ready = new Promise(resolve => { release = resolve; });
		await page.route('**/*.js?*', async route => {
			const name = new URL(route.request().url()).pathname.slice(1, -3);
			if (!optional.has(name)) return route.continue();
			requested.push(name);
			await ready; await route.abort();
		});
		try {
			await page.goto(origin + path);
			await page.locator(path === '/' ? '.editor-fallback' : '#paste-content pre').waitFor();
			assert.deepEqual(requested, [], 'Initial editor/plaintext content must not request optional modules');
			assert.deepEqual(errors, []);
			if (path === '/') {
				await page.locator('.editor-fallback').fill('Editable without optional imports');
				await Promise.all([page.waitForRequest('**/media.js?*'),
					page.locator('#file-input').setInputFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('Upload') })]);
				await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Reading'));
			} else {
				assert.equal(await page.locator('#paste-content pre').textContent(), content);
				assert.equal(await page.locator('dialog.paste-dialog').count(), 0);
				await Promise.all([page.waitForRequest('**/view_dialogs.js?*'), page.locator('#open-details').click()]);
				assert.equal(await page.locator('dialog.paste-dialog').count(), 0, 'Pending dialog code must not block readable content');
			}
			console.log(`Lazy imports passed: ${path}`);
		} finally { release(); await context.close(); }
	}
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
