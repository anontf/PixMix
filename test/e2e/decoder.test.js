// The website decoder in real browsers (each engine in PIXMIX_BROWSERS): every format and
// effect, the Web Worker and its fallback, a cross-origin CDN setup, wrong keys and EXIF
// orientation.
// Run with `npm run test:browser` (after `npm run build`).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { GifWriter } from 'omggif';
import { encode, encodeAsync, decodeAsync, inspect, convert } from '../../src/index.js';
import { unscrambleJxlDetailed, reconstructJpeg } from '../../src/formats/jxl/index.js';
import { readPng } from '../../src/formats/png/index.js';
import { toRGBA8 } from '../../src/formats/png/rgba.js';
import { readSegments } from '../../src/formats/jpeg/markers.js';
import { decodeFrame } from '../../src/formats/jpeg/decode.js';
import { loadJxlCodec } from '../../src/formats/jxl/load.js';
import { watermarkStore } from '../../src/watermark/store.js';
import { startServer, launch, engines, openPage, revealed, rendered, decoderPage } from './harness.js';

let server, cdn;
const coefs = (b) => decodeFrame(readSegments(b).segments).components.map((c) => Buffer.from(c.coefs.buffer));
const sameCoefs = (a, b) => coefs(a).every((c, i) => c.equals(coefs(b)[i]));
const pngFrames = (b) => { const p = readPng(b); return p.frames.map((f) => Buffer.from(toRGBA8(p, f))); };

async function photo(w, h, jpegOpts) {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 3;
    raw[o] = (x * 255) / w; raw[o + 1] = (y * 255) / h; raw[o + 2] = ((x ^ y) * 3) & 255;
  }
  const s = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  return new Uint8Array(await (jpegOpts ? s.jpeg(jpegOpts) : s.png()).toBuffer());
}

const F = {};
const W = {};
before(async () => {
  const store = watermarkStore();
  W.gold = await store.compiled('vivi-gold');
  W.pixel = await store.compiled('vivi-pixel');
  W.window = await store.compiled('vivi-window');
  W.byId = { 'vivi-gold': W.gold, 'vivi-pixel': W.pixel, 'vivi-window': W.window };
  server = await startServer();
  cdn = await startServer({ cors: true });
  F.png = await photo(160, 100);
  F.jpeg = await photo(160, 100, { quality: 85 });
  F.jpegProgressive = await photo(160, 96, { quality: 85, progressive: true });
  F.jpegRotated = new Uint8Array(await sharp(F.jpeg).withMetadata({ orientation: 6 }).jpeg().toBuffer());
  F.jxlSource = await (await loadJxlCodec()).encode({ width: 160, height: 100, data: new Uint8Array(await sharp(F.png).ensureAlpha().raw().toBuffer()) });
  const buf = Buffer.alloc(1 << 16);
  const gw = new GifWriter(buf, 40, 24, { loop: 0, palette: [0x000000, 0xff0000, 0x00ff00, 0x0000ff] });
  for (let f = 0; f < 4; f++) gw.addFrame(0, 0, 40, 24, Array.from({ length: 960 }, (_, i) => (((i % 40) + f * 9) >> 3) & 3), { delay: 5 });
  F.gif = new Uint8Array(buf.subarray(0, gw.end()));
});
after(async () => {
  await server?.close();
  await cdn?.close();
});

const CASES = [
  ['PNG pixel', async () => encode(F.png, { key: 'k' }), 'png'],
  ['PNG block', async () => encode(F.png, { key: 'k', mode: 'block', block: 8 }), 'png'],
  ['JPEG (MCU + flips)', async () => encode(F.jpeg, { key: 'k' }), 'jpeg'],
  ['progressive JPEG', async () => encode(F.jpegProgressive, { key: 'k' }), 'jpeg-progressive'],
  ['JPEG XL pixel route', async () => encodeAsync(F.jxlSource, { key: 'k', mode: 'block', block: 8 }), 'jxl'],
  ['JPEG XL JPEG route', async () => encodeAsync(F.jpeg, { key: 'k', format: 'jxl' }), 'jxl-jpeg'],
  ['APNG from GIF', async () => encode(F.gif, { key: 'k', mode: 'block', block: 4 }), 'apng'],
  ['animated JPEG XL from GIF', async () => encodeAsync(F.gif, { key: 'k', format: 'jxl', mode: 'block', block: 4 }), 'jxl-anim'],
];

