// Real lifecycle regression: upgrade a cached shell controlled by the old worker.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const currentWorker = await readFile('public/sw.js', 'utf8');
const { CACHE_VERSION } = await import('../public/offline_assets.js');
let generation = 'old';
const requests = [];
const legacyWorker = `
import { CACHE_VERSION, SHELL_URL, SHELL_ASSETS } from './offline_assets.js?v=old';
const name = 'cp.codes.shell.' + CACHE_VERSION;
self.addEventListener('install', event => event.waitUntil(
  caches.open(name).then(cache => cache.addAll([SHELL_URL, ...SHELL_ASSETS]))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const navigation = event.request.mode === 'navigate' &&
    (url.pathname === '/pastes' || url.pathname === '/CP000001');
  if (!navigation && !SHELL_ASSETS.includes(url.pathname + url.search)) return;
  event.respondWith(caches.open(name).then(async cache =>
    await cache.match(navigation ? SHELL_URL : event.request) ?? fetch(event.request)));
});`;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  requests.push(url.pathname + url.search);
  response.setHeader('cache-control', 'no-store');
  if (url.pathname === '/sw.js') {
    response.setHeader('content-type', 'application/javascript');
    response.end(generation === 'old' ? legacyWorker :
      currentWorker.replace(`./offline_assets.js?v=${CACHE_VERSION}`, `./offline_assets.js?v=${generation}`));
  } else if (url.pathname === '/offline_assets.js') {
    const version = url.searchParams.get('v');
    response.setHeader('content-type', 'application/javascript');
    response.end(`export const CACHE_VERSION = '${version}';
      export const SHELL_URL = '/app-shell?v=${version}';
      export const COMPOSER_URL = '/new-shell?v=${version}';
      export const ABOUT_URL = '/about-shell?v=${version}';
      export const EDITOR_MANIFEST_URL = '/lib/codemirror/manifest.json';
      export const SHELL_ASSETS = ['/site.js?v=${version}', EDITOR_MANIFEST_URL];`);
  } else if (url.pathname === '/lib/codemirror/manifest.json') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ files: ['/lib/codemirror/editor.js'], precache: ['/lib/codemirror/editor.js'] }));
  } else if (url.pathname === '/lib/codemirror/editor.js') {
    response.setHeader('content-type', 'application/javascript');
    response.end('export const editor = true;');
  } else if (url.pathname === '/site.js') {
    response.setHeader('content-type', 'application/javascript');
    if (url.searchParams.get('v') === 'failed') { response.statusCode = 503; response.end('Unavailable'); return; }
    response.end(`document.body.dataset.scriptVersion = '${url.searchParams.get('v')}';
      navigator.serviceWorker.register('/sw.js', { type: 'module', updateViaCache: 'none' });`);
  } else {
    const version = url.pathname === '/app-shell' ? url.searchParams.get('v') : generation;
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><body data-shell-version="${version}">
      <h1>${version}</h1><textarea></textarea><script type="module" src="/site.js?v=${version}"></script>`);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext();
  await context.addInitScript(() => { window.documentToken = crypto.randomUUID(); });
  const page = await context.newPage();
  await page.goto(origin + '/CP000001#file-note.txt');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const initialToken = await page.evaluate(() => window.documentToken);
  // First install must not disturb the current document.
  assert.equal(await page.evaluate(() => window.documentToken), initialToken);
  await page.reload();
  assert.equal(await page.locator('body').getAttribute('data-shell-version'), 'old');
  const archive = await context.newPage();
  await archive.goto(origin + '/pastes?page=2');
  const about = await context.newPage();
  await about.goto(origin + '/about#service-providers');
  const editor = await context.newPage();
  await editor.goto(origin + '/');
  await editor.locator('textarea').fill('Unsaved draft');
  const editorToken = await editor.evaluate(() => window.documentToken);

  generation = 'failed';
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const finished = new Promise(resolve => registration.addEventListener('updatefound', () => {
      const candidate = registration.installing;
      candidate.addEventListener('statechange', () => {
        if (candidate.state === 'redundant') resolve();
      });
    }, { once: true }));
    await registration.update(); await finished;
  });
  await page.reload();
  assert.equal(await page.locator('body').getAttribute('data-shell-version'), 'old');
  assert.ok(await page.evaluate(() => caches.has('cp.codes.shell.old')));
  assert.equal(await page.evaluate(() => caches.has('cp.codes.shell.failed')), false);
  console.log('Incomplete update keeps the old working shell');

  generation = 'new';
  // Ordinary reload (no cache bypass) discovers and activates the update even
  // though both open public pages are still executing the legacy client script.
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.shellVersion === 'new' && document.body.dataset.scriptVersion === 'new');
  await archive.waitForFunction(() => document.body.dataset.shellVersion === 'new' && document.body.dataset.scriptVersion === 'new');
  await about.waitForFunction(() => document.body.dataset.shellVersion === 'new' && document.body.dataset.scriptVersion === 'new');
  assert.equal(page.url(), origin + '/CP000001#file-note.txt');
  assert.equal(archive.url(), origin + '/pastes?page=2');
  assert.equal(about.url(), origin + '/about#service-providers');
  assert.equal(await editor.evaluate(() => window.documentToken), editorToken);
  assert.equal(await editor.locator('textarea').inputValue(), 'Unsaved draft');
  assert.equal(await editor.evaluate(async () => (await fetch('/site.js?v=old')).text()),
    `document.body.dataset.scriptVersion = 'old';
      navigator.serviceWorker.register('/sw.js', { type: 'module', updateViaCache: 'none' });`);
  console.log('Normal refresh upgrades legacy paste/archive/about tabs and preserves editor drafts');

  const token = await page.evaluate(() => window.documentToken);
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  assert.equal(await page.evaluate(() => window.documentToken), token, 'unchanged worker must not reload again');
  await context.setOffline(true);
  const before = requests.length;
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.scriptVersion === 'new');
  assert.equal(await page.locator('body').getAttribute('data-shell-version'), 'new');
  assert.equal(requests.length, before, 'offline refresh must use the complete new local shell');
  console.log('Updated shell refreshes offline without network requests or reload loops');
  await context.close();
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
