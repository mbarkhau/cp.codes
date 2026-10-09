// Run: node --test scripts/webp.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { transform } from "esbuild";
import { contentTypeForFilename, detectContentType } from "../public/content_type.js";
import { MEDIA_MIME_TYPES, mediaTypeHint, mediaTypeFromBytes, mediaDataUrlType } from "../public/media.js";
import { assessPaste, initialModeration } from "../src/jev.mjs";

// Real 1x1 lossy, lossless and extended/alpha WebP files.
const images = [
	"UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
	"UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA",
	"UklGRlgAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAgFZQOCAwAAAA0AEAnQEqAQABAAFAJiWgAnS6AfgAA7AA/vLrf/zYFc1z7/f/0uD9Lg/S4P/SkAAA",
].map((value) => Buffer.from(value, "base64"));
const dataUrl = (bytes) => `data:image/webp;base64,${bytes.toString("base64")}`;
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const viewer = await readFile(new URL("../public/view.js", import.meta.url), "utf8");

function browser({ decodeFails = false } = {}) {
	const statuses = [];
	let decodeCalls = 0;
	class Element {
		constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; }
		append(...children) { this.children.push(...children); }
	}
	class Image extends Element {
		constructor() { super("img"); this.naturalWidth = 1; this.naturalHeight = 1; }
		async decode() { decodeCalls++; if (decodeFails) throw new Error("invalid image"); }
	}
	const contentEl = { value: "", focus() {}, setSelectionRange() {} };
	const filenameEl = { value: "", maxLength: 255 };
	const context = vm.createContext({
		atob, Uint8Array, DataView, Image, contentEl, filenameEl,
		MEDIA_MIME_TYPES, mediaTypeHint, mediaTypeFromBytes, mediaDataUrlType,
		imageTypeFromBytes: mediaTypeFromBytes, imageDataUrlType: mediaDataUrlType, imageTypeHint: mediaTypeHint,
		document: { createElement: (tag) => tag === "img" ? new Image() : new Element(tag) },
		bytesToBase64: (bytes) => Buffer.from(bytes).toString("base64"),
		updateBytes: () => Buffer.byteLength(contentEl.value),
		setStatus: (...args) => statuses.push(args),
	});
	vm.runInContext(app.slice(app.indexOf("async function verifyDecodableImage"), app.indexOf('fileButtonEl.addEventListener("click"')), context);
	vm.runInContext(viewer.slice(viewer.indexOf("async function renderMedia"), viewer.indexOf("function readPasteCache")), context);
	return { context, contentEl, filenameEl, statuses, get decodeCalls() { return decodeCalls; } };
}

test("client and server resolve WebP filenames, data URLs and metadata", async () => {
	const source = await readFile(new URL("../src/content_type.ts", import.meta.url), "utf8");
	const { code } = await transform(source, { loader: "ts", format: "esm" });
	const server = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
	for (const resolve of [contentTypeForFilename, server.contentTypeForFilename]) {
		assert.equal(resolve("picture.WEBP"), "webp");
	}
	for (const detect of [detectContentType, server.detectContentType]) {
		assert.equal(detect(dataUrl(images[0])), "webp");
	}
	assert.ok(server.CONTENT_TYPES.includes("webp"));
	assert.equal(server.CONTENT_TYPE_LABELS.webp, "WebP image");
	assert.equal(server.fileExtension("webp"), "webp");
	assert.equal(server.rawContentType("webp"), "text/plain; charset=utf-8");
});

test("browser signatures accept lossy/lossless/extended WebP but reject malformed RIFF", () => {
	const { context } = browser();
	for (const bytes of images) {
		assert.equal(context.imageTypeFromBytes(bytes), "webp");
		assert.equal(context.imageDataUrlType(dataUrl(bytes)), "webp");
		assert.equal(context.imageDataUrlType(dataUrl(bytes).replace("image/webp", "image/png")), null);
		assert.equal(context.imageTypeFromBytes(bytes.subarray(0, bytes.length - 1)), null);
		for (const offset of [0, 4, 8, 12]) {
			const corrupt = Buffer.from(bytes);
			corrupt[offset] = 0;
			assert.equal(context.imageTypeFromBytes(corrupt), null);
		}
	}
	assert.equal(context.imageTypeHint({ type: "image/webp", name: "image" }), "webp");
	assert.equal(context.imageTypeHint({ type: "", name: "IMAGE.WEBP" }), "webp");
});

test("browser file upload encodes WebP and verifies that it decodes", async () => {
	const b = browser();
	await b.context.loadFile({
		name: "picture.webp", type: "image/webp",
		arrayBuffer: async () => Uint8Array.from(images[0]).buffer,
	});
	assert.equal(b.contentEl.value, dataUrl(images[0]));
	assert.equal(b.filenameEl.value, "picture.webp");
	assert.equal(b.decodeCalls, 1);
	assert.equal(b.statuses.at(-1)[1], "ok");
});

test("browser rejects a WebP disguised as PNG", async () => {
	const b = browser();
	await b.context.loadFile({
		name: "picture.png", type: "image/png",
		arrayBuffer: async () => Uint8Array.from(images[0]).buffer,
	});
	assert.equal(b.contentEl.value, "");
	assert.equal(b.statuses.at(-1)[1], "err");
});

test("viewer routes WebP to a decoded image instead of code", async () => {
	const b = browser();
	for (const bytes of images) {
		const rendered = await b.context.renderPasteContent(dataUrl(bytes), "webp");
		assert.equal(rendered.className, "paste-image-wrap");
		const image = rendered.children[0];
		assert.equal(image.tagName, "IMG");
		assert.equal(image.src, dataUrl(bytes));
		assert.equal(image.className, "paste-image");
	}
	assert.equal(b.decodeCalls, 3);
});

test("viewer rejects corrupt, mislabeled or undecodable WebP", async () => {
	const { context } = browser();
	for (const offset of [0, 4, 8, 12]) {
		const corrupt = Buffer.from(images[0]);
		corrupt[offset] = 0;
		await assert.rejects(context.renderPasteContent(dataUrl(corrupt), "webp"), /Image bytes are not valid WEBP/);
	}
	await assert.rejects(context.renderPasteContent(dataUrl(images[0]), "png"), /Invalid PNG image data URL/);
	await assert.rejects(context.renderPasteContent("data:image/webp;base64,YWJj", "webp"), /Image bytes are not valid WEBP/);
	await assert.rejects(browser({ decodeFails: true }).context.renderPasteContent(dataUrl(images[0]), "webp"), /invalid image/);
});

test("WebP images require human moderation even with misleading metadata", async () => {
	for (const [content_type, content] of [["webp", "image"], ["plaintext", dataUrl(images[0])]]) {
		const assessment = await assessPaste({ content_type, byte_length: content.length }, content, "key", {
			fetchImpl: () => { throw new Error("must not call image-unsupported classifier"); },
		});
		assert.equal(assessment.status, "unsupported");
		assert.equal(initialModeration(assessment).visibility, "hidden");
		assert.equal(initialModeration(assessment).requires_review, true);
	}
});
