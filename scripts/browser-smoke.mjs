// Optional browser smoke test. Install playwright separately; no paid AI calls.
// PLAYWRIGHT_MODULE may point to an external playwright/index.mjs installation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { CRITERIA, MODEL } from '../src/jev.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const compiled = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: compiled.outputFiles[0].text,
	compatibilityDate: '2026-09-05', bindings: { POW_DIFFICULTY_BITS: '0', DEFAPI_KEY: 'fake-test-key', STAFF_ALLOW_DEVELOPMENT_LOGIN: 'true' }, r2Buckets: ['PASTES'],
	durableObjects: Object.fromEntries(['PASTE_INDEX:PasteIndex', 'POW_KEY:PowKey', 'MONO_CLOCK:MonoClock', 'STAFF_SESSIONS:StaffSession'].map(value => {
		const [binding, className] = value.split(':'); return [binding, { className, useSQLite: true }];
	})),
	serviceBindings: { ASSETS: async request => {
		const path = new URL(request.url).pathname.slice(1);
		if (!/^[a-z_]+\.(js|css)$/.test(path)) return new Response('', { status: 404 });
		try { return new Response(await readFile(join(process.cwd(), 'public', path)), { headers: { 'content-type': path.endsWith('.js') ? 'application/javascript' : 'text/css' } }); }
		catch { return new Response('', { status: 404 }); }
	} },
	outboundService: async () => new Response(JSON.stringify({ model: MODEL, answers: { category: { type: 'choice', choice: 'code',
		probabilities: Object.fromEntries(Object.keys(CRITERIA).map(key => [key, key === 'code' ? 1 : 0])) } } })),
}));
let browser;
try {
	const origin = (await mf.ready).origin;
	browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
	const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
	const page = await context.newPage();
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(origin);
	await page.locator('#filename').fill('readme.md');
	await page.locator('#content').fill('# My document\n\n![Diagram](diagram.png)\n\n[Code](hello.js)');
	await page.locator('#file-input').setInputFiles([
		{ name: 'diagram.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7qkAAAAASUVORK5CYII=', 'base64') },
		{ name: 'hello.js', mimeType: 'text/javascript', buffer: Buffer.from('console.log("hello");') },
	]);
	await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 3);
	await page.getByRole('button', { name: 'readme.md', exact: true }).click();
	await page.locator('#preview-file').click();
	await page.waitForFunction(() => document.querySelector('#draft-preview img')?.naturalWidth === 1);
	await page.screenshot({ path: '/tmp/cp-codes-composer.png', fullPage: true });
	await page.locator('#consent').check(); await page.locator('#consent-moderation').check(); await page.locator('#publish').click();
	await page.locator('#upload-result').waitFor({ state: 'visible' });
	assert.match(await page.locator('#upload-result').innerText(), /review required/i);
	const id = await page.locator('#upload-result .share-link').evaluate(link => new URL(link.href).pathname.slice(1));
	await page.goto(`${origin}/${id}`);
	assert.match(await page.locator('h1').innerText(), /Human review/);
	await page.locator('#paste-delete').waitFor({ state: 'visible' });
	await page.goto(`${origin}/login`); await page.locator('#username').fill('admin'); await page.locator('#password').fill('4dm1n');
	await page.getByRole('button', { name: 'Log in', exact: true }).click(); await page.waitForURL('**/admin/pastes');
	await page.goto(`${origin}/admin/paste/${id}/view`);
	await page.waitForFunction(() => document.querySelector('#paste-content img')?.naturalWidth === 1);
	await page.getByRole('button', { name: 'hello.js', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('#paste-content').textContent.includes('console.log'));
	await page.getByRole('button', { name: 'readme.md', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('#paste-content img')?.naturalWidth === 1);
	await page.getByRole('button', { name: 'Approve public access', exact: true }).click(); await page.waitForURL('**/admin/pastes');
	const anon = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
	const viewer = await anon.newPage(); viewer.on('pageerror', error => errors.push(error.message));
	await viewer.goto(`${origin}/${id}`);
	await viewer.waitForFunction(() => document.querySelector('#paste-content img')?.naturalWidth === 1);
	assert.match(await viewer.locator('.sharing-banner').innerText(), /Human-approved/);
	assert.equal(await viewer.locator('#paste-delete').isVisible(), false);
	assert.equal(await viewer.locator('.paste-actions .icon-action svg').count(), 6);
	await viewer.evaluate(() => {
		window.copiedText = null;
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedText = text; } } });
	});
	await viewer.getByRole('button', { name: 'hello.js', exact: true }).click();
	await viewer.waitForFunction(() => document.querySelector('#paste-content').textContent.includes('console.log'));
	assert.match(await viewer.locator('#raw-paste').getAttribute('href'), /\/files\/hello\.js$/);
	const actionsBefore = await viewer.locator('.paste-actions').boundingBox();
	const contentBefore = await viewer.locator('.paste-card').boundingBox();
	const toolbarBefore = await viewer.locator('.paste-toolbar').boundingBox();
	assert.equal(actionsBefore.x + actionsBefore.width, toolbarBefore.x + toolbarBefore.width);
	await viewer.getByRole('button', { name: 'Copy content', exact: true }).click();
	await viewer.waitForFunction(() => window.copiedText === 'console.log("hello");');
	assert.equal(await viewer.locator('#copy-paste svg').count(), 1);
	assert.equal(await viewer.locator('#paste-action-status').innerText(), 'Content copied.');
	const feedback = await viewer.locator('#paste-action-status').boundingBox();
	assert.ok(feedback.x + feedback.width <= actionsBefore.x);
	assert.deepEqual(await viewer.locator('.paste-actions').boundingBox(), actionsBefore);
	assert.deepEqual(await viewer.locator('.paste-card').boundingBox(), contentBefore);
	await viewer.waitForTimeout(4000);
	assert.equal(await viewer.locator('#paste-action-status').evaluate(status => status.classList.contains('is-fading')), false);
	await viewer.getByRole('button', { name: 'Copy link', exact: true }).click();
	await viewer.waitForFunction(expected => window.copiedText === expected, `${origin}/${id}`);
	assert.equal(await viewer.locator('#paste-action-status').innerText(), 'Link copied.');
	await viewer.waitForTimeout(2000);
	assert.equal(await viewer.locator('#paste-action-status').evaluate(status => status.classList.contains('is-fading')), false);
	assert.equal(await viewer.locator('#paste-action-status').innerText(), 'Link copied.');
	await viewer.waitForFunction(() => document.querySelector('#paste-action-status').classList.contains('is-fading'));
	await viewer.waitForFunction(() => getComputedStyle(document.querySelector('#paste-action-status')).opacity === '0');
	await viewer.waitForFunction(() => document.querySelector('#paste-action-status').textContent === '');
	assert.deepEqual(await viewer.locator('.paste-actions').boundingBox(), actionsBefore);
	assert.deepEqual(await viewer.locator('.paste-card').boundingBox(), contentBefore);
	await viewer.getByRole('button', { name: 'Paste details', exact: true }).click();
	assert.equal(await viewer.locator('#paste-details-dialog').evaluate(dialog => dialog.open), true);
	assert.equal(await viewer.locator('#paste-details-dialog .paste-file-metadata').count(), 3);
	assert.match(await viewer.locator('#paste-details-dialog').innerText(), /SHA-256/);
	await viewer.waitForFunction(() => document.querySelector('#qr').naturalWidth > 0);
	await viewer.setViewportSize({ width: 390, height: 844 });
	assert.ok(await viewer.locator('#paste-details-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth));
	await viewer.screenshot({ path: '/tmp/cp-codes-details-mobile.png', fullPage: true });
	await viewer.keyboard.press('Escape');
	assert.equal(await viewer.locator('#paste-details-dialog').evaluate(dialog => dialog.open), false);
	assert.equal(await viewer.locator('#open-details').evaluate(button => document.activeElement === button), true);
	await viewer.getByRole('button', { name: 'Report paste', exact: true }).click();
	assert.equal(await viewer.locator('#report-dialog').evaluate(dialog => dialog.open), true);
	await viewer.getByRole('button', { name: 'Close report', exact: true }).click();
	await viewer.setViewportSize({ width: 1280, height: 1000 });
	await viewer.getByRole('button', { name: 'readme.md', exact: true }).click();
	await viewer.waitForFunction(() => document.querySelector('#paste-content img')?.naturalWidth === 1);
	await viewer.screenshot({ path: '/tmp/cp-codes-viewer.png', fullPage: true });
	await viewer.goto(origin); await viewer.locator('#content').fill('# A harmless text-only paste');
	await viewer.locator('#consent').check(); await viewer.locator('#consent-moderation').check(); await viewer.locator('#publish').click();
	await viewer.locator('#upload-result').waitFor({ state: 'visible' });
	assert.match(await viewer.locator('#upload-result').innerText(), /Ready to share/);
	await viewer.getByRole('link', { name: 'Open paste →', exact: true }).click();
	await viewer.waitForFunction(() => document.querySelector('#paste-content h1')?.textContent === 'A harmless text-only paste');
	assert.match(await viewer.locator('.sharing-banner').innerText(), /Limited sharing/);
	await viewer.locator('#paste-delete').waitFor({ state: 'visible' });
	assert.equal(await viewer.locator('#delete-paste svg').count(), 1);
	assert.match(await viewer.locator('#delete-paste').getAttribute('title'), /remaining/);
	await viewer.setViewportSize({ width: 390, height: 844 });
	const mobileActionsBefore = await viewer.locator('.paste-actions').boundingBox();
	const mobileContentBefore = await viewer.locator('.paste-card').boundingBox();
	await viewer.evaluate(() => {
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard unavailable: ' + 'long error '.repeat(100)); } } });
		document.execCommand = () => false;
	});
	await viewer.getByRole('button', { name: 'Copy content', exact: true }).click();
	await viewer.waitForFunction(() => document.querySelector('#paste-action-status').textContent.includes('Clipboard access was denied'));
	assert.deepEqual(await viewer.locator('.paste-actions').boundingBox(), mobileActionsBefore);
	assert.deepEqual(await viewer.locator('.paste-card').boundingBox(), mobileContentBefore);
	assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	await viewer.setViewportSize({ width: 1280, height: 1000 });
	await viewer.getByRole('button', { name: 'Paste details', exact: true }).click();
	assert.match(await viewer.locator('#paste-details-dialog').innerText(), /leading zero bits/);
	await viewer.getByRole('button', { name: 'Close details', exact: true }).click();
	await viewer.evaluate(() => {
		const id = document.querySelector('#paste-content').dataset.cpCode;
		const key = `cp.codes.deletion.v1:${id}`;
		const grant = JSON.parse(localStorage.getItem(key));
		localStorage.setItem(key, JSON.stringify({ ...grant, expiresAt: Date.now() - 1 }));
	});
	await viewer.reload();
	await viewer.waitForFunction(() => document.querySelector('#paste-content h1')?.textContent === 'A harmless text-only paste');
	assert.equal(await viewer.locator('#paste-delete').isVisible(), false);
	await viewer.getByRole('button', { name: 'Report paste', exact: true }).click();
	const reportBefore = await viewer.locator('#report-dialog').boundingBox();
	await viewer.getByRole('button', { name: 'Submit report', exact: true }).click();
	await viewer.waitForFunction(() => document.querySelector('#report-status').textContent.includes('Report submitted'));
	assert.deepEqual(await viewer.locator('#report-dialog').boundingBox(), reportBefore);
	await viewer.getByRole('button', { name: 'Close report', exact: true }).click();
	await viewer.setViewportSize({ width: 390, height: 844 }); await viewer.goto(origin);
	await viewer.waitForFunction(() => document.querySelectorAll('.file-row').length === 1);
	assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	await viewer.locator('#theme-toggle').click(); assert.equal(await viewer.locator('html').getAttribute('data-theme'), 'dark');
	await viewer.screenshot({ path: '/tmp/cp-codes-mobile.png', fullPage: true });
	assert.deepEqual(errors, []);
	console.log('Browser smoke passed: files, preview, media review, staff inspection/approval, sibling images, limited text sharing, mobile layout and dark mode.');
} finally { await browser?.close(); await mf.dispose(); }
