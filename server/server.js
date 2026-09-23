// Development server: a lab page for encoding/decoding, and a mock "website" that serves
// scrambled images and reveals them in the browser. Uses the built encoder bundle, the
// way a real image server would embed it.
//
//   npm run serve        (builds dist/ first)   ->  http://localhost:8080

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodeAsync, rekey, inspect, sharpDecoder, PixmixError } from '../dist/pixmix-encoder.mjs';
import { decode } from '../src/decoder.js';

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = new URL('..', import.meta.url).pathname;
const MAX_BODY = 64 * 1024 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.map': 'application/json' };

// sharp is optional: with it the server also accepts WebP, AVIF, HEIC and TIFF uploads.
const sharp = await import('sharp').then((m) => m.default, () => null);
const decoders = sharp ? [sharpDecoder(sharp, { formats: ['webp', 'avif', 'heic', 'tiff', 'jxl'] })] : [];

/** In-memory "CDN" for the demo site: id -> {bytes, key, name, effect}. */
const gallery = new Map();

const routes = {
  // Any supported input; the X-Pixmix-Convert header reports what happened to it.
  'POST /api/encode': async (req, q) => {
    let report;
    const out = await encodeAsync(await body(req), {
      key: q.get('key'),
      mode: q.get('mode') || 'pixel',
      block: q.has('block') ? Number(q.get('block')) : undefined,
      level: q.has('level') ? Number(q.get('level')) : undefined,
      format: q.get('format') || undefined,
      decoders,
      onConvert: (r) => { report = r; },
    });
    const { png: _, ...info } = report;
    return { ...png(out), headers: { 'X-Pixmix-Convert': JSON.stringify(info) } };
  },
  'POST /api/decode': async (req, q) => png(decode(await body(req), { key: q.get('key') })),
  'POST /api/rekey': async (req, q) => png(rekey(await body(req), {
    from: q.get('from'),
    to: q.get('to'),
    mode: q.get('mode') || undefined,
    block: q.has('block') ? Number(q.get('block')) : undefined,
  })),
  'POST /api/inspect': async (req) => json(inspect(await body(req))),

  // Stores an already-scrambled image for the demo site.
  'POST /api/gallery': async (req, q) => {
    const bytes = await body(req);
    const info = inspect(bytes);
    if (!info.scrambled) throw new PixmixError('Only scrambled images can be published', 'NOT_SCRAMBLED');
    const id = randomUUID().slice(0, 8);
    gallery.set(id, { bytes, key: q.get('key'), name: q.get('name') || id, effect: q.get('effect') || 'dissolve' });
    return json({ id, url: `/images/${id}.png` }, 201);
  },
  'GET /api/gallery': async () => json([...gallery].map(([id, g]) => ({
    id, url: `/images/${id}.png`, key: g.key, name: g.name, effect: g.effect, ...pick(inspect(g.bytes)),
  }))),
  'DELETE /api/gallery': async () => { gallery.clear(); return json({ ok: true }); },
};

const pick = ({ width, height, mode, block }) => ({ width, height, mode, block });

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const route = routes[`${req.method} ${url.pathname}`];
    let out;
    if (route) out = await route(req, url.searchParams);
    else if (req.method === 'GET') out = await staticFile(url.pathname);
    else out = json({ error: 'Not found' }, 404);
    send(res, out);
  } catch (err) {
    const status = err.code === 'WRONG_KEY' ? 403 : err instanceof PixmixError ? 400 : err.status || 500;
    if (status === 500) console.error(err);
    send(res, json({ error: err.message, code: err.code }, status));
  }
}).listen(PORT, HOST, () => console.log(`pixmix dev server on http://${HOST}:${PORT}${sharp ? ' (sharp: on)' : ''}`));

async function staticFile(pathname) {
  const img = pathname.match(/^\/images\/([\w-]+)\.png$/);
  if (img) {
    const g = gallery.get(img[1]);
    return g ? png(g.bytes) : json({ error: 'Not found' }, 404);
  }
  if (pathname === '/') pathname = '/index.html';
  const base = pathname.startsWith('/dist/') ? ROOT : join(ROOT, 'server/public');
  const file = normalize(join(base, pathname));
  if (!file.startsWith(base)) return json({ error: 'Not found' }, 404);
  try {
    return { status: 200, type: TYPES[extname(file)] || 'application/octet-stream', data: await readFile(file), cache: 'no-cache' };
  } catch {
    return json({ error: 'Not found' }, 404);
  }
}

function body(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); }
      else parts.push(c);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(parts))));
    req.on('error', reject);
  });
}

const png = (data) => ({ status: 200, type: 'image/png', data, cache: 'no-store' });
const json = (obj, status = 200) => ({ status, type: 'application/json', data: JSON.stringify(obj) });

function send(res, { status, type, data, cache = 'no-store', headers = {} }) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': Buffer.byteLength(data), ...headers });
  res.end(data);
}
