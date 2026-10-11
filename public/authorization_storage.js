// Reading/deleting saved credentials does not need the passphrase wordlist.
export const AUTHORIZATION_STORAGE_PREFIX = 'cp.codes.authorization.v1:';

export function storedPasscode(id) {
	try {
		const value = JSON.parse(localStorage.getItem(`${AUTHORIZATION_STORAGE_PREFIX}${id.toUpperCase()}`) || 'null')?.passcode;
		return typeof value === 'string' && /^[0-9a-f]{16}$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
	} catch { return null; }
}

export function forgetAuthorization(id) {
	try { localStorage.removeItem(`${AUTHORIZATION_STORAGE_PREFIX}${id.toUpperCase()}`); } catch { /* Storage is optional. */ }
}

export function initializePassphraseDisplay(element, value) {
	const label = element.getAttribute('aria-label') || 'Passphrase';
	element.textContent = Array.from({ length: 2 }, () => Array(4).fill('********').join('  ')).join('\n');
	element.setAttribute('role', 'button');
	element.setAttribute('tabindex', '0');
	element.setAttribute('aria-label', 'Reveal passphrase');
	element.title = 'Click to reveal passphrase';
	let pending = false;
	const reveal = async () => {
		if (pending) return;
		pending = true;
		try {
			const { formatPassphraseGrid } = await import('./authorization.js?v=2');
			element.textContent = formatPassphraseGrid(value);
			element.setAttribute('aria-label', label);
			element.removeAttribute('role');
			element.removeAttribute('tabindex');
			element.title = 'Passphrase';
			element.removeEventListener('click', reveal);
			element.removeEventListener('keydown', onKeydown);
		} catch {
			element.title = 'Could not load passphrase. Click to retry.';
		} finally { pending = false; }
	};
	const onKeydown = event => {
		if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void reveal(); }
	};
	element.addEventListener('click', reveal);
	element.addEventListener('keydown', onKeydown);
}
