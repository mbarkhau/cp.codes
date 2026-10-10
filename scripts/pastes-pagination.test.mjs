import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MODEL, PROMPT_VERSION } from '../src/jev.mjs';

let mf, options, persistPath;
const fetch = (path, init) => mf.dispatchFetch(`https://cp.codes${path}`, init);
const ids = html => [...html.matchAll(/class="recent-id" href="\/(CP\d{6})"/g)].map(match => match[1]);
const id = number => `CP${String(number).padStart(6, '0')}`;

before(async () => {
	persistPath = await mkdtemp(join(tmpdir(), 'cp-pagination-'));
	const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
import worker from './src/index.ts';
import { pasteIndexStub } from './src/paste.ts';
import { PasteIndex } from './src/index.ts';
export class PaginationTestIndex extends PasteIndex {
 legacySchema() { this.ctx.storage.sql.exec('ALTER TABLE paste_records DROP COLUMN preview'); }
 seedModels(rows) {
  for (const { paste_id, model, prompt_version } of rows) {
   this.ctx.storage.sql.exec('INSERT INTO paste_automoderation (paste_id, assessment_json, requires_review) VALUES (?, ?, 0)',
    paste_id, JSON.stringify({ model, prompt_version }));
  }
 }
}
export default { async fetch(request, env, ctx) {
 const url = new URL(request.url);
 if (url.pathname === '/__seed') {
  const index = pasteIndexStub(env);
  for (let number = 1; number <= 108; number++) {
   const id = 'CP' + String(number).padStart(6, '0');
   const created_at = new Date(Date.UTC(2026, 0, 1) + Math.floor(number / 3) * 1000).toISOString();
   const unlisted = number === 107 || number === 108;
   const metadata = { id, byte_length: 12, sha256: 'a'.repeat(64), created_at, region_id: 0, region: null,
    content_type: 'plaintext', description: null, filename: 'note' + number + '.txt', unlisted,
    upload_metadata: { 'cf-connecting-ip': 'private-audit-marker' }, proof_of_work: null,
    content_encoding: 'gzip', compressed_byte_length: 32 };
   const entry = { id, byte_length: 12, sha256: metadata.sha256, created_at, region_id: 0, region: null,
    content_type: 'plaintext', description: null, filename: metadata.filename, pow_difficulty: null,
    preview: 'Preview #' + number + ' <script>not executable</script>', hit_count: 0 };
   // 108 deliberately has inconsistent listed metadata: never expose it.
   await index.record(entry, number !== 107, 40, metadata);
   await index.updateModeration(id, { decision: number === 103 ? 'unreviewed' : number === 104 ? 'restricted' : 'approved',
    visibility: number === 105 ? 'hidden' : number === 106 ? 'deleted' : 'visible',
    moderatedBy: 'fixture', reason: number === 104 ? 'spam' : null });
  }
  return Response.json({ ok: true });
 }
 if (url.pathname === '/__legacy') { await env.PASTE_INDEX.getByName('paste-index').legacySchema(); return Response.json({ ok: true }); }
 if (url.pathname === '/__models') {
  const index = env.PASTE_INDEX.getByName('paste-index');
  if (request.method === 'POST') { await index.seedModels(await request.json()); return Response.json({ ok: true }); }
  return Response.json(await index.getAutomoderations(url.searchParams.getAll('id')));
 }
 if (url.pathname === '/__page') return Response.json(await pasteIndexStub(env).listPublicPage(Number(url.searchParams.get('page') || 1)));
 return worker.fetch(request, env, ctx);
}};` }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
	options = convertV4MiniflareOptions({ modules: true, script: result.outputFiles[0].text,
		compatibilityDate: '2026-09-05', bindings: { STAFF_ALLOW_DEVELOPMENT_LOGIN: 'false' },
		resourcePersistencePath: persistPath,
		durableObjects: { PASTE_INDEX: { className: 'PaginationTestIndex', useSQLite: true } },
	});
	mf = new Miniflare(options);
});
after(async () => { await mf?.dispose(); if (persistPath) await rm(persistPath, { recursive: true, force: true }); });

test('empty public archive renders without bogus pagination', async () => {
	const response = await fetch('/pastes');
	assert.equal(response.status, 200);
	const html = await response.text();
	assert.match(html, /No public pastes yet/);
	assert.doesNotMatch(html, /aria-label="Paste pages"/);
});

test('first page shows exactly 50 newest approved listed pastes, independent of the 40-entry cache', async () => {
	assert.equal((await fetch('/__seed')).status, 200);
	const html = await (await fetch('/pastes')).text();
	assert.deepEqual(ids(html), Array.from({ length: 50 }, (_, index) => id(102 - index)));
	assert.match(html, /Page 1 of 3 · 1–50 of 102 pastes/);
	assert.match(html, /href="\/pastes\?page=2" rel="next"/);
	assert.equal([...html.matchAll(/aria-label="Paste pages"/g)].length, 2);
	assert.doesNotMatch(html, /rel="prev"/);
	const table = html.match(/<table class="recent-list">([\s\S]*?)<\/table>/)[1];
	assert.deepEqual([...table.matchAll(/<th\b[^>]*>([^<]+)<\/th>/g)].map(match => match[1]),
		['id', 'filename', 'hits', 'bytes', 'timestamp']);
	assert.match(table, /<td class="recent-filename" title="note102.txt">note102.txt<\/td>/);
	assert.match(table, /<td class="recent-hits">0<\/td>/);
	assert.match(table, /<td class="recent-bytes">12<\/td>/);
	assert.match(table, /<td class="recent-meta">2026-01-01 00:00:34Z<\/td>/);
	assert.doesNotMatch(table, /Preview #|recent-preview|type-badge|PoW|Proof-of-work/);
	assert.doesNotMatch(html, /private-audit-marker/);
});

test('middle and last pages have correct ranges, links, and no duplicates or omissions', async () => {
	const second = await (await fetch('/pastes?page=2')).text();
	const last = await (await fetch('/pastes?page=3')).text();
	assert.deepEqual(ids(second), Array.from({ length: 50 }, (_, index) => id(52 - index)));
	assert.deepEqual(ids(last), [id(2), id(1)]);
	assert.match(second, /Page 2 of 3 · 51–100 of 102 pastes/);
	assert.match(second, /href="\/pastes\?page=1" rel="prev"/);
	assert.match(second, /href="\/pastes\?page=3" rel="next"/);
	assert.match(last, /Page 3 of 3 · 101–102 of 102 pastes/);
	assert.doesNotMatch(last, /rel="next"/);
	const first = await (await fetch('/pastes?page=1')).text();
	assert.equal(new Set([...ids(first), ...ids(second), ...ids(last)]).size, 102);
});

test('SQL pagination never returns unreviewed, restricted, hidden, deleted or unlisted entries or private metadata', async () => {
	for (const page of [1, 2, 3]) {
		const data = await (await fetch(`/__page?page=${page}`)).json();
		assert.equal(data.page_size, 50); assert.equal(data.total, 102);
		assert.ok(data.items.every(item => Number(item.id.slice(2)) <= 102));
		assert.doesNotMatch(JSON.stringify(data), /upload_metadata|proof_of_work|private-audit-marker/);
	}
});

test('out-of-range pages clamp to the last page, without unbounded offsets', async () => {
	const response = await fetch('/pastes?page=9007199254740991');
	assert.equal(response.status, 200);
	const html = await response.text();
	assert.deepEqual(ids(html), [id(2), id(1)]);
	assert.match(html, /Page 3 of 3/);
});

test('malformed page parameters are rejected', async () => {
	for (const value of ['0', '-1', '1.5', '1e2', 'abc', '', '2junk', '9007199254740992', '<script>']) {
		assert.equal((await fetch(`/pastes?page=${encodeURIComponent(value)}`)).status, 400, value);
	}
});

test('HEAD works and unsupported methods do not list pastes', async () => {
	assert.equal((await fetch('/pastes?page=2', { method: 'HEAD' })).status, 200);
	assert.equal((await fetch('/pastes', { method: 'POST' })).status, 405);
});

test('policy migration preserves dated Jev assessments across restart but reopens unsupported models', async () => {
	const rows = [
		{ paste_id: 'CP000201', model: MODEL, prompt_version: PROMPT_VERSION },
		{ paste_id: 'CP000202', model: `${MODEL}-20260917`, prompt_version: PROMPT_VERSION },
		{ paste_id: 'CP000203', model: 'typesafe/jev-1.14-20260917', prompt_version: PROMPT_VERSION },
		{ paste_id: 'CP000204', model: `${MODEL}-20260917-extra`, prompt_version: PROMPT_VERSION },
		{ paste_id: 'CP000205', model: `${MODEL}-20260917`, prompt_version: PROMPT_VERSION - 1 },
	];
	assert.equal((await fetch('/__models', { method: 'POST', body: JSON.stringify(rows) })).status, 200);
	await mf.dispose(); mf = new Miniflare(options);
	const response = await fetch('/__models?' + rows.map(row => `id=${row.paste_id}`).join('&'));
	assert.equal(response.status, 200, await response.clone().text());
	const data = await response.json();
	for (const [index, row] of rows.entries()) {
		assert.equal(data[row.paste_id].requires_review, index >= 2, row.model);
		assert.equal(data[row.paste_id].model, row.model);
	}
});

test('legacy schema upgrades preserve cached previews and moderation across restart', async () => {
	assert.equal((await fetch('/__legacy')).status, 200);
	await mf.dispose(); mf = new Miniflare(options);
	const data = await (await fetch('/__page')).json();
	assert.equal(data.total, 102); assert.equal(data.items.length, 50);
	assert.equal(data.items[0].preview, 'Preview #102 <script>not executable</script>');
	const html = await (await fetch('/pastes?page=3')).text();
	assert.deepEqual(ids(html), [id(2), id(1)]);
});
