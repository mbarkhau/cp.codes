import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const manifest = JSON.parse(await readFile('public/lib/codemirror/manifest.json', 'utf8'));
const pins = JSON.parse(await readFile('scripts/codemirror-packages.json', 'utf8'));

test('pinned CodeMirror ESM modules and licenses are present at versioned local URLs', async () => {
	assert.deepEqual(Object.keys(manifest.imports), Object.keys(pins));
	for (const [name, { version, entry }] of Object.entries(pins)) {
		const path = `/lib/codemirror/${name}@${version}/${entry}`;
		assert.equal(manifest.imports[name], path);
		assert.ok(manifest.files.includes(path));
		assert.equal(manifest.sources[name].version, version);
		assert.match(manifest.sources[name].integrity, /^sha512-/);
		assert.ok((await readFile(`public${path}`, 'utf8')).length > 0);
		assert.match(await readFile(`public${manifest.sources[name].license}`, 'utf8'), /copyright/i);
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
				return { path: resolve(`public${manifest.imports[path]}`) };
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
});
