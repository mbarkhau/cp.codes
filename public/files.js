import { contentTypeForFilename, detectContentType } from './content_type.js?v=7';
import { MAX_FILES, MAX_UPLOAD_BYTES } from './policy.js';

export function createFileEditor({ content, filename, type, list, changed }) {
	let files = [{ name: 'note.md', content_type: 'markdown', content: '' }];
	let selected = 0;
	let primary = files[0];
	filename.value = files[0].name;
	type.value = 'auto';
	const sync = () => {
		const file = files[selected];
		file.name = filename.value.trim();
		file.content = content.value;
		file.content_type = type.value === 'auto' ? contentTypeForFilename(file.name) || detectContentType(file.content) : type.value;
	};
	function render() {
		list.replaceChildren();
		files.forEach((file, index) => {
			const row = document.createElement('div');
			row.className = 'file-row';
			const tab = document.createElement('button');
			tab.type = 'button'; tab.className = 'file-tab'; tab.textContent = file.name || 'Unnamed file';
			tab.setAttribute('aria-pressed', String(index === selected));
			tab.addEventListener('click', () => { sync(); selected = index; load(); changed(); });
			const main = document.createElement('button');
			main.type = 'button'; main.className = 'file-primary'; main.textContent = primary === file ? '★ Main' : '☆ Main';
			main.setAttribute('aria-label', `Make ${file.name} the main document`);
			main.addEventListener('click', () => { primary = file; render(); changed(); });
			const remove = document.createElement('button');
			remove.type = 'button'; remove.className = 'file-remove'; remove.textContent = '×'; remove.disabled = files.length === 1;
			remove.setAttribute('aria-label', `Remove ${file.name}`);
			remove.addEventListener('click', () => {
				sync(); files.splice(index, 1); if (primary === file) primary = files[0]; selected = Math.min(selected, files.length - 1); load(); changed();
			});
			row.append(tab, main, remove); list.append(row);
		});
	}
	function load() {
		hidePreview();
		const file = files[selected]; content.value = file.content; filename.value = file.name; type.value = file.content_type;
		const media = ['png', 'jpeg', 'gif', 'webp', 'mp3', 'mp4'].includes(file.content_type);
		content.hidden = media; document.getElementById('media-selected').hidden = !media;
		if (media) {
			const visual = document.createElement(file.content_type === 'mp3' ? 'audio' : file.content_type === 'mp4' ? 'video' : 'img');
			visual.src = file.content; visual.className = 'paste-image'; visual.alt = file.name;
			if (['mp3', 'mp4'].includes(file.content_type)) { visual.controls = true; visual.preload = 'none'; }
			preview.replaceChildren(visual); preview.hidden = false; previewButton.setAttribute('aria-pressed', 'true');
		}
		render();
	}
	function add(name, text, contentType) {
		sync();
		if (files.length === 1 && files[0].content === '') files = [];
		if (files.length >= MAX_FILES) throw new Error(`A paste can contain up to ${MAX_FILES} files`);
		if (files.some(file => file.name.toLowerCase() === name.toLowerCase())) throw new Error(`A file named ${name} already exists. Rename it first.`);
		const file = { name, content: text, content_type: contentType };
		files.push(file); if (!files.includes(primary)) primary = file; selected = files.length - 1; load(); changed();
	}
	document.getElementById('add-text').addEventListener('click', () => {
		try {
			let n = files.length + 1;
			while (files.some(file => file.name === `note-${n}.md`)) n++;
			add(`note-${n}.md`, '', 'markdown'); content.focus();
		} catch (error) { changed(error.message); }
	});
	filename.addEventListener('change', () => { sync(); render(); changed(); });
	const getBundle = () => { sync(); return { format: 'bundle-v1', primary: primary.name, files: files.map(file => ({ ...file })) }; };
	function validate() {
		const bundle = getBundle(); const names = new Set();
		for (const file of bundle.files) {
			if (!file.name || file.name.length > 128 || file.name !== file.name.trim() || /[\x00-\x1f\x7f/\\?#%:]/.test(file.name) || ['.', '..'].includes(file.name)) throw new Error('Use simple filenames without paths (up to 128 characters)');
			if (names.has(file.name.toLowerCase())) throw new Error('Every file needs a unique filename');
			names.add(file.name.toLowerCase());
			if (!file.content.length) throw new Error(`${file.name} is empty`);
		}
		if (new TextEncoder().encode(JSON.stringify(bundle)).length > MAX_UPLOAD_BYTES) throw new Error('Paste exceeds the 8 MiB upload limit');
		return bundle;
	}
	const preview = document.getElementById('draft-preview');
	const previewButton = document.getElementById('preview-file');
	let previewVersion = 0;
	function hidePreview() { previewVersion++; preview.hidden = true; previewButton.setAttribute('aria-pressed', 'false'); }
	for (const input of [content, filename, type]) input.addEventListener('input', hidePreview);
	previewButton.addEventListener('click', async () => {
		if (!preview.hidden) { hidePreview(); return; }
		sync(); const file = files[selected]; const version = ++previewVersion;
		preview.textContent = 'Preparing preview…'; preview.hidden = false; previewButton.setAttribute('aria-pressed', 'true');
		try {
			let element;
			if (file.content_type === 'markdown') {
				const { markdownElement } = await import('./markdown.js?v=1');
				const attachments = new Map(files.map(file => [file.name, { url: file.content, image: ['png', 'jpeg', 'gif', 'webp'].includes(file.content_type), link: `#file-${encodeURIComponent(file.name)}` }]));
				element = await markdownElement(file.content, attachments);
				for (const link of element.querySelectorAll('a[href^="#file-"]')) link.addEventListener('click', event => {
					event.preventDefault(); sync();
					const name = decodeURIComponent(link.getAttribute('href').slice(6));
					const index = files.findIndex(file => file.name === name);
					if (index < 0) return;
					selected = index; load(); changed();
				});
			} else if (['png', 'jpeg', 'gif', 'webp'].includes(file.content_type)) {
				element = document.createElement('img'); element.src = file.content; element.alt = file.name; element.className = 'paste-image';
			} else { element = document.createElement('pre'); element.className = 'paste'; element.textContent = file.content; }
			if (version === previewVersion) preview.replaceChildren(element);
		} catch { if (version === previewVersion) preview.textContent = 'Preview unavailable. Your source is still intact.'; }
	});
	render();
	return { add, getBundle, validate, render };
}
