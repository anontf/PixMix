// Development server: a lab page for encoding/decoding, and a mock "website" that serves
// scrambled images and reveals them in the browser. Uses the built encoder bundle, the
// way a real image server would embed it.
//
//   npm run serve        (builds dist/ first)   ->  http://localhost:8080
//
// Watermarks live in the repository's watermarks/ directory ($PIXMIX_WATERMARKS_DIR
// overrides it): the lab edits them through /api/watermarks, and decoders fetch the compiled
// ones from /watermarks/<id>.json. Metadata profiles live in metadata-profiles/
// ($PIXMIX_METADATA_PROFILES_DIR), edited through /api/metadata-profiles.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodeAsync, rekeyAsync, inspect, detectFormat, sharpDecoder, PixmixError } from '../dist/pixmix-encoder.mjs';
import { decodeAsync } from '../src/decoder.js';
import { watermarkStore } from '../src/watermark/store.js';
import { ID_PATTERN, normalizeDefinition } from '../src/watermark/schema.js';
import { metadataProfileStore } from '../src/meta/profiles.js';
import { normalizePolicy, PROFILE_ID, PRESET_NAMES, KINDS, GROUPS } from '../src/meta/policy.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080; // 0 = any free port
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = new URL('..', import.meta.url).pathname;
const MAX_BODY = 64 * 1024 * 1024;
const MAX_JSON = 256 * 1024;
// Uploads are untrusted: every call gets pixmix's resource limits (the defaults, with the
// upload size as the input limit). PIXMIX_MAX_PIXELS and PIXMIX_MAX_FRAMES override two.
const LIMITS = {
  maxInputBytes: MAX_BODY,
  ...(process.env.PIXMIX_MAX_PIXELS ? { maxPixels: Number(process.env.PIXMIX_MAX_PIXELS) } : {}),
  ...(process.env.PIXMIX_MAX_FRAMES ? { maxFrames: Number(process.env.PIXMIX_MAX_FRAMES) } : {}),
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.map': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const IMAGE = { png: ['image/png', 'png'], jpeg: ['image/jpeg', 'jpg'], jxl: ['image/jxl', 'jxl'] };

// sharp is optional: with it the server also accepts WebP, AVIF, HEIC and TIFF uploads.
const sharp = await import('sharp').then((m) => m.default, () => null);
const decoders = sharp ? [sharpDecoder(sharp, { formats: ['webp', 'avif', 'heic', 'tiff', 'jxl'] })] : [];

/** In-memory "CDN" for the demo site: id -> {bytes, key, name, effect}. */
const gallery = new Map();

const watermarks = watermarkStore();
const profiles = metadataProfileStore();
const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * The ?metadata= parameter: a preset name or a profile id, as the policy to pass on (the
 * profile object itself: the encoder bundle validates it again), or undefined.
 */
async function storedPolicy(ref) {
  if (!ref) return undefined;
  if (PRESET_NAMES.includes(ref)) return ref;
  if (!PROFILE_ID.test(ref)) throw httpError(400, `Invalid metadata profile id "${ref}"`);
  const profile = await profiles.get(ref);
  normalizePolicy(profile);
  return profile;
}

// Reports go in response headers: JSON with anything outside ASCII escaped.
const headerJson = (obj) => JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** The ?watermark= style parameter: an id in the store, or null. */
async function storedWatermark(id) {
  if (!id) return null;
  if (!ID_PATTERN.test(id)) throw httpError(400, `Invalid watermark id "${id}"`);
  return watermarks.compiled(id);
}

const routes = {
  // Any supported input; the X-Pixmix-Convert header reports what happened to it.
  'POST /api/encode': async (req, q) => {
    let report;
    const num = (k) => (q.has(k) ? Number(q.get(k)) : undefined);
    const out = await encodeAsync(await body(req), {
      key: q.get('key'),
      mode: q.get('mode') || undefined,
      block: num('block'),
      level: num('level'),
      effort: num('effort'),
      format: q.get('format') || undefined,
      quality: num('quality'),
      transforms: q.get('transforms') !== '0',
      decoders,
      limits: LIMITS,
      onConvert: (r) => { report = r; },
      // watermark: carried for the decoder (whole, or just its id with watermarkEmbed=id);
      // visibleWatermark: drawn on the scrambled image.
      watermark: q.get('watermarkEmbed') === 'id' && q.get('watermark') ? { id: q.get('watermark') } : await storedWatermark(q.get('watermark')),
      visibleWatermark: await storedWatermark(q.get('visibleWatermark')),
      // ?metadata=<preset or profile id>: the scrambled file's metadata.
      metadata: await storedPolicy(q.get('metadata')),
    });
    const { bytes: _, ...info } = report;
    return { ...image(out), headers: { 'X-Pixmix-Convert': headerJson(info) } };
  },
  // ?watermark=<id> draws that watermark on the result, ?watermark=embedded the file's own;
  // ?metadata= sets the restored file's metadata (X-Pixmix-Metadata reports what changed).
  'POST /api/decode': async (req, q) => {
    const wm = q.get('watermark');
    let meta = null;
    const out = await decodeAsync(await body(req), {
      key: q.get('key'),
      limits: LIMITS,
      watermark: wm === 'embedded' ? 'embedded' : await storedWatermark(wm),
      resolveWatermark: (id) => storedWatermark(id),
      metadata: await storedPolicy(q.get('metadata')),
      onMetadata: (r) => { meta = r; },
    });
    return { ...image(out), headers: meta ? { 'X-Pixmix-Metadata': headerJson(meta) } : {} };
  },
  'POST /api/rekey': async (req, q) => {
    let meta = null;
    const out = await rekeyAsync(await body(req), {
      from: q.get('from'),
      to: q.get('to'),
      mode: q.get('mode') || undefined,
      block: q.has('block') ? Number(q.get('block')) : undefined,
      transforms: q.has('transforms') ? q.get('transforms') !== '0' : undefined,
      limits: LIMITS,
      metadata: await storedPolicy(q.get('metadata')),
      onMetadata: (r) => { meta = r; },
    });
    return { ...image(out), headers: meta ? { 'X-Pixmix-Metadata': headerJson(meta) } : {} };
  },
  // ?metadata=1 adds the parsed metadata (EXIF tags, XMP properties, ICC, text, …).
  'POST /api/inspect': async (req, q) => json(inspect(await body(req), { limits: LIMITS, metadata: q.get('metadata') === '1' })),

  // Stores an already-scrambled image for the demo site.
  'POST /api/gallery': async (req, q) => {
    const bytes = await body(req);
    const info = inspect(bytes, { limits: LIMITS });
    if (!info.scrambled) throw new PixmixError('Only scrambled images can be published', 'NOT_SCRAMBLED');
    const id = randomUUID().slice(0, 8);
    gallery.set(id, { bytes, key: q.get('key'), name: q.get('name') || id, effect: q.get('effect') || 'dissolve', watermark: q.get('watermark') || '' });
    return json({ id, url: urlFor(id, bytes) }, 201);
  },
  'GET /api/gallery': async () => json([...gallery].map(([id, g]) => ({
    id, url: urlFor(id, g.bytes), key: g.key, name: g.name, effect: g.effect, watermark: g.watermark, ...pick(inspect(g.bytes)),
  }))),
  'DELETE /api/gallery': async () => { gallery.clear(); return json({ ok: true }); },

  // Watermark definitions, saved to the watermarks/ directory (and compiled next to it).
  'GET /api/watermarks': async () => json({
    watermarks: await watermarks.list(), fonts: await watermarks.fonts(), assets: await watermarks.assets(),
  }),
  'POST /api/watermarks': async (req) => {
    const def = await jsonBody(req);
    if (ID_PATTERN.test(def?.id) && (await watermarks.exists(def.id))) throw httpError(409, `Watermark "${def.id}" already exists`);
    return json(await watermarks.save(def), 201);
  },
  // Compiles without saving, for the lab's live preview.
  // (and gives the definition back normalised, defaults filled in).
  'POST /api/watermarks/preview': async (req) => {
    const definition = normalizeDefinition(await jsonBody(req));
    return json({ definition, compiled: watermarks.compile(definition) });
  },

  // Metadata profiles, saved to the metadata-profiles/ directory.
  'GET /api/metadata-profiles': async () => json({ profiles: await profiles.list(), presets: PRESET_NAMES, kinds: KINDS, groups: GROUPS }),
  'POST /api/metadata-profiles': async (req) => {
    const profile = await jsonBody(req);
    if (PROFILE_ID.test(profile?.id) && (await profiles.exists(profile.id))) throw httpError(409, `Metadata profile "${profile.id}" already exists`);
    return json(await profiles.save(profile), 201);
  },
};

/** /api/metadata-profiles/<id>: read, create or replace, delete. */
const profileRoutes = {
  GET: async (id) => json(await profiles.get(id)),
  PUT: async (id, req) => {
    const profile = await jsonBody(req);
    if (profile?.id !== id) throw httpError(400, 'The profile\'s id must match the URL');
    const created = !(await profiles.exists(id));
    return json(await profiles.save(profile), created ? 201 : 200);
  },
  DELETE: async (id) => { await profiles.remove(id); return json({ ok: true }); },
};

/** /api/watermarks/<id>: read, create or replace, delete. */
const watermarkRoutes = {
  GET: async (id) => json({ definition: await watermarks.get(id), compiled: await watermarks.compiled(id) }),
  PUT: async (id, req) => {
    const def = await jsonBody(req);
    if (def?.id !== id) throw httpError(400, 'The definition\'s id must match the URL');
    const created = !(await watermarks.exists(id));
    return json(await watermarks.save(def), created ? 201 : 200);
  },
  DELETE: async (id) => { await watermarks.remove(id); return json({ ok: true }); },
};

const pick = ({ format, width, height, mode, block, watermark, visibleWatermark }) => ({
  format, width, height, mode, block, carries: watermark?.id ?? null, visibleWatermark,
});
const urlFor = (id, bytes) => `/images/${id}.${IMAGE[detectFormat(bytes)][1]}`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const route = routes[`${req.method} ${url.pathname}`];
    const wm = /^\/api\/watermarks\/([^/]+)$/.exec(url.pathname);
    const mp = /^\/api\/metadata-profiles\/([^/]+)$/.exec(url.pathname);
    let out;
    if (route) out = await route(req, url.searchParams);
    else if (wm && watermarkRoutes[req.method]) {
      if (!ID_PATTERN.test(wm[1])) throw httpError(400, 'Invalid watermark id');
      out = await watermarkRoutes[req.method](wm[1], req);
    } else if (mp && profileRoutes[req.method]) {
      if (!PROFILE_ID.test(mp[1])) throw httpError(400, 'Invalid metadata profile id');
      out = await profileRoutes[req.method](mp[1], req);
    } else if (req.method === 'GET') out = await staticFile(url.pathname);
    else out = json({ error: 'Not found' }, 404);
    send(res, out);
  } catch (err) {
    // PixmixErrors come from the bundle and from src/ (two classes): go by name.
    const pixmix = err instanceof PixmixError || err?.name === 'PixmixError' || err?.name === 'WrongKeyError';
    const status = err.status || (err.code === 'WRONG_KEY' ? 403 : err.code === 'LIMIT' ? 413 : pixmix ? 400 : 500);
    if (status === 500) console.error(err);
    send(res, json({ error: err.message, code: err.code }, status));
  }
});
server.listen(PORT, HOST, () => console.log(`pixmix dev server on http://${HOST}:${server.address().port}${sharp ? ' (sharp: on)' : ''}`));

