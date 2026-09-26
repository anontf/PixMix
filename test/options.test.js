// Option validation at the entry points, scrambled input, and grids too small to shuffle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import {
  encode, encodeAsync, decode, decodeAsync, rekey, rekeyAsync, inspect, convert, convertAsync, detectFormat,
} from '../src/index.js';
import { loadJxlCodec } from '../src/formats/jxl/load.js';
import { readJxl } from '../src/formats/jxl/container.js';
import { computeLayout } from '../src/core/layout.js';
import { readChunks } from '../src/formats/png/chunks.js';
import { readMarker } from '../src/core/params.js';

function png(w, h, { alpha = false, seed = 1 } = {}) {
  const img = new PNG({ width: w, height: h, colorType: alpha ? 6 : 2 });
  for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 37 + seed * 11 + (i >> 5)) & 255;
  if (!alpha) for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  return new Uint8Array(PNG.sync.write(img));
}
const pixels = (bytes) => Buffer.from(PNG.sync.read(Buffer.from(bytes)).data);
const rejects = (fn, code = 'BAD_OPTION') => assert.throws(fn, (e) => e.name === 'PixmixError' && e.code === code, String(fn));
const rejectsAsync = (fn, code = 'BAD_OPTION') => assert.rejects(fn, (e) => e.name === 'PixmixError' && e.code === code);
const markerOf = (bytes) => readMarker(readChunks(bytes).find((c) => c.type === 'pmIx').data).params;

const src = png(40, 24);
const jpg = new Uint8Array(await sharp(Buffer.from(src)).jpeg().toBuffer());

test('bad option values are BAD_OPTION errors, before any work', async () => {
  for (const opts of [
    { quality: NaN }, { quality: 'high' }, { quality: null }, { quality: 0 }, { quality: 101 },
    { subsampling: '4:1:1' }, { background: 'red' }, { background: '#12345' },
  ]) {
    rejects(() => encode(src, { key: 'k', format: 'jpeg', ...opts }));
    rejects(() => convert(src, { format: 'jpeg', ...opts }));
  }
  for (const opts of [
    { level: 10 }, { level: -1 }, { level: '5' }, { level: 1.5 }, { effort: 0 }, { effort: 10 }, { effort: 3.5 }, { effort: 'x' },
    { block: 1 }, { block: 4097 }, { block: '16' }, { mode: 'tiles' }, { transforms: 'no' }, { progressive: 1 },
    { keepThumbnails: 'yes' }, { decoders: {} }, { decoders: [{}] }, { salt: new Uint8Array(256) }, { salt: 'abc' },
    { key: '' }, { key: 5 }, { key: 'a\ud800b' },
  ]) {
    rejects(() => encode(src, { key: 'k', ...opts }));
    await rejectsAsync(() => encodeAsync(src, { key: 'k', ...opts }));
  }
  await rejectsAsync(() => convertAsync(src, { decoders: {} }));
  const scrambled = encode(src, { key: 'k' });
  rejects(() => decode(scrambled, { key: 'k', level: 12 }));
  rejects(() => decode(scrambled, { key: '\udc00' }));
  rejects(() => rekey(scrambled, { from: 'k', to: 'n', mode: 'mcu' }));
  rejects(() => rekey(scrambled, { from: 'k', to: 'n', format: 'jpeg' }));
  await rejectsAsync(() => rekeyAsync(scrambled, { from: 'k', to: 'n', transforms: 'no' }));
});

test('valid option values still work: quality range, #rgb background, well-formed keys', () => {
  const alpha = png(16, 16, { alpha: true });
  const a = encode(alpha, { key: 'k', format: 'jpeg', background: '#f80', quality: 1 });
  const b = encode(alpha, { key: 'k', format: 'jpeg', background: 'FF8800', quality: 1 });
  assert.equal(inspect(a).scrambled, true);
  assert.equal(inspect(b).scrambled, true);
  const key = 'emoji 😀 key';
  assert.deepEqual(pixels(decode(encode(src, { key }), { key })), pixels(src));
});

test('a salt of 255 bytes is the longest, and restores', () => {
  const salt = new Uint8Array(255).fill(7);
  const s = encode(src, { key: 'k', salt });
  assert.deepEqual(pixels(decode(s, { key: 'k' })), pixels(src));
  rejects(() => encode(jpg, { key: 'k', salt: new Uint8Array(300) }));
});

test('detectFormat takes ArrayBuffer and any view', () => {
  assert.equal(detectFormat(src.buffer.slice(src.byteOffset, src.byteOffset + src.length)), 'png');
  assert.equal(detectFormat(new DataView(src.buffer, src.byteOffset, src.length)), 'png');
  assert.equal(detectFormat(Buffer.from(jpg)), 'jpeg');
});

