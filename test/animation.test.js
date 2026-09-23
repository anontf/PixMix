import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { GifWriter } from 'omggif';
import { encodeAsync, decodeAsync, rekeyAsync, convertAsync, inspect } from '../src/index.js';
import { sharpDecoder } from '../src/plugins/sharp.js';
import { readPng } from '../src/formats/png/index.js';
import { readChunks } from '../src/formats/png/chunks.js';
import { toRGBA8 } from '../src/formats/png/rgba.js';
import { loadJxlCodec } from '../src/formats/jxl/load.js';
import { readWebpLoopCount } from '../src/meta/webp.js';

const frameRgba = (png) => { const p = readPng(png); return p.frames.map((f) => Buffer.from(toRGBA8(p, f))); };
const delays = (png) => readChunks(png).filter((c) => c.type === 'fcTL').map((c) => {
  const b = Buffer.from(c.data);
  return b.readUInt16BE(20) / b.readUInt16BE(22);
});
const solid = (w, h, [r, g, b]) => Buffer.from(new Uint8Array(w * h * 4).map((_, i) => [r, g, b, 255][i % 4]));

test('animated WebP (via sharp) becomes an APNG with all frames, delays and loops', async () => {
  const colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  const frames = await Promise.all(colours.map((c) => sharp(solid(24, 16, c), { raw: { width: 24, height: 16, channels: 4 } }).png().toBuffer()));
  const webp = await sharp(frames, { join: { animated: true } }).webp({ loop: 3, delay: [100, 200, 300], lossless: true }).toBuffer();
  let report;
  const scrambled = await encodeAsync(webp, { key: 'k', mode: 'block', block: 4, decoders: [sharpDecoder(sharp)], onConvert: (r) => { report = r; } });
  assert.equal(report.from, 'webp');
  assert.ok(report.transferred.includes('animation'));
  assert.ok(!report.dropped.some((d) => d.startsWith('animation')));
  const info = inspect(scrambled);
  assert.deepEqual([info.animated, info.frames, info.plays], [true, 3, 3]);
  const restored = await decodeAsync(scrambled, { key: 'k' });
  assert.deepEqual(frameRgba(restored), colours.map((c) => solid(24, 16, c)));
  assert.deepEqual(delays(restored), [0.1, 0.2, 0.3]);
});

