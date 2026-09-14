/**
 * CP-Code ID codec — TypeScript port of prototype/cp_code.py
 *
 * The version is identified by the total ID length, not stored in the payload.
 *
 * 8-character ID = `CP` + 6-character Base32 (30 bit) payload:
 *
 * - timestamp: 24 bits — ticks since TIME_EPOCH at TIME_RESOLUTION
 * - counter: 4 bits — per-tick sequence number
 * - region ID: 2 bits
 *
 * Layout: [timestamp:24][counter:4][region:2]
 *
 * 9-character ID = `CP` + 7-character Base32 (35 bit) payload:
 *
 * - timestamp: 24 bits — ticks since TIME_EPOCH at TIME_RESOLUTION
 * - counter: 9 bits — per-tick sequence number
 * - region ID: 2 bits
 *
 * Layout: [timestamp:24][counter:9][region:2]
 *
 * At 5 minute resolution, the 24-bit timestamp wraps after about 160 years.
 * Regions: enam=0, weur=1, apac=2, sam=3.
 *
 * Note: multi-bit packing uses BigInt. JavaScript's `<<` / `&` are 32-bit.
 */

export type CPCode = {
	timestamp: number;
	counter: number;
	region_id: number;
	version: number;
};

/** Custom alphabet (no M/N/O/W) for readable IDs. */
export const ALPHABET = "0123456789ABCDEFGHIJKLPQRSTUVXYZ";
export const ID_PREFIX = "CP";
export const TIMESTAMP_BITS = 24;
export const REGION_ID_BITS = 2;
export const V0_COUNTER_BITS = 4;
export const V1_COUNTER_BITS = 9;

export const VERSION_0 = 0;
export const VERSION_1 = 1;
export const CURRENT_VERSION = VERSION_0;

export const COUNTER_BITS_BY_VERSION = Object.freeze({
	[VERSION_0]: V0_COUNTER_BITS,
	[VERSION_1]: V1_COUNTER_BITS,
});

export const PAYLOAD_CHARS_BY_VERSION = Object.freeze({
	[VERSION_0]: (TIMESTAMP_BITS + V0_COUNTER_BITS + REGION_ID_BITS) / 5,
	[VERSION_1]: (TIMESTAMP_BITS + V1_COUNTER_BITS + REGION_ID_BITS) / 5,
});

export const ID_LENGTH_BY_VERSION = Object.freeze({
	[VERSION_0]: ID_PREFIX.length + PAYLOAD_CHARS_BY_VERSION[VERSION_0],
	[VERSION_1]: ID_PREFIX.length + PAYLOAD_CHARS_BY_VERSION[VERSION_1],
});

export const VERSION_BY_ID_LENGTH = Object.freeze({
	[ID_LENGTH_BY_VERSION[VERSION_0]]: VERSION_0,
	[ID_LENGTH_BY_VERSION[VERSION_1]]: VERSION_1,
});

/** Aliases for the default format. */
export const PAYLOAD_CHARS = PAYLOAD_CHARS_BY_VERSION[CURRENT_VERSION];
export const PAYLOAD_BITS = PAYLOAD_CHARS * 5;
export const ID_LENGTH = ID_LENGTH_BY_VERSION[CURRENT_VERSION];

/** Fixed time base for tick 0 (unix seconds). */
export const TIME_EPOCH = 1_785_000_000;
/** Tick length in seconds. */
export const TIME_RESOLUTION = 5 * 60;
export const MAX_TICK = 2 ** TIMESTAMP_BITS;
export const V0_MAX_COUNTER = 2 ** V0_COUNTER_BITS;
export const V1_MAX_COUNTER = 2 ** V1_COUNTER_BITS;

const MAX_TICK_DURATION_S = MAX_TICK * TIME_RESOLUTION;
const TIMESTAMP_MASK = (1n << BigInt(TIMESTAMP_BITS)) - 1n;
const REGION_MASK = (1n << BigInt(REGION_ID_BITS)) - 1n;

