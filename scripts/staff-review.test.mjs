// Integration tests against the actual Worker, R2, and SQLite Durable Object.
// Run: node --test scripts/staff-review.test.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

let mf;
const auth = (username = "admin", password = "4dm1n") => ({
	authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
});
const fetch = (path, options) => mf.dispatchFetch(`https://cp.codes${path}`, { redirect: "manual", ...options });

before(async () => {
	const bundle = await build({
		stdin: {
			resolveDir: process.cwd(), loader: "ts",
			contents: `
import worker from "./src/index.ts";
import * as paste from "./src/paste.ts";
export { MonoClock, PowKey, PasteIndex, StaffSession } from "./src/index.ts";
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== "/__seed") return worker.fetch(request, env, ctx);
    const { id, visibility = "hidden", decision = "restricted", reason = "spam", encoding = "gzip", content_type = "plaintext", unlisted = false } = await request.json();
    const content = content_type === "url" ? "https://example.com/" : "Harmless review fixture <script>not executable</script>";
    const bytes = new TextEncoder().encode(content);
    const stream = new Response(bytes).body;
    const storedBytes = new Uint8Array(await new Response(encoding === "gzip" ? stream.pipeThrough(new CompressionStream("gzip")) : stream).arrayBuffer());
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
    await env.PASTES.put(paste.pasteObjectKey(id), storedBytes, { customMetadata: {
      id, byte_length: String(bytes.length), compressed_byte_length: String(storedBytes.length),
      content_encoding: encoding, sha256: hash, created_at: new Date().toISOString(), content_type,
      unlisted: String(unlisted),
    }});
    const metadata = await paste.getPasteMetadata(env, id);
    await paste.updatePasteModeration(env, id, { visibility, decision, reason, moderatedBy: "admin" }, metadata);
    return Response.json({ content });
  }
};`,
		},
		bundle: true, write: false, format: "esm", platform: "browser",
		external: ["cloudflare:workers"],
	});
	mf = new Miniflare(convertV4MiniflareOptions({
		modules: true, script: bundle.outputFiles[0].text,
		compatibilityDate: "2026-09-05", r2Buckets: ["PASTES"],
		durableObjects: {
			PASTE_INDEX: { className: "PasteIndex", useSQLite: true },
			STAFF_SESSIONS: { className: "StaffSession", useSQLite: true },
		},
	}));
});
after(async () => { await mf?.dispose(); });

async function seed(id, options = {}) {
	const response = await fetch("/__seed", { method: "POST", body: JSON.stringify({ id, ...options }) });
	assert.equal(response.status, 200);
	return (await response.json()).content;
}

for (const [index, reason] of ["spam", "CSAM", "malware or phishing"].entries()) {
	test(`staff can inspect ${reason} without exposing or changing the paste`, async () => {
		const id = `CP00000${index + 1}`;
		const content = await seed(id, { reason, unlisted: true });
		for (const path of [`/${id}`, `/${id}.txt`, `/api/paste/${id}`, `/api/paste/${id}/content`]) {
			for (const method of ["GET", "HEAD"]) {
				assert.equal((await fetch(path, { method })).status, 404, path);
			}
		}
		for (const suffix of ["view", "raw", "content"]) {
			const path = `/admin/paste/${id}/${suffix}`;
			for (const headers of [undefined, auth("admin", "wrong")]) {
				const response = await fetch(path, { headers });
				assert.equal(response.status, suffix === "view" ? 303 : 401);
				assert.equal(response.headers.get("www-authenticate"), null);
				if (suffix === "view") assert.match(response.headers.get("location"), /^\/login\?next=/);
				assert.equal((await fetch(path, { headers, method: "HEAD" })).status, suffix === "view" ? 303 : 401);
			}
			for (const headers of [auth(), auth("moderator", "hunter2")]) {
				const response = await fetch(path, { headers });
				assert.equal(response.status, 200);
				assert.equal(response.headers.get("cache-control"), "no-store, private");
				assert.equal(response.headers.get("vary"), "Cookie, Authorization");
				assert.equal(response.headers.get("referrer-policy"), "no-referrer");
				if (suffix === "view") {
					const html = await response.text();
					assert.ok(html.includes(`data-content-url="/admin/paste/${id}/content"`));
					assert.ok(html.includes(`href="/admin/paste/${id}/raw"`));
					assert.ok(html.includes('data-staff-review="true"'));
					assert.ok(!html.includes(content));
				} else if (suffix === "raw") {
					assert.equal(await response.text(), content);
					assert.match(response.headers.get("content-security-policy"), /sandbox/);
				} else {
					assert.equal(response.headers.get("x-content-encoding"), "gzip");
					assert.equal(gunzipSync(Buffer.from(await response.arrayBuffer())).toString(), content);
				}
				const head = await fetch(path, { headers, method: "HEAD" });
				assert.equal(head.status, 200);
				assert.equal(await head.text(), "");
			}
			assert.equal((await fetch(path, { headers: auth(), method: "POST" })).status, 405);
		}
		const state = await (await fetch(`/api/admin/paste/${id}`, { headers: auth() })).json();
		assert.equal(state.moderation.visibility, "hidden");
		assert.equal(state.moderation.reason, reason);
		const dataset = await (await fetch("/api/admin", { headers: auth() })).json();
		assert.equal(dataset.pastes.find(item => item.metadata.id === id).hit_count, 0);
		const panel = await (await fetch("/admin/pastes?reports=all", { headers: auth() })).text();
		assert.ok(panel.includes(`href="/admin/paste/${id}/view"`));
	});
}

