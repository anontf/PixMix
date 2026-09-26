// The dev server's watermark API (and the watermark options of encode/decode), against a
// copy of the watermarks directory. The server uses the built encoder: after `npm run build`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { inspect, decodeAsync } from '../src/index.js';
import { readPng } from '../src/formats/png/index.js';

const ROOT = new URL('..', import.meta.url).pathname;
const built = existsSync(join(ROOT, 'dist/pixmix-encoder.mjs'));
const skip = built ? false : 'needs dist/ (npm run build)';
let proc, base, dir, profilesDir;

before(async () => {
  if (!built) return;
  dir = mkdtempSync(join(tmpdir(), 'pixmix-server-'));
  cpSync(join(ROOT, 'watermarks'), dir, { recursive: true });
  profilesDir = mkdtempSync(join(tmpdir(), 'pixmix-server-profiles-'));
  cpSync(join(ROOT, 'metadata-profiles'), profilesDir, { recursive: true });
  proc = spawn(process.execPath, [join(ROOT, 'server/server.js')], {
    env: { ...process.env, PORT: '0', PIXMIX_WATERMARKS_DIR: dir, PIXMIX_METADATA_PROFILES_DIR: profilesDir }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { const m = /http:\/\/[\d.]+:\d+/.exec(String(d)); if (m) resolve(m[0]); });
    proc.on('exit', (c) => reject(new Error(`server exited (${c})`)));
  });
});
after(() => {
  proc?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (profilesDir) rmSync(profilesDir, { recursive: true, force: true });
});

