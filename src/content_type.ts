export const CONTENT_TYPES = [
	"plaintext",
	"url",
	"markdown",
	"png",
	"jpeg",
	"webp",
	"gif",
	"mp3",
	"mp4",
	"javascript",
	"typescript",
	"python",
	"java",
	"json",
	"html",
	"css",
	"shell",
	"sql",
	"yaml",
	"xml",
	"c",
	"cpp",
	"csharp",
	"go",
	"rust",
	"ruby",
	"php",
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];
export type ContentTypeChoice = ContentType | "auto";

export const CONTENT_TYPE_FILES: Record<ContentType, { extension: string; mediaType: string }> = {
	plaintext: { extension: "txt", mediaType: "text/plain" },
	url: { extension: "url", mediaType: "text/uri-list" },
	markdown: { extension: "md", mediaType: "text/markdown" },
	// Media paste bodies are UTF-8 data URLs; raw routes return that URL as text.
	png: { extension: "png", mediaType: "text/plain" },
	jpeg: { extension: "jpg", mediaType: "text/plain" },
	webp: { extension: "webp", mediaType: "text/plain" },
	gif: { extension: "gif", mediaType: "text/plain" },
	mp3: { extension: "mp3", mediaType: "text/plain" },
	mp4: { extension: "mp4", mediaType: "text/plain" },
	javascript: { extension: "js", mediaType: "text/javascript" },
	typescript: { extension: "ts", mediaType: "text/typescript" },
	python: { extension: "py", mediaType: "text/x-python" },
	java: { extension: "java", mediaType: "text/x-java-source" },
	json: { extension: "json", mediaType: "application/json" },
	html: { extension: "html", mediaType: "text/html" },
	css: { extension: "css", mediaType: "text/css" },
	shell: { extension: "sh", mediaType: "text/x-shellscript" },
	sql: { extension: "sql", mediaType: "application/sql" },
	yaml: { extension: "yaml", mediaType: "application/yaml" },
	xml: { extension: "xml", mediaType: "application/xml" },
	c: { extension: "c", mediaType: "text/x-c" },
	cpp: { extension: "cpp", mediaType: "text/x-c++" },
	csharp: { extension: "cs", mediaType: "text/x-csharp" },
	go: { extension: "go", mediaType: "text/x-go" },
	rust: { extension: "rs", mediaType: "text/x-rust" },
	ruby: { extension: "rb", mediaType: "text/x-ruby" },
	php: { extension: "php", mediaType: "text/x-php" },
};

export function fileExtension(type: ContentType): string {
	return CONTENT_TYPE_FILES[type].extension;
}

export function rawContentType(type: ContentType): string {
	const { mediaType } = CONTENT_TYPE_FILES[type];
	return mediaType.startsWith("text/") ? `${mediaType}; charset=utf-8` : mediaType;
}

const CONTENT_TYPE_EXTENSION_ALIASES: Readonly<Record<string, ContentType>> = {
	text: "plaintext",
	markdown: "markdown",
	jpeg: "jpeg",
	jpg: "jpeg",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	mts: "typescript",
	cts: "typescript",
	tsx: "typescript",
	jsonl: "json",
	htm: "html",
	bash: "shell",
	zsh: "shell",
	fish: "shell",
	yml: "yaml",
	h: "c",
	cc: "cpp",
	cxx: "cpp",
	hh: "cpp",
	hpp: "cpp",
	hxx: "cpp",
};

export function contentTypeForExtension(extension: string): ContentType | null {
	const normalized = extension.toLowerCase().replace(/^\./, "");
	return CONTENT_TYPES.find((type) => fileExtension(type) === normalized)
		?? CONTENT_TYPE_EXTENSION_ALIASES[normalized]
		?? null;
}

/** Resolve a supplied filename by its final extension, without inspecting content. */
export function contentTypeForFilename(filename: string): ContentType {
	const basename = filename.trim().split(/[\\/]/).pop() ?? "";
	const dot = basename.lastIndexOf(".");
	if (dot <= 0 || dot === basename.length - 1) return "plaintext";
	return contentTypeForExtension(basename.slice(dot + 1)) ?? "plaintext";
}

