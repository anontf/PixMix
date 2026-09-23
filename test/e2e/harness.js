// Real-browser test harness: a static server for bundles, fixtures and pages, and
// launchers for the engines Playwright ships (`npx playwright install chromium webkit`).
// PIXMIX_BROWSERS picks the engines (default: all); the ones that can't start are skipped.
// If the host lacks their shared libraries, either install them system-wide
// (`sudo npx playwright install-deps`) or point PIXMIX_BROWSER_LIBS at directories holding
// them (colon-separated, added to LD_LIBRARY_PATH).

import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, access } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import * as playwright from 'playwright';

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

export const ENGINES = ['chromium', 'webkit', 'firefox'];

/** @param {string} engine */
export async function launch(engine = 'chromium') {
  const libs = process.env.PIXMIX_BROWSER_LIBS;
  const env = libs ? { ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } : process.env;
  // Playwright's dependency check ignores our libraries; a missing one fails the launch.
  if (libs) process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS ??= '1';
  if (engine === 'webkit' && libs) return playwright.webkit.launch({ env: await webkitEnv(env, libs), executablePath: await webkitLauncher(libs) });
  return playwright[engine].launch({ env });
}

// Playwright's WebKit wrapper resets LD_LIBRARY_PATH, so run a copy that appends ours.
let launcher;
function webkitLauncher(libs) {
  launcher ??= (async () => {
    const dir = join(dirname(playwright.webkit.executablePath()), 'minibrowser-wpe');
    const sh = (await readFile(join(dir, 'MiniBrowser'), 'utf8'))
      .replace(/^MYDIR=.*$/m, `MYDIR=${JSON.stringify(dir)}\nexport WEBKIT_FORCE_COMPLEX_TEXT=1`)
      .replace(/^(export LD_LIBRARY_PATH=".*)"$/m, (_, head) => `${head}:${libs}"`);
    if (!sh.includes(libs)) throw new Error('unexpected WebKit wrapper; install its dependencies system-wide');
    const tmp = await mkdtemp(join(tmpdir(), 'pixmix-webkit-'));
    process.once('exit', () => rmSync(tmp, { recursive: true, force: true }));
    const file = join(tmp, 'MiniBrowser');
    await writeFile(file, sh, { mode: 0o755 });
    return file;
  })();
  return launcher;
}

// Unpacked libraries that WebKit loads as plugins need their own search paths: glvnd's EGL
// vendor file (for Mesa) and GStreamer's plugins, which WebKit also uses to decode images.
const PLUGIN_PATHS = { __EGL_VENDOR_LIBRARY_DIRS: '../../share/glvnd/egl_vendor.d', GST_PLUGIN_PATH: 'gstreamer-1.0' };
async function webkitEnv(env, libs) {
  const out = { ...env };
  for (const [name, rel] of Object.entries(PLUGIN_PATHS)) {
    const dirs = [];
    for (const lib of libs.split(':')) {
      const d = join(lib, rel);
      if (await access(d).then(() => true, () => false)) dirs.push(d);
    }
    if (dirs.length) out[name] = [...dirs, env[name]].filter(Boolean).join(':');
  }
  return out;
}

/**
 * The engines to test (PIXMIX_BROWSERS, default all), each with a skip reason if it can't
 * launch here. For `describe(name, { skip }, …)`.
 * @returns {Promise<{name: string, skip: string|false}[]>}
 */
export async function engines() {
  const names = (process.env.PIXMIX_BROWSERS ?? ENGINES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const name of names) {
    if (!ENGINES.includes(name)) throw new Error(`PIXMIX_BROWSERS: unknown engine ${name}`);
    const skip = await launch(name).then((b) => b.close().then(() => false), (e) => `${name} can't launch: ${launchError(e)}`);
    if (skip) console.log(`# skipping ${skip}`);
    out.push({ name, skip });
  }
  return out;
}

// The browser's own complaint (its last stderr lines), else Playwright's first lines.
function launchError(e) {
  const lines = String(e?.message ?? e).replace(/\x1b\[\d+m/g, '').split('\n').map((l) => l.replace(/[║╔╗╚╝═]/g, '').trim()).filter(Boolean);
  const err = lines.filter((l) => l.includes('[err]')).map((l) => l.replace(/^.*\[err\]\s*/, ''));
  return (err.length ? err.slice(-2) : lines.slice(0, 3)).join(' ');
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
