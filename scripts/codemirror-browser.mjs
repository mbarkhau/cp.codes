// Optional browser check: PLAYWRIGHT_MODULE may point to an external installation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const manifest = JSON.parse(await readFile('public/lib/codemirror/manifest.json', 'utf8'));
const vendorFiles = new Set(manifest.files);
const fixtures = JSON.parse(await readFile('scripts/fixtures/languages.json', 'utf8'));
const worker = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false,
	format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: worker.outputFiles[0].text,
	compatibilityDate: '2026-09-05', serviceBindings: { ASSETS: async request => {
		const path = new URL(request.url).pathname;
		// Mirror Workers Assets' canonical path redirects so the browser test
		// catches unencoded module URLs as well as missing files.
		const canonical = path.split('/').map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/');
		if (canonical !== path) return new Response(null, { status: 307, headers: { location: canonical } });
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
		if (path.startsWith('/lib/codemirror/') && response.status() >= 300 && response.status() < 400) failures.push(path);
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
	// Auto detection must update the parser after content edits, without changing the dropdown.
	const waitForLanguage = name => page.waitForFunction(async name => {
		const { language } = await import('@codemirror/language');
		return (document.querySelector('.editor-card').editorView.state.facet(language)?.name ?? null) === name;
	}, name, { timeout: 3000 });
	await page.locator('.cm-content').fill('ordinary text');
	await page.waitForFunction(() => document.querySelector('.editor-card').editorView.state.doc.toString() === 'ordinary text');
	await waitForLanguage(null);
	const yamlContent = fixtures.find(f => f.type === 'yaml').content;
	await page.locator('.cm-content').fill(yamlContent);
	assert.equal(await page.locator('.editor-type').inputValue(), 'auto');
	assert.equal(await page.locator('.editor-type option[value="auto"]').textContent(), 'Auto (YAML)');
	await waitForLanguage('yaml');
	await page.waitForFunction(() => [...document.querySelectorAll('.cm-line span')].some(span =>
		span.textContent === 'demo' && getComputedStyle(span).color !== getComputedStyle(document.querySelector('.cm-content')).color));
	await page.locator('.cm-content').fill('{"value": 42}');
	await waitForLanguage('json');
	await page.locator('.cm-content').fill('ordinary text');
	await waitForLanguage(null);
	await page.locator('.editor-type').selectOption('python');
	await waitForLanguage('python');
	await page.locator('.cm-content').fill(yamlContent);
	await waitForLanguage('python');
	await page.locator('.editor-type').selectOption('auto');
	await waitForLanguage('yaml');
	await page.evaluate(() => {
		const view = document.querySelector('.editor-card').editorView;
		for (const insert of ['{"value": 42}', 'name: demo\nquoted: hello\n', 'ordinary text']) {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert } });
		}
	});
	await waitForLanguage(null);
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
	for (const { type, content, languageName } of fixtures) {
		await page.locator('.editor-type').selectOption(type);
		await page.locator('.cm-content').fill(content);
		await page.waitForFunction(async name => {
			const { language } = await import('@codemirror/language');
			const active = document.querySelector('.editor-card').editorView.state.facet(language);
			return active?.name === name;
		}, languageName ?? (type === 'ini' ? 'properties' : type));
		await page.waitForFunction(() => [...document.querySelectorAll('.cm-line span')].some(span =>
			getComputedStyle(span).color !== getComputedStyle(document.querySelector('.cm-content')).color));
	}
	await page.locator('.editor-type').selectOption('auto');
	await page.locator('.editor-filename').fill('icon.SVG');
	await page.locator('.cm-content').fill('plain source text');
	await waitForLanguage('xml');
	await page.locator('.editor-filename').fill('unknown.txt');
	const svgSource = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 10"/></svg>';
	await page.locator('.cm-content').fill(svgSource);
	await waitForLanguage('xml');
	assert.equal(await page.locator('.editor-type option[value="auto"]').textContent(), 'Auto (XML)');
	assert.equal(await page.locator('.editor-mount img, .editor-mount svg').count(), 0);
	await page.locator('.editor-type').selectOption('plaintext');
	await waitForLanguage(null);
	// YAML plain values and anchors need theme tags beyond string/keyword.
	for (const theme of ['light', 'dark']) {
		await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
		await page.locator('.editor-type').selectOption('yaml');
		await page.locator('.cm-content').fill(fixtures.find(f => f.type === 'yaml').content);
		await page.waitForFunction(() => {
			const spans = [...document.querySelectorAll('.cm-line span')];
			const base = getComputedStyle(document.querySelector('.cm-content')).color;
			return ['name', 'demo', '"hello"', '&base', '# settings'].every(text =>
				spans.some(span => span.textContent === text && getComputedStyle(span).color !== base));
		});
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
	console.log(`Local CodeMirror editor and all 50 language modes passed, including YAML colors in both themes; ${requests.size} vendor modules loaded, zero external requests.`);
} finally {
	await browser?.close();
	await mf.dispose();
}
