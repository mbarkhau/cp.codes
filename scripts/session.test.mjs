// Run: node --test scripts/session.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

let mf, script;
let ipCounter = 0;
const auth = (username = "admin", password = "4dm1n") => ({
	authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
});
const fetch = (path, options = {}, instance = mf) => instance.dispatchFetch(`https://cp.codes${path}`, { redirect: "manual", ...options });
const settings = (extra = {}) => convertV4MiniflareOptions({
	modules: true, script, compatibilityDate: "2026-09-05",
	bindings: { POW_DIFFICULTY_BITS: "7", STAFF_ALLOW_DEVELOPMENT_LOGIN: 'true' },
	durableObjects: {
		STAFF_SESSIONS: { className: "TestStaffSession", useSQLite: true },
		POW_KEY: { className: "PowKey", useSQLite: true },
		PASTE_INDEX: { className: "PasteIndex", useSQLite: true },
	},
	...extra,
});
const login = (form = {}, headers = {}, instance = mf) => fetch("/login", {
	method: "POST", headers: { origin: "https://cp.codes", "cf-connecting-ip": `192.0.2.${++ipCounter}`, ...headers },
	body: new URLSearchParams({ username: "admin", password: "4dm1n", ...form }),
}, instance);
const cookieOf = response => response.headers.get("set-cookie").split(";")[0];
const getUser = async (cookie, instance = mf) => {
	const response = await fetch("/api/admin/users", { headers: { cookie } }, instance);
	assert.equal(response.status, 200);
	return (await response.json()).authenticated_user;
};
const fixture = async (action, cookie) => {
	const response = await fetch("/__session", { method: "POST", body: JSON.stringify({ action, token: cookie.split("=")[1] }) });
	assert.equal(response.status, 200);
	return response.json();
};

