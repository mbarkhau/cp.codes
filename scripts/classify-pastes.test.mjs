import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.19";
import { CRITERIA, DEFAULT_MAX_BYTES, MODEL, run } from "./classify-pastes.mjs";

const ID = "CP0A1B2C";
const KEY = "test-secret-not-a-real-key";
const CONTENT = "console.log('hello');";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

async function metadata(id = ID, content = CONTENT, encoding = "gzip") {
	const bytes = new TextEncoder().encode(content);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return {
		id, content_type: "javascript", content_encoding: encoding,
		byte_length: bytes.byteLength,
		sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
	};
}

async function gzip(content) {
	const stream = new Blob([content]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decision(choice = "code") {
	return {
		model: MODEL,
		answers: {
			category: {
				type: "choice", choice, confidence: 0.9,
				probabilities: Object.fromEntries(Object.keys(CRITERIA).map((key) => [key, key === choice ? 1 : 0])),
			},
		},
		usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
		task_id: "test-task", consumed: "0.00001",
	};
}

async function execute(args, fetchImpl, env = { DEFAPI_KEY: KEY }) {
	const out = [], errors = [];
	const code = await run({ args, fetchImpl, env, stdout: (line) => out.push(line), stderr: (line) => errors.push(line) });
	return { code, out, errors };
}

function fixtureFetch({ content = CONTENT, encoding = "gzip", meta = {}, answer = decision(), jevStatus = 200 } = {}) {
	const calls = [];
	const fetchImpl = async (url, options) => {
		calls.push({ url, options });
		if (url.includes("api.defapi.org")) return json(answer, jevStatus);
		assertEquals(options.headers?.authorization, undefined, "DefAPI key must not go to the paste server");
		if (url.endsWith("/content")) {
			return new Response(encoding === "gzip" ? await gzip(content) : content);
		}
		const id = url.split("/").at(-1);
		return json({ ...(await metadata(id, content, encoding)), ...meta });
	};
	return { fetchImpl, calls };
}

Deno.test("single ID: verifies gzip and sends the six-way choice request", async () => {
	const { fetchImpl, calls } = fixtureFetch();
	const result = await execute([ID.toLowerCase()], fetchImpl);
	assertEquals(result.code, 0);
	assertEquals(result.errors, []);
	const output = JSON.parse(result.out[0]);
	assertEquals(output.id, ID);
	assertEquals(output.category, "code");
	assertEquals(output.confidence, 0.9);
	assertEquals(output.usage, decision().usage);
	assertEquals(calls.length, 3);
	assertEquals(calls[0].url, `https://cp.codes/api/paste/${ID}`);
	const request = calls[2].options;
	assertEquals(request.headers.authorization, `Bearer ${KEY}`);
	assertEquals(request.redirect, "error");
	const body = JSON.parse(request.body);
	assertEquals(body.model, MODEL);
	assertEquals(body.state, { content_type: "javascript", content: CONTENT });
	assertEquals(body.questions.category.type, "choice");
	assertEquals(Object.keys(body.questions.category.criteria), ["spam", "phishing", "csam", "code", "plaintext", "ascii"]);
	assertMatch(body.questions.category.instructions, /untrusted data/);
	assert(!result.out[0].includes(CONTENT));
	assert(!result.out[0].includes(KEY));
});

Deno.test("no ID: requests latest 20 and processes each once in server order", async () => {
	const ids = Array.from({ length: 22 }, (_, i) => `CP${String(i).padStart(6, "0")}`);
	const { fetchImpl, calls } = fixtureFetch();
	const result = await execute(["--base-url", "http://localhost:8787"], async (url, options) => {
		if (url.endsWith("/api/pastes?limit=20")) return json({ items: ids.map((id) => ({ id })) });
		return fetchImpl(url, options);
	});
	assertEquals(result.code, 0);
	assertEquals(result.out.map((line) => JSON.parse(line).id), ids.slice(0, 20));
	assertEquals(calls.filter((call) => call.url.includes("api.defapi.org")).length, 20);
	assertEquals(calls[0].url, `http://localhost:8787/api/paste/${ids[0]}`);
});

Deno.test("identity encoding is supported and URL content is not followed", async () => {
	const content = "https://example.com/login";
	const { fetchImpl, calls } = fixtureFetch({ content, encoding: "identity", meta: { content_type: "url" } });
	const result = await execute([ID], fetchImpl);
	assertEquals(result.code, 0);
	assertEquals(calls.length, 3);
	assertEquals(JSON.parse(calls[2].options.body).state.content, content);
});

Deno.test("default cap accepts the reported 116666-byte paste and the boundary", async () => {
	assertEquals(DEFAULT_MAX_BYTES, 248_000);
	for (const byteLength of [116_666, DEFAULT_MAX_BYTES]) {
		const content = "a".repeat(byteLength);
		const { fetchImpl, calls } = fixtureFetch({ content });
		const result = await execute([ID], fetchImpl);
		assertEquals(result.code, 0);
		assertEquals(JSON.parse(result.out[0]).status, "classified");
		assertEquals(JSON.parse(calls[2].options.body).state.content.length, byteLength);
	}
});

Deno.test("media and oversized bodies are explicitly skipped without a model call", async () => {
	for (const meta of [
		...["png", "jpeg", "webp", "gif", "mp3", "mp4"].map((content_type) => ({ content_type })),
		{ byte_length: DEFAULT_MAX_BYTES + 1 },
	]) {
		const { fetchImpl, calls } = fixtureFetch({ meta });
		const result = await execute([ID], fetchImpl);
		assertEquals(result.code, 0);
		assertEquals(JSON.parse(result.out[0]).status, "skipped");
		assertEquals(calls.length, 1);
	}
});

Deno.test("media data URLs with misleading metadata never reach Jev", async () => {
	for (const mime of ["image/gif", "audio/mpeg", "video/mp4"]) {
		const { fetchImpl, calls } = fixtureFetch({ content: `data:${mime};base64,eA==`, meta: { content_type: "plaintext" } });
		const result = await execute([ID], fetchImpl);
		assertEquals(result.code, 0);
		assertEquals(JSON.parse(result.out[0]).status, "skipped");
		assertEquals(calls.length, 2);
	}
});

Deno.test("--max-bytes changes the body limit", async () => {
	const { fetchImpl, calls } = fixtureFetch();
	const result = await execute([ID, "--max-bytes", "1"], fetchImpl);
	assertEquals(JSON.parse(result.out[0]).status, "skipped");
	assertEquals(calls.length, 1);
});

Deno.test("hash mismatch and decompression bombs never reach Jev", async () => {
	for (const fixture of [
		{ meta: { sha256: "0".repeat(64) } },
		{ content: "a".repeat(DEFAULT_MAX_BYTES + 1), meta: { byte_length: 1 } },
	]) {
		const { fetchImpl, calls } = fixtureFetch(fixture);
		const result = await execute([ID], fetchImpl);
		assertEquals(result.code, 1);
		assertEquals(JSON.parse(result.out[0]).status, "error");
		assertEquals(calls.length, 2);
	}
});

Deno.test("bad model responses and HTTP failures are not classifications", async () => {
	for (const fixture of [
		{ answer: decision("unknown") },
		{ answer: { answers: { category: { type: "choice", choice: "code" } } } },
		{ answer: {}, jevStatus: 401 },
		{ answer: {}, jevStatus: 429 },
	]) {
		const { fetchImpl } = fixtureFetch(fixture);
		const result = await execute([ID], fetchImpl);
		assertEquals(result.code, 1);
		assertEquals(JSON.parse(result.out[0]).status, "error");
	}
});

Deno.test("batch continues after an unavailable paste but exits nonzero", async () => {
	const other = "CP0A1B2D";
	const { fetchImpl } = fixtureFetch();
	const result = await execute([], async (url, options) => {
		if (url.endsWith("limit=20")) return json({ items: [{ id: ID }, { id: other }] });
		if (url.endsWith(ID)) return json({ error: "hidden" }, 404);
		return fetchImpl(url, options);
	});
	assertEquals(result.code, 1);
	assertEquals(result.out.map((line) => JSON.parse(line).status), ["error", "classified"]);
});

Deno.test("configuration errors make no network calls; help works without a key", async () => {
	const noFetch = () => { throw new Error("Unexpected network call"); };
	for (const args of [["bad-id"], [ID, ID], ["--max-bytes", "0"], ["--base-url", "file:///tmp"], ["--unknown"]]) {
		const result = await execute(args, noFetch);
		assertEquals(result.code, 1);
		assertEquals(result.out.length, 0);
	}
	const missing = await execute([ID], noFetch, {});
	assertMatch(missing.errors[0], /DEFAPI_KEY is not set/);
	const help = await execute(["--help"], noFetch, {});
	assertEquals(help.code, 0);
	assertMatch(help.out[0], /Usage:/);
	assert(help.out[0].includes(`default: ${DEFAULT_MAX_BYTES}`));
});

Deno.test("paste connection errors identify the server, cause, and local setup", async () => {
	const result = await execute(["--base-url", "http://localhost:8787"], () => {
		throw new TypeError("fetch failed", { cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) });
	});
	assertEquals(result.code, 1);
	assertMatch(result.errors[0], /Recent pastes \(http:\/\/localhost:8787\/api\/pastes\?limit=20\)/);
	assertMatch(result.errors[0], /ECONNREFUSED/);
	assertMatch(result.errors[0], /make dev/);
});

Deno.test("Jev connection errors identify DefAPI rather than blaming the local server", async () => {
	const { fetchImpl } = fixtureFetch();
	const result = await execute([ID], (url, options) => {
		if (url.includes("api.defapi.org")) throw new TypeError("fetch failed");
		return fetchImpl(url, options);
	});
	assertEquals(result.code, 1);
	assertMatch(result.errors[0], /Jev \(https:\/\/api.defapi.org/);
	assert(!result.errors[0].includes("make dev"));
});

Deno.test("network errors redact the key", async () => {
	const result = await execute([ID], () => { throw new Error(`Failed with ${KEY}`); });
	assertEquals(result.code, 1);
	assert(!JSON.stringify(result).includes(KEY));
	assertMatch(result.out[0], /\[redacted\]/);
});
