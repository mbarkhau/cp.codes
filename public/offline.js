/** Bounded, best-effort saved public copies. Storage failures remain cache misses. */
const DATABASE = 'cp.codes.offline.v1';
const STORE = 'snapshots';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 40;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
let databasePromise;

function database() {
	if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE, 1);
		let expired = false;
		const timeout = setTimeout(() => { expired = true; reject(new Error('Offline storage unavailable')); }, 1500);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
		request.onerror = () => { clearTimeout(timeout); reject(request.error); };
		request.onsuccess = () => {
			clearTimeout(timeout);
			const db = request.result;
			if (expired) { db.close(); return; }
			db.onversionchange = () => { db.close(); databasePromise = null; };
			resolve(db);
		};
	}).catch(error => { databasePromise = null; throw error; });
	return databasePromise;
}

async function transaction(mode, operation) {
	const db = await database();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, mode);
		let result;
		tx.oncomplete = () => resolve(result);
		tx.onerror = tx.onabort = () => reject(tx.error || new Error('Offline storage unavailable'));
		operation(tx.objectStore(STORE), value => { result = value; });
	});
}

async function read(key) {
	try {
		const entry = await transaction('readonly', (store, done) => {
			const request = store.get(key); request.onsuccess = () => done(request.result);
		});
		if (!entry || entry.schema !== 1 || !Number.isFinite(entry.saved_at) || Date.now() - entry.saved_at > MAX_AGE) return null;
		return entry;
	} catch { return null; }
}

async function write(entry) {
	try {
		if (entry.size > MAX_BYTES) return false;
		await transaction('readwrite', (store, done) => {
			store.put({ ...entry, schema: 1, saved_at: Date.now() });
			const request = store.getAll();
			request.onsuccess = () => {
				const entries = request.result.sort((a, b) => b.saved_at - a.saved_at);
				let bytes = 0, count = 0;
				for (const item of entries) {
					if (Date.now() - item.saved_at > MAX_AGE || ++count > MAX_ENTRIES || (bytes += item.size) > MAX_BYTES) store.delete(item.key);
				}
				done(true);
			};
		});
		return true;
	} catch { return false; }
}

export async function removePasteSnapshot(id) {
	try { await transaction('readwrite', store => store.delete(`paste:${id}`)); } catch {}
}

export async function getPasteSnapshot(id) {
	const entry = await read(`paste:${id}`);
	if (!entry || !eligiblePaste(entry.metadata) || entry.metadata.id !== id ||
		!validPasteMetadata(entry.metadata) ||
		!(entry.body instanceof ArrayBuffer) || entry.body.byteLength > MAX_BODY_BYTES) return null;
	return entry;
}

function validPasteMetadata(paste) {
	return typeof paste.created_at === 'string' && typeof paste.content_type === 'string' &&
		typeof paste.type_label === 'string' && typeof paste.raw_url === 'string' &&
		paste.content_url === `/api/paste/${paste.id}/content` &&
		(paste.filename == null || typeof paste.filename === 'string') &&
		(paste.primary == null || typeof paste.primary === 'string') &&
		Number.isSafeInteger(paste.hit_count) && paste.hit_count >= 0 &&
		['single', 'bundle-v1'].includes(paste.format);
}

export function eligiblePaste(paste) {
	return paste?.offline_cacheable === true && paste.staff_review !== true && paste.moderation?.state === 'approved' &&
		!(paste.format === 'single' && paste.content_type === 'url') &&
		Number.isSafeInteger(paste.byte_length) && paste.byte_length > 0 && paste.byte_length <= 8 * 1024 * 1024 &&
		/^[0-9a-f]{64}$/.test(paste.sha256) && ['gzip', 'identity'].includes(paste.content_encoding);
}

export function snapshotResponse(snapshot) {
	return new Response(snapshot.body, { headers: {
		'x-content-encoding': snapshot.metadata.content_encoding,
		'x-hit-count': String(snapshot.metadata.hit_count),
	} });
}

// Call only after the viewer has verified and rendered the original response.
export async function savePasteSnapshot(paste, response) {
	if (!eligiblePaste(paste) || !response.ok || /no-store/.test(response.headers.get('cache-control') || '')) {
		void response.body?.cancel().catch(() => {}); return false;
	}
	try {
		const reader = response.body.getReader();
		const chunks = []; let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read(); if (done) break;
				size += value.length;
				if (size > MAX_BODY_BYTES) { await reader.cancel(); return false; }
				chunks.push(value);
			}
		} finally { reader.releaseLock(); }
		const body = new Uint8Array(size); let offset = 0;
		for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
		return await write({ key: `paste:${paste.id}`, metadata: paste, body: body.buffer,
			size: size + new TextEncoder().encode(JSON.stringify(paste)).length });
	} catch { return false; }
}

function archiveKey(page, q = '') {
	return `archive:${page}${q ? ':' + q : ''}`;
}

export async function getArchiveSnapshot(page, q = '') {
	const entry = await read(archiveKey(page, q));
	const listing = entry?.listing;
	return listing && (listing.q ?? '') === q && Number.isSafeInteger(listing.page) && String(listing.page) === String(page) &&
		Number.isSafeInteger(listing.page_size) && Number.isSafeInteger(listing.total) && Number.isSafeInteger(listing.total_pages) &&
		Array.isArray(listing.items) && listing.items.every(item => typeof item.id === 'string' &&
			typeof item.created_at === 'string' && Number.isSafeInteger(item.byte_length) &&
			(item.filename == null || typeof item.filename === 'string') && (item.primary == null || typeof item.primary === 'string')) ? entry : null;
}

export function saveArchiveSnapshot(listing) {
	return write({ key: archiveKey(listing.page, listing.q), listing, size: new TextEncoder().encode(JSON.stringify(listing)).length });
}

export async function registerOfflineShell() {
	if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js', { type: 'module', updateViaCache: 'none' });
}
