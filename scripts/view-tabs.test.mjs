// Run: node --test scripts/view-tabs.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/view.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('let currentCopyContent'), source.indexOf('function initializePasteTabsLayout'));
function harness() {
	const context = vm.createContext({ location: { origin: 'https://cp.codes', hash: '' } });
	vm.runInContext(helpers, context);
	return context;
}

test('file fragments round-trip filenames without confusing URL delimiters', () => {
	const context = harness();
	for (const name of ['readme.md', 'résumé detailed-source.js', '日本語.txt', 'a#b?c%d.txt', '', 'file-hello.js']) {
		const file = { name };
		const fragment = context.fileFragment(name);
		assert.equal(fragment, `#file-${encodeURIComponent(name)}`);
		assert.equal(context.fileForFragment([file], fragment), file);
		assert.equal(new URL(fragment, 'https://cp.codes/CPTEST00').hash, fragment);
	}
});

test('missing, unknown, malformed and non-file fragments safely return no file', () => {
	const context = harness();
	const files = [{ name: 'readme.md' }];
	for (const fragment of ['', '#heading', '#file-missing.txt', '#file-%E0%A4%A', '#file-%', '#file-%ZZ']) {
		assert.equal(context.fileForFragment(files, fragment), null, fragment);
	}
	context.location.hash = '#file-readme.md';
	assert.equal(context.fileForFragment(files), files[0]);
});

test('copied links use the displayed file, while ordinary single-file links stay unchanged', () => {
	const context = harness();
	assert.equal(context.pasteShareLink('CPTEST00'), 'https://cp.codes/CPTEST00');
	for (const name of ['readme.md', 'résumé detailed-source.js', '']) {
		vm.runInContext(`currentCopyFile = ${JSON.stringify(name)};`, context);
		assert.equal(context.pasteShareLink('CPTEST00'), `https://cp.codes/CPTEST00#file-${encodeURIComponent(name)}`);
	}
	vm.runInContext('currentCopyFile = null;', context);
	assert.equal(context.pasteShareLink('CPTEST00'), 'https://cp.codes/CPTEST00');
});