export const CONTENT_TYPE_LABELS: Record<ContentTypeChoice, string> = {
	auto: "Auto detect",
	plaintext: "Plaintext",
	url: "URL",
	markdown: "Markdown",
	png: "PNG image",
	jpeg: "JPEG image",
	webp: "WebP image",
	gif: "GIF image",
	mp3: "MP3 audio",
	mp4: "MP4 video",
	javascript: "JavaScript",
	typescript: "TypeScript",
	python: "Python",
	java: "Java",
	json: "JSON",
	html: "HTML",
	css: "CSS",
	shell: "Shell",
	sql: "SQL",
	yaml: "YAML",
	xml: "XML",
	c: "C",
	cpp: "C++",
	csharp: "C#",
	go: "Go",
	rust: "Rust",
	ruby: "Ruby",
	php: "PHP",
};

const CONTENT_TYPE_SET = new Set<string>(CONTENT_TYPES);

export function isContentType(value: unknown): value is ContentType {
	return typeof value === "string" && CONTENT_TYPE_SET.has(value);
}

export function isContentTypeChoice(value: unknown): value is ContentTypeChoice {
	return value === "auto" || isContentType(value);
}

/** A URL paste is exactly one absolute HTTP(S) URL (surrounding whitespace is ignored). */
export function parseHttpUrl(content: string): URL | null {
	const value = content.trim();
	if (!value || /\s/.test(value)) return null;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

function matches(content: string, patterns: RegExp[]): number {
	return patterns.reduce((score, pattern) => score + (pattern.test(content) ? 1 : 0), 0);
}

/**
 * Conservative text/language detection. Ambiguous input intentionally remains
 * plaintext; callers can always supply an explicit content type.
 */
export function detectContentType(content: string): ContentType {
	const text = content.trim();
	if (/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(text)) return "png";
	if (/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(text)) return "jpeg";
	if (/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(text)) return "webp";
	if (/^data:image\/gif;base64,[A-Za-z0-9+/]+={0,2}$/.test(text)) return "gif";
	if (/^data:audio\/mpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(text)) return "mp3";
	if (/^data:video\/mp4;base64,[A-Za-z0-9+/]+={0,2}$/.test(text)) return "mp4";
	if (parseHttpUrl(text)) return "url";
	if (!text) return "plaintext";

	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object") return "json";
	} catch {
		// Not JSON.
	}

	if (/^<\?php\b/i.test(text)) return "php";
	if (/^#!.*\b(?:python\d*|python)\b/m.test(text)) return "python";
	if (/^#!.*\b(?:bash|sh|zsh|fish)\b/m.test(text)) return "shell";
	if (/^#!.*\bruby\b/m.test(text)) return "ruby";
	if (/^\s*<!doctype html\b/i.test(text) || /<(?:html|head|body|script|main|section)\b[^>]*>/i.test(text)) return "html";
	if (/^\s*<\?xml\b/i.test(text) || (/<[A-Za-z][\w:.-]*(?:\s[^<>]*)?>/.test(text) && /<\/[A-Za-z][\w:.-]*>/.test(text))) return "xml";

	if (matches(text, [
		/^\s*package\s+main\b/m,
		/^\s*func\s+(?:\([^)]*\)\s*)?\w+\s*\(/m,
		/^\s*import\s*\([\s\S]*?^\s*\)/m,
		/\bfmt\.(?:Print|Printf|Println)\s*\(/,
	]) >= 2) return "go";

	if (matches(text, [
		/\bfn\s+\w+\s*\([^)]*\)\s*(?:->\s*[^\s{]+\s*)?\{/,
		/\blet\s+mut\s+\w+/,
		/\b(?:println|eprintln)!\s*\(/,
		/\bimpl(?:<[^>]+>)?\s+\w+/,
		/\buse\s+(?:std|crate|super)::/,
	]) >= 2) return "rust";

	if (matches(text, [
		/^\s*using\s+System(?:\.|;)/m,
		/\bnamespace\s+[\w.]+\s*[;{]/,
		/\bConsole\.Write(?:Line)?\s*\(/,
		/\b(?:public|private|internal)\s+(?:sealed\s+|static\s+)?class\s+\w+/,
	]) >= 2) return "csharp";

	if (matches(text, [
		/^\s*#include\s*<(?:iostream|vector|string|map|memory)>/m,
		/\bstd::\w+/,
		/\b(?:cout|cin)\s*<</,
		/\btemplate\s*</,
	]) >= 1) return "cpp";

	if (matches(text, [
		/^\s*#include\s*<[^>]+>/m,
		/\b(?:printf|scanf|malloc|free)\s*\(/,
		/\b(?:struct|typedef)\s+\w+/,
		/\bint\s+main\s*\(/,
	]) >= 2) return "c";

	if (/\bSystem\.(?:out|err)\.print(?:ln)?\s*\(/.test(text) || matches(text, [
		/^\s*(?:public\s+)?(?:abstract\s+|final\s+)?class\s+\w+/m,
		/\bpublic\s+static\s+void\s+main\s*\(/,
		/^\s*import\s+java\./m,
	]) >= 2) return "java";

	if (/^\s*(?:interface|type|enum|namespace)\s+\w+/m.test(text) || matches(text, [
		/^\s*(?:interface|type|enum|namespace)\s+\w+/m,
		/\b(?:string|number|boolean|unknown|never)\[?\]?\s*[;,)=]/,
		/\b(?:implements|keyof|readonly)\b/,
		/\w+\??:\s*(?:string|number|boolean|unknown|[A-Z]\w*)\b/,
	]) >= 2) return "typescript";

	if (
		/\bconsole\.(?:log|error|warn)\s*\(/.test(text) ||
		/\b(?:async\s+)?function\s+[$A-Z_a-z][$\w]*\s*\(/.test(text) ||
		/^\s*(?:const|let|var)\s+[$A-Z_a-z][$\w]*\s*=.*;\s*$/m.test(text) ||
		/=>\s*[\w({[]/.test(text) ||
		/^\s*(?:import\s+.+\s+from\s+|export\s+(?:default\s+|\{))/m.test(text)
	) return "javascript";

	const pythonImport = /^\s*(?:from\s+[\w.]+\s+import\s+.+|import\s+[A-Za-z_]\w*(?:\.\w+)*(?:\s+as\s+\w+)?(?:\s*,\s*[A-Za-z_]\w*(?:\.\w+)*)*)\s*$/m;
	if (
		/^\s*(?:async\s+)?def\s+\w+\s*\([^)]*\)\s*(?:->\s*[^:]+)?:/m.test(text) ||
		/^\s*class\s+\w+(?:\([^)]*\))?:/m.test(text) ||
		/^\s*(?:print|input)\s*\(/m.test(text) ||
		/^\s*(?:for\s+.+\s+in\s+.+|elif\s+.+|except(?:\s+.+)?):\s*$/m.test(text) ||
		/^\s*if\s+__name__\s*==\s*["']__main__["']\s*:/m.test(text) ||
		pythonImport.test(text) ||
		matches(text, [
			/\b(?:len|range|enumerate|zip|isinstance)\s*\(/,
			/\b(?:None|True|False)\b/,
			/\bself\.\w+/,
			/^\s*(?:if|for|while|with|try)\b.*:\s*$/m,
		]) >= 2
	) return "python";

	if (matches(text, [
		/^\s*(?:require|require_relative)\s+["']/m,
		/^\s*def\s+\w+[!?=]?/m,
		/\b(?:puts|attr_reader|attr_accessor)\b/,
		/\bdo\s*\|[^|]*\|/,
	]) >= 2) return "ruby";

	if (matches(text, [
		/^\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE)\b/im,
		/\b(?:FROM|WHERE|JOIN|VALUES|GROUP\s+BY|ORDER\s+BY)\b/i,
		/;\s*$/m,
	]) >= 2) return "sql";

	if (matches(text, [
		/(?:^|})\s*[.#]?[A-Za-z][\w-]*(?:\s+[.#]?[\w-]+)*\s*\{[^}]*\}/m,
		/\b(?:color|display|margin|padding|font-family|background)\s*:/,
	]) >= 2) return "css";

	const yamlKeyLines = text.match(/^\s*[\w.-]+:\s+(?:[^|>{].*|$)/gm)?.length ?? 0;
	if (yamlKeyLines >= 2 || matches(text, [
		/^\s*---\s*$/m,
		/^\s*[\w.-]+:\s+(?:[^|>{].*|$)/m,
		/^\s*-\s+\w[\w ]*:\s*/m,
	]) >= 2) return "yaml";

	const markdownScore = matches(text, [
		/^#{1,6}\s+\S/m,
		/^\s*```[\w-]*\s*$/m,
		/\[[^\]]+\]\([^)]+\)/,
		/^\s*(?:[-*+]\s+|\d+\.\s+)\S/m,
		/(?:\*\*|__)[^\n]+(?:\*\*|__)/,
		/^>\s+\S/m,
	]);
	if (markdownScore >= 2 || /^#{1,6}\s+\S/m.test(text) || /^\s*```[\s\S]*```\s*$/.test(text)) return "markdown";

	return "plaintext";
}

export function resolveContentType(content: string, choice: ContentTypeChoice): ContentType {
	return choice === "auto" ? detectContentType(content) : choice;
}
