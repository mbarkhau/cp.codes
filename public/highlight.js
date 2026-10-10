/** Optional paste highlighting: fetch only the core and explicitly requested grammars. */
const HIGHLIGHT_CDN = "https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/lib";
// Regex-based grammars can be expensive on large/untrusted inputs.
const MAX_HIGHLIGHT_CHARS = 200_000;
const LANGUAGE_ALIASES = new Map([
	["javascript", "javascript"], ["js", "javascript"], ["jsx", "javascript"],
	["typescript", "typescript"], ["ts", "typescript"], ["tsx", "typescript"],
	["python", "python"], ["py", "python"], ["java", "java"], ["json", "json"],
	["html", "xml"], ["xml", "xml"], ["css", "css"],
	["shell", "bash"], ["sh", "bash"], ["bash", "bash"],
	["sql", "sql"], ["yaml", "yaml"], ["yml", "yaml"],
	["c", "c"], ["cpp", "cpp"], ["c++", "cpp"],
	["csharp", "csharp"], ["cs", "csharp"], ["c#", "csharp"],
	["go", "go"], ["golang", "go"], ["rust", "rust"], ["rs", "rust"],
	["ruby", "ruby"], ["rb", "ruby"], ["php", "php"],
]);

let corePromise;
const languagePromises = new Map();

function loadLanguage(language) {
	if (!corePromise) corePromise = import(`${HIGHLIGHT_CDN}/core/+esm`).then(({ default: hljs }) => hljs);
	if (!languagePromises.has(language)) {
		languagePromises.set(language, corePromise.then(async (hljs) => {
			const { default: grammar } = await import(`${HIGHLIGHT_CDN}/languages/${language}/+esm`);
			hljs.registerLanguage(language, grammar);
			return hljs;
		}));
	}
	return languagePromises.get(language);
}

export async function highlightPaste(root) {
	const candidates = [];
	for (const code of root.querySelectorAll("code[class*='language-']")) {
		if (code.parentElement?.tagName !== "PRE") continue;
		const name = [...code.classList].find((name) => name.startsWith("language-"))?.slice(9).toLowerCase();
		const language = LANGUAGE_ALIASES.get(name);
		const content = code.textContent;
		if (!language || !content || content.length > MAX_HIGHLIGHT_CHARS) continue;
		candidates.push({ code, language, content });
	}
	if (!candidates.length) return;

	if (!document.getElementById("paste-highlight-style")) {
		const link = document.createElement("link");
		link.id = "paste-highlight-style";
		link.rel = "stylesheet";
		link.href = "/highlight.css?v=2";
		document.head.append(link);
	}

	await Promise.all(candidates.map(async ({ code, language, content }) => {
		try {
			const hljs = await loadLanguage(language);
			if (!hljs.getLanguage(language)) return;
			// Highlight.js escapes the source; never interpret paste HTML directly.
			const result = hljs.highlight(content, { language, ignoreIllegals: true });
			code.innerHTML = result.value;
			code.classList.add("hljs");
		} catch (error) {
			// Highlighting must not interfere with reading, copying, or caching a paste.
			console.warn(`Syntax highlighting unavailable for ${language}`, error);
		}
	}));
}
