import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import vm from 'node:vm';
import { delimitedParser } from '../public/delimited.js';
import { editorPrecacheFiles } from './codemirror-precache.mjs';

const manifest = JSON.parse(await readFile('public/lib/codemirror/manifest.json', 'utf8'));
const pins = JSON.parse(await readFile('scripts/codemirror-packages.json', 'utf8'));
const fixtures = JSON.parse(await readFile('scripts/fixtures/languages.json', 'utf8'));

test('editor precache includes only the six default languages and their complete dependencies', async () => {
	assert.deepEqual(manifest.precache, await editorPrecacheFiles(manifest.imports));
	assert.ok(manifest.precache.every(path => manifest.files.includes(path)));
	assert.deepEqual(manifest.precache.filter(path => path.includes('/%40codemirror/lang-')),
		['css', 'html', 'javascript', 'json', 'markdown', 'python'].map(name => manifest.imports[`@codemirror/lang-${name}`]));
});

test('pinned CodeMirror ESM modules and licenses are present at versioned local URLs', async () => {
	assert.deepEqual(Object.keys(manifest.imports), Object.entries(pins).flatMap(([name, pin]) =>
		[name, ...Object.keys(pin.subpaths ?? {}).map(subpath => `${name}/${subpath}`)]));
	for (const [name, { version, entry }] of Object.entries(pins)) {
		const prefix = '/lib/codemirror/' + `${name}@${version}`.split('/').map(encodeURIComponent).join('/') + '/';
		const path = prefix + entry;
		assert.equal(manifest.imports[name], path);
		assert.ok(manifest.files.includes(path));
		assert.equal(manifest.sources[name].version, version);
		assert.match(manifest.sources[name].integrity, /^sha512-/);
		assert.ok((await readFile(`public${decodeURIComponent(path)}`, 'utf8')).length > 0);
		assert.match(await readFile(`public${decodeURIComponent(manifest.sources[name].license)}`, 'utf8'), /copyright/i);
		for (const [subpath, file] of Object.entries(pins[name].subpaths ?? {})) {
			assert.equal(manifest.imports[`${name}/${subpath}`], prefix + file);
			assert.ok(manifest.files.includes(manifest.imports[`${name}/${subpath}`]));
		}
	}
});

test('all vendored URLs use canonical path encoding to avoid asset redirects', () => {
	for (const path of [...Object.values(manifest.imports), ...manifest.files, ...manifest.precache,
		...Object.values(manifest.sources).map(source => source.license)]) {
		assert.equal(path, path.split('/').map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/'));
		assert.equal(path.includes('@'), false, path);
	}
});

test('the complete vendored graph resolves locally and language extensions share the core', async () => {
	const names = Object.keys(manifest.imports);
	const result = await build({ stdin: { contents: names.map((name, index) =>
		`export * as package${index} from ${JSON.stringify(name)};`).join('\n'), resolveDir: process.cwd() },
		bundle: true, write: false, format: 'esm', platform: 'browser', metafile: true,
		plugins: [{ name: 'local-codemirror-import-map', setup(build) {
			build.onResolve({ filter: /^[^./]/ }, ({ path }) => {
				assert.ok(manifest.imports[path], `Unmapped import: ${path}`);
				return { path: resolve(`public${decodeURIComponent(manifest.imports[path])}`) };
			});
		} }],
	});
	assert.deepEqual(Object.values(result.metafile.outputs)[0].imports, []);
	const packages = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
	const get = name => packages[`package${names.indexOf(name)}`];
	const { EditorState } = get('@codemirror/state');
	for (const [name, factory] of [
		['cpp', 'cpp'], ['css', 'css'], ['go', 'go'], ['html', 'html'], ['java', 'java'],
		['javascript', 'javascript'], ['json', 'json'], ['markdown', 'markdown'], ['php', 'php'],
		['python', 'python'], ['rust', 'rust'], ['sql', 'sql'], ['xml', 'xml'], ['yaml', 'yaml'],
	]) {
		const support = get(`@codemirror/lang-${name}`)[factory]();
		const state = EditorState.create({ doc: 'hello world', extensions: [support] });
		assert.ok(get('@codemirror/language').syntaxTree(state), name);
	}
	const typescript = get('@codemirror/lang-javascript').javascript({ typescript: true });
	assert.doesNotThrow(() => EditorState.create({ extensions: [typescript] }));
	// Exercise the composer loader with real vendored modules, including modes sharing clike.
	const cm = { ...get('@codemirror/language'), ...get('@codemirror/state'), ...get('@lezer/highlight') };
	const source = (await readFile('public/files.js', 'utf8')).replace(/^import .*;\r?\n/gm, '')
		.replace('export function createFileEditor', 'function createFileEditor').replaceAll('import(', 'loadModule(');
	const context = vm.createContext({ delimitedParser, loadModule: async name => {
		assert.ok(names.includes(name), `Unmapped language import: ${name}`);
		return get(name);
	} });
	context.cm = cm;
	vm.runInContext(source + '\ncodeMirrorPromise = Promise.resolve(globalThis.cm);', context);
	for (const { type, content } of fixtures) {
		const extension = await context.languageExtension(type);
		const state = EditorState.create({ doc: content, extensions: [extension] });
		assert.ok(state.facet(cm.language), `${type}: loader must not silently fall back to plaintext`);
		const tree = cm.syntaxTree(state);
		if (['jsonc', 'json5', 'scss', 'sass', 'less', 'xml'].includes(type)) {
			tree.iterate({ enter(node) { assert.ok(!node.type.isError, `${type}: valid fixture must parse without errors`); } });
		}
		const tokens = [];
		get('@lezer/highlight').highlightTree(tree, get('@lezer/highlight').classHighlighter,
			(from, to, classes) => tokens.push({ text: content.slice(from, to), classes }));
		assert.ok(tokens.length, `${type}: source must contain highlighted tokens`);
	}
});
