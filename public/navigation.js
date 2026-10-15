/** Public archive/view navigation using the existing JSON and gzip APIs. */
import { recentSection, pasteBody, pasteSkeleton } from './pages.js?v=9';
import { mountPasteView, disposePasteView, decodePasteResponse } from './view.js?v=42';
import { getPasteSnapshot, savePasteSnapshot, removePasteSnapshot, snapshotResponse, eligiblePaste,
	getArchiveSnapshot, saveArchiveSnapshot } from './offline.js?v=2';

const root = document.getElementById('page-content');
const snapshots = new Map();
let requestController = null;
let renderedUrl = new URL(location.href);
let ready = true;
let searchTimer = null;
let searchController = null;

function focusFirstPaste() {
	const target = root.querySelector('.recent-id') || root.querySelector('#paste-id-search');
	target?.focus({ preventScroll: true });
	return Boolean(target);
}

function cancelSearch() {
	clearTimeout(searchTimer);
	searchTimer = null;
	if (searchController) {
		searchController.abort();
		searchController = null;
		root.removeAttribute('aria-busy');
	}
}

function renderArchive(listing, preserveSearch = false) {
	const section = root.querySelector('#pastes');
	const results = section?.querySelector('[data-paste-results]');
	if (!preserveSearch || !results) {
		root.innerHTML = recentSection(listing.items, true, listing);
		return;
	}
	// Keep the input mounted: focus, selection and partially typed text survive updates.
	const focusedHref = results.contains(document.activeElement)
		? document.activeElement.closest('.recent-id')?.getAttribute('href') : null;
	const template = document.createElement('template');
	template.innerHTML = recentSection(listing.items, true, listing);
	results.innerHTML = template.content.querySelector('[data-paste-results]').innerHTML;
	section.dataset.listing = JSON.stringify(listing);
	const input = section.querySelector('#paste-id-search');
	input.defaultValue = input.value; // Include the applied draft in HTML history snapshots.
	const clear = section.querySelector('[data-paste-clear]');
	if (!listing.q) clear?.remove();
	else if (!clear) section.querySelector('.paste-search .row').append(template.content.querySelector('[data-paste-clear]'));
	if (focusedHref) {
		const focused = [...results.querySelectorAll('.recent-id')].find(link => link.getAttribute('href') === focusedHref);
		if (focused) focused.focus({ preventScroll: true });
		else focusFirstPaste();
	}
}

async function filterPastes(form) {
	const url = new URL(form.action);
	const input = form.elements.namedItem('q');
	const q = input.value.trim().toUpperCase();
	if (q) url.searchParams.set('q', input.value);
	const target = route(url);
	const status = form.querySelector('#paste-search-status');
	const controller = searchController = new AbortController();
	const { signal } = controller;
	let saved;
	root.setAttribute('aria-busy', 'true');
	status.textContent = '';
	const apply = listing => {
		renderArchive(listing, true);
		history.replaceState({ ...history.state, cpNavigation: { ...newState(), scroll: [scrollX, scrollY] } }, '', url.href);
		renderedUrl = url;
		status.textContent = `${listing.total} ${listing.total === 1 ? 'paste' : 'pastes'} found.`;
	};
	try {
		saved = await getArchiveSnapshot(target.page, target.q);
		signal.throwIfAborted();
		if (saved) {
			apply(saved.listing);
			if (!navigator.onLine) return;
		}
		const listing = await fetch(archiveApiUrl(target), { signal, cache: 'no-store' }).then(metadata);
		signal.throwIfAborted();
		apply(listing);
		void saveArchiveSnapshot(listing);
	} catch (error) {
		if (!signal.aborted && !saved) status.textContent = navigator.onLine ? error.message : 'Connect to search for pastes that are not saved offline.';
	} finally {
		if (searchController === controller) {
			searchController = null;
			root.removeAttribute('aria-busy');
		}
	}
}

function scheduleSearch(input, composing = false) {
	cancelSearch();
	// A background archive refresh must not overwrite a newer draft query.
	requestController?.abort();
	const q = input.value.trim().toUpperCase();
	const valid = !q || /^CP[0123456789ABCDEFGHIJKLPQRSTUVXYZ]{0,10}$/.test(q);
	input.setCustomValidity(valid || composing ? '' : 'Enter a paste ID or prefix starting with CP.');
	input.form.querySelector('#paste-search-status').textContent = '';
	if (composing || !valid) return;
	searchTimer = setTimeout(() => {
		searchTimer = null;
		if (input.isConnected) void filterPastes(input.form);
	}, 500);
}

