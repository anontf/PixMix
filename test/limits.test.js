import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, brotliCompressSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GifWriter } from 'omggif';
import sharp from 'sharp';
import {
  encode, encodeAsync, decode, decodeAsync, rekey, inspect, convert, convertAsync, DEFAULT_LIMITS,
} from '../src/index.js';
import { sharpDecoder } from '../src/plugins/sharp.js';
import { writeChunks } from '../src/formats/png/chunks.js';
import { writeJxl } from '../src/formats/jxl/container.js';
import { loadJxlCodec } from '../src/formats/jxl/load.js';
import { writeSegments, readSegments, M } from '../src/formats/jpeg/markers.js';
import { restoreForDisplay } from '../src/browser/index.js';

const u32 = (...v) => { const b = new Uint8Array(v.length * 4); const dv = new DataView(b.buffer); v.forEach((x, i) => dv.setUint32(i * 4, x)); return b; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const isLimit = (re) => (err) => err.name === 'PixmixError' && err.code === 'LIMIT' && (!re || re.test(err.message));

/** A PNG with the given IHDR size (grey 8-bit) and whatever IDAT payload. */
function png(width, height, idat = deflateSync(new Uint8Array(height * (width + 1))), extra = []) {
  return writeChunks([
    { type: 'IHDR', data: cat(u32(width, height), Uint8Array.of(8, 0, 0, 0, 0)) },
    ...extra,
    { type: 'IDAT', data: idat },
    { type: 'IEND', data: new Uint8Array(0) },
  ]);
}

test('DEFAULT_LIMITS are exported and frozen', () => {
  assert.equal(DEFAULT_LIMITS.maxPixels, 100_000_000);
  assert.ok(Object.isFrozen(DEFAULT_LIMITS));
  assert.throws(() => encode(png(4, 4), { key: 'k', limits: { maxPixels: -1 } }), /positive number/);
  assert.throws(() => encode(png(4, 4), { key: 'k', limits: { maxPixel: 5 } }), /Unknown limit "maxPixel"/);
});

test('PNG: IHDR size is checked before any image data is inflated', () => {
  // 60000 x 60000 claimed, 20 bytes of data: rejected up front, nothing allocated.
  const big = png(60000, 60000, deflateSync(new Uint8Array(10)));
  for (const run of [() => encode(big, { key: 'k' }), () => inspect(big), () => convert(big, { format: 'jpeg' })]) {
    assert.throws(run, isLimit(/60000x60000 \(3600 megapixels\).*limits\.maxPixels/));
  }
  const small = png(40, 30);
  assert.throws(() => encode(small, { key: 'k', limits: { maxPixels: 1000 } }), isLimit(/40x30/));
  assert.ok(encode(small, { key: 'k', limits: { maxPixels: 1200 } }));
});

test('PNG: a decompression bomb stops at the size the IHDR declares', () => {
  // 32 MiB of zeros in ~32 KiB of deflate, for a 16 x 16 image: only 272 bytes are inflated.
  const bomb = png(16, 16, deflateSync(new Uint8Array(32 * 2 ** 20)));
  const start = performance.now();
  const out = encode(bomb, { key: 'k' });
  assert.equal(decode(out, { key: 'k' }).length > 0, true);
  assert.ok(performance.now() - start < 2000, 'did not inflate the whole stream');
  // And the raster itself is capped by maxDecompressedBytes.
  assert.throws(() => encode(png(4000, 4000), { key: 'k', limits: { maxDecompressedBytes: 2 ** 20 } }), isLimit(/limits\.maxDecompressedBytes/));
});

test('PNG: compressed metadata (zTXt, iCCP) is capped by maxMetadataBytes', () => {
  const ztxt = { type: 'zTXt', data: cat(ascii('Comment\0\0'), deflateSync(new Uint8Array(2 * 2 ** 20))) };
  const input = png(8, 8, undefined, [ztxt]);
  assert.throws(() => convert(input, { format: 'jpeg', limits: { maxMetadataBytes: 2 ** 20 } }), isLimit(/metadata chunk.*maxMetadataBytes/));
  assert.ok(convert(input, { format: 'jpeg' }).bytes.length > 0); // 2 MiB is under the default
});

test('APNG and GIF: frame counts and total pixels are checked', () => {
  const frames = 5;
  const buf = new Uint8Array(4096);
  const gw = new GifWriter(buf, 8, 8, { loop: 0, palette: [0, 0xffffff] });
  for (let i = 0; i < frames; i++) gw.addFrame(0, 0, 8, 8, new Uint8Array(64).fill(i & 1), { delay: 5 });
  const gif = buf.slice(0, gw.end());
  assert.throws(() => encode(gif, { key: 'k', limits: { maxFrames: 4 } }), isLimit(/5 frames.*maxFrames/));
  assert.throws(() => encode(gif, { key: 'k', limits: { maxTotalPixels: 300 } }), isLimit(/maxTotalPixels/));
  const apng = encode(gif, { key: 'k' });
  assert.equal(inspect(apng).frames, frames);
  assert.throws(() => decode(apng, { key: 'k', limits: { maxFrames: 4 } }), isLimit(/maxFrames/));
  assert.throws(() => inspect(apng, { limits: { maxFrames: 4 } }), isLimit(/maxFrames/));
});

test('GIF: the logical screen and each frame are checked before omggif allocates', () => {
  const gif = cat(ascii('GIF89a'), Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0, 0, 0), ascii(';'));
  assert.throws(() => encode(gif, { key: 'k' }), isLimit(/65535x65535/));
  // A 1x1 screen with a 60000x60000 frame.
  const frame = cat(ascii('GIF89a'), Uint8Array.of(1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255),
    Uint8Array.of(0x2c, 0, 0, 0, 0, 0x60, 0xea, 0x60, 0xea, 0, 2, 2, 0x4c, 0x01, 0), ascii(';'));
  assert.throws(() => encode(frame, { key: 'k' }), isLimit(/GIF frame 0 is 60000x60000/));
});

