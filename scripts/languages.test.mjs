import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { transform } from 'esbuild';
import { CONTENT_TYPE_LABELS, contentTypeForFilename, detectContentType } from '../public/content_type.js';

const { code } = await transform(await readFile('src/content_type.ts', 'utf8'), { loader: 'ts', format: 'esm' });
const server = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const fixtures = JSON.parse(await readFile('scripts/fixtures/languages.json', 'utf8'));

test('client and server recognize build files before Markdown and YAML', () => {
	const dockerfile = `FROM python:3.13
WORKDIR /usr/local/app

# Install the application dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy in the source code
COPY src ./src
EXPOSE 8080

# Setup an app user so the container doesn't run as the root user
RUN useradd app
USER app

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]`;
	const makefile = `SHELL := /bin/bash
.SHELLFLAGS := -O extglob -eo pipefail -c
.DEFAULT_GOAL := html
.SUFFIXES:

.PHONY: sync_and_ingest
sync_and_ingest:
    uv run --script scripts/panzer_imgsync.py $(SYNC_ARGS)


.PHONY: thumbnails
thumbnails:
    uv run --script scripts/generate_thumbnails.py


index.html: templates/*
    uv run --script scripts/gen_html.py index.html

media.html: templates/*
    uv run --script scripts/gen_html.py media.html

.PHONY: classification-index
classification-index:
    uv run --script scripts/export_classifications.py

.PHONY: html
html: classification-index index.html media.html`;
	const cases = [
		[dockerfile, 'dockerfile'],
		['# syntax=docker/dockerfile:1\nARG BASE=alpine:3\nFROM ${BASE}\nRUN echo hello', 'dockerfile'],
		['from alpine:3\nrun echo hello', 'dockerfile'],
		[makefile, 'makefile'],
		[makefile.replace(/^ {4}/gm, '\t'), 'makefile'],
		['CC = gcc\nall: main.c\n\t$(CC) main.c -o main', 'makefile'],
		['.PHONY: clean\nclean:\n\trm -f output', 'makefile'],
		['all:\n\techo hello', 'makefile'],
		['# Settings\nname: demo\nimage: python:3.13\ncommand: pip install requirements', 'yaml'],
		['# Installation\n\nRun pip install to get started.', 'markdown'],
		['```dockerfile\n' + dockerfile + '\n```', 'markdown'],
		['```makefile\n' + makefile + '\n```', 'markdown'],
		['FROM the documentation we learn many things.', 'plaintext'],
	];
	for (const detect of [detectContentType, server.detectContentType]) {
		for (const [content, type] of cases) {
			assert.equal(detect(content), type, content);
			assert.equal(detect(content.replaceAll('\n', '\r\n')), type, content);
		}
	}
});

test('language choices agree across browser, API and CLI and have valid raw routes', async () => {
	assert.deepEqual(CONTENT_TYPE_LABELS, server.CONTENT_TYPE_LABELS);
	const cli = await readFile('scripts/paste.py', 'utf8');
	const choices = cli.match(/CONTENT_TYPES = \(([\s\S]*?)\)/)[1].match(/"([a-z0-9]+)"/g).map(value => JSON.parse(value));
	assert.deepEqual(choices, server.CONTENT_TYPES);
	for (const { type } of fixtures) {
		assert.ok(server.isContentType(type));
		assert.equal(server.contentTypeForExtension(server.fileExtension(type)), type);
		assert.ok(server.rawContentType(type));
	}
});

