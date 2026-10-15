import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { CONTENT_TYPE_LABELS, contentTypeForFilename, detectContentType } from '../public/content_type.js';
import { MAX_FILES, MAX_UPLOAD_BYTES } from '../public/policy.js';

const source = (await readFile(new URL('../public/files.js', import.meta.url), 'utf8'))
	.replace(/^import .*;\r?\n/gm, '').replace('export function createFileEditor', 'function createFileEditor');

function composer() {
	class Element {
		constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.value = ''; }
		append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
		insertBefore(child, reference) { child.remove(); child.parent = this; this.children.splice(this.children.indexOf(reference), 0, child); }
		replaceChildren(...children) { this.children = []; this.append(...children); }
		setAttribute() {}
		addEventListener(name, listener) { this.listeners[name] = listener; }
		removeEventListener(name) { delete this.listeners[name]; }
		remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
		focus() { document.activeElement = this; }
		querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
		querySelectorAll(selector) {
			const matches = element => selector.startsWith('.') ? element.className === selector.slice(1)
				: selector === 'option[value="auto"]' ? element.tagName === 'option' && element.value === 'auto'
					: selector.split(', ').includes(element.tagName);
			return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
		}
	}
	const root = new Element('div'), addButton = new Element('button');
	const document = {
		createElement: tag => new Element(tag), createElementNS: (_namespace, tag) => new Element(tag),
		getElementById: id => id === 'add-text' ? addButton : null,
	};
	const context = vm.createContext({
		document, CONTENT_TYPE_LABELS, contentTypeForFilename, detectContentType, MAX_FILES, MAX_UPLOAD_BYTES, TextEncoder,
		Option: function (label, value) { const option = new Element('option'); option.textContent = label; option.value = value; return option; },
	});
	// Exercise the real fallback editor without loading browser-only CodeMirror modules.
	vm.runInContext(source + '\ncodeMirrorPromise = Promise.resolve(null);', context);
	const editor = context.createFileEditor({ root });
	return { root, editor, addFile: () => addButton.listeners.click(),
		drafts: () => JSON.parse(editor.serialized()).files };
}

test('uploads populate the first and subsequent empty editors in place', () => {
	const c = composer();
	const first = c.root.children[0];
	c.editor.add('first.txt', 'first', 'plaintext');
	assert.equal(c.root.children[0], first);
	c.addFile();
	const second = c.root.children[1];
	c.editor.add('second.py', 'print(2)', 'python');
	assert.equal(c.root.children.length, 2);
	assert.equal(c.root.children[1], second);
	assert.equal(second.querySelector('.editor-fallback').value, 'print(2)');
	assert.equal(second.querySelector('.editor-filename').value, 'second.py');
	assert.deepEqual(c.drafts().map(file => file.content), ['first', 'print(2)']);
	assert.equal(c.drafts()[1].content_type, 'python');
	assert.equal(c.editor.prepare().bundle.primary, 'first.txt');
});

test('every registered content type is selectable exactly once', () => {
	const c = composer();
	const select = c.root.children[0].querySelector('.editor-type');
	const values = select.querySelectorAll('option').map(option => option.value);
	assert.deepEqual(values.sort(), Object.keys(CONTENT_TYPE_LABELS).sort());
});

test('Add file creates separate empty editors, which successive uploads fill in order', () => {
	const c = composer();
	c.addFile(); c.addFile();
	assert.equal(c.root.children.length, 3);
	for (const name of ['one.txt', 'two.txt', 'three.txt']) c.editor.add(name, name, 'plaintext');
	assert.equal(c.root.children.length, 3);
	assert.deepEqual(c.drafts().map(file => file.name), ['one.txt', 'two.txt', 'three.txt']);
	c.editor.add('four.txt', 'four', 'plaintext');
	assert.equal(c.root.children.length, 4);
});

test('an empty editor with a filename and manual type is populated using the uploaded filename and type', () => {
	const c = composer();
	c.editor.add('first.txt', 'first', 'plaintext'); c.addFile();
	const card = c.root.children[1];
	card.querySelector('.editor-filename').value = 'draft.js';
	card.querySelector('.editor-type').value = 'javascript';
	c.editor.add('loaded.py', 'print(2)', 'python');
	assert.equal(c.root.children.length, 2);
	assert.equal(c.drafts()[1].name, 'loaded.py');
	assert.equal(c.drafts()[1].content_type, 'python');
});

