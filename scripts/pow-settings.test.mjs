// Integration tests against the real Worker and SQLite Durable Objects.
// Run: node --test scripts/pow-settings.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { shortIdDifficultyBits, SHORT_ID_CAPACITY } from "../public/policy.js";

let mf;
let script;
const auth = (username = "admin", password = "4dm1n") => ({
	authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
});
const fetch = (path, options) => mf.dispatchFetch(`https://cp.codes${path}`, { redirect: "manual", ...options });
const options = (extra = {}) => convertV4MiniflareOptions({
	modules: true, script, compatibilityDate: "2026-09-05",
	bindings: { POW_DIFFICULTY_BITS: "7", STAFF_ALLOW_DEVELOPMENT_LOGIN: 'true' },
	durableObjects: {
		POW_KEY: { className: "PowKey", useSQLite: true },
		PASTE_INDEX: { className: "PasteIndex", useSQLite: true },
		MONO_CLOCK: { className: 'MonoClock', useSQLite: true },
	},
	...extra,
});
const getState = async () => {
	const response = await fetch("/api/admin/pow", { headers: auth() });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store, private");
	return response.json();
};
const update = (value, headers = auth()) => fetch("/api/admin/pow", {
	method: "PATCH", headers: { ...headers, "content-type": "application/json" },
	body: JSON.stringify({ minimum_difficulty_bits: value }),
});
const challenge = async (byteLength = 1) => {
	const response = await fetch("/api/challenge", {
		method: "POST", headers: { "content-type": "application/json", 'cf-connecting-ip': '192.0.2.99' },
		body: JSON.stringify({ content_hash: "a".repeat(64), byte_length: byteLength }),
	});
	assert.equal(response.status, 200);
	return response.json();
};

