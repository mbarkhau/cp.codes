import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delimitedParser, highlightDelimited } from '../public/delimited.js';

function tokens(content, separator) {
	const parser = delimitedParser(separator), state = parser.startState();
	return content.split(/\r\n|\r|\n/).flatMap(line => {
		if (!line) { parser.blankLine(state); return []; }
		const stream = { string: line, pos: 0, sol() { return this.pos === 0; }, peek() { return this.string[this.pos]; } };
		const result = [];
		while (stream.pos < line.length) {
			const start = stream.pos, tag = parser.token(stream, state);
			assert.ok(stream.pos > start, 'every token must advance');
			result.push({ text: line.slice(start, stream.pos), tag });
		}
		return result;
	});
}

for (const separator of [',', '\t']) {
	test(`${separator === ',' ? 'CSV' : 'TSV'} respects quoted delimiters, escaped quotes, multiline and empty fields`, () => {
		const content = `name${separator}notes${separator}age\nAda${separator}"hello${separator}\n\nworld ""quoted"""${separator}37\r\nBob${separator}${separator}42\n`;
		const result = tokens(content, separator);
		assert.deepEqual(result.filter(t => t.tag).map(t => [t.text, t.tag]), [
			['name', 'string'], ['notes', 'number'], ['age', 'keyword'],
			['Ada', 'string'], [`"hello${separator}`, 'number'], ['world ""quoted"""', 'number'], ['37', 'keyword'],
			['Bob', 'string'], ['42', 'keyword'],
		]);
		const html = highlightDelimited(content, separator);
		assert.equal(html.replace(/<\/?span[^>]*>/g, ''), content);
		assert.match(html, /class="hljs-number">world/);
		assert.match(html, /class="hljs-keyword">42/);
	});
}

test('delimited highlighting escapes source HTML and preserves every byte of text', () => {
	const content = '<script>&danger</script>,"a,""b""",\r\n,,\n';
	const html = highlightDelimited(content, ',');
	assert.ok(!html.includes('<script>'));
	assert.equal(html.replace(/<\/?span[^>]*>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'), content);
	assert.equal(highlightDelimited('', ','), '');
});
