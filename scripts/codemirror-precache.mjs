import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const project = fileURLToPath(new URL('../', import.meta.url));
const defaultImports = [
	'@codemirror/view', '@codemirror/state', '@codemirror/language',
	'@codemirror/commands', '@lezer/highlight',
	'@codemirror/lang-markdown', '@codemirror/lang-json', '@codemirror/lang-html',
	'@codemirror/lang-css', '@codemirror/lang-javascript', '@codemirror/lang-python',
];

/** Include the complete dependency graph of the editor and its default languages. */
export async function editorPrecacheFiles(imports) {
	const result = await build({
		absWorkingDir: project,
		stdin: { contents: defaultImports.map(name => `import ${JSON.stringify(name)};`).join('\n'), resolveDir: project },
		bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser',
		plugins: [{ name: 'editor-precache-import-map', setup(build) {
			build.onResolve({ filter: /^[^./]/ }, ({ path }) => {
				if (!imports[path]) throw new Error(`Unmapped editor dependency: ${path}`);
				return { path: resolve(project, `public${decodeURIComponent(imports[path])}`) };
			});
		} }],
	});
	return Object.keys(result.metafile.inputs).filter(path => path !== '<stdin>')
		.map(path => '/' + relative(resolve(project, 'public'), resolve(project, path)).split(sep).map(encodeURIComponent).join('/')).sort();
}
