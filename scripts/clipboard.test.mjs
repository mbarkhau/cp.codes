// Run: node --test scripts/clipboard.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/view.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function isCopyableImage'), source.indexOf('async function sha256Hex'));
const copy = source.slice(source.indexOf('function initializePasteCopy'), source.indexOf('function initializePasteDeletion'));
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const pngContent = `data:image/png;base64,${pngBytes.toString('base64')}`;

function harness(options = {}) {
	const calls = { writes: [], blobs: [], text: [], canvases: [], draws: [], encodings: [], statuses: [] };
	class Element {
		constructor() { this.attributes = {}; }
		setAttribute(name, value) { this.attributes[name] = value; }
	}
	class Button extends Element {
		constructor() { super(); this.disabled = false; this.listeners = {}; }
		addEventListener(name, listener) { this.listeners[name] = listener; }
	}
	class ClipboardItem {
		static supports() { return options.supportsPng !== false; }
		constructor(data) { this.data = data; this.types = Object.keys(data); }
		async getType(type) { return this.data[type]; }
	}
	const button = new Button(), status = new Element();
	const image = { naturalWidth: 640, naturalHeight: 480 };
	const clipboard = {
		async write(items) {
			calls.writes.push(items);
			if (options.denied) throw new Error('Clipboard access was denied');
			for (const item of items) calls.blobs.push(await item.getType('image/png'));
		},
		async writeText(text) { calls.text.push(text); },
	};
	if (options.noWrite) delete clipboard.write;
	const context = vm.createContext({
		Blob, atob, Uint8Array, HTMLButtonElement: Button, HTMLElement: Element,
		ClipboardItem: options.noClipboardItem ? undefined : ClipboardItem,
		navigator: { clipboard },
		document: {
			getElementById: id => id === 'copy-paste' ? button : id === 'paste-action-status' ? status : null,
			querySelector: () => image,
			createElement(tag) {
				assert.equal(tag, 'canvas');
				const canvas = {
					width: 0, height: 0,
					getContext() {
						return options.noCanvasContext ? null : {
							drawImage(drawn, x, y) { calls.draws.push({ image: drawn, x, y, width: canvas.width, height: canvas.height }); },
						};
					},
					toBlob(callback, type) {
						calls.encodings.push(type);
						const finish = () => callback(options.noBlob ? null : new Blob([pngBytes], { type }));
						if (options.deferEncoding) calls.finishEncoding = finish;
						else queueMicrotask(finish);
					},
				};
				calls.canvases.push(canvas);
				return canvas;
			},
		},
		writeToClipboard: async text => { calls.text.push(text); },
		showActionFeedback: (_status, message, kind) => calls.statuses.push({ message, kind }),
	});
	vm.runInContext(helpers + '\nlet currentCopyContent = null; let currentCopyType = null;\n' + copy, context);
	return {
		context, calls, button, image,
		select(type, content) {
			vm.runInContext(`currentCopyType = ${JSON.stringify(type)}; currentCopyContent = ${JSON.stringify(content)};`, context);
		},
	};
}

test('PNG is copied as image data without canvas conversion or base64 text', async () => {
	const h = harness();
	await h.context.writeImageToClipboard(pngContent, 'png', h.image);
	assert.equal(h.calls.blobs[0].type, 'image/png');
	assert.deepEqual(Buffer.from(await h.calls.blobs[0].arrayBuffer()), pngBytes);
	assert.equal(h.calls.canvases.length, 0);
	assert.deepEqual(h.calls.text, []);
});

test('JPEG, WebP and GIF are encoded as PNG at the displayed image’s original resolution', async () => {
	for (const type of ['jpeg', 'webp', 'gif']) {
		const h = harness();
		await h.context.writeImageToClipboard('encoded image', type, h.image);
		assert.equal(h.calls.blobs[0].type, 'image/png');
		assert.deepEqual(h.calls.draws, [{ image: h.image, x: 0, y: 0, width: 640, height: 480 }]);
		assert.deepEqual(h.calls.encodings, ['image/png']);
		assert.equal(h.calls.canvases[0].width, 0);
		assert.equal(h.calls.canvases[0].height, 0);
		assert.deepEqual(h.calls.text, []);
	}
});

