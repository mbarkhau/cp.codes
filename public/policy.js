// Shared browser/server policy. Prices are estimates; see README redesign notes.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
export const MAX_FILES = 16;
export const BASE_BYTES = 10 * 1024;
export const WINDOW_MS = 10 * 60 * 1000;
export const MAX_IP_COST_UNITS = 32;
export const MAX_GLOBAL_COST_UNITS = 512;
export const MAX_CHALLENGES_PER_IP = 30;
export const MAX_GLOBAL_CHALLENGES = 1024;
export const SHARING_LIMITS = Object.freeze({ recipients: 3, requests: 100, bytes: 32 * 1024 * 1024, ownerRequests: 200, ownerBytes: 64 * 1024 * 1024 });
/** Version-0 CP-Codes have 16 timestamp-accurate IDs per five-minute tick. */
export const SHORT_ID_CAPACITY = 16;
export const SHORT_ID_WINDOW_MS = 5 * 60 * 1000;

/** Conservative 30-day storage + operations + text moderation estimate in USD.
 * AI estimate: $0.10 / million tokens, ~4 bytes/token, one bounded request.
 * Count the inflated container, not client-claimed compressed size.
 * @param {number} bytes
 */
export function estimatedUploadCost(bytes) {
	return 0.00005 + bytes / 1e9 * 0.015 + Math.min(bytes, 248000) / 4 / 1e6 * 0.10;
}
/** @param {number} bytes */
export function uploadCostUnits(bytes) {
	if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_UPLOAD_BYTES) throw new Error(`Upload must be 1–${MAX_UPLOAD_BYTES} bytes`);
	return Math.max(1, estimatedUploadCost(bytes) / estimatedUploadCost(BASE_BYTES));
}
/** Work increases approximately linearly in estimated cost, never a bit per byte block.
 * @param {number} bytes
 */
export function sizeDifficultyBits(bytes) {
	return Math.ceil(Math.log2(uploadCostUnits(bytes)));
}
/** @param {number} units */
export function trafficDifficultyBits(units) {
	return Math.floor(Math.log2(1 + Math.max(0, units) / 12));
}
/** Regional friction for version-0 IDs. The increment is bits per ID already
 * consumed by that region's current five-minute tick and may exceed one.
 * @param {number} issued @param {number} [increment]
 */
export function shortIdDifficultyBits(issued, increment = 1) {
	if (!Number.isSafeInteger(issued) || issued < 0) throw new Error('short ID count out of range');
	if (typeof increment !== 'number' || !Number.isFinite(increment) || increment < 0 || increment > 64) throw new Error('short ID difficulty increment out of range');
	return issued * increment;
}
