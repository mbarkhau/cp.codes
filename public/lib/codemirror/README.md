# Vendored CodeMirror ESM modules

The package versions and ESM entry points are pinned in
`scripts/codemirror-packages.json`. `manifest.json` records the local import map,
npm archive URLs and verified SHA-512 checksums, licenses, and served ESM files.
Each package directory retains its upstream license and package metadata. The
JavaScript files are unmodified copies of the published npm files.

The editor's import map uses root-relative URLs containing each package version.
All imports of a package resolve to one module instance, including the shared
CodeMirror state/view/language packages. Language extensions continue to load on
demand. These files receive the same immutable cache policy as other pinned
vendor assets.

To refresh the vendor files, update the pins and run:

```sh
node scripts/vendor-codemirror.mjs
node --test scripts/codemirror.test.mjs scripts/assets.test.mjs
```

With Playwright and Chromium installed, `npm run test:codemirror:browser` checks
the actual editor and all supported language modes with external requests blocked.
`PLAYWRIGHT_MODULE` can select an external Playwright installation, and
`PLAYWRIGHT_EXECUTABLE_PATH` can select an installed Chromium executable.

The maintenance script downloads npm archives, verifies their integrity, copies
the ESM dependency graph and licenses, and regenerates the manifest. It rejects
unmapped dependencies and changed archive checksums for an already-vendored
package version. Add any newly required packages to the pins before retrying.

Development and deployment serve these committed files directly; no download or
build step is required. Keep versioned vendor directories unchanged once shipped.
