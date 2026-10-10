import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.19";
import {
	assessPaste, initialModeration, validateDecision, CRITERIA, MODEL,
	DECISIONS_URL, DEFAULT_MAX_BYTES, PROMPT_VERSION,
} from "../src/jev.mjs";

const KEY = "test-key-not-real";
const metadata = { content_type: "plaintext", byte_length: 5 };

function answer(category = "plaintext", probability = 0.95) {
	const alternative = category === "plaintext" ? "code" : "plaintext";
	return {
		model: MODEL,
		answers: { category: {
			type: "choice", choice: category, confidence: 0.8,
			probabilities: Object.fromEntries(Object.keys(CRITERIA).map((key) => [key,
				key === category ? probability : key === alternative ? 1 - probability : 0])),
		} },
		usage: { input_tokens: 200, output_tokens: 25, cost: 0.00002 },
		task_id: "task-1", consumed: "0.00002",
	};
}

function mockFetch(value = answer(), status = 200) {
	return async () => new Response(JSON.stringify(value), { status });
}

for (const category of ["code", "plaintext", "ascii"]) {
	Deno.test(`upload policy: ${category} with a strong score is visible but NOT staff-approved`, async () => {
		const assessment = await assessPaste(metadata, "hello", KEY, { fetchImpl: mockFetch(answer(category)) });
		assertEquals(assessment.status, "classified");
		assertEquals(initialModeration(assessment), {
			decision: "unreviewed", visibility: "visible", reason: null, requires_review: false,
		});
	});
}

Deno.test("dated Jev revisions are retained and use the same moderation policy", async () => {
	const model = `${MODEL}-20260917`;
	for (const [category, visibility] of [["code", "visible"], ["unsafe", "hidden"]]) {
		const result = { ...answer(category), model };
		assertEquals(validateDecision(result).model, model);
		const assessment = await assessPaste(metadata, "hello", KEY, { fetchImpl: mockFetch(result) });
		assertEquals(assessment.status, "classified");
		assertEquals(assessment.model, model);
		assertEquals(initialModeration(assessment).visibility, visibility);
	}
});

Deno.test("unrelated models and malformed revision suffixes fail closed", async () => {
	for (const model of [undefined, null, 42, "other/model", "typesafe/jev-1.14-20260917",
		`${MODEL}0`, `${MODEL}-`, `${MODEL}-latest`, `${MODEL}-2026091`, `${MODEL}-202609170`,
		`${MODEL}-20260917-extra`, `${MODEL}-20260917\n`, `${MODEL}\n`]) {
		const result = { ...answer(), model };
		const assessment = await assessPaste(metadata, "hello", KEY, { fetchImpl: mockFetch(result) });
		assertEquals(assessment.status, "error");
		assertEquals(initialModeration(assessment).visibility, "hidden");
		assertEquals(initialModeration({ ...result, status: "classified", prompt_version: PROMPT_VERSION,
			category: "plaintext", probabilities: result.answers.category.probabilities }).visibility, "hidden");
	}
});

for (const [category, reason] of [["spam", "spam"], ["phishing", "malware or phishing"], ["csam", "CSAM"], ['unsafe', 'other illegal content']]) {
	Deno.test(`upload policy: ${category} is hidden and mapped to the staff reason`, async () => {
		const assessment = await assessPaste(metadata, "hello", KEY, { fetchImpl: mockFetch(answer(category, 0.55)) });
		assertEquals(initialModeration(assessment), {
			decision: "restricted", visibility: "hidden", reason, requires_review: true,
		});
	});
}

Deno.test("a benign choice with too much aggregate harmful score stays hidden", async () => {
	const result = answer('plaintext', 0.98);
	result.answers.category.probabilities.code = 0;
	result.answers.category.probabilities.unsafe = 0.02;
	const assessment = await assessPaste(metadata, "hello", KEY, { fetchImpl: mockFetch(result) });
	assertEquals(initialModeration(assessment), {
		decision: "unreviewed", visibility: "hidden", reason: null, requires_review: true,
	});
});

Deno.test("the 0.01 aggregate harmful threshold is inclusive", async () => {
	const result = answer('code', 0.99);
	result.answers.category.probabilities.plaintext = 0;
	result.answers.category.probabilities.unsafe = 0.01;
	const assessment = await assessPaste(metadata, "hello", KEY, { fetchImpl: mockFetch(result) });
	assertEquals(initialModeration(assessment).visibility, "visible");
});

Deno.test("URL text does not imply destination approval or a redirect", async () => {
	const assessment = await assessPaste({ ...metadata, content_type: "url" }, "https://example.com", KEY, {
		fetchImpl: mockFetch(),
	});
	assertEquals(initialModeration(assessment).decision, "unreviewed");
});