function route(url) {
	if (url.origin !== location.origin) return null;
	if (url.pathname.replace(/\/+$/, '') === '/pastes') {
		if ([...url.searchParams.keys()].some(key => key !== 'page' && key !== 'q')) return null;
		return { page: url.searchParams.get('page') ?? '1', q: (url.searchParams.get('q') ?? '').trim().toUpperCase() };
	}
	const match = /^\/(CP(?:[0-9A-Za-z]{6,7}|[0-9A-Za-z]{10}))\/?$/.exec(url.pathname);
	return match && !url.search ? { id: match[1].toUpperCase() } : null;
}

function newState() {
	return { key: crypto.randomUUID(), scroll: [0, 0] };
}

function rememberPage() {
	const state = history.state?.cpNavigation ?? newState();
	history.replaceState({ ...history.state, cpNavigation: { ...state, scroll: [scrollX, scrollY] } }, '');
	if (ready && route(renderedUrl)?.page) {
		snapshots.set(state.key, { html: root.innerHTML, title: document.title, url: renderedUrl.href });
		if (snapshots.size > 20) snapshots.delete(snapshots.keys().next().value);
	}
}

function finish(url, scroll) {
	ready = true;
	root.removeAttribute('aria-busy');
	renderedUrl = new URL(url);
	if (!route(url)?.page || !focusFirstPaste()) root.focus({ preventScroll: true });
	if (scroll) scrollTo(...scroll);
	else if (url.hash && !url.hash.startsWith('#file-')) {
		try { document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView(); } catch {}
	} else scrollTo(0, 0);
}

function showFailure(error, url) {
	root.replaceChildren();
	const section = document.createElement('section'); section.className = 'card';
	const heading = document.createElement('h1');
	const offlineMiss = !navigator.onLine && !error.status;
	heading.textContent = error.status === 423 ? 'Human review is needed.' : error.status === 404 ? 'Paste not found.' : offlineMiss ? 'Not saved for offline use.' : 'Could not load page.';
	const message = document.createElement('p'); message.className = 'status err';
	message.setAttribute('role', 'alert');
	message.textContent = offlineMiss ? 'Connect to the site and visit this page to save a local copy.' : error.message;
	const retry = document.createElement('a'); retry.href = url.href; retry.textContent = 'Check again';
	section.append(heading, message, retry); root.append(section);
	document.title = `${heading.textContent} — cp.codes`;
}

async function metadata(response) {
	const data = await response.json();
	if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { status: response.status });
	return data;
}

async function renderPaste(paste, response, saveOffline = true) {
	root.innerHTML = pasteBody(paste, paste.hit_count, {
		typeLabel: paste.type_label, rawUrl: paste.raw_url, contentUrl: paste.content_url,
		staffReview: paste.staff_review, offlineCacheable: paste.offline_cacheable,
		reportCategories: paste.report_categories, maxReportEmailChars: paste.max_report_email_chars,
	});
	return mountPasteView({ contentResponse: response, saveOffline }).ready;
}

async function refreshPaste(snapshot, url, signal) {
	if (!navigator.onLine) return;
	try {
		const fresh = await fetch(`/api/paste/${snapshot.metadata.id}`, { signal, cache: 'no-store' }).then(metadata);
		signal.throwIfAborted();
		if (fresh.id !== snapshot.metadata.id) throw new Error('Paste metadata does not match the requested paste');
		if (!eligiblePaste(fresh) || fresh.sha256 !== snapshot.metadata.sha256 ||
			fresh.content_encoding !== snapshot.metadata.content_encoding || fresh.byte_length !== snapshot.metadata.byte_length) {
			await removePasteSnapshot(snapshot.metadata.id);
			if (!signal.aborted) void navigate(url, { pop: true });
			return;
		}
		const count = root.querySelector('#paste-hit-count');
		if (count) count.textContent = `${fresh.hit_count.toLocaleString('en-US')} ${fresh.hit_count === 1 ? 'hit' : 'hits'}`;
		await savePasteSnapshot(fresh, snapshotResponse(snapshot));
	} catch (error) {
		if (signal.aborted) return;
		if ([404, 423].includes(error.status)) {
			await removePasteSnapshot(snapshot.metadata.id);
			if (signal.aborted) return;
			disposePasteView(); showFailure(error, url);
		}
	}
}

