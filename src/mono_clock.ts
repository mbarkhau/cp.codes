/**
 * Per-region monotonic clock (Durable Object).
 *
 * Generic: no knowledge of CP-Code layout. Caller passes the tick resolution
 * in seconds and the per-tick counter capacity; `next(...)` returns a unix
 * timestamp on that grid plus a counter that increments within the current
 * window. Counter overflow advances the tick.
 *
 * Shard by DO location region: one object named `clock:${hint}` (e.g.
 * `clock:weur`), created with matching locationHint so the watermark lives
 * with the region encoded in region_id.
 */

import { DurableObject } from "cloudflare:workers";

export type MonoClockParts = {
	/** Unix timestamp (seconds), resolution-aligned. */
	timestamp: number;
	/** Per-tick sequence, `0 .. maxCounter-1`. */
	counter: number;
};

export class MonoClock extends DurableObject<Env> {
	/** Last issued unix timestamp (seconds), resolution-aligned. */
	#lastTs = 0;
	/** Last issued counter for `#lastTs` (`-1` means none yet). */
	#lastCounter = -1;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			this.#lastTs = (await this.ctx.storage.get<number>("last")) ?? 0;
			const storedCounter = await this.ctx.storage.get<number>("counter");
			if (storedCounter === undefined && this.#lastTs > 0) {
				// Pre-counter watermark: each call issued counter 0 and advanced the
				// tick, so `#lastTs` is already consumed. Force the next tick.
				this.#lastCounter = Number.MAX_SAFE_INTEGER;
			} else {
				this.#lastCounter = storedCounter ?? -1;
			}
		});
	}

	/**
	 * Next monotonic (timestamp, counter) on a `resolution`-second grid.
	 * Within the current wall-clock tick, counter increments; once it reaches
	 * `maxCounter`, the tick advances. Uses integer tick math against the
	 * unix epoch to avoid float drift.
	 */
	async next(
		resolution: number,
		maxCounter: number,
		now = Date.now() / 1000,
	): Promise<MonoClockParts> {
		if (!(resolution > 0) || !Number.isFinite(resolution)) {
			throw new Error("resolution must be a positive finite number");
		}
		if (!Number.isInteger(maxCounter) || maxCounter < 1) {
			throw new Error("maxCounter must be a positive integer");
		}
		if (!Number.isFinite(now)) {
			throw new Error("now must be a finite number");
		}

		// floor wall-clock so we never issue a tick still in the future
		const nowTick = Math.floor(now / resolution);
		let tick: number;
		let counter: number;

		if (this.#lastTs <= 0) {
			tick = nowTick;
			counter = 0;
		} else {
			const lastTick = Math.round(this.#lastTs / resolution);
			if (nowTick > lastTick) {
				tick = nowTick;
				counter = 0;
			} else {
				tick = lastTick;
				counter = this.#lastCounter + 1;
				if (counter >= maxCounter) {
					counter = 0;
					tick = lastTick + 1;
				}
			}
		}

		this.#lastTs = tick * resolution;
		this.#lastCounter = counter;
		await this.ctx.storage.put({
			last: this.#lastTs,
			counter: this.#lastCounter,
		});
		return { timestamp: this.#lastTs, counter };
	}
}

/** Durable Object name for a location-hint shard (globally unique per hint). */
export function clockName(hint: string): string {
	return `clock:${hint}`;
}