test('client and server detect language extensions and conventional build filenames consistently', () => {
	const cases = {
		'Cargo.toml': 'toml', 'Makefile': 'makefile', 'GNUmakefile': 'makefile', 'rules.mk': 'makefile',
		'rules.mak': 'makefile', 'rules.make': 'makefile', 'Main.kt': 'kotlin', 'build.gradle.kts': 'kotlin',
		'Demo.swift': 'swift', 'main.dart': 'dart', 'Demo.scala': 'scala', 'script.sc': 'scala',
		'init.lua': 'lua', 'script.pl': 'perl', 'Module.pm': 'perl', 'analysis.R': 'r', 'script.rscript': 'r',
		'analysis.jl': 'julia', 'script.ps1': 'powershell', 'Module.psm1': 'powershell', 'Module.psd1': 'powershell',
		'Dockerfile': 'dockerfile', 'Dockerfile.dev': 'dockerfile', 'Containerfile': 'dockerfile', 'app.dockerfile': 'dockerfile',
		'CMakeLists.txt': 'cmake', 'FindDemo.cmake': 'cmake', 'settings.ini': 'ini', 'change.diff': 'diff', 'change.patch': 'diff',
		'settings.yaml': 'yaml', 'settings.yml': 'yaml', 'notes.txt': 'plaintext', 'unknown.xyz': 'plaintext',
		'icon.svg': 'xml', 'settings.jsonc': 'jsonc', 'settings.json5': 'json5', 'table.csv': 'csv', 'table.tsv': 'tsv',
		'style.scss': 'scss', 'style.sass': 'sass', 'style.less': 'less', 'demo.ex': 'elixir', 'script.exs': 'elixir',
		'demo.erl': 'erlang', 'header.hrl': 'erlang', 'Main.hs': 'haskell', 'Main.lhs': 'haskell',
		'demo.clj': 'clojure', 'demo.cljs': 'clojure', 'demo.cljc': 'clojure', 'data.edn': 'clojure',
		'demo.fs': 'fsharp', 'script.fsx': 'fsharp', 'header.fsi': 'fsharp', 'demo.mm': 'objectivec', 'demo.objc': 'objectivec',
		'demo.groovy': 'groovy', 'build.gradle': 'groovy', 'analysis.m': 'matlab', 'analysis.matlab': 'matlab', 'analysis.octave': 'octave',
	};
	for (const resolve of [contentTypeForFilename, server.contentTypeForFilename]) {
		for (const [filename, type] of Object.entries(cases)) {
			assert.equal(resolve(filename), type, filename);
			assert.equal(resolve(`path/to/${filename.toUpperCase()}`), type, filename);
			assert.equal(resolve(`C:\\project\\${filename}`), type, filename);
		}
	}
});

test('SVG root tags, namespaces and doctypes select XML without overriding HTML or fenced code', () => {
	const cases = [
		['<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>', 'xml'],
		['<svg/>', 'xml'], ['<svg', 'xml'], ['<svg:svg/>', 'xml'],
		['<?xml version="1.0"?>\n<!-- icon -->\n<svg xmlns="http://www.w3.org/2000/svg"/>', 'xml'],
		['<!-- icon -->\n<svg/>', 'xml'],
		['<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg/>', 'xml'],
		['<g xmlns="http://www.w3.org/2000/svg">', 'xml'],
		['<html><body><svg/></body></html>', 'html'],
		['```xml\n<svg/>\n```', 'markdown'],
		['```xml\n<svg xmlns="http://www.w3.org/2000/svg"/>\n```', 'markdown'],
		['const url = "http://www.w3.org/2000/svg";', 'javascript'],
	];
	for (const detect of [detectContentType, server.detectContentType]) {
		for (const [content, type] of cases) assert.equal(detect(content), type, content);
	}
	for (const resolve of [contentTypeForFilename, server.contentTypeForFilename]) {
		assert.equal(resolve('unknown.txt', '<svg/>'), 'xml');
		assert.equal(resolve('Demo.m', '#import <Foundation/Foundation.h>\n@interface Demo : NSObject\n@end'), 'objectivec');
		assert.equal(resolve('Demo.m', 'function y = square(x)\n y = x.^2;\nend'), 'matlab');
		assert.equal(resolve('Demo.m', ''), 'matlab');
	}
});
