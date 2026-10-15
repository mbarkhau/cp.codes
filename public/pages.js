/** Shared server/client markup. Paste content is rendered separately by the viewer. */

function escapeHtml(s) {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function formatWhen(iso) {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return escapeHtml(iso);
	return escapeHtml(new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z"));
}

function formatHitCount(hitCount) {
	const count = Number.isSafeInteger(hitCount) && hitCount >= 0 ? hitCount : 0;
	return `${count.toLocaleString("en-US")} ${count === 1 ? "hit" : "hits"}`;
}

export function recentSection(recent, standalone = false, listing) {
	const items =
		recent.length === 0
			? `<p class="recent-empty">${listing?.q ? 'No public pastes match this ID or prefix.' : 'No public pastes yet.'}</p>`
			: `<div class="recent-table-scroll"><table class="recent-list">
  <thead><tr><th scope="col">id</th><th scope="col">filename</th><th scope="col" class="recent-hits">hits</th><th scope="col" class="recent-bytes">bytes</th><th scope="col">timestamp</th></tr></thead>
  <tbody>
${recent
	.map(
		(p) => `  <tr>
	<td><a class="recent-id" href="/${escapeHtml(p.id)}"${!p.format && p.content_type === "url" ? ' data-native-navigation' : ''}>${escapeHtml(p.id)}</a></td>
	<td class="recent-filename" title="${escapeHtml(p.primary ?? p.filename ?? '')}">${escapeHtml(p.primary ?? p.filename ?? '—')}</td>
	<td class="recent-hits">${Number.isSafeInteger(p.hit_count) && p.hit_count >= 0 ? p.hit_count.toLocaleString("en-US") : '0'}</td>
	<td class="recent-bytes">${p.byte_length.toLocaleString("en-US")}</td>
	<td class="recent-meta">${formatWhen(p.created_at)}</td>
  </tr>`,
	)
	.join("\n")}
  </tbody>
</table></div>`;

	return `
<section class="recent card${standalone ? " recent-page" : ""}" id="pastes"${listing ? ` data-listing="${escapeHtml(JSON.stringify(listing))}"` : ''}>
  <h2>${standalone ? 'Public pastes' : 'Recent uploads'}</h2>
  ${standalone ? `<form class="paste-search" method="get" action="/pastes" data-paste-search role="search">
    <label for="paste-id-search">Search paste IDs</label>
    <div class="row"><input type="text" id="paste-id-search" name="q" value="${escapeHtml(listing?.q ?? '')}" maxlength="12" placeholder="CP…" spellcheck="false" autocomplete="off" autocapitalize="characters" /><button type="submit">Search</button>${listing?.q ? ' <a data-paste-clear href="/pastes">Clear</a>' : ''}</div>
    <p class="meta" id="paste-search-status" role="status" aria-live="polite"></p>
  </form>` : ''}
  <div data-paste-results>
  ${listing ? publicPasteNavigation(listing) : ''}
  ${items}
  ${listing ? publicPasteNavigation(listing) : ''}
  </div>
</section>`;
}

function publicPasteNavigation(listing) {
	if (!listing.total || listing.total_pages <= 1) return '';
	const query = listing.q ? `&amp;q=${encodeURIComponent(listing.q)}` : '';
	const previous = listing.page > 1
		? `<a href="/pastes?page=${listing.page - 1}${query}" rel="prev">← Previous</a>`
		: '<span aria-disabled="true">← Previous</span>';
	const next = listing.page < listing.total_pages
		? `<a href="/pastes?page=${listing.page + 1}${query}" rel="next">Next →</a>`
		: '<span aria-disabled="true">Next →</span>';
	const first = (listing.page - 1) * listing.page_size + 1;
	const last = first + listing.items.length - 1;
	return `<nav class="paste-pagination" aria-label="Paste pages">${previous}<span class="meta">Page ${listing.page} of ${listing.total_pages} · ${first}–${last} of ${listing.total} pastes</span>${next}</nav>`;
}


export function pasteContentSkeleton() {
	return `<div class="paste-skeleton-content" role="status">
  <span class="sr-only">Loading paste…</span>
  <div aria-hidden="true">
    <span class="skeleton-block"></span>
    <span class="skeleton-block"></span>
    <span class="skeleton-block"></span>
  </div>
</div>`;
}

export function pasteSkeleton() {
	return `<div class="paste-main paste-skeleton">
  <section class="paste-head" aria-hidden="true">
    <div class="meta paste-skeleton-meta">
      <span class="skeleton-block"></span><span class="skeleton-block"></span>
      <span class="skeleton-block"></span><span class="skeleton-block"></span>
    </div>
    <div class="paste-toolbar">
      <span class="paste-action-status"></span>
      <div class="paste-actions">${'<span class="icon-action skeleton-block"></span>'.repeat(5)}</div>
    </div>
  </section>
  <section class="card paste-card">
    <nav class="paste-file-nav" aria-hidden="true"><span class="paste-file-tab-skeleton"><span><span class="skeleton-block">&nbsp;</span></span></span></nav>
    ${pasteContentSkeleton()}
  </section>
</div>`;
}

export function pasteBody(paste, hitCount, { typeLabel, rawUrl, contentUrl, staffReview = false, reportCategories, maxReportEmailChars, offlineCacheable = false }) {
	const id = escapeHtml(paste.id);
	const dialogMetadata = escapeHtml(JSON.stringify({
		created_at: paste.created_at,
		compressed_byte_length: paste.compressed_byte_length,
		content_encoding: paste.content_encoding,
		filename: paste.filename,
		unlisted: paste.unlisted,
		files: paste.files,
		proof_of_work: paste.proof_of_work,
		report_categories: reportCategories,
		max_report_email_chars: maxReportEmailChars,
	}));
	const files = paste.format === 'bundle-v1' && paste.files?.length
		? paste.files : [{ name: paste.filename || 'Unnamed file' }];
	const selectedFile = Math.max(0, files.findIndex(file => file.name === paste.primary));
	const visibility = paste.unlisted ? " · unlisted" : "";
	return `
<div class="paste-main">
  <section class="paste-head">
    ${staffReview ? `<p class="status">Staff review — content remains subject to its current visibility. <a href="/admin/pastes">← moderation</a></p><div class="row"><form method="post" action="/admin/paste/${id}"><input type="hidden" name="action" value="approve"/><button type="submit">Approve public access</button></form><form method="post" action="/admin/paste/${id}"><input type="hidden" name="action" value="classify"/><select name="reason" aria-label="Restriction reason" required><option value="">Restriction reason…</option>${reportCategories.map(reason => `<option>${escapeHtml(reason)}</option>`).join('')}</select> <button class="danger" type="submit">Restrict &amp; hide</button></form></div>` : ""}
    <div class="meta">${formatWhen(paste.created_at)} · ${paste.byte_length} bytes · <span id="paste-hit-count">${formatHitCount(hitCount)}</span> · <span class="type-badge">${escapeHtml(typeLabel)}</span>${visibility}</div>
    <div class="paste-toolbar"></div>
  </section>
  <section class="card paste-card">
    <nav class="paste-file-nav" id="paste-file-nav" role="tablist" aria-label="Paste files">${files.map((file, index) =>
		`<button type="button" id="paste-file-tab-${index}" role="tab" aria-controls="paste-content" aria-selected="${index === selectedFile}" tabindex="${index === selectedFile ? 0 : -1}" title="${escapeHtml(file.name || 'Unnamed file')}"${paste.format === 'bundle-v1' ? ' disabled' : ''}><span>${escapeHtml(file.name || 'Unnamed file')}</span></button>`).join('')}</nav>
    <div id="paste-content" role="tabpanel" aria-labelledby="paste-file-tab-${selectedFile}" tabindex="0" data-cp-code="${id}" data-content-url="${contentUrl}" data-raw-url="${rawUrl}" data-staff-review="${staffReview}" data-offline-cacheable="${offlineCacheable}" data-format="${paste.format ?? 'single'}" data-primary="${escapeHtml(paste.primary ?? '')}" data-content-type="${escapeHtml(paste.content_type)}" data-byte-length="${paste.byte_length}" data-sha256="${escapeHtml(paste.sha256)}" data-dialog-metadata="${dialogMetadata}" aria-busy="true">
      ${pasteContentSkeleton()}
    </div>
  </section>
</div>`;
}
