// Capture the current UI with deterministic local data; no uploads or paid API calls.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/screenshot-matrix.mjs
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve(process.env.SCREENSHOT_OUTPUT || 'doc/design-review/2026-10-12');
await mkdir(resolve(output, 'screenshots'), { recursive: true });
await mkdir(resolve(output, 'viewports'), { recursive: true });
const compiled = await build({ entryPoints: ['src/ui.ts'], bundle: true, write: false, format: 'esm', plugins: [{
  name: 'workers-stub', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}' }));
  },
}] });
const ui = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const code = `// Fetch a paste and verify its contents.
export async function loadPaste(id) {
  const response = await fetch(\`/api/paste/\${id}\`);
  if (!response.ok) {
    throw new Error(\`Paste unavailable: \${response.status}\`);
  }

  const paste = await response.json();
  return {
    id: paste.id,
    filename: paste.filename ?? 'untitled.txt',
    bytes: paste.byte_length,
    createdAt: new Date(paste.created_at),
  };
}

const paste = await loadPaste('CP000101');
console.log(paste.filename, paste.bytes);
`;
const markdown = `# Project notes

A small document shared with the team. This sample exercises the typography, links, lists, table, and code styles used in the viewer.

## Release checklist

- Review the **mobile layout** and navigation.
- Check light and dark themes for readable contrast.
- Share the [JavaScript example](paste-client.js) with the team.

> Keep the document easy to scan. Good defaults should work on every screen.

## File overview

| File | Purpose | Status |
| --- | --- | --- |
| readme.md | Project notes | Ready |
| paste-client.js | API example | Review |

Use \`loadPaste(id)\` to request the document metadata.

\`\`\`javascript
const paste = await loadPaste('CP000101');
console.log(paste.filename, paste.bytes);
\`\`\`
`;
const files = [
  { name: 'readme.md', content_type: 'markdown', content: markdown },
  { name: 'paste-client.js', content_type: 'javascript', content: code },
];
const content = JSON.stringify({ format: 'bundle-v1', primary: 'readme.md', files });
const body = gzipSync(Buffer.from(content));
const hash = value => createHash('sha256').update(value).digest('hex');
const metadata = {
  id: 'CP000101', created_at: '2026-10-12T08:30:00Z', content_type: 'markdown',
  format: 'bundle-v1', primary: 'readme.md', filename: 'readme.md', unlisted: false,
  files: files.map(({ content, ...file }) => ({ ...file, byte_length: Buffer.byteLength(content), sha256: hash(content) })),
  byte_length: Buffer.byteLength(content), compressed_byte_length: body.length, content_encoding: 'gzip', sha256: hash(content),
};
const names = ['readme.md', 'paste-client.js', 'meeting-notes.md', 'settings.json', 'hello.py', 'release-checklist.md',
  'schema.sql', 'styles.css', 'quick-start.md', 'deploy.sh', 'example.html', 'notes.txt'];
