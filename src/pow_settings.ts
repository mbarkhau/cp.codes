import { countPastesCreatedSince } from "./paste";
import {
	MAX_POW_DIFFICULTY_BITS, POW_DEFAULTS,
	powConfigFromEnv, powKeyStub,
} from "./pow";

/** Shared by challenge issuance and staff UI; never cache mutable settings in isolates. */
export async function getPowDifficultyState(env: Env) {
	const [settings, recentPasteCount, recentCostUnits] = await Promise.all([
		powKeyStub(env).getDifficultySettings(),
		countPastesCreatedSince(env, Date.now() - POW_DEFAULTS.rateWindowSeconds * 1000),
		powKeyStub(env).getAdmissionUnits(),
	]);
	const configuredDefault = Math.min(MAX_POW_DIFFICULTY_BITS, powConfigFromEnv(env).difficultyBits);
	const minimum = settings.difficultyBits ?? configuredDefault;
	const rateExtraBits = Math.floor(Math.log2(1 + recentCostUnits / POW_DEFAULTS.rateThreshold));
	return {
		minimum_difficulty_bits: minimum,
		configured_default_bits: configuredDefault,
		override_difficulty_bits: settings.difficultyBits,
		short_id_increment: settings.shortIdIncrement,
		current_difficulty_bits: Math.min(MAX_POW_DIFFICULTY_BITS, minimum + rateExtraBits),
		recent_paste_count: recentPasteCount,
		recent_cost_units: recentCostUnits,
		rate_extra_bits: rateExtraBits,
		rate_window_seconds: POW_DEFAULTS.rateWindowSeconds,
		updated_at: settings.updatedAt,
		updated_by: settings.updatedBy,
	};
}

export type PowDifficultyState = Awaited<ReturnType<typeof getPowDifficultyState>>;
