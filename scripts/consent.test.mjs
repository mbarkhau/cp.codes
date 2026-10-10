// Run: node --test scripts/consent.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

let mf;
before(async () => {
	const bundle = await build({
		entryPoints: ["src/index.ts"], bundle: true, write: false,
		format: "esm", platform: "browser", external: ["cloudflare:workers"],
	});
	mf = new Miniflare(convertV4MiniflareOptions({
		modules: true, script: bundle.outputFiles[0].text,
		compatibilityDate: "2026-09-05",
	}));
});
after(async () => { await mf?.dispose(); });

for (const field of ["consent", "consent_moderation"]) {
	for (const value of [undefined, false, "true", 1, null]) {
		test(`API requires explicit ${field}: ${JSON.stringify(value)}`, async () => {
			const response = await mf.dispatchFetch("https://cp.codes/api/paste", {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ consent: true, consent_moderation: true, [field]: value }),
			});
			assert.equal(response.status, 403);
			assert.match((await response.json()).error,
				field === "consent" ? /IP and location/ : /automated moderation.*DefAPI\/TypeSafe/);
		});
	}
}

test("API proceeds to upload validation only after both consents", async () => {
	const response = await mf.dispatchFetch("https://cp.codes/api/paste", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ consent: true, consent_moderation: true }),
	});
	assert.equal(response.status, 400);
	assert.equal((await response.json()).error, "compression must be gzip");
});

