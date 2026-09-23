// Runs the browser reveal against a tiny fake DOM/canvas: checks every effect ends on
// exactly the original pixels and that the <img> swap happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode } from '../src/encoder.js';
import { readPng } from '../src/formats/png/index.js';
import { toRGBA8 } from '../src/browser/rgba.js';

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
    return {
      putImageData(img, x, y) {
        for (let r = 0; r < img.height; r++) {
          c.pixels.set(img.data.subarray(r * img.width * 4, (r + 1) * img.width * 4), ((y + r) * c.width + x) * 4);
        }
      },
      drawImage(src, sx, sy, sw, sh, dx, dy) {
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
}

globalThis.ImageData = FakeImageData;
globalThis.document = { createElement: () => new FakeCanvas() };
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
