/** Resolve a supplied filename by its final extension, without inspecting content. */
export function contentTypeForFilename(filename) {
	const aliases = {
		txt: "plaintext", text: "plaintext",
		url: "url",
		md: "markdown", markdown: "markdown",
		png: "png", jpg: "jpeg", jpeg: "jpeg", webp: "webp", gif: "gif", mp3: "mp3", mp4: "mp4",
		js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
		ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
		py: "python", java: "java", json: "json", jsonl: "json",
		html: "html", htm: "html", css: "css",
		sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
		sql: "sql", yaml: "yaml", yml: "yaml", xml: "xml",
		c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp",
		hh: "cpp", hpp: "cpp", hxx: "cpp", cs: "csharp",
		go: "go", rs: "rust", rb: "ruby", php: "php",
	};
	const basename = String(filename).trim().split(/[\\/]/).pop() ?? "";
	const dot = basename.lastIndexOf(".");
	if (dot <= 0 || dot === basename.length - 1) return "plaintext";
	return aliases[basename.slice(dot + 1).toLowerCase()] ?? "plaintext";
}

/** Lightweight, synchronous browser-side content detection. */
export function detectContentType(content) {
	const text = content.trim();
	if (!text) return "plaintext";

	if (/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(text)) return "png";
	if (/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(text)) return "jpeg";
	if (/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(text)) return "webp";
	if (/^data:image\/gif;base64,[A-Za-z0-9+/]+={0,2}$/.test(text)) return "gif";
	if (/^data:audio\/mpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(text)) return "mp3";
	if (/^data:video\/mp4;base64,[A-Za-z0-9+/]+={0,2}$/.test(text)) return "mp4";

	if (!/\s/.test(text)) {
		try {
			const url = new URL(text);
			if (url.protocol === "http:" || url.protocol === "https:") return "url";
		} catch {
			// Not a URL.
		}
	}

	try {
		const value = JSON.parse(text);
		if (value !== null && typeof value === "object") return "json";
	} catch {
		// Not JSON.
	}

	if (/^<\?php\b/i.test(text)) return "php";
	const pythonImport = /^\s*(?:from\s+[\w.]+\s+import\s+.+|import\s+[A-Za-z_]\w*(?:\.\w+)*(?:\s+as\s+\w+)?(?:\s*,\s*[A-Za-z_]\w*(?:\.\w+)*)*)\s*$/m;
	const pythonSignals = [
		/\b(?:len|range|enumerate|zip|isinstance)\s*\(/,
		/\b(?:None|True|False)\b/,
		/\bself\.\w+/,
		/^\s*(?:if|for|while|with|try)\b.*:\s*$/m,
	].filter((pattern) => pattern.test(text)).length;
	if (/^#!.*\bpython\d*\b/m.test(text) || /^\s*(?:async\s+)?def\s+\w+\s*\([^)]*\).*:/m.test(text) || /^\s*class\s+\w+(?:\([^)]*\))?:/m.test(text) || /^\s*(?:print|input)\s*\(/m.test(text) || /^\s*(?:for\s+.+\s+in\s+.+|elif\s+.+|except(?:\s+.+)?):\s*$/m.test(text) || /^\s*if\s+__name__\s*==\s*["']__main__["']\s*:/m.test(text) || pythonImport.test(text) || pythonSignals >= 2) return "python";
	if (/^#!.*\b(?:bash|sh|zsh|fish)\b/m.test(text)) return "shell";
	if (/^#!.*\bruby\b/m.test(text)) return "ruby";
	if (/^\s*<!doctype html\b/i.test(text) || /<(?:html|head|body|script|main|section)\b[^>]*>/i.test(text)) return "html";
	if (/^\s*<\?xml\b/i.test(text) || (/<[A-Za-z][\w:.-]*(?:\s[^<>]*)?>/.test(text) && /<\/[A-Za-z][\w:.-]*>/.test(text))) return "xml";
	if (/\bSystem\.(?:out|err)\.print(?:ln)?\s*\(/.test(text) || (/\bclass\s+\w+/.test(text) && (/\bpublic\s+static\s+void\s+main\s*\(/.test(text) || /^\s*import\s+java\./m.test(text)))) return "java";
	if (/^\s*(?:interface|type|enum|namespace)\s+\w+/m.test(text) || (/\w+\??:\s*(?:string|number|boolean|unknown)\b/.test(text) && /\b(?:const|let|function|class)\b/.test(text))) return "typescript";
	if (/\bconsole\.(?:log|error|warn)\s*\(/.test(text) || /\b(?:async\s+)?function\s+[$\w]+\s*\(/.test(text) || /^\s*(?:const|let|var)\s+[$\w]+\s*=.*;\s*$/m.test(text) || /=>\s*[\w({[]/.test(text) || /^\s*(?:import\s+.+\s+from\s+|export\s+(?:default\s+|\{))/m.test(text)) return "javascript";
	if (/^\s*package\s+main\b/m.test(text) && /\bfunc\s+\w+\s*\(/.test(text)) return "go";
	if (/\bfn\s+\w+\s*\([^)]*\).+\{/.test(text) && /\b(?:let\s+mut|println!|use\s+std::)/.test(text)) return "rust";
	if (/^\s*using\s+System(?:\.|;)/m.test(text) && /\b(?:namespace|Console\.Write|class)\b/.test(text)) return "csharp";
	if (/^\s*#include\s*<(?:iostream|vector|string|map|memory)>/m.test(text) || /\bstd::\w+/.test(text)) return "cpp";
	if (/^\s*#include\s*<[^>]+>/m.test(text) && /\b(?:printf|scanf|int\s+main)\s*\(/.test(text)) return "c";
	if (/^\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE)\b/im.test(text) && /\b(?:FROM|WHERE|VALUES|TABLE)\b/i.test(text)) return "sql";
	if (/\b(?:color|display|margin|padding|background)\s*:/.test(text) && /[.#]?[A-Za-z][\w-]*\s*\{[^}]*\}/.test(text)) return "css";
	if ((text.match(/^\s*[\w.-]+:\s+(?:[^|>{].*|$)/gm) ?? []).length >= 2 || (/^\s*---\s*$/m.test(text) && /^\s*[\w.-]+:\s+/m.test(text))) return "yaml";
	if (/^\s*(?:require|require_relative)\s+["']/m.test(text) && /^\s*def\s+\w+/m.test(text)) return "ruby";

	const markdownSignals = [
		/^#{1,6}\s+\S/m,
		/^\s*```[\w-]*\s*$/m,
		/\[[^\]]+\]\([^)]+\)/,
		/^\s*(?:[-*+]\s+|\d+\.\s+)\S/m,
		/(?:\*\*|__)[^\n]+(?:\*\*|__)/,
	].filter((pattern) => pattern.test(text)).length;
	if (markdownSignals >= 2 || /^#{1,6}\s+\S/m.test(text) || /^\s*```[\s\S]*```\s*$/.test(text)) return "markdown";

	return "plaintext";
}
