/**
 * Per-region monotonic clock (Durable Object).
 *
 * Generic: no knowledge of CP-Code layout. Caller passes the tick resolution
 * in seconds; `next(resolution)` returns a unix timestamp on that grid,
 * strictly greater than the previous value for this object.
 *
 * Shard by DO location region: one object named `clock:${hint}` (e.g.
 * `clock:weur`), created with matching locationHint so the watermark lives
 * with the region encoded in region_id.
 */

import { DurableObject } from "cloudflare:workers";

export class MonoClock extends DurableObject<Env> {
	/** Last issued unix timestamp (seconds), resolution-aligned. */
	#last = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			this.#last = (await this.ctx.storage.get<number>("last")) ?? 0;
		});
	}

	/**
	 * Next exclusive timestamp on a `resolution`-second grid.
	 * Uses integer tick math against the unix epoch to avoid float drift.
	 */
	async next(resolution: number, now = Date.now() / 1000): Promise<number> {
		if (!(resolution > 0) || !Number.isFinite(resolution)) {
			throw new Error("resolution must be a positive finite number");
		}
		if (!Number.isFinite(now)) {
			throw new Error("now must be a finite number");
		}

		// floor wall-clock so we never issue a tick still in the future
		const nowTick = Math.floor(now / resolution);
		const lastTick = this.#last > 0 ? Math.round(this.#last / resolution) : -1;
		const tick = Math.max(nowTick, lastTick + 1);

		this.#last = tick * resolution;
		await this.ctx.storage.put("last", this.#last);
		return this.#last;
	}
}

/** Durable Object name for a location-hint shard (globally unique per hint). */
export function clockName(hint: string): string {
	return `clock:${hint}`;
}
