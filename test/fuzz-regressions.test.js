// Regression tests for the bugs the fuzzer found (test/fuzz). Each input is the minimal
// shape of the failing case, built here rather than stored as a binary. Every one used to
// throw something other than a PixmixError, or hang.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import { GifReader, GifWriter } from 'omggif';
import { gifDecoder } from '../src/convert/decoders.js';
import { encode, encodeAsync, decode, decodeAsync, rekeyAsync, inspect, convert, convertAsync } from '../src/index.js';
import { compute } from '../src/browser/compute.js';
import { sharpDecoder } from '../src/plugins/sharp.js';
import { writeChunks } from '../src/formats/png/chunks.js';
import { encodeRaster } from '../src/formats/png/raster.js';
import { writeJxl } from '../src/formats/jxl/container.js';
import { loadJxlCodec } from '../src/formats/jxl/load.js';
import { readSegments, writeSegments, M } from '../src/formats/jpeg/markers.js';
import { assembleJpeg } from '../src/formats/jpeg/encode.js';
import { encodePixels } from '../src/formats/jpeg/fdct.js';
import { makeParams, writeMarker } from '../src/core/params.js';
import { computeGridLayout } from '../src/core/layout.js';

const u32 = (...v) => { const b = new Uint8Array(v.length * 4); const dv = new DataView(b.buffer); v.forEach((x, i) => dv.setUint32(i * 4, x)); return b; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const JXL_SIGNATURE = Uint8Array.of(0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a);

/** Asserts `run` rejects with a PixmixError (optionally of `code`). */
async function rejectsPixmix(run, code) {
  await assert.rejects(async () => run(), (err) => {
    assert.equal(err.name === 'PixmixError' || err.name === 'WrongKeyError', true, `${err.name}: ${err.message}`);
    if (code) assert.equal(err.code, code, err.message);
    return true;
  });
}

/**
 * Runs pixmix's `fn(input, opts)` in a worker, so that a regression to a hang fails the
 * test instead of stalling it. Resolves to 'ok', '<error name> <code>' or 'hang'.
 */
async function inWorker(fn, input, opts) {
  const worker = new Worker(`
    const { workerData: w, parentPort } = require('node:worker_threads');
    import(w.url).then((pixmix) => {
      try { pixmix[w.fn](w.input, w.opts); parentPort.postMessage('ok'); }
      catch (err) { parentPort.postMessage(err.name + ' ' + err.code); }
    });`, { eval: true, workerData: { fn, input, opts, url: new URL('../src/index.js', import.meta.url).href } });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { worker.terminate(); resolve('hang'); }, 10000);
    worker.once('message', (m) => { clearTimeout(timer); worker.terminate(); resolve(m); });
  });
}

/** GIF89a with a 4x4 screen, a 2-bit palette and one frame of the given LZW codes. */
function gifWithCodes(codes) {
  let acc = 0, bits = 0;
  const data = [];
  for (const [code, size] of codes) {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) { data.push(acc & 255); acc >>>= 8; bits -= 8; }
  }
  if (bits) data.push(acc & 255);
  return cat(ascii('GIF89a'), Uint8Array.of(4, 0, 4, 0, 0x81, 0, 0), new Uint8Array(12).fill(200),
    Uint8Array.of(0x2c, 0, 0, 0, 0, 4, 0, 4, 0, 0, 2, data.length, ...data, 0), ascii(';'));
}

test('GIF: an LZW code past the end of the table no longer loops forever', async () => {
  // Literal 0, then 7 (the table only reaches 6): omggif then defined entry 7 as its own
  // prefix, and expanding it never ended. Run in a worker, so a regression fails, not hangs.
  const gif = gifWithCodes([[4, 3], [0, 3], [7, 3], [6, 3], [7, 4], [5, 4]]);
  const outcome = await inWorker('convert', gif, { format: 'png' });
  assert.ok(outcome === 'ok' || outcome.startsWith('PixmixError'), outcome);
});

test('GIF: pixmix\'s own LZW decoder matches omggif on valid files', () => {
  const w = 37, h = 23;
  const buf = new Uint8Array(1 << 16);
  const gw = new GifWriter(buf, w, h, { palette: Array.from({ length: 256 }, (_, i) => i * 0x010101) });
  gw.addFrame(0, 0, w, h, Uint8Array.from({ length: w * h }, (_, i) => (i * 31) ^ (i >> 3)));
  gw.addFrame(0, 0, w, h, Uint8Array.from({ length: w * h }, (_, i) => (i / 50) | 0), { interlaced: true });
  const gif = buf.slice(0, gw.end());
  const reader = new GifReader(gif);
  // Both frames cover the whole screen, so composited frames equal omggif's own blits.
  const theirs = [0, 1].map((i) => { const d = new Uint8Array(w * h * 4); reader.decodeAndBlitFrameRGBA(i, d); return d; });
  const ours = gifDecoder.decode(gif, 'gif').animation.frames.map((f) => f.data);
  assert.deepEqual(ours, theirs);
  // …and the KwKwK case: clear, 1, 1, 6 (= "1 1", used as it is defined), 2 x 12, eoi.
  const kwk = gifWithCodes([[4, 3], [1, 3], [1, 3], [6, 3], ...Array(12).fill([2, 4]), [5, 4]]);
  const px = gifDecoder.decode(kwk, 'gif').data;
  assert.deepEqual([...px.subarray(0, 16)], [200, 200, 200, 255, 200, 200, 200, 255, 200, 200, 200, 255, 200, 200, 200, 255]);
});

