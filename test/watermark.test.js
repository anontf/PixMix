// Watermarks: definitions, compiling, rendering, the on-disk store, drawing on restored
// images, and the two things a scrambled file can carry (a watermark for the decoder, and
// a visible watermark on the scrambled image whose covered pixels are stashed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { PNG } from 'pngjs';
import { GifWriter } from 'omggif';
import { encode, encodeAsync, decode, decodeAsync, rekey, rekeyAsync, inspect, detectFormat } from '../src/index.js';
import {
  normalizeDefinition, formatDefinition, formatJson, validateCompiled, compileWatermark, watermarkToSvg,
  watermarkStore, loadWatermark, renderWatermark, placeWatermark, ANCHORS,
} from '../src/watermark/index.js';
import { readPng } from '../src/formats/png/index.js';
import { toRGBA8 } from '../src/formats/png/rgba.js';
import { readChunks, writeChunks } from '../src/formats/png/chunks.js';
import { readSegments, writeSegments } from '../src/formats/jpeg/markers.js';
import { decodeFrame } from '../src/formats/jpeg/decode.js';
import { readJxl, writeJxl } from '../src/formats/jxl/container.js';
import { encodeRaster } from '../src/formats/png/raster.js';
import { encodeStash } from '../src/watermark/embed.js';
import { loadJxlCodec } from '../src/formats/jxl/load.js';
import { readMarker } from '../src/core/params.js';

const WM_DIR = new URL('../watermarks/', import.meta.url).pathname;
const FIX = new URL('./fixtures/pngsuite/', import.meta.url).pathname;
const store = watermarkStore(WM_DIR);
const fonts = (n) => readFileSync(join(WM_DIR, 'fonts', `${n}.ttf`));
const DEFAULTS = ['vivi-gold', 'vivi-pixel', 'vivi-window'];

// A watermark that shows even on 32x32 test images.
const tiny = compileWatermark({
  id: 'tiny', text: 'Vi', font: 'PressStart2P-Regular', crisp: true,
  size: { px: 8 }, fit: { maxWidth: 1, maxHeight: 1, minSize: 1 }, margin: { relative: 0, min: 1, max: 1 },
  stroke: { color: '#200040', width: 0.125, join: 'square' }, shadow: { color: '#000000', opacity: 0.4, x: 0.125, y: 0.125 },
}, { font: fonts });
const gold = await store.compiled('vivi-gold');
const win = await store.compiled('vivi-window');

async function photo(w, h, jpegOpts) {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 3;
    raw[o] = (x * 255) / w; raw[o + 1] = (y * 255) / h; raw[o + 2] = ((x ^ y) * 3) & 255;
  }
  const s = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  return new Uint8Array(await (jpegOpts ? s.jpeg(jpegOpts) : s.png()).toBuffer());
}
const PHOTO = await photo(320, 200);
const JPEG = await photo(320, 200, { quality: 85 });
const JPEG_PROGRESSIVE = await photo(320, 192, { quality: 85, progressive: true });
const JPEG_444 = await photo(200, 120, { quality: 90, chromaSubsampling: '4:4:4' });
const JPEG_GREY = new Uint8Array(await sharp(JPEG).greyscale().jpeg().toBuffer());

const coefs = (b) => decodeFrame(readSegments(b).segments).components.map((c) => Buffer.from(c.coefs.buffer));
const sameCoefs = (a, b) => coefs(a).every((c, i) => c.equals(coefs(b)[i]));
const pngPixels = (b) => { const p = readPng(b); return p.frames.map((f) => Buffer.from(f)); };
const samePng = (a, b) => { const x = pngPixels(a), y = pngPixels(b); return x.length === y.length && x.every((f, i) => f.equals(y[i])); };
const eqBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));

// --- definitions -----------------------------------------------------------------

test('definitions: defaults filled in, fixed key order, strict validation', () => {
  const d = normalizeDefinition({ text: 'Vivi', font: 'X', id: 'a-b' });
  assert.deepEqual(Object.keys(d).slice(0, 5), ['id', 'name', 'text', 'font', 'letterSpacing']);
  assert.equal(d.name, 'a-b');
  assert.equal(d.anchor, 'bottom-right');
  assert.equal(normalizeDefinition({ ...d, fill: '#ABC' }).fill, '#aabbcc');
  const bad = [
    [{ id: 'A' }, /id/], [{ id: '../x' }, /id/], [{ id: 'x-' }, /id/], [{ foo: 1 }, /foo: is not a known field/],
    [{ fill: 'red' }, /fill: must be a colour/], [{ anchor: 'middle' }, /anchor: must be one of/],
    [{ opacity: 2 }, /opacity: must be between/], [{ size: { min: 50, max: 10 } }, /size.min/],
    [{ text: '' }, /text/], [{ text: 'a\nb\nc\nd\ne' }, /text/], [{ text: 'a\u0007' }, /control/],
    [{ fill: { type: 'linear', stops: [{ at: 0.5, color: '#fff' }, { at: 0.2, color: '#000' }] } }, /increasing/],
    [{ fill: { type: 'linear', stops: [{ at: 0 }] } }, /stops/], [{ ornaments: [{ shape: 'image' }] }, /src: is required/],
    [{ ornaments: [{ shape: 'image', src: '../x.png' }] }, /asset name/], [{ font: 'a/b' }, /font name/],
    [{ size: { relative: '0.1' } }, /must be a number/], [{ stroke: 5 }, /stroke: must be an object or null/],
  ];
  for (const [patch, re] of bad) {
    assert.throws(() => normalizeDefinition({ ...d, ...patch }), (e) => e.code === 'BAD_WATERMARK' && re.test(e.message), JSON.stringify(patch));
  }
});

