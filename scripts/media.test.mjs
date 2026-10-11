// Run: node --test scripts/media.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { test } from "node:test";
import vm from "node:vm";
import { transform } from "esbuild";
import { contentTypeForFilename, detectContentType } from "../public/content_type.js";
import { MEDIA_MIME_TYPES, mediaTypeHint, mediaTypeFromBytes, mediaDataUrlType } from "../public/media.js";
import { assessPaste, initialModeration } from "../src/jev.mjs";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/media.json", import.meta.url), "utf8"));
const cases = Object.entries(fixtures).map(([name, encoded]) => ({
	name, type: name.startsWith("gif") ? "gif" : name, bytes: Buffer.from(encoded, "base64"),
}));
const dataUrl = ({ type, bytes }) => `data:${MEDIA_MIME_TYPES[type]};base64,${bytes.toString("base64")}`;
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const viewer = await readFile(new URL("../public/view.js", import.meta.url), "utf8");

function browser({ decodeFails = false } = {}) {
	const statuses = [];
	let decodeCalls = 0;
	class Element {
		constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; }
		append(...children) { this.children.push(...children); }
		setAttribute(name, value) { this.attributes[name] = value; }
	}
	class Image extends Element {
		constructor() { super("img"); this.naturalWidth = 1; this.naturalHeight = 1; }
		async decode() { decodeCalls++; if (decodeFails) throw new Error("invalid image"); }
	}
	const contentEl = { value: "", focus() {}, setSelectionRange() {} };
	const filenameEl = { value: "", maxLength: 255 };
	const context = vm.createContext({
		atob, Uint8Array, TextDecoder, Image, contentEl, filenameEl,
		MEDIA_MIME_TYPES, mediaTypeHint, mediaTypeFromBytes, mediaDataUrlType,
		loadMedia: async () => ({ MEDIA_MIME_TYPES, mediaTypeHint, mediaTypeFromBytes, mediaDataUrlType }),
		loadAuthorization: async () => ({ storeAuthorization: () => true }),
		document: { getElementById: () => null, createElement: (tag) => tag === "img" ? new Image() : new Element(tag) },
		bytesToBase64: (bytes) => Buffer.from(bytes).toString("base64"),
		updateBytes: () => Buffer.byteLength(contentEl.value),
		setStatus: (...args) => statuses.push(args),
	});
	vm.runInContext(app.slice(app.indexOf("async function verifyDecodableImage"), app.indexOf('fileButtonEl.addEventListener("click"')), context);
	vm.runInContext(viewer.slice(viewer.indexOf("async function renderMedia"), viewer.indexOf("function removeCachedPasteContent")), context);
	return { context, contentEl, filenameEl, statuses, get decodeCalls() { return decodeCalls; } };
}

test("client and server resolve GIF, MP3 and MP4 filenames, data URLs and metadata", async () => {
	const source = await readFile(new URL("../src/content_type.ts", import.meta.url), "utf8");
	const { code } = await transform(source, { loader: "ts", format: "esm" });
	const server = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
	for (const media of cases) {
		for (const resolve of [contentTypeForFilename, server.contentTypeForFilename]) {
			assert.equal(resolve(`media.${media.type.toUpperCase()}`), media.type);
		}
		for (const detect of [detectContentType, server.detectContentType]) {
			assert.equal(detect(dataUrl(media)), media.type);
		}
		assert.ok(server.CONTENT_TYPES.includes(media.type));
		assert.equal(server.fileExtension(media.type), media.type);
		assert.equal(server.rawContentType(media.type), "text/plain; charset=utf-8");
	}
});