test('duplicate uploads leave empty editors and existing content intact', () => {
	const c = composer();
	c.editor.add('first.txt', 'first', 'plaintext'); c.addFile();
	const before = c.editor.serialized();
	assert.throws(() => c.editor.add('FIRST.txt', 'replacement', 'plaintext'), /already exists/);
	assert.equal(c.editor.serialized(), before);
});

test('uploads can fill an empty editor at the file limit but cannot append past it', () => {
	const c = composer();
	for (let i = 1; i < MAX_FILES; i++) c.addFile();
	for (let i = 0; i < MAX_FILES; i++) c.editor.add(`${i}.txt`, `${i}`, 'plaintext');
	assert.equal(c.root.children.length, MAX_FILES);
	assert.throws(() => c.editor.add('extra.txt', 'extra', 'plaintext'), /up to/);
});

test('media uploads replace a subsequent empty text editor with a preview', () => {
	const c = composer();
	c.editor.add('first.txt', 'first', 'plaintext'); c.addFile();
	const card = c.root.children[1];
	const content = 'data:audio/mpeg;base64,audio';
	c.editor.add('sound.mp3', content, 'mp3');
	assert.equal(c.root.children.length, 2);
	assert.equal(card.querySelector('audio').src, content);
	assert.equal(card.querySelector('audio').controls, true);
	assert.equal(card.querySelector('.editor-fallback'), null);
	assert.equal(c.drafts()[1].content_type, 'mp3');
});

test('the sole image keeps its trash action and removing it restores an empty editor', () => {
	const c = composer();
	c.editor.add('image.png', 'data:image/png;base64,aW1hZ2U=', 'png');
	const image = c.root.children[0];
	const actions = image.querySelector('.editor-options');
	assert.notEqual(actions.hidden, true);
	assert.notEqual(actions.querySelector('.icon-action danger editor-remove').hidden, true);
	assert.equal(actions.querySelector('.icon-action editor-toggle').hidden, true);
	assert.equal(actions.querySelector('.icon-action editor-move-up').hidden, true);
	actions.querySelector('.icon-action danger editor-remove').listeners.click();
	assert.equal(c.root.children.length, 1);
	assert.notEqual(c.root.children[0], image);
	assert.equal(c.root.children[0].querySelector('.editor-fallback').value, '');
	assert.equal(c.editor.serialized(), '');
	assert.equal(c.editor.hasContent(), false);
	assert.equal(c.editor.primary().name, '');
	c.editor.add('next.txt', 'next', 'plaintext');
	assert.equal(c.editor.prepare().content, 'next');
});

test('move up swaps adjacent cards and changes the primary file without losing edits', () => {
	const c = composer();
	c.editor.add('first.txt', 'first', 'plaintext');
	c.editor.add('second.png', 'data:image/png;base64,aW1hZ2U=', 'png');
	c.editor.add('third.py', 'print(3)', 'python');
	const [first, second, third] = c.root.children;
	const move = card => card.querySelector('.icon-action editor-move-up');
	const type = third.querySelector('.editor-type');
	type.value = 'javascript';
	const text = third.querySelector('.editor-fallback');
	text.value = 'updated'; text.listeners.input();
	assert.equal(move(first).hidden, true);
	assert.equal(move(second).hidden, false);
	move(third).listeners.click();
	assert.deepEqual(c.root.children, [first, third, second]);
	assert.deepEqual(c.drafts().map(file => file.name), ['first.txt', 'third.py', 'second.png']);
	move(third).listeners.click();
	assert.deepEqual(c.root.children, [third, first, second]);
	assert.equal(move(third).hidden, true);
	assert.equal(move(first).hidden, false);
	assert.equal(c.editor.prepare().bundle.primary, 'third.py');
	assert.equal(c.editor.primary().content, 'updated');
	assert.equal(c.editor.primary().type_choice, 'javascript');
	assert.equal(JSON.parse(c.editor.serialized()).primary, 'third.py');
	c.editor.setEditable(false);
	assert.equal(move(second).disabled, true);
	c.editor.setEditable(true);
	third.querySelector('.icon-action danger editor-remove').listeners.click();
	assert.deepEqual(c.root.children, [first, second]);
	assert.equal(c.editor.primary().name, 'first.txt');
	assert.equal(move(first).hidden, true);
});