function archiveApiUrl(target) {
	const params = new URLSearchParams({ page: target.page });
	if (target.q) params.set('q', target.q);
	return `/api/pastes?${params}`;
}

async function refreshArchive(target, signal) {
	if (!navigator.onLine) return;
	try {
		const listing = await fetch(archiveApiUrl(target), { signal, cache: 'no-store' }).then(metadata);
		signal.throwIfAborted();
		renderArchive(listing, true);
		await saveArchiveSnapshot(listing);
	} catch { /* The saved archive stays available during a network failure. */ }
}

async function navigate(url, { pop = false, scroll = null } = {}) {
	cancelSearch();
	const target = route(url);
	if (!target) { location.assign(url.href); return; }
	const referrer = renderedUrl.href;
	if (!pop) {
		rememberPage();
		history.pushState({ cpNavigation: newState() }, '', url.href);
	}
	requestController?.abort();
	const controller = requestController = new AbortController();
	const { signal } = controller;
	disposePasteView();
	ready = false;
	dispatchEvent(new Event('cp:navigation'));
	root.setAttribute('aria-busy', 'true');
	root.innerHTML = target.id ? pasteSkeleton() : '<p class="paste-loading" role="status">Loading…</p>';
	document.title = target.id ? `cp.codes/${target.id}` : 'Pastes — cp.codes';
	try {
		const snapshot = pop && snapshots.get(history.state?.cpNavigation?.key);
		if (snapshot?.url === url.href) {
			root.innerHTML = snapshot.html; document.title = snapshot.title;
		} else if (target.page) {
			const saved = await getArchiveSnapshot(target.page, target.q);
			signal.throwIfAborted();
			if (saved) {
				root.innerHTML = recentSection(saved.listing.items, true, saved.listing);
				finish(url, scroll); void refreshArchive(target, signal); return;
			}
			const listing = await fetch(archiveApiUrl(target), { signal, referrer }).then(metadata);
			signal.throwIfAborted();
			root.innerHTML = recentSection(listing.items, true, listing);
			void saveArchiveSnapshot(listing);
		} else {
			const saved = await getPasteSnapshot(target.id);
			signal.throwIfAborted();
			if (saved) {
				const content = await renderPaste(saved.metadata, snapshotResponse(saved), false);
				signal.throwIfAborted();
				if (content !== null) {
					finish(url, scroll); void refreshPaste(saved, url, signal); return;
				}
				await removePasteSnapshot(target.id); signal.throwIfAborted();
			}
			// Start both requests immediately. Body discovery never waits for metadata.
			const [paste, contentResponse] = await Promise.all([
				fetch(`/api/paste/${target.id}`, { signal, referrer }).then(metadata),
				fetch(`/api/paste/${target.id}/content`, { signal, referrer, headers: { accept: 'application/gzip' } }),
			]);
			signal.throwIfAborted();
			if (!contentResponse.ok) throw Object.assign(new Error(`Could not load paste content (${contentResponse.status})`), { status: contentResponse.status });
			if (paste.id !== target.id) throw new Error('Paste metadata does not match the requested paste');
			// Canonical approved URL pastes keep the server's redirect behavior.
			if (paste.format === 'single' && paste.content_type === 'url' && paste.moderation.state === 'approved') {
				if (paste.byte_length > 64 * 1024 || paste.compressed_byte_length > 256 * 1024) throw new Error('Redirect URL exceeds its size limit');
				const content = await decodePasteResponse(contentResponse, paste.byte_length, paste.sha256);
				signal.throwIfAborted();
				const destination = new URL(content.trim());
				if (!['http:', 'https:'].includes(destination.protocol)) throw new Error('Invalid redirect URL');
				const policy = document.createElement('meta'); policy.name = 'referrer'; policy.content = 'no-referrer'; document.head.append(policy);
				controller.abort(); location.replace(destination.href); return;
			}
			await renderPaste(paste, contentResponse);
			signal.throwIfAborted();
		}
		finish(url, scroll);
	} catch (error) {
		if (signal.aborted) return;
		controller.abort();
		showFailure(error, url); finish(url, scroll);
	}
}

