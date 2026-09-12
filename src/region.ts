/**
 * CP-Code region_id ↔ Durable Object location.
 *
 * region_id identifies which MonoClock DO owns the timestamp watermark —
 * i.e. the DO's location region, not the Worker request colo.
 *
 * Cloudflare DO location hints that actually host objects today:
 *   wnam, enam, weur, eeur, apac, apac-ne, apac-se, oc
 * (sam / afr / me are valid hint names but currently fall back elsewhere.)
 *
 * Stability: existing region IDs must never change; new regions append.
 * Fits in 6-bit CP-Code region_id (0..63).
 */

/** DO location hints that spawn Durable Objects (per CF docs). */
export type DoLocationHint =
	| "wnam"
	| "enam"
	| "weur"
	| "eeur"
	| "apac"
	| "apac-ne"
	| "apac-se"
	| "oc";

/** All hint strings accepted by get(..., { locationHint }). */
export type LocationHint =
	| DoLocationHint
	| "sam"
	| "afr"
	| "me";

/**
 * Append-only hint → region_id.
 * 0 is reserved for legacy/unmapped decode only — new mints always use 1..8.
 */
export const REGION_ID = {
	wnam: 1, // Western North America
	enam: 2, // Eastern North America
	weur: 3, // Western Europe
	eeur: 4, // Eastern Europe
	apac: 5, // Asia-Pacific (general)
	"apac-ne": 6, // Northeast Asia-Pacific
	"apac-se": 7, // Southeast Asia-Pacific
	oc: 8, // Oceania
} as const satisfies Record<DoLocationHint, number>;

/**
 * Fallback when colo/geo cannot be resolved.
 * Always a real hosting region so MonoClock gets a stable name + locationHint
 * (never an unhinted `clock:0` shard).
 */
export const DEFAULT_LOCATION_HINT: DoLocationHint = "weur";

export type RegionHint = keyof typeof REGION_ID;

export const ID_TO_HINT: ReadonlyMap<number, RegionHint> = new Map(
	(Object.entries(REGION_ID) as [RegionHint, number][]).map(([hint, id]) => [id, hint]),
);

export const REGION_COUNT = Object.keys(REGION_ID).length;
export const UNKNOWN_REGION_ID = 0;

/** Known DO-host colos → location hint (best-effort). */
export const COLO_TO_HINT: Readonly<Record<string, DoLocationHint>> = Object.freeze({
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
	// apac
	HKG: "apac",
	// apac-ne
	ICN: "apac-ne",
	KIX: "apac-ne",
	NRT: "apac-ne",
	// apac-se
	SIN: "apac-se",
	// oc
	AKL: "oc",
	BNE: "oc",
	MEL: "oc",
	SYD: "oc",
});

/**
 * Hints that do not host DOs → nearest hosting hint (CF docs).
 * sam → enam; afr/me → weur (reasonable nearby fallbacks).
 */
const NON_HOST_FALLBACK: Record<"sam" | "afr" | "me", DoLocationHint> = {
	sam: "enam",
	afr: "weur",
	me: "weur",
};

export function isRegionHint(value: string): value is RegionHint {
	return Object.prototype.hasOwnProperty.call(REGION_ID, value);
}

export function idToHint(regionId: number): RegionHint | null {
	if (!Number.isInteger(regionId) || regionId === UNKNOWN_REGION_ID) return null;
	return ID_TO_HINT.get(regionId) ?? null;
}

export function hintToId(hint: string | null | undefined): number {
	if (!hint || !isRegionHint(hint)) return UNKNOWN_REGION_ID;
	return REGION_ID[hint];
}

/** Normalize any location hint to one that actually hosts DOs. */
export function hostingHint(hint: LocationHint | string | null | undefined): DoLocationHint | null {
	if (!hint) return null;
	if (isRegionHint(hint)) return hint;
	if (hint === "sam" || hint === "afr" || hint === "me") {
		return NON_HOST_FALLBACK[hint];
	}
	return null;
}

/** Map a cf.colo code to a DO hosting hint, if known. */
export function hintFromColo(colo: string | null | undefined): DoLocationHint | null {
	if (!colo) return null;
	const code = colo.trim().toUpperCase();
	return COLO_TO_HINT[code] ?? null;
}

/**
 * Best-effort hint from request.cf geography when colo isn't a known DO host.
 * Uses continent / country — coarse but better than unknown.
 */
export function hintFromCfGeo(cf: IncomingRequestCfProperties | undefined): DoLocationHint | null {
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
		case "AS": {
			const ne = new Set(["JP", "KR", "TW", "CN", "HK", "MO", "MN", "KP"]);
			const se = new Set([
				"SG", "MY", "ID", "TH", "VN", "PH", "KH", "LA", "MM", "BN",
				"IN", "BD", "PK", "LK", "NP", "BT",
			]);
			if (country && ne.has(country)) return "apac-ne";
			if (country && se.has(country)) return "apac-se";
			return "apac";
		}
		case "OC":
			return "oc";
		case "SA":
			return hostingHint("sam");
		case "AF":
			return hostingHint("afr");
		default:
			return null;
	}
}

export type ResolvedRegion = {
	region_id: number;
	/** DO location hint used for placement + clock shard (always set). */
	location_hint: DoLocationHint;
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
