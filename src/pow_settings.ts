import { countPastesCreatedSince } from "./paste";
import {
	MAX_POW_DIFFICULTY_BITS, POW_DEFAULTS, difficultyForRecentPastes,
	powConfigFromEnv, powKeyStub,
} from "./pow";

/** Shared by challenge issuance and staff UI; never cache mutable settings in isolates. */
export async function getPowDifficultyState(env: Env) {
	const [settings, recentPasteCount] = await Promise.all([
		powKeyStub(env).getDifficultySettings(),
		countPastesCreatedSince(env, Date.now() - POW_DEFAULTS.rateWindowSeconds * 1000),
	]);
	const configuredDefault = Math.min(MAX_POW_DIFFICULTY_BITS, powConfigFromEnv(env).difficultyBits);
	const minimum = settings.difficultyBits ?? configuredDefault;
	const rateExtraBits = difficultyForRecentPastes(0, recentPasteCount);
	return {
		minimum_difficulty_bits: minimum,
		configured_default_bits: configuredDefault,
		override_difficulty_bits: settings.difficultyBits,
		current_difficulty_bits: Math.min(MAX_POW_DIFFICULTY_BITS, minimum + rateExtraBits),
		recent_paste_count: recentPasteCount,
		rate_extra_bits: rateExtraBits,
		rate_window_seconds: POW_DEFAULTS.rateWindowSeconds,
		updated_at: settings.updatedAt,
		updated_by: settings.updatedBy,
	};
}

export type PowDifficultyState = Awaited<ReturnType<typeof getPowDifficultyState>>;
