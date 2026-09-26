import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { encode, decode, rekey, inspect, convert, encodeAsync, decodeAsync } from '../src/index.js';
import { loadJxlCodec } from '../src/formats/jxl/load.js';
import { readChunks, writeChunks } from '../src/formats/png/chunks.js';
import { encodeRaster } from '../src/formats/png/raster.js';
import { readPng } from '../src/formats/png/index.js';

const u32 = (...v) => { const b = new Uint8Array(v.length * 4); const dv = new DataView(b.buffer); v.forEach((x, i) => dv.setUint32(i * 4, x)); return b; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

function rgba(w, h, seed) {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < d.length; i++) d[i] = (i * (seed + 3) + seed * 17) & 255;
  return d;
}

/**
 * Builds an RGBA APNG. frames[0] is the IDAT image; `defaultInAnimation` puts an fcTL
 * before it; `split` spreads each fdAT frame over two chunks.
 */
function makeApng({ width, height, frames, defaultInAnimation = true, split = false, plays = 0 }) {
  const ihdr = { width, height, depth: 8, colorType: 6, interlace: 0 };
  const chunks = [{ type: 'IHDR', data: cat(u32(width, height), Uint8Array.of(8, 6, 0, 0, 0)) }];
  const animFrames = defaultInAnimation ? frames.length : frames.length - 1;
  chunks.push({ type: 'acTL', data: u32(animFrames, plays) });
  chunks.push({ type: 'tEXt', data: new TextEncoder().encode('Comment\0hello') });
  const fctl = (f) => ({ type: 'fcTL', data: cat(u32(0, f.w, f.h, f.x, f.y), Uint8Array.of(0, 1, 0, 10, 0, 0)) });
  frames.forEach((f, i) => {
    const z = encodeRaster({ ...ihdr, width: f.w, height: f.h }, f.rgba);
    if (i === 0) {
      if (defaultInAnimation) chunks.push(fctl(f));
      chunks.push({ type: 'IDAT', data: z.subarray(0, 10) }, { type: 'IDAT', data: z.subarray(10) });
      return;
    }
    chunks.push(fctl(f));
    const parts = split ? [z.subarray(0, 7), z.subarray(7)] : [z];
    for (const p of parts) chunks.push({ type: 'fdAT', data: cat(u32(0), p) });
  });
  chunks.push({ type: 'IEND', data: new Uint8Array(0) });
  let seq = 0;
  for (const c of chunks) if (c.type === 'fcTL' || c.type === 'fdAT') new DataView(c.data.buffer, c.data.byteOffset).setUint32(0, seq++);
  return writeChunks(chunks);
}

const FRAMES = [
  { w: 30, h: 20, x: 0, y: 0, rgba: rgba(30, 20, 1) },
  { w: 12, h: 9, x: 5, y: 4, rgba: rgba(12, 9, 2) }, // partial frame with an offset
  { w: 30, h: 20, x: 0, y: 0, rgba: rgba(30, 20, 1) }, // same content as frame 0
];

const framePixels = (bytes) => readPng(bytes).frames.map((f) => Buffer.from(f));
const sequenceNumbers = (bytes) => readChunks(bytes).filter((c) => c.type === 'fcTL' || c.type === 'fdAT')
  .map((c) => new DataView(c.data.buffer, c.data.byteOffset).getUint32(0));