test('GIF: a file with no image is a PixmixError, not omggif\'s "Frame index out of range"', async () => {
  const gif = cat(ascii('GIF89a'), Uint8Array.of(1, 0, 1, 0, 0, 0, 0), ascii(';'));
  await rejectsPixmix(() => encode(gif, { key: 'k' }), 'BAD_GIF');
  await rejectsPixmix(() => convertAsync(gif, { format: 'jxl' }), 'BAD_GIF');
});

test('GIF: a 0x0 screen is refused before the JPEG XL encoder sees it', async () => {
  const gif = cat(ascii('GIF89a'), Uint8Array.of(0, 0, 0, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255),
    Uint8Array.of(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0), ascii(';'));
  await rejectsPixmix(() => convertAsync(gif, { format: 'jxl' }));
  await rejectsPixmix(() => encode(gif, { key: 'k' }));
});

test('PNG: a palette image without PLTE is refused (it crashed the browser reveal)', async () => {
  const ihdr = { width: 3, height: 2, depth: 8, colorType: 3, interlace: 0 };
  const png = writeChunks([
    { type: 'IHDR', data: cat(u32(3, 2), Uint8Array.of(8, 3, 0, 0, 0)) },
    { type: 'IDAT', data: encodeRaster(ihdr, new Uint8Array(6)) },
    { type: 'IEND', data: new Uint8Array(0) },
  ]);
  await rejectsPixmix(() => convert(png, { format: 'jpeg' }), 'BAD_PNG');
  await rejectsPixmix(() => encode(png, { key: 'k' }), 'BAD_PNG');
  await rejectsPixmix(() => compute(png, 'k'), 'BAD_PNG');
});

test('APNG: fdAT frames without an IDAT image are refused (they were written back as a broken IDAT)', async () => {
  // Frame data before any IDAT became "frame 0" and was written out as the IDAT image at its
  // own, smaller size: encode succeeded, and decoding its output failed.
  const ihdr = { width: 8, height: 6, depth: 8, colorType: 0, interlace: 0 };
  const fctl = (seq) => ({ type: 'fcTL', data: cat(u32(seq, 4, 3, 0, 0), Uint8Array.of(0, 1, 0, 10, 0, 0)) });
  const fdat = (seq) => ({ type: 'fdAT', data: cat(u32(seq), encodeRaster({ ...ihdr, width: 4, height: 3 }, new Uint8Array(12).fill(9))) });
  const png = writeChunks([
    { type: 'IHDR', data: cat(u32(8, 6), Uint8Array.of(8, 0, 0, 0, 0)) }, { type: 'acTL', data: u32(1, 0) },
    fctl(0), fdat(1), { type: 'IEND', data: new Uint8Array(0) },
  ]);
  await rejectsPixmix(() => encode(png, { key: 'k' }), 'BAD_PNG');
});

/** A 16x16 colour JPEG from sharp with every component's sampling factors replaced. */
async function jpegWithSampling(factor) {
  const src = new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#808080' } }).jpeg().toBuffer());
  const { segments } = readSegments(src);
  const sof = segments.find((s) => s.marker === M.SOF0);
  const data = sof.data.slice();
  for (let i = 0; i < 3; i++) data[7 + 3 * i] = factor;
  return writeSegments(segments.map((s) => (s === sof ? { ...s, data } : s)));
}

test('JPEG: sampling factors of 0 are refused (the MCU grid was infinite: a hang, or a RangeError)', async () => {
  assert.equal(await inWorker('encode', await jpegWithSampling(0x00), { key: 'k' }), 'PixmixError BAD_JPEG');
  await rejectsPixmix(async () => decode(await jpegWithSampling(0x10), { key: 'k' }), 'BAD_JPEG');
  assert.ok(encode(await jpegWithSampling(0x22), { key: 'k' })); // 2x2 everywhere is fine
});

