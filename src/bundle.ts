import { isContentType, type ContentType } from './content_type';
import { validatePlaintext, type StoredPaste, type StoredPasteObject } from './paste';
import { boundedBytes, parseBoundedJson } from './body';
import { sha256Hex } from './pow';
import { MAX_FILES, MAX_UPLOAD_BYTES } from '../public/policy.js';

export type BundleFile = { name: string; content_type: ContentType; content: string };
export type Bundle = { format: 'bundle-v1'; primary: string; files: BundleFile[] };
export type FileManifest = { name: string; content_type: ContentType; byte_length: number; sha256: string };
const media = new Set(['png', 'jpeg', 'webp', 'gif', 'mp3', 'mp4']);
const mimes: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp3: 'audio/mpeg', mp4: 'video/mp4' };

export function validFilename(name: unknown): name is string {
	return typeof name === 'string' && name.isWellFormed() && name.length > 0 && name.length <= 128 &&
		name !== '.' && name !== '..' && !/[\u0000-\u001f\u007f/\\?#%:]/.test(name) && name.trim() === name;
}

/** A single bounded container commits names, ordering, primary selection and contents. */
export function parseBundle(content: string): Bundle {
	const value: unknown = parseBoundedJson(content);
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid file bundle');
	const rec = value as Record<string, unknown>;
	if (Object.keys(rec).length !== 3 || Object.keys(rec).some(key => !['format', 'primary', 'files'].includes(key))) throw new Error('Unexpected bundle fields');
	if (rec.format !== 'bundle-v1' || !validFilename(rec.primary) || !Array.isArray(rec.files) ||
		rec.files.length < 1 || rec.files.length > MAX_FILES) throw new Error(`A paste needs 1–${MAX_FILES} files and a primary filename`);
	const names = new Set<string>();
	const files = rec.files.map((file: unknown): BundleFile => {
		if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Invalid file');
		const item = file as Record<string, unknown>;
		if (Object.keys(item).length !== 3 || Object.keys(item).some(key => !['name', 'content_type', 'content'].includes(key))) throw new Error('Unexpected file fields');
		if (!validFilename(item.name) || names.has(item.name.toLowerCase())) throw new Error('Filenames must be unique, simple names without paths');
		names.add(item.name.toLowerCase());
		if (!isContentType(item.content_type) || typeof item.content !== 'string') throw new Error('Invalid file type or content');
		const result = validatePlaintext(item.content);
		if (!result.ok) throw new Error(`${item.name}: ${result.error}`);
		if (result.bytes.length > MAX_UPLOAD_BYTES) throw new Error('File exceeds upload limit');
		if (media.has(item.content_type)) {
			const match = /^data:([^;]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.content);
			if (!match || match[1] !== mimes[item.content_type] || match[2]!.length % 4) throw new Error(`${item.name}: invalid media data URL`);
			const data = atob(match[2]!);
			// MIME sniffing is for safe rendering, not proof of innocuousness.
			const starts = (...bytes: number[]) => bytes.every((b, i) => data.charCodeAt(i) === b);
			const valid = item.content_type === 'png' ? starts(137,80,78,71,13,10,26,10)
				: item.content_type === 'jpeg' ? starts(255,216,255)
				: item.content_type === 'gif' ? /^GIF8[79]a/.test(data)
				: item.content_type === 'webp' ? data.startsWith('RIFF') && data.slice(8,12) === 'WEBP'
				: item.content_type === 'mp4' ? data.slice(4,8) === 'ftyp'
				: data.startsWith('ID3') || starts(255) && (data.charCodeAt(1) & 224) === 224;
			if (!valid) throw new Error(`${item.name}: media signature does not match its type`);
		}
		return { name: item.name, content_type: item.content_type, content: item.content };
	});
	if (!files.some(file => file.name === rec.primary)) throw new Error('Primary file is missing');
	return { format: 'bundle-v1', primary: rec.primary, files };
}

export async function bundleManifest(bundle: Bundle): Promise<FileManifest[]> {
	return Promise.all(bundle.files.map(async file => ({ name: file.name, content_type: file.content_type,
		byte_length: new TextEncoder().encode(file.content).length, sha256: await sha256Hex(file.content) })));
}

export function bundleAssessmentText(bundle: Bundle): { content: string; unsupported: boolean } {
	return { content: bundle.files.map(file => `File: ${JSON.stringify(file.name)} (${file.content_type})\n${file.content}`).join('\n\n'),
		unsupported: bundle.files.some(file => media.has(file.content_type)) };
}

export async function bundleFileResponse(request: Request, object: StoredPasteObject | null, stored: StoredPaste, name: string, hitCount: number): Promise<Response> {
	const item = stored.files?.find(file => file.name === name);
	if (!item) return Response.json({ error: 'File not found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
	let body: Uint8Array | null = null;
	let mime = mimes[item.content_type] ?? 'text/plain; charset=utf-8';
	if (request.method === 'GET') {
		if (!object) return new Response(null, { status: 404 });
		const stream = stored.content_encoding === 'gzip' ? object.body.pipeThrough(new DecompressionStream('gzip')) : object.body;
		const bytes = await boundedBytes(stream, MAX_UPLOAD_BYTES);
		if (bytes.length !== stored.byte_length || await sha256Hex(bytes) !== stored.sha256) throw new Error('Stored bundle integrity check failed');
		const bundle = parseBundle(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
		const file = bundle.files.find(file => file.name === name);
		if (!file) throw new Error('Stored manifest does not match its files');
		const decoded = fileBytes(file);
		body = decoded.bytes;
		mime = decoded.mime;
	}
	return new Response(body, { headers: {
		'content-type': mime, 'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff',
		'content-security-policy': "sandbox; default-src 'none'", 'referrer-policy': 'no-referrer',
		vary: 'Cookie, Authorization', 'x-hit-count': String(hitCount),
		...(body ? { 'content-length': String(body.length) } : {}),
		...(new URL(request.url).searchParams.has('download') ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}` } : {}),
	} });
}

export function fileBytes(file: BundleFile): { bytes: Uint8Array; mime: string } {
	if (media.has(file.content_type)) {
		const binary = atob(file.content.slice(file.content.indexOf(',') + 1));
		return { bytes: Uint8Array.from(binary, c => c.charCodeAt(0)), mime: mimes[file.content_type]! };
	}
	return { bytes: new TextEncoder().encode(file.content), mime: 'text/plain; charset=utf-8' };
}
