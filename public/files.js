import { CONTENT_TYPE_LABELS, contentTypeForFilename, detectContentType } from './content_type.js?v=8';
import { MAX_FILES, MAX_UPLOAD_BYTES } from './policy.js?v=1';

const mediaTypes = new Set(['png', 'jpeg', 'webp', 'gif', 'mp3', 'mp4']);
const languagePackages = {
	javascript: ['@codemirror/lang-javascript', 'javascript'],
	typescript: ['@codemirror/lang-javascript', 'javascript', { typescript: true }],
	python: ['@codemirror/lang-python', 'python'],
	java: ['@codemirror/lang-java', 'java'],
	json: ['@codemirror/lang-json', 'json'],
	html: ['@codemirror/lang-html', 'html'],
	css: ['@codemirror/lang-css', 'css'],
	sql: ['@codemirror/lang-sql', 'sql'],
	yaml: ['@codemirror/lang-yaml', 'yaml'],
	xml: ['@codemirror/lang-xml', 'xml'],
	c: ['@codemirror/lang-cpp', 'cpp'],
	cpp: ['@codemirror/lang-cpp', 'cpp'],
	rust: ['@codemirror/lang-rust', 'rust'],
	go: ['@codemirror/lang-go', 'go'],
	php: ['@codemirror/lang-php', 'php'],
	markdown: ['@codemirror/lang-markdown', 'markdown'],
};

let codeMirrorPromise;
function loadCodeMirror() {
	// Bare imports share one module copy through the page import map.
	codeMirrorPromise ??= Promise.all([
		import('@codemirror/view'),
		import('@codemirror/state'),
		import('@codemirror/language'),
		import('@codemirror/commands'),
		import('@lezer/highlight'),
	]).then(([view, state, language, commands, { tags }]) => ({ ...view, ...state, ...language, ...commands, tags }))
		.catch(() => null);
	return codeMirrorPromise;
}

const languageCache = new Map();
async function languageExtension(type) {
	const spec = languagePackages[type];
	const cm = await loadCodeMirror();
	if (!spec || !cm) return [];
	try {
		let extension = languageCache.get(spec[0] + JSON.stringify(spec[2] ?? {}));
		if (!extension) {
			const module = await import(spec[0]);
			extension = module[spec[1]](spec[2] ?? {});
			languageCache.set(spec[0] + JSON.stringify(spec[2] ?? {}), extension);
		}
		return extension;
	} catch {
		return [];
	}
}

function trashIcon() {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 32 32');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M 13 7 H 19 Z M 8 9 H 24 Z M 9 12 V 14 L 11 25 H 21 L 23 14 V 12');
	path.setAttribute('fill', 'none');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.8');
	path.setAttribute('stroke-linecap', 'butt');
	path.setAttribute('stroke-linejoin', 'miter');
	svg.append(path);
	return svg;
}

