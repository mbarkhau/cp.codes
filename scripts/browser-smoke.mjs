// Optional browser smoke test. Install playwright separately; no paid AI calls.
// PLAYWRIGHT_MODULE may point to an external playwright/index.mjs installation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { CRITERIA, MODEL } from '../src/jev.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const editorManifest = JSON.parse(await readFile(new URL('../public/lib/codemirror/manifest.json', import.meta.url), 'utf8'));
const vendorAssets = new Set(['lib/uqr-0.1.2.js', 'lib/markdown-it-14.1.0.js', 'lib/hash-wasm-4.12.0.js',
	...editorManifest.files.map(path => path.slice(1))]);
const compiled = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: compiled.outputFiles[0].text,
	compatibilityDate: '2026-09-05', bindings: { POW_DIFFICULTY_BITS: '0', DEFAPI_KEY: 'fake-test-key', STAFF_ALLOW_DEVELOPMENT_LOGIN: 'true' }, r2Buckets: ['PASTES'],
	durableObjects: Object.fromEntries(['PASTE_INDEX:PasteIndex', 'POW_KEY:PowKey', 'MONO_CLOCK:MonoClock', 'STAFF_SESSIONS:StaffSession'].map(value => {
		const [binding, className] = value.split(':'); return [binding, { className, useSQLite: true }];
	})),
	serviceBindings: { ASSETS: async request => {
		const path = new URL(request.url).pathname.slice(1);
		if (!/^[a-z_]+\.(js|css)$/.test(path) && !vendorAssets.has(path)) return new Response('', { status: 404 });
		try { return new Response(await readFile(join(process.cwd(), 'public', decodeURIComponent(path))), { headers: { 'content-type': path.endsWith('.js') ? 'application/javascript' : 'text/css' } }); }
		catch { return new Response('', { status: 404 }); }
	} },
	outboundService: async () => new Response(JSON.stringify({ model: MODEL, answers: { category: { type: 'choice', choice: 'code',
		probabilities: Object.fromEntries(Object.keys(CRITERIA).map(key => [key, key === 'code' ? 1 : 0])) } } })),
}));
function luminance(color) {
	const channels = color.match(/[\d.]+/g).slice(0, 3).map(value => {
		const channel = Number(value) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(foreground, background) {
	const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
	return (values[0] + 0.05) / (values[1] + 0.05);
}

async function actionIcon(locator) {
	return locator.evaluate(button => {
		const style = getComputedStyle(button, '::before');
		const url = style.maskImage.match(/^url\("([^"]+)"\)$/)?.[1];
		const svg = url?.startsWith('data:image/svg+xml,')
			? new DOMParser().parseFromString(decodeURIComponent(url.slice(url.indexOf(',') + 1)), 'image/svg+xml')
			: null;
		return { color: style.backgroundColor, width: style.width, height: style.height,
			strokeWidth: svg?.documentElement.getAttribute('stroke-width'),
			path: svg?.querySelector('path')?.getAttribute('d') };
	});
}

async function checkThemeInitialization(browser, origin, errors) {
	for (const scenario of [
		{ path: '/about', saved: 'dark', expected: 'dark' },
		{ path: '/login', saved: 'dark', expected: 'dark' },
		{ path: '/about', saved: 'light', expected: 'light' },
		{ path: '/about', saved: 'invalid', expected: 'light' },
		{ path: '/about', blocked: true, expected: 'light' },
	]) {
		const context = await browser.newContext();
		await context.addInitScript(({ saved, blocked }) => {
			if (blocked) Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
			else if (saved && localStorage.getItem('cp.codes.theme') === null) localStorage.setItem('cp.codes.theme', saved);
		}, scenario);
		const page = await context.newPage();
		page.on('pageerror', error => errors.push(error.message));
		const requests = [];
		page.on('request', request => requests.push(new URL(request.url()).pathname));
		try {
			await page.goto(origin + scenario.path);
			await page.waitForFunction(() => performance.getEntriesByName('first-contentful-paint').length > 0);
			assert.equal(requests.includes('/site.js'), true);
			assert.equal(requests.includes('/style.css'), true);
			assert.equal(await page.getByRole('navigation', { name: 'Primary navigation' }).count(), 1);
			assert.equal(await page.locator('.footer li').count(), 4);
			assert.equal(await page.locator('#theme-toggle').count(), 1);
			assert.equal(await page.locator('#theme-toggle svg').count(), 2);
			assert.equal(await page.locator('html').getAttribute('data-theme'), scenario.expected);
			assert.equal(await page.locator('#theme-toggle').getAttribute('aria-pressed'), String(scenario.expected === 'dark'));
			const next = scenario.expected === 'dark' ? 'light' : 'dark';
			await page.getByRole('button', { name: `Switch to ${next} mode`, exact: true }).click();
			assert.equal(await page.locator('html').getAttribute('data-theme'), next);
			await page.reload();
			assert.equal(await page.locator('html').getAttribute('data-theme'), scenario.blocked ? 'light' : next);
		} finally {
			await context.close();
		}
	}
}

async function checkThemeHierarchy(page, selector, screenshots = false) {
	for (const theme of ['light', 'dark']) {
		if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
		const styles = await page.evaluate(selector => {
			const primary = document.querySelector(selector);
			const card = primary.closest('.card');
			const read = element => {
				const style = getComputedStyle(element);
				return { bg: style.backgroundColor, fg: style.color, shadow: style.boxShadow };
			};
			const cardStyle = read(card);
			if (cardStyle.shadow === 'none' && primary.closest('#paste-content')) cardStyle.shadow = read(primary.closest('#paste-content')).shadow;
			return {
				primary: read(primary), card: cardStyle, page: read(document.body),
				control: read(document.querySelector('.editor-filename, .icon-action')),
				meta: read(document.querySelector('.meta')),
				tokens: [...primary.querySelectorAll('.cm-line span, .hljs span')].map(element => getComputedStyle(element).color),
			};
		}, selector);
		assert.equal(styles.primary.bg, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
		assert.equal(styles.primary.fg, theme === 'light' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
		assert.equal(contrast(styles.primary.fg, styles.primary.bg), 21);
		assert.notEqual(styles.card.shadow, 'none');
		const backgrounds = [styles.primary.bg, styles.control.bg, styles.card.bg, styles.page.bg].map(luminance);
		for (let i = 1; i < backgrounds.length; i++) {
			assert.ok(theme === 'light' ? backgrounds[i - 1] > backgrounds[i] : backgrounds[i - 1] < backgrounds[i], theme);
		}
		const controlContrast = contrast(styles.control.fg, styles.control.bg);
		const metaContrast = contrast(styles.meta.fg, styles.card.bg);
		assert.ok(controlContrast >= 4.5 && controlContrast < 21);
		assert.ok(metaContrast >= 4.5 && metaContrast < controlContrast);
		for (const color of styles.tokens) assert.ok(contrast(color, styles.primary.bg) >= 4.5, `${theme}: ${color}`);
		if (screenshots) await page.screenshot({ path: `/tmp/cp-codes-hierarchy-${theme}.png`, fullPage: true });
	}
	await page.locator('#theme-toggle').click(); // Restore light mode for subsequent tests.
}
async function checkEditorTheme(context, origin, errors) {
	const page = await context.newPage();
	page.on('pageerror', error => errors.push(error.message));
	let releaseCodeMirror;
	const ready = new Promise(resolve => { releaseCodeMirror = resolve; });
	await page.route(url => url.pathname === editorManifest.imports['@codemirror/view'], async route => {
		await ready;
		await route.continue();
	});
	try {
		await page.goto(origin);
		await page.locator('.editor-filename').fill('example.js');
		await page.locator('.editor-fallback').fill('const answer = 42;\nconsole.log("hello", answer); // A comment');
		await checkThemeHierarchy(page, '.editor-fallback');
		releaseCodeMirror();
		await page.locator('.cm-editor').waitFor();
		await page.waitForFunction(() => document.querySelector('.cm-line span'));
		await checkThemeHierarchy(page, '.cm-editor', true);
	} finally {
		releaseCodeMirror();
		await page.close();
	}
}

async function checkEditorPlaceholder(context, origin, errors) {
	const page = await context.newPage();
	page.on('pageerror', error => errors.push(error.message));
	let releaseEditor;
	const ready = new Promise(resolve => { releaseEditor = resolve; });
	await page.route('**/app.js?*', async route => {
		await ready;
		await route.continue();
	});
	try {
		await page.goto(origin, { waitUntil: 'commit' });
		await page.locator('.editor-placeholder').waitFor();
		assert.equal(await page.locator('.editor-placeholder').getAttribute('aria-hidden'), 'true');
		assert.ok((await page.locator('.editor-placeholder').boundingBox()).height >= 320);
		const before = await page.locator('.composer-actions').boundingBox();
		releaseEditor();
		await page.locator('.editor-fallback, .cm-content').first().waitFor();
		assert.equal(await page.locator('.editor-placeholder').count(), 0);
		assert.equal(await page.locator('.editor-card').count(), 1);
		assert.equal((await page.locator('.composer-actions').boundingBox()).y, before.y);
		await page.locator('.cm-content').waitFor();
		assert.equal((await page.locator('.composer-actions').boundingBox()).y, before.y);
	} finally {
		releaseEditor();
		await page.close();
	}
}

async function checkEditorFocus(context, origin, errors) {
	for (const keepFocus of [true, false]) {
		const page = await context.newPage();
		page.on('pageerror', error => errors.push(error.message));
		let releaseCodeMirror;
		const ready = new Promise(resolve => { releaseCodeMirror = resolve; });
		await page.route(url => url.pathname === editorManifest.imports['@codemirror/view'], async route => {
			await ready;
			await route.continue();
		});
		try {
			await page.goto(origin);
			const fallback = page.locator('.editor-fallback').first();
			await fallback.fill('alpha\nbeta\ngamma');
			await fallback.evaluate(element => element.setSelectionRange(1, 4, 'backward'));
			if (!keepFocus) await page.locator('.editor-filename').first().focus();
			releaseCodeMirror();
			await page.locator('.cm-content').first().waitFor();
			const first = page.locator('.editor-card').first();
			assert.equal(await first.evaluate(card => card.editorView.hasFocus), keepFocus);
			assert.deepEqual(await first.evaluate(card => {
				const { anchor, head } = card.editorView.state.selection.main;
				return { anchor, head };
			}), { anchor: 4, head: 1 });
			if (!keepFocus) {
				assert.equal(await page.locator('.editor-filename').first().evaluate(element => document.activeElement === element), true);
				continue;
			}
			await page.keyboard.type('Z');
			assert.equal(await first.evaluate(card => card.editorView.state.doc.toString()), 'aZa\nbeta\ngamma');
			await first.locator('.cm-content').fill('alpha\nbeta\ngamma');
			// Text selection must still be handled by CodeMirror, not our surface click handler.
			await first.locator('.cm-line').first().dblclick({ position: { x: 20, y: 10 } });
			assert.equal(await first.evaluate(card => {
				const { from, to } = card.editorView.state.selection.main;
				return card.editorView.state.sliceDoc(from, to);
			}), 'alpha');
			await first.locator('.editor-filename').fill('first.txt');
			await page.locator('#add-text').click();
			await page.waitForFunction(() => document.querySelectorAll('.cm-content').length === 2);
			const second = page.locator('.editor-card').nth(1);
			assert.equal(await second.evaluate(card => card.editorView.hasFocus), true);
			await page.keyboard.type('second');
			assert.equal(await second.evaluate(card => card.editorView.state.doc.toString()), 'second');
			for (const card of [first, second, first]) {
				await card.locator('.editor-mount').scrollIntoViewIfNeeded();
				const mount = await card.locator('.editor-mount').boundingBox();
				const scroller = await card.locator('.cm-scroller').boundingBox();
				const content = await card.locator('.cm-content').boundingBox();
				for (const [x, y] of [
					[content.x + 100, scroller.y + scroller.height - 16], // Below the text.
					[scroller.x + 3, scroller.y + scroller.height - 16], // Blank gutter area.
					[scroller.x + 3, scroller.y + 12], // Line-number gutter.
					[mount.x + 1, mount.y + mount.height - 12], // Outer padding.
				]) {
					await card.locator('.editor-filename').focus();
					for (let repeat = 0; repeat < 2; repeat++) {
						await page.mouse.click(x, y);
						assert.equal(await card.evaluate(element => element.editorView.hasFocus), true);
					}
				}
			}
		} finally {
			releaseCodeMirror();
			await page.close();
		}
	}
}

let browser;
try {
	const origin = (await mf.ready).origin;
	browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
	const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
	const errors = [];
	await checkThemeInitialization(browser, origin, errors);
	await checkEditorTheme(context, origin, errors);
	await checkEditorPlaceholder(context, origin, errors);
	await checkEditorFocus(context, origin, errors);
	const page = await context.newPage();
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(origin);
	const codeFilename = 'résumé & "><img src=x onerror=window.dialogInjected=1>.js';
	const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
	const media = JSON.parse(await readFile('scripts/fixtures/media.json', 'utf8'));
	await page.locator('.editor-filename').first().fill('readme.md');
	await page.locator('.cm-content, .editor-fallback').first().fill(`# My document\n\n![Diagram](diagram.png)\n\n[Code](${encodeURIComponent(codeFilename)})`);
	await page.locator('#file-input').setInputFiles([
		{ name: 'diagram.png', mimeType: 'image/png', buffer: pngBytes },
		{ name: 'animation.gif', mimeType: 'image/gif', buffer: Buffer.from(media.gif89, 'base64') },
		{ name: codeFilename, mimeType: 'text/javascript', buffer: Buffer.from('console.log("hello");') },
	]);
	await page.waitForFunction(() => document.querySelectorAll('.editor-card').length === 4);
	await page.locator('.cm-content, .editor-fallback').first().focus();
	assert.equal(await page.locator('#preview-file, #draft-preview').count(), 0);
	await page.screenshot({ path: '/tmp/cp-codes-composer.png', fullPage: true });
	await page.locator('#consent').check(); await page.locator('#consent-moderation').check(); await page.locator('#publish').click();
	await page.waitForURL(url => /^\/CP[A-Z0-9]+$/.test(url.pathname));
	const id = new URL(page.url()).pathname.slice(1);
	assert.equal(await page.locator('#upload-result, #authorize-paste, #saved-authorization, #paste-delete').count(), 0);
	assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('cp.codes.authorization.'))), false);
	assert.match(await page.locator('h1').innerText(), /Human review/);
	await page.goto(`${origin}/login`); await page.locator('#username').fill('admin'); await page.locator('#password').fill('4dm1n');
	await page.getByRole('button', { name: 'Log in', exact: true }).click(); await page.waitForURL('**/admin/pastes');
	await page.goto(`${origin}/about`);
	assert.equal(await page.locator('.staff-nav-start, .nav-logout').count(), 2);
	assert.match(await page.evaluate(() => document.cookie), /(?:^|; )cp_staff_nav=1(?:;|$)/);
	assert.doesNotMatch(await page.evaluate(() => document.cookie), /(?:^|; )cp_session=/);
	await page.goto(`${origin}/admin/paste/${id}/view`);
	await page.waitForFunction(() => document.querySelector('#paste-content img')?.naturalWidth === 1);
	await page.getByRole('tab', { name: codeFilename, exact: true }).click();
	await page.waitForFunction(() => document.querySelector('#paste-content').textContent.includes('console.log'));
	await page.getByRole('tab', { name: 'readme.md', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('#paste-content img')?.naturalWidth === 1);
	await page.getByRole('button', { name: 'Approve public access', exact: true }).click(); await page.waitForURL('**/admin/pastes');
	const anon = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
	const viewer = await anon.newPage(); viewer.on('pageerror', error => errors.push(error.message));
	const viewResponse = await viewer.goto(`${origin}/${id}`);
	const viewHtml = await viewResponse.text();
	assert.match(viewHtml, /<div class="paste-toolbar"><\/div>/);
	assert.doesNotMatch(viewHtml, /id="copy-link"|id="copy-paste"/);
	assert.equal(await viewer.locator('.paste-head > .paste-toolbar').count(), 1);
	await viewer.waitForFunction(() => document.querySelector('#paste-content img')?.naturalWidth === 1);
	assert.equal(await viewer.locator('.sharing-banner, #selected-file-info').count(), 0);
	assert.equal(await viewer.locator('#paste-file-nav button').count(), 4);
	assert.equal(await viewer.locator('.paste-actions .icon-action svg').count(), 0);
	assert.equal(await viewer.locator('.paste-actions .icon-action[data-icon]').count(), 5);
	assert.deepEqual(await viewer.locator('.paste-actions > .icon-action').evaluateAll(actions => actions.map(action => action.id)),
		['copy-link', 'raw-paste', 'copy-paste', 'open-details', 'open-report']);
	const copyIcon = await actionIcon(viewer.locator('#copy-paste'));
	assert.equal(copyIcon.strokeWidth, '1.7');
	assert.ok(Math.abs(parseFloat(copyIcon.width) - 19.2) < 0.02);
	assert.equal(copyIcon.height, copyIcon.width);
	assert.equal(copyIcon.path, 'M 6 17 A 2 2 0 0 1 4 15 V 4 A 2 2 0 0 1 6 2 H 14 A 2 2 0 0 1 16 4 M 11 6 H 18 A 2 2 0 0 1 20 8 V 19 A 2 2 0 0 1 18 21 H 10 A 2 2 0 0 1 8 19 V 8 A 2 2 0 0 1 10 6 Z M 11 10 H 17 M 11 13 H 17 M 11 16 H 16 Z');
	assert.equal((await actionIcon(viewer.locator('#raw-paste'))).path, 'M 7 6 L 2 12 L 7 18 M 17 6 L 22 12 L 17 18 M 14 4 L 10 20');
	assert.equal((await actionIcon(viewer.locator('#copy-link'))).path, 'M 16 12 L 7 12 M 9 16 L 8 17 A 4 4 0 0 1 2 11 L 6 7 A 4 4 0 0 1 12 7 M 14 8 L 15 7 A 4 4 0 0 1 21 13 L 17 17 A 4 4 0 0 1 11 17');
	for (const theme of ['light', 'dark']) {
		if (await viewer.locator('html').getAttribute('data-theme') !== theme) await viewer.locator('#theme-toggle').click();
		await viewer.locator('#open-report').hover();
		const report = await viewer.locator('#open-report').evaluate(button => {
			const style = getComputedStyle(button);
			return { fg: style.color, bg: style.backgroundColor, icon: getComputedStyle(button, '::before').backgroundColor };
		});
		assert.equal(report.fg, 'rgb(255, 255, 255)');
		assert.equal(report.icon, report.fg);
		assert.equal(report.bg, 'rgb(155, 79, 89)');
		assert.ok(contrast(report.fg, report.bg) >= 4.5);
		await viewer.locator('.paste-actions').screenshot({ path: `/tmp/cp-codes-actions-${theme}.png` });
		await viewer.mouse.move(0, 0);
	}
	await viewer.locator('#theme-toggle').click();
	await viewer.evaluate(() => {
		window.copiedText = null;
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
			writeText: async text => { window.copiedText = text; },
			write: async items => {
				const blob = await items[0].getType('image/png');
				const bitmap = await createImageBitmap(blob);
				window.copiedImage = {
					type: blob.type, width: bitmap.width, height: bitmap.height,
					bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
				};
				bitmap.close();
			},
		} });
	});
	for (const filename of ['diagram.png', 'animation.gif']) {
		await viewer.getByRole('tab', { name: filename, exact: true }).click();
		await viewer.waitForFunction(() => document.querySelector('#paste-content .paste-image')?.naturalWidth === 1);
		await viewer.evaluate(() => { window.copiedImage = null; });
		await viewer.getByRole('button', { name: 'Copy image', exact: true }).click();
		await viewer.waitForFunction(() => window.copiedImage !== null || document.querySelector('.paste-action-status').classList.contains('err'));
		const copied = await viewer.evaluate(() => window.copiedImage);
		assert.ok(copied, await viewer.locator('#paste-action-status').innerText());
		assert.equal(copied.type, 'image/png');
		assert.equal(copied.width, 1); assert.equal(copied.height, 1);
		assert.deepEqual(Buffer.from(copied.bytes).subarray(0, 8), pngBytes.subarray(0, 8));
		if (filename === 'diagram.png') assert.deepEqual(Buffer.from(copied.bytes), pngBytes);
		assert.equal(await viewer.evaluate(() => window.copiedText), null);
		assert.equal(await viewer.locator('#paste-action-status').innerText(), 'Image copied.');
	}
	await viewer.getByRole('tab', { name: codeFilename, exact: true }).click();
	await viewer.waitForFunction(() => document.querySelector('#paste-content').textContent.includes('console.log'));
	await viewer.waitForFunction(() => document.querySelector('#paste-content .hljs'));
	await checkThemeHierarchy(viewer, '#paste-content pre.paste');
	assert.equal(await viewer.locator('#raw-paste').getAttribute('href'), `/${id}/files/${encodeURIComponent(codeFilename)}`);
	assert.equal(await viewer.locator('#paste-file-nav').evaluate(nav => nav.parentElement.classList.contains('paste-card') && nav.nextElementSibling.id === 'paste-content'), true);
	assert.equal(await viewer.getByRole('tab', { name: codeFilename }).getAttribute('aria-selected'), 'true');
	for (const width of [390, 240]) {
		await viewer.setViewportSize({ width, height: 844 });
		await viewer.waitForFunction(() => document.querySelector('#paste-file-nav').classList.contains('tabs-overflowing'));
		const sizes = await viewer.locator('#paste-file-nav').evaluate(nav => {
			const selected = nav.querySelector('[aria-selected="true"] > span');
			return {
				readable: selected.scrollWidth <= selected.clientWidth && selected.scrollHeight <= selected.clientHeight,
				others: [...nav.querySelectorAll('[aria-selected="false"]')].map(tab => tab.getBoundingClientRect().width),
			};
		});
		assert.equal(sizes.readable, true);
		assert.ok(Math.max(...sizes.others) - Math.min(...sizes.others) <= 1);
		assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	}
	await viewer.getByRole('tab', { name: codeFilename }).focus();
	await viewer.keyboard.press('Home');
	await viewer.waitForFunction(() => document.querySelector('#paste-content h1')?.textContent === 'My document');
	assert.equal(await viewer.getByRole('tab', { name: 'readme.md' }).getAttribute('aria-selected'), 'true');
	await viewer.keyboard.press('End');
	await viewer.waitForFunction(() => document.querySelector('#paste-content').textContent.includes('console.log'));
	assert.equal(await viewer.getByRole('tab', { name: codeFilename }).getAttribute('aria-selected'), 'true');
	await viewer.setViewportSize({ width: 1280, height: 1000 });
	await viewer.waitForFunction(() => !document.querySelector('#paste-file-nav').classList.contains('tabs-overflowing'));
	const actionsBefore = await viewer.locator('.paste-actions').boundingBox();
	const contentBefore = await viewer.locator('.paste-card').boundingBox();
	const toolbarBefore = await viewer.locator('.paste-toolbar').boundingBox();
	assert.equal(actionsBefore.x + actionsBefore.width, toolbarBefore.x + toolbarBefore.width);
	await viewer.getByRole('button', { name: 'Copy content', exact: true }).click();
	await viewer.waitForFunction(() => window.copiedText === 'console.log("hello");');
	assert.ok((await actionIcon(viewer.locator('#copy-paste'))).path);
	assert.equal(await viewer.locator('#paste-action-status').innerText(), 'Content copied.');
	const feedback = await viewer.locator('#paste-action-status').boundingBox();
	assert.ok(feedback.x + feedback.width <= actionsBefore.x);
	assert.deepEqual(await viewer.locator('.paste-actions').boundingBox(), actionsBefore);
	assert.deepEqual(await viewer.locator('.paste-card').boundingBox(), contentBefore);
	await viewer.waitForTimeout(4000);
	assert.equal(await viewer.locator('#paste-action-status').evaluate(status => status.classList.contains('is-fading')), false);
	await viewer.getByRole('button', { name: 'Copy link', exact: true }).click();
	const selectedLink = `${origin}/${id}#file-${encodeURIComponent(codeFilename)}`;
	await viewer.waitForFunction(expected => window.copiedText === expected, selectedLink);
	assert.equal(new URL(viewer.url()).hash, `#file-${encodeURIComponent(codeFilename)}`);
	assert.equal(await viewer.locator('#paste-action-status').innerText(), 'Link copied.');
	await viewer.waitForTimeout(2000);
	assert.equal(await viewer.locator('#paste-action-status').evaluate(status => status.classList.contains('is-fading')), false);
	assert.equal(await viewer.locator('#paste-action-status').innerText(), 'Link copied.');
	await viewer.waitForFunction(() => document.querySelector('#paste-action-status').classList.contains('is-fading'));
	await viewer.waitForFunction(() => getComputedStyle(document.querySelector('#paste-action-status')).opacity === '0');
	await viewer.waitForFunction(() => document.querySelector('#paste-action-status').textContent === '');
	assert.deepEqual(await viewer.locator('.paste-actions').boundingBox(), actionsBefore);
	assert.deepEqual(await viewer.locator('.paste-card').boundingBox(), contentBefore);
	const linked = await anon.newPage(); linked.on('pageerror', error => errors.push(error.message));
	await linked.goto(selectedLink);
	await linked.waitForFunction(() => document.querySelector('#paste-content').textContent.includes('console.log'));
	assert.equal(await linked.getByRole('tab', { name: codeFilename }).getAttribute('aria-selected'), 'true');
	assert.equal(await linked.locator('#qr').count(), 0);
	await linked.locator('#open-details').click();
	await linked.waitForFunction(() => document.querySelector('#qr')?.naturalWidth > 0);
	await linked.keyboard.press('Escape');
	await linked.reload();
	await linked.waitForFunction(() => document.querySelector('#paste-content').textContent.includes('console.log'));
	await linked.locator('#open-details').click();
	await linked.waitForFunction(() => document.querySelector('#qr')?.naturalWidth > 0);
	assert.equal(await linked.locator('#qr').getAttribute('data-qr-cache-hit'), 'true');
	await linked.keyboard.press('Escape');
	await linked.evaluate(() => {
		const id = document.querySelector('#paste-content').dataset.cpCode;
		const entries = JSON.parse(localStorage.getItem('cp.codes.paste.v1'));
		entries.find(entry => entry.id === id).qr.dataUrl = 'data:image/png;base64,AAAA';
		localStorage.setItem('cp.codes.paste.v1', JSON.stringify(entries));
	});
	await linked.reload();
	await linked.waitForFunction(() => document.querySelector('#paste-content').textContent.includes('console.log'));
	await linked.locator('#open-details').click();
	await linked.waitForFunction(() => document.querySelector('#qr')?.naturalWidth > 0);
	assert.equal(await linked.locator('#qr').getAttribute('data-qr-cache-hit'), null);
	await linked.keyboard.press('Escape');
	await linked.evaluate(() => { location.hash = '#file-readme.md'; });
	await linked.waitForFunction(() => document.querySelector('#paste-content h1')?.textContent === 'My document');
	await linked.locator('#paste-content a').filter({ hasText: 'Code' }).click();
	await linked.waitForFunction(() => document.querySelector('#paste-content').textContent.includes('console.log'));
	await linked.evaluate(() => { location.hash = '#file-%E0%A4%A'; });
	await linked.waitForFunction(() => document.querySelector('#paste-content h1')?.textContent === 'My document');
	await linked.close();
	await viewer.getByRole('button', { name: 'Paste details', exact: true }).click();
	assert.equal(await viewer.locator('#paste-details-dialog').evaluate(dialog => dialog.open), true);
	assert.equal(await viewer.locator('#paste-details-dialog .paste-file-metadata').count(), 4);
	assert.match(await viewer.locator('#paste-details-dialog').innerText(), /SHA-256/);
	assert.ok((await viewer.locator('#paste-details-dialog').innerText()).includes(codeFilename));
	assert.equal(await viewer.locator('.paste-file-metadata img, [onerror]').count(), 0);
	assert.equal(await viewer.evaluate(() => window.dialogInjected), undefined);
	const downloads = await viewer.locator('.paste-file-metadata .file-download').evaluateAll(links =>
		links.map(link => ({ href: link.href, download: link.download, hidden: link.parentElement.hidden })));
	assert.ok(downloads.every(link => link.href.startsWith('blob:') && !link.hidden));
	assert.ok(downloads.some(link => link.download === codeFilename));
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
	await viewer.getByRole('tab', { name: 'readme.md', exact: true }).click();
	await viewer.waitForFunction(() => document.querySelector('#paste-content img')?.naturalWidth === 1);
	await checkThemeHierarchy(viewer, '#paste-content .markdown-body');
	await viewer.screenshot({ path: '/tmp/cp-codes-viewer.png', fullPage: true });
	await viewer.goto(origin); await viewer.locator('.cm-content, .editor-fallback').first().fill('# A harmless text-only paste');
	await viewer.locator('#consent').check(); await viewer.locator('#consent-moderation').check(); await viewer.locator('#publish').click();
	await viewer.waitForURL(url => /^\/CP[A-Z0-9]+$/.test(url.pathname));
	await viewer.waitForFunction(() => document.querySelector('#paste-content h1')?.textContent === 'A harmless text-only paste');
	assert.equal(await viewer.locator('.sharing-banner, #selected-file-info').count(), 0);
	assert.equal(await viewer.locator('#paste-file-nav [role="tab"]').count(), 1);
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
	await viewer.getByRole('button', { name: 'Report paste', exact: true }).click();
	const reportBefore = await viewer.locator('#report-dialog').boundingBox();
	await viewer.getByRole('button', { name: 'Submit report', exact: true }).click();
	await viewer.waitForFunction(() => document.querySelector('#report-status').textContent.includes('Report submitted'));
	assert.deepEqual(await viewer.locator('#report-dialog').boundingBox(), reportBefore);
	await viewer.getByRole('button', { name: 'Close report', exact: true }).click();
	await viewer.goto(`${origin}/pastes`);
	for (const theme of ['light', 'dark']) {
		if (await viewer.locator('html').getAttribute('data-theme') !== theme) await viewer.locator('#theme-toggle').click();
		const list = await viewer.locator('.recent-list').evaluate(element => {
			const style = getComputedStyle(element);
			return {
				bg: style.backgroundColor, fg: style.color,
				filename: getComputedStyle(element.querySelector('.recent-filename')).color,
				meta: getComputedStyle(element.querySelector('.recent-meta')).color,
				shadow: getComputedStyle(element.closest('.card')).boxShadow,
			};
		});
		assert.equal(list.bg, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
		assert.equal(contrast(list.fg, list.bg), 21);
		assert.equal(list.filename, list.fg);
		assert.ok(contrast(list.meta, list.bg) >= 4.5 && contrast(list.meta, list.bg) < 21);
		assert.notEqual(list.shadow, 'none');
		await viewer.screenshot({ path: `/tmp/cp-codes-list-${theme}.png`, fullPage: true });
	}
	await viewer.locator('#theme-toggle').click();
	await viewer.setViewportSize({ width: 390, height: 844 }); await viewer.goto(origin);
	await viewer.waitForFunction(() => document.querySelectorAll('.editor-card').length === 1);
	assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	await viewer.locator('#theme-toggle').click(); assert.equal(await viewer.locator('html').getAttribute('data-theme'), 'dark');
	await viewer.screenshot({ path: '/tmp/cp-codes-mobile.png', fullPage: true });
	await page.goto(`${origin}/about`);
	await page.getByRole('button', { name: 'log out', exact: true }).click();
	await page.waitForURL('**/login');
	await page.goto(`${origin}/about`);
	assert.equal(await page.locator('.staff-nav-start, .nav-logout').count(), 0);
	assert.doesNotMatch(await page.evaluate(() => document.cookie), /(?:^|; )cp_staff_nav=1(?:;|$)/);
	assert.deepEqual(errors, []);
	console.log('Browser smoke passed: image/text clipboard, responsive file tabs/deep links, theme hierarchy/contrast, editor placeholder/layout, focus/selection, files, media review, staff inspection/approval, sibling images, limited text sharing, mobile layout and dark mode.');
} finally { await browser?.close(); await mf.dispose(); }
