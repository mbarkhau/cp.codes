import { DurableObject } from "cloudflare:workers";
import { randomHex, sha256Hex } from "./pow";

export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_ATTEMPTS = 10;

type SessionRecord = { username: string; expiresAt: number };
type LoginAttempts = { attempts: number; resetsAt: number };

/** One SQLite-backed object per hashed session token (or hashed login-rate-limit IP). */
export class StaffSession extends DurableObject<Env> {
	async create(username: string, expiresAt: number): Promise<void> {
		const now = Date.now();
		if (!username || username.length > 100 || !Number.isSafeInteger(expiresAt) ||
			expiresAt <= now || expiresAt > now + SESSION_TTL_SECONDS * 1000) throw new Error("invalid session");
		if (this.ctx.storage.kv.get("session")) throw new Error("session already exists");
		this.ctx.storage.kv.put<SessionRecord>("session", { username, expiresAt });
		await this.ctx.storage.setAlarm(expiresAt);
	}

	getUsername(): string | null {
		const row = this.ctx.storage.kv.get<SessionRecord>("session");
		return row && row.expiresAt > Date.now() ? row.username : null;
	}

	async revoke(): Promise<void> {
		// Clear identity synchronously before any await, so concurrent reads cannot use it.
		this.ctx.storage.kv.delete("session");
		await this.ctx.storage.deleteAll(); // Also deletes the alarm with our compatibility date.
	}

	/** Fixed-window throttling; count all login submissions, not just failures. */
	async allowLoginAttempt(): Promise<boolean> {
		const now = Date.now();
		const row = this.ctx.storage.kv.get<LoginAttempts>("attempts");
		const attempts = row && row.resetsAt > now ? row.attempts + 1 : 1;
		const resetsAt = row && row.resetsAt > now ? row.resetsAt : now + LOGIN_WINDOW_MS;
		if (attempts > LOGIN_ATTEMPTS) return false;
		this.ctx.storage.kv.put<LoginAttempts>("attempts", { attempts, resetsAt });
		await this.ctx.storage.setAlarm(resetsAt);
		return true;
	}

	async alarm(): Promise<void> {
		// Alarms may be delayed or retried. Never erase a newer active rate window.
		const next = Math.max(
			this.ctx.storage.kv.get<SessionRecord>("session")?.expiresAt ?? 0,
			this.ctx.storage.kv.get<LoginAttempts>("attempts")?.resetsAt ?? 0,
		);
		if (next > Date.now()) await this.ctx.storage.setAlarm(next);
		else await this.ctx.storage.deleteAll();
	}
}

function isLocalHttp(request: Request): boolean {
	const url = new URL(request.url);
	return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function sessionTransportAllowed(request: Request): boolean {
	return new URL(request.url).protocol === "https:" || isLocalHttp(request);
}

function cookieName(request: Request): string {
	return isLocalHttp(request) ? "cp_session" : "__Host-cp_session";
}

export function sessionToken(request: Request): string | null {
	const matching = (request.headers.get("cookie") ?? "").split(";")
		.map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName(request)}=`));
	if (matching.length !== 1) return null;
	const token = matching[0]!.slice(cookieName(request).length + 1);
	return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

export function sessionCookie(request: Request, token: string, maxAge = SESSION_TTL_SECONDS): string {
	return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isLocalHttp(request) ? "" : "; Secure"}`;
}

/** Readable UI hint only. This cookie never grants access or contains credentials. */
export function staffNavigationCookie(request: Request, enabled: boolean): string {
	const name = isLocalHttp(request) ? 'cp_staff_nav' : '__Host-cp_staff_nav';
	return `${name}=${enabled ? '1' : ''}; Path=/; SameSite=Lax; Max-Age=${enabled ? SESSION_TTL_SECONDS : 0}${isLocalHttp(request) ? '' : '; Secure'}`;
}

async function sessionStub(env: Env, token: string): Promise<DurableObjectStub<StaffSession>> {
	// Neither durable object names nor stored session records contain the bearer token.
	return env.STAFF_SESSIONS.getByName(`session:${await sha256Hex(token)}`);
}

export async function createSession(env: Env, username: string): Promise<string> {
	const token = randomHex(32);
	await (await sessionStub(env, token)).create(username, Date.now() + SESSION_TTL_SECONDS * 1000);
	return token;
}

export async function sessionUsername(request: Request, env: Env): Promise<string | null> {
	const token = sessionToken(request);
	if (!token || !sessionTransportAllowed(request)) return null;
	return (await sessionStub(env, token)).getUsername();
}

export async function revokeSession(request: Request, env: Env): Promise<void> {
	const token = sessionToken(request);
	if (token) await (await sessionStub(env, token)).revoke();
}

export async function allowLoginAttempt(request: Request, env: Env): Promise<boolean> {
	// Cloudflare supplies this header in production; local tests/development share a bucket.
	const ip = request.headers.get("cf-connecting-ip") ?? "local";
	return env.STAFF_SESSIONS.getByName(`login:${await sha256Hex(ip)}`).allowLoginAttempt();
}
