/** Initialize the shared page shell before first paint, independently of page modules. */
const STORAGE_KEY = 'cp.codes.theme';

function escapeHtml(value) {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function initHeader() {
	const header = document.querySelector('header');
	if (!header) return;
	const pathname = location.pathname.replace(/\/+$/, '') || '/';
	const headerPath = pathname.slice(1);
	const currentPath = pathname === '/new' ? '/' : pathname;
	const link = (href, label, className = '') =>
		`<a${className ? ` class="${className}"` : ''} href="${href}"${currentPath === href ? ' aria-current="page"' : ''}>${label}</a>`;
	const logo = headerPath
		? `<span class="logo"><a href="/">cp<span>.codes</span></a><a href="/${escapeHtml(headerPath)}"><span>/</span>${escapeHtml(headerPath)}</a></span>`
		: '<a class="logo" href="/">cp<span>.codes/</span></a>';
	// The readable cookie is only a display hint; staff routes authenticate on the server.
	const navigationCookie = location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
		? 'cp_staff_nav' : '__Host-cp_staff_nav';
	let staffNavigation = false;
	try {
		const matching = document.cookie.split(';').map(part => part.trim())
			.filter(part => part.startsWith(`${navigationCookie}=`));
		staffNavigation = matching.length === 1 && matching[0] === `${navigationCookie}=1`;
	} catch {}
	const staffLinks = staffNavigation
		? `${link('/admin/pastes', 'review', 'staff-nav-start')}
        ${link('/admin/pow', 'PoW')}
        ${link('/admin/users', 'users')}
        ${link('/admin/access-log', 'log')}
        <form class="nav-logout" method="post" action="/logout"><button type="submit">log out</button></form>`
		: '';
	header.innerHTML = `${logo}
      <nav class="site-nav" aria-label="Primary navigation">
        ${link('/', 'new')}
        ${link('/pastes', 'pastes')}
        ${link('/about', 'about')}
        ${staffLinks}
      </nav>`;
}

function initFooter() {
	const footer = document.querySelector('.footer');
	if (!footer) return;
	footer.innerHTML = `
      <li>AI-cleared pastes are limited to their uploader and three other IPs. Human approval is required for public distribution. Unlisted links are not secret storage.</li>
      <li>Operators may hide or delete content at any time for any reason.</li>
      <li>Access to your paste may be limited until a moderator approves wider distribution.</li>
      <li>IP and location metadata are logged for paste uploads and accesses; access logs also retain the HTTP Referer. They are used for abuse prevention and made available upon lawful request.</li>`;
}

function initTheme() {
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

	let theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
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
}

// The script runs after the shell has been parsed. Keep shared setup synchronous
// so the header, footer and theme are ready without waiting for page modules.
initHeader();
initFooter();
initTheme();

// Rebuild the header when client navigation changes the pathname. Theme setup
// recreates its button inside the header and retains the selected theme.
addEventListener('cp:navigation', () => { initHeader(); initTheme(); });

// Public archive/view navigation is an enhancement; other pages keep their
// ordinary links, and links still work if this module cannot be loaded.
if (location.pathname.replace(/\/+$/, '') === '/pastes' || /^\/CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10})\/?$/.test(location.pathname)) {
	void import('./navigation.js?v=13').catch(error => console.warn('Client navigation unavailable', error));
}

if (!location.pathname.startsWith('/admin') && !['/login', '/logout', '/client-info'].includes(location.pathname)) {
	// Install after the initial load, so precaching does not compete with page assets.
	const install = () => {
		void import('./offline.js?v=2').then(({ registerOfflineShell }) => registerOfflineShell())
			.catch(error => console.warn('Offline shell unavailable', error));
	};
	const idleInstall = () => 'requestIdleCallback' in window
		? requestIdleCallback(install, { timeout: 3000 }) : install();
	if (document.readyState === 'complete') idleInstall();
	else addEventListener('load', idleInstall, { once: true });
}
