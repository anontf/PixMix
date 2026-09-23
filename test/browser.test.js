// Runs the browser reveal against a tiny fake DOM/canvas: checks every effect ends on
// exactly the original pixels and that the <img> swap happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode } from '../src/encoder.js';
import { readPng } from '../src/formats/png/index.js';
import { toRGBA8 } from '../src/formats/png/rgba.js';
import { resolveObjectURL } from 'node:buffer';
import jpeg from 'jpeg-js';
import { decode, detectFormat, inspect } from '../src/decoder.js';
import { readJpegMetadata } from '../src/meta/jpeg.js';
import { readOrientation } from '../src/meta/exif.js';
import { orientationTransform, swapsAxes } from '../src/browser/orient.js';

class FakeImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    else { this.data = a; this.width = b; this.height = c; }
  }
}
class FakeElement {
  constructor() { this.dataset = {}; this.attrs = {}; this.style = {}; this.listeners = {}; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  before(el) { this.inserted = el; }
  remove() { this.removed = true; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  getClientRects() { return [1]; }
}
class FakeCanvas extends FakeElement {
  getContext() {
    const c = this;
    c.pixels ??= new Uint8ClampedArray(c.width * c.height * 4);
    let m = [1, 0, 0, 1, 0, 0];
    return {
      setTransform(...t) { m = t; },
      clearRect() { c.pixels.fill(0); },
      getImageData(x, y, w, h) {
        const out = new Uint8ClampedArray(w * h * 4);
        for (let r = 0; r < h; r++) out.set(c.pixels.subarray(((y + r) * c.width + x) * 4, ((y + r) * c.width + x + w) * 4), r * w * 4);
        return new FakeImageData(out, w, h);
      },
      putImageData(img, x, y) {
        for (let r = 0; r < img.height; r++) {
          c.pixels.set(img.data.subarray(r * img.width * 4, (r + 1) * img.width * 4), ((y + r) * c.width + x) * 4);
        }
      },
      drawImage(src, sx, sy, sw, sh, dx, dy) {
        if (sw === undefined) { // drawImage(src, x, y) through the current transform
          for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
            const X = Math.floor(m[0] * (x + 0.5) + m[2] * (y + 0.5) + m[4]);
            const Y = Math.floor(m[1] * (x + 0.5) + m[3] * (y + 0.5) + m[5]);
            const s = (y * src.width + x) * 4, d = (Y * c.width + X) * 4;
            for (let k = 0; k < 4; k++) c.pixels[d + k] = src.pixels[s + k];
          }
          return;
        }
        dx = Math.round(dx); dy = Math.round(dy);
        for (let r = 0; r < sh; r++) for (let q = 0; q < sw; q++) {
          const s = ((sy + r) * src.width + sx + q) * 4, d = ((dy + r) * c.width + dx + q) * 4;
          for (let k = 0; k < 4; k++) c.pixels[d + k] = src.pixels[s + k];
        }
      },
    };
  }
}
class FakeImg extends FakeElement {
  set src(v) { this._src = v; queueMicrotask(() => this.listeners.load?.forEach((f) => f())); }
  get src() { return this._src; }
  // Like a browser: decodes the JPEG and applies its EXIF orientation.
  async decode() {
    const bytes = new Uint8Array(await resolveObjectURL(this._src).arrayBuffer());
    const raw = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    const exif = readJpegMetadata(bytes).exif;
    const o = exif ? readOrientation(exif) : 1;
    const shown = new FakeCanvas();
    shown.width = swapsAxes(o) ? raw.height : raw.width;
    shown.height = swapsAxes(o) ? raw.width : raw.height;
    const ctx = shown.getContext('2d');
    ctx.setTransform(...orientationTransform(o, raw.width, raw.height));
    ctx.drawImage({ width: raw.width, height: raw.height, pixels: raw.data }, 0, 0);
    this.width = this.naturalWidth = shown.width;
    this.height = this.naturalHeight = shown.height;
    this.pixels = shown.pixels;
  }
}

globalThis.ImageData = FakeImageData;
globalThis.document = { createElement: () => new FakeCanvas() };
globalThis.Image = FakeImg;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 4);

