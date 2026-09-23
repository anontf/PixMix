import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { GifWriter } from 'omggif';
import { encodeAsync, decodeAsync, convertAsync, inspect } from '../src/index.js';
import { sharpDecoder } from '../src/plugins/sharp.js';
import { readPng } from '../src/formats/png/index.js';
import { readChunks } from '../src/formats/png/chunks.js';
import { toRGBA8 } from '../src/formats/png/rgba.js';
import { loadJxlCodec } from '../src/formats/jxl/load.js';

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

async function animatedJxl() {
  const buf = Buffer.alloc(1 << 14);
  const gw = new GifWriter(buf, 20, 12, { loop: 0, palette: [0x000000, 0xff0000, 0x00ff00, 0xffffff] });
  for (let f = 0; f < 3; f++) gw.addFrame(0, 0, 20, 12, Array.from({ length: 240 }, (_, i) => ((i >> 2) + f) & 3), { delay: 10 * (f + 1) });
  const gif = new Uint8Array(buf.subarray(0, gw.end()));
  return { gif, jxl: await (await loadJxlCodec()).runCjxl(gif, 'gif', ['--distance=0']) };
}

test('animated JPEG XL keeps every frame when converted to PNG', async () => {
  const { gif, jxl } = await animatedJxl();
  assert.equal(inspect(jxl).animated, true);
  const r = await convertAsync(jxl, { format: 'png' });
  assert.ok(r.transferred.includes('animation'));
  const fromGif = frameRgba((await convertAsync(gif, { format: 'png' })).bytes);
  assert.deepEqual(frameRgba(r.bytes), fromGif, 'same frames as the GIF it was made from');
  assert.deepEqual(delays(r.bytes), [0.1, 0.2, 0.3]);
  // And it scrambles/restores as an APNG.
  const s = await encodeAsync(jxl, { key: 'k', format: 'png' });
  assert.deepEqual(frameRgba(await decodeAsync(s, { key: 'k' })), fromGif);
});

test('animated JPEG XL kept as JPEG XL keeps the first frame and says so', async () => {
  const { jxl } = await animatedJxl();
  let report;
  await encodeAsync(jxl, { key: 'k', onConvert: (r) => { report = r; } });
  assert.ok(report.dropped.includes('animation (first frame kept)'));
});
