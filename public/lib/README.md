# Vendored browser libraries

## uqr 0.1.2

`uqr-0.1.2.js` is the unmodified `dist/index.mjs` from the published
[`uqr@0.1.2`](https://www.npmjs.com/package/uqr/v/0.1.2) package. It has no
dependencies and is imported locally by `../qr_text.js`; no build step is needed.
The MIT license is retained in `uqr-LICENSE`.

Source archive: https://registry.npmjs.org/uqr/-/uqr-0.1.2.tgz

Verified npm archive integrity (SHA-512):

```text
sha512-MJu7ypHq6QasgF5YRTjqscSzQp/W11zoUk6kvmlH+fmWEs63Y0Eib13hYFwAzagRJcVY8WVnlV+eBDUGMJ5IbA==
```

To update, extract the ESM module and license from a checksum-verified npm
archive, use a new versioned filename, and update the QR import and browser smoke
test's asset allowlist.

## Markdown and SHA-256 bundles

`markdown-it-14.1.0.js` is a standalone ESM bundle of `markdown-it@14.1.0`
with `mdurl@2.0.0`, `entities@4.5.0`, `uc.micro@2.1.0`, `linkify-it@5.0.0`,
and `punycode.js@2.3.1`. One compatible copy of `uc.micro` serves both
Markdown and link detection. `argparse` is only used by the upstream CLI and is
not needed in the browser. Licenses and the Node.js URL-parser notice are
retained in `markdown-it-LICENSE`.

`hash-wasm-4.12.0.js` is a standalone ESM bundle exporting only `sha256` from
`hash-wasm@4.12.0`. Its WASM is embedded; there are no external WASM files or
runtime dependencies. The package license and embedded SHA-256 implementation's
notice are retained in `hash-wasm-LICENSE`.

Both bundles were generated with esbuild 0.28.1 from checksum-verified npm
archives. `vendor-sources.json` records the exact versions, archive URLs, and
SHA-512 integrity values. All application imports use `/lib/` URLs anchored to
the site root. Wrangler serves the committed files directly; development and
deployment do not require an additional build step.

To reproduce, install the recorded package versions and `esbuild@0.28.1` in a
temporary directory. Match the archive integrity values to `vendor-sources.json`.
Create `hash-wasm-sha256.mjs` there with:

```js
export { sha256 } from 'hash-wasm';
```

Run these commands from that temporary directory, then copy the resulting files
into `public/lib/`:

```sh
npx --no-install esbuild node_modules/markdown-it/index.mjs --bundle --format=esm --platform=browser --target=es2020 --minify --legal-comments=inline --outfile=markdown-it-14.1.0.js
npx --no-install esbuild hash-wasm-sha256.mjs --bundle --format=esm --platform=browser --target=es2020 --minify --legal-comments=inline --outfile=hash-wasm-4.12.0.js
```

For updates, refresh the versions, integrity records, and license notices;
change the versioned filenames and corresponding imports and smoke-test asset
allowlist. Verify Markdown rendering and SHA-256 test vectors with networking
disabled, and increment the changed client modules' cache-version query strings.