const { reveal } = await import('../src/browser/index.js');
const orig = readFileSync(new URL('./fixtures/pngsuite/basn6a08.png', import.meta.url));
const expected = (() => { const img = readPng(orig); return toRGBA8(img, img.pixels); })();

for (const [effect, mode] of [['dissolve', 'pixel'], ['scan', 'pixel'], ['blocks', 'block'], ['blocks', 'pixel'], ['dissolve', 'block']]) {
  test(`reveal ${effect} (${mode}) ends on the original pixels`, async () => {
    const scrambled = encode(orig, { key: 'k', mode, block: 5 });
    globalThis.fetch = async () => new Response(scrambled);
    const img = new FakeImg();
    img.src = 'x';
    const progress = [];
    const out = await reveal(img, { key: 'k', effect, duration: 40, final: 'canvas', onProgress: (p) => progress.push(p) });
    assert.ok(out instanceof FakeCanvas);
    assert.deepEqual(out.pixels, expected);
    assert.equal(progress.at(-1), 1);
  });
}

test('reveal swaps the restored PNG into the <img>', async () => {
  const scrambled = encode(orig, { key: 'k' });
  globalThis.fetch = async () => new Response(scrambled);
  const img = new FakeImg();
  img.alt = 'cat';
  await reveal(img, { key: 'k', duration: 10 });
  assert.equal(img.dataset.pixmixState, 'done');
  assert.match(img.src, /^blob:/);
  assert.ok(img.inserted.removed, 'animation canvas removed');
  assert.equal(img.inserted.getAttribute('aria-label'), 'cat');
});

test('reveal with wrong key leaves the image alone', async () => {
  globalThis.fetch = async () => new Response(encode(orig, { key: 'k' }));
  const img = new FakeImg();
  img.src = 'scrambled.png';
  await assert.rejects(reveal(img, { key: 'nope' }), { code: 'WRONG_KEY' });
  assert.equal(img.dataset.pixmixState, 'error');
  assert.equal(img.src, 'scrambled.png');
});

test('reveal applies EXIF orientation to the animation', async () => {
  // A PNG tagged "rotate 90° CW" (orientation 6), as a converted phone JPEG would be.
  const { buildPng } = await import('../src/convert/png-build.js');
  const w = 6, h = 4;
  const data = new Uint8Array(w * h * 4).map((_, i) => (i * 37) & 255).map((v, i) => (i % 4 === 3 ? 255 : v));
  const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
  const { png } = buildPng({ width: w, height: h, data }, { exif: tiff });
  globalThis.fetch = async () => new Response(encode(png, { key: 'k' }));
  const img = new FakeImg();
  const out = await reveal(img, { key: 'k', duration: 20, final: 'canvas', orientation: 'apply' });
  assert.equal(out.width, h);
  assert.equal(out.height, w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, d = (x * h + (h - 1 - y)) * 4;
    assert.deepEqual([...out.pixels.subarray(d, d + 4)], [...data.subarray(s, s + 4)]);
  }
});

async function jpegFixture(orientation) {
  const { encodePixels } = await import('../src/formats/jpeg/fdct.js');
  const { assembleJpeg } = await import('../src/formats/jpeg/encode.js');
  const w = 37, h = 21; // partial edge MCUs on both axes
  const data = new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 29) % 251));
  const { frame, dqt } = encodePixels({ width: w, height: h, data });
  const header = [dqt];
  if (orientation) {
    const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0];
    header.unshift({ marker: 0xe1, data: Uint8Array.from([0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]) });
  }
  return assembleJpeg(header, frame);
}