async function staticFile(pathname) {
  const img = pathname.match(/^\/images\/([\w-]+)\.(png|jpg|jxl)$/);
  if (img) {
    const g = gallery.get(img[1]);
    return g ? image(g.bytes) : json({ error: 'Not found' }, 404);
  }
  const wm = pathname.match(/^\/watermarks\/([a-z0-9-]+)\.(json|svg)$/);
  if (wm) {
    if (!ID_PATTERN.test(wm[1]) || !(await watermarks.exists(wm[1]))) return json({ error: 'Not found' }, 404);
    if (wm[2] === 'json') return { status: 200, type: 'application/json', data: JSON.stringify(await watermarks.compiled(wm[1])), cache: 'no-cache' };
    const { watermarkToSvg } = await import('../src/watermark/compile.js');
    return { status: 200, type: TYPES['.svg'], data: watermarkToSvg(await watermarks.compiled(wm[1])), cache: 'no-cache' };
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

function body(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); }
      else parts.push(c);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(parts))));
    req.on('error', reject);
  });
}

/** A JSON request body (small), parsed. */
async function jsonBody(req) {
  const bytes = await body(req, MAX_JSON);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw httpError(400, 'The body is not valid JSON');
  }
}

const image = (data) => ({ status: 200, type: IMAGE[detectFormat(data)][0], data, cache: 'no-store' });
const json = (obj, status = 200) => ({ status, type: 'application/json', data: JSON.stringify(obj) });

function send(res, { status, type, data, cache = 'no-store', headers = {} }) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': Buffer.byteLength(data), ...headers });
  res.end(data);
}