test("signature checks accept GIF87a/GIF89a, tagged/untagged MP3 and MP4", () => {
	for (const media of cases) {
		assert.equal(mediaTypeFromBytes(media.bytes), media.type);
		assert.equal(mediaDataUrlType(dataUrl(media)), media.type);
		assert.equal(mediaTypeHint({ type: MEDIA_MIME_TYPES[media.type], name: "file" }), media.type);
		assert.equal(mediaTypeHint({ type: "", name: `FILE.${media.type.toUpperCase()}` }), media.type);
		assert.equal(mediaDataUrlType(dataUrl(media).replace(MEDIA_MIME_TYPES[media.type], "image/png")), null);
	}
	const mp3 = cases.find(({ type }) => type === "mp3").bytes;
	assert.equal(mediaTypeFromBytes(mp3.subarray(45)), "mp3");
});

test("malformed GIF/MP3/MP4 signatures and unrelated ftyp brands are rejected", () => {
	for (const media of cases.filter(({ type }) => type === "gif")) {
		assert.equal(mediaTypeFromBytes(media.bytes.subarray(0, media.bytes.length - 1)), null);
		assert.equal(mediaTypeFromBytes(Buffer.concat([Buffer.from("GIF00a"), media.bytes.subarray(6)])), null);
	}
	const mp3 = Buffer.from(cases.find(({ type }) => type === "mp3").bytes);
	mp3[3] = 0xff;
	assert.equal(mediaTypeFromBytes(mp3), null);
	assert.equal(mediaTypeFromBytes(Buffer.from([0xff, 0xff, 0xff, 0xff])), null);
	const mp4 = cases.find(({ type }) => type === "mp4").bytes;
	for (const offset of [0, 4, 8]) {
		const corrupt = Buffer.from(mp4);
		corrupt[offset] = 0xff;
		assert.equal(mediaTypeFromBytes(corrupt), null);
	}
	const avif = Buffer.from(mp4);
	avif.write("avif", 8);
	assert.equal(mediaTypeFromBytes(avif), null);
	for (const type of ["gif", "mp3", "mp4"]) {
		assert.equal(mediaDataUrlType(`data:${MEDIA_MIME_TYPES[type]};base64,YWJj`), null);
	}
});

test('file selection preserves UTF-8/BOM despite unfamiliar MIME types and rejects binary controls', async () => {
	const text = '\ufeffconfiguration = true\n'; const bytes = Buffer.from(text);
	const app = browser();
	await app.context.loadFile({ name: 'settings.config', type: 'application/octet-stream', size: bytes.length, arrayBuffer: async () => bytes });
	assert.equal(app.contentEl.value, text); assert.equal(app.filenameEl.value, 'settings.config');
	const binary = browser(); const controls = Buffer.from('\u0001'.repeat(9));
	await binary.context.loadFile({ name: 'opaque.bin', type: '', size: controls.length, arrayBuffer: async () => controls });
	assert.equal(binary.contentEl.value, ''); assert.match(binary.statuses.at(-1)[0], /binary/);
});

test("browser uploads media losslessly without trying to decode audio/video as images", async () => {
	for (const media of cases) {
		const b = browser();
		await b.context.loadFile({
			name: `media.${media.type}`, type: MEDIA_MIME_TYPES[media.type],
			arrayBuffer: async () => Uint8Array.from(media.bytes).buffer,
		});
		assert.equal(b.contentEl.value, dataUrl(media));
		assert.equal(b.filenameEl.value, `media.${media.type}`);
		assert.equal(b.decodeCalls, media.type === "gif" ? 1 : 0);
		assert.equal(b.statuses.at(-1)[1], "ok");
	}
});

test("browser rejects mismatched MIME types and undecodable GIF images", async () => {
	for (const media of cases) {
		const b = browser();
		await b.context.loadFile({
			name: "image.png", type: "image/png",
			arrayBuffer: async () => Uint8Array.from(media.bytes).buffer,
		});
		assert.equal(b.contentEl.value, "");
		assert.equal(b.statuses.at(-1)[1], "err");
	}
	const gif = cases[0];
	const b = browser({ decodeFails: true });
	await b.context.loadFile({ name: "image.gif", type: "image/gif", arrayBuffer: async () => Uint8Array.from(gif.bytes).buffer });
	assert.equal(b.contentEl.value, "");
	assert.equal(b.statuses.at(-1)[1], "err");
});

