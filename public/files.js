import { CONTENT_TYPE_LABELS, contentTypeForFilename, detectContentType } from './content_type.js?v=11';
import { MAX_FILES, MAX_UPLOAD_BYTES } from './policy.js?v=1';
import { delimitedParser } from './delimited.js?v=1';

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
	makefile: ['codemirror-lang-makefile', 'makefile'],
	toml: ['@codemirror/legacy-modes/mode/toml', 'toml', { stream: true }],
	ini: ['@codemirror/legacy-modes/mode/properties', 'properties', { stream: true }],
	kotlin: ['@codemirror/legacy-modes/mode/clike', 'kotlin', { stream: true }],
	csharp: ['@codemirror/legacy-modes/mode/clike', 'csharp', { stream: true }],
	scala: ['@codemirror/legacy-modes/mode/clike', 'scala', { stream: true }],
	dart: ['@codemirror/legacy-modes/mode/clike', 'dart', { stream: true }],
	shell: ['@codemirror/legacy-modes/mode/shell', 'shell', { stream: true }],
	ruby: ['@codemirror/legacy-modes/mode/ruby', 'ruby', { stream: true }],
	swift: ['@codemirror/legacy-modes/mode/swift', 'swift', { stream: true }],
	lua: ['@codemirror/legacy-modes/mode/lua', 'lua', { stream: true }],
	perl: ['@codemirror/legacy-modes/mode/perl', 'perl', { stream: true }],
	r: ['@codemirror/legacy-modes/mode/r', 'r', { stream: true }],
	julia: ['@codemirror/legacy-modes/mode/julia', 'julia', { stream: true }],
	powershell: ['@codemirror/legacy-modes/mode/powershell', 'powerShell', { stream: true }],
	dockerfile: ['@codemirror/legacy-modes/mode/dockerfile', 'dockerFile', { stream: true }],
	cmake: ['@codemirror/legacy-modes/mode/cmake', 'cmake', { stream: true }],
	diff: ['@codemirror/legacy-modes/mode/diff', 'diff', { stream: true }],
	jsonc: ['lezer-json5', 'parser', { json5: true }],
	json5: ['lezer-json5', 'parser', { json5: true }],
	scss: ['@codemirror/lang-sass', 'sass'],
	sass: ['@codemirror/lang-sass', 'sass', { indented: true }],
	less: ['@codemirror/lang-less', 'less'],
	elixir: ['codemirror-lang-elixir', 'elixir'],
	erlang: ['@codemirror/legacy-modes/mode/erlang', 'erlang', { stream: true }],
	haskell: ['@codemirror/legacy-modes/mode/haskell', 'haskell', { stream: true }],
	clojure: ['@codemirror/legacy-modes/mode/clojure', 'clojure', { stream: true }],
	fsharp: ['@codemirror/legacy-modes/mode/mllike', 'fSharp', { stream: true }],
	objectivec: ['@codemirror/legacy-modes/mode/clike', 'objectiveC', { stream: true }],
	groovy: ['@codemirror/legacy-modes/mode/groovy', 'groovy', { stream: true }],
	matlab: ['@codemirror/legacy-modes/mode/octave', 'octave', { stream: true }],
	octave: ['@codemirror/legacy-modes/mode/octave', 'octave', { stream: true }],
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
	]).then(([view, state, language, commands, { tags, styleTags }]) => ({ ...view, ...state, ...language, ...commands, tags, styleTags }))
		.catch(() => null);
	return codeMirrorPromise;
}

const languageCache = new Map();
async function languageExtension(type) {
	const spec = languagePackages[type];
	const cm = await loadCodeMirror();
	if (cm && (type === 'csv' || type === 'tsv')) {
		if (!languageCache.has(type)) languageCache.set(type, cm.StreamLanguage.define(delimitedParser(type === 'tsv' ? '\t' : ',')));
		return languageCache.get(type);
	}
	if (!spec || !cm) return [];
	try {
		const key = spec[0] + ':' + spec[1] + JSON.stringify(spec[2] ?? {});
		let extension = languageCache.get(key);
		if (!extension) {
			const module = await import(spec[0]);
			extension = spec[2]?.json5 ? new cm.LanguageSupport(cm.LRLanguage.define({
				name: 'json5',
				parser: module.parser.configure({ props: [cm.styleTags({
					String: cm.tags.string, 'PropertyName!': cm.tags.propertyName, Number: cm.tags.number,
					'Null': cm.tags.null, 'True False': cm.tags.bool, 'LineComment BlockComment': cm.tags.comment,
				})] }),
				languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
			})) : spec[2]?.stream
				? cm.StreamLanguage.define({ ...module[spec[1]], name: module[spec[1]].name ?? type })
				: module[spec[1]](spec[2] ?? {});
			languageCache.set(key, extension);
		}
		return extension;
	} catch {
		return [];
	}
}

