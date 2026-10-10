// Real Workers + SQLite + R2 tests. All Jev requests use a local fixture.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { CRITERIA, MODEL, PROMPT_VERSION, initialModeration } from '../src/jev.mjs';
import { MAX_UPLOAD_BYTES, MAX_REQUEST_BYTES, uploadCostUnits, sizeDifficultyBits, shortIdDifficultyBits, SHORT_ID_CAPACITY, SHARING_LIMITS } from '../public/policy.js';

let mf;
let moderationCalls = 0;
const staff = { authorization: `Basic ${Buffer.from('admin:4dm1n').toString('base64')}` };
const hash = value => createHash('sha256').update(value).digest('hex');
const ipHeaders = ip => ({ 'cf-connecting-ip': ip });
const fetch = (path, options = {}) => mf.dispatchFetch(`https://cp.codes${path}`, { redirect: 'manual', ...options });
const jsonPost = (path, body, ip = '192.0.2.1') => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...ipHeaders(ip) }, body: JSON.stringify(body) });
const fixture = (category = 'code') => ({ status: 'classified', model: MODEL, prompt_version: PROMPT_VERSION,
	assessed_at: new Date().toISOString(), category, probabilities: Object.fromEntries(Object.keys(CRITERIA).map(key => [key, key === category ? 1 : 0])), confidence: 1,
	usage: null, task_id: null, consumed: null, detail: null });

