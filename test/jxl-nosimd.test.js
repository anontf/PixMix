// The JPEG XL encoder build without WebAssembly SIMD, as an engine without SIMD gets it.
// (A file of its own: node --test runs each file in its own process, so the encoder is
// loaded here for the first time, after SIMD has been hidden.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const validate = WebAssembly.validate;
const probed = [];
WebAssembly.validate = (bytes) => {
  probed.push(bytes.length);
  return bytes.length < 64 ? false : validate(bytes); // "no SIMD" for the feature probe
};
const { encodeAsync, decodeAsync, inspect, convert } = await import('../src/index.js');
const { loadJxlCodec } = await import('../src/formats/jxl/load.js');
const { readSegments } = await import('../src/formats/jpeg/markers.js');
const { decodeFrame } = await import('../src/formats/jpeg/decode.js');
const codec = await loadJxlCodec();

test('without SIMD the plain encoder is used, and round trips stay exact', async () => {
  assert.equal(codec.hasSimd(), false);
  const w = 37, h = 23;
  const data = new Uint8Array(w * h * 4).map((_, i) => (i * 7919) & 255);
  const jxl = await codec.encode({ width: w, height: h, data });
  assert.ok(probed.length > 0, 'SIMD support was probed');
  assert.deepEqual((await codec.decode(jxl)).data, data);
  const s = await encodeAsync(jxl, { key: 'k', mode: 'block', block: 4 });
  assert.deepEqual((await codec.decode(await decodeAsync(s, { key: 'k' }))).data, data);
  const d16 = new Uint16Array(w * h * 4).map((_, i) => (i * 4099) & 0xffff);
  assert.deepEqual((await codec.decode(await codec.encode({ width: w, height: h, depth: 16, data: d16 }), { high: true })).data, d16);
});

test('without SIMD the JPEG route still works', async () => {
  const raw = Buffer.alloc(64 * 48 * 3).map((_, i) => (i * 31) & 255);
  const jpg = new Uint8Array(await sharp(raw, { raw: { width: 64, height: 48, channels: 3 } }).jpeg().toBuffer());
  const jxl = await encodeAsync(jpg, { key: 'k', format: 'jxl' });
  assert.equal(inspect(jxl).mode, 'mcu');
  const back = await codec.reconstructJpeg(await decodeAsync(jxl, { key: 'k' }));
  const coefs = (b) => decodeFrame(readSegments(b).segments).components.map((c) => Buffer.from(c.coefs.buffer));
  assert.deepEqual(coefs(back), coefs(convert(jpg, { format: 'jpeg' }).bytes), 'the same DCT coefficients');
});