for (const [name, opts] of [
  ['default image is frame 1', {}],
  ['default image outside the animation', { defaultInAnimation: false }],
  ['frames split over several fdAT chunks', { split: true }],
]) {
  test(`APNG round trip: ${name}`, () => {
    const src = makeApng({ width: 30, height: 20, frames: FRAMES, ...opts });
    for (const m of [{ mode: 'pixel' }, { mode: 'block', block: 4 }]) {
      const scrambled = encode(src, { key: 'k', ...m });
      const info = inspect(scrambled);
      assert.equal(info.animated, true);
      assert.equal(info.scrambled, true);
      // Every frame is scrambled, each with its own permutation.
      const s = framePixels(scrambled), o = framePixels(src);
      s.forEach((f, i) => assert.ok(!f.equals(o[i]), `frame ${i} scrambled`));
      assert.ok(!s[2].equals(s[0]), 'identical frames scramble differently');
      assert.deepEqual(sequenceNumbers(scrambled), [...sequenceNumbers(scrambled).keys()], 'sequence numbers 0..n');
      const types = readChunks(scrambled).map((c) => c.type);
      if (opts.defaultInAnimation !== false) assert.equal(types[types.indexOf('IDAT') - 1], 'fcTL', 'fcTL stays right before its IDAT');
      assert.ok(types.indexOf('pmIx') < types.indexOf('IDAT'));
      // Plain viewers still read the default image.
      assert.equal(PNG.sync.read(Buffer.from(scrambled)).width, 30);

      const restored = decode(scrambled, { key: 'k' });
      assert.deepEqual(framePixels(restored), o);
      const keep = (b) => readChunks(b).filter((c) => !['IDAT', 'fdAT', 'fcTL', 'pmIx'].includes(c.type))
        .map((c) => c.type + Buffer.from(c.data).toString('hex'));
      assert.deepEqual(keep(restored), keep(src), 'acTL, tEXt etc. unchanged');
      const fctl = (b) => readChunks(b).filter((c) => c.type === 'fcTL').map((c) => Buffer.from(c.data.subarray(4)).toString('hex'));
      assert.deepEqual(fctl(restored), fctl(src), 'fcTL unchanged apart from the sequence number');
    }
  });
}

test('APNG rekey and inspect', () => {
  const src = makeApng({ width: 30, height: 20, frames: FRAMES, plays: 3 });
  const a = encode(src, { key: 'one' });
  const b = rekey(a, { from: 'one', to: 'two', mode: 'block', block: 5 });
  assert.deepEqual(framePixels(decode(b, { key: 'two' })), framePixels(src));
  const info = inspect(b);
  assert.deepEqual([info.frames, info.plays, info.mode], [3, 3, 'block']);
});

test('APNG to JPEG keeps the first frame and says so', () => {
  const src = makeApng({ width: 30, height: 20, frames: FRAMES });
  const r = convert(src, { format: 'jpeg' });
  assert.ok(r.dropped.includes('animation (first frame kept)'));
});

/** What a viewer shows for FRAMES (blend source, dispose none): frames drawn over each other. */
function composited(width, height, frames) {
  const canvas = new Uint8Array(width * height * 4);
  return frames.map((f) => {
    for (let y = 0; y < f.h; y++) canvas.set(f.rgba.subarray(y * f.w * 4, (y + 1) * f.w * 4), ((f.y + y) * width + f.x) * 4);
    return Buffer.from(canvas);
  });
}

for (const defaultInAnimation of [true, false]) {
  test(`APNG -> JPEG XL is an animation of the frames it shows (default image ${defaultInAnimation ? 'in' : 'outside'} it)`, async () => {
    const src = makeApng({ width: 30, height: 20, frames: FRAMES, defaultInAnimation, plays: 2 });
    let report;
    const s = await encodeAsync(src, { key: 'k', format: 'jxl', mode: 'block', block: 4, onConvert: (r) => { report = r; } });
    assert.ok(report.transferred.includes('animation'));
    assert.ok(!report.dropped.some((d) => d.startsWith('animation')), report.dropped.join());
    assert.deepEqual([inspect(s).animated, inspect(s).plays], [true, 2]);
    const anim = await (await loadJxlCodec()).decodeAnimation(await decodeAsync(s, { key: 'k' }));
    const want = composited(30, 20, defaultInAnimation ? FRAMES : FRAMES.slice(1));
    assert.deepEqual(anim.frames.map((f) => Buffer.from(f.data)), want);
    assert.deepEqual(anim.frames.map((f) => f.delay), want.map(() => [1, 10]), 'exact: 100 ms');
  });
}
