import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { WORDLIST } from '../public/wordlist.js';
import { normalizePasscode, passphraseFromPasscode, storeAuthorization, storedPasscode, forgetAuthorization, AUTHORIZATION_STORAGE_PREFIX } from '../public/authorization.js';
import { MODEL, CRITERIA, PROMPT_VERSION } from '../src/jev.mjs';

let mf, options, persistPath;
const staff = { authorization: `Basic ${Buffer.from('admin:4dm1n').toString('base64')}` };
const fetch = (path, options = {}) => mf.dispatchFetch(`https://cp.codes${path}`, { redirect: 'manual', ...options });
const request = (path, body, method = 'POST', headers = {}) => fetch(path, { method,
	headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.50', ...headers }, body: JSON.stringify(body) });
const fixture = { status: 'classified', model: MODEL, prompt_version: PROMPT_VERSION,
	assessed_at: new Date().toISOString(), category: 'code',
	probabilities: Object.fromEntries(Object.keys(CRITERIA).map(key => [key, key === 'code' ? 1 : 0])), confidence: 1 };

before(async () => {
	persistPath = await mkdtemp(join(tmpdir(), 'cp-authorization-'));
	const compiled = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
import worker from './src/index.ts';
import { PasteIndex, putPaste } from './src/paste.ts';
import { sha256Hex } from './src/pow.ts';
export { PowKey, MonoClock, StaffSession } from './src/index.ts';
export class TestPasteIndex extends PasteIndex {
 inspectAuthorization(id) { return this.ctx.storage.sql.exec('SELECT * FROM paste_authorization WHERE paste_id = ?', id).toArray(); }
}
export default { async fetch(request, env, ctx) {
 const path = new URL(request.url).pathname;
 const index = env.PASTE_INDEX.getByName('paste-index');
 if (path === '/__seed') {
  const { id, assessment, legacy = false } = await request.json();
  const bytes = new TextEncoder().encode('Public content');
  const compressed = new Uint8Array(await new Response(new Response(bytes).body.pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const passcode = legacy ? null : await index.createPasscode(id);
  await putPaste(env, { id, byte_length: bytes.length, sha256: await sha256Hex(bytes), created_at: '2000-01-01T00:00:00Z',
   region_id: 0, region: null, content_type: 'plaintext', filename: 'note.txt', description: null,
   unlisted: false, proof_of_work: null, upload_metadata: { 'cf-connecting-ip': '192.0.2.50' } }, compressed, 'Public content', assessment);
  return Response.json({ id, passcode });
 }
 if (path === '/__inspect') return Response.json(await index.inspectAuthorization((await request.json()).id));
 if (path === '/__codes') {
  const codes = []; for (let i = 0; i < 50; i++) codes.push(await index.createPasscode('test-' + i));
  return Response.json(codes);
 }
 return worker.fetch(request, env, ctx);
}};` }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
	options = convertV4MiniflareOptions({ modules: true, script: compiled.outputFiles[0].text, resourcePersistencePath: persistPath,
		compatibilityDate: '2026-09-05', bindings: { POW_DIFFICULTY_BITS: '0', DEFAPI_KEY: 'fixture', STAFF_ALLOW_DEVELOPMENT_LOGIN: 'true' },
		r2Buckets: ['PASTES'], durableObjects: {
			PASTE_INDEX: { className: 'TestPasteIndex', useSQLite: true }, POW_KEY: { className: 'PowKey', useSQLite: true },
			MONO_CLOCK: { className: 'MonoClock', useSQLite: true }, STAFF_SESSIONS: { className: 'StaffSession', useSQLite: true },
		}, outboundService: async request => {
			assert.equal(new URL(request.url).hostname, 'api.defapi.org');
			assert.doesNotMatch(JSON.stringify(await request.json()), /passcode|passphrase/);
			return Response.json({ model: MODEL, answers: { category: { type: 'choice', choice: 'code', probabilities: fixture.probabilities } } });
		},
	});
	mf = new Miniflare(options);
});
after(async () => { await mf?.dispose(); if (persistPath) await rm(persistPath, { recursive: true, force: true }); });

async function seed(id, extra = {}) {
	const response = await request('/__seed', { id, assessment: fixture, ...extra });
	assert.equal(response.status, 200, await response.clone().text()); return response.json();
}

test('all 256 word indices round-trip through hex, including leading zeros', () => {
	assert.equal(WORDLIST.length, 256); assert.equal(new Set(WORDLIST).size, 256);
	for (let offset = 0; offset < 256; offset += 8) {
		const code = Array.from({ length: 8 }, (_, index) => (offset + index).toString(16).padStart(2, '0')).join('');
		const phrase = WORDLIST.slice(offset, offset + 8).join(' ');
		assert.equal(passphraseFromPasscode(code), phrase);
		assert.equal(normalizePasscode(phrase), code);
		assert.equal(normalizePasscode(phrase.toUpperCase().replaceAll(' ', '-')), code);
		assert.equal(normalizePasscode(` \n${code.toUpperCase()}\n `), code);
	}
	for (const input of [null, {}, [], '', 'a'.repeat(15), 'a'.repeat(17), 'z'.repeat(16), 'abacus '.repeat(7), 'abacus '.repeat(9), 'unknown '.repeat(8)]) {
		assert.equal(normalizePasscode(input), null);
	}
});

test('browser storage saves both forms, isolates paste IDs and handles invalid/unavailable storage', () => {
	const previous = globalThis.localStorage;
	const values = new Map();
	globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
	try {
		const code = '0001020304050607'; assert.equal(storeAuthorization('cp000101', code), true);
		assert.deepEqual(JSON.parse(values.get(`${AUTHORIZATION_STORAGE_PREFIX}CP000101`)), { passcode: code, passphrase: passphraseFromPasscode(code) });
		assert.equal(storedPasscode('CP000101'), code); assert.equal(storedPasscode('CP000102'), null);
		assert.equal(storeAuthorization('CP000101', 'bad'), false); assert.equal(storedPasscode('CP000101'), code);
		forgetAuthorization('CP000101'); assert.equal(storedPasscode('CP000101'), null);
		values.set(`${AUTHORIZATION_STORAGE_PREFIX}CP000101`, '{broken'); assert.equal(storedPasscode('CP000101'), null);
		globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
		assert.equal(storeAuthorization('CP000101', code), false); assert.equal(storedPasscode('CP000101'), null);
	} finally { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; }
});

test('real upload returns equivalent credentials, stores only the code and keeps public reading unchanged', async () => {
	const content = 'A harmless public document';
	const hash = value => createHash('sha256').update(value).digest('hex');
	const challenge = await (await request('/api/challenge', { content_hash: hash(content), byte_length: Buffer.byteLength(content) })).json();
	assert.equal(challenge.difficulty, 0);
	const response = await request('/api/paste', { content_gzip: gzipSync(content).toString('base64'), compression: 'gzip', content_type: 'plaintext',
		consent: true, consent_moderation: true, challenge, solution: '0', pow_hash: hash(`${challenge.content_hash}:${challenge.challenge_id}:${challenge.nonce}:0`) });
	assert.equal(response.status, 201, await response.clone().text()); const created = await response.json();
	assert.match(created.passcode, /^[0-9a-f]{16}$/); assert.equal(created.passphrase, passphraseFromPasscode(created.passcode));
	assert.equal('deletion_token' in created, false); assert.equal('deletion_expires_at' in created, false);
	assert.deepEqual(await (await request('/__inspect', { id: created.id })).json(), [{ paste_id: created.id, passcode: created.passcode }]);
	const headers = { 'cf-connecting-ip': '192.0.2.50' };
	for (const path of [`/api/paste/${created.id}`, `/${created.id}`]) {
		const result = await fetch(path, { headers: { ...headers, ...(path.startsWith('/api/') ? {} : { accept: 'text/html' }) } });
		assert.equal(result.status, 200); const body = await result.text();
		assert.ok(!body.includes(created.passcode)); assert.ok(!body.includes(created.passphrase));
	}
	assert.equal(await (await fetch(`/${created.id}.txt`, { headers })).text(), content);
	const admin = await (await fetch(`/api/admin/paste/${created.id}`, { headers: staff })).text();
	assert.ok(!admin.includes(created.passcode)); assert.ok(!admin.includes(created.passphrase));
});

test('server generates unique random codes', async () => {
	const codes = await (await request('/__codes', {})).json();
	assert.equal(new Set(codes).size, 50); assert.ok(codes.every(code => /^[0-9a-f]{16}$/.test(code)));
});

test('authorization accepts either form, rejects cross-paste and invalid credentials, and never reveals the stored code', async () => {
	const first = await seed('CP000141'); const second = await seed('CP000142');
	for (const body of [{ passcode: first.passcode.toUpperCase() }, { passphrase: passphraseFromPasscode(first.passcode).toUpperCase() }]) {
		const response = await request(`/api/paste/${first.id}/authorize`, body);
		assert.equal(response.status, 200); assert.deepEqual(await response.json(), { authorized: true, id: first.id });
	}
	for (const body of [{}, { passcode: 'bad' }, { passcode: second.passcode }, { deletion_token: first.passcode }]) {
		assert.equal((await request(`/api/paste/${first.id}/authorize`, body)).status, 403);
		assert.equal((await request(`/api/paste/${first.id}`, body, 'DELETE')).status, 403);
	}
	assert.equal((await request(`/api/paste/${first.id}/authorize`, { passcode: first.passcode }, 'POST', { origin: 'https://evil.example' })).status, 403);
	assert.equal((await request(`/api/paste/${first.id}`, { passcode: first.passcode }, 'DELETE', { 'sec-fetch-site': 'cross-site' })).status, 403);
	assert.equal((await request(`/api/paste/${first.id}/authorize`, 'x'.repeat(5000))).status, 413);
});

test('a years-old paste can be deleted with either credential, retaining its audit record and removing the body', async () => {
	for (const [id, field] of [['CP000143', 'passcode'], ['CP000144', 'passphrase']]) {
		const created = await seed(id); const credential = field === 'passcode' ? created.passcode : passphraseFromPasscode(created.passcode);
		const response = await request(`/api/paste/${id}`, { [field]: credential }, 'DELETE');
		assert.equal(response.status, 200); assert.deepEqual(await response.json(), { deleted: true, id });
		assert.equal((await fetch(`/${id}.txt`, { headers: staff })).status, 404);
		assert.equal((await request(`/api/paste/${id}/authorize`, { passcode: created.passcode })).status, 404);
		const retained = await (await fetch(`/api/admin/paste/${id}`, { headers: staff })).json();
		assert.equal(retained.moderation.visibility, 'deleted'); assert.equal(retained.metadata.created_at, '2000-01-01T00:00:00Z');
		assert.equal((await request(`/api/paste/${id}`, { [field]: credential }, 'DELETE')).status, 404);
	}
});

test('held pastes can be authorized and deleted without making content public; legacy pastes cannot be claimed', async () => {
	const held = await seed('CP000145', { assessment: { ...fixture, status: 'error' } });
	assert.equal((await fetch(`/${held.id}.txt`)).status, 404);
	assert.equal((await request(`/api/paste/${held.id}/authorize`, { passcode: held.passcode })).status, 200);
	assert.equal((await fetch(`/${held.id}.txt`)).status, 404);
	assert.equal((await request(`/api/paste/${held.id}`, { passcode: held.passcode }, 'DELETE')).status, 200);
	await seed('CP000146', { legacy: true });
	assert.equal((await request('/api/paste/CP000146/authorize', { passcode: held.passcode })).status, 403);
	assert.equal((await request('/api/paste/CP000146', { deletion_token: 'a'.repeat(64) }, 'DELETE')).status, 403);
});

test('authorization attempts are bounded per IP', async () => {
	await seed('CP000147'); let response;
	for (let attempt = 0; attempt < 31; attempt++) response = await request('/api/paste/CP000147/authorize', { passcode: 'f'.repeat(16) }, 'POST', { 'cf-connecting-ip': '198.51.100.99' });
	assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '600');
});

test('passcodes survive a Worker restart and still authorize deletion', async () => {
	const created = await seed('CP000148');
	await mf.dispose(); mf = new Miniflare(options);
	assert.equal((await request(`/api/paste/${created.id}/authorize`, { passphrase: passphraseFromPasscode(created.passcode) })).status, 200);
	assert.equal((await request(`/api/paste/${created.id}`, { passcode: created.passcode }, 'DELETE')).status, 200);
});
