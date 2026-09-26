// inspect() checks the same limits as decoding, and the three exported versions agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { GifWriter } from 'omggif';
import { inspect, encode } from '../src/index.js';
import { inspect as decoderInspect } from '../src/decoder.js';
import { inspect as browserInspect } from '../src/browser/index.js';

function gif(w, h, frames) {
  const buf = new Uint8Array(4096);
  const g = new GifWriter(buf, w, h, { palette: [0x000000, 0xff0000, 0x00ff00, 0x0000ff], loop: 0 });
  for (let f = 0; f < frames; f++) g.addFrame(0, 0, w, h, new Uint8Array(w * h).map((_, i) => (i + f) & 3), { delay: 10 });
  return buf.slice(0, g.end());
}
const limit = (fn) => assert.throws(fn, (e) => e.code === 'LIMIT', String(fn));

const anim = gif(20, 16, 3);
const webp = new Uint8Array(await sharp({ create: { width: 37, height: 29, channels: 3, background: '#308' } }).webp().toBuffer());
const webpLossless = new Uint8Array(await sharp({ create: { width: 33, height: 21, channels: 4, background: '#308' } }).webp({ lossless: true }).toBuffer());
const progressive = new Uint8Array(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#357' } }).jpeg({ progressive: true }).toBuffer());

test('GIF and WebP: size and frames from the headers, the same from every inspect()', () => {
  for (const fn of [inspect, decoderInspect, browserInspect]) {
    assert.deepEqual(fn(anim), { format: 'gif', scrambled: false, width: 20, height: 16, animated: true, frames: 3 });
    assert.deepEqual(fn(webp), { format: 'webp', scrambled: false, width: 37, height: 29, metadata: [] });
    assert.equal(fn(webpLossless).width, 33);
    limit(() => fn(anim, { limits: { maxFrames: 2 } }));
    limit(() => fn(anim, { limits: { maxPixels: 100 } }));
    limit(() => fn(webp, { limits: { maxPixels: 100 } }));
  }
});

test('inspect checks maxScans, maxTotalPixels and maxDecompressedBytes', () => {
  limit(() => inspect(progressive, { limits: { maxScans: 2 } }));
  limit(() => decoderInspect(progressive, { limits: { maxScans: 2 } }));
  const apng = encode(anim, { key: 'k' });
  assert.equal(inspect(apng).frames, 3);
  limit(() => inspect(apng, { limits: { maxTotalPixels: 20 * 16 * 3 - 1 } }));
  inspect(apng, { limits: { maxTotalPixels: 20 * 16 * 3 } });
  limit(() => inspect(apng, { limits: { maxDecompressedBytes: 95 } })); // 2-bit palette: 16 rows of 1 + 5 bytes
});