test('clipboard write starts synchronously before asynchronous image encoding completes', async () => {
	const h = harness({ deferEncoding: true });
	const writing = h.context.writeImageToClipboard('encoded image', 'jpeg', h.image);
	assert.equal(h.calls.writes.length, 1);
	assert.equal(h.calls.blobs.length, 0);
	h.calls.finishEncoding();
	await writing;
	assert.equal(h.calls.blobs.length, 1);
});

test('image copying works without the optional ClipboardItem.supports API', async () => {
	const h = harness();
	delete h.context.ClipboardItem.supports;
	await h.context.writeImageToClipboard(pngContent, 'png', h.image);
	assert.equal(h.calls.blobs.length, 1);
});

test('unsupported image clipboard APIs never fall back to copying base64 text', async () => {
	for (const options of [{ noWrite: true }, { noClipboardItem: true }, { supportsPng: false }]) {
		const h = harness(options);
		await assert.rejects(h.context.writeImageToClipboard(pngContent, 'png', h.image), /Image copying is unavailable/);
		assert.deepEqual(h.calls.text, []);
		assert.equal(h.calls.writes.length, 0);
	}
});

test('conversion failures are reported and canvas memory is released', async () => {
	for (const options of [{ noCanvasContext: true }, { noBlob: true }]) {
		const h = harness(options);
		await assert.rejects(h.context.writeImageToClipboard('encoded image', 'gif', h.image), /conversion is unavailable|could not be encoded/);
		assert.equal(h.calls.canvases[0].width, 0);
		assert.equal(h.calls.canvases[0].height, 0);
		assert.deepEqual(h.calls.text, []);
	}
});

test('denied writes do not leak later image encoding rejections', async () => {
	const h = harness({ denied: true, noBlob: true });
	await assert.rejects(h.context.writeImageToClipboard('encoded image', 'gif', h.image), /Clipboard access was denied/);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(h.calls.text, []);
});

test('missing image pixels and malformed PNG data are rejected', async () => {
	const h = harness();
	await assert.rejects(h.context.imageClipboardBlob('encoded image', 'jpeg', null), /Image content is unavailable/);
	await assert.rejects(h.context.imageClipboardBlob('not a PNG data URL', 'png', h.image), /PNG image content is unavailable/);
});

test('copy action uses the selected image without awaiting the initial content promise', async () => {
	const h = harness();
	h.select('png', pngContent);
	h.context.initializePasteCopy(new Promise(() => {}));
	const copying = h.button.listeners.click();
	assert.equal(h.calls.writes.length, 1);
	await copying;
	assert.deepEqual(h.calls.statuses, [{ message: 'Image copied.', kind: 'ok' }]);
	assert.deepEqual(h.calls.text, []);
	assert.equal(h.button.disabled, false);
});

test('text, Markdown, audio and video retain text clipboard behavior', async () => {
	for (const type of ['plaintext', 'markdown', 'javascript', 'mp3', 'mp4']) {
		const h = harness();
		h.select(type, 'selected file content');
		h.context.initializePasteCopy(Promise.resolve('initial file content'));
		await h.button.listeners.click();
		assert.deepEqual(h.calls.text, ['selected file content']);
		assert.equal(h.calls.writes.length, 0);
		assert.deepEqual(h.calls.statuses, [{ message: 'Content copied.', kind: 'ok' }]);
	}
});

test('unsupported or denied image writes show an error and re-enable the copy action', async () => {
	for (const options of [{ noClipboardItem: true }, { denied: true }]) {
		const h = harness(options);
		h.select('png', pngContent);
		h.context.initializePasteCopy(Promise.resolve(pngContent));
		await h.button.listeners.click();
		assert.equal(h.calls.statuses[0].kind, 'err');
		assert.match(h.calls.statuses[0].message, /unavailable|denied/);
		assert.deepEqual(h.calls.text, []);
		assert.equal(h.button.disabled, false);
	}
});

test('copy action labels follow the selected file type', () => {
	const h = harness();
	for (const type of ['png', 'jpeg', 'webp', 'gif']) {
		h.context.updatePasteCopyLabel(type);
		assert.equal(h.button.attributes['aria-label'], 'Copy image');
		assert.equal(h.button.title, 'Copy image as PNG');
	}
	h.context.updatePasteCopyLabel('markdown');
	assert.equal(h.button.attributes['aria-label'], 'Copy content');
	assert.equal(h.button.title, 'Copy content');
});