Deno.test("provider request includes public paste fields, not private audit metadata", async () => {
	let calls = 0;
	const assessment = await assessPaste({
		...metadata, filename: "note.txt", id: "CP0A1B2C",
		upload_metadata: { ip: "do-not-send" }, proof_of_work: { nonce: "do-not-send" },
	}, "hello", KEY, { fetchImpl: async (url, options) => {
		calls++;
		assertEquals(url, DECISIONS_URL);
		assertEquals(options.redirect, "manual");
		assertEquals(options.headers.authorization, `Bearer ${KEY}`);
		assert(options.signal instanceof AbortSignal);
		const request = JSON.parse(options.body);
		assertEquals(request.state, { content_type: "plaintext", content: "hello", filename: "note.txt" });
		assert(!JSON.stringify(request).includes("do-not-send"));
		return new Response(JSON.stringify(answer()));
	} });
	assertEquals(calls, 1);
	assertEquals(assessment.prompt_version, PROMPT_VERSION);
	assertEquals(assessment.model, MODEL);
	assertEquals(assessment.usage, answer().usage);
	assertEquals(assessment.task_id, "task-1");
	assertEquals(assessment.consumed, "0.00002");
	assert(Number.isFinite(Date.parse(assessment.assessed_at)));
});

Deno.test("missing key is an audited error and hides the upload without calling DefAPI", async () => {
	const assessment = await assessPaste(metadata, "hello", undefined, {
		fetchImpl: () => { throw new Error("must not call"); },
	});
	assertEquals(assessment.status, "error");
	assertMatch(assessment.detail, /DEFAPI_KEY/);
	assertEquals(initialModeration(assessment).visibility, "hidden");
});

Deno.test("media (including a misleading plaintext content_type) needs human review", async () => {
	for (const [contentType, content] of [
		["png", "data:image/png;base64,x"], ["jpeg", "image"], ["webp", "image"], ["gif", "image"],
		["mp3", "audio"], ["mp4", "video"], ["plaintext", "data:image/png;base64,x"],
		["plaintext", "data:image/webp;base64,x"], ["plaintext", "data:image/gif;base64,x"],
		["plaintext", "data:audio/mpeg;base64,x"], ["plaintext", "data:video/mp4;base64,x"],
		['plaintext', 'data:application/octet-stream;base64,YWJj'],
		['plaintext', 'Code with an embedded data:image/png;base64,YWJj payload'],
	]) {
		const assessment = await assessPaste({ ...metadata, content_type: contentType }, content, KEY, {
			fetchImpl: () => { throw new Error("must not call"); },
		});
		assertEquals(assessment.status, "unsupported");
		assertEquals(initialModeration(assessment).visibility, "hidden");
		assertEquals(initialModeration(assessment).requires_review, true);
	}
});

Deno.test("oversized bodies are held intact, not silently truncated or chunked", async () => {
	const assessment = await assessPaste({ ...metadata, byte_length: DEFAULT_MAX_BYTES + 1 }, "hello", KEY, {
		fetchImpl: () => { throw new Error("must not call"); },
	});
	assertEquals(assessment.status, "unsupported");
	assertMatch(assessment.detail, /single-request limit/);
	assertEquals(initialModeration(assessment).visibility, "hidden");
});

Deno.test("HTTP errors are held for review; no error body or credential is retained", async () => {
	for (const status of [400, 401, 429, 500]) {
		const assessment = await assessPaste(metadata, "hello", KEY, { fetchImpl: mockFetch({ message: KEY }, status) });
		assertEquals(assessment.status, "error");
		assertEquals(assessment.detail, `Jev: HTTP ${status}`);
		assertEquals(initialModeration(assessment).visibility, "hidden");
		assert(!JSON.stringify(assessment).includes(KEY));
	}
});

Deno.test("network failures cannot leak credentials or lead to approval", async () => {
	const assessment = await assessPaste(metadata, "hello", KEY, {
		fetchImpl: () => { throw new Error(`authorization: Bearer ${KEY}`); },
	});
	assertEquals(assessment.detail, "Jev: connection failed");
	assert(!JSON.stringify(assessment).includes(KEY));
	assertEquals(initialModeration(assessment).requires_review, true);
});

Deno.test("invalid, missing, contradictory, and non-normalized answers fail closed", async () => {
	const unknown = answer();
	unknown.answers.category.choice = "unknown";
	const contradictory = answer();
	contradictory.answers.category.probabilities.plaintext = 0.01;
	contradictory.answers.category.probabilities.spam = 0.94;
	const unnormalized = answer();
	unnormalized.answers.category.probabilities.spam = 1;
	for (const value of [{}, unknown, contradictory, unnormalized, { ...answer(), model: 'other/model' }, { ...answer(), model: undefined }]) {
		const assessment = await assessPaste(metadata, "hello", KEY, { fetchImpl: mockFetch(value) });
		assertEquals(assessment.status, "error");
		assertEquals(initialModeration(assessment).visibility, "hidden");
	}
});

Deno.test("malformed JSON and oversized responses do not approve a paste", async () => {
	for (const body of ["not json", "x".repeat(128 * 1024 + 1)]) {
		const assessment = await assessPaste(metadata, "hello", KEY, {
			fetchImpl: async () => new Response(body),
		});
		assertEquals(assessment.status, "error");
		assertEquals(initialModeration(assessment).visibility, "hidden");
	}
});

Deno.test("provider fields are whitelisted for persisted assessment", () => {
	const raw = answer();
	raw.private_field = "do-not-retain";
	raw.usage.paste_content = "do-not-retain";
	raw.answers.category.arbitrary = "do-not-retain";
	assert(!JSON.stringify(validateDecision(raw)).includes("do-not-retain"));
});