before(async () => {
	const bundle = await build({
		stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
import worker from "./src/index.ts";
import { verifyChallenge } from "./src/pow.ts";
import { regionFromRequest } from './src/region.ts';
export { PowKey, PasteIndex, MonoClock } from "./src/index.ts";
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/__seed_rate") {
      const index = env.PASTE_INDEX.getByName("paste-index");
      for (let i = 0; i < 13; i++) {
        await index.record({ id: "fixture" + i, created_at: new Date().toISOString() }, false);
        await env.POW_KEY.getByName('pow-key').admit({ challenge_id: i.toString(16).padStart(32, '0'), requester_hash: 'b'.repeat(64), byte_length: 1, difficulty: 256, expires_at: Date.now() + 600000 }, 7);
      }
      await index.record({ id: "old-fixture", created_at: new Date(Date.now() - 700000).toISOString() }, false);
      return Response.json({ ok: true });
    }
    if (path === '/__seed_short_ids') {
      const count = Number(await request.text());
      const regionHeader = request.headers.get('cf-region');
      const resolved = regionHeader ? { location_hint: regionHeader } : regionFromRequest(request);
      const clock = env.MONO_CLOCK.getByName('clock:' + resolved.location_hint, { locationHint: resolved.location_hint });
      while (await clock.shortIdCount(300) < count) await clock.recordShortId(300);
      return Response.json({ count: await clock.shortIdCount(300), region: resolved.location_hint });
    }
    if (path === "/__verify") return Response.json({ valid: !!await verifyChallenge(env, await request.json()) });
    return worker.fetch(request, env, ctx);
  }
};` },
		bundle: true, write: false, format: "esm", platform: "browser",
		external: ["cloudflare:workers"],
	});
	script = bundle.outputFiles[0].text;
	mf = new Miniflare(options());
});
after(async () => { await mf?.dispose(); });

test("settings require authentication; both roles can read but only admins can write", async () => {
	for (const path of ["/admin/pow", "/api/admin/pow"]) {
		for (const method of ["GET", "POST", "PATCH"]) {
			assert.equal((await fetch(path, { method })).status, path === "/admin/pow" && method === "GET" ? 303 : 401);
		}
		assert.equal((await fetch(path, { headers: auth("admin", "wrong") })).status, path === "/admin/pow" ? 303 : 401);
		for (const headers of [auth(), auth("moderator", "hunter2")]) {
			assert.equal((await fetch(path, { headers })).status, 200);
		}
	}
	assert.equal((await update(9, auth("moderator", "hunter2"))).status, 403);
	const deniedForm = await fetch("/admin/pow", {
		method: "POST", headers: auth("moderator", "hunter2"),
		body: new URLSearchParams({ minimum_difficulty_bits: "9" }),
	});
	assert.equal(deniedForm.status, 403);
	assert.equal((await getState()).minimum_difficulty_bits, 7);
	const html = await (await fetch("/admin/pow", { headers: auth("moderator", "hunter2") })).text();
	assert.match(html, /Only admins can change/);
	assert.match(html, /type="submit" disabled/);
});

test("default state, navigation, and effective challenge difficulty agree", async () => {
	const state = await getState();
	assert.equal(state.configured_default_bits, 7);
	assert.equal(state.minimum_difficulty_bits, 7);
	assert.equal(state.current_difficulty_bits, 7);
	assert.equal(state.override_difficulty_bits, null);
	assert.equal((await challenge()).difficulty, 7);
	const response = await fetch("/admin/pow", { headers: auth() });
	const html = await response.text();
	assert.match(html, /href="\/admin\/pow" aria-current="page">proof of work/);
	assert.match(html, /Current difficulty for a base-size paste/);
	assert.match(html, /name="minimum_difficulty_bits".*value="7"/);
	assert.match(response.headers.get("content-security-policy"), /form-action 'self'/);
});

test("save and reset work through both JSON and HTML; old challenges stay valid", async () => {
	const old = await challenge();
	const saved = await update(11);
	assert.equal(saved.status, 200);
	const state = await saved.json();
	assert.equal(state.minimum_difficulty_bits, 11);
	assert.equal(state.short_id_increment, 1);
	const increment = await fetch('/api/admin/pow', { method: 'PATCH', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ minimum_difficulty_bits: 11, short_id_increment: 1.5 }) });
	assert.equal((await increment.json()).short_id_increment, 1.5);
	assert.equal(state.override_difficulty_bits, 11);
	assert.equal(state.updated_by, "admin");
	assert.ok(Date.parse(state.updated_at));
	assert.equal((await challenge()).difficulty, 11);
	const verified = await fetch("/__verify", { method: "POST", body: JSON.stringify(old) });
	assert.equal((await verified.json()).valid, true);
	const form = await fetch("/admin/pow", {
		method: "POST", headers: { ...auth(), origin: "https://cp.codes" },
		body: new URLSearchParams({ minimum_difficulty_bits: "5" }), redirect: "manual",
	});
	assert.equal(form.status, 303);
	assert.equal(form.headers.get("location"), "/admin/pow");
	assert.equal((await challenge()).difficulty, 5);
	const reset = await fetch("/admin/pow", {
		method: "POST", headers: auth(), body: new URLSearchParams({ action: "reset" }), redirect: "manual",
	});
	assert.equal(reset.status, 303);
	assert.equal((await getState()).minimum_difficulty_bits, 7);
	await update(6);
	assert.equal((await update(null)).status, 200);
	assert.equal((await getState()).override_difficulty_bits, null);
});

test("invalid settings and cross-origin requests cannot change the minimum", async () => {
	for (const value of [-1, 257, 1.5, true, "8", "", {}, [], undefined]) {
		assert.equal((await update(value)).status, 400, JSON.stringify(value));
	}
	for (const body of ["null", "[]", "not json"]) {
		assert.equal((await fetch("/api/admin/pow", {
			method: "PATCH", headers: auth(), body,
		})).status, 400);
	}
	for (const value of ["", "-1", "1.5", "257", "bad"]) {
		assert.equal((await fetch("/admin/pow", {
			method: "POST", headers: auth(), body: new URLSearchParams({ minimum_difficulty_bits: value }),
		})).status, 400);
	}
	for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { origin: "null" }]) {
		assert.equal((await update(9, { ...auth(), ...headers })).status, 403);
	}
	assert.equal((await getState()).minimum_difficulty_bits, 7);
	for (const method of ["DELETE", "PUT"]) {
		assert.equal((await fetch("/api/admin/pow", { method, headers: auth() })).status, 405);
	}
});

test("minimum bounds, traffic, size adjustments, and saturation are reflected in new challenges", async () => {
	await update(0);
	assert.equal((await challenge()).difficulty, 0);
	await update(256);
	assert.equal((await challenge(10241)).difficulty, 256);
	await update(8);
	assert.equal((await fetch("/__seed_rate")).status, 200);
	const state = await getState();
	assert.equal(state.recent_paste_count, 13); // old fixture does not count
	assert.equal(state.rate_extra_bits, 1);
	assert.equal(state.recent_cost_units, 13);
	assert.equal(state.current_difficulty_bits, 9);
	assert.equal((await challenge(10240)).difficulty, 9);
	assert.equal((await challenge(10241)).difficulty, 10);
	assert.equal((await challenge(112641)).difficulty, 13);
	assert.equal((await fetch('/__seed_short_ids', { method: 'POST', body: '7' })).status, 200);
	assert.equal(shortIdDifficultyBits(7, 1), 7);
	assert.equal((await challenge(10240)).difficulty, 16);
	assert.equal((await fetch('/__seed_short_ids', { method: 'POST', headers: { 'cf-region': 'enam' }, body: '20' })).status, 200);
	assert.equal((await challenge(10240)).difficulty, 16);
});

test('difficulty saturates at 256 bits', async () => {
	await update(255);
	assert.equal((await getState()).current_difficulty_bits, 256);
	assert.equal((await challenge()).difficulty, 256);
	await update(null);
});

test("override persists across Worker restarts and reset uses the latest deployment default", async () => {
	const directory = await mkdtemp(join(tmpdir(), "cp-pow-settings-"));
	let instance;
	try {
		instance = new Miniflare(options({ resourcePersistencePath: directory }));
		let response = await instance.dispatchFetch("https://cp.codes/api/admin/pow", {
			method: "PATCH", headers: auth(), body: JSON.stringify({ minimum_difficulty_bits: 12 }),
		});
		assert.equal(response.status, 200);
		await instance.dispose();
		instance = new Miniflare(options({ resourcePersistencePath: directory, bindings: { POW_DIFFICULTY_BITS: "9", STAFF_ALLOW_DEVELOPMENT_LOGIN: 'true' } }));
		response = await instance.dispatchFetch("https://cp.codes/api/admin/pow", { headers: auth() });
		let state = await response.json();
		assert.equal(state.minimum_difficulty_bits, 12);
		assert.equal(state.configured_default_bits, 9);
		assert.equal(state.updated_by, "admin");
		response = await instance.dispatchFetch("https://cp.codes/api/admin/pow", {
			method: "PATCH", headers: auth(), body: JSON.stringify({ minimum_difficulty_bits: null }),
		});
		state = await response.json();
		assert.equal(state.minimum_difficulty_bits, 9);
		assert.equal(state.override_difficulty_bits, null);
	} finally {
		await instance?.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});
