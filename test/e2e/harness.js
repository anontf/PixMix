// Real-browser test harness: a static server for bundles, fixtures and pages, and a
// Chromium launcher. Chromium comes from Playwright (`npx playwright install chromium`);
// if the host lacks its shared libraries, either install them system-wide
// (`sudo npx playwright install-deps`) or point PIXMIX_BROWSER_LIBS at a directory holding
// them (added to LD_LIBRARY_PATH).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = new URL('../..', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jxl': 'image/jxl',
};

/**
 * Serves /dist/* from the build, plus in-memory files: files.set('/x.png', bytes).
 * @param {{cors?: boolean, headers?: Record<string, string>}} [opts]
 */
export async function startServer({ cors = false, headers = {} } = {}) {
  const files = new Map();
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let body = files.get(path);
    if (!body && path.startsWith('/dist/')) {
      const file = normalize(join(ROOT, path));
      if (file.startsWith(join(ROOT, 'dist'))) body = await readFile(file).catch(() => null);
    }
    const extra = { ...headers, ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}) };
    if (!body) { res.writeHead(404, extra); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, files, close: () => new Promise((r) => server.close(r)) };
}

export async function launch() {
  const libs = process.env.PIXMIX_BROWSER_LIBS;
  const env = libs ? { ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } : process.env;
  return chromium.launch({ env });
}

/** A page that records console errors and uncaught exceptions. */
export async function openPage(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const workers = [];
  page.on('worker', (w) => workers.push(w.url()));
  return { page, errors, workers };
}

/** Waits for an <img data-pixmix> to finish, returns its state and the bytes it now shows. */
export async function revealed(page, selector = 'img') {
  await page.waitForFunction((s) => {
    const el = document.querySelector(s);
    return el && ['done', 'error'].includes(el.dataset.pixmixState);
  }, selector, { timeout: 60000 });
  return page.evaluate(async (s) => {
    const el = document.querySelector(s);
    const bytes = new Uint8Array(await (await fetch(el.src)).arrayBuffer());
    return { state: el.dataset.pixmixState, src: el.src, bytes: Array.from(bytes), natural: [el.naturalWidth, el.naturalHeight] };
  }, selector);
}

/** RGBA the browser renders for an image URL (first frame for animations). */
export function rendered(page, url) {
  return page.evaluate(async (u) => {
    const im = new Image();
    im.src = u;
    await im.decode();
    const c = document.createElement('canvas');
    c.width = im.naturalWidth;
    c.height = im.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0);
    return Array.from(g.getImageData(0, 0, c.width, c.height).data);
  }, url);
}

export const decoderPage = ({ src, effect = 'dissolve', duration = 300, extra = '', script = '/dist/pixmix-decoder.min.js', key = 'k' }) => `<!doctype html>
<meta charset="utf-8"><body>
<img data-pixmix src="${src}" alt="t" style="width:200px">
<script src="${script}" data-key="${key}" data-effect="${effect}" data-duration="${duration}" ${extra}></script>
</body>`;
