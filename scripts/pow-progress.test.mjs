// Run: node --test scripts/pow-progress.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const proofSearch = source.slice(source.indexOf("const POW_RATE_KEY"), source.indexOf("async function publish()"));

function harness() {
	let now = 0;
	const statuses = [], workers = [];
	class Worker {
		constructor() { this.listeners = {}; this.stopped = false; workers.push(this); }
		addEventListener(type, listener) { this.listeners[type] = listener; }
		postMessage(message) { this.start = message; }
		terminate() { this.stopped = true; }
	}
	const context = vm.createContext({
		Worker, navigator: { hardwareConcurrency: 2 },
		performance: { now: () => now }, setStatus: (text) => statuses.push(text),
	});
	vm.runInContext(proofSearch, context);
	return {
		context, statuses, workers,
		setTime: (ms) => { now = ms; },
		send: (workerId, data) => workers[workerId].listeners.message({ data: { workerId, ...data } }),
	};
}

const challenge = {
	signature: "signed", algorithm: "sha256", difficulty: 10, expected_attempts_p50: 1000,
	challenge_id: "challenge", nonce: "nonce", content_hash: "hash",
};

test("durations use three significant digits and readable time units", () => {
	const { context } = harness();
	for (const [ms, expected] of [
		[0, "0.00s"], [1, "0.00100s"], [50, "0.0500s"], [100, "0.100s"], [123.456, "0.123s"],
		[1000, "1.00s"], [10000, "10.0s"], [1234.567, "1.23s"], [12345.67, "12.3s"], [59000, "59.0s"],
		[60000, "1.00m"], [123456, "2.06m"], [3600000, "1.00h"],
		[1234.567 * 60000, "20.6h"], [86400000, "1.00d"],
		[2.34567 * 86400000, "2.35d"], [1234.56 * 86400000, "1.23e+3d"],
		[1000 * 86400000, "1.00e+3d"],
		[59990, "1.00m"], [3599000, "1.00h"], [86399000, "1.00d"],
	]) {
		assert.equal(context.formatPowDuration(ms), expected, String(ms));
	}
	for (const ms of [NaN, Infinity, -1]) {
		assert.equal(context.formatPowDuration(ms), "estimating…");
	}
});

test("estimated durations extend to weeks and 365-day years", () => {
	const { context } = harness();
	const day = 86400000;
	for (const [ms, expected] of [
		[6 * day, "6.00d"], [7 * day - 1000, "1.00w"], [7 * day, "1.00w"],
		[14 * day, "2.00w"], [364 * day, "52.0w"],
		[365 * day, "1.00y"], [730 * day, "2.00y"],
		[1000 * 365 * day, "1.00e+3y"],
	]) {
		assert.equal(context.formatPowDuration(ms, true), expected, String(ms));
	}
	assert.equal(context.formatPowDuration(7 * day), "7.00d");
	assert.equal(context.formatPowDuration(365 * day), "365d");
});

test("duration mantissas always contain exactly three significant digits", () => {
	const { context } = harness();
	for (const extendedUnits of [false, true]) {
		for (let power = -12; power <= 300; power += 3) {
			const formatted = context.formatPowDuration(123.456 * 10 ** power, extendedUnits);
			const digits = formatted.split("e")[0].replace(/\D/g, "").replace(/^0+/, "");
			assert.equal(digits.length, 3, formatted);
			assert.match(formatted, extendedUnits ? /[smhdwy]$/ : /[smhd]$/);
		}
	}
});

test("50% proof time is expected attempts divided by measured attempts per second", () => {
	const { context } = harness();
	assert.equal(context.powP50TimeEstimate(1000, 200, 1000), "~5.00s");
	assert.equal(context.powP50TimeEstimate(1000, 400, 2000), "~5.00s");
	assert.equal(context.powP50TimeEstimate(1000, 400, 1000), "~2.50s");
	assert.equal(context.powP50TimeEstimate(1, 100, 1), "~0.0000100s");
	assert.equal(context.powP50TimeEstimate(1000, 200, 60000), "~5.00m");
	assert.equal(context.powP50TimeEstimate(1000, 100, 360000), "~1.00h");
	assert.equal(context.powP50TimeEstimate(1000, 100, 8640000), "~1.00d");
	assert.equal(context.powP50TimeEstimate(7, 1, 86400000), "~1.00w");
	assert.equal(context.powP50TimeEstimate(365, 1, 86400000), "~1.00y");
});