if (root && route(renderedUrl)) {
	history.replaceState({ ...history.state, cpNavigation: newState() }, '');
	history.scrollRestoration = 'manual';
	let pendingScroll = false;
	addEventListener('scroll', () => {
		if (pendingScroll || !ready) return;
		pendingScroll = true;
		const key = history.state?.cpNavigation?.key;
		requestAnimationFrame(() => {
			pendingScroll = false;
			if (ready && history.state?.cpNavigation?.key === key) {
				const state = history.state.cpNavigation;
				history.replaceState({ ...history.state, cpNavigation: { ...state, scroll: [scrollX, scrollY] } }, '');
			}
		});
	}, { passive: true });
	document.addEventListener('click', event => {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const link = event.target.closest?.('a[href]');
		if (!(link instanceof HTMLAnchorElement) || link.hasAttribute('download') || link.hasAttribute('data-native-navigation') ||
			link.hasAttribute('referrerpolicy') || (link.target && link.target !== '_self') ||
			link.rel.split(/\s+/).some(value => value === 'external' || value === 'noreferrer')) return;
		const url = new URL(link.href);
		if (!route(url)) return;
		// Keep file/heading fragments and links to the current page native.
		if (ready && url.pathname === location.pathname && url.search === location.search && url.hash) return;
		event.preventDefault();
		void navigate(url);
	});
	document.addEventListener('submit', event => {
		const form = event.target;
		if (event.defaultPrevented || !(form instanceof HTMLFormElement) || !root.contains(form) || !form.hasAttribute('data-paste-search')) return;
		const input = form.elements.namedItem('q');
		if (document.activeElement === input && input.value.trim().toUpperCase() === route(renderedUrl)?.q) {
			event.preventDefault();
			cancelSearch();
			focusFirstPaste();
			return;
		}
		const url = new URL(form.action);
		url.search = new URLSearchParams(new FormData(form)).toString();
		event.preventDefault();
		void navigate(url);
	});
	document.addEventListener('keydown', event => {
		if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || !route(renderedUrl)?.page) return;
		const target = event.target;
		if (target instanceof Element && (target.closest('input, textarea, select') || target.isContentEditable)) return;
		if (event.key === '/') {
			const input = root.querySelector('#paste-id-search');
			if (input) { event.preventDefault(); input.focus(); }
			return;
		}
		if (event.key !== 'j' && event.key !== 'k') return;
		const links = [...root.querySelectorAll('.recent-id')];
		if (!links.length) return;
		event.preventDefault();
		const current = links.indexOf(document.activeElement);
		const next = current < 0 ? 0 : Math.max(0, Math.min(links.length - 1, current + (event.key === 'j' ? 1 : -1)));
		links[next].focus();
	});
	document.addEventListener('input', event => {
		const input = event.target;
		if (input instanceof HTMLInputElement && input.id === 'paste-id-search' && root.contains(input)) scheduleSearch(input, event.isComposing);
	});
	document.addEventListener('compositionstart', event => {
		const input = event.target;
		if (input instanceof HTMLInputElement && input.id === 'paste-id-search' && root.contains(input)) scheduleSearch(input, true);
	});
	document.addEventListener('compositionend', event => {
		const input = event.target;
		if (input instanceof HTMLInputElement && input.id === 'paste-id-search' && root.contains(input)) scheduleSearch(input);
	});
	addEventListener('popstate', event => {
		const url = new URL(location.href);
		if (ready && url.pathname === renderedUrl.pathname && url.search === renderedUrl.search) return;
		void navigate(url, { pop: true, scroll: event.state?.cpNavigation?.scroll });
	});
	addEventListener('pagehide', event => { cancelSearch(); if (!event.persisted) requestController?.abort(); });
	document.documentElement.dataset.navigationReady = 'true';
	if (root.hasAttribute('data-app-shell')) void navigate(renderedUrl, { pop: true });
	else {
		const listing = root.querySelector('[data-listing]')?.dataset.listing;
		if (listing) void saveArchiveSnapshot(JSON.parse(listing));
		if (route(renderedUrl)?.page && document.activeElement === document.body) focusFirstPaste();
	}
}
