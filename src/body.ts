export class BodyLimitError extends Error {}

export async function boundedBytes(stream: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maximum) { await reader.cancel(); throw new BodyLimitError('Request exceeds upload limit'); }
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	return bytes;
}

/** Bound allocation complexity as well as bytes. Millions of tiny objects can
 * exhaust memory even when the JSON byte length is within the upload cap. */
export function parseBoundedJson(text: string): unknown {
	let depth = 0;
	let tokens = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (character === '"') {
			while (true) {
				const quote = text.indexOf('"', index + 1);
				if (quote < 0) throw new SyntaxError('Unterminated JSON string');
				let slashes = 0;
				for (let before = quote - 1; before >= 0 && text[before] === '\\'; before--) slashes++;
				index = quote;
				if (slashes % 2 === 0) break;
			}
		} else if ('{}[],:'.includes(character!)) {
			tokens++;
			if (character === '{' || character === '[') depth++;
			if (character === '}' || character === ']') depth--;
			if (depth > 32 || tokens > 512) throw new BodyLimitError('JSON structure exceeds the complexity limit');
		}
	}
	return JSON.parse(text);
}

export async function boundedJson(request: Request, maximum: number): Promise<unknown> {
	const length = Number(request.headers.get('content-length'));
	if (length > maximum) throw new BodyLimitError('Request exceeds upload limit');
	if (!request.body) throw new Error('Empty body');
	return parseBoundedJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await boundedBytes(request.body, maximum)));
}
