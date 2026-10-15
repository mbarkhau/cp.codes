// Explicit maintenance command; not needed to run or deploy the application.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { editorPrecacheFiles } from './codemirror-precache.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const output = join(project, 'public/lib/codemirror');
const pins = JSON.parse(await readFile(new URL('./codemirror-packages.json', import.meta.url), 'utf8'));
let previous;
try { previous = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const temporary = await mkdtemp(join(tmpdir(), 'cp-codes-codemirror-'));
const imports = {}, sources = {}, files = [];

async function download(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${response.status}: ${url}`);
	return response;
}

try {
	for (const [name, { version, entry, subpaths = {} }] of Object.entries(pins)) {
		assert.match(name, /^(?:@[a-z0-9-]+\/)?[a-z0-9.-]+$/);
		assert.match(version, /^\d+\.\d+\.\d+$/);
		const metadata = await (await download(`https://registry.npmjs.org/${name}/${version}`)).json();
		assert.equal(metadata.name, name);
		assert.equal(metadata.version, version);
		const archive = Buffer.from(await (await download(metadata.dist.tarball)).arrayBuffer());
		const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
		assert.equal(integrity, metadata.dist.integrity, `Archive checksum: ${name}`);
		if (previous?.sources[name]?.version === version) {
			assert.equal(integrity, previous.sources[name].integrity, `Published archive changed: ${name}`);
		}
		const packageDirectory = join(temporary, name.replaceAll('/', '-'));
		await mkdir(packageDirectory);
		const archivePath = join(packageDirectory, 'package.tgz');
		await writeFile(archivePath, archive);
		const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' }).trim().split(/\r?\n/);
		assert.ok(entries.every(path => path.startsWith('package/') && !path.split('/').includes('..')));
		execFileSync('tar', ['-xzf', archivePath, '-C', packageDirectory, '--strip-components', '1']);
		// Workers Assets canonicalizes each path segment, including every @ sign.
		const prefix = '/lib/codemirror/' + `${name}@${version}`.split('/').map(encodeURIComponent).join('/') + '/';
		const destination = join(output, `${name}@${version}`);
		imports[name] = prefix + entry;
		for (const [subpath, file] of Object.entries(subpaths)) imports[`${name}/${subpath}`] = prefix + file;
		const visited = new Set();
		async function copyModule(relative) {
			if (visited.has(relative)) return;
			visited.add(relative);
			const inputPath = resolve(packageDirectory, relative);
			assert.ok(inputPath.startsWith(resolve(packageDirectory) + sep));
			const source = await readFile(inputPath, 'utf8');
			const parsed = await build({ stdin: { contents: source, sourcefile: relative },
				bundle: false, write: false, metafile: true, format: 'esm', logLevel: 'silent' });
			for (const { path: specifier } of Object.values(parsed.metafile.outputs).flatMap(file => file.imports)) {
				if (specifier.startsWith('.')) {
					const next = posix.normalize(posix.join(posix.dirname(relative), specifier));
					await copyModule(next);
				} else {
					assert.ok(pins[specifier], `Unpinned dependency: ${name} imports ${specifier}`);
				}
			}
			const target = join(destination, relative);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, source);
			files.push(prefix + relative.replaceAll('\\', '/'));
		}
		await copyModule(entry);
		for (const file of Object.values(subpaths)) await copyModule(file);
		const license = (await readdir(packageDirectory)).find(path => /^license(?:[.-]|$)/i.test(path));
		assert.ok(license, `License missing: ${name}`);
		await writeFile(join(destination, license), await readFile(join(packageDirectory, license)));
		await writeFile(join(destination, 'package.json'), await readFile(join(packageDirectory, 'package.json')));
		sources[name] = { version, entry, integrity, tarball: metadata.dist.tarball, license: prefix + license };
		console.log(`Vendored ${name}@${version} (${visited.size} ESM file${visited.size === 1 ? '' : 's'})`);
	}
	const precache = await editorPrecacheFiles(imports);
	await writeFile(join(output, 'manifest.json'), JSON.stringify({ imports, sources, files: files.sort(), precache }, null, 2) + '\n');
} finally {
	// Remove only this command's mkdtemp directory inside the system temp root.
	const resolved = await realpath(temporary);
	assert.equal(dirname(resolved), await realpath(tmpdir()));
	assert.ok(resolved.includes('cp-codes-codemirror-'));
	await rm(resolved, { recursive: true, force: true });
}