test("upload page displays separate unchecked consent controls", async () => {
	const response = await mf.dispatchFetch("https://cp.codes/new");
	const html = await response.text();
	assert.equal(response.status, 200);
	assert.match(html, /id="consent" \/><span>I consent to the collection and storage/);
	const moderationConsent = html.match(/id="consent-moderation" \/><span>(.*?)<\/span>/)[1];
	assert.match(moderationConsent, /href="\/about#service-providers">service providers<\/a>/);
	assert.doesNotMatch(moderationConsent, /DefAPI|TypeSafe/);
	assert.match(html, /id="publish" disabled/);
	assert.match(html, /id="listed" checked \/>/);
	assert.match(html, /id="file-editors"[^>]*>\s*<article class="editor-card editor-placeholder" aria-hidden="true">/);
	assert.match(html, /<link rel="stylesheet" href="\/style\.css\?v=\d+" \/>/);
	assert.doesNotMatch(html, /<style[\s>]/);
	const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
	assert.match(css, /#file-editors, \.editor-placeholder \{ min-height: 320px; \}/);
	assert.match(html, />Add file</);
	assert.match(html, /\(max\. 8 MiB\)/);
	assert.doesNotMatch(html, /file-sidebar|note\.md|id="content"|Make .* the main document/);
	assert.doesNotMatch(html, /upload-result/);

});

test("about page lists service providers and the data they process", async () => {
	const response = await mf.dispatchFetch("https://cp.codes/about");
	const html = await response.text();
	assert.equal(response.status, 200);
	assert.match(html, /<h2 id="service-providers">Service providers<\/h2>/);
	for (const name of ["Cloudflare", "DefAPI", "TypeSafe", "jsDelivr"]) {
		assert.ok(html.includes(`<strong>${name}</strong>`));
	}
	assert.match(html, /Paste text, filename, and content type/);
	assert.match(html, /paste editor, Markdown rendering/);
	assert.doesNotMatch(html, /id="description"|Description/);
	assert.match(html, /Private IP\/location metadata and proof-of-work details are not sent/);
});

test("upload byte counter uses bytes, KiB and MiB without thousands separators", async () => {
	const source = await readFile("public/app.js", "utf8");
	const bytesEl = {};
	const contentEl = { value: "" };
	const context = vm.createContext({
		TextEncoder, bytesEl, contentEl, fileEditor: null,
		updateDetection() {}, updatePublishState() {},
	});
	vm.runInContext(source.slice(source.indexOf("function formatBytes"),
		source.indexOf('contentEl?.addEventListener("input"')), context);
	for (const [n, expected] of [
		[0, "0 bytes"], [1, "1 byte"], [1023, "1023 bytes"],
		[1024, "1.00 KiB"], [1536, "1.50 KiB"],
		[1024 ** 2 - 1, "1024.00 KiB"], [1024 ** 2, "1.00 MiB"],
		[1.5 * 1024 ** 2, "1.50 MiB"], [8 * 1024 ** 2, "8.00 MiB"],
	]) {
		contentEl.value = "a".repeat(n);
		assert.equal(context.updateBytes(), n);
		assert.equal(bytesEl.textContent, expected);
	}
	contentEl.value = "é".repeat(512);
	assert.equal(context.updateBytes(), 1024);
	assert.equal(bytesEl.textContent, "1.00 KiB");
});

test("browser requires both consents, locks both while busy, and submits both", async () => {
	const source = await readFile("public/app.js", "utf8");
	const elements = new Map();
	const getElement = (id) => {
		if (!elements.has(id)) elements.set(id, {
			value: "", checked: false, disabled: false, style: {}, options: [],
			listeners: {}, setAttribute() {},
			addEventListener(event, listener) { this.listeners[event] = listener; },
		});
		return elements.get(id);
	};
	getElement("content").value = "hello";
	getElement("content-type").value = "plaintext";
	getElement("content-type").options = [{ value: "plaintext", textContent: "Plaintext" }];
	const requests = [];
	const authorizations = [];
	const location = { href: '' };
	let authorizationStored = true;
	let visibility = 'hidden';
	const context = vm.createContext({
		document: { getElementById: getElement }, TextEncoder,
		window: { location },
		localStorage: { length: 0 }, detectContentType: () => "plaintext",
		storeAuthorization: (id, passcode) => {
			assert.equal(location.href, '');
			authorizations.push({ id, passcode });
			return authorizationStored;
		},
		contentTypeForFilename: () => "plaintext",
		sha256Hex: async () => "hash", gzip: async () => new Uint8Array([1]),
		bytesToBase64: () => "gzip", solvePow: async () => ({ solution: "0", pow_hash: "proof" }),
		fetch: async (path, options) => {
			requests.push({ path, body: JSON.parse(options.body) });
			assert.equal(getElement("consent").disabled, true);
			assert.equal(getElement("consent-moderation").disabled, true);
			return { ok: true, json: async () => path === "/api/challenge" ? {} : {
				id: "CPTEST00", passcode: "0123456789abcdef", moderation: { visibility },
			} };
		},
	});
	// Execute the actual initialization and publish function, with PoW helpers mocked.
	const initialization = source.slice(0, source.indexOf("async function verifyDecodableImage"))
		.replace(/^import .*;$/gm, "");
	const publish = source.slice(source.indexOf("async function publish()"),
		source.indexOf('publishBtn.addEventListener("click"'));
	vm.runInContext(initialization + publish, context);
	assert.equal(getElement("publish").disabled, true);
	for (const [data, moderation] of [[false, false], [true, false], [false, true], [true, true]]) {
		getElement("consent").checked = data;
		getElement("consent-moderation").checked = moderation;
		getElement("consent").listeners.change();
		getElement("consent-moderation").listeners.change();
		assert.equal(getElement("publish").disabled, !(data && moderation));
		if (!(data && moderation)) {
			await vm.runInContext("publish()", context);
			assert.equal(requests.length, 0);
		}
	}
	vm.runInContext("setBusy(true)", context);
	assert.equal(getElement("publish").disabled, true);
	await vm.runInContext("publish()", context);
	assert.equal(requests.length, 0);
	vm.runInContext("setBusy(false)", context);
	await vm.runInContext("publish()", context);
	assert.equal(requests.length, 2);
	assert.equal(requests[1].path, "/api/paste");
	assert.equal(requests[1].body.consent, true);
	assert.equal(requests[1].body.consent_moderation, true);
	assert.equal(getElement("consent").disabled, false);
	assert.equal(getElement("consent-moderation").disabled, false);
	assert.equal(getElement("publish").disabled, false);
	assert.equal(location.href, '/CPTEST00');
	assert.deepEqual(authorizations, [{ id: 'CPTEST00', passcode: '0123456789abcdef' }]);
	// Successful uploads navigate even when browser storage is unavailable.
	for (visibility of ['hidden', 'limited']) {
		authorizationStored = false;
		location.href = '';
		await vm.runInContext("publish()", context);
		assert.equal(location.href, '/CPTEST00');
	}
});