/** Stacked file editors. The first file is always the primary document. */
export function createFileEditor({ root, changed = () => {}, submit = () => {} }) {
	const files = [];
	const notify = (error) => { try { changed(error); } catch { /* The caller reports its own UI errors. */ } };

	function detectedType(file) {
		const detected = detectContentType(file.content);
		if (mediaTypes.has(detected)) return detected;
		const name = file.input.value.trim();
		return name ? contentTypeForFilename(name) : detected;
	}

	function resolveType(file) {
		const detected = detectedType(file);
		if (mediaTypes.has(detectContentType(file.content))) return detected;
		if (file.typeSelect?.value && file.typeSelect.value !== 'auto') return file.typeSelect.value;
		return detected;
	}

	function syncTypeLabel(file) {
		const option = file.typeSelect?.querySelector('option[value="auto"]');
		if (option) option.textContent = `Auto (${CONTENT_TYPE_LABELS[detectedType(file)] ?? detectedType(file)})`;
	}

	function items() {
		return files.map((file, index) => ({
			name: file.input.value.trim(),
			content: file.content,
			content_type: resolveType(file, index),
		}));
	}

	let previewVersion = 0;
	let previewed = null;
	const previewPane = () => document.getElementById('draft-preview');
	function hidePreview() {
		previewVersion++;
		previewed = null;
		const pane = previewPane();
		if (pane) { pane.hidden = true; pane.replaceChildren(); }
		document.getElementById('preview-file')?.setAttribute('aria-pressed', 'false');
	}

	function updateRemoveButtons() {
		for (const file of files) file.removeButton.hidden = files.length < 2;
	}

	function showMedia(file) {
		file.editor?.destroy();
		file.editor = null;
		file.mount.replaceChildren();
		const kind = resolveType(file, files.indexOf(file));
		const visual = document.createElement(kind === 'mp3' ? 'audio' : kind === 'mp4' ? 'video' : 'img');
		visual.src = file.content;
		visual.className = kind === 'mp3' || kind === 'mp4' ? 'paste-media' : 'paste-image';
		visual.alt = file.input.value || 'Media file';
		if (kind === 'mp3' || kind === 'mp4') { visual.controls = true; visual.preload = 'none'; }
		file.mount.append(visual);
		file.options.hidden = true;
	}

	function configure(file) {
		const cm = file.cm;
		if (!cm || !file.view) return;
		file.view.dispatch({ effects: file.wrapCompartment.reconfigure(file.wrap.value === 'soft' ? cm.EditorView.lineWrapping : []) });
	}

	function mountTextEditor(file) {
		const textarea = document.createElement('textarea');
		textarea.className = 'editor-fallback';
		textarea.value = file.content;
		textarea.spellcheck = false;
		textarea.setAttribute('aria-label', 'File content');
		textarea.addEventListener('input', () => { file.content = textarea.value; hidePreview(file); syncTypeLabel(file); notify(); });
		textarea.addEventListener('keydown', (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submit(); }
		});
		file.mount.replaceChildren(textarea);
		const focusSurface = (event) => {
			if (event.button !== 0 || textarea.disabled) return;
			// Text clicks belong to CodeMirror; blank space and gutters should focus it too.
			if (event.target !== file.mount && event.target !== file.view?.dom &&
				event.target !== file.view?.scrollDOM && !event.target.closest?.('.cm-gutters')) return;
			api.focus();
		};
		file.mount.addEventListener('click', focusSurface);
		const api = {
			set(value) { file.content = value; if (file.view) file.view.dispatch({ changes: { from: 0, to: file.view.state.doc.length, insert: value } }); else textarea.value = value; },
			focus() { (file.view ?? textarea).focus(); },
			setEditable(value) { textarea.disabled = !value; file.editable?.reconfigure && file.view?.dispatch({ effects: file.editable.reconfigure(file.cm.EditorView.editable.of(value)) }); },
			destroy() { file.mount.removeEventListener('click', focusSurface); file.view?.destroy(); textarea.remove(); },
		};
		void loadCodeMirror().then(async (cm) => {
			if (!cm || !textarea.isConnected) return;
			const wrap = new cm.Compartment();
			const language = new cm.Compartment();
			const editable = new cm.Compartment();
			file.cm = cm;
			file.wrapCompartment = wrap;
			file.languageCompartment = language;
			file.editable = editable;
			const hadFocus = document.activeElement === textarea;
			const backwards = textarea.selectionDirection === 'backward';
			const view = new cm.EditorView({
				parent: file.mount,
				state: cm.EditorState.create({
					doc: textarea.value,
					selection: {
						anchor: backwards ? textarea.selectionEnd : textarea.selectionStart,
						head: backwards ? textarea.selectionStart : textarea.selectionEnd,
					},
					extensions: [
						cm.lineNumbers({ formatNumber: (lineNo) => String(lineNo).padStart(3, '\u2007') }), cm.highlightActiveLine(), cm.drawSelection(), cm.dropCursor(),
						cm.history(), cm.indentOnInput(), cm.bracketMatching(),
						cm.syntaxHighlighting(cm.HighlightStyle.define([
							...cm.defaultHighlightStyle.specs.filter((spec) => !spec.color),
							{ tag: cm.tags.keyword, color: 'var(--syntax-keyword)' },
							{ tag: [cm.tags.string, cm.tags.regexp], color: 'var(--syntax-string)' },
							{ tag: [cm.tags.number, cm.tags.bool, cm.tags.null, cm.tags.atom], color: 'var(--syntax-number)' },
							{ tag: [cm.tags.typeName, cm.tags.className, cm.tags.namespace], color: 'var(--syntax-type)' },
							{ tag: [cm.tags.function(cm.tags.variableName), cm.tags.definition(cm.tags.variableName)], color: 'var(--syntax-title)' },
							{ tag: [cm.tags.tagName, cm.tags.attributeName, cm.tags.propertyName], color: 'var(--syntax-tag)' },
							{ tag: [cm.tags.comment, cm.tags.meta], color: 'var(--syntax-comment)' },
							{ tag: cm.tags.invalid, color: 'var(--danger)' },
						]), { fallback: true }),
						cm.keymap.of([{ key: 'Mod-Enter', run: () => { submit(); return true; } }, cm.indentWithTab, ...cm.defaultKeymap, ...cm.historyKeymap]),
						cm.indentUnit.of('    '),
						wrap.of(file.wrap.value === 'soft' ? cm.EditorView.lineWrapping : []),
						language.of([]),
						editable.of(cm.EditorView.editable.of(!textarea.disabled)),
						cm.EditorView.theme({
							'&': { backgroundColor: 'var(--content-bg)', color: 'var(--content-fg)', fontFamily: 'var(--mono)', fontSize: '.92rem' },
							'.cm-scroller': { fontFamily: 'inherit', minHeight: '16rem', maxHeight: '28rem' },
							'.cm-gutters, .cm-gutter, .cm-activeLineGutter': { backgroundColor: 'var(--content-bg)', color: 'var(--muted)', border: 'none' },
							'.cm-lineNumbers, .cm-lineNumbers .cm-gutterElement': { minWidth: '3ch', textAlign: 'right' },
							'.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--content-fg) 3%, transparent)' },
							'&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, var(--content-bg))' },
							'.cm-content': { caretColor: 'var(--content-fg)', minHeight: '16rem' },
							'.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--content-fg)' },
							'&.cm-focused': { outline: '2px solid var(--focus)', outlineOffset: '2px' },
						}),
						cm.EditorView.updateListener.of((update) => {
							if (!update.docChanged) return;
							file.content = update.state.doc.toString();
							hidePreview(file);
							syncTypeLabel(file);
							notify();
						}),
					],
				}),
			});
			file.view = view;
			file.card.editorView = view;
			textarea.remove();
			if (hadFocus) view.focus();
			void applyLanguage(file);
		});
		return api;
	}

	async function applyLanguage(file) {
		if (!file.languageCompartment || !file.view) return;
		const next = resolveType(file, files.indexOf(file));
		if (file.appliedLanguage === next) return;
		file.appliedLanguage = next;
		const extension = await languageExtension(next);
		if (file.appliedLanguage === next && file.view) file.view.dispatch({ effects: file.languageCompartment.reconfigure(extension) });
	}

	function createFile(initial = {}) {
		const file = { content: initial.content ?? '', appliedLanguage: null };
		const card = document.createElement('article');
		card.className = 'editor-card';
		file.card = card;
		const toolbar = document.createElement('div');
		toolbar.className = 'editor-toolbar';
		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'editor-filename';
		input.placeholder = 'Filename (optional)';
		input.maxLength = 128;
		input.spellcheck = false;
		input.setAttribute('aria-label', 'Filename including extension');
		input.value = initial.name ?? '';
		file.input = input;
		const typeSelect = document.createElement('select');
		typeSelect.className = 'editor-type';
		typeSelect.setAttribute('aria-label', 'File type');
		for (const [value, label] of Object.entries(CONTENT_TYPE_LABELS)) typeSelect.append(new Option(label, value));
		typeSelect.value = mediaTypes.has(initial.content_type) ? initial.content_type : 'auto';
		file.typeSelect = typeSelect;
		const nameGroup = document.createElement('div');
		nameGroup.className = 'editor-name';
		nameGroup.append(input, typeSelect);
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'file-button editor-remove';
		remove.setAttribute('aria-label', 'Remove file');
		remove.append(trashIcon());
		file.removeButton = remove;
		const options = document.createElement('div');
		options.className = 'editor-options';
		file.options = options;
		const wrapIcon = (wrapped) => {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('viewBox', '0 0 24 24');
			svg.setAttribute('width', '20');
			svg.setAttribute('height', '20');
			svg.setAttribute('aria-hidden', 'true');
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('fill', 'none');
			path.setAttribute('stroke', 'currentColor');
			path.setAttribute('stroke-width', '1.8');
			path.setAttribute('stroke-linecap', 'butt');
			path.setAttribute('stroke-linejoin', 'miter');
			path.setAttribute('d', wrapped
				? 'M4 6h16M4 12h9a4 4 0 0 1 0 8H8m0 0 2.5-2.5M8 20l2.5 2.5'
				: 'M4 7h16M4 12h16M4 17h16');
			svg.append(path);
			return svg;
		};
		const modeToggle = (name, modes, initial) => {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'file-button editor-toggle';
			let index = Math.max(0, modes.findIndex((mode) => mode.value === initial));
			const render = () => {
				const mode = modes[index];
				button.value = mode.value;
				button.replaceChildren(mode.icon());
				button.title = mode.label;
				button.setAttribute('aria-label', `${name}: ${mode.label}`);
			};
			render();
			button.addEventListener('click', () => {
				index = (index + 1) % modes.length;
				render();
				configure(file);
			});
			return button;
		};
		const wrap = modeToggle('Line wrapping', [
			{ value: 'soft', label: 'Soft wrap', icon: () => wrapIcon(true) },
			{ value: 'none', label: 'No wrap', icon: () => wrapIcon(false) },
		], 'soft');
		file.wrap = wrap;
		options.append(wrap);
		toolbar.append(nameGroup, remove, options);
		const mount = document.createElement('div');
		mount.className = 'editor-mount';
		file.mount = mount;
		card.append(toolbar, mount);
		input.addEventListener('input', () => { hidePreview(file); syncTypeLabel(file); void applyLanguage(file); notify(); });
		typeSelect.addEventListener('change', () => { hidePreview(file); syncTypeLabel(file); void applyLanguage(file); notify(); });
		remove.addEventListener('click', () => {
			if (files.length < 2) return;
			file.editor?.destroy();
			card.remove();
			files.splice(files.indexOf(file), 1);
			updateRemoveButtons();
			notify();
		});
		const markActive = () => { active = file; };
		card.addEventListener('pointerdown', markActive);
		card.addEventListener('focusin', markActive);
		const initialType = initial.content_type ?? detectContentType(file.content);
		if (mediaTypes.has(initialType)) showMedia(file);
		else file.editor = mountTextEditor(file);
		syncTypeLabel(file);
		return file;
	}

	async function togglePreview(file) {
		const pane = previewPane();
		if (!pane) return;
		if (previewed === file && !pane.hidden) { hidePreview(); return; }
		const version = ++previewVersion;
		previewed = file;
		pane.hidden = false;
		document.getElementById('preview-file')?.setAttribute('aria-pressed', 'true');
		pane.textContent = 'Preparing preview…';
		try {
			const index = files.indexOf(file);
			const contentType = resolveType(file, index);
			let element;
			if (contentType === 'markdown') {
				const { markdownElement } = await import('./markdown.js?v=2');
				const attachments = new Map(items().map((item) => [item.name, {
					url: item.content, image: ['png', 'jpeg', 'webp', 'gif'].includes(item.content_type), link: `#file-${encodeURIComponent(item.name)}`,
				}]));
				element = await markdownElement(file.content, attachments);
				for (const link of element.querySelectorAll('a[href^="#file-"]')) link.addEventListener('click', (event) => {
					event.preventDefault();
					const name = decodeURIComponent(link.getAttribute('href').slice(6));
					const target = files.find((item) => item.input.value === name);
					target?.editor?.focus();
				});
			} else if (['png', 'jpeg', 'webp', 'gif'].includes(contentType)) {
				element = document.createElement('img');
				element.src = file.content; element.alt = file.input.value; element.className = 'paste-image';
			} else {
				element = document.createElement('pre');
				element.className = 'paste';
				element.textContent = file.content;
			}
			if (version === previewVersion) pane.replaceChildren(element);
		} catch {
			if (version === previewVersion) pane.textContent = 'Preview unavailable. Your source is still intact.';
		}
	}

	function add(name, text, contentType) {
		if (files.length === 1 && !files[0].input.value.trim() && !files[0].content) {
			const file = files[0];
			file.input.value = name;
			file.content = text;
			if (mediaTypes.has(contentType)) {
				file.typeSelect.value = contentType;
				showMedia(file);
			} else file.editor?.set(text);
			syncTypeLabel(file);
			void applyLanguage(file);
			notify();
			file.editor?.focus();
			return;
		}
		if (files.length >= MAX_FILES) throw new Error(`A paste can contain up to ${MAX_FILES} files`);
		if (name && files.some((file) => file.input.value.trim().toLowerCase() === name.toLowerCase())) throw new Error(`A file named ${name} already exists. Rename it first.`);
		const file = createFile({ name, content: text, content_type: contentType });
		files.push(file);
		root.append(file.card);
		updateRemoveButtons();
		notify();
		file.editor?.focus();
	}

	function serialized() {
		const draft = items();
		if (draft.length < 2) return draft[0]?.content ?? '';
		return JSON.stringify({ format: 'bundle-v1', primary: draft[0].name, files: draft });
	}

	function prepare() {
		const draft = items();
		if (draft.some((file) => !file.content.length)) throw new Error('Every file needs content');
		const encoded = new TextEncoder();
		if (draft.length === 1) {
			if (encoded.encode(draft[0].content).length > MAX_UPLOAD_BYTES) throw new Error('Paste exceeds the 8 MiB upload limit');
			return { bundle: null, content: draft[0].content, filename: draft[0].name, content_type: draft[0].content_type };
		}
		const names = new Set();
		for (const file of draft) {
			if (file.name.length > 128 || /[\u0000-\u001f\u007f/\\?#%:]/.test(file.name) || file.name === '.' || file.name === '..') throw new Error('Use simple filenames without paths (up to 128 characters)');
			if (file.name && names.has(file.name.toLowerCase())) throw new Error('Every file needs a unique filename');
			if (file.name) names.add(file.name.toLowerCase());
		}
		const bundle = { format: 'bundle-v1', primary: draft[0].name, files: draft };
		if (encoded.encode(JSON.stringify(bundle)).length > MAX_UPLOAD_BYTES) throw new Error('Paste exceeds the 8 MiB upload limit');
		return { bundle, content: draft[0].content, filename: draft[0].name, content_type: draft[0].content_type };
	}

	let active;
	const first = createFile();
	files.push(first);
	active = first;
	root.replaceChildren(first.card);
	updateRemoveButtons();
	document.getElementById('add-text')?.addEventListener('click', () => {
		try { add('', '', 'plaintext'); } catch (error) { notify(error.message); }
	});
	const previewButton = document.getElementById('preview-file');
	previewButton?.addEventListener('mousedown', (event) => event.preventDefault());
	previewButton?.addEventListener('click', () => {
		const card = document.activeElement?.closest?.('.editor-card');
		const focused = files.find((item) => item.card === card) ?? (files.includes(active) ? active : files[0]);
		void togglePreview(focused);
	});
	return {
		add, prepare, serialized,
		hasContent: () => files.some((file) => file.content.length > 0),
		primary: () => {
			const item = items()[0];
			return item ? { ...item, type_choice: files[0].typeSelect.value } : { name: '', content: '', content_type: 'plaintext', type_choice: 'auto' };
		},
		setEditable(value) {
			for (const file of files) {
				file.input.disabled = !value;
				file.typeSelect.disabled = !value;
				file.removeButton.disabled = !value;
				file.editor?.setEditable(value);
				for (const control of file.options.querySelectorAll('select, button')) control.disabled = !value;
			}
		},
	};
}
