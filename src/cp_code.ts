/**
 * CP-Code ID codec — TypeScript port of prototype/cp_code.py
 *
 * 9-character ID = `CP` + 7-character Base32 (35 bit) payload:
 *
 * - version: 5 bits — `0..31` (format version; currently 0)
 * - timestamp: 20 bits — ticks since TIME_EPOCH at TIME_RESOLUTION
 * - counter: 7 bits — per-tick sequence `0..127`
 * - region ID: 3 bits — `0..7`
 *
 * Layout: [version:5][timestamp:20][counter:7][region:3]
 *
 * At 300s resolution, 20-bit ticks cover ~10 years
 *
 * Note: multi-bit packing uses BigInt. JavaScript's `<<` / `&` are 32-bit.
 */

/** Current format version written into new IDs. */
export const CURRENT_VERSION = 0;

/** Fixed time base for tick 0 (unix seconds). */
export const TIME_EPOCH = 1_785_000_000;

/** Tick length in seconds. */
export const TIME_RESOLUTION = 300;

export type CPCode = {
	version: number;
	timestamp: number;
	counter: number;
	region_id: number;
};

/** Custom alphabet (no M/N/O/W) for readable IDs. */
export const ALPHABET = "0123456789ABCDEFGHIJKLPQRSTUVXYZ";

export const VERSION_BITS = 5;
export const TIMESTAMP_BITS = 20;
export const COUNTER_BITS = 7;
export const REGION_ID_BITS = 3;

export const PAYLOAD_BITS = VERSION_BITS + TIMESTAMP_BITS + COUNTER_BITS + REGION_ID_BITS;
export const PAYLOAD_CHARS = 7; // 35 bits → 7 Base32 chars
export const ID_PREFIX = "CP";
export const ID_LENGTH = ID_PREFIX.length + PAYLOAD_CHARS; // 9

const MAX_TICK = 2 ** TIMESTAMP_BITS;
const MAX_COUNTER = 2 ** COUNTER_BITS;
const MAX_TICK_DURATION_S = MAX_TICK * TIME_RESOLUTION;

const VERSION_MASK = (1n << BigInt(VERSION_BITS)) - 1n;
const TIMESTAMP_MASK = (1n << BigInt(TIMESTAMP_BITS)) - 1n;
const COUNTER_MASK = (1n << BigInt(COUNTER_BITS)) - 1n;
const REGION_MASK = (1n << BigInt(REGION_ID_BITS)) - 1n;

export function timeRange(): { start: number; end: number; years: number } {
	return {
		start: TIME_EPOCH,
		end: TIME_EPOCH + MAX_TICK_DURATION_S,
		years: MAX_TICK_DURATION_S / 31_557_600,
	};
}

function assertVersion(version: number): void {
	if (!Number.isInteger(version) || version < 0 || version >= 1 << VERSION_BITS) {
		throw new Error(`version must be an integer between 0 and ${(1 << VERSION_BITS) - 1}`);
	}
	if (version !== CURRENT_VERSION) {
		throw new Error(`unsupported version: ${version}`);
	}
}

function assertCounter(counter: number): void {
	if (!Number.isInteger(counter) || counter < 0 || counter >= MAX_COUNTER) {
		throw new Error(`counter must be an integer between 0 and ${MAX_COUNTER - 1}`);
	}
}

function assertRegionId(regionId: number): void {
	if (!Number.isInteger(regionId) || regionId < 0 || regionId >= 1 << REGION_ID_BITS) {
		throw new Error(`region_id must be an integer between 0 and ${(1 << REGION_ID_BITS) - 1}`);
	}
}

/** Convert unix seconds → tick index (nearest). */
export function timestampToTick(timestamp: number): number {
	return Math.round((timestamp - TIME_EPOCH) / TIME_RESOLUTION);
}

/** Convert tick index → unix seconds. */
export function tickToTimestamp(tick: number): number {
	return TIME_EPOCH + tick * TIME_RESOLUTION;
}

