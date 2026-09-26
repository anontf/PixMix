// The website decoder in real browsers (each engine in PIXMIX_BROWSERS): every format and
// effect, the Web Worker and its fallback, a cross-origin CDN setup, wrong keys, EXIF
// orientation, the stand-in canvas's size, repeated reveals, <picture>/srcset and big images.
// Run with `npm run test:browser` (after `npm run build`).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
    assert.deepEqual([out.anim.animated, out.anim.mode], [true, 'block']);
    assert.deepEqual([out.deep, out.deepExact], [16, true]);
    assert.deepEqual(errors, []);
    await p.close();
  });

  // --- the stand-in canvas, repeated reveals, <picture>, srcset --------------------------

  const plainPage = (body, head = '') => `<!doctype html><meta charset="utf-8">${head}<script src="/dist/pixmix-decoder.min.js"></script>
<body style="margin:0">${body}`;
  const png320 = async () => encode(await photo(320, 200), { key: 'k', mode: 'block', block: 16 });

  test('width/height attributes size the canvas box, not its bitmap; final: canvas is the whole image', async () => {
    const { page: p, errors } = await page(plainPage(`<img id="i" src="/s.png" alt="a" width="160" height="100">
<script>window.done = PixMix.reveal(document.getElementById('i'), { key: 'k', effect: 'dissolve', duration: 1500, final: 'canvas' })
  .then((c) => [c.width, c.height, c.clientWidth, c.clientHeight]);</script>`), { '/s.png': await png320() });
    const c = await p.waitForSelector('canvas', { timeout: 20000 });
    assert.deepEqual(await c.evaluate((el) => [el.width, el.height, el.clientWidth, el.clientHeight]), [320, 200, 160, 100]);
    assert.deepEqual(await p.evaluate(() => window.done), [320, 200, 160, 100]);
    assert.deepEqual(errors, []);
    await p.close();
  });

  test('the canvas takes the rendered box of the <img> (CSS rules for img, srcset densities), and the <img> keeps it', async () => {
    const files = { '/s.png': await png320() };
    for (const [label, body, head] of [
      ['CSS rule on img', '<div style="width:500px"><img data-pixmix id="i" src="/s.png" alt="a"></div>', '<style>img { width: 50%; height: auto; border: 3px solid red; box-sizing: border-box }</style>'],
      ['srcset 2x', '<img data-pixmix id="i" srcset="/s.png 2x" alt="a">', ''],
      ['srcset w + sizes', '<img data-pixmix id="i" srcset="/s.png 320w" sizes="120px" alt="a">', ''],
    ]) {
      const html = `<!doctype html><meta charset="utf-8">${head}<body style="margin:0">${body}
<script>const i = document.getElementById('i'); window.sizes = {};
i.decode().then(() => { window.sizes.before = [i.clientWidth, i.clientHeight]; });
new MutationObserver((m) => { for (const r of m) for (const n of r.addedNodes) if (n.tagName === 'CANVAS') window.sizes.canvas = [n.clientWidth, n.clientHeight, n.width]; })
  .observe(document.body, { childList: true, subtree: true });</script>
<script src="/dist/pixmix-decoder.min.js" data-key="k" data-duration="300"></script>`;
      const { page: p, errors } = await page(html, files);
      const r = await revealed(p, '#i');
      assert.equal(r.state, 'done', label);
      const sizes = await p.evaluate(() => ({ ...window.sizes, after: [document.getElementById('i').clientWidth, document.getElementById('i').clientHeight] }));
      assert.deepEqual(sizes.canvas.slice(0, 2), sizes.before, `${label}: canvas box`);
      assert.equal(sizes.canvas[2], 320, `${label}: canvas bitmap`);
      assert.deepEqual(sizes.after, sizes.before, `${label}: the revealed <img>`);
      assert.deepEqual(errors, [], label);
      await p.close();
    }
  });

  test('two reveals in flight share one: the <img> ends visible, fetched once', async () => {
    const files = { '/s.png': await png320() };
    for (const [label, body] of [
      ['auto-run + revealAll, off-screen', `<div style="height:3000px"></div><img data-pixmix src="/s.png" alt="a" id="i">
<script src="/dist/pixmix-decoder.min.js" data-key="k" data-duration="200"></script><script>PixMix.revealAll({ key: 'k', duration: 200 });</script>`],
      ['reveal twice', `<img src="/s.png" alt="a" id="i"><script src="/dist/pixmix-decoder.min.js"></script>
<script>const i = document.getElementById('i'); window.same = PixMix.reveal(i, { key: 'k', duration: 200 }) === PixMix.reveal(i, { key: 'k', duration: 400 });</script>`],
    ]) {
      server.files.set('/t.html', `<!doctype html><meta charset="utf-8"><body style="margin:0">${body}`);
      server.files.set('/s.png', files['/s.png']);
      const { page: p, errors } = await openPage(browser);
      const fetched = [];
      p.on('request', (req) => { if (req.url().endsWith('/s.png')) fetched.push(req.url()); });
      await p.goto(`${server.url}/t.html`);
      await p.waitForTimeout(300);
      await p.evaluate(() => document.getElementById('i').scrollIntoView());
      const r = await revealed(p, '#i');
      assert.equal(r.state, 'done', label);
      await p.waitForTimeout(300);
      const out = await p.evaluate(() => ({ display: document.getElementById('i').style.display, canvases: document.querySelectorAll('canvas').length, same: window.same }));
      assert.deepEqual([out.display, out.canvases], ['', 0], label);
      if (label === 'reveal twice') assert.equal(out.same, true, 'the second call returns the first one\'s promise');
      assert.ok(fetched.length <= 2, `${label}: fetched ${fetched.length}x (the page's own load, and the reveal's)`);
      assert.deepEqual(errors, [], label);
      await p.close();
    }
  });

  test('reveal() of a revealed image is a no-op; an unknown effect plays dissolve; hidden stays hidden', async () => {
    const { page: p, errors } = await page(plainPage(`<img id="i" src="/s.png" alt="a"><img id="h" hidden src="/s.png" alt="b">
<script>window.r = (async () => {
  const warn = []; const w = console.warn; console.warn = (...a) => { warn.push(a.join(' ')); w(...a); };
  const i = document.getElementById('i'), h = document.getElementById('h');
  await PixMix.reveal(i, { key: 'k', effect: 'fade', duration: 50 });
  const src = i.src;
  const again = await PixMix.reveal(i, { key: 'k', effect: 'none' });
  const hidden = PixMix.reveal(h, { key: 'k', duration: 400 });
  await new Promise((r) => requestAnimationFrame(r));
  const c = await new Promise((res) => { const t = () => { const c = document.querySelector('canvas'); c ? res(c) : requestAnimationFrame(t); }; t(); });
  const canvasHidden = [c.hidden, c.getClientRects().length];
  await hidden;
  return { same: again === i && i.src === src, state: i.dataset.pixmixState, warn, canvasHidden, hState: h.dataset.pixmixState };
})();</script>`), { '/s.png': await png320() });
    const r = await p.evaluate(() => window.r);
    assert.deepEqual([r.same, r.state, r.hState], [true, 'done', 'done']);
    assert.ok(r.warn.some((m) => m.includes('unknown effect "fade"')), r.warn.join());
    assert.deepEqual(r.canvasHidden, [true, 0]);
    assert.deepEqual(errors, []);
    await p.close();
  });

  test('<picture>: the <source>s stop picking the scrambled file', async () => {
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<picture><source srcset="/s.png" type="image/png"><img data-pixmix src="/s.png" alt="a"></picture>
<script src="/dist/pixmix-decoder.min.js" data-key="k" data-duration="200"></script>`;
    const png = await photo(320, 200);
    const { page: p, errors } = await page(html, { '/s.png': encode(png, { key: 'k' }) });
    const r = await revealed(p);
    assert.equal(r.state, 'done');
    const shown = await p.evaluate(() => ({ current: document.querySelector('img').currentSrc, kept: document.querySelector('source').dataset.pixmixSrcset }));
    assert.match(shown.current, /^blob:/);
    assert.equal(shown.kept, '/s.png');
    assert.deepEqual(pngFrames(new Uint8Array(r.bytes)), pngFrames(png));
    assert.deepEqual(errors, []);
    await p.close();
  });

  test('the blob: URL is revoked once the <img> shows something else', async () => {
    const { page: p, errors } = await page(plainPage(`<img id="i" src="/s.png" alt="a">
<script>window.r = (async () => {
  const revoked = []; const rv = URL.revokeObjectURL; URL.revokeObjectURL = (u) => { revoked.push(u); rv.call(URL, u); };
  const i = document.getElementById('i');
  await PixMix.reveal(i, { key: 'k', duration: 50 });
  const blob = i.src;
  await new Promise((r) => setTimeout(r, 50));
  const early = revoked.includes(blob);
  i.src = '/s.png';
  await new Promise((r) => setTimeout(r, 50));
  return { early, late: revoked.includes(blob) };
})();</script>`), { '/s.png': await png320() });
    assert.deepEqual(await p.evaluate(() => window.r), { early: false, late: true });
    assert.deepEqual(errors, []);
    await p.close();
  });

  // --- configuration reaches the worker ---------------------------------------------------

  test('configureJxl / configureWatermarks({ moduleUrl }) reach the Web Worker', async () => {
    const dist = (f) => readFile(new URL(`../../dist/${f}`, import.meta.url));
    const files = {};
    for (const f of ['pixmix-decoder.min.js', 'pixmix-worker.mjs']) files[`/lib/${f}`] = await dist(f);
    for (const f of ['pixmix-jxl.mjs', 'pixmix-jxl-dec.wasm', 'pixmix-watermark.mjs']) files[`/chunks/${f}`] = await dist(f);
    files['/s.jxl'] = await encodeAsync(F.jxlSource, { key: 'k' });
    files['/wm.png'] = encode(F.png, { key: 'k', watermark: W.gold });
    const { page: p, errors, workers } = await page(`<!doctype html><meta charset="utf-8"><body><img id="a" src="/s.jxl" alt="a"><img id="b" src="/wm.png" alt="b">
<script src="/lib/pixmix-decoder.min.js"></script><script>
PixMix.configureJxl({ moduleUrl: '../chunks/pixmix-jxl.mjs' });
PixMix.configureWatermarks({ moduleUrl: '/chunks/pixmix-watermark.mjs' });
window.r = Promise.all(['a', 'b'].map((id) => PixMix.reveal(document.getElementById(id), { key: 'k', effect: 'none' }).then(() => 'done', (e) => e.message)));</script>`, files);
    assert.deepEqual(await p.evaluate(() => window.r), ['done', 'done']);
    assert.ok(workers.some((u) => u.includes('pixmix-worker')));
    const node = await decodeAsync(files['/wm.png'], { key: 'k', watermark: true });
    const shown = await p.evaluate(async () => Array.from(new Uint8Array(await (await fetch(document.getElementById('b').src)).arrayBuffer())));
    assert.deepEqual(pngFrames(new Uint8Array(shown)), pngFrames(node), 'watermark drawn in the worker');
    assert.deepEqual(errors, []);
    await p.close();
  });

  // --- orientation ----------------------------------------------------------------------

  test('JPEG with orientation: ignore animates the stored grid, unrotated', async () => {
    const { page: p, errors } = await page(plainPage(`<img id="i" src="/r.jpg" alt="a">
<script>window.c = PixMix.reveal(document.getElementById('i'), { key: 'k', effect: 'dissolve', duration: 50, orientation: 'ignore', final: 'canvas' })
.then((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let empty = 0; for (let i = 3; i < d.length; i += 4) if (d[i] === 0) empty++; return [c.width, c.height, empty, Array.from(d)]; });</script>`), { '/r.jpg': encode(F.jpegRotated, { key: 'k' }) });
    const [w, h, empty, px] = await p.evaluate(() => window.c);
    assert.deepEqual([w, h, empty], [160, 100, 0]);
    // The restored JPEG as stored, without its EXIF.
    const raw = await sharp(F.jpegRotated).raw().ensureAlpha().toBuffer(); // sharp ignores orientation unless asked
    let off = 0;
    for (let i = 0; i < raw.length; i++) if (Math.abs(raw[i] - px[i]) > 8) off++;
    assert.ok(off < raw.length / 100, `${off} samples off`);
    assert.deepEqual(errors, []);
    await p.close();
  });

  test('watermark on an EXIF-rotated PNG lands bottom-right of the image as this browser shows it', async () => {
    const { readChunks, writeChunks } = await import('../../src/formats/png/chunks.js');
    const ch = readChunks(await photo(480, 300));
    ch.splice(1, 0, { type: 'eXIf', data: new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]) });
    const s = encode(writeChunks(ch), { key: 'k', watermark: W.gold });
    const { page: p, errors } = await page(plainPage('<img id="i" src="/s.png" alt="a">'), { '/s.png': s });
    const box = await p.evaluate(async () => {
      const img = document.getElementById('i');
      await PixMix.reveal(img, { key: 'k', effect: 'none' });
      const exact = await PixMix.decodeToURL('/s.png', { key: 'k', watermark: false });
      const px = async (u) => { const im = new Image(); im.src = u; await im.decode(); const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return [g.getImageData(0, 0, c.width, c.height).data, c.width, c.height]; };
      const [a, w, h] = await px(img.src), [b] = await px(exact);
      let x0 = w, y0 = h;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); } }
      return { w, h, x0, y0 };
    });
    assert.ok(box.x0 > box.w / 2 && box.y0 > box.h / 2, JSON.stringify(box));
    assert.deepEqual(errors, []);
    await p.close();
  });

  test('JPEG watermark: the last animation frame is the final image (no pop at the swap)', async () => {
    const s = encode(F.jpeg, { key: 'k', watermark: W.gold });
    const { page: p, errors } = await page(plainPage('<img id="i" src="/s.jpg" alt="a">'), { '/s.jpg': s, '/n.jpg': await decodeAsync(s, { key: 'k', watermark: true }) });
    const off = await p.evaluate(async () => {
      const c = await PixMix.reveal(document.getElementById('i'), { key: 'k', effect: 'dissolve', duration: 100, final: 'canvas' });
      const got = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const im = new Image(); im.src = '/n.jpg'; await im.decode();
      const d = document.createElement('canvas'); d.width = c.width; d.height = c.height; const g = d.getContext('2d'); g.drawImage(im, 0, 0);
      const want = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0, max = 0; for (let i = 0; i < want.length; i++) { const d = Math.abs(want[i] - got[i]); if (d > 2) n++; max = Math.max(max, d); }
      return [n, max];
    });
    // The engine's decodes of one JPEG can differ by a level or two (the worker's vs the page's).
    assert.equal(off[0], 0, `${off[0]} samples off by more than 2`);
    assert.deepEqual(errors, []);
    await p.close();
  });

  // --- big images -----------------------------------------------------------------------

  test('a big image animates at a reduced size, keeps the main thread free, and ends exact', async () => {
    const big = await photo(3000, 2000, { quality: 85 });
    const { page: p, errors } = await page(plainPage('<img id="i" src="/b.jpg" alt="a" style="width:300px">'), { '/b.jpg': encode(big, { key: 'k' }) });
    const r = await p.evaluate(async () => {
      const img = document.getElementById('i');
      await img.decode();
      let last = performance.now(), maxGap = 0, run = true;
      const loop = (t) => { maxGap = Math.max(maxGap, t - last); last = t; if (run) requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      let bitmap = null;
      new MutationObserver((m) => { for (const x of m) for (const n of x.addedNodes) if (n.tagName === 'CANVAS') bitmap = [n.width, n.height, n.clientWidth]; }).observe(document.body, { childList: true });
      await PixMix.reveal(img, { key: 'k', effect: 'dissolve', duration: 800 });
      run = false;
      return { bitmap, maxGap, shown: [img.naturalWidth, img.clientWidth], state: img.dataset.pixmixState };
    });
    assert.equal(r.state, 'done');
    assert.ok(r.bitmap[0] < 3000 && r.bitmap[0] * r.bitmap[1] <= 2_000_000, `animated at ${r.bitmap}`);
    assert.equal(r.bitmap[2], 300);
    assert.deepEqual(r.shown, [3000, 300]);
    assert.ok(r.maxGap < 1000, `longest frame gap ${Math.round(r.maxGap)} ms`);
    assert.deepEqual(errors, []);
    await p.close();
  });
});
