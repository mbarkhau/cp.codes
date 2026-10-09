// Run: node --test scripts/highlight.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/highlight.js", import.meta.url), "utf8");

function codeBlock(language, content = "const value = 42;", parent = "PRE") {
	const classes = new Set(language ? [`language-${language}`] : []);
	return {
		classList: classes,
		parentElement: { tagName: parent },
		textContent: content,
		innerHTML: null,
	};
}

function harness({ failImport = false, failHighlight = false, missingGrammar = false } = {}) {
	const imports = [], styles = [], calls = [], warnings = [];
	const registered = new Set();
	const hljs = {
		registerLanguage(language) { registered.add(language); },
		getLanguage(language) { return !missingGrammar && registered.has(language); },
		highlight(content, options) {
			if (failHighlight) throw new Error("highlight failed");
			calls.push({ content, ...options });
			return { value: `<span class="hljs-keyword">${content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</span>` };
		},
	};
	const context = vm.createContext({
		document: {
			getElementById(id) { return styles.find((style) => style.id === id); },
			createElement() { return {}; },
			head: { append(style) { styles.push(style); } },
		},
		console: { warn(...args) { warnings.push(args); } },
		async loadModule(url) {
			imports.push(url);
			if (failImport) throw new Error("CDN unavailable");
			return { default: url.endsWith("/core/+esm") ? hljs : () => ({}) };
		},
	});
	// Substitute only the network import boundary, executing the real client logic.
	vm.runInContext(source.replace("export async function", "async function").replaceAll("import(", "loadModule("), context);
	return {
		imports, styles, calls, warnings,
		highlight: (blocks) => context.highlightPaste({ querySelectorAll: () => blocks }),
	};
}

test("unsupported, unlabelled, empty, inline and oversized code never loads dependencies", async () => {
	const h = harness();
	const blocks = [
		codeBlock("plaintext"), codeBlock("unknown"), codeBlock(null),
		codeBlock("javascript", ""), codeBlock("javascript", "x", "P"),
		codeBlock("javascript", "x".repeat(200_001)), codeBlock("../../evil"),
	];
	await h.highlight(blocks);
	assert.equal(h.imports.length, 0);
	assert.equal(h.styles.length, 0);
	assert.ok(blocks.every((code) => code.innerHTML === null));
});

test("loads pinned core and only requested grammars, once each", async () => {
	const h = harness();
	const blocks = [codeBlock("javascript"), codeBlock("js"), codeBlock("python")];
	await h.highlight(blocks);
	await h.highlight([codeBlock("javascript")]);
	assert.deepEqual(h.imports.sort(), [
		"https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/lib/core/+esm",
		"https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/lib/languages/javascript/+esm",
		"https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/lib/languages/python/+esm",
	]);
	assert.equal(h.styles.length, 1);
	assert.equal(h.styles[0].href, "/highlight.css?v=1");
	assert.ok(blocks.every((code) => code.classList.has("hljs")));
	assert.equal(h.calls.length, 4);
	assert.ok(h.calls.every((call) => call.ignoreIllegals === true));
});

test("maps paste content types and Markdown fence aliases to grammar names", async () => {
	const h = harness();
	const aliases = {
		html: "xml", shell: "bash", sh: "bash", yml: "yaml", cs: "csharp",
		"c++": "cpp", "c#": "csharp", TS: "typescript", py: "python", rb: "ruby",
	};
	for (const [alias, language] of Object.entries(aliases)) {
		await h.highlight([codeBlock(alias)]);
		assert.equal(h.calls.at(-1).language, language);
	}
});

test("passes source as text to the highlighter and preserves it for copying", async () => {
	const h = harness();
	const content = '<script>alert("x")</script> & <img src=x onerror=alert(1)>';
	const block = codeBlock("html", content);
	await h.highlight([block]);
	assert.equal(h.calls[0].content, content);
	assert.equal(block.textContent, content);
	assert.ok(block.innerHTML.includes("&lt;script&gt;"));
	assert.ok(!block.innerHTML.includes("<script>"));
});

for (const failure of ["failImport", "failHighlight", "missingGrammar"]) {
	test(`${failure} leaves original code readable without rejecting`, async () => {
		const h = harness({ [failure]: true });
		const block = codeBlock("javascript");
		await h.highlight([block]);
		assert.equal(block.innerHTML, null);
		assert.equal(block.textContent, "const value = 42;");
		assert.equal(block.classList.has("hljs"), false);
	});
}

test("paste viewer starts enhancement only after rendering and enabling copy", async () => {
	const viewer = await readFile(new URL("../public/view.js", import.meta.url), "utf8");
	const displayIndex = viewer.indexOf("host.replaceChildren(rendered)");
	const copyIndex = viewer.indexOf("copyButton.disabled = false", displayIndex);
	const highlightIndex = viewer.indexOf('void import("./highlight.js?v=1")', displayIndex);
	assert.ok(displayIndex >= 0 && displayIndex < copyIndex && copyIndex < highlightIndex);
	assert.match(viewer, /highlightPaste\(rendered\)/);
});
