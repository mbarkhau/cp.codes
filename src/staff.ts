import { sha256Hex, hexToBytes, bytesToHex } from './pow';
import type { StaffUser } from './admin';

export type StaffCredential = StaffUser & { passwordHash: string; salt?: string };
const DEVELOPMENT_USERS: StaffCredential[] = [
	{ username: 'admin', role: 'admin', passwordHash: '6a4e4054fa6e08046c40df5745530cdde6e4e091de831d04d7d902635b9350ac' },
	{ username: 'moderator', role: 'mod', passwordHash: 'f52fbd32b2b3b86ff88ef6c490628285f482af15ddcb29541f94bcf526a3f6c7' },
];

/** Development fixture credentials are opt-in, NEVER enabled in wrangler.jsonc. */
export function developmentStaffEnabled(env: Env): boolean {
	return String(env.STAFF_ALLOW_DEVELOPMENT_LOGIN) === 'true';
}

export function staffCredentials(env: Env): StaffCredential[] {
	if (!env.STAFF_CREDENTIALS) return developmentStaffEnabled(env) ? DEVELOPMENT_USERS : [];
	try {
		const value: unknown = JSON.parse(env.STAFF_CREDENTIALS);
		if (!Array.isArray(value) || value.length < 1 || value.length > 8) return [];
		const users: StaffCredential[] = [];
		for (const item of value) {
			if (!item || typeof item !== 'object' || typeof item.username !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.username) ||
				!['admin', 'mod'].includes(item.role) || !/^[0-9a-f]{64}$/.test(item.passwordHash) || !/^[0-9a-f]{32}$/.test(item.salt) || users.some(user => user.username === item.username)) return [];
			users.push({ username: item.username, role: item.role, passwordHash: item.passwordHash, salt: item.salt });
		}
		return users;
	} catch { return []; }
}

export function staffUsers(env: Env): StaffUser[] {
	return staffCredentials(env).map(({ username, role }) => ({ username, role }));
}

export async function verifyStaffCredentials(username: string, password: string, env: Env): Promise<StaffUser | null> {
	if (username.length > 100 || password.length > 256) return null;
	const nameHash = await sha256Hex(username);
	let matched: StaffCredential | undefined;
	for (const user of staffCredentials(env)) {
		if (crypto.subtle.timingSafeEqual(hexToBytes(nameHash), hexToBytes(await sha256Hex(user.username)))) matched = user;
	}
	let actual: string;
	// Use an equally expensive dummy derivation for unknown production users.
	if (matched?.salt || !developmentStaffEnabled(env)) {
		const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
		actual = bytesToHex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000,
			salt: hexToBytes(matched?.salt ?? '0'.repeat(32)) }, key, 256)));
	} else actual = await sha256Hex(password);
	const valid = crypto.subtle.timingSafeEqual(hexToBytes(actual), hexToBytes(matched?.passwordHash ?? '0'.repeat(64)));
	return valid && matched ? { username: matched.username, role: matched.role } : null;
}