const items = names.map((filename, index) => ({ id: `CP${String(101 + index).padStart(6, '0')}`, filename,
  content_type: index === 0 ? 'markdown' : 'plaintext', byte_length: index === 0 ? metadata.byte_length : 180 + index * 137,
  created_at: new Date(Date.parse('2026-10-12T08:30:00Z') - index * 720000).toISOString(), hit_count: [42, 18, 7, 12, 3, 24, 5, 9, 16, 2, 8, 1][index],
}));
const listing = { items, page: 1, page_size: 50, total: 62, total_pages: 2 };
const publicRoot = resolve('public');
const serverErrors = [];
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    if (path === '/' || path === '/new') {
      response.setHeader('content-type', 'text/html'); response.end(await ui.newPage().text());
    } else if (path === '/pastes') {
      response.setHeader('content-type', 'text/html'); response.end(await ui.pastesPage(listing).text());
    } else if (path === '/CP000101') {
      response.setHeader('content-type', 'text/html'); response.end(await ui.viewPage(metadata, 42).text());
    } else if (path === '/api/pow') {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ difficulty: 16 }));
    } else if (path === '/api/paste/CP000101/content') {
      response.setHeader('content-type', 'application/octet-stream');
      response.setHeader('x-content-encoding', 'gzip'); response.setHeader('x-hit-count', '42'); response.end(body);
    } else if (path === '/api/paste/CP000101') {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...metadata, hit_count: 42 }));
    } else if (path === '/api/pastes') {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(listing));
    } else if (extname(path) && !path.startsWith('/api/')) {
      const file = resolve(publicRoot, '.' + decodeURIComponent(path));
      if (!file.startsWith(publicRoot + '/')) throw new Error('Invalid asset path');
      response.setHeader('content-type', ({ '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream');
      response.end(await readFile(file));
    } else { response.statusCode = 404; response.end(); }
  } catch (error) {
    serverErrors.push(error.message); response.statusCode = 500; response.end(error.message);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const screens = [{ key: 'editor', name: 'Editor', path: '/' }, { key: 'list', name: 'Public paste list', path: '/pastes' },
  { key: 'viewer-markdown', name: 'Viewer · Markdown', path: '/CP000101' },
  { key: 'viewer-code', name: 'Viewer · Code', path: '/CP000101#file-paste-client.js' }];
const devices = [{ key: 'desktop', width: 1440, height: 1000 }, { key: 'mobile', width: 390, height: 844 }];
const captures = [], errors = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  for (const device of devices) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: device.width, height: device.height },
        deviceScaleFactor: 1, colorScheme: theme, isMobile: device.key === 'mobile', hasTouch: device.key === 'mobile',
        locale: 'en-US', timezoneId: 'Europe/Berlin', serviceWorkers: 'block' });
      await context.addInitScript(theme => localStorage.setItem('cp.codes.theme', theme), theme);
      for (const screen of screens) {
        const page = await context.newPage();
        const key = `${screen.key}-${device.key}-${theme}`;
        page.on('pageerror', error => errors.push({ key, message: error.message }));
        await page.goto(origin + screen.path, { waitUntil: 'networkidle' });
        if (screen.key === 'editor') {
          await page.locator('.cm-content').first().waitFor();
          await page.locator('.editor-filename').first().fill('paste-client.js');
          await page.locator('.cm-content').first().fill(code);
          await page.waitForFunction(() => document.querySelector('.cm-line span'));
          await page.waitForFunction(() => document.getElementById('proof-estimate').textContent.startsWith('Estimated'));
        } else if (screen.key.startsWith('viewer')) {
          await page.waitForFunction(() => document.getElementById('paste-content').getAttribute('aria-busy') === 'false');
          assert.equal(await page.locator('#paste-content [role="alert"]').count(), 0, await page.locator('#paste-content').innerText());
          if (screen.key === 'viewer-code') {
            await page.getByRole('tab', { name: 'paste-client.js', exact: true }).click();
            await page.waitForFunction(() => document.querySelector('#paste-content pre code')?.textContent.includes('export async'));
          } else {
            await page.locator('#paste-content h1').waitFor();
          }
          await page.locator('#paste-content code.hljs').first().waitFor({ timeout: 30000 });
        } else { assert.equal(await page.locator('.recent-list tbody tr').count(), names.length); }
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        await page.evaluate(async () => {
          document.activeElement?.blur(); window.scrollTo(0, 0);
          document.querySelectorAll('.cm-scroller').forEach(element => { element.scrollTop = 0; element.scrollLeft = 0; });
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const measurements = await page.evaluate(() => ({ pageWidth: document.documentElement.scrollWidth,
          pageHeight: document.documentElement.scrollHeight, innerWidth: window.innerWidth,
          title: document.title, selectedTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
        }));
        const screenshot = `screenshots/${key}.png`, viewport = `viewports/${key}.png`;
        await page.screenshot({ path: resolve(output, screenshot), fullPage: true, animations: 'disabled', caret: 'hide' });
        await page.screenshot({ path: resolve(output, viewport), animations: 'disabled', caret: 'hide' });
        captures.push({ key, screen: screen.key, label: screen.name, device: device.key, theme, width: device.width,
          height: device.height, screenshot, viewport, ...measurements });
        console.log(`Captured ${key}: ${device.width} × ${measurements.pageHeight}`);
        await page.close();
      }
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
assert.equal(captures.length, 16);
assert.deepEqual(errors, [], 'Browser rendering errors');
assert.deepEqual(serverErrors, [], 'Local asset errors');
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
const manifest = { capturedAt: new Date().toISOString(), browser: 'Chromium', browserVersion: browser.version(),
  gitHead: git(['rev-parse', 'HEAD']), workingTree: git(['status', '--short']),
  source: 'Current working tree, actual src/ui.ts templates and public assets, deterministic local data',
  notes: 'Full-page captures preserve below-fold content. Viewport captures preserve device proportions. Code highlighting loads the app’s normal pinned CDN modules. No production uploads.',
  captures, errors, serverErrors };
await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const columns = [ ['desktop', 'light'], ['desktop', 'dark'], ['mobile', 'light'], ['mobile', 'dark'] ];
const cards = screen => columns.map(([device, theme]) => {
  const capture = captures.find(item => item.screen === screen.key && item.device === device && item.theme === theme);
  return `<article class="capture" data-device="${device}" data-theme="${theme}"><div class="caption"><strong>${device} · ${theme}</strong><span>${capture.width} × ${capture.height}</span></div><button class="preview" data-key="${capture.key}" aria-label="Open ${screen.name}, ${device}, ${theme}"><img src="${capture.viewport}" alt="${screen.name} — ${device}, ${theme}" loading="lazy"></button><div class="links"><a href="${capture.screenshot}" target="_blank">Full page ↗</a><a href="${capture.screenshot}" download>Download PNG</a></div></article>`;
}).join('');
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>cp.codes · Design review matrix</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#edf0f4;color:#18202c;font:15px/1.5 system-ui,sans-serif}main{max-width:1900px;margin:auto;padding:32px}h1{font-size:32px;margin:0 0 8px}h2{font-size:20px;margin:32px 0 12px}p{margin:8px 0;color:#526071}a{color:#2459a3}header{margin-bottom:24px}.controls{display:flex;flex-wrap:wrap;gap:16px;margin-top:20px;align-items:center}select,button{font:inherit}select{padding:7px;background:white;border:1px solid #bcc5d0;border-radius:6px}.matrix{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.capture{border:1px solid #ccd3dd;border-radius:9px;overflow:hidden;background:white}.caption{display:flex;justify-content:space-between;gap:6px;padding:10px 14px;border-bottom:1px solid #dde2e9;font-size:13px;text-transform:capitalize}.caption span{color:#627084}.preview{width:100%;height:420px;display:flex;align-items:flex-start;justify-content:center;border:0;padding:0;overflow:hidden;background:#dfe4eb;cursor:zoom-in}.preview img{display:block;max-width:100%;max-height:100%;width:auto;height:auto}.capture[data-device="desktop"] .preview img{width:100%;max-height:none}.full .preview{height:560px}.full .preview img{max-height:100%}.full .capture[data-device="desktop"] .preview img{max-height:100%;width:auto}.links{display:flex;justify-content:space-between;padding:10px 14px;font-size:13px}dialog{border:0;border-radius:10px;max-width:96vw;width:1550px;max-height:95vh;padding:0;background:#edf0f4}dialog::backdrop{background:#111a}dialog .bar{position:sticky;top:0;display:flex;justify-content:space-between;gap:12px;padding:12px 16px;background:white;border-bottom:1px solid #ccd3dd}dialog img{display:block;max-width:100%;margin:auto}dialog button{border:1px solid #bcc5d0;border-radius:5px;padding:4px 10px;background:white;cursor:pointer}body:has(dialog[open]){overflow:hidden}[hidden]{display:none!important}@media(max-width:1000px){.matrix{grid-template-columns:repeat(2,minmax(0,1fr))}main{padding:20px}}@media(max-width:550px){.matrix{grid-template-columns:1fr}.caption{font-size:14px}h1{font-size:26px}}
</style><main><header><h1>cp.codes / Design review</h1><p>16 combinations · 4 screens × 2 themes × 2 devices · 12 October 2026</p><p>Desktop 1440 × 1000 · Mobile 390 × 844 · Current working tree with consistent sample data</p><div class="controls"><label>Device <select id="device"><option value="all">Both devices</option><option>desktop</option><option>mobile</option></select></label><label>Theme <select id="theme"><option value="all">Both themes</option><option>light</option><option>dark</option></select></label><label>Capture <select id="mode"><option value="viewport">Viewport</option><option value="full">Full page</option></select></label><a href="matrix.png" target="_blank">PNG overview ↗</a><a href="manifest.json">Capture details</a></div></header>
${screens.map(screen => `<section><h2>${screen.name}</h2><div class="matrix">${cards(screen)}</div></section>`).join('')}
<p>Click a screenshot to inspect it. Full-page images include all content below the fold. Mobile captures use Chromium touch and mobile viewport emulation at 1× pixel density.</p></main><dialog id="zoom"><div class="bar"><strong id="zoom-label"></strong><span><a id="zoom-download" download>Download PNG</a> <button id="close">Close ×</button></span></div><img id="zoom-image" alt=""></dialog><script>
const captures=${JSON.stringify(captures)};const dialog=document.querySelector('#zoom');
function refresh(){const device=document.querySelector('#device').value,theme=document.querySelector('#theme').value,full=document.querySelector('#mode').value==='full';document.body.classList.toggle('full',full);document.querySelectorAll('.capture').forEach(card=>{card.hidden=(device!=='all'&&card.dataset.device!==device)||(theme!=='all'&&card.dataset.theme!==theme);const c=captures.find(c=>c.key===card.querySelector('button').dataset.key);card.querySelector('img').src=full?c.screenshot:c.viewport})}
document.querySelectorAll('select').forEach(s=>s.addEventListener('change',refresh));document.querySelectorAll('.preview').forEach(b=>b.addEventListener('click',()=>{const c=captures.find(c=>c.key===b.dataset.key);document.querySelector('#zoom-label').textContent=c.label+' · '+c.device+' · '+c.theme;document.querySelector('#zoom-image').src=document.querySelector('#mode').value==='full'?c.screenshot:c.viewport;document.querySelector('#zoom-image').alt=document.querySelector('#zoom-label').textContent;document.querySelector('#zoom-download').href=c.screenshot;dialog.showModal()}));document.querySelector('#close').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close()});
</script></html>`;
await writeFile(resolve(output, 'index.html'), html);
await writeFile(resolve(output, 'README.md'), `# cp.codes screenshot matrix\n\nCaptured from the current working tree on 12 October 2026 using actual app templates and browser assets with deterministic local sample pastes.\n\n- Open index.html for the filterable 16-cell review gallery and image zoom.\n- matrix.png is the viewport contact sheet.\n- screenshots/ contains all 16 full-page PNGs.\n- viewports/ contains the same 16 combinations at exact viewport sizes.\n- manifest.json records dimensions, source revision, and rendering checks.\n\nDesktop: 1440 × 1000. Mobile: 390 × 844. Chromium, device pixel ratio 1, Europe/Berlin timezone. Mobile is touch/viewport emulation. The editor contains JavaScript; the viewers display the Markdown and JavaScript tabs of one two-file paste. The public list contains sample data and pagination.\n\nRecreate from the repository root:\n\n\`\`\`sh\nPLAYWRIGHT_MODULE=/tmp/cp-browser/node_modules/playwright/index.mjs node scripts/screenshot-matrix.mjs\npython3 scripts/screenshot-matrix.py doc/design-review/2026-10-12\n\`\`\`\n`);
console.log(`Saved 16 screenshots, viewport variants, gallery, and manifest to ${output}`);