/** Stacked file editors. The first file is always the primary document. */
export function createFileEditor({ root, changed = () => {}, submit = () => {} }) {
	const files = [];
	const notify = (error) => { try { changed(error); } catch { /* The caller reports its own UI errors. */ } };

	function detectedType(file) {
		const detected = detectContentType(file.content);
		if (mediaTypes.has(detected)) return detected;
		const name = file.input.value.trim();
		return name ? contentTypeForFilename(name, file.content) : detected;
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


	function updateFileActions() {
		for (const [index, file] of files.entries()) file.moveUpButton.hidden = index === 0;
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
		file.wrap.hidden = true;
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
		textarea.addEventListener('input', () => { file.content = textarea.value; syncTypeLabel(file); notify(); });
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
							{ tag: [cm.tags.string, cm.tags.regexp, cm.tags.content], color: 'var(--syntax-string)' },
							{ tag: [cm.tags.number, cm.tags.bool, cm.tags.null, cm.tags.atom], color: 'var(--syntax-number)' },
							{ tag: [cm.tags.typeName, cm.tags.className, cm.tags.namespace], color: 'var(--syntax-type)' },
							{ tag: [cm.tags.function(cm.tags.variableName), cm.tags.definition(cm.tags.variableName), cm.tags.labelName], color: 'var(--syntax-title)' },
							{ tag: [cm.tags.tagName, cm.tags.attributeName, cm.tags.propertyName], color: 'var(--syntax-tag)' },
							{ tag: [cm.tags.comment, cm.tags.meta], color: 'var(--syntax-comment)' },
							{ tag: cm.tags.inserted, color: 'var(--syntax-tag)' },
							{ tag: cm.tags.deleted, color: 'var(--syntax-keyword)' },
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
							syncTypeLabel(file);
							void applyLanguage(file);
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
		for (const value of ['auto', 'plaintext', 'markdown', 'url']) {
			typeSelect.append(new Option(CONTENT_TYPE_LABELS[value], value));
		}
		// Explicit display order within each group; future code types fall back to alphabetical order.
		const configTypes = ['json', 'jsonc', 'json5', 'xml', 'ini', 'yaml', 'toml', 'csv', 'tsv'];
		const scriptTypes = ['javascript', 'typescript', 'python', 'ruby', 'perl', 'php', 'lua', 'shell', 'powershell', 'dockerfile', 'makefile'];
		const codeOrder = ['html', 'css', 'scss', 'sass', 'less', 'sql', 'rust', 'c', 'cpp', 'csharp',
			'fsharp', 'objectivec', 'go', 'java', 'groovy', 'scala', 'kotlin', 'clojure', 'swift', 'dart',
			'r', 'julia', 'matlab', 'octave', 'cmake', 'erlang', 'elixir', 'haskell', 'diff'];
		const codeRank = new Map(codeOrder.map((type, index) => [type, index]));
		const typeGroups = {
			'Config/Data': configTypes,
			Script: scriptTypes,
			Code: Object.keys(CONTENT_TYPE_LABELS)
				.filter(type => !['auto', 'plaintext', 'markdown', 'url', ...configTypes, ...scriptTypes].includes(type) && !mediaTypes.has(type))
				.sort((a, b) => (codeRank.get(a) ?? Infinity) - (codeRank.get(b) ?? Infinity) ||
					CONTENT_TYPE_LABELS[a].localeCompare(CONTENT_TYPE_LABELS[b])),
			Image: ['jpeg', 'png', 'webp', 'gif'],
			Media: ['mp4', 'mp3'],
		};
		for (const [label, types] of Object.entries(typeGroups)) {
			const group = document.createElement('optgroup');
			group.label = label;
			for (const value of types) group.append(new Option(CONTENT_TYPE_LABELS[value], value));
			typeSelect.append(group);
		}
		typeSelect.value = mediaTypes.has(initial.content_type) ? initial.content_type : 'auto';
		file.typeSelect = typeSelect;
		const nameGroup = document.createElement('div');
		nameGroup.className = 'editor-name';
		nameGroup.append(input, typeSelect);
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'icon-action danger editor-remove';
		remove.setAttribute('aria-label', 'Remove file');
		remove.setAttribute('data-icon', 'delete');
		remove.title = 'Remove file';
		file.removeButton = remove;
		const moveUp = document.createElement('button');
		moveUp.type = 'button';
		moveUp.className = 'icon-action editor-move-up';
		moveUp.setAttribute('aria-label', 'Move file up');
		moveUp.setAttribute('data-icon', 'arrow-up');
		moveUp.title = 'Move file up';
		file.moveUpButton = moveUp;
		const options = document.createElement('div');
		options.className = 'editor-options';
		file.options = options;
		const modeToggle = (name, modes, initial) => {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'icon-action editor-toggle';
			let index = Math.max(0, modes.findIndex((mode) => mode.value === initial));
			const render = () => {
				const mode = modes[index];
				button.value = mode.value;
				button.setAttribute('data-icon', mode.icon);
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
			{ value: 'soft', label: 'Soft wrap', icon: 'wrap' },
			{ value: 'none', label: 'No wrap', icon: 'no-wrap' },
		], 'soft');
		file.wrap = wrap;
		options.append(wrap, moveUp, remove);
		toolbar.append(nameGroup, options);
		const mount = document.createElement('div');
		mount.className = 'editor-mount';
		file.mount = mount;
		card.append(toolbar, mount);
		input.addEventListener('input', () => { syncTypeLabel(file); void applyLanguage(file); notify(); });
		typeSelect.addEventListener('change', () => { syncTypeLabel(file); void applyLanguage(file); notify(); });
		remove.addEventListener('click', () => {
			const index = files.indexOf(file);
			if (index < 0) return;
			file.editor?.destroy();
			card.remove();
			files.splice(index, 1);
			if (!files.length) {
				const empty = createFile();
				files.push(empty);
				root.append(empty.card);
				empty.editor.focus();
			}
			updateFileActions();
			notify();
		});
		moveUp.addEventListener('click', () => {
			const index = files.indexOf(file);
			if (index < 1) return;
			const predecessor = files[index - 1];
			files[index - 1] = file;
			files[index] = predecessor;
			root.insertBefore(card, predecessor.card);
			updateFileActions();
			moveUp.focus();
			notify();
		});
		const initialType = initial.content_type ?? detectContentType(file.content);
		if (mediaTypes.has(initialType)) showMedia(file);
		else file.editor = mountTextEditor(file);
		syncTypeLabel(file);
		return file;
	}

	function add(name, text, contentType, { reuseEmpty = true } = {}) {
		const empty = reuseEmpty ? files.find((file) => !file.content) : null;
		if (name && files.some((file) => file !== empty && file.input.value.trim().toLowerCase() === name.toLowerCase())) throw new Error(`A file named ${name} already exists. Rename it first.`);
		if (empty) {
			const file = empty;
			file.input.value = name;
			file.content = text;
			file.typeSelect.value = mediaTypes.has(contentType) ? contentType : 'auto';
			if (mediaTypes.has(contentType)) {
				showMedia(file);
			} else file.editor?.set(text);
			syncTypeLabel(file);
			void applyLanguage(file);
			notify();
			file.editor?.focus();
			return;
		}
		if (files.length >= MAX_FILES) throw new Error(`A paste can contain up to ${MAX_FILES} files`);
		const file = createFile({ name, content: text, content_type: contentType });
		files.push(file);
		root.append(file.card);
		updateFileActions();
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

	const first = createFile();
	files.push(first);
	root.replaceChildren(first.card);
	updateFileActions();
	document.getElementById('add-text')?.addEventListener('click', () => {
		try { add('', '', 'plaintext', { reuseEmpty: false }); } catch (error) { notify(error.message); }
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
