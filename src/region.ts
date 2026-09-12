/**
 * CP-Code region_id ↔ Durable Object location.
 *
 * region_id identifies which MonoClock DO owns the timestamp watermark —
 * i.e. the DO's location region, not the Worker request colo.
 *
 * CP-Code packs 8 logical regions into 3 bits. Hint names match Cloudflare
 * DurableObjectLocationHint values (sam/afr are valid hints; CF may place
 * the DO in a nearby jurisdiction if they do not host there yet).
 *
 * Stability: existing region IDs must never change; new regions append.
 * Fits in 3-bit CP-Code region_id (0..7).
 */

/** Logical regions encoded in CP-Code region_id (and used as DO clock shards). */
export type RegionHint =
	| "wnam"
	| "enam"
	| "weur"
	| "eeur"
	| "apac"
	| "oc"
	| "sam"
	| "afr";

/** Hints accepted by get(..., { locationHint }) but not packed as their own region_id. */
export type LocationHint =
	| RegionHint
	| "apac-ne"
	| "apac-se"
	| "me";

/** @deprecated alias — prefer RegionHint */
export type DoLocationHint = RegionHint;

/**
 * Append-only hint → region_id.
 * Eight logical regions pack into 3 bits (0..7).
 */
export const REGION_ID = {
	wnam: 0, // Western North America
	enam: 1, // Eastern North America
	weur: 2, // Western Europe
	eeur: 3, // Eastern Europe
	apac: 4, // Asia-Pacific
	oc: 5, // Oceania
	sam: 6, // South America
	afr: 7, // Africa
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
	// wnam
	DEN: "wnam",
	LAX: "wnam",
	SEA: "wnam",
	SJC: "wnam",
	// enam
	ATL: "enam",
	DFW: "enam",
	EWR: "enam",
	IAD: "enam",
	MIA: "enam",
	ORD: "enam",
	// weur
	AMS: "weur",
	CDG: "weur",
	FRA: "weur",
	LHR: "weur",
	LIS: "weur",
	MAD: "weur",
	MRS: "weur",
	MXP: "weur",
	// eeur
	ARN: "eeur",
	OTP: "eeur",
	PRG: "eeur",
	VIE: "eeur",
	WAW: "eeur",
	// apac (incl. former apac-ne / apac-se colos)
	HKG: "apac",
	ICN: "apac",
	KIX: "apac",
	NRT: "apac",
	SIN: "apac",
	// oc
	AKL: "oc",
	BNE: "oc",
	MEL: "oc",
	SYD: "oc",
	// sam
	GRU: "sam",
	SCL: "sam",
	// afr
	JNB: "afr",
	CPT: "afr",
});

/** Non-packed CF hints → nearest packed region. */
const HINT_FALLBACK: Record<"apac-ne" | "apac-se" | "me", RegionHint> = {
	"apac-ne": "apac",
	"apac-se": "apac",
	me: "weur",
};

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
	if (hint === "apac-ne" || hint === "apac-se" || hint === "me") {
		return HINT_FALLBACK[hint];
	}
	return null;
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
	const country = cf.country;
	const longitude = cf.longitude != null ? Number(cf.longitude) : NaN;

	switch (continent) {
		case "NA":
			// Rough split: west of ~100°W → wnam
			if (!Number.isNaN(longitude) && longitude < -100) return "wnam";
			return "enam";
		case "EU": {
			const eastern = new Set([
				"PL", "CZ", "SK", "HU", "RO", "BG", "MD", "UA", "BY", "RU",
				"FI", "EE", "LV", "LT", "SE", "NO", "AX",
			]);
			if (country && eastern.has(country)) return "eeur";
			// longitude fallback
			if (!Number.isNaN(longitude) && longitude > 15) return "eeur";
			return "weur";
		}
		case "AS":
			return "apac";
		case "OC":
			return "oc";
		case "SA":
			return "sam";
		case "AF":
			return "afr";
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
