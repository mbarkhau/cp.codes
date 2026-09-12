/**
 * CP-Codes — Cloudflare Worker entrypoint.
 *
 * Local:   npm run dev   → http://localhost:8787
 * Deploy:  npm run deploy
 * Types:   npm run cf-typegen  (after changing wrangler.jsonc bindings)
 *
 * Endpoints:
 *   GET  /         health
 *   GET  /health   health
 *   GET  /debug    request-level debug dump
 *   GET  /new      mint a new CP-Code (region_id = DO location hint)
 *   GET  /:id      parse/validate a CP-Code (e.g. /CP0000000003)
 */

import * as cpCode from "./cp_code";
import * as region from "./region";
import * as clock from "./mono_clock";

export { MonoClock } from "./mono_clock";

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function error(message: string, status = 400): Response {
	return json({ error: message }, status);
}

function codeResponse(id: string, parts: cpCode.CPCode): Response {
	return json({
		id,
		version: parts.version,
		timestamp: parts.timestamp,
		region_id: parts.region_id,
		region: region.idToHint(parts.region_id),
		url: `https://cp.codes/${id}`,
	});
}

function monoClock(
	env: Env,
	resolved: region.ResolvedRegion,
): DurableObjectStub<clock.MonoClock> {
	// Same hint → same global DO id. locationHint only affects first placement.
	return env.MONO_CLOCK.getByName(clock.clockName(resolved.location_hint), {
		locationHint: resolved.location_hint,
	});
}

function headersToObject(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of headers) {
		// Headers can repeat; join duplicates rather than drop them.
		out[key] = key in out ? `${out[key]}, ${value}` : value;
	}
	return out;
}

function searchParamsToObject(params: URLSearchParams): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	for (const key of new Set(params.keys())) {
		const values = params.getAll(key);
		out[key] = values.length === 1 ? values[0]! : values;
	}
	return out;
}

function envBindingSummary(env: Env): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(env as object).sort()) {
		const value = (env as unknown as Record<string, unknown>)[key];
		const type = value === null ? "null" : typeof value;
		// Never dump binding contents (secrets, KV handles, etc.) — names/types only.
		out[key] = type === "object" && value !== null
			? (Object.getPrototypeOf(value)?.constructor?.name ?? "object")
			: type;
	}
	return out;
}

function debugPayload(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	url: URL,
	path: string,
): Record<string, unknown> {
	return {
		service: "cp.codes",
		generated_at: new Date().toISOString(),
		worker_now_ms: Date.now(),
		request: {
			method: request.method,
			url: request.url,
			redirect: request.redirect,
			integrity: request.integrity,
			keepalive: request.keepalive,
			cache: request.cache ?? null,
			bodyUsed: request.bodyUsed,
			hasBody: request.body !== null,
			signal: {
				aborted: request.signal.aborted,
				reason: request.signal.reason ?? null,
			},
			fetcher: request.fetcher === null ? null : typeof request.fetcher,
		},
		url: {
			href: url.href,
			origin: url.origin,
			protocol: url.protocol,
			username: url.username,
			password: url.password ? "[redacted]" : "",
			host: url.host,
			hostname: url.hostname,
			port: url.port,
			pathname: url.pathname,
			normalized_path: path,
			search: url.search,
			searchParams: searchParamsToObject(url.searchParams),
			hash: url.hash,
		},
		headers: headersToObject(request.headers),
		cf: request.cf ?? null,
		env_bindings: envBindingSummary(env),
		ctx: {
			props: ctx.props ?? null,
			has_cache: ctx.cache !== undefined,
			has_access: ctx.access !== undefined,
			exports_keys: Object.keys(ctx.exports ?? {}).sort(),
		},
	};
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/+$/, "") || "/";

		if (request.method !== "GET" && request.method !== "HEAD") {
			return error("Method Not Allowed", 405);
		}

		if (path === "/" || path === "/health") {
			return json({
				service: "cp.codes",
				status: "ok",
			});
		}

		if (path === "/debug") {
			return json(debugPayload(request, env, ctx, url, path));
		}

		// Mint: DO-region mono clock → timestamp; cp_code encodes (region_id, ts)
		if (path === "/new") {
			try {
				const resolved = region.regionFromRequest(request);
				const timestamp = await monoClock(env, resolved).next(cpCode.TIME_RESOLUTION);
				const parts = cpCode.generateCpCode(resolved.region_id, timestamp);
				const id = cpCode.encodeCpCode(parts);
				return codeResponse(id, parts);
			} catch (err) {
				const message = err instanceof Error ? err.message : "bad request";
				return error(message, 400);
			}
		}

		// Validate / decode an existing code: /CP..........
		const maybeId = path.slice(1);
		if (/^CP[0-9A-Za-z]{10}$/.test(maybeId)) {
			try {
				const parts = cpCode.parseCpCode(maybeId.toUpperCase());
				return codeResponse(maybeId.toUpperCase(), parts);
			} catch (err) {
				const message = err instanceof Error ? err.message : "invalid id";
				return error(message, 400);
			}
		}

		return error("Not Found", 404);
	},
} satisfies ExportedHandler<Env>;
