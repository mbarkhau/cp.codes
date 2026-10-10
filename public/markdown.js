/** HTML is disabled; only explicit sibling images load, never remote trackers. */
export async function markdownElement(content, attachments = new Map()) {
	const { default: MarkdownIt } = await import('/lib/markdown-it-14.1.0.js');
	const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });
	const localFile = value => {
		try { return attachments.get(decodeURIComponent(value.replace(/^\.\//, ''))); } catch { return null; }
	};
	const defaultImage = markdown.renderer.rules.image;
	markdown.renderer.rules.image = (tokens, index, options, env, self) => {
		const file = localFile(tokens[index].attrGet('src') || '');
		if (!file?.image) return `<span class="meta">[Image not loaded: ${markdown.utils.escapeHtml(tokens[index].content)}]</span>`;
		tokens[index].attrSet('src', file.url);
		tokens[index].attrSet('loading', 'lazy');
		tokens[index].attrSet('referrerpolicy', 'no-referrer');
		return defaultImage(tokens, index, options, env, self);
	};
	const defaultLink = markdown.renderer.rules.link_open;
	markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
		const href = tokens[index].attrGet('href') || '';
		const local = localFile(href);
		if (local) tokens[index].attrSet('href', local.link ?? local.url);
		else if (!/^(https?:|mailto:|#)/i.test(href)) { tokens[index].attrSet('href', '#'); tokens[index].attrSet('title', 'Sibling file not found'); }
		tokens[index].attrSet('rel', 'nofollow noopener noreferrer');
		return defaultLink ? defaultLink(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
	};
	const article = document.createElement('article');
	article.className = 'markdown-body'; article.innerHTML = markdown.render(content);
	return article;
}