/** Snap a unix timestamp to the resolution grid (nearest tick). */
export function alignTimestamp(timestamp: number): number {
	return tickToTimestamp(timestampToTick(timestamp));
}

export function encodeCpCode(cpCode: CPCode): string {
	assertVersion(cpCode.version);
	assertCounter(cpCode.counter);
	assertRegionId(cpCode.region_id);

	const offset = cpCode.timestamp - TIME_EPOCH;
	if (offset < 0) {
		throw new Error("timestamp is before TIME_EPOCH");
	}

	const tsVal = timestampToTick(cpCode.timestamp);
	if (Math.abs(offset - tsVal * TIME_RESOLUTION) > 1e-6) {
		throw new Error("timestamp is not aligned to TIME_RESOLUTION");
	}
	if (tsVal < 0 || tsVal >= MAX_TICK) {
		throw new Error("timestamp is outside the supported range");
	}

	// [version:5][timestamp:20][counter:7][region:3] = 35 bits
	let payload =
		(BigInt(cpCode.version) << BigInt(TIMESTAMP_BITS + COUNTER_BITS + REGION_ID_BITS)) |
		(BigInt(tsVal) << BigInt(COUNTER_BITS + REGION_ID_BITS)) |
		(BigInt(cpCode.counter) << BigInt(REGION_ID_BITS)) |
		BigInt(cpCode.region_id);

	const chars: string[] = [];
	for (let i = 0; i < PAYLOAD_CHARS; i++) {
		chars.push(ALPHABET[Number(payload & 0x1fn)]!);
		payload >>= 5n;
	}
	return ID_PREFIX + chars.reverse().join("");
}

export function generateCpCode(
	regionId = 0,
	timestamp: number = Date.now() / 1000,
	counter = 0,
	version: number = CURRENT_VERSION,
): CPCode {
	assertVersion(version);
	assertRegionId(regionId);
	assertCounter(counter);
	if (!Number.isFinite(timestamp)) {
		throw new Error("timestamp must be a finite number");
	}

	const aligned = alignTimestamp(timestamp);
	const tick = timestampToTick(aligned);
	if (tick < 0 || tick >= MAX_TICK) {
		throw new Error("timestamp is outside the supported range");
	}
	return { version, timestamp: aligned, counter, region_id: regionId };
}

export function makeCpCode(
	regionId = 0,
	timestamp: number = Date.now() / 1000,
	counter = 0,
	version: number = CURRENT_VERSION,
): string {
	return encodeCpCode(generateCpCode(regionId, timestamp, counter, version));
}

export function parseCpCode(cpCodeData: string): CPCode {
	if (typeof cpCodeData !== "string" || cpCodeData.length !== ID_LENGTH) {
		throw new Error(`ID must be exactly ${ID_LENGTH} characters`);
	}
	if (!cpCodeData.startsWith(ID_PREFIX)) {
		throw new Error(`ID must use prefix '${ID_PREFIX}'`);
	}

	let payload = 0n;
	for (const char of cpCodeData.slice(ID_PREFIX.length).toUpperCase()) {
		const digit = ALPHABET.indexOf(char);
		if (digit < 0) {
			throw new Error(`invalid Base32 character: '${char}'`);
		}
		payload = (payload << 5n) | BigInt(digit);
	}

	// [version:5][timestamp:20][counter:7][region:3]
	const version = Number(
		(payload >> BigInt(TIMESTAMP_BITS + COUNTER_BITS + REGION_ID_BITS)) & VERSION_MASK,
	);
	const tsVal = Number(
		(payload >> BigInt(COUNTER_BITS + REGION_ID_BITS)) & TIMESTAMP_MASK,
	);
	const counter = Number((payload >> BigInt(REGION_ID_BITS)) & COUNTER_MASK);
	const regionId = Number(payload & REGION_MASK);

	assertVersion(version);
	return {
		version,
		timestamp: tickToTimestamp(tsVal),
		counter,
		region_id: regionId,
	};
}
