/**
 * CP-Code region_id ↔ Durable Object location.
 *
 * region_id identifies which MonoClock DO owns the timestamp watermark —
 * i.e. the DO's location region, not the Worker request colo.
 *
 * CP-Code packs four logical regions into 2 bits. The logical regions use
 * Cloudflare Durable Object location-hint names and collapse nearby hints.
 *
 * Stability: existing region IDs must never change.
 */

/** Logical regions encoded in CP-Code region_id (and used as DO clock shards). */
export type RegionHint = "enam" | "weur" | "apac" | "sam";

/** Cloudflare hints that can be normalized to one of the packed regions. */
export type LocationHint =
	| RegionHint
	| "wnam"
	| "eeur"
	| "oc"
	| "afr"
	| "apac-ne"
	| "apac-se"
	| "me";

/** @deprecated alias — prefer RegionHint */
export type DoLocationHint = RegionHint;

/**
 * Append-only hint → region_id.
 * Four logical regions pack into 2 bits (0..3).
 */
export const REGION_ID = {
	enam: 0, // North America
	weur: 1, // Europe, Middle East, and Africa
	apac: 2, // Asia-Pacific and Oceania
	sam: 3, // South America
} as const satisfies Record<RegionHint, number>;

/**
 * Fallback when colo/geo cannot be resolved.
 * Always a real hosting region so MonoClock gets a stable name + locationHint
 * (never an unhinted `clock:0` shard).
 */
export const DEFAULT_LOCATION_HINT: RegionHint = "weur";

export const ID_TO_HINT: ReadonlyMap<number, RegionHint> = new Map(
	(Object.entries(REGION_ID) as [RegionHint, number][]).map(([hint, id]) => [id, hint]),
);

export const REGION_COUNT = Object.keys(REGION_ID).length;
/** Sentinel for unresolved hints — not a valid packed region_id. */
export const UNKNOWN_REGION_ID = -1;

/** Known colos → packed region hint (best-effort). */
export const COLO_TO_HINT: Readonly<Record<string, RegionHint>> = Object.freeze({
	// North America
	DEN: "enam",
	LAX: "enam",
	SEA: "enam",
	SJC: "enam",
	ATL: "enam",
	DFW: "enam",
	EWR: "enam",
	IAD: "enam",
	MIA: "enam",
	ORD: "enam",
	// Europe
	AMS: "weur",
	CDG: "weur",
	FRA: "weur",
	LHR: "weur",
	LIS: "weur",
	MAD: "weur",
	MRS: "weur",
	MXP: "weur",
	ARN: "weur",
	OTP: "weur",
	PRG: "weur",
	VIE: "weur",
	WAW: "weur",
	// Asia-Pacific and Oceania
	HKG: "apac",
	ICN: "apac",
	KIX: "apac",
	NRT: "apac",
	SIN: "apac",
	AKL: "apac",
	BNE: "apac",
	MEL: "apac",
	SYD: "apac",
	// South America
	GRU: "sam",
	SCL: "sam",
	// Africa maps to the EMEA clock.
	JNB: "weur",
	CPT: "weur",
});

/** Non-packed Cloudflare hints → nearest packed region. */
const HINT_FALLBACK: Readonly<Record<string, RegionHint>> = Object.freeze({
	wnam: "enam",
	eeur: "weur",
	oc: "apac",
	afr: "weur",
	"apac-ne": "apac",
	"apac-se": "apac",
	me: "weur",
});

export function isRegionHint(value: string): value is RegionHint {
	return Object.prototype.hasOwnProperty.call(REGION_ID, value);
}

export function idToHint(regionId: number): RegionHint | null {
	if (!Number.isInteger(regionId) || regionId < 0) return null;
	return ID_TO_HINT.get(regionId) ?? null;
}

export function hintToId(hint: string | null | undefined): number {
	if (!hint || !isRegionHint(hint)) return UNKNOWN_REGION_ID;
	return REGION_ID[hint];
}

/** Normalize any CF location hint to a packed RegionHint. */
export function hostingHint(hint: LocationHint | string | null | undefined): RegionHint | null {
	if (!hint) return null;
	if (isRegionHint(hint)) return hint;
	return HINT_FALLBACK[hint] ?? null;
}

/** Map a cf.colo code to a packed region hint, if known. */
export function hintFromColo(colo: string | null | undefined): RegionHint | null {
	if (!colo) return null;
	const code = colo.trim().toUpperCase();
	return COLO_TO_HINT[code] ?? null;
}

/**
 * Best-effort hint from request.cf geography when colo isn't a known DO host.
 * Uses continent / country — coarse but better than unknown.
 */
export function hintFromCfGeo(cf: IncomingRequestCfProperties | undefined): RegionHint | null {
	if (!cf) return null;

	const continent = cf.continent;

	switch (continent) {
		case "NA":
			return "enam";
		case "EU":
		case "AF":
			return "weur";
		case "AS":
		case "OC":
			return "apac";
		case "SA":
			return "sam";
		default:
			return null;
	}
}

export type ResolvedRegion = {
	region_id: number;
	/** DO location hint used for placement + clock shard (always set). */
	location_hint: RegionHint;
	/** True when we fell back to DEFAULT_LOCATION_HINT. */
	used_default: boolean;
	/** Request Worker colo, if present. */
	colo: string | null;
};

/** Resolve which MonoClock region should mint for this request. */
export function regionFromRequest(request: Request): ResolvedRegion {
	const coloRaw = request.cf?.colo;
	const colo = typeof coloRaw === "string" ? coloRaw.toUpperCase() : null;

	const detected =
		hintFromColo(colo) ??
		hintFromCfGeo(request.cf as IncomingRequestCfProperties | undefined) ??
		null;

	const location_hint = detected ?? DEFAULT_LOCATION_HINT;

	return {
		region_id: REGION_ID[location_hint],
		location_hint,
		used_default: detected === null,
		colo,
	};
}