before(async () => {
	const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
import worker from './src/index.ts';
import * as paste from './src/paste.ts';
import { parseBundle, bundleManifest } from './src/bundle.ts';
import { sha256Hex } from './src/pow.ts';
export { PasteIndex, PowKey, MonoClock, StaffSession } from './src/index.ts';
export default { async fetch(request, env, ctx) {
 const path = new URL(request.url).pathname;
 if (path === '/__seed') {
  const { id, content = 'Hello world', assessment, owner = '192.0.2.1', bundle = false, description = null, filename = 'note.txt' } = await request.json();
  const bytes = new TextEncoder().encode(content);
  const parsed = bundle ? parseBundle(content) : null;
  const metadata = { id, byte_length: bytes.length, sha256: await sha256Hex(bytes), created_at: new Date().toISOString(), region_id: 0, region: null,
   content_type: parsed?.files.find(f => f.name === parsed.primary).content_type ?? 'plaintext', description, filename: parsed?.primary ?? filename,
   unlisted: false, upload_metadata: { 'cf-connecting-ip': owner }, proof_of_work: null,
   ...(parsed ? { format: 'bundle-v1', primary: parsed.primary, files: await bundleManifest(parsed) } : {}) };
  const compressed = new Uint8Array(await new Response(new Response(bytes).body.pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  await paste.putPaste(env, metadata, compressed, { tokenHash: await sha256Hex('a'.repeat(64)), expiresAt: Date.now()+600000 }, 'fixture preview', assessment);
  return Response.json({ ok: true });
 }
 if (path === '/__admissions') {
  const { count, requester_hash = 'f'.repeat(64), rotate = false } = await request.json();
  let accepted = 0;
  for (let i=0; i<count; i++) {
   const result = await env.POW_KEY.getByName('pow-key').admit({ challenge_id: crypto.randomUUID().replaceAll('-', ''), expires_at: Date.now()+600000, requester_hash: rotate ? await sha256Hex('global-budget-' + Math.floor(i/32)) : requester_hash, byte_length: 1, difficulty: 256 }, 0);
   if (result === 'ok') accepted++;
  }
  return Response.json({ accepted });
 }
 return worker.fetch(request, env, ctx);
}};` }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
	mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-09-05',
		bindings: { POW_DIFFICULTY_BITS: '0', DEFAPI_KEY: 'fake-key', STAFF_ALLOW_DEVELOPMENT_LOGIN: 'true' }, r2Buckets: ['PASTES'],
		durableObjects: Object.fromEntries(['PASTE_INDEX:PasteIndex', 'POW_KEY:PowKey', 'MONO_CLOCK:MonoClock', 'STAFF_SESSIONS:StaffSession'].map(pair => { const [binding, className] = pair.split(':'); return [binding, { className, useSQLite: true }]; })),
		outboundService: async (request) => {
			assert.equal(new URL(request.url).host, 'api.defapi.org');
			const body = await request.json(); moderationCalls++;
			assert.ok(!JSON.stringify(body).includes('192.0.2.'));
			const answer = fixture(JSON.stringify(body.state).includes('UNSAFE') ? 'unsafe' : 'code');
			return new Response(JSON.stringify({ model: `${MODEL}-20260917`, answers: { category: { type: 'choice', choice: answer.category, probabilities: answer.probabilities } } }));
		},
	}));
});
after(async () => { await mf?.dispose(); });

async function seed(id, extra = {}) { const response = await jsonPost('/__seed', { id, assessment: fixture(), ...extra }); assert.equal(response.status, 200, await response.clone().text()); }
async function challenge(content, ip) { const response = await jsonPost('/api/challenge', { content_hash: hash(content), byte_length: Buffer.byteLength(content) }, ip); assert.equal(response.status, 200); return response.json(); }
function proof(challenge) {
	for (let n = 0; n < 1e7; n++) {
		const digest = hash(`${challenge.content_hash}:${challenge.challenge_id}:${challenge.nonce}:${n}`);
		const value = BigInt(`0x${digest}`);
		if (value < (1n << BigInt(256 - challenge.difficulty))) return { solution: String(n), pow_hash: digest };
	}
	throw new Error('fixture proof too difficult');
}
async function submit(content, challenge, ip, extra = {}) { return jsonPost('/api/paste', { content_gzip: gzipSync(content).toString('base64'), compression: 'gzip',
	content_type: 'plaintext', consent: true, consent_moderation: true, unlisted: true, challenge, ...proof(challenge), ...extra }, ip); }
async function upload(content, ip, extra) { const c = await challenge(content, ip); const response = await submit(content, c, ip, extra); assert.equal(response.status, 201, await response.clone().text()); return response.json(); }
async function approve(id) { const response = await fetch(`/api/admin/paste/${id}`, { method: 'PATCH', headers: { ...staff, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }) }); assert.equal(response.status, 200); }

const textBundle = () => JSON.stringify({ format: 'bundle-v1', primary: 'readme.md', files: [
	{ name: 'readme.md', content_type: 'markdown', content: '# Hello\n[Source](hello.js)' },
	{ name: 'hello.js', content_type: 'javascript', content: 'console.log("hello");' },
] });

test('short CP-Code difficulty doubles per consumed slot and saturates at the 16-ID capacity', () => {
	assert.deepEqual([0, 1, 2, 16, 17].map(count => shortIdDifficultyBits(count, 1.5)), [0, 1.5, 3, 24, 25.5]);
	assert.equal(SHORT_ID_CAPACITY, 16);
	assert.throws(() => shortIdDifficultyBits(-1));
});

test('cost work is bounded, monotonic, approximately linear, and has no free splitting advantage', () => {
	for (const bytes of [1, 10240, 10241, 100000, 248000, 1048576, MAX_UPLOAD_BYTES]) {
		const units = uploadCostUnits(bytes);
		assert.ok(2 ** sizeDifficultyBits(bytes) >= units);
		assert.ok(2 ** sizeDifficultyBits(bytes) < 2 * units || units === 1);
		assert.ok(2 * uploadCostUnits(Math.ceil(bytes / 2)) >= units);
	}
	assert.ok(sizeDifficultyBits(MAX_UPLOAD_BYTES) < 10);
	assert.throws(() => uploadCostUnits(MAX_UPLOAD_BYTES + 1));
});

test('aggregate safety, model-version changes and unsafe categories fail closed', () => {
	const assessment = fixture();
	assessment.probabilities.code = 0.98; assessment.probabilities.spam = 0.006; assessment.probabilities.phishing = 0.006; assessment.probabilities.csam = 0.004; assessment.probabilities.unsafe = 0.004;
	assert.equal(initialModeration(assessment).visibility, 'hidden');
	assert.equal(initialModeration({ ...fixture(), prompt_version: 1 }).visibility, 'hidden');
	assert.equal(initialModeration(fixture('unsafe')).visibility, 'hidden');
});

test('AI-cleared paste: uploader and three IPs; feed and forwarding headers cannot bypass the gate', async () => {
	const id = 'CP000101'; await seed(id);
	assert.ok(!(await (await fetch('/api/pastes')).json()).items.some(p => p.id === id));
	assert.equal((await fetch(`/api/paste/${id}`, { headers: ipHeaders('192.0.2.1') })).status, 200);
	assert.equal((await fetch(`/api/paste/${id}`, { method: 'HEAD', headers: ipHeaders('192.0.2.2') })).status, 423);
	for (const ip of ['192.0.2.2', '192.0.2.3', '192.0.2.4']) {
		assert.equal((await fetch(`/${id}.txt`, { headers: ipHeaders(ip) })).status, 200);
	}
	const headers = { ...ipHeaders('192.0.2.5'), 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.1' };
	for (const path of [`/${id}.txt`, `/api/paste/${id}`, `/api/paste/${id}/content`, `/${id}`]) {
		assert.equal((await fetch(path, { headers })).status, 423, path);
	}
	assert.equal((await fetch(`/${id}.txt`, { headers: ipHeaders('192.0.2.1') })).status, 200);
	const review = await (await fetch('/api/admin/paste/' + id, { headers: staff })).json();
	assert.equal(review.automoderation.requires_review, true);
	assert.match(await (await fetch('/admin/pastes', { headers: staff })).text(), /Traffic review/);
	await approve(id);
	assert.equal((await fetch(`/${id}.txt`, { headers })).status, 200);
	assert.ok((await (await fetch('/api/pastes')).json()).items.some(p => p.id === id));
});

test('concurrent audience admission never permits more than three recipients', async () => {
	const id = 'CP000102'; await seed(id);
	const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => fetch(`/${id}.txt`, { headers: ipHeaders(`198.51.100.${i + 1}`) })));
	assert.equal(responses.filter(r => r.status === 200).length, 3);
	assert.equal(responses.filter(r => r.status === 423).length, 9);
});

test('all metadata, HTML, raw and content paths hide uncertain or restricted content, including from owner', async () => {
	for (const [id, assessment] of [['CP000103', fixture('unsafe')], ['CP000104', { ...fixture(), status: 'error' }]]) {
		await seed(id, { assessment });
		for (const path of [`/${id}`, `/${id}.txt`, `/api/paste/${id}`, `/api/paste/${id}/content`]) {
			for (const method of ['GET', 'HEAD']) assert.equal((await fetch(path, { method, headers: ipHeaders('192.0.2.1') })).status, 404);
		}
		assert.equal((await fetch(`/admin/paste/${id}/raw`, { headers: staff })).status, 200);
	}
});

test('body request and byte budgets escalate atomically; HEAD does not spend budget', async () => {
	const id = 'CP000105'; await seed(id);
	const headers = ipHeaders('203.0.113.10');
	assert.equal((await fetch(`/api/paste/${id}`, { headers })).status, 200);
	for (let i = 0; i < 4; i++) assert.equal((await fetch(`/${id}.txt`, { method: 'HEAD', headers })).status, 200);
	const responses = await Promise.all(Array.from({ length: SHARING_LIMITS.requests + 2 }, () => fetch(`/api/paste/${id}/content`, { headers })));
	assert.equal(responses.filter(r => r.status === 200).length, SHARING_LIMITS.requests);
	assert.equal(responses.filter(r => r.status === 423).length, 2);
	assert.equal((await fetch(`/${id}.txt`, { headers: ipHeaders('192.0.2.1') })).status, 200);
	const big = 'CP000106'; await seed(big, { content: 'x'.repeat(MAX_UPLOAD_BYTES) });
	for (let i = 0; i < 4; i++) assert.equal((await fetch(`/api/paste/${big}/content`, { headers })).status, 200);
	assert.equal((await fetch(`/api/paste/${big}/content`, { headers })).status, 423);
});

test('real multi-file upload is one gzip container with immutable manifest and primary raw document', async () => {
	const content = textBundle(); const paste = await upload(content, '192.0.2.20', { format: 'bundle-v1' });
	const retained = await (await fetch('/api/admin/paste/' + paste.id, { headers: staff })).json();
	assert.equal(paste.moderation.state, 'limited', JSON.stringify(retained.automoderation)); assert.equal(paste.files.length, 2);
	assert.equal(retained.automoderation.model, `${MODEL}-20260917`);
	assert.equal(retained.automoderation.requires_review, false);
	assert.equal(paste.filename, 'readme.md'); assert.equal(paste.content_type, 'markdown');
	const headers = ipHeaders('192.0.2.20');
	const metadata = await (await fetch(`/api/paste/${paste.id}`, { headers })).json();
	assert.equal(metadata.format, 'bundle-v1'); assert.equal(metadata.primary, 'readme.md');
	assert.equal(metadata.files[1].sha256, hash('console.log("hello");'));
	assert.ok(!JSON.stringify(metadata).includes('192.0.2.20'));
	const stored = await fetch(`/api/paste/${paste.id}/content`, { headers });
	assert.equal(gunzipSync(Buffer.from(await stored.arrayBuffer())).toString(), content);
	assert.equal(await (await fetch(`/${paste.id}.md`, { headers })).text(), '# Hello\n[Source](hello.js)');
	assert.equal(await (await fetch(`/${paste.id}/files/hello.js`, { headers })).text(), 'console.log("hello");');
	assert.equal((await fetch(`/${paste.id}/files/missing.txt`, { headers })).status, 404);
	const html = await (await fetch(`/${paste.id}`, { headers: { ...headers, accept: 'text/html' } })).text();
	assert.match(html, /data-format="bundle-v1"/); assert.match(html, /id="paste-file-nav"/);
	assert.equal((await fetch(`/${paste.id}/files/hello.js?download`, { headers })).headers.get('content-disposition'), "attachment; filename*=UTF-8''hello.js");
});

test('media bundle is held as a whole; staff can inspect all files and approve without a false AI claim', async () => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7qkAAAAASUVORK5CYII=';
	const content = JSON.stringify({ format: 'bundle-v1', primary: 'readme.md', files: [
		{ name: 'readme.md', content_type: 'markdown', content: '![image](picture.png)' },
		{ name: 'picture.png', content_type: 'png', content: `data:image/png;base64,${image}` },
	] });
	const before = moderationCalls;
	const paste = await upload(content, '192.0.2.21', { format: 'bundle-v1' });
	assert.equal(moderationCalls, before); assert.equal(paste.moderation.state, 'review');
	for (const path of [`/${paste.id}/files/readme.md`, `/${paste.id}/files/picture.png`, `/api/paste/${paste.id}/content`]) {
		assert.equal((await fetch(path, { headers: ipHeaders('192.0.2.21') })).status, 404);
		assert.equal((await fetch(path, { headers: staff })).status, 200);
	}
	await approve(paste.id);
	const response = await fetch(`/${paste.id}/files/picture.png`);
	assert.equal(response.headers.get('content-type'), 'image/png');
	assert.equal(Buffer.from(await response.arrayBuffer()).toString('base64'), image);
	await fetch(`/api/admin/paste/${paste.id}`, { method: 'PATCH', headers: { ...staff, 'content-type': 'application/json' }, body: JSON.stringify({ visibility: 'deleted' }) });
	assert.equal((await fetch(`/${paste.id}/files/picture.png`, { headers: staff })).status, 404);
});

test('bundle validation rejects traversal, duplicate case-folded names, missing main and invalid media', async () => {
	const base = JSON.parse(textBundle());
	for (const mutation of [
		b => { b.files[0].name = '../escape.md'; }, b => { b.files[1].name = 'README.MD'; },
		b => { b.primary = 'missing.md'; }, b => { b.files[0].content_type = 'png'; },
		b => { b.files[0].name = '%2e%2e'; }, b => { b.files = Array(17).fill(b.files[0]); },
		b => { b.extra = 'unassessed hidden content'; }, b => { b.files[0].extra = 'unassessed hidden content'; },
	]) {
		const bundle = structuredClone(base); mutation(bundle); const content = JSON.stringify(bundle);
		const c = await challenge(content, '192.0.2.22');
		assert.equal((await submit(content, c, '192.0.2.22', { format: 'bundle-v1' })).status, 400);
	}
});

test('signed requester binding, replay, gzip bombs, and request/challenge size bounds are enforced', async () => {
	const content = 'hello'; const c = await challenge(content, '192.0.2.23');
	assert.equal((await submit(content, c, '192.0.2.24')).status, 403);
	assert.equal((await submit(content, c, '192.0.2.23')).status, 201);
	assert.equal((await submit(content, c, '192.0.2.23')).status, 409);
	const bombChallenge = await challenge('x', '192.0.2.25');
	assert.equal((await submit('x'.repeat(512 * 1024), bombChallenge, '192.0.2.25')).status, 400);
	assert.equal((await jsonPost('/api/challenge', { content_hash: hash('x'), byte_length: MAX_UPLOAD_BYTES + 1 })).status, 413);
	assert.equal((await jsonPost('/api/challenge', null)).status, 400);
	assert.equal((await fetch('/api/paste', { method: 'POST', body: ' '.repeat(MAX_REQUEST_BYTES + 1) })).status, 413);
	assert.equal((await jsonPost('/api/paste', { payload: Array.from({ length: 1000 }, () => ({})) })).status, 413);
	assert.equal((await fetch('/api/challenge', { method: 'POST', body: '['.repeat(40) + '0' + ']'.repeat(40), headers: ipHeaders('192.0.2.26') })).status, 413);
	const concurrent = await challenge('one redemption', '192.0.2.26');
	const duplicates = await Promise.all([submit('one redemption', concurrent, '192.0.2.26'), submit('one redemption', concurrent, '192.0.2.26')]);
	assert.deepEqual(duplicates.map(response => response.status).sort(), [201, 409]);
	const missingIp = await fetch('/api/challenge', { method: 'POST', headers: { 'cf-connecting-ip': 'unavailable', 'x-real-ip': '192.0.2.1', 'content-type': 'application/json' }, body: JSON.stringify({ content_hash: hash('x'), byte_length: 1 }) });
	assert.equal(missingIp.status, 403);
	const altered = { ...c, requester_hash: hash('192.0.2.24') };
	assert.equal((await submit(content, altered, '192.0.2.24')).status, 403);
});

test('client gzip side channels are stripped and padded storage is rejected before inflation', async () => {
	const content = 'Verified plain text'; const ip = '192.0.2.27';
	const original = gzipSync(Buffer.from(content)); const header = Buffer.from(original.subarray(0, 10)); header[3] = 4;
	const extra = Buffer.from('unmoderated bytes outside the plaintext'); const extraLength = Buffer.alloc(2); extraLength.writeUInt16LE(extra.length);
	const clientGzip = Buffer.concat([header, extraLength, extra, original.subarray(10)]);
	assert.equal(gunzipSync(clientGzip).toString(), content);
	const c = await challenge(content, ip);
	const response = await submit(content, c, ip, { content_gzip: clientGzip.toString('base64') });
	assert.equal(response.status, 201); const created = await response.json();
	const stored = Buffer.from(await (await fetch(`/api/paste/${created.id}/content`, { headers: ipHeaders(ip) })).arrayBuffer());
	assert.equal(gunzipSync(stored).toString(), content);
	assert.equal(stored[3] & 4, 0); assert.equal(stored.includes(extra), false);
	assert.equal(created.compressed_byte_length, stored.length); assert.equal(created.sha256, hash(content));
	const hugeExtra = Buffer.alloc(4096, 65); extraLength.writeUInt16LE(hugeExtra.length);
	const padded = Buffer.concat([header, extraLength, hugeExtra, original.subarray(10)]);
	const fresh = await challenge(content, ip);
	assert.equal((await submit(content, fresh, ip, { content_gzip: padded.toString('base64') })).status, 413);
});

test('missing assessment/state fails closed until explicit human approval', async () => {
	await seed('CP000108', { assessment: null });
	assert.equal((await fetch('/CP000108.txt', { headers: ipHeaders('192.0.2.1') })).status, 404);
	assert.equal((await fetch('/CP000108.txt', { headers: staff })).status, 200);
	const restored = await fetch('/api/admin/paste/CP000108', { method: 'PATCH', headers: { ...staff, 'content-type': 'application/json' }, body: JSON.stringify({ visibility: 'visible' }) });
	assert.equal(restored.status, 200);
	assert.equal((await fetch('/CP000108.txt', { headers: ipHeaders('192.0.2.1') })).status, 423);
	await approve('CP000108');
	assert.equal((await fetch('/CP000108.txt', { headers: ipHeaders('192.0.2.99') })).status, 200);
});

test('new pastes retain long filenames without accepting descriptions', async () => {
	const filename = '文'.repeat(255);
	const id = 'CP001239';
	await seed(id, { filename }); await approve(id);
	const last = await (await fetch(`/api/paste/${id}`)).json();
	assert.equal(last.description, null); assert.equal(last.filename, filename);
	assert.equal((await jsonPost('/api/paste', { description: 'not accepted', consent: true, consent_moderation: true })).status, 400);
});

test('prefetched cheap proofs are repriced at redemption and issuance is bounded', async () => {
	const content = 'prefetched'; const c = await challenge(content, '192.0.2.30');
	await jsonPost('/__admissions', { count: 24, requester_hash: hash('198.51.100.200') });
	assert.equal((await submit(content, c, '192.0.2.30')).status, 409);
	let last;
	for (let i = 0; i < 31; i++) last = await jsonPost('/api/challenge', { content_hash: hash('x'), byte_length: 1 }, '192.0.2.31');
	assert.equal(last.status, 429); assert.equal(last.headers.get('retry-after'), '600');
});

test('per-IP cost budget is a hard ceiling even for zero-bit configured minimum', async () => {
	const ip = '192.0.2.32'; const c = await challenge('budget', ip);
	const response = await jsonPost('/__admissions', { count: 33, requester_hash: hash(ip) });
	assert.equal((await response.json()).accepted, 32);
	assert.equal((await jsonPost('/api/challenge', { content_hash: hash('budget'), byte_length: 6 }, ip)).status, 429);
	assert.equal((await submit('budget', c, ip)).status, 429);
});

test('global cost ceiling holds across many IPs, not just one uploader', async () => {
	const c = await challenge('global budget', '192.0.2.33');
	const before = await (await fetch('/api/admin/pow', { headers: staff })).json();
	const response = await jsonPost('/__admissions', { count: 512, rotate: true });
	assert.equal((await response.json()).accepted, 512 - before.recent_cost_units);
	const state = await (await fetch('/api/admin/pow', { headers: staff })).json();
	assert.equal(state.recent_cost_units, 512);
	assert.equal((await jsonPost('/api/challenge', { content_hash: hash('global budget'), byte_length: 13 }, '192.0.2.33')).status, 429);
	assert.equal((await submit('global budget', c, '192.0.2.33')).status, 429);
});