/** A JPEG whose SOF claims another size. */
async function jpegWithSize(width, height) {
  const src = new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#808080' } }).jpeg().toBuffer());
  const { segments } = readSegments(src);
  const sof = segments.find((s) => s.marker === M.SOF0);
  const data = sof.data.slice();
  data[1] = height >> 8; data[2] = height & 255; data[3] = width >> 8; data[4] = width & 255;
  return writeSegments(segments.map((s) => (s === sof ? { ...s, data } : s)));
}

test('JPEG: SOF size is checked before coefficient arrays are allocated', async () => {
  const big = await jpegWithSize(65535, 65535);
  for (const run of [() => encode(big, { key: 'k' }), () => inspect(big), () => convert(big, { format: 'png' })]) {
    assert.throws(run, isLimit(/65535x65535/));
  }
  const ok = await jpegWithSize(16, 16);
  assert.throws(() => encode(ok, { key: 'k', limits: { maxPixels: 100 } }), isLimit());
  const scrambled = encode(ok, { key: 'k' });
  assert.throws(() => decode(scrambled, { key: 'k', limits: { maxPixels: 100 } }), isLimit());
  assert.throws(() => rekey(scrambled, { from: 'k', to: 'j', limits: { maxPixels: 100 } }), isLimit());
});

test('JPEG: the number of scans is capped', async () => {
  const src = new Uint8Array(await sharp({ create: { width: 32, height: 32, channels: 3, background: '#406080' } }).jpeg({ progressive: true }).toBuffer());
  const scans = readSegments(src).segments.filter((s) => s.marker === M.SOS).length;
  assert.ok(scans > 3);
  assert.throws(() => encode(src, { key: 'k', limits: { maxScans: 3 } }), isLimit(new RegExp(`${scans} scans.*maxScans`)));
  assert.ok(encode(src, { key: 'k', limits: { maxScans: scans } }));
});

test('maxInputBytes and maxChunks', async () => {
  const input = png(20, 20);
  for (const run of [
    () => encode(input, { key: 'k', limits: { maxInputBytes: 50 } }),
    () => decode(input, { key: 'k', limits: { maxInputBytes: 50 } }),
    () => inspect(input, { limits: { maxInputBytes: 50 } }),
    () => convert(input, { format: 'jpeg', limits: { maxInputBytes: 50 } }),
  ]) assert.throws(run, isLimit(/maxInputBytes/));
  await assert.rejects(encodeAsync(input, { key: 'k', limits: { maxInputBytes: 50 } }), isLimit(/maxInputBytes/));
  await assert.rejects(convertAsync(input, { format: 'jxl', limits: { maxInputBytes: 50 } }), isLimit(/maxInputBytes/));
  const texts = Array.from({ length: 20 }, () => ({ type: 'tEXt', data: ascii('a\0b') }));
  assert.throws(() => encode(png(4, 4, undefined, texts), { key: 'k', limits: { maxChunks: 10 } }), isLimit(/more than 10 chunks/));
});