const lastPartsByVersion: Record<number, { timestamp: number; counter: number }> = {
	[VERSION_0]: { timestamp: 0, counter: -1 },
	[VERSION_1]: { timestamp: 0, counter: -1 },
};

export function timeRange(): { start: number; end: number; years: number } {
	return {
		start: TIME_EPOCH,
		end: TIME_EPOCH + MAX_TICK_DURATION_S,
		years: MAX_TICK_DURATION_S / 31_557_600,
	};
}

function counterBitsForVersion(version: number): number {
	if (version === VERSION_0) return V0_COUNTER_BITS;
	if (version === VERSION_1) return V1_COUNTER_BITS;
	throw new Error(`unsupported version: ${version}`);
}

function payloadCharsForVersion(version: number): number {
	if (version === VERSION_0) return PAYLOAD_CHARS_BY_VERSION[VERSION_0];
	if (version === VERSION_1) return PAYLOAD_CHARS_BY_VERSION[VERSION_1];
	throw new Error(`unsupported version: ${version}`);
}

function versionForIdLength(idLength: number): number | undefined {
	if (idLength === ID_LENGTH_BY_VERSION[VERSION_0]) return VERSION_0;
	if (idLength === ID_LENGTH_BY_VERSION[VERSION_1]) return VERSION_1;
	return undefined;
}

function assertCounter(counter: number, maxCounter: number): void {
	if (!Number.isInteger(counter) || counter < 0 || counter >= maxCounter) {
		throw new Error(`counter must be between 0 and ${maxCounter - 1}`);
	}
}

function assertRegionId(regionId: number): void {
	if (!Number.isInteger(regionId) || regionId < 0 || regionId >= 2 ** REGION_ID_BITS) {
		throw new Error(`region_id must be between 0 and ${2 ** REGION_ID_BITS - 1}`);
	}
}

/** Python-compatible round-to-nearest, with ties going to the even integer. */
function roundHalfToEven(value: number): number {
	const lower = Math.floor(value);
	const fraction = value - lower;
	if (fraction < 0.5) return lower;
	if (fraction > 0.5) return lower + 1;
	return lower % 2 === 0 ? lower : lower + 1;
}

/** Convert unix seconds to a tick index (nearest). */
export function timestampToTick(timestamp: number): number {
	return roundHalfToEven((timestamp - TIME_EPOCH) / TIME_RESOLUTION);
}

/** Convert a tick index to unix seconds. */
export function tickToTimestamp(tick: number): number {
	return TIME_EPOCH + tick * TIME_RESOLUTION;
}

/** Snap a unix timestamp to the resolution grid (nearest tick). */
export function alignTimestamp(timestamp: number): number {
	return tickToTimestamp(timestampToTick(timestamp));
}

/** Return the next monotonic timestamp/counter pair on the resolution grid. */
export function nextParts(
	lastTs = 0,
	lastCounter = -1,
	now: number = Date.now() / 1000,
	maxCounter = V0_MAX_COUNTER,
): { timestamp: number; counter: number } {
	if (!Number.isFinite(now)) {
		throw new Error("now must be a finite number");
	}
	if (!Number.isInteger(maxCounter) || maxCounter < 1) {
		throw new Error("maxCounter must be a positive integer");
	}

	// Match Python's int(...) conversion. For supported timestamps this floors
	// wall-clock time so a tick still in the future is never issued.
	const nowTick = Math.trunc((now - TIME_EPOCH) / TIME_RESOLUTION);
	let tick: number;
	let counter: number;

	if (lastTs <= 0) {
		tick = nowTick;
		counter = 0;
	} else {
		const lastTick = timestampToTick(lastTs);
		if (nowTick > lastTick) {
			tick = nowTick;
			counter = 0;
		} else {
			tick = lastTick;
			counter = lastCounter + 1;
			if (counter >= maxCounter) {
				counter = 0;
				tick = lastTick + 1;
			}
		}
	}

	if (tick < 0 || tick >= MAX_TICK) {
		throw new Error("timestamp is outside the supported range");
	}
	return { timestamp: tickToTimestamp(tick), counter };
}