test('already-scrambled input is refused for every output format', async () => {
  const once = encode(src, { key: 'first' });
  const onceJpeg = encode(jpg, { key: 'first' });
  for (const format of ['png', 'jpeg']) {
    rejects(() => encode(once, { key: 'second', format }), 'ALREADY_SCRAMBLED');
    rejects(() => encode(onceJpeg, { key: 'second', format }), 'ALREADY_SCRAMBLED');
  }
  for (const format of ['png', 'jpeg', 'jxl']) {
    await rejectsAsync(() => encodeAsync(once, { key: 'second', format }), 'ALREADY_SCRAMBLED');
    await rejectsAsync(() => encodeAsync(onceJpeg, { key: 'second', format }), 'ALREADY_SCRAMBLED');
  }
  // Converting to another format would lose the marker; the same format keeps it.
  rejects(() => convert(once, { format: 'jpeg' }), 'ALREADY_SCRAMBLED');
  rejects(() => convert(onceJpeg, { format: 'png' }), 'ALREADY_SCRAMBLED');
  assert.equal(inspect(convert(once).bytes).scrambled, true);
});

test('JPEG XL: scrambled input is refused; convert keeps the boxes of an unchanged codestream', async () => {
  const codec = await loadJxlCodec();
  const once = await encodeAsync(src, { key: 'first', format: 'jxl' });
  for (const format of ['png', 'jpeg', 'jxl']) await rejectsAsync(() => encodeAsync(once, { key: 'second', format }), 'ALREADY_SCRAMBLED');
  await rejectsAsync(() => convertAsync(once, { format: 'png' }), 'ALREADY_SCRAMBLED');
  // JXL -> JXL copies the codestream: the marker stays valid, and so does the file.
  const kept = await convertAsync(once);
  assert.equal(inspect(kept.bytes).scrambled, true);
  assert.deepEqual(await decodeAsync(kept.bytes, { key: 'first' }).then((b) => codec.decode(b)).then((d) => Buffer.from(d.data)),
    await decodeAsync(once, { key: 'first' }).then((b) => codec.decode(b)).then((d) => Buffer.from(d.data)));
  // A recompressed JPEG keeps its reconstruction data (jbrd), so the JPEG still comes back.
  const recompressed = await codec.transcodeJpeg(jpg);
  const out = await convertAsync(recompressed);
  assert.ok(readJxl(out.bytes).boxes.some((b) => b.type === 'jbrd'));
  assert.deepEqual(Buffer.from(await codec.reconstructJpeg(out.bytes)), Buffer.from(jpg));
  assert.deepEqual(out.dropped, []);
  // A level-10 codestream keeps its level box.
  const d16 = new Uint16Array(16 * 16 * 4).map((_, i) => (i % 4 === 3 ? 65535 : (i * 4099) & 0xffff));
  const jxl16 = await codec.encode({ width: 16, height: 16, depth: 16, data: d16 });
  assert.ok(readJxl((await convertAsync(jxl16)).bytes).boxes.some((b) => b.type === 'jxll'));
});

test('an image of only a few tiles gets a smaller tile size, so it is really shuffled', async () => {
  for (const [w, h, opts, block] of [
    [16, 16, {}, 8], [16, 16, { transforms: false }, 5], [32, 16, {}, 8], [20, 17, { block: 16 }, 8],
    [64, 64, { block: 64 }, 32], [64, 64, { block: 64, transforms: false }, 21], [3, 3, { block: 2 }, null],
  ]) {
    const image = png(w, h);
    let same = 0;
    for (let i = 0; i < 16; i++) {
      const s = encode(image, { key: `key${i}`, mode: 'block', ...opts });
      const params = markerOf(s);
      if (block) assert.equal(params.block & 0x7fff, block, `${w}x${h}`);
      else assert.equal(params.mode, 'pixel', `${w}x${h}`);
      assert.equal(inspect(s).block, block);
      if (pixels(s).equals(pixels(image))) same++;
      assert.deepEqual(pixels(decode(s, { key: `key${i}` })), pixels(image));
    }
    assert.equal(same, 0, `${w}x${h}: never left as it was`);
  }
  // Images that tile well keep the tile size they asked for.
  assert.equal(markerOf(encode(png(64, 64), { key: 'k' })).block & 0x7fff, 16);
  assert.equal(markerOf(encode(png(40, 24), { key: 'k', block: 8 })).block & 0x7fff, 8);
  assert.equal(markerOf(encode(png(32, 32), { key: 'k' })).block & 0x7fff, 16);
  // Existing files keep decoding with the params in their marker.
  const params = { version: 1, mode: 'block', block: 16 | 0x8000, salt: new Uint8Array(16) };
  assert.equal(computeLayout('k', params, 16, 16).tiles.perm.length, 1);
  // JPEG XL (pixel route) gets the same treatment.
  const jxl = await encodeAsync(png(16, 16), { key: 'k', format: 'jxl', mode: 'block' });
  assert.equal(inspect(jxl).block, 8);
});
