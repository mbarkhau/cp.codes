// Optional browser regression: use the same Playwright setup as first-paint.test.mjs.
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
const hash = value => createHash('sha256').update(value).digest('hex');
const files = [
	{ name: 'first.txt', content_type: 'plaintext', content: 'Readable before any dialog loads.' },
	{ name: '<img src=x onerror="window.injected=true">.txt', content_type: 'plaintext', content: 'Second file.' },
];
const content = JSON.stringify({ format: 'bundle-v1', primary: files[0].name, files });
const paste = { id: 'CP000000', created_at: '2026-10-11T00:00:00Z', content_type: 'plaintext',
	format: 'bundle-v1', primary: files[0].name, filename: files[0].name,
	files: files.map(file => ({ ...file, content: undefined, byte_length: Buffer.byteLength(file.content), sha256: hash(file.content) })),
	byte_length: Buffer.byteLength(content), compressed_byte_length: Buffer.byteLength(content), content_encoding: 'identity', sha256: hash(content) };
let reports = 0, authorizations = 0;
const server = createServer(async (request, response) => {
	const path = new URL(request.url, 'http://localhost').pathname;
	if (path === '/CP000000' || path === '/held') {
		response.setHeader('content-type', 'text/html');
		response.end(await (path === '/held' ? ui.reviewRequiredPage(paste.id, 'Fixture awaiting review.') : ui.viewPage(paste, 0)).text());
	} else if (path === '/api/paste/CP000000/content') {
		response.setHeader('content-type', 'text/plain'); response.end(content);
	} else if (/^\/api\/paste\/CP000000\/(report|authorize)$/.test(path)) {
		let body = ''; for await (const chunk of request) body += chunk;
		const data = JSON.parse(body);
		if (path.endsWith('/report')) { reports++; assert.deepEqual(data, { category: null, email: null }); }
		else { authorizations++; assert.equal(data.passcode, '0001020304050607'); }
		response.setHeader('content-type', 'application/json'); response.end('{"authorized":true}');
	} else if (/^\/[a-z_]+\.(js|css)$/.test(path) || path === '/lib/uqr-0.1.2.js') {
		response.setHeader('content-type', path.endsWith('.js') ? 'application/javascript' : 'text/css');
		try { response.end(await readFile(new URL('../public' + path, import.meta.url))); }
		catch { response.statusCode = 404; response.end(); }
	} else { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
	browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
	const context = await browser.newContext();
	const page = await context.newPage();
	const errors = [], requests = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('request', request => requests.push(new URL(request.url()).pathname));
	let release, started;
	const held = new Promise(resolve => { release = resolve; });
	const contentRequested = new Promise(resolve => { started = resolve; });
	await page.route('**/api/paste/CP000000/content', async route => { started(); await held; await route.continue(); });
	try {
		await page.goto(origin + '/CP000000', { waitUntil: 'commit' });
		await contentRequested;
		await page.locator('#open-details').waitFor();
		assert.equal(await page.locator('dialog').count(), 0);
		assert.equal(requests.includes('/view_dialogs.js'), false);
		await page.locator('#open-details').dblclick();
		await page.locator('#paste-details-dialog').waitFor({ state: 'visible' });
		assert.equal(await page.locator('dialog').count(), 1, 'Rapid repeated clicks create only the requested dialog');
		assert.equal(requests.filter(path => path === '/view_dialogs.js').length, 1);
		assert.equal(await page.locator('.paste-file-metadata').count(), 2);
		assert.equal(await page.locator('.paste-file-links:visible').count(), 0);
		assert.equal(await page.locator('.paste-file-metadata img, [onerror]').count(), 0);
		release();
		await page.waitForFunction(() => document.querySelector('#paste-content').getAttribute('aria-busy') === 'false');
		await page.waitForFunction(() => [...document.querySelectorAll('.file-download')].every(link => link.href.startsWith('blob:') && !link.parentElement.hidden));
		const downloads = await page.locator('.file-download').evaluateAll(async links => Promise.all(links.map(async link => ({
			name: link.download, content: await (await fetch(link.href)).text(),
		}))));
		assert.deepEqual(downloads, files.map(file => ({ name: file.name, content: file.content })));
		await page.waitForFunction(() => document.querySelector('#qr')?.naturalWidth > 0);
		await page.keyboard.press('Escape');
		assert.equal(await page.locator('#open-details').evaluate(button => document.activeElement === button), true);
		await page.locator('#open-details').click();
		await page.locator('#paste-details-dialog').waitFor({ state: 'visible' });
		assert.equal(await page.locator('dialog').count(), 1);
		await page.getByRole('button', { name: 'Close details', exact: true }).click();
		await page.locator('#open-report').click();
		await page.locator('#report-dialog').waitFor({ state: 'visible' });
		assert.equal(await page.locator('dialog').count(), 2);
		await page.getByRole('button', { name: 'Submit report', exact: true }).click();
		await page.waitForFunction(() => document.querySelector('#report-status').textContent.includes('Report submitted'));
		assert.equal(reports, 1);
		await page.keyboard.press('Escape');
		await page.locator('#open-report').click();
		await page.locator('#report-dialog').waitFor({ state: 'visible' });
		assert.equal(await page.locator('#report-dialog').count(), 1);
		assert.equal(reports, 1, 'Reopening does not submit another report');
		await page.keyboard.press('Escape');
		await page.locator('#authorize-paste').click();
		await page.getByLabel('Passphrase', { exact: true }).fill('0001020304050607');
		await page.getByRole('button', { name: 'Authorize', exact: true }).click();
		await page.waitForFunction(() => document.querySelector('#saved-authorization')?.hidden === false);
		assert.equal(authorizations, 1);
		assert.equal(await page.locator('dialog').count(), 0, 'Reload with saved credentials still creates no dialogs');
		assert.equal(await page.locator('#authorize-paste').isVisible(), false);
		assert.equal(await page.locator('#paste-delete').isVisible(), true);
		assert.deepEqual(errors, []);
		console.log('Lazy dialogs passed: initial loading, early details, download links, QR, repeated clicks, focus restoration, reporting and authorization.');
	} finally { release(); await context.close(); }

	for (const scenario of ['held', 'failed-import']) {
		const context = await browser.newContext(); const page = await context.newPage();
		try {
			if (scenario === 'failed-import') await page.route('**/view_dialogs.js?*', route => route.abort());
			await page.goto(origin + (scenario === 'held' ? '/held' : '/CP000000'));
			assert.equal(await page.locator('dialog').count(), 0);
			await page.locator('#authorize-paste').click();
			if (scenario === 'held') {
				await page.getByLabel('Passphrase', { exact: true }).fill('0001020304050607');
				await page.getByRole('button', { name: 'Authorize', exact: true }).click();
				await page.waitForFunction(() => document.querySelector('#saved-authorization')?.hidden === false);
				assert.equal(authorizations, 2);
			} else {
				await page.waitForFunction(() => document.querySelector('#paste-action-status').textContent.includes('Could not open dialog'));
				assert.equal(await page.locator('#paste-content code').textContent(), files[0].content);
				assert.equal(await page.locator('#copy-paste').isEnabled(), true);
			}
			console.log(`Lazy dialog recovery passed: ${scenario}`);
		} finally { await context.close(); }
	}
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