before(async () => {
	const bundle = await build({
		stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
import worker from "./src/index.ts";
import { StaffSession } from "./src/session.ts";
import { sha256Hex } from "./src/pow.ts";
export { PowKey, PasteIndex, MonoClock } from "./src/index.ts";
export class TestStaffSession extends StaffSession {
  cleanUp() { return this.alarm(); }
  inspect() { return Array.from(this.ctx.storage.kv.list()); }
  expire() {
    const session = this.ctx.storage.kv.get("session");
    this.ctx.storage.kv.put("session", { ...session, expiresAt: Date.now() - 1 });
  }
}
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== "/__session") return worker.fetch(request, env, ctx);
    const { token, action } = await request.json();
    const stub = env.STAFF_SESSIONS.getByName("session:" + await sha256Hex(token));
    if (action === "expire") await stub.expire();
    if (action === "alarm") await stub.cleanUp();
    return Response.json(await stub.inspect());
  }
};` },
		bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"],
	});
	script = bundle.outputFiles[0].text;
	mf = new Miniflare(settings());
});
after(async () => { await mf?.dispose(); });

test("login page and anonymous staff redirects do not trigger browser Basic Auth dialogs", async () => {
	const response = await fetch("/login?next=%2Fadmin%2Fpow");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("www-authenticate"), null);
	assert.equal(response.headers.get("cache-control"), "no-store, private");
	assert.match(response.headers.get("content-security-policy"), /form-action 'self'; frame-ancestors 'none'/);
	const html = await response.text();
	assert.match(html, /method="post" action="\/login"/);
	assert.match(html, /type="password" autocomplete="current-password"/);
	assert.match(html, /name="next" value="\/admin\/pow"/);
	const redirect = await fetch("/admin/pastes?reports=all");
	assert.equal(redirect.status, 303);
	assert.equal(redirect.headers.get("location"), "/login?next=%2Fadmin%2Fpastes%3Freports%3Dall");
	const api = await fetch("/api/admin/users");
	assert.equal(api.status, 401);
	assert.match(api.headers.get("www-authenticate"), /Basic/);
	assert.equal((await fetch("/login", { method: "PUT" })).status, 405);
});

test("login creates a random, host-only, eight-hour session with safe cookie flags", async () => {
	const response = await login({ next: "/admin/pow" });
	assert.equal(response.status, 303);
	assert.equal(response.headers.get("location"), "/admin/pow");
	const header = response.headers.get("set-cookie");
	assert.match(header, /^__Host-cp_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800; Secure$/);
	assert.doesNotMatch(header, /Domain=/);
	const cookie = cookieOf(response);
	assert.deepEqual(await getUser(cookie), { username: "admin", role: "admin" });
	const stored = await fixture("inspect", cookie);
	assert.equal(stored[0][0], "session");
	assert.equal(stored[0][1].username, "admin");
	assert.ok(stored[0][1].expiresAt > Date.now());
	assert.ok(!JSON.stringify(stored).includes(cookie.split("=")[1]));
	assert.equal((await fetch("/admin/pow", { headers: { cookie } })).status, 200);
	assert.equal((await fetch("/login", { headers: { cookie } })).status, 303);
});

test("public pages show staff navigation only after successful authentication", async () => {
	const cookie = cookieOf(await login());
	for (const path of ["/about", "/pastes", "/new", "/", "/client-info"]) {
		const response = await fetch(path, { headers: { cookie } });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store, private");
		assert.equal(response.headers.get("vary"), "Cookie, Authorization");
		const html = await response.text();
		assert.match(html, /href="\/admin\/pastes"/);
		assert.match(html, /method="post" action="\/logout"/);
		assert.ok(!html.includes(cookie.split("=")[1]));
		for (const headers of [{}, auth("admin", "wrong"), { cookie: "__Host-cp_session=" + "0".repeat(64) }]) {
			const anonymous = await (await fetch(path, { headers })).text();
			assert.doesNotMatch(anonymous, /href="\/admin\/pastes"|href="\/login"/);
		}
	}
});

test("cookie authentication preserves role restrictions and CSRF checks on staff mutations", async () => {
	const cookie = cookieOf(await login());
	for (const headers of [{}, { origin: "https://evil.example" }, { "sec-fetch-site": "same-site" }]) {
		const response = await fetch("/api/admin/pow", {
			method: "PATCH", headers: { cookie, ...headers }, body: JSON.stringify({ minimum_difficulty_bits: 8 }),
		});
		assert.equal(response.status, 403);
	}
	const saved = await fetch("/api/admin/pow", {
		method: "PATCH", headers: { cookie, origin: "https://cp.codes" }, body: JSON.stringify({ minimum_difficulty_bits: 8 }),
	});
	assert.equal(saved.status, 200);
	assert.equal((await saved.json()).minimum_difficulty_bits, 8);
	const modCookie = cookieOf(await login({ username: "moderator", password: "hunter2" }));
	assert.deepEqual(await getUser(modCookie), { username: "moderator", role: "mod" });
	assert.equal((await fetch("/api/admin/pow", {
		method: "PATCH", headers: { cookie: modCookie, origin: "https://cp.codes" }, body: JSON.stringify({ minimum_difficulty_bits: 9 }),
	})).status, 403);
	// A stray Basic header cannot override an authenticated session's identity.
	assert.equal((await fetch("/api/admin/pow", {
		method: "PATCH", headers: { cookie: modCookie, ...auth(), origin: "https://cp.codes" }, body: JSON.stringify({ minimum_difficulty_bits: 9 }),
	})).status, 403);
});

test("logout is POST-only, rejects CSRF, clears the cookie, and revokes the bearer token", async () => {
	const cookie = cookieOf(await login());
	assert.equal((await fetch("/logout", { headers: { cookie } })).status, 405);
	for (const headers of [{}, { origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }]) {
		assert.equal((await fetch("/logout", { method: "POST", headers: { cookie, ...headers } })).status, 403);
	}
	assert.equal((await getUser(cookie)).username, "admin");
	const response = await fetch("/logout", { method: "POST", headers: { cookie, origin: "https://cp.codes" } });
	assert.equal(response.status, 303);
	assert.equal(response.headers.get("location"), "/login");
	assert.match(response.headers.get("set-cookie"), /^__Host-cp_session=;.*Max-Age=0; Secure$/);
	assert.equal((await fetch("/api/admin/users", { headers: { cookie } })).status, 401);
	assert.equal((await fetch("/admin/users", { headers: { cookie } })).status, 303);
	assert.deepEqual(await fixture("inspect", cookie), []);
});

test("successful login rotates the session; failed login does not revoke it", async () => {
	const original = cookieOf(await login());
	const denied = await login({ password: "wrong" }, { cookie: original });
	assert.equal(denied.status, 401);
	assert.equal((await getUser(original)).username, "admin");
	const replacement = cookieOf(await login({ username: "moderator", password: "hunter2" }, { cookie: original }));
	assert.notEqual(replacement, original);
	assert.equal((await fetch("/api/admin/users", { headers: { cookie: original } })).status, 401);
	assert.equal((await getUser(replacement)).username, "moderator");
});

test("expired sessions fail immediately, before delayed alarm cleanup", async () => {
	const cookie = cookieOf(await login());
	await fixture("expire", cookie);
	const expired = await fetch("/api/admin/users", { headers: { cookie } });
	assert.equal(expired.status, 401);
	assert.equal(expired.headers.get("www-authenticate"), null);
	const browser = await fetch("/api/admin/users", { headers: { "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" } });
	assert.equal(browser.status, 401);
	assert.equal(browser.headers.get("www-authenticate"), null);
	const html = await (await fetch("/about", { headers: { cookie } })).text();
	assert.doesNotMatch(html, /href="\/admin\/pastes"/);
	assert.deepEqual(await fixture("alarm", cookie), []);
});

test("login rejects missing/cross-site origins, bad forms, and incorrect passwords without leaking credentials", async () => {
	for (const headers of [{ origin: "" }, { origin: "null" }, { origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }]) {
		const response = await login({}, headers);
		assert.equal(response.status, 403);
		assert.equal(response.headers.get("set-cookie"), null);
	}
	for (const password of ["wrong", "", "x".repeat(257)]) {
		const response = await login({ password });
		assert.equal(response.status, 401);
		assert.equal(response.headers.get("set-cookie"), null);
		assert.equal(response.headers.get("www-authenticate"), null);
		assert.match(await response.text(), /Invalid username or password/);
	}
	for (const body of [new URLSearchParams({ username: "x".repeat(5000) }), "not a form"]) {
		assert.equal((await fetch("/login", { method: "POST", headers: { origin: "https://cp.codes" }, body })).status, 400);
	}
});

test("login redirect destinations cannot point to another origin or reflect unsafe HTML", async () => {
	for (const next of ["https://evil.example/", "//evil.example/", "/\\evil.example/", "/login", "/logout", "/\n/evil.example"]) {
		const response = await login({ next });
		assert.equal(response.headers.get("location"), "/admin/pastes", next);
	}
	const response = await fetch('/login?next=' + encodeURIComponent('/admin/pastes?x="<script>'));
	const html = await response.text();
	assert.doesNotMatch(html.match(/<form[\s\S]*?<\/form>/)[0], /<script>/);
	assert.match(html, /name="next" value="\/admin\/pastes\?x=/);
});

test("invalid, duplicate, and wrong-scope cookies never authenticate", async () => {
	const valid = cookieOf(await login());
	for (const cookie of ["__Host-cp_session=bad", valid + "; " + valid, valid.replace("__Host-cp_session", "cp_session"), "__Host-cp_session=" + "f".repeat(64)]) {
		assert.equal((await fetch("/api/admin/users", { headers: { cookie } })).status, 401);
	}
});

test("debug output redacts session cookies and Basic credentials", async () => {
	const cookie = cookieOf(await login());
	const response = await fetch("/debug", { headers: { cookie, ...auth() } });
	const data = await response.json();
	assert.equal(data.request.headers.cookie, "[redacted]");
	assert.equal(data.request.headers.authorization, "[redacted]");
	assert.ok(!JSON.stringify(data).includes(cookie.split("=")[1]));
	assert.equal(response.headers.get("cache-control"), "no-store, private");
});

test("Basic Auth still works for CLI clients, including mutations without browser headers", async () => {
	const response = await fetch("/api/admin/users", { headers: auth() });
	assert.equal(response.status, 200);
	assert.equal((await response.json()).authenticated_user.username, "admin");
	assert.equal((await fetch("/api/admin/pow", {
		method: "PATCH", headers: auth(), body: JSON.stringify({ minimum_difficulty_bits: 7 }),
	})).status, 200);
});

test("loopback HTTP development works without weakening production cookie transport", async () => {
	const response = await mf.dispatchFetch("http://localhost:8787/login", {
		method: "POST", redirect: "manual", headers: { origin: "http://localhost:8787", "cf-connecting-ip": "local-dev" },
		body: new URLSearchParams({ username: "admin", password: "4dm1n" }),
	});
	assert.equal(response.status, 303);
	assert.match(response.headers.get("set-cookie"), /^cp_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800$/);
	assert.equal((await mf.dispatchFetch("http://localhost:8787/api/admin/users", {
		headers: { cookie: cookieOf(response) },
	})).status, 200);
	const remote = await mf.dispatchFetch("http://cp.codes/login", {
		method: "POST", headers: { origin: "http://cp.codes" }, body: new URLSearchParams({ username: "admin", password: "4dm1n" }),
	});
	assert.equal(remote.status, 400);
	assert.equal(remote.headers.get("set-cookie"), null);
});

test("login attempts are rate limited per IP across requests", async () => {
	const headers = { "cf-connecting-ip": "198.51.100.1" };
	const concurrent = await Promise.all(Array.from({ length: 11 }, () => login({ password: "wrong" }, headers)));
	assert.equal(concurrent.filter((response) => response.status === 401).length, 10);
	assert.equal(concurrent.filter((response) => response.status === 429).length, 1);
	const response = await login({}, headers);
	assert.equal(response.status, 429);
	assert.equal(response.headers.get("retry-after"), "600");
	assert.equal(response.headers.get("set-cookie"), null);
	assert.equal((await login({}, { "cf-connecting-ip": "198.51.100.2" })).status, 303);
});

test("sessions survive restarts, and logout revocation persists", async () => {
	const directory = await mkdtemp(join(tmpdir(), "cp-session-"));
	let instance;
	try {
		instance = new Miniflare(settings({ resourcePersistencePath: directory }));
		const cookie = cookieOf(await login({}, {}, instance));
		await instance.dispose();
		instance = new Miniflare(settings({ resourcePersistencePath: directory }));
		assert.equal((await getUser(cookie, instance)).username, "admin");
		assert.equal((await fetch("/logout", { method: "POST", headers: { cookie, origin: "https://cp.codes" } }, instance)).status, 303);
		await instance.dispose();
		instance = new Miniflare(settings({ resourcePersistencePath: directory }));
		assert.equal((await fetch("/api/admin/users", { headers: { cookie } }, instance)).status, 401);
	} finally {
		await instance?.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});