test('committed definitions are normalised, and their compiled files are up to date', async () => {
  const ids = readdirSync(WM_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(ids, DEFAULTS);
  for (const id of ids) {
    const text = readFileSync(join(WM_DIR, `${id}.json`), 'utf8');
    assert.equal(formatDefinition(JSON.parse(text)), text, `${id}.json is in the saved format`);
    const compiled = compileWatermark(JSON.parse(text), { font: fonts });
    assert.equal(formatJson(compiled), readFileSync(join(WM_DIR, 'compiled', `${id}.json`), 'utf8'), `compiled/${id}.json is current (npm run watermarks)`);
    assert.equal(watermarkToSvg(compiled), readFileSync(join(WM_DIR, 'compiled', `${id}.svg`), 'utf8'));
    assert.match(compiled.shapes.at(-1).d, /^M/);
  }
  // Every committed font has its licence next to it.
  for (const f of readdirSync(join(WM_DIR, 'fonts')).filter((n) => n.endsWith('.ttf'))) {
    const stem = f.replace(/(-Regular|-Bold)?\.ttf$/, '');
    assert.ok(existsSync(join(WM_DIR, 'fonts', `${stem}-OFL.txt`)), `${f} licence`);
  }
});

test('compiling: glyphs from the font, missing glyphs and fonts are errors', () => {
  const base = { id: 'x', text: 'Vivi', font: 'PressStart2P-Regular' };
  const a = compileWatermark(base, { font: fonts });
  const b = compileWatermark(base, { font: fonts });
  assert.deepEqual(a, b);
  assert.deepEqual(a.box, [0, -1000, 3875, -125], 'Press Start 2P: 8 px grid, 1000 units per em');
  assert.throws(() => compileWatermark({ ...base, text: 'Vivi ✓' }, { font: fonts }), /no glyph for "✓"/);
  assert.throws(() => compileWatermark({ ...base, font: 'Nope' }, { font: () => null }), /Unknown font/);
  const two = compileWatermark({ ...base, text: 'Vi\nVivi', align: 'right' }, { font: fonts });
  assert.ok(two.box[3] > a.box[3] + 1000, 'second line below the first');
  const orn = compileWatermark({ ...base, ornaments: [{ shape: 'star', position: 'before' }, { shape: 'line', position: 'below', size: 1 }] }, { font: fonts });
  assert.equal(orn.shapes.length, 3);
  assert.ok(orn.box[0] < 0 && orn.box[3] > a.box[3], 'ornaments widen the box');
});

test('compiled watermarks from untrusted places are validated with bounds', () => {
  const ok = structuredClone(gold);
  assert.deepEqual(validateCompiled(ok), gold);
  const bad = [
    (c) => { c.version = 2; }, (c) => { c.format = 'svg'; }, (c) => { c.shapes[0].d = 'M0 0<script>'; },
    (c) => { c.shapes = []; }, (c) => { c.shapes = Array(40).fill(c.shapes[0]); },
    (c) => { c.shapes[0].d = 'M1 1'.repeat(60000); }, (c) => { c.box = [0, 0, 1]; }, (c) => { c.extra = 1; },
    (c) => { c.shapes[0].image = { width: 2, height: 2, box: [0, 0, 1, 1], rgba: 'AAAA' }; },
    (c) => { c.shapes[0].fill = { type: 'linear', dir: [0, 2], stops: [{ at: 0, color: '#fff' }, { at: 1, color: '#000' }] }; },
  ];
  for (const f of bad) {
    const c = structuredClone(gold);
    f(c);
    assert.throws(() => validateCompiled(c), { code: 'BAD_WATERMARK' }, f.toString());
  }
});

// --- rendering ---------------------------------------------------------------------

test('rendering is deterministic and places the watermark by its rules', () => {
  const a = renderWatermark(gold, 800, 500), b = renderWatermark(gold, 800, 500);
  assert.ok(Buffer.from(a.data.buffer).equals(Buffer.from(b.data.buffer)));
  // Bottom right, inside the margin, small.
  assert.ok(a.x + a.width <= 800 && a.y + a.height <= 500 && a.x > 700 && a.y > 420, JSON.stringify([a.x, a.y, a.width, a.height]));
  // Size: relative to the short side, clamped, snapped.
  const px = (c, w, h) => placeWatermark(c, w, h)?.em;
  const pixel = compileWatermark(JSON.parse(readFileSync(join(WM_DIR, 'vivi-pixel.json'), 'utf8')), { font: fonts });
  assert.deepEqual([px(pixel, 400, 400), px(pixel, 800, 500), px(pixel, 2000, 1500), px(pixel, 8000, 6000)], [8, 8, 24, 24]);
  assert.equal(px(gold, 1000, 1000), 30);
  assert.equal(px(gold, 100, 100), 12);
  assert.equal(px(gold, 20000, 12000), 40);
  // Too small to read: left out rather than squeezed.
  assert.equal(renderWatermark(gold, 16, 16), null);
  // maxWidth keeps it from covering a thin image.
  const thin = placeWatermark(gold, 60, 400);
  assert.ok(thin === null || thin.ink[2] - thin.ink[0] <= 30.5);
  // All nine anchors land where they say.
  for (const anchor of ANCHORS) {
    const p = renderWatermark({ ...gold, anchor }, 600, 400);
    const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
    const col = anchor.endsWith('left') ? 0 : anchor.endsWith('right') ? 2 : 1;
    const row = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? 2 : 1;
    assert.equal(Math.floor(cx / 200), col, anchor);
    assert.equal(Math.floor(cy / 133.4), row, anchor);
  }
  // Crisp pixel text has hard edges: coverage is all or nothing (apart from opacity).
  const crisp = renderWatermark(pixel, 800, 500);
  const alphas = new Set();
  for (let i = 3; i < crisp.data.length; i += 4) alphas.add(Math.round(crisp.data[i] * 1000));
  assert.ok(alphas.size <= 4, [...alphas].join());
});

// --- the store -------------------------------------------------------------------------

test('store: save, load, list, delete; ids cannot leave the directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pixmix-wm-'));
  try {
    cpSync(join(WM_DIR, 'fonts'), join(dir, 'fonts'), { recursive: true });
    const s = watermarkStore(dir);
    const { definition, compiled } = await s.save({ id: 'round-trip', text: 'Vivi', font: 'PixelifySans', fill: '#FFF' });
    assert.equal(definition.fill, '#ffffff');
    assert.equal(readFileSync(join(dir, 'round-trip.json'), 'utf8'), formatDefinition(definition));
    assert.deepEqual(await s.get('round-trip'), definition);
    assert.deepEqual(await s.compiled('round-trip'), compiled);
    assert.deepEqual((await s.list()).map((d) => d.id), ['round-trip']);
    assert.deepEqual(await s.fonts(), ['CinzelDecorative-Bold', 'PixelifySans', 'PressStart2P-Regular']);
    assert.deepEqual(await loadWatermark(join(dir, 'round-trip.json'), { dir }), compiled, 'a definition file');
    assert.deepEqual(await loadWatermark(join(dir, 'compiled', 'round-trip.json'), { dir }), compiled, 'a compiled file');
    for (const id of ['../x', 'a/b', '..', 'x.json', '', 'A']) {
      await assert.rejects(s.get(id), { code: 'BAD_WATERMARK' }, id);
      await assert.rejects(s.save({ id, text: 'x', font: 'PixelifySans' }), { code: 'BAD_WATERMARK' }, id);
    }
    await assert.rejects(s.save({ id: 'f', text: 'x', font: '../../etc/passwd' }), { code: 'BAD_WATERMARK' });
    await s.remove('round-trip');
    assert.equal(existsSync(join(dir, 'round-trip.json')), false);
    assert.equal(existsSync(join(dir, 'compiled', 'round-trip.json')), false);
    await assert.rejects(s.get('round-trip'), { status: 404 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- drawing on restored images ------------------------------------------------------

/** Pixels outside the rectangle must be exactly as restored. */
function changedOnlyIn(plain, marked, width, rect, bpp) {
  let inside = 0;
  for (let i = 0; i < plain.length; i += bpp) {
    const p = i / bpp, x = p % width, y = Math.floor(p / width);
    const same = plain.subarray(i, i + bpp).every((v, k) => v === marked[i + k]);
    const inRect = x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
    if (!same) { assert.ok(inRect, `pixel ${x},${y} changed outside the watermark`); inside++; }
  }
  return inside;
}

for (const file of ['basn2c08', 'basn6a08', 'basn0g16', 'basn6a16', 'basn4a08', 'basi2c08', 'basn3p08', 'basn0g04']) {
  test(`PNG ${file}: the watermark changes only its own pixels; restoring stays exact without it`, async () => {
    const src = readFileSync(join(FIX, `${file}.png`));
    const s = encode(src, { key: 'k', watermark: tiny });
    const plain = await decodeAsync(s, { key: 'k' });
    assert.ok(samePng(plain, src), 'no watermark unless asked');
    const marked = await decodeAsync(s, { key: 'k', watermark: true });
    const a = readPng(plain), b = readPng(marked);
    const promoted = a.ihdr.colorType === 3 || a.ihdr.depth < 8;
    assert.equal(b.ihdr.colorType, promoted ? 6 : a.ihdr.colorType);
    assert.equal(b.ihdr.depth, promoted ? 8 : a.ihdr.depth);
    assert.equal(b.ihdr.interlace, a.ihdr.interlace);
    const rect = renderWatermark(tiny, 32, 32);
    const before = promoted ? toRGBA8(a, a.pixels) : a.pixels, after = b.pixels;
    assert.ok(changedOnlyIn(before, after, 32, rect, promoted ? 4 : b.pixelBytes) > 20, 'the watermark shows');
    // Other chunks are kept (except the palette ones when promoted, and our own).
    const kept = (p) => p.chunks.map((c) => c.type).filter((t) => !['IDAT', 'PLTE', 'tRNS', 'bKGD', 'hIST', 'sBIT', 'IHDR'].includes(t));
    assert.deepEqual(kept(b), kept(a));
    assert.ok(PNG.sync.read(Buffer.from(marked)).width === 32, 'pngjs reads it');
  });
}

test('APNG: every full-size frame gets the watermark', async () => {
  const buf = Buffer.alloc(1 << 16);
  const gw = new GifWriter(buf, 40, 24, { loop: 0, palette: [0x000000, 0xff0000, 0x00ff00, 0x0000ff] });
  for (let f = 0; f < 3; f++) gw.addFrame(0, 0, 40, 24, Array.from({ length: 960 }, (_, i) => (((i % 40) + f * 9) >> 3) & 3), { delay: 5 });
  const s = encode(new Uint8Array(buf.subarray(0, gw.end())), { key: 'k', watermark: tiny });
  const plain = readPng(await decodeAsync(s, { key: 'k' }));
  const marked = readPng(await decodeAsync(s, { key: 'k', watermark: true }));
  assert.equal(marked.frames.length, 3);
  const rect = renderWatermark(tiny, 40, 24);
  for (let i = 0; i < 3; i++) assert.ok(changedOnlyIn(toRGBA8(plain, plain.frames[i]), marked.frames[i], 40, rect, 4) > 10, `frame ${i}`);
});

test('visible watermark on an APNG with 256+ frames: the stash counts regions in four bytes', async () => {
  const gif = (n) => {
    const buf = Buffer.alloc(1 << 20);
    const gw = new GifWriter(buf, 40, 24, { loop: 0, palette: [0x000000, 0xff0000, 0x00ff00, 0x0000ff] });
    for (let f = 0; f < n; f++) gw.addFrame(0, 0, 40, 24, Array.from({ length: 960 }, (_, i) => (((i % 40) + f * 9) >> 3) & 3), { delay: 5 });
    return new Uint8Array(buf.subarray(0, gw.end()));
  };
  for (const [n, version] of [[255, 1], [256, 2], [300, 2]]) {
    const png = encode(gif(n), { key: 'k' });
    const want = await decodeAsync(png, { key: 'k' });
    const s = await rekeyAsync(png, { from: 'k', to: 'k', visibleWatermark: tiny });
    assert.equal(readChunks(s).find((c) => c.type === 'pmWs').data[0], version, `${n} frames`);
    assert.ok(samePng(await decodeAsync(s, { key: 'k' }), want), `${n} frames: exact restore`);
    assert.ok(samePng(await decodeAsync(await rekeyAsync(s, { from: 'k', to: 'j' }), { key: 'j' }), want), `${n} frames: exact after rekey`);
  }
});

for (const [name, src] of [['baseline 4:2:0', JPEG], ['progressive', JPEG_PROGRESSIVE], ['4:4:4', JPEG_444], ['grey', JPEG_GREY]]) {
  test(`JPEG ${name}: the watermark is painted in the DCT domain, only its MCUs change`, async () => {
    const s = encode(src, { key: 'k', watermark: gold });
    const plain = await decodeAsync(s, { key: 'k' });
    assert.ok(sameCoefs(plain, src), 'exact without the watermark');
    const marked = await decodeAsync(s, { key: 'k', watermark: 'embedded' });
    assert.equal(inspect(marked).progressive, inspect(src).progressive);
    const f0 = decodeFrame(readSegments(plain).segments), f1 = decodeFrame(readSegments(marked).segments);
    const { width, height } = f0;
    const p = renderWatermark(gold, width, height);
    const tw = 8 * f0.hmax, th = 8 * f0.vmax;
    let changed = 0;
    f0.components.forEach((c, ci) => {
      for (let b = 0; b < c.blocksW * c.blocksH; b++) {
        const same = c.coefs.subarray(b * 64, b * 64 + 64).every((v, k) => v === f1.components[ci].coefs[b * 64 + k]);
        if (same) continue;
        changed++;
        const mx = Math.floor((b % c.blocksW) / c.h), my = Math.floor(Math.floor(b / c.blocksW) / c.v);
        assert.ok(mx * tw < p.x + p.width && (mx + 1) * tw > p.x && my * th < p.y + p.height && (my + 1) * th > p.y, `block ${b} is outside the watermark`);
      }
    });
    assert.ok(changed > 4, `${changed} blocks changed`);
    // Other software decodes it, and it looks watermarked where it should.
    const raw = await sharp(Buffer.from(marked)).raw().toBuffer({ resolveWithObject: true });
    assert.equal(raw.info.width, width);
    const ref = await sharp(Buffer.from(plain)).raw().toBuffer();
    const diff = (x0, y0, x1, y1) => {
      let d = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let k = 0; k < raw.info.channels; k++) d += Math.abs(raw.data[(y * width + x) * raw.info.channels + k] - ref[(y * width + x) * raw.info.channels + k]);
      return d / ((x1 - x0) * (y1 - y0));
    };
    assert.ok(diff(p.x, p.y, p.x + p.width, p.y + p.height) > 5, 'visible');
    assert.ok(diff(0, 0, 64, 64) === 0, 'untouched elsewhere');
  });
}

test('JPEG XL: both routes draw the watermark (decodeAsync)', async () => {
  const pixel = await encodeAsync(PHOTO, { key: 'k', format: 'jxl', watermark: win });
  const codec = await loadJxlCodec();
  const plain = (await codec.decode(await decodeAsync(pixel, { key: 'k' }))).data;
  const marked = (await codec.decode(await decodeAsync(pixel, { key: 'k', watermark: true }))).data;
  assert.ok(changedOnlyIn(plain, marked, 320, renderWatermark(win, 320, 200), 4) > 100);
  const route = await encodeAsync(JPEG, { key: 'k', format: 'jxl', watermark: win });
  assert.equal(inspect(route).watermark.id, 'vivi-window', 'mirrored in a box for inspect');
  const jpeg = await codec.reconstructJpeg(await decodeAsync(route, { key: 'k', watermark: true }));
  const direct = await decodeAsync(encode(JPEG, { key: 'k' }), { key: 'k', watermark: win });
  assert.ok(sameCoefs(jpeg, direct), 'the JPEG inside is watermarked as a plain JPEG would be');
});

test('Node renders the same bytes for the same file and watermark', async () => {
  const s = encode(JPEG, { key: 'k', watermark: gold });
  assert.ok(eqBytes(await decodeAsync(s, { key: 'k', watermark: true }), await decodeAsync(s, { key: 'k', watermark: gold })));
});

// --- carried watermarks --------------------------------------------------------------

test('a scrambled file can carry its watermark: whole, or by id', async () => {
  for (const src of [PHOTO, JPEG]) {
    const whole = encode(src, { key: 'k', watermark: gold });
    assert.deepEqual(inspect(whole).watermark, { id: 'vivi-gold', name: 'Vivi · gold', embedded: true });
    assert.equal(inspect(whole).visibleWatermark, false);
    const byId = encode(src, { key: 'k', watermark: { id: 'vivi-window' } });
    assert.deepEqual(inspect(byId).watermark, { id: 'vivi-window', embedded: false });
    await assert.rejects(decodeAsync(byId, { key: 'k', watermark: true }), /resolveWatermark/);
    const drawn = await decodeAsync(byId, { key: 'k', watermark: true, resolveWatermark: (id) => store.compiled(id) });
    assert.ok(eqBytes(drawn, await decodeAsync(byId, { key: 'k', watermark: win })));
    // Restored files never carry pixmix's chunks.
    const plain = decode(whole, { key: 'k' });
    assert.equal(inspect(plain).watermark, null);
    assert.ok(!(inspect(plain).chunks ?? inspect(plain).segments).some((c) => ['pmWm', 'pmWs', 'APP15'].includes(c.type)));
    // Rekey keeps it; null removes it; another replaces it.
    assert.equal(inspect(rekey(whole, { from: 'k', to: 'j' })).watermark.id, 'vivi-gold');
    assert.equal(inspect(rekey(whole, { from: 'k', to: 'j', watermark: null })).watermark, null);
    assert.equal(inspect(rekey(byId, { from: 'k', to: 'j' })).watermark.embedded, false);
    assert.equal(inspect(rekey(whole, { from: 'k', to: 'j', watermark: win })).watermark.id, 'vivi-window');
    // A file without a watermark: 'embedded' draws nothing.
    const none = encode(src, { key: 'k' });
    assert.ok((await content(await decodeAsync(none, { key: 'k', watermark: true }))).equals(await content(src)));
  }
  assert.throws(() => encode(PHOTO, { key: 'k', watermark: { id: '../x' } }), { code: 'BAD_WATERMARK' });
  assert.throws(() => encode(PHOTO, { key: 'k', watermark: { ...gold, version: 9 } }), { code: 'BAD_WATERMARK' });
  assert.throws(() => decode(encode(PHOTO, { key: 'k', watermark: gold }), { key: 'k', watermark: true }), { code: 'ASYNC_DECODER' });
});

test('a corrupt carried watermark is reported, not drawn', async () => {
  const s = encode(PHOTO, { key: 'k', watermark: gold });
  const hostile = writeChunks(readChunks(s).map((c) => (c.type === 'pmWm' ? { type: 'pmWm', data: new Uint8Array([1, 1, ...Buffer.from(JSON.stringify({ ...gold, shapes: [{ d: 'M0 0L1e9 1e9Z', fill: '#fff', outline: true, image: null }] }))]) } : c)));
  await assert.rejects(decodeAsync(hostile, { key: 'k', watermark: true }), { code: 'BAD_WATERMARK' });
});

/** The file with its carried watermark payload (pmWm chunk / APP15 pixmix-wm / pmWm box) swapped. */
function withCarried(b, payload) {
  const f = detectFormat(b);
  if (f === 'png') return writeChunks(readChunks(b).map((c) => (c.type === 'pmWm' ? { type: 'pmWm', data: payload } : c)));
  if (f === 'jpeg') {
    const { segments, trailing } = readSegments(b);
    const sig = Buffer.from('pixmix-wm\0');
    return writeSegments(segments.map((x) => (x.marker === 0xef && sig.equals(Buffer.from(x.data.subarray(0, sig.length))) ? { ...x, data: new Uint8Array([...sig, ...payload]) } : x)), trailing);
  }
  const { boxes, codestream } = readJxl(b);
  return writeJxl(boxes.filter((x) => x.type !== 'ftyp' && x.type !== 'jxlc').map((x) => (x.type === 'pmWm' ? { type: 'pmWm', data: payload } : x)), codestream);
}

test('a damaged or oversized carried watermark never stops restoring, inspect or rekey', async () => {
  const damaged = Uint8Array.of(1, 1, 0x7b, 0x7b);
  for (const [name, make] of [['PNG', () => encode(PHOTO, { key: 'k', watermark: gold })], ['JPEG', () => encode(JPEG, { key: 'k', watermark: gold })],
    ['JPEG XL', () => encodeAsync(PHOTO, { key: 'k', format: 'jxl', mode: 'block', block: 8, effort: 1, watermark: gold })]]) {
    const s = await make();
    const want = await content(await decodeAsync(s, { key: 'k' }));
    const bad = withCarried(s, damaged);
    assert.equal(inspect(bad).watermark.unreadable, true, name);
    assert.match(inspect(bad).watermark.error, /Corrupt/);
    assert.ok((await content(await decodeAsync(bad, { key: 'k' }))).equals(want), `${name}: plain decode is exact`);
    if (name !== 'JPEG XL') assert.ok((await content(decode(bad, { key: 'k' }))).equals(want), `${name}: sync decode`);
    // Asking for the file's own watermark is an error; drawing another one is not.
    await assert.rejects(decodeAsync(bad, { key: 'k', watermark: 'embedded' }), { code: 'BAD_WATERMARK' });
    await decodeAsync(bad, { key: 'k', watermark: win });
    // Rekey drops the damaged watermark, or replaces it.
    const r = await rekeyAsync(bad, { from: 'k', to: 'j' });
    assert.equal(inspect(r).watermark, null, `${name}: dropped by rekey`);
    assert.ok((await content(await decodeAsync(r, { key: 'j' }))).equals(want));
    assert.equal(inspect(await rekeyAsync(bad, { from: 'k', to: 'j', watermark: win })).watermark.id, 'vivi-window');
    // Over maxMetadataBytes: restoring ignores it, inspect flags it, rekey keeps it as it is.
    const limits = { maxMetadataBytes: 100 };
    assert.ok((await content(await decodeAsync(s, { key: 'k', limits }))).equals(want), `${name}: limit only matters for drawing`);
    assert.match(inspect(s, { limits }).watermark.error, /maxMetadataBytes/);
    await assert.rejects(decodeAsync(s, { key: 'k', limits, watermark: true }), { code: 'LIMIT' });
    assert.deepEqual(inspect(await rekeyAsync(s, { from: 'k', to: 'j', limits })).watermark, { id: 'vivi-gold', name: 'Vivi · gold', embedded: true });
  }
});

test('a watermark on a 1/2/4-bit grey PNG drops its grey ICC profile with the promotion to RGBA', async () => {
  const withIcc = (b) => writeChunks(readChunks(b).flatMap((c) => (c.type === 'IHDR' ? [c, { type: 'iCCP', data: new Uint8Array([...Buffer.from('p\0\0'), 0x78, 0x9c, 3, 0, 0, 0, 0, 1]) }] : [c])));
  const grey = withIcc(readFileSync(join(FIX, 'basn0g04.png')));
  const drawn = await decodeAsync(encode(grey, { key: 'k' }), { key: 'k', watermark: tiny });
  assert.equal(inspect(drawn).colorType, 6);
  assert.deepEqual(inspect(drawn).chunks.map((c) => c.type).filter((t) => t !== 'IDAT'), ['IHDR', 'gAMA', 'IEND']);
  // A palette image's profile is an RGB one, which RGBA can keep.
  const pal = withIcc(readFileSync(join(FIX, 'basn3p08.png')));
  assert.ok(inspect(await decodeAsync(encode(pal, { key: 'k' }), { key: 'k', watermark: tiny })).chunks.some((c) => c.type === 'iCCP'));
});

test('a watermark on a PNG with a tRNS colour key: keyed pixels are transparent, painted ones never become the key', async () => {
  const w = 48, h = 32;
  const u16 = (...v) => new Uint8Array(v.flatMap((x) => [x >> 8, x & 255]));
  const png = (colorType, depth, key, fill) => writeChunks([
    { type: 'IHDR', data: new Uint8Array([0, 0, 0, w, 0, 0, 0, h, depth, colorType, 0, 0, 0]) },
    { type: 'tRNS', data: u16(...key) },
    { type: 'IDAT', data: encodeRaster({ width: w, height: h, depth, colorType, interlace: 0 }, fill) },
    { type: 'IEND', data: new Uint8Array(0) },
  ]);
  // The key is the stroke colour of `tiny`: the whole image is transparent.
  const rgb = png(2, 8, [0x20, 0x00, 0x40], new Uint8Array(w * h * 3).map((_, i) => [0x20, 0x00, 0x40][i % 3]));
  const grey16 = png(0, 16, [0x1234], new Uint8Array(w * h * 2).map((_, i) => (i % 2 ? 0x34 : 0x12)));
  const patch = renderWatermark(tiny, w, h);
  let covering = 0;
  for (let i = 3; i < patch.data.length; i += 4) if (patch.data[i] >= 0.5) covering++;
  for (const [name, src] of [['RGB', rgb], ['grey 16-bit', grey16]]) {
    for (const s of [encode(src, { key: 'k', watermark: tiny }), encode(src, { key: 'k', visibleWatermark: tiny })]) {
      const visible = inspect(s).visibleWatermark;
      const out = visible ? s : await decodeAsync(s, { key: 'k', watermark: true });
      const img = readPng(out);
      const rgba = toRGBA8(img, img.pixels);
      let opaque = 0;
      for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) opaque++;
      assert.equal(opaque, covering, `${name}${visible ? ', visible' : ''}: every pixel the watermark covers shows, nothing else`);
      if (visible) assert.ok(samePng(await decodeAsync(s, { key: 'k' }), src), 'exact restore');
    }
  }
});

// --- visible watermarks on scrambled images ------------------------------------------

const VISIBLE = [
  ['PNG pixel', () => encode(PHOTO, { key: 'k', visibleWatermark: win }), PHOTO],
  ['PNG block', () => encode(PHOTO, { key: 'k', mode: 'block', block: 16, visibleWatermark: gold }), PHOTO],
  ['PNG palette', () => encode(readFileSync(join(FIX, 'basn3p08.png')), { key: 'k', visibleWatermark: tiny }), readFileSync(join(FIX, 'basn3p08.png'))],
  ['PNG grey 16-bit', () => encode(readFileSync(join(FIX, 'basn0g16.png')), { key: 'k', visibleWatermark: tiny }), readFileSync(join(FIX, 'basn0g16.png'))],
  ['PNG 1-bit', () => encode(readFileSync(join(FIX, 'basn0g01.png')), { key: 'k', visibleWatermark: tiny }), readFileSync(join(FIX, 'basn0g01.png'))],
  ['PNG interlaced RGBA 16-bit', () => encode(readFileSync(join(FIX, 'basi6a16.png')), { key: 'k', visibleWatermark: tiny }), readFileSync(join(FIX, 'basi6a16.png'))],
  ['JPEG', () => encode(JPEG, { key: 'k', visibleWatermark: gold }), JPEG],
  ['JPEG progressive', () => encode(JPEG_PROGRESSIVE, { key: 'k', visibleWatermark: win }), JPEG_PROGRESSIVE],
  ['JPEG grey', () => encode(JPEG_GREY, { key: 'k', visibleWatermark: win }), JPEG_GREY],
  ['JPEG XL pixel route', () => encodeAsync(PHOTO, { key: 'k', format: 'jxl', visibleWatermark: gold }), null],
  ['JPEG XL JPEG route', () => encodeAsync(JPEG, { key: 'k', format: 'jxl', visibleWatermark: gold }), JPEG],
];

/** What restoring must give back: PNG samples, JPEG coefficients, JPEG XL pixels. */
async function content(b) {
  const f = detectFormat(b);
  if (f === 'png') return Buffer.concat(pngPixels(b));
  if (f === 'jpeg') return Buffer.concat(coefs(b));
  const codec = await loadJxlCodec();
  const jpeg = readJxl(b).boxes.some((x) => x.type === 'jbrd') ? await codec.reconstructJpeg(b) : null;
  return jpeg ? content(jpeg) : Buffer.from((await codec.decode(b)).data);
}

for (const [name, make, source] of VISIBLE) {
  test(`visible watermark, ${name}: shown on the scrambled image, restoring and rekey stay exact`, async () => {
    const s = await make();
    const info = inspect(s);
    assert.equal(info.visibleWatermark, true);
    const want = source ? await content(source) : await content(await decodeAsync(await encodeAsync(PHOTO, { key: 'k', format: 'jxl' }), { key: 'k' }));
    assert.ok((await content(await decodeAsync(s, { key: 'k' }))).equals(want), 'exact restore');
    // The marker is v2 (with the stash flag), so older decoders refuse the file.
    const f = detectFormat(s);
    const marker = f === 'png' ? readChunks(s).find((c) => c.type === 'pmIx').data
      : f === 'jpeg' ? readSegments(s).segments.find((x) => x.marker === 0xef && x.data[6] === 0).data.subarray(7)
        : readJxl(s).boxes.find((x) => x.type === 'pmIx').data;
    assert.equal(marker[0], 2);
    assert.equal(readMarker(marker).params.flags, 1);
    // The scrambled image looks different where the watermark is: compare with a plain scramble.
    const r = await rekeyAsync(s, { from: 'k', to: 'j' });
    assert.equal(inspect(r).visibleWatermark, true, 'kept by rekey');
    assert.ok((await content(await decodeAsync(r, { key: 'j' }))).equals(want), 'exact after rekey');
    const off = await rekeyAsync(s, { from: 'k', to: 'j', visibleWatermark: null });
    assert.equal(inspect(off).visibleWatermark, false);
    assert.ok((await content(await decodeAsync(off, { key: 'j' }))).equals(want), 'exact after removing it');
    await assert.rejects(decodeAsync(s, { key: 'wrong' }), { code: 'WRONG_KEY' });
    // Other software still reads the scrambled file.
    if (f !== 'jxl') assert.equal((await sharp(Buffer.from(s)).metadata()).width, info.width, 'sharp reads it');
    if (f === 'png') assert.equal(PNG.sync.read(Buffer.from(s)).width, info.width, 'pngjs reads it');
    if (f === 'jxl') assert.equal((await (await loadJxlCodec()).decode(s)).width, info.width, 'jxl-oxide reads it');
  });
}

test('visible watermark: the stash is needed, bound to the key, and bounds-checked', async () => {
  const s = encode(PHOTO, { key: 'k', visibleWatermark: win });
  const plain = encode(PHOTO, { key: 'k' });
  // The scrambled image differs only under the watermark from one without it.
  const a = readPng(s), b = readPng(rekey(plain, { from: 'k', to: 'k', salt: readMarker(readChunks(s).find((c) => c.type === 'pmIx').data).params.salt }));
  const rect = renderWatermark(win, 320, 200);
  assert.ok(changedOnlyIn(b.pixels, a.pixels, 320, rect, 3) > 200);
  const without = writeChunks(readChunks(s).filter((c) => c.type !== 'pmWs'));
  await assert.rejects(decodeAsync(without, { key: 'k' }), /lost the pixels/);
  const tampered = writeChunks(readChunks(s).map((c) => {
    if (c.type !== 'pmWs') return c;
    const d = c.data.slice();
    const dv = new DataView(d.buffer);
    const jl = dv.getUint32(1);
    dv.setUint32(1 + 4 + jl + 1 + 4, 400); // region x beyond the image
    return { type: 'pmWs', data: d };
  }));
  await assert.rejects(decodeAsync(tampered, { key: 'k' }), { code: 'BAD_WATERMARK' });
  // One region per frame: a stash listing a frame again (so the regions could add up to far
  // more than the image) is refused before anything is allocated.
  const salt = readMarker(readChunks(s).find((c) => c.type === 'pmIx').data).params.salt;
  const full = { frame: 0, x: 0, y: 0, width: 320, height: 200 };
  const restash = (regions) => writeChunks(readChunks(s).map((c) => (c.type === 'pmWs' ? { type: 'pmWs', data: encodeStash({ watermark: win, regions, raw: new Uint8Array(regions.length * 320 * 200 * 3), key: 'k', salt }) } : c)));
  await assert.rejects(decodeAsync(restash([full, full, full]), { key: 'k' }), { code: 'BAD_WATERMARK' });
  await decodeAsync(restash([full]), { key: 'k' });
  await assert.rejects(decodeAsync(restash([full]), { key: 'k', limits: { maxDecompressedBytes: 100_000 } }), { code: 'LIMIT' });
  // The watermark in the stash is only needed to draw it again: restoring ignores it (and
  // maxMetadataBytes), rekey keeping it needs it.
  const badJson = writeChunks(readChunks(s).map((c) => (c.type === 'pmWs' ? { type: 'pmWs', data: Uint8Array.from(c.data, (v, i) => (i === 5 ? 0x78 : v)) } : c)));
  assert.ok(samePng(await decodeAsync(badJson, { key: 'k' }), await decodeAsync(s, { key: 'k' })));
  assert.throws(() => rekey(badJson, { from: 'k', to: 'j' }), { code: 'BAD_WATERMARK' });
  assert.equal(inspect(rekey(badJson, { from: 'k', to: 'j', visibleWatermark: null })).visibleWatermark, false);
  await decodeAsync(s, { key: 'k', limits: { maxMetadataBytes: 100 } });
  assert.throws(() => rekey(s, { from: 'k', to: 'j', limits: { maxMetadataBytes: 100 } }), { code: 'LIMIT' });
  // JPEG: stash split across APP15 segments, which must all be there.
  const j = encode(await photo(1200, 800, { quality: 95 }), { key: 'k', visibleWatermark: gold });
  const segs = readSegments(j).segments;
  const ws = segs.filter((x) => x.marker === 0xef && x.data[7] === 0x77 && x.data[8] === 0x73);
  assert.ok(ws.length >= 1);
  const missing = writeSegments(segs.filter((x) => x !== ws.at(-1)));
  await assert.rejects(decodeAsync(missing, { key: 'k' }), /lost the coefficients/);
  // Files without a visible watermark keep marker v1.
  assert.equal(readChunks(plain).find((c) => c.type === 'pmIx').data[0], 1);
  // JPEG XL needs 8-bit sRGB for it.
  const deep = await (await loadJxlCodec()).encode({ width: 40, height: 30, depth: 16, data: new Uint16Array(40 * 30 * 4).fill(3000) });
  await assert.rejects(encodeAsync(deep, { key: 'k', visibleWatermark: tiny }), /8-bit sRGB/);
});

test('JPEG XL boxes: pmWm and pmWs are dropped from restored files', async () => {
  const s = await encodeAsync(PHOTO, { key: 'k', format: 'jxl', watermark: gold, visibleWatermark: win });
  const types = readJxl(s).boxes.map((b) => b.type);
  assert.ok(types.includes('pmWm') && types.includes('pmWs'));
  const restored = readJxl(await decodeAsync(s, { key: 'k' })).boxes.map((b) => b.type);
  assert.ok(!restored.some((t) => t.startsWith('pm')), restored.join());
});