/** A bare JPEG XL codestream header claiming width x height (rest missing). */
function jxlHeader(width, height) {
  const bits = [];
  const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
  put(0xff, 8); put(0x0a, 8);
  put(0, 1); // not small
  put(3, 2); put(height - 1, 30); // height, 30-bit distribution
  put(0, 3); // no ratio
  put(3, 2); put(width - 1, 30);
  put(1, 1); // all_default metadata
  const out = new Uint8Array(Math.ceil(bits.length / 8) + 4);
  bits.forEach((b, i) => { out[i >> 3] |= b << (i & 7); });
  return out;
}

test('JPEG XL: header size is checked before the decoder runs', async () => {
  const big = jxlHeader(100000, 100000);
  assert.throws(() => inspect(big), isLimit(/100000x100000/));
  await assert.rejects(encodeAsync(big, { key: 'k' }), isLimit(/100000x100000/));
  await assert.rejects(convertAsync(big, { format: 'png' }), isLimit(/100000x100000/));
  const codec = await loadJxlCodec();
  const data = new Uint8Array(24 * 16 * 4).fill(90);
  const small = writeJxl([], await codec.encode({ width: 24, height: 16, data }));
  await assert.rejects(encodeAsync(small, { key: 'k', limits: { maxPixels: 100 } }), isLimit(/24x16/));
  const scrambled = await encodeAsync(small, { key: 'k' });
  await assert.rejects(decodeAsync(scrambled, { key: 'k', limits: { maxPixels: 100 } }), isLimit());
  // The WASM decoder enforces the limit itself too (a caller could skip the JS check).
  await assert.rejects(codec.decode(small, { limits: { maxPixels: 100 } }), isLimit(/24x16.*maxPixels/));
});

test('JPEG XL: brob boxes are capped by maxMetadataBytes', async () => {
  const codec = await loadJxlCodec();
  const cs = await codec.encode({ width: 8, height: 8, data: new Uint8Array(256).fill(7) });
  const xmp = cat(ascii('xml '), brotliCompressSync(new Uint8Array(4 * 2 ** 20).fill(32)));
  const input = writeJxl([{ type: 'brob', data: xmp }], cs);
  await assert.rejects(convertAsync(input, { format: 'png', limits: { maxMetadataBytes: 2 ** 20 } }), isLimit(/compressed xml box/));
  assert.ok((await convertAsync(input, { format: 'png' })).bytes.length > 0);
});

test('sharp plugin: limitInputPixels follows limits.maxPixels', async () => {
  const webp = new Uint8Array(await sharp({ create: { width: 100, height: 80, channels: 3, background: '#123456' } }).webp().toBuffer());
  const decoders = [sharpDecoder(sharp)];
  await assert.rejects(encodeAsync(webp, { key: 'k', decoders, limits: { maxPixels: 5000 } }), isLimit());
  assert.ok(await encodeAsync(webp, { key: 'k', decoders, limits: { maxPixels: 8000 } }));
});

test('browser decoder: restoreForDisplay takes limits', async () => {
  const scrambled = encode(png(40, 30), { key: 'k' });
  await assert.rejects(restoreForDisplay(scrambled, { key: 'k', worker: false, limits: { maxPixels: 1000 } }), isLimit(/40x30/));
  const { type } = await restoreForDisplay(scrambled, { key: 'k', worker: false });
  assert.equal(type, 'image/png');
});

test('CLI: --max-pixels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pixmix-limits-'));
  try {
    const file = join(dir, 'in.png');
    writeFileSync(file, png(40, 30));
    const cli = new URL('../bin/pixmix.js', import.meta.url).pathname;
    const run = (...args) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { env: { ...process.env, PIXMIX_KEY: 'k' }, stdio: 'pipe' }).toString() };
      } catch (err) {
        return { code: err.status, out: err.stderr.toString() };
      }
    };
    const refused = run('encode', file, '--max-pixels', '1000', '-o', join(dir, 'out.png'));
    assert.equal(refused.code, 1);
    assert.match(refused.out, /40x30 .*limits\.maxPixels/);
    assert.equal(run('inspect', file, '--max-pixels', '1000').code, 1);
    assert.equal(run('encode', file, '--max-pixels', 'lots').code, 2);
    assert.equal(run('encode', file, '--max-pixels', '1200', '-o', join(dir, 'out.png')).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
