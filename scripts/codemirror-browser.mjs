// Optional browser check: PLAYWRIGHT_MODULE may point to an external installation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const manifest = JSON.parse(await readFile('public/lib/codemirror/manifest.json', 'utf8'));
const vendorFiles = new Set(manifest.files);
const worker = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false,
	format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: worker.outputFiles[0].text,
	compatibilityDate: '2026-09-05', serviceBindings: { ASSETS: async request => {
		const path = new URL(request.url).pathname;
		if (!/^\/[a-z_0-9-]+\.(js|css|png|svg)$/.test(path) && !vendorFiles.has(path)) return new Response('', { status: 404 });
		try {
			return new Response(await readFile(new URL(`../public${path}`, import.meta.url)), {
				headers: { 'content-type': path.endsWith('.js') ? 'application/javascript' :
					path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'image/png' },
			});
		} catch { return new Response('', { status: 404 }); }
	} },
}));
let browser;
try {
	const origin = (await mf.ready).origin;
	browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
		executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
	const page = await browser.newPage();
	const external = [], failures = [], errors = [], requests = new Set();
	page.on('pageerror', error => errors.push(error.message));
	page.on('response', response => {
		const path = new URL(response.url()).pathname;
		if (!vendorFiles.has(path)) return;
		requests.add(path);
		if (response.status() !== 200 || response.headers()['cache-control'] !== 'public, max-age=31536000, immutable') failures.push(path);
	});
	await page.route('**/*', async route => {
		if (new URL(route.request().url()).origin !== origin) {
			external.push(route.request().url());
			await route.abort();
		} else await route.continue();
	});
	await page.goto(`${origin}/new`);
	await page.locator('.cm-editor').waitFor();
	assert.ok(![...requests].some(path => path.includes('/lang-')), 'Language support should remain lazy');
	await page.locator('.cm-content').fill('const example = 42;');
	for (const [type, packageName, factory, options] of [
		['javascript', 'javascript', 'javascript'], ['typescript', 'javascript', 'javascript', { typescript: true }],
		['python', 'python', 'python'], ['java', 'java', 'java'], ['json', 'json', 'json'],
		['html', 'html', 'html'], ['css', 'css', 'css'], ['sql', 'sql', 'sql'],
		['yaml', 'yaml', 'yaml'], ['xml', 'xml', 'xml'], ['c', 'cpp', 'cpp'], ['cpp', 'cpp', 'cpp'],
		['rust', 'rust', 'rust'], ['go', 'go', 'go'], ['php', 'php', 'php'], ['markdown', 'markdown', 'markdown'],
	]) {
		await page.locator('.editor-type').selectOption(type);
		const name = await page.evaluate(async ([packageName, factory, options]) => {
			const module = await import(`@codemirror/lang-${packageName}`);
			return module[factory](options).language.name;
		}, [packageName, factory, options]);
		await page.waitForFunction(async name => {
			const { language } = await import('@codemirror/language');
			return document.querySelector('.editor-card').editorView.state.facet(language)?.name === name;
		}, name);
		assert.ok(requests.has(manifest.imports[`@codemirror/lang-${packageName}`]), type);
	}
	assert.equal(await page.evaluate(async () => {
		const { EditorView } = await import('@codemirror/view');
		const { EditorState } = await import('@codemirror/state');
		const view = document.querySelector('.editor-card').editorView;
		return view instanceof EditorView && view.state instanceof EditorState;
	}), true);
	assert.deepEqual(external, []);
	assert.deepEqual(failures, []);
	assert.deepEqual(errors, []);
	console.log(`Local CodeMirror editor and all 16 language modes passed; ${requests.size} vendor modules loaded, zero external requests.`);
} finally {
	await browser?.close();
	await mf.dispose();
}
