import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pbkdf2Sync } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const compiled = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
const create = bindings => new Miniflare(convertV4MiniflareOptions({ modules: true, script: compiled.outputFiles[0].text, compatibilityDate: '2026-09-05', bindings,
	durableObjects: { STAFF_SESSIONS: { className: 'StaffSession', useSQLite: true } } }));
const basic = (username, password) => ({ authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') });

test('production cannot authenticate the committed development accounts', async () => {
	const mf = create({ STAFF_ALLOW_DEVELOPMENT_LOGIN: 'false' });
	try {
		for (const [username, password] of [['admin', '4dm1n'], ['moderator', 'hunter2']]) {
			const response = await mf.dispatchFetch('https://cp.codes/api/admin/users', { headers: basic(username, password) });
			assert.equal(response.status, 401);
		}
	} finally { await mf.dispose(); }
});

test('salted production credentials support sessions and never appear in staff responses', async () => {
	const salt = '1234567890abcdef1234567890abcdef';
	const password = 'this is only a test password';
	const passwordHash = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex');
	const mf = create({ STAFF_ALLOW_DEVELOPMENT_LOGIN: 'false', STAFF_CREDENTIALS: JSON.stringify([{ username: 'real-admin', role: 'admin', salt, passwordHash }]) });
	try {
		let response = await mf.dispatchFetch('https://cp.codes/api/admin/users', { headers: basic('real-admin', password) });
		assert.equal(response.status, 200);
		const body = await response.text();
		assert.ok(body.includes('real-admin')); assert.ok(!body.includes(passwordHash)); assert.ok(!body.includes(salt));
		response = await mf.dispatchFetch('https://cp.codes/api/admin/users', { headers: basic('real-admin', 'wrong') });
		assert.equal(response.status, 401);
		response = await mf.dispatchFetch('https://cp.codes/login', { method: 'POST', redirect: 'manual', headers: { origin: 'https://cp.codes', 'cf-connecting-ip': '192.0.2.5' },
			body: new URLSearchParams({ username: 'real-admin', password }) });
		assert.equal(response.status, 303);
		const cookie = response.headers.get('set-cookie').split(';')[0];
		response = await mf.dispatchFetch('https://cp.codes/api/admin/users', { headers: { cookie } });
		assert.equal(response.status, 200);
		assert.equal((await response.json()).authenticated_user.role, 'admin');
	} finally { await mf.dispose(); }
});

test('malformed credential secrets fail closed, even if the development flag is set', async () => {
	for (const secret of ['not json', '[{"username":"admin","role":"admin"}]', '[]']) {
		const mf = create({ STAFF_ALLOW_DEVELOPMENT_LOGIN: 'true', STAFF_CREDENTIALS: secret });
		try { assert.equal((await mf.dispatchFetch('https://cp.codes/api/admin/users', { headers: basic('admin', '4dm1n') })).status, 401); }
		finally { await mf.dispose(); }
	}
});