test("unreviewed held content is visible only to staff", async () => {
	const id = "CP000007";
	const content = await seed(id, { decision: "unreviewed", reason: null });
	assert.equal((await fetch(`/api/paste/${id}/content`)).status, 404);
	assert.equal(await (await fetch(`/admin/paste/${id}/raw`, { headers: auth() })).text(), content);
});

test("identity-encoded bodies and approved URL pastes are inspectable without redirecting", async () => {
	const id = "CP000004";
	const content = await seed(id, { encoding: "identity", content_type: "url", visibility: "visible", decision: "approved", reason: null });
	const view = await fetch(`/admin/paste/${id}/view`, { headers: auth() });
	assert.equal(view.status, 200);
	assert.equal(view.headers.get("location"), null);
	for (const suffix of ["raw", "content"]) {
		const response = await fetch(`/admin/paste/${id}/${suffix}`, { headers: auth() });
		assert.equal(await response.text(), content);
	}
	assert.equal((await fetch(`/admin/paste/${id}/view`)).status, 303);
});

test("deleted bodies are unavailable even if an R2 object still exists", async () => {
	const id = "CP000005";
	await seed(id, { visibility: "deleted" });
	for (const suffix of ["view", "raw", "content"]) {
		for (const method of ["GET", "HEAD"]) {
			assert.equal((await fetch(`/admin/paste/${id}/${suffix}`, { method, headers: auth() })).status, 404);
			assert.equal((await fetch(`/api/paste/${id}/content`, { method, headers: auth() })).status, 404);
		}
	}
});

test("session cookies allow hidden-paste review without Basic Auth or publishing content", async () => {
	const id = "CP000008";
	const content = await seed(id);
	const login = await fetch("/login", {
		method: "POST", headers: { origin: "https://cp.codes" },
		body: new URLSearchParams({ username: "moderator", password: "hunter2" }),
	});
	assert.equal(login.status, 303);
	const cookie = login.headers.get("set-cookie").split(";")[0];
	for (const suffix of ["view", "raw", "content"]) {
		const response = await fetch(`/admin/paste/${id}/${suffix}`, { headers: { cookie } });
		assert.equal(response.status, 200);
		if (suffix === "raw") assert.equal(await response.text(), content);
	}
	const state = await (await fetch(`/api/admin/paste/${id}`, { headers: { cookie } })).json();
	assert.equal(state.moderation.visibility, "hidden");
	const canonical = await fetch(`/${id}`, { headers: { cookie, accept: "text/html" } });
	assert.equal(canonical.status, 200);
	assert.match(await canonical.text(), /data-staff-review="true"/);
	assert.equal((await fetch(`/api/paste/${id}/content`)).status, 404);
	assert.equal((await fetch(`/api/paste/${id}/content`, { headers: { cookie } })).status, 200);
	assert.equal((await fetch(`/api/paste/${id}/content`)).status, 404);
});

test("missing bodies do not expose retained content", async () => {
	for (const suffix of ["view", "raw", "content"]) {
		assert.equal((await fetch(`/admin/paste/CP000006/${suffix}`, { headers: auth() })).status, 404);
	}
});