test("viewer preserves GIF animation and uses controlled, non-autoplaying MP3/MP4 players", async () => {
	for (const media of cases) {
		const b = browser();
		const wrapper = await b.context.renderPasteContent(dataUrl(media), media.type);
		const element = wrapper.children[0];
		assert.equal(element.src, dataUrl(media));
		assert.equal(element.tagName, { gif: "IMG", mp3: "AUDIO", mp4: "VIDEO" }[media.type]);
		if (media.type === "gif") {
			assert.equal(b.decodeCalls, 1);
		} else {
			assert.equal(element.controls, true);
			assert.equal(element.preload, "metadata");
			assert.notEqual(element.autoplay, true);
			assert.equal(element.attributes["aria-label"], `${media.type.toUpperCase()} paste`);
			if (media.type === "mp4") assert.equal(element.playsInline, true);
		}
	}
});

test("viewer rejects malformed and mislabeled media", async () => {
	const { context } = browser();
	for (const media of cases) {
		await assert.rejects(context.renderPasteContent(`data:${MEDIA_MIME_TYPES[media.type]};base64,YWJj`, media.type), /bytes are not valid/);
		await assert.rejects(context.renderPasteContent(dataUrl(media), "png"), /Invalid PNG image data URL/);
	}
});

test("browser publish submits encoded media with the matching type and body-bound challenge", async () => {
	for (const media of cases) {
		const b = browser();
		const requests = [];
		b.contentEl.value = dataUrl(media);
		Object.assign(b.context, {
			TextEncoder, isBusy: false, consentEl: { checked: true }, moderationConsentEl: { checked: true },
			listedEl: { checked: true },
			updateDetection: () => media.type, setBusy() {}, storeAuthorization: () => true, passphraseFromPasscode: () => 'fixture phrase',
			sha256Hex: async (bytes) => createHash("sha256").update(bytes).digest("hex"),
			gzip: async (bytes) => gzipSync(bytes), MAX_POW_SUBMISSION_ATTEMPTS: 1,
			solvePow: async () => ({ solution: "0", pow_hash: "proof" }),
			fetch: async (path, options) => {
				requests.push({ path, body: JSON.parse(options.body) });
				return { ok: true, json: async () => path === "/api/challenge" ? {} : { moderation: { visibility: "hidden" } } };
			},
		});
		vm.runInContext(app.slice(app.indexOf("async function publish()"), app.indexOf('publishBtn.addEventListener("click"')), b.context);
		await b.context.publish();
		assert.equal(requests.length, 2);
		assert.equal(requests[0].body.byte_length, Buffer.byteLength(dataUrl(media)));
		assert.equal(requests[0].body.content_hash, createHash("sha256").update(dataUrl(media)).digest("hex"));
		assert.equal(requests[1].body.content_type, media.type);
		assert.equal(gunzipSync(Buffer.from(requests[1].body.content_gzip, "base64")).toString(), dataUrl(media));
		requests.length = 0;
		b.contentEl.value = `data:${MEDIA_MIME_TYPES[media.type]};base64,YWJj`;
		await b.context.publish();
		assert.equal(requests.length, 0);
		assert.equal(b.statuses.at(-1)[1], "err");
	}
});

test("GIF, MP3 and MP4 require human moderation, even with misleading metadata", async () => {
	for (const media of cases) {
		for (const content_type of [media.type, "plaintext"]) {
			const content = dataUrl(media);
			let called = false;
			const assessment = await assessPaste({ content_type, byte_length: content.length }, content, "key", {
				fetchImpl: () => { called = true; throw new Error("unsupported"); },
			});
			assert.equal(called, false);
			assert.equal(assessment.status, "unsupported");
			assert.equal(initialModeration(assessment).visibility, "hidden");
		}
	}
});