test('JPEG: a coefficient that overflowed on decoding is refused, not written as a garbled stream', async () => {
  // A successive-approximation shift of 15 turns an AC value of 1 into 32768, which wraps
  // to -32768 in the Int16 coefficients: category 16, which an AC symbol cannot hold. The
  // encoder used to write it anyway, and decode of its own output failed or differed.
  const { frame, dqt } = encodePixels({ width: 16, height: 16, data: new Uint8Array(1024).fill(128) }, { quality: 90, subsampling: '4:4:4', grey: false });
  frame.components[0].coefs[1] = -32768;
  for (const progressive of [false, true]) {
    assert.throws(() => assembleJpeg([dqt], frame, { progressive }), (err) => err.name === 'PixmixError' && err.code === 'BAD_JPEG');
  }
  // End to end, from a progressive JPEG with Al = 15 in an AC scan.
  const src = new Uint8Array(await sharp(Buffer.alloc(32 * 32 * 3).map((_, i) => (i * 37) & 255), { raw: { width: 32, height: 32, channels: 3 } })
    .jpeg({ progressive: true, quality: 95 }).toBuffer());
  const { segments } = readSegments(src);
  let tried = 0;
  for (const scan of segments.filter((s) => s.marker === M.SOS && s.data[1 + s.data[0] * 2] > 0)) {
    const data = scan.data.slice();
    data[3 + data[0] * 2] = (data[3 + data[0] * 2] & 0xf0) | 15;
    const jpeg = writeSegments(segments.map((s) => (s === scan ? { ...s, data } : s)));
    let scrambled;
    try { scrambled = encode(jpeg, { key: 'k' }); } catch (err) { assert.equal(err.name, 'PixmixError'); tried++; continue; }
    assert.ok(decode(scrambled, { key: 'k' }), 'whatever encode writes, decode reads');
    tried++;
  }
  assert.ok(tried > 0);
});

test('JPEG XL: a box with a 64-bit size cut off inside its header', async () => {
  const jxl = cat(JXL_SIGNATURE, u32(1), ascii('jxlc'), new Uint8Array(4));
  await rejectsPixmix(() => inspect(jxl), 'BAD_JXL');
  await rejectsPixmix(() => decodeAsync(jxl, { key: 'k' }), 'BAD_JXL');
});

test('JPEG XL: a JPEG-route marker without reconstruction data', async () => {
  // A pixel image carrying an mcu-mode marker: there is no JPEG inside to reveal or rekey.
  const codec = await loadJxlCodec();
  const cs = await codec.encode({ width: 8, height: 8, data: new Uint8Array(256).fill(120) });
  const params = makeParams({ mode: 'mcu' });
  const marker = writeMarker(params, computeGridLayout('k', params, 1, 1).check);
  const jxl = writeJxl([{ type: 'pmIx', data: marker }], cs);
  await rejectsPixmix(() => compute(jxl, 'k'), 'BAD_JXL');
  await rejectsPixmix(() => rekeyAsync(jxl, { from: 'k', to: 'j' }), 'BAD_JXL');
  await rejectsPixmix(() => decodeAsync(jxl, { key: 'k' }), 'BAD_JXL');
});

test('JPEG XL: decoder errors (jxl-oxide) come out as PixmixErrors', async () => {
  const codec = await loadJxlCodec();
  const cs = await codec.encode({ width: 16, height: 16, data: new Uint8Array(1024).map((_, i) => i * 7) });
  const broken = cs.slice();
  for (let i = 12; i < broken.length; i += 3) broken[i] ^= 0x5a;
  await rejectsPixmix(() => encodeAsync(broken, { key: 'k' }), 'BAD_JXL');
  await rejectsPixmix(() => convertAsync(broken, { format: 'png' }), 'BAD_JXL');
  // …and the decoder keeps working afterwards.
  assert.equal((await codec.decode(cs)).width, 16);
});

test('sharp plugin: libvips errors on a corrupt WebP come out as PixmixErrors', async () => {
  const webp = new Uint8Array(await sharp({ create: { width: 20, height: 10, channels: 3, background: '#335577' } }).webp().toBuffer());
  const broken = webp.slice(0, 40);
  const decoders = [sharpDecoder(sharp)];
  await rejectsPixmix(() => encodeAsync(broken, { key: 'k', decoders }), 'BAD_WEBP');
  await rejectsPixmix(() => convertAsync(broken, { format: 'jpeg', decoders }), 'BAD_WEBP');
});

test('decode of a scrambled file is still fine after all that', () => {
  const png = writeChunks([
    { type: 'IHDR', data: cat(u32(4, 4), Uint8Array.of(8, 0, 0, 0, 0)) },
    { type: 'IDAT', data: encodeRaster({ width: 4, height: 4, depth: 8, colorType: 0, interlace: 0 }, new Uint8Array(16).map((_, i) => i * 16)) },
    { type: 'IEND', data: new Uint8Array(0) },
  ]);
  assert.ok(decode(encode(png, { key: 'k' }), { key: 'k' }).length > 0);
});
