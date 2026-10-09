/** Supported binary paste formats. Signatures identify containers, not codec support. */
export const MEDIA_MIME_TYPES = Object.freeze({
	png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
	mp3: "audio/mpeg", mp4: "video/mp4",
});
const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9", "mp41", "mp42", "avc1", "M4V ", "M4A ", "MSNV", "dash", "msdh", "msix"]);

export function mediaTypeHint(file) {
	const mime = file.type.toLowerCase().split(";", 1)[0];
	const type = Object.keys(MEDIA_MIME_TYPES).find((type) => MEDIA_MIME_TYPES[type] === mime);
	if (type) return type;
	if (mime === "audio/mp3") return "mp3";
	if (mime === "audio/mp4" || mime === "application/mp4") return "mp4";
	const extension = file.name.split(".").pop()?.toLowerCase();
	if (extension === "jpg") return "jpeg";
	return Object.hasOwn(MEDIA_MIME_TYPES, extension) ? extension : null;
}

export function mediaTypeFromBytes(bytes) {
	const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
	if (bytes.byteLength >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return "png";
	if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.byteLength - 2] === 0xff && bytes[bytes.byteLength - 1] === 0xd9) return "jpeg";
	if (bytes.byteLength >= 20 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" &&
		["VP8 ", "VP8L", "VP8X"].includes(ascii(12, 16)) &&
		new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 === bytes.byteLength) return "webp";
	if (bytes.byteLength >= 14 && ["GIF87a", "GIF89a"].includes(ascii(0, 6)) && bytes[bytes.byteLength - 1] === 0x3b) return "gif";
	if (bytes.byteLength >= 10 && ascii(0, 3) === "ID3" && [2, 3, 4].includes(bytes[3]) &&
		bytes[4] !== 0xff && bytes.subarray(6, 10).every((byte) => byte < 0x80)) return "mp3";
	// Untagged MPEG Layer III frames, excluding reserved version/rate/bitrate fields.
	if (bytes.byteLength >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 &&
		(bytes[1] & 0x18) !== 0x08 && (bytes[1] & 0x06) === 0x02 &&
		(bytes[2] & 0xf0) !== 0xf0 && (bytes[2] & 0x0c) !== 0x0c) return "mp3";
	if (bytes.byteLength >= 16 && ascii(4, 8) === "ftyp") {
		const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
		if (size >= 16 && size <= bytes.byteLength && size % 4 === 0 && MP4_BRANDS.has(ascii(8, 12))) return "mp4";
	}
	return null;
}

export function mediaDataUrlType(content) {
	const match = /^data:(image\/(?:png|jpeg|webp|gif)|audio\/mpeg|video\/mp4);base64,([A-Za-z0-9+/]+={0,2})$/.exec(content.trim());
	if (!match || match[2].length % 4 !== 0) return null;
	try {
		const binary = atob(match[2]);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		const type = mediaTypeFromBytes(bytes);
		return type && MEDIA_MIME_TYPES[type] === match[1] ? type : null;
	} catch {
		return null;
	}
}