for (const effect of ['blocks', 'dissolve', 'scan']) {
  test(`JPEG reveal ${effect} ends on the restored image`, async () => {
    const src = await jpegFixture();
    const scrambled = encode(src, { key: 'k' });
    globalThis.fetch = async () => new Response(scrambled);
    const out = await reveal(new FakeImg(), { key: 'k', effect, duration: 30, final: 'canvas' });
    const expected = jpeg.decode(decode(scrambled, { key: 'k' }), { useTArray: true, formatAsRGBA: true }).data;
    assert.deepEqual(out.pixels, new Uint8ClampedArray(expected));
  });
}

test('JPEG reveal with EXIF orientation 6 shows the image the way the browser will', async () => {
  const src = await jpegFixture(6);
  const scrambled = encode(src, { key: 'k' });
  globalThis.fetch = async () => new Response(scrambled);
  const out = await reveal(new FakeImg(), { key: 'k', effect: 'blocks', duration: 30, final: 'canvas' });
  const shown = new FakeImg();
  shown.src = URL.createObjectURL(new Blob([decode(scrambled, { key: 'k' })], { type: 'image/jpeg' }));
  await shown.decode();
  assert.equal(out.width, 21);
  assert.equal(out.height, 37);
  assert.deepEqual(out.pixels, shown.pixels);
});

test('JPEG reveal swaps the restored JPEG into the <img>', async () => {
  globalThis.fetch = async () => new Response(encode(await jpegFixture(), { key: 'k' }));
  const img = new FakeImg();
  await reveal(img, { key: 'k', effect: 'none' });
  assert.equal(img.dataset.pixmixState, 'done');
  const restored = new Uint8Array(await resolveObjectURL(img.src).arrayBuffer());
  assert.equal(detectFormat(restored), 'jpeg');
});


test('JXL reveal animates to the exact pixels and shows a PNG', async () => {
  const { encodeAsync } = await import('../src/encoder.js');
  const { loadJxlCodec } = await import('../src/formats/jxl/load.js');
  const codec = await loadJxlCodec();
  const w = 23, h = 17;
  const data = new Uint8Array(w * h * 4).map((_, i) => (i * 41) & 255);
  const jxl = await codec.encode({ width: w, height: h, data });
  for (const [mode, effect] of [['pixel', 'dissolve'], ['block', 'blocks']]) {
    globalThis.fetch = async () => new Response(await encodeAsync(jxl, { key: 'k', mode, block: 4 }));
    const out = await reveal(new FakeImg(), { key: 'k', effect, duration: 20, final: 'canvas' });
    assert.deepEqual(out.pixels, new Uint8ClampedArray(data), `${mode}/${effect}`);
  }
  globalThis.fetch = async () => new Response(await encodeAsync(jxl, { key: 'k' }));
  const img = new FakeImg();
  await reveal(img, { key: 'k', effect: 'none' });
  const shown = new Uint8Array(await resolveObjectURL(img.src).arrayBuffer());
  assert.equal(detectFormat(shown), 'png');
});

test('JPEG-route JXL reveals as the original JPEG', async () => {
  const { encodeAsync } = await import('../src/encoder.js');
  const { unscrambleJxlDetailed } = await import('../src/formats/jxl/index.js');
  const jxl = await encodeAsync(await jpegFixture(), { key: 'k', format: 'jxl' });
  assert.equal(inspect(jxl).mode, 'mcu');
  globalThis.fetch = async () => new Response(jxl);
  const out = await reveal(new FakeImg(), { key: 'k', effect: 'blocks', duration: 20, final: 'canvas' });
  const restored = (await unscrambleJxlDetailed(jxl, { key: 'k' })).jpeg.toJpeg();
  assert.deepEqual(out.pixels, new Uint8ClampedArray(jpeg.decode(restored, { useTArray: true, formatAsRGBA: true }).data));
  const img = new FakeImg();
  globalThis.fetch = async () => new Response(jxl);
  await reveal(img, { key: 'k', effect: 'none' });
  assert.equal(detectFormat(new Uint8Array(await resolveObjectURL(img.src).arrayBuffer())), 'jpeg');
});