for (const { name: engine, skip } of await engines()) describe(engine, { skip }, () => {
  let browser;
  before(async () => { browser = await launch(engine); });
  after(() => browser?.close());

  async function page(html, files = {}) {
    for (const [p, b] of Object.entries(files)) server.files.set(p, b);
    server.files.set('/t.html', html);
    const p = await openPage(browser);
    await p.page.goto(`${server.url}/t.html`);
    return p;
  }

  for (const [name, make, kind] of CASES) {
    for (const effect of ['blocks', 'dissolve', 'scan', 'none']) {
      test(`${name} · ${effect}`, async () => {
        const scrambled = await make();
        const ext = { png: 'png', apng: 'png', jpeg: 'jpg', 'jpeg-progressive': 'jpg', jxl: 'jxl', 'jxl-jpeg': 'jxl', 'jxl-anim': 'jxl' }[kind];
        const { page: p, errors, workers } = await page(decoderPage({ src: `/s.${ext}`, effect }), { [`/s.${ext}`]: scrambled });
        const r = await revealed(p);
        assert.equal(r.state, 'done');
        assert.match(r.src, /^blob:/);
        const shown = new Uint8Array(r.bytes);
        if (kind.startsWith('jpeg') || kind === 'jxl-jpeg') {
          const original = kind === 'jpeg-progressive' ? F.jpegProgressive : F.jpeg;
          assert.equal(inspect(shown).format, 'jpeg');
          assert.ok(sameCoefs(shown, original), 'the <img> shows the original JPEG coefficients');
          if (kind === 'jpeg-progressive') assert.equal(inspect(shown).progressive, true, 'still progressive');
          // And the browser renders it exactly like the untouched original.
          server.files.set('/orig.jpg', original);
          assert.deepEqual(await rendered(p, r.src), await rendered(p, '/orig.jpg'));
        } else if (kind === 'jxl') {
          const want = Buffer.from((await (await loadJxlCodec()).decode(F.jxlSource)).data);
          assert.ok(pngFrames(shown)[0].equals(want), 'PNG of the exact JPEG XL pixels');
        } else if (kind === 'jxl-anim') {
          assert.equal(inspect(shown).frames, 4, 'an APNG of every frame');
          assert.deepEqual(pngFrames(shown), pngFrames(convert(F.gif, { format: 'png' }).bytes), 'every frame exact');
        } else {
          const source = kind === 'apng' ? encode(F.gif, { key: 'x' }) : F.png;
          const want = kind === 'apng' ? pngFrames(await decodeAsync(source, { key: 'x' })) : pngFrames(F.png);
          assert.deepEqual(pngFrames(shown), want, 'every frame exact');
          if (kind === 'png') {
            server.files.set('/orig.png', F.png);
            assert.deepEqual(await rendered(p, r.src), await rendered(p, '/orig.png'));
          }
        }
        assert.ok(workers.some((u) => u.includes('pixmix-worker')), 'decoded in the Web Worker');
        assert.deepEqual(errors, []);
        await p.close();
      });
    }
  }

  // Watermarks: the browser draws exactly the bytes Node draws (same renderer, same maths),
  // and only fetches the painter when there is something to draw.
  const WM_CASES = [
    ['PNG, carried whole', async () => encode(F.png, { key: 'k', watermark: W.gold }), '', 'png'],
    ['PNG block, visible watermark and one by id (data-watermark)', async () => encode(F.png, { key: 'k', mode: 'block', block: 8, visibleWatermark: W.pixel }), 'data-watermark="vivi-window"', 'png'],
    ['JPEG, carried by id', async () => encode(F.jpeg, { key: 'k', watermark: { id: 'vivi-gold' }, visibleWatermark: W.window }), '', 'jpeg'],
    ['JPEG XL pixel route', async () => encodeAsync(F.jxlSource, { key: 'k', mode: 'block', block: 8, watermark: W.window }), '', 'jxl'],
    ['JPEG XL JPEG route', async () => encodeAsync(F.jpeg, { key: 'k', format: 'jxl', watermark: W.gold, visibleWatermark: W.pixel }), '', 'jxl-jpeg'],
  ];
  for (const [name, make, extra, kind] of WM_CASES) {
    test(`watermark · ${name}: the <img> shows exactly what Node draws`, async () => {
      const scrambled = await make();
      const ext = { png: 'png', jpeg: 'jpg', jxl: 'jxl', 'jxl-jpeg': 'jxl' }[kind];
      const files = { [`/s.${ext}`]: scrambled };
      for (const [id, c] of Object.entries(W.byId)) files[`/watermarks/${id}.json`] = JSON.stringify(c);
      const { page: p, errors } = await page(decoderPage({ src: `/s.${ext}`, effect: 'dissolve', extra }), files);
      const r = await revealed(p);
      assert.equal(r.state, 'done');
      const shown = new Uint8Array(r.bytes);
      const want = extra ? W.window : undefined;
      const node = await decodeAsync(scrambled, { key: 'k', watermark: want ?? true, resolveWatermark: (id) => W.byId[id] });
      if (kind === 'jxl') {
        const px = Buffer.from((await (await loadJxlCodec()).decode(node)).data);
        assert.ok(pngFrames(shown)[0].equals(px), 'same pixels as Node');
      } else if (kind === 'jxl-jpeg') {
        assert.ok(Buffer.from(shown).equals(Buffer.from(await reconstructJpeg(node))), 'same JPEG as Node');
      } else if (kind === 'png') {
        // Same pixels; the deflate stream is the engine's own (CompressionStream).
        assert.deepEqual(pngFrames(shown), pngFrames(node), 'same pixels as Node');
      } else {
        assert.ok(Buffer.from(shown).equals(Buffer.from(node)), 'same file as Node');
      }
      if (!kind.startsWith('jxl')) assert.ok(!Buffer.from(shown).equals(Buffer.from(await decodeAsync(scrambled, { key: 'k' }))), 'watermarked');
      assert.deepEqual(errors, []);
      await p.close();
    });
  }

  test('watermark: the painter is only fetched when something is drawn', async () => {
    // On the main thread (data-worker="false"), so the page's resource timing sees the fetch.
    const loaded = (p) => p.evaluate(() => performance.getEntriesByType('resource').some((e) => e.name.includes('pixmix-watermark')));
    const run = async (bytes, extra = '') => {
      const { page: p, errors } = await page(decoderPage({ src: '/s.png', extra: `data-worker="false" ${extra}` }), { '/s.png': bytes });
      const r = await revealed(p);
      const out = { frames: pngFrames(new Uint8Array(r.bytes)), painter: await loaded(p), errors };
      await p.close();
      return out;
    };
    const plain = await run(encode(F.png, { key: 'k' }));
    assert.deepEqual([plain.frames, plain.painter], [pngFrames(F.png), false], 'no watermark: not fetched');
    const marked = await run(encode(F.png, { key: 'k', watermark: W.gold }));
    assert.equal(marked.painter, true);
    const off = await run(encode(F.png, { key: 'k', watermark: W.gold }), 'data-watermark="none"');
    assert.deepEqual([off.frames, off.painter], [pngFrames(F.png), false], 'data-watermark="none"');
    assert.deepEqual([...plain.errors, ...marked.errors, ...off.errors], []);
  });

  test('watermark: a missing one is skipped with a warning, the image still shows', async () => {
    const { page: p } = await page(decoderPage({ src: '/s.png', extra: 'data-watermark="not-there"' }), { '/s.png': encode(F.png, { key: 'k' }) });
    const r = await revealed(p);
    assert.equal(r.state, 'done');
    assert.deepEqual(pngFrames(new Uint8Array(r.bytes)), pngFrames(F.png));
    await p.close();
  });

  test('animation frames are drawn on a canvas while revealing', async () => {
    const { page: p, errors } = await page(decoderPage({ src: '/s.png', effect: 'blocks', duration: 1500 }), { '/s.png': encode(F.png, { key: 'k', mode: 'block', block: 8 }) });
    const canvas = await p.waitForSelector('canvas', { timeout: 20000 });
    const size = await canvas.evaluate((c) => [c.width, c.height, getComputedStyle(c).display]);
    assert.deepEqual(size.slice(0, 2), [160, 100]);
    await revealed(p);
    assert.equal(await p.locator('canvas').count(), 0, 'canvas removed afterwards');
    assert.deepEqual(errors, []);
    await p.close();
  });

  test('without the worker file, or under a CSP forbidding workers, it decodes on the main thread', async () => {
    const s = encode(F.png, { key: 'k' });
    const noWorker = decoderPage({ src: '/s.png', extra: 'data-worker="false"' });
    for (const [label, html] of [
      ['data-worker="false"', noWorker],
      ['CSP worker-src none', decoderPage({ src: '/s.png' }).replace('<meta charset="utf-8">', `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="worker-src 'none'">`)],
    ]) {
      const { page: p, workers } = await page(html, { '/s.png': s });
      const r = await revealed(p);
      assert.equal(r.state, 'done', label);
      assert.deepEqual(pngFrames(new Uint8Array(r.bytes)), pngFrames(F.png), label);
      if (label.startsWith('data')) assert.equal(workers.length, 0);
      await p.close();
    }
  });

  test('decoder served from another origin (CDN) still uses a worker and finds JPEG XL', async () => {
    const s = await encodeAsync(F.jxlSource, { key: 'k' });
    const html = decoderPage({ src: '/s.jxl', script: `${cdn.url}/dist/pixmix-decoder.min.js` });
    const { page: p, errors, workers } = await page(html, { '/s.jxl': s });
    const r = await revealed(p);
    assert.equal(r.state, 'done');
    assert.ok(workers.length > 0, 'worker started through the blob module');
    assert.deepEqual(errors, []);
    await p.close();
  });

  test('a wrong key leaves the scrambled image in place', async () => {
    const { page: p } = await page(decoderPage({ src: '/s.png', key: 'nope' }), { '/s.png': encode(F.png, { key: 'k' }) });
    await p.waitForFunction(() => document.querySelector('img').dataset.pixmixState === 'error', null, { timeout: 20000 });
    assert.match(await p.evaluate(() => document.querySelector('img').getAttribute('src')), /\/s\.png$/);
    await p.close();
  });

  test('EXIF orientation: canvas and final image come out rotated like a plain <img>', async () => {
    const s = encode(F.jpegRotated, { key: 'k' });
    const { page: p, errors } = await page(decoderPage({ src: '/s.jpg', effect: 'blocks', duration: 1500 }), { '/s.jpg': s, '/orig.jpg': F.jpegRotated });
    const canvas = await p.waitForSelector('canvas', { timeout: 20000 });
    assert.deepEqual(await canvas.evaluate((c) => [c.width, c.height]), [100, 160], 'animation drawn rotated');
    const r = await revealed(p);
    assert.deepEqual(r.natural, [100, 160]);
    assert.deepEqual(await rendered(p, r.src), await rendered(p, '/orig.jpg'));
    assert.deepEqual(errors, []);
    await p.close();
  });

  // Without WebCodecs' ImageDecoder (hidden here, or absent from the engine) the documented
  // fallback is the first frame, with the animation reported as dropped.
  for (const hide of [false, true]) {
    test(`browser plugin: animated WebP keeps every frame through ImageDecoder${hide ? ', or the first without it' : ''}`, async () => {
      const solid = (c) => sharp({ create: { width: 24, height: 16, channels: 4, background: c } }).png().toBuffer();
      const frames = await Promise.all(['#ff0000', '#00ff00', '#0000ff'].map(solid));
      const webp = new Uint8Array(await sharp(frames, { join: { animated: true } }).webp({ loop: 2, delay: [100, 200, 300], lossless: true }).toBuffer());
      const { page: p, errors } = await page('<!doctype html><body></body>', {});
      const out = await p.evaluate(async ([bytes, hide]) => {
        if (hide) delete globalThis.ImageDecoder;
        const Enc = await import('/dist/pixmix-encoder.mjs');
        const r = await Enc.convertAsync(new Uint8Array(bytes), { format: 'png', decoders: [Enc.browserDecoder()] });
        return { native: typeof ImageDecoder !== 'undefined', info: Enc.inspect(r.bytes), transferred: r.transferred, dropped: r.dropped, png: Array.from(r.bytes) };
      }, [Array.from(webp), hide]);
      const px = pngFrames(new Uint8Array(out.png)).map((f) => [...f.subarray(0, 4)]);
      if (out.native) {
        assert.deepEqual([out.info.frames, out.info.plays], [3, 2]);
        assert.ok(out.transferred.includes('animation'));
        assert.deepEqual(px, [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]);
        const delays = readPng(new Uint8Array(out.png)).chunks.filter((c) => c.type === 'fcTL')
          .map(({ data: d }) => Math.round(((d[20] << 8 | d[21]) / (d[22] << 8 | d[23])) * 1000));
        assert.deepEqual(delays, [100, 200, 300]);
      } else {
        assert.ok(hide || engine !== 'chromium', 'Chromium has ImageDecoder');
        assert.deepEqual(px, [[255, 0, 0, 255]]);
        assert.ok(out.dropped.some((d) => d.startsWith('animation')), out.dropped.join());
      }
      assert.deepEqual(errors, []);
      await p.close();
    });
  }

  test('encoder in the browser: JPEG -> JPEG XL takes the JPEG route, and 16-bit / animation survive', async () => {
    const { page: p, errors } = await page('<!doctype html><body></body>', {});
    const out = await p.evaluate(async ({ jpeg, gif }) => {
      const Enc = await import('/dist/pixmix-encoder.mjs');
      const Dec = await import('/dist/pixmix-decoder.js');
      const jxl = await Enc.encodeAsync(new Uint8Array(jpeg), { key: 'k', format: 'jxl' });
      const restored = await Dec.decodeAsync(jxl, { key: 'k' }); // back to JPEG XL, in the browser
      const anim = await Enc.encodeAsync(new Uint8Array(gif), { key: 'k', format: 'jxl' });
      const w = 5, h = 3, d16 = new Uint16Array(w * h * 4).map((_, i) => (i * 4099 + 7) & 0xffff);
      const codec = await Enc.loadJxlCodec();
      const deep = await Enc.encodeAsync(await codec.encode({ width: w, height: h, depth: 16, data: d16 }), { key: 'k', mode: 'block', block: 2 });
      const deepBack = (await codec.decode(await Dec.decodeAsync(deep, { key: 'k' }), { high: true })).data;
      return {
        info: Enc.inspect(jxl), jxl: Array.from(jxl), restored: Array.from(restored),
        anim: Enc.inspect(anim), deep: Enc.inspect(deep).bitDepth, deepExact: deepBack.every((v, i) => v === d16[i]),
      };
    }, { jpeg: Array.from(F.jpeg), gif: Array.from(F.gif) });
    assert.equal(out.info.mode, 'mcu', 'JPEG route');
    const plain = convert(F.jpeg, { format: 'jpeg' }).bytes;
    assert.ok(sameCoefs((await unscrambleJxlDetailed(new Uint8Array(out.jxl), { key: 'k' })).jpeg.toJpeg(), plain), 'Node restores what the browser wrote');
    assert.ok(sameCoefs(await reconstructJpeg(new Uint8Array(out.restored)), plain), 'the browser restored it to a JPEG XL of the original JPEG');
    assert.deepEqual([out.anim.animated, out.anim.mode], [true, 'pixel']);
    assert.deepEqual([out.deep, out.deepExact], [16, true]);
    assert.deepEqual(errors, []);
    await p.close();
  });
});