export function encodeCpCode(cpCode: CPCode): string {
	const counterBits = counterBitsForVersion(cpCode.version);
	const maxCounter = 2 ** counterBits;
	assertCounter(cpCode.counter, maxCounter);
	assertRegionId(cpCode.region_id);

	if (!Number.isFinite(cpCode.timestamp)) {
		throw new Error("timestamp must be a finite number");
	}
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

	let payload =
		(BigInt(tsVal) << BigInt(counterBits + REGION_ID_BITS)) |
		(BigInt(cpCode.counter) << BigInt(REGION_ID_BITS)) |
		BigInt(cpCode.region_id);

	const chars: string[] = [];
	for (let i = 0; i < payloadCharsForVersion(cpCode.version); i++) {
		chars.push(ALPHABET[Number(payload & 0x1fn)]!);
		payload >>= 5n;
	}
	return ID_PREFIX + chars.reverse().join("");
}

export function generateCpCode(
	regionId = 0,
	timestamp?: number,
	counter?: number,
	version: number = CURRENT_VERSION,
): CPCode {
	const counterBits = counterBitsForVersion(version);
	const maxCounter = 2 ** counterBits;
	assertRegionId(regionId);

	let timestampPart: number;
	let counterPart: number;
	if (timestamp === undefined) {
		if (counter !== undefined) {
			throw new Error("counter requires an explicit timestamp");
		}
		const last = lastPartsByVersion[version]!;
		const next = nextParts(last.timestamp, last.counter, Date.now() / 1000, maxCounter);
		last.timestamp = next.timestamp;
		last.counter = next.counter;
		timestampPart = next.timestamp;
		counterPart = next.counter;
	} else {
		if (!Number.isFinite(timestamp)) {
			throw new Error("timestamp must be a finite number");
		}
		timestampPart = alignTimestamp(timestamp);
		const tick = timestampToTick(timestampPart);
		if (tick < 0 || tick >= MAX_TICK) {
			throw new Error("timestamp is outside the supported range");
		}
		counterPart = counter ?? 0;
		assertCounter(counterPart, maxCounter);
	}

	return {
		timestamp: timestampPart,
		counter: counterPart,
		region_id: regionId,
		version,
	};
}

export function makeCpCode(
	regionId = 0,
	timestamp?: number,
	counter?: number,
	version: number = CURRENT_VERSION,
): string {
	return encodeCpCode(generateCpCode(regionId, timestamp, counter, version));
}

export function parseCpCode(cpCodeData: string): CPCode {
	const version =
		typeof cpCodeData === "string" ? versionForIdLength(cpCodeData.length) : undefined;
	if (version === undefined) {
		const lengths = Object.keys(VERSION_BY_ID_LENGTH)
			.map(Number)
			.sort((a, b) => a - b)
			.join(" or ");
		throw new Error(`ID must be exactly ${lengths} characters`);
	}
	if (!cpCodeData.startsWith(ID_PREFIX)) {
		throw new Error(`ID must use prefix '${ID_PREFIX}'`);
	}

	const counterBits = counterBitsForVersion(version);
	let payload = 0n;
	for (const char of cpCodeData.slice(ID_PREFIX.length).toUpperCase()) {
		const digit = ALPHABET.indexOf(char);
		if (digit < 0) {
			throw new Error(`invalid Base32 character: '${char}'`);
		}
		payload = (payload << 5n) | BigInt(digit);
	}

	const counterMask = (1n << BigInt(counterBits)) - 1n;
	const tsVal = Number(
		(payload >> BigInt(counterBits + REGION_ID_BITS)) & TIMESTAMP_MASK,
	);
	const counter = Number((payload >> BigInt(REGION_ID_BITS)) & counterMask);
	const regionId = Number(payload & REGION_MASK);

	return {
		timestamp: tickToTimestamp(tsVal),
		counter,
		region_id: regionId,
		version,
	};
}
