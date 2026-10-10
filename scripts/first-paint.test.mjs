// Optional browser regression: run with the same Playwright setup as browser-smoke.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const compiled = await build({ entryPoints: ['src/ui.ts'], bundle: true, write: false, format: 'esm',
	plugins: [{ name: 'workers-stub', setup(build) {
		build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}' }));
	} }],
});
const ui = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const paste = { id: 'CP000000', created_at: '2026-10-10T00:00:00Z', content_type: 'plaintext',
	byte_length: 5, compressed_byte_length: 5, content_encoding: 'identity', sha256: '0'.repeat(64) };
const server = createServer(async (request, response) => {
	const path = new URL(request.url, 'http://localhost').pathname;
	if (path === '/' || path === '/CP000000') {
		response.setHeader('content-type', 'text/html');
		response.end(await (path === '/' ? ui.newPage() : ui.viewPage(paste, 0)).text());
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
	for (const [path, module] of [['/', 'app'], ['/CP000000', 'view']]) {
		for (const theme of ['light', 'dark']) {
			for (const held of [module, 'files']) {
				const context = await browser.newContext();
				await context.addInitScript(theme => localStorage.setItem('cp.codes.theme', theme), theme);
				const page = await context.newPage();
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
					await requestStarted;
					await page.waitForFunction(() => performance.getEntriesByName('first-contentful-paint').length > 0, null, { timeout: 3000 });
					assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
					await page.locator('.logo').waitFor({ state: 'visible' });
					await page.getByRole('navigation', { name: 'Primary navigation' }).waitFor({ state: 'visible' });
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
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
