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
let proc, base, dir;

before(async () => {
  if (!built) return;
  dir = mkdtempSync(join(tmpdir(), 'pixmix-server-'));
  cpSync(join(ROOT, 'watermarks'), dir, { recursive: true });
  proc = spawn(process.execPath, [join(ROOT, 'server/server.js')], {
    env: { ...process.env, PORT: '0', PIXMIX_WATERMARKS_DIR: dir }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { const m = /http:\/\/[\d.]+:\d+/.exec(String(d)); if (m) resolve(m[0]); });
    proc.on('exit', (c) => reject(new Error(`server exited (${c})`)));
  });
});
after(() => {
  proc?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
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
