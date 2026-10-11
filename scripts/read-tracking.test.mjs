import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { CRITERIA, MODEL, PROMPT_VERSION } from '../src/jev.mjs';

const compiled = await build({
	entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm',
	plugins: [{ name: 'workers-stub', setup(build) {
		build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}' }));
	} }],
});
const { default: worker, PasteIndex } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const id = 'CP000101';
const metadata = {
	id, created_at: '2026-10-11T00:00:00Z', content_type: 'plaintext',
	byte_length: 5, compressed_byte_length: 5, content_encoding: 'identity', sha256: '',
	region_id: 0, region: null, unlisted: false, filename: 'note.txt', description: null,
	upload_metadata: { 'cf-connecting-ip': '192.0.2.1' }, proof_of_work: null,
};
const moderation = { paste_id: id, visibility: 'visible', decision: 'approved' };

function fixture(completeRead, overrides = {}) {
	const stub = {
		getReadState: async () => ({ moderation, hit_count: 7 }),
		getRetainedPaste: async () => ({ metadata, moderation }),
		authorizeAccess: async () => ({ allowed: true, state: 'approved' }),
		getSharing: async () => ({ escalated: null, recipients: 0, requests: 0, bytes: 0 }),
		completeRead, ...overrides,
	};
	const env = {
		PASTE_INDEX: { getByName: () => stub },
		PASTES: {
			head: async () => ({ customMetadata: {}, size: 5, uploaded: new Date() }),
			get: async () => ({ customMetadata: {}, size: 5, uploaded: new Date(), body: new Response('Hello').body }),
		},
	};
	const pending = [];
	return { env, pending, ctx: { waitUntil: promise => pending.push(promise) } };
}

test('responses and bodies finish while tracking persistence is blocked', async () => {
	for (const [path, headers, kind, increment] of [
		[`/${id}`, { accept: 'text/html', referer: 'https://external.example/' }, 'html', false],
		[`/api/paste/${id}`, {}, 'json', false],
		[`/${id}.txt`, {}, 'raw', true],
		[`/api/paste/${id}/content`, {}, 'content', true],
		[`/api/paste/${id}/content`, { referer: `https://cp.codes/${id}` }, null, true],
	]) {
		let release;
		const blocked = new Promise(resolve => { release = resolve; });
		const writes = [];
		const { env, pending, ctx } = fixture(async (...args) => { writes.push(args); await blocked; });
		let timer;
		try {
			const response = await Promise.race([
				worker.fetch(new Request(`https://cp.codes${path}`, { headers }), env, ctx),
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('response waited for tracking')), 1000); }),
			]);
			assert.equal(response.status, 200, path);
			const body = await response.text();
			assert.ok(body.length > 0);
			assert.equal(pending.length, 1);
			assert.equal(writes.length, 1);
			assert.equal(writes[0][0], id);
			assert.equal(writes[0][1]?.kind ?? null, kind);
			assert.equal(writes[0][2], increment);
			if (kind === 'html') assert.equal(writes[0][1].referer, headers.referer);
			if (increment) assert.equal(response.headers.get('x-hit-count'), '7');
		} finally {
			clearTimeout(timer); release(); await Promise.all(pending);
		}
	}
});

test('HEAD does not schedule tracking and failed tracking does not fail a served response', async () => {
	const head = fixture(async () => { throw new Error('HEAD must not write'); });
	assert.equal((await worker.fetch(new Request(`https://cp.codes/${id}.txt`, { method: 'HEAD' }), head.env, head.ctx)).status, 200);
	assert.equal(head.pending.length, 0);
	const failed = fixture(async () => { throw new Error('storage unavailable'); });
	const response = await worker.fetch(new Request(`https://cp.codes/${id}.txt`), failed.env, failed.ctx);
	assert.equal(response.status, 200);
	assert.equal(await response.text(), 'Hello');
	await Promise.all(failed.pending);
});

function reservedIndex() {
	const index = Object.create(PasteIndex.prototype);
	index.pendingSharing = new Map();
	const sql = [];
	index.ctx = { storage: { sql: { exec(query) {
		sql.push(query);
		assert.match(query.trim(), /^SELECT /, 'admission must not write to SQLite');
		return { toArray: () => [] };
	} } } };
	index.getRetainedPaste = () => ({
		metadata, moderation: { ...moderation, decision: 'unreviewed' },
		automoderation: {
			status: 'classified', model: MODEL, prompt_version: PROMPT_VERSION,
			category: 'code', probabilities: Object.fromEntries(Object.keys(CRITERIA).map(key => [key, key === 'code' ? 1 : 0])),
		},
	});
	return { index, sql };
}

test('pending audience and traffic reservations enforce limits before any persistence', async () => {
	const { index } = reservedIndex();
	const decisions = await Promise.all(Array.from({ length: 12 }, (_, i) =>
		Promise.resolve(index.authorizeAccess(id, `198.51.100.${i + 1}`, 5, true))));
	assert.equal(decisions.filter(result => result.allowed).length, 3);
	assert.equal(index.getSharing(id).recipients, 3);
	assert.ok(index.getSharing(id).escalated);
	const traffic = reservedIndex().index;
	for (let i = 0; i < 100; i++) assert.equal(traffic.authorizeAccess(id, '198.51.100.1', 5, true).allowed, true);
	assert.equal(traffic.authorizeAccess(id, '198.51.100.1', 5, true).allowed, false);
	assert.equal(traffic.getSharing(id).requests, 100);
	const head = reservedIndex().index;
	assert.equal(head.authorizeAccess(id, '198.51.100.1', 0, false).allowed, false);
	assert.equal(head.pendingSharing.size, 0);
});