test("unknown throughput displays an estimating state, not NaN or Infinity", () => {
	const { context } = harness();
	for (const inputs of [
		[1000, 0, 1000], [1000, 10, 0], [1000, -1, 10],
		[NaN, 10, 1000], [1000, Infinity, 1000], [1000, 10, Infinity],
	]) {
		assert.equal(context.powP50TimeEstimate(...inputs), "estimating…");
	}
});

test("progress uses the requested three-line layout", () => {
	const { context } = harness();
	assert.equal(context.powProgressText({
		workerCount: 2, implementations: new Set(["Web Crypto"]), difficulty: 10,
		attempts: 200, p50: 1000, elapsedMs: 1000,
	}), [
		"Searching SHA-256 proof with 2 workers using WebCrypto. 10 zero bits required.",
		"  200 attempts |  1.00s elapsed",
		"1,000 attempts | ~5.00s (required for 50% chance of finding proof)",
	].join("\n"));
});

test("progress uses weeks/years only for the estimate, not elapsed time", () => {
	const { context } = harness();
	const text = context.powProgressText({
		workerCount: 2, implementations: new Set(["Web Crypto"]), difficulty: 10,
		attempts: 7, p50: 365, elapsedMs: 7 * 86400000,
	});
	assert.match(text, /7 attempts \| +7\.00d elapsed/);
	assert.match(text, /365 attempts \| ~1\.00y \(required for 50% chance/);
});

test("attempt and time numbers are right-aligned across both rows", () => {
	const { context } = harness();
	for (const values of [
		{ attempts: 200, p50: 1000, elapsedMs: 1000 },
		{ attempts: 12000, p50: 1000, elapsedMs: 1200000 },
		{ attempts: 1, p50: 2, elapsedMs: 10 },
		{ attempts: 200, p50: 1000, elapsedMs: 86400000 },
		{ attempts: 7, p50: 365, elapsedMs: 7 * 86400000 },
	]) {
		const [, actual, expected] = context.powProgressText({
			workerCount: 2, implementations: new Set(["WASM"]), difficulty: 10, ...values,
		}).split("\n");
		assert.equal(actual.indexOf(" attempts"), expected.indexOf(" attempts"));
		assert.equal(actual.indexOf("|"), expected.indexOf("|"));
		assert.equal(actual.indexOf(" elapsed"), expected.indexOf(" (required"));
	}
});

test("status styling preserves the monospaced column padding", async () => {
	const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
	const style = css.match(/\.status \{([^}]+)\}/)[1];
	assert.match(style, /font-family: var\(--mono\)/);
	assert.match(style, /white-space: pre-wrap/);
});

test("worker progress shows elapsed and aggregate 50% proof time without a countdown", async () => {
	const h = harness();
	const proof = h.context.solvePow(challenge);
	assert.equal(h.statuses.at(-1).split("\n").length, 3);
	assert.match(h.statuses.at(-1), /estimating… \(required for 50% chance of finding proof\)/);
	h.setTime(1000);
	h.send(0, { type: "progress", attempts: 100, implementation: "Web Crypto" });
	assert.match(h.statuses.at(-1), /100 attempts \| +1\.00s elapsed\n1,000 attempts \| ~10\.0s/);
	h.send(1, { type: "progress", attempts: 100, implementation: "WASM" });
	assert.match(h.statuses.at(-1), /200 attempts \| +1\.00s elapsed\n1,000 attempts \| ~5\.00s/);
	assert.match(h.statuses.at(-1), /2 workers using WebCrypto\/WASM\. 10 zero bits required\./);
	h.setTime(2000);
	h.send(0, { type: "progress", attempts: 200 });
	h.send(1, { type: "progress", attempts: 200 });
	assert.match(h.statuses.at(-1), /400 attempts \| +2\.00s elapsed\n1,000 attempts \| ~5\.00s/);
	h.send(0, { type: "result", attempts: 201, solution: "42", powHash: "proof" });
	const result = await proof;
	assert.equal(result.attempts, 401);
	assert.equal(result.ms, 2000);
	assert.match(h.statuses.at(-1), /^Proof found with .* Uploading…\n/);
	assert.match(h.statuses.at(-1), /1,000 attempts \| ~4\.99s \(required for 50% chance of finding proof\)/);
	assert.ok(h.workers.every((worker) => worker.stopped));
});

test("a proof found before any progress update still gets a time estimate", async () => {
	const h = harness();
	const proof = h.context.solvePow(challenge);
	h.setTime(10);
	h.send(0, { type: "result", attempts: 1, solution: "0", powHash: "proof" });
	await proof;
	assert.match(h.statuses.at(-1), /1,000 attempts \| +~10\.0s \(required for 50% chance of finding proof\)/);
});
