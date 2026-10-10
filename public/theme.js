/** Create the toggle and restore the saved theme before first paint. */
const STORAGE_KEY = 'cp.codes.theme';

document.querySelector('.site-nav')?.insertAdjacentHTML('afterend', `
  <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Switch color theme" aria-pressed="false">
    <svg class="theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/>
    </svg>
    <svg class="theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20.2 15.2A8.5 8.5 0 0 1 8.8 3.8a8.5 8.5 0 1 0 11.4 11.4Z"/>
    </svg>
  </button>`);

function applyTheme(theme) {
	document.documentElement.dataset.theme = theme;
	const toggle = document.getElementById('theme-toggle');
	if (!(toggle instanceof HTMLButtonElement)) return;
	const dark = theme === 'dark';
	toggle.setAttribute('aria-pressed', String(dark));
	toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
	toggle.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
}

let theme = 'light';
try {
	const saved = localStorage.getItem(STORAGE_KEY);
	if (saved === 'light' || saved === 'dark') theme = saved;
} catch {
	// Viewing and toggling still work when browser storage is unavailable.
}
applyTheme(theme);

document.getElementById('theme-toggle')?.addEventListener('click', () => {
	const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
	applyTheme(next);
	try { localStorage.setItem(STORAGE_KEY, next); } catch {}
});
