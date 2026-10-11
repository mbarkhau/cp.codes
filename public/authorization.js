import { WORDLIST } from './wordlist.js?v=1';
import { AUTHORIZATION_STORAGE_PREFIX } from './authorization_storage.js?v=1';
export { AUTHORIZATION_STORAGE_PREFIX, storedPasscode, forgetAuthorization, initializePassphraseDisplay } from './authorization_storage.js?v=1';

export const PASSPHRASE_WORD_COUNT = 8;
const wordIndices = new Map(WORDLIST.map((word, index) => [word, index]));

/** Accept either the hexadecimal passcode or its equivalent wordlist phrase. */
export function normalizePasscode(value) {
	if (typeof value !== 'string') return null;
	const text = value.trim().toLowerCase();
	if (new RegExp(`^[0-9a-f]{${PASSPHRASE_WORD_COUNT * 2}}$`).test(text)) return text;
	const words = text.split(/[\s-]+/);
	if (words.length !== PASSPHRASE_WORD_COUNT || words.some(word => !wordIndices.has(word))) return null;
	return words.map(word => wordIndices.get(word).toString(16).padStart(2, '0')).join('');
}

export function passphraseFromPasscode(value) {
	const passcode = normalizePasscode(value);
	if (!passcode) throw new Error('Invalid passcode or passphrase');
	return passcode.match(/../g).map(byte => WORDLIST[parseInt(byte, 16)]).join(' ');
}

/** Two rows of four words, with columns aligned for a compact preformatted display. */
export function formatPassphraseGrid(value) {
	const words = passphraseFromPasscode(value).split(' ');
	const width = Math.max(...words.map(word => word.length)) + 2;
	return [words.slice(0, 4), words.slice(4)].map(row => row.map(word => word.padEnd(width)).join('').trimEnd()).join('\n');
}

export function storeAuthorization(id, value) {
	const passcode = normalizePasscode(value);
	if (!passcode) return false;
	try {
		localStorage.setItem(`${AUTHORIZATION_STORAGE_PREFIX}${id.toUpperCase()}`,
			JSON.stringify({ passcode, passphrase: passphraseFromPasscode(passcode) }));
		return true;
	} catch { return false; }
}
