// Shared CSV/TSV tokenization for the editor and viewer. Quoted fields may span lines.
const tokenNames = ['string', 'number', 'keyword', 'type', 'attribute', 'def'];
const classes = ['string', 'number', 'keyword', 'type', 'attr', 'title'];

function tokenEnd(text, from, state, separator) {
	if (!state.quoted && text[from] === separator) {
		state.column++;
		state.fieldStart = true;
		return from + 1;
	}
	let pos = from;
	if (state.fieldStart && text[pos] === '"') { state.quoted = true; pos++; }
	state.fieldStart = false;
	while (pos < text.length) {
		if (state.quoted && text[pos] === '"') {
			if (text[pos + 1] === '"') { pos += 2; continue; }
			state.quoted = false;
			pos++;
		} else if (!state.quoted && text[pos] === separator) break;
		else pos++;
	}
	return pos;
}

export function delimitedParser(separator) {
	return {
		name: separator === '\t' ? 'tsv' : 'csv',
		startState: () => ({ column: 0, quoted: false, fieldStart: true }),
		blankLine(state) { if (!state.quoted) { state.column = 0; state.fieldStart = true; } },
		token(stream, state) {
			if (stream.sol() && !state.quoted) { state.column = 0; state.fieldStart = true; }
			const column = state.column;
			const delimiter = !state.quoted && stream.peek() === separator;
			stream.pos = tokenEnd(stream.string, stream.pos, state, separator);
			return delimiter ? null : tokenNames[column % tokenNames.length];
		},
	};
}

const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function highlightDelimited(content, separator) {
	const state = { column: 0, quoted: false, fieldStart: true };
	return content.split(/(\r\n|\r|\n)/).map((line, index) => {
		if (index % 2) return line;
		if (!state.quoted) { state.column = 0; state.fieldStart = true; }
		let result = '', pos = 0;
		while (pos < line.length) {
			const column = state.column;
			const delimiter = !state.quoted && line[pos] === separator;
			const end = tokenEnd(line, pos, state, separator);
			const text = escape(line.slice(pos, end));
			result += delimiter ? text : `<span class="hljs-${classes[column % classes.length]}">${text}</span>`;
			pos = end;
		}
		return result;
	}).join('');
}