test('WebP loop count comes from the ANIM chunk (the browser plugin trusts it over ImageDecoder)', async () => {
  const frames = await Promise.all([[255, 0, 0], [0, 0, 255]].map((c) => sharp(solid(8, 8, c), { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer()));
  const webp = (loop) => sharp(frames, { join: { animated: true } }).webp({ loop, lossless: true }).toBuffer();
  assert.equal(readWebpLoopCount(await webp(2)), 2);
  assert.equal(readWebpLoopCount(await webp(0)), 0);
  assert.equal(readWebpLoopCount(await sharp(frames[0]).webp().toBuffer()), null);
});

function animatedGif({ frames = 3, same = false } = {}) {
  const buf = Buffer.alloc(1 << 14);
  const gw = new GifWriter(buf, 20, 12, { loop: 0, palette: [0x000000, 0xff0000, 0x00ff00, 0xffffff] });
  for (let f = 0; f < frames; f++) gw.addFrame(0, 0, 20, 12, Array.from({ length: 240 }, (_, i) => ((i >> 2) + (same ? 0 : f)) & 3), { delay: 10 * (f + 1) });
  return new Uint8Array(buf.subarray(0, gw.end()));
}

async function animatedJxl() {
  const gif = animatedGif();
  const r = await convertAsync(gif, { format: 'jxl' });
  assert.ok(r.transferred.includes('animation'), 'GIF -> JPEG XL keeps the animation');
  assert.ok(!r.dropped.some((d) => d.startsWith('animation')), r.dropped.join());
  return { gif, jxl: r.bytes };
}

const jxlFrames = async (jxl) => (await (await loadJxlCodec()).decodeAnimation(jxl)).frames;
const rgbaFrames = (frames) => frames.map((f) => Buffer.from(f.data));

test('animated JPEG XL keeps every frame when converted to PNG', async () => {
  const { gif, jxl } = await animatedJxl();
  const info = inspect(jxl);
  assert.deepEqual([info.animated, info.plays], [true, 0]);
  const r = await convertAsync(jxl, { format: 'png' });
  assert.ok(r.transferred.includes('animation'));
  const fromGif = frameRgba((await convertAsync(gif, { format: 'png' })).bytes);
  assert.deepEqual(frameRgba(r.bytes), fromGif, 'same frames as the GIF it was made from');
  assert.deepEqual(delays(r.bytes), [0.1, 0.2, 0.3]);
  // And it scrambles/restores as an APNG.
  const s = await encodeAsync(jxl, { key: 'k', format: 'png' });
  assert.deepEqual(frameRgba(await decodeAsync(s, { key: 'k' })), fromGif);
});

for (const opts of [{ mode: 'pixel' }, { mode: 'block', block: 4 }]) {
  test(`animated JPEG XL stays animated as JPEG XL, every frame restored exactly (${opts.mode})`, async () => {
    const { gif, jxl } = await animatedJxl();
    let report;
    const s = await encodeAsync(jxl, { key: 'k', ...opts, onConvert: (r) => { report = r; } });
    assert.deepEqual(report.dropped, []);
    assert.equal(inspect(s).animated, true);
    const original = await jxlFrames(jxl);
    const scrambled = await jxlFrames(s);
    assert.equal(scrambled.length, 3);
    scrambled.forEach((f, i) => assert.ok(!Buffer.from(f.data).equals(Buffer.from(original[i].data)), `frame ${i} scrambled`));
    const restored = await decodeAsync(s, { key: 'k' });
    assert.deepEqual(rgbaFrames(await jxlFrames(restored)), rgbaFrames(original));
    assert.deepEqual(delays((await convertAsync(restored, { format: 'png' })).bytes), [0.1, 0.2, 0.3]);
    assert.deepEqual(frameRgba((await convertAsync(restored, { format: 'png' })).bytes), frameRgba((await convertAsync(gif, { format: 'png' })).bytes));
    const r = await rekeyAsync(s, { from: 'k', to: 'k2', mode: 'block', block: 5 });
    assert.deepEqual(rgbaFrames(await jxlFrames(await decodeAsync(r, { key: 'k2' }))), rgbaFrames(original));
  });
}

test('identical animation frames scramble differently (the frame index is in the seed)', async () => {
  const gif = animatedGif({ same: true });
  const s = await encodeAsync(gif, { key: 'k', format: 'jxl' });
  const [a, b] = await jxlFrames(s);
  assert.ok(!Buffer.from(a.data).equals(Buffer.from(b.data)));
  const restored = await jxlFrames(await decodeAsync(s, { key: 'k' }));
  assert.ok(Buffer.from(restored[0].data).equals(Buffer.from(restored[1].data)));
});

test('animated WebP (via sharp) becomes an animated JPEG XL with its delays and loops', async () => {
  const colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  const frames = await Promise.all(colours.map((c) => sharp(solid(24, 16, c), { raw: { width: 24, height: 16, channels: 4 } }).png().toBuffer()));
  const webp = await sharp(frames, { join: { animated: true } }).webp({ loop: 3, delay: [100, 200, 300], lossless: true }).toBuffer();
  let report;
  const s = await encodeAsync(webp, { key: 'k', format: 'jxl', decoders: [sharpDecoder(sharp)], onConvert: (r) => { report = r; } });
  assert.ok(report.transferred.includes('animation'));
  assert.deepEqual([inspect(s).animated, inspect(s).plays], [true, 3]);
  const png = (await convertAsync(await decodeAsync(s, { key: 'k' }), { format: 'png' })).bytes;
  assert.deepEqual(frameRgba(png), colours.map((c) => solid(24, 16, c)));
  assert.deepEqual(delays(png), [0.1, 0.2, 0.3]);
});