const call = async (path, { method = 'GET', body, json = true } = {}) => {
  const res = await fetch(base + path, { method, body: body && (body instanceof Uint8Array ? body : JSON.stringify(body)) });
  return { status: res.status, body: json ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
};

test('watermark API: list, read, create, update, preview, delete', { skip }, async () => {
  let r = await call('/api/watermarks');
  assert.deepEqual(r.body.watermarks.map((w) => w.id), ['vivi-gold', 'vivi-pixel', 'vivi-window']);
  assert.ok(r.body.fonts.includes('PressStart2P-Regular'));
  r = await call('/api/watermarks/vivi-gold');
  assert.equal(r.body.definition.font, 'CinzelDecorative-Bold');
  assert.equal(r.body.compiled.format, 'pixmix-watermark');
  r = await call('/watermarks/vivi-gold.json');
  assert.deepEqual(r.body, JSON.parse(readFileSync(join(ROOT, 'watermarks/compiled/vivi-gold.json'), 'utf8')), 'what decoders fetch');

  const def = { id: 'api-test', text: 'Vivi', font: 'PixelifySans', fill: '#ff0000' };
  r = await call('/api/watermarks/preview', { method: 'POST', body: def });
  assert.equal(r.status, 200);
  assert.equal(r.body.definition.anchor, 'bottom-right', 'normalised');
  assert.equal(existsSync(join(dir, 'api-test.json')), false, 'preview does not save');
  r = await call('/api/watermarks', { method: 'POST', body: def });
  assert.equal(r.status, 201);
  assert.ok(existsSync(join(dir, 'api-test.json')) && existsSync(join(dir, 'compiled/api-test.json')) && existsSync(join(dir, 'compiled/api-test.svg')));
  assert.equal((await call('/api/watermarks', { method: 'POST', body: def })).status, 409);
  r = await call('/api/watermarks/api-test', { method: 'PUT', body: { ...def, text: 'Vivi!' } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(readFileSync(join(dir, 'api-test.json'), 'utf8')).text, 'Vivi!');
  assert.equal((await call('/api/watermarks/api-test', { method: 'PUT', body: { ...def, id: 'other' } })).status, 400);
  assert.equal((await call('/api/watermarks/api-test', { method: 'DELETE' })).status, 200);
  assert.equal(existsSync(join(dir, 'api-test.json')), false);
  assert.equal((await call('/api/watermarks/api-test')).status, 404);
});

test('watermark API: strict input, no way out of the directory', { skip }, async () => {
  for (const path of ['/api/watermarks/..%2F..%2Fpackage', '/api/watermarks/A', '/api/watermarks/a.json', '/api/watermarks/%2e%2e']) {
    // 400, or 404 where URL parsing already resolved the dots away.
    assert.ok([400, 404].includes((await call(path)).status), path);
    assert.ok([400, 404].includes((await call(path, { method: 'PUT', body: { id: 'x', text: 'x', font: 'PixelifySans' } })).status), path);
  }
  assert.equal((await call('/watermarks/..%2Fpackage.json')).status, 404);
  assert.equal((await call('/watermarks/nope.json')).status, 404);
  const bad = [
    { id: 'x', text: 'x', font: '../../package' }, { id: 'x', text: 'x', font: 'PixelifySans', extra: 1 },
    { id: 'x', text: 'x', font: 'PixelifySans', size: { relative: 99 } }, { id: 'x', text: 'x', font: 'Nope' },
  ];
  for (const body of bad) {
    const r = await call('/api/watermarks', { method: 'POST', body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.body.error);
  }
  const res = await fetch(`${base}/api/watermarks`, { method: 'POST', body: '{not json' });
  assert.equal(res.status, 400);
  const big = await fetch(`${base}/api/watermarks/preview`, { method: 'POST', body: 'x'.repeat(300 * 1024) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
});

test('encode and decode endpoints take watermark ids', { skip }, async () => {
  const png = new Uint8Array(await sharp({ create: { width: 300, height: 200, channels: 3, background: '#406080' } }).png().toBuffer());
  let r = await call('/api/encode?key=k&watermark=vivi-gold&visibleWatermark=vivi-window', { method: 'POST', body: png, json: false });
  assert.equal(r.status, 200);
  const info = inspect(r.body);
  assert.deepEqual([info.watermark.id, info.watermark.embedded, info.visibleWatermark], ['vivi-gold', true, true]);
  const scrambled = r.body;
  const ref = await call('/api/encode?key=k&watermark=vivi-pixel&watermarkEmbed=id', { method: 'POST', body: png, json: false });
  assert.deepEqual(inspect(ref.body).watermark, { id: 'vivi-pixel', embedded: false });
  r = await call('/api/decode?key=k', { method: 'POST', body: scrambled, json: false });
  assert.ok(Buffer.from(readPng(r.body).pixels).equals(Buffer.from(readPng(png).pixels)), 'exact by default');
  r = await call('/api/decode?key=k&watermark=embedded', { method: 'POST', body: scrambled, json: false });
  assert.ok(Buffer.from(r.body).equals(Buffer.from(await decodeAsync(scrambled, { key: 'k', watermark: true }))));
  r = await call('/api/decode?key=k&watermark=embedded', { method: 'POST', body: ref.body, json: false });
  assert.equal(r.status, 200, 'an id-only watermark is looked up in the store');
  assert.equal((await call('/api/decode?key=k&watermark=../x', { method: 'POST', body: scrambled })).status, 400);
  assert.equal((await call('/api/encode?key=k&watermark=nope', { method: 'POST', body: png })).status, 404);
});

test('metadata profile API: list, read, create, update, delete; strict ids and bodies', { skip }, async () => {
  let r = await call('/api/metadata-profiles');
  assert.deepEqual(r.body.profiles.map((p) => p.id), ['vivi-privacy', 'vivi-web']);
  assert.deepEqual(r.body.presets, ['keep', 'strip-all', 'privacy', 'web']);
  assert.ok(r.body.kinds.includes('exif') && r.body.groups.includes('gps'));
  assert.equal((await call('/api/metadata-profiles/vivi-web')).body.set.artist, 'Vivi');
  const p = { id: 'api-test', name: 'Test', preset: 'privacy', set: { copyright: 'Vivi' } };
  r = await call('/api/metadata-profiles', { method: 'POST', body: p });
  assert.equal(r.status, 201);
  assert.equal(readFileSync(join(profilesDir, 'api-test.json'), 'utf8'), `${JSON.stringify(p, null, 2)}\n`);
  assert.equal((await call('/api/metadata-profiles', { method: 'POST', body: p })).status, 409);
  r = await call('/api/metadata-profiles/api-test', { method: 'PUT', body: { ...p, set: { copyright: 'V2' } } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(readFileSync(join(profilesDir, 'api-test.json'), 'utf8')).set.copyright, 'V2');
  assert.equal((await call('/api/metadata-profiles/api-test', { method: 'PUT', body: { ...p, id: 'other' } })).status, 400);
  for (const body of [{ id: 'web' }, { id: 'x', strip: ['pixels'] }, { id: 'x', extra: 1 }, { id: 'x', set: { exif: { MakerNote: 'x' } } }, { id: 'X' }, { id: '../x' }]) {
    const res = await call('/api/metadata-profiles', { method: 'POST', body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error);
  }
  for (const path of ['/api/metadata-profiles/..%2F..%2Fpackage', '/api/metadata-profiles/A', '/api/metadata-profiles/a.json', '/api/metadata-profiles/%2e%2e']) {
    assert.ok([400, 404].includes((await call(path)).status), path);
    assert.ok([400, 404].includes((await call(path, { method: 'PUT', body: { id: 'x' } })).status), path);
  }
  assert.equal((await call('/api/metadata-profiles/api-test', { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/metadata-profiles/api-test')).status, 404);
  assert.equal((await call('/api/metadata-profiles/api-test', { method: 'DELETE' })).status, 404);
});

test('encode, decode, rekey and inspect endpoints take ?metadata=', { skip }, async () => {
  const jpeg = new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: '#406080' } })
    .withExif({ IFD0: { Artist: 'Jane Doe', Make: 'Cam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '48/1 51/1 2400/100' } }).jpeg().toBuffer());
  let res = await fetch(`${base}/api/encode?key=k&metadata=vivi-web`, { method: 'POST', body: jpeg });
  assert.equal(res.status, 200);
  const report = JSON.parse(res.headers.get('X-Pixmix-Convert'));
  assert.deepEqual(report.metadata.set, ['EXIF Artist', 'EXIF Copyright']);
  const scrambled = new Uint8Array(await res.arrayBuffer());
  let r = await call('/api/inspect?metadata=1', { method: 'POST', body: scrambled });
  assert.deepEqual(r.body.meta.exif.tags.map((t) => t.value), ['Vivi', 'Vivi']);
  res = await fetch(`${base}/api/decode?key=k&metadata=strip-all`, { method: 'POST', body: scrambled });
  assert.match(res.headers.get('X-Pixmix-Metadata'), /EXIF \(2 tags\)/);
  r = await call('/api/inspect?metadata=1', { method: 'POST', body: new Uint8Array(await res.arrayBuffer()) });
  assert.equal(r.body.meta.exif, null);
  res = await fetch(`${base}/api/rekey?from=k&to=k2&metadata=vivi-privacy`, { method: 'POST', body: scrambled });
  assert.equal(res.status, 200);
  assert.ok(JSON.parse(res.headers.get('X-Pixmix-Metadata')).removed.some((x) => /Artist/.test(x)));
  // Non-ASCII in reports stays a valid header.
  res = await fetch(`${base}/api/decode?key=k&metadata=vivi-web`, { method: 'POST', body: scrambled });
  assert.equal(res.status, 200);
  assert.equal((await call('/api/encode?key=k&metadata=nope', { method: 'POST', body: jpeg })).status, 404);
  assert.equal((await call('/api/encode?key=k&metadata=..%2Fx', { method: 'POST', body: jpeg })).status, 400);
});

test('bad requests: numeric parameters, JSON bodies, reserved and unknown ids, oversized bodies', { skip }, async () => {
  const png = new Uint8Array(await sharp({ create: { width: 40, height: 30, channels: 3, background: '#406080' } }).png().toBuffer());
  let r = await call('/api/encode?key=k&format=jpeg&quality=abc', { method: 'POST', body: png });
  assert.deepEqual([r.status, r.body.code], [400, 'BAD_OPTION']);
  assert.equal((await call('/api/encode?key=k&format=jpeg&quality=', { method: 'POST', body: png, json: false })).status, 200, 'empty = default');
  assert.equal((await call('/api/encode?key=k&level=12', { method: 'POST', body: png })).status, 400);
  for (const body of ['null', '[]', '"x"', '7']) {
    r = await fetch(`${base}/api/watermarks`, { method: 'POST', body });
    assert.deepEqual([r.status, (await r.json()).code], [400, 'BAD_REQUEST'], body);
  }
  const def = JSON.parse(readFileSync(join(dir, 'vivi-pixel.json'), 'utf8'));
  assert.equal((await call('/api/watermarks', { method: 'POST', body: { ...def, id: 'preview' } })).status, 400);
  assert.equal((await call('/api/watermarks/preview', { method: 'PUT', body: { ...def, id: 'preview' } })).status, 400);
  r = await call('/api/encode?key=k&watermark=nope&watermarkEmbed=id', { method: 'POST', body: png });
  assert.deepEqual([r.status, r.body.code], [404, 'NOT_FOUND']);
  // 413, answered (the connection is not just reset).
  r = await fetch(`${base}/api/watermarks/preview`, { method: 'POST', body: new Uint8Array(300 * 1024) });
  assert.deepEqual([r.status, (await r.json()).code], [413, 'TOO_LARGE']);
});

test('concurrent saves of one watermark: no 500s, exactly one creation', { skip }, async () => {
  const def = JSON.parse(readFileSync(join(dir, 'vivi-pixel.json'), 'utf8'));
  const save = (id, method, i) => fetch(`${base}/api/watermarks${method === 'PUT' ? `/${id}` : ''}`, {
    method, body: JSON.stringify({ ...def, id, text: `v${i}` }),
  }).then((r) => r.status);
  const puts = await Promise.all([0, 1, 2, 3, 4].map((i) => save('race-put', 'PUT', i)));
  assert.deepEqual(puts.sort(), [200, 200, 200, 200, 201]);
  const posts = await Promise.all([0, 1, 2, 3, 4].map((i) => save('race-post', 'POST', i)));
  assert.deepEqual(posts.sort(), [201, 409, 409, 409, 409]);
  for (const id of ['race-put', 'race-post']) await call(`/api/watermarks/${id}`, { method: 'DELETE' });
});

test('static files: HEAD, content types; gallery images only under their own extension', { skip }, async () => {
  let r = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal((await r.arrayBuffer()).byteLength, 0);
  r = await fetch(`${base}/dist/pixmix-jxl-enc.LICENSES.txt`, { method: 'HEAD' });
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  r = await fetch(`${base}/dist/pixmix-encoder.cjs`, { method: 'HEAD' });
  assert.equal(r.headers.get('content-type'), 'text/javascript');
  const png = new Uint8Array(await sharp({ create: { width: 40, height: 30, channels: 3, background: '#406080' } }).png().toBuffer());
  const scrambled = (await call('/api/encode?key=k', { method: 'POST', body: png, json: false })).body;
  const { url } = (await call('/api/gallery?key=k', { method: 'POST', body: scrambled })).body;
  assert.match(url, /\.png$/);
  assert.equal((await fetch(base + url)).status, 200);
  assert.equal((await fetch(base + url.replace(/\.png$/, '.jpg'))).status, 404);
  await call('/api/gallery', { method: 'DELETE' });
});
