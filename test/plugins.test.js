// Decoder plugins: which formats they claim, falling back to the built-in decoders, and what
// sharp hands over (orientation, pages, precision). Also format detection details.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import jpegjs from 'jpeg-js';
import { PNG } from 'pngjs';
import * as pkg from '../src/index.js';
import { convert, convertAsync, detectFormat, encode, decode } from '../src/index.js';
import { sharpDecoder } from '../src/plugins/sharp.js';
import { browserDecoder } from '../src/plugins/browser.js';
import { readChunks, writeChunks } from '../src/formats/png/chunks.js';
import { readOrientation } from '../src/meta/exif.js';
import { withOrientation } from '../src/convert/orientation.js';
import { readPng } from '../src/formats/png/index.js';

const solidPng = (w, h, hex) => sharp({ create: { width: w, height: h, channels: 3, background: hex } }).png().toBuffer();
const exifOf = (png) => readChunks(new Uint8Array(png)).find((c) => c.type === 'eXIf')?.data;

test('plugins only claim formats they can decode, and leave GIF and JPEG XL to pixmix', () => {
  const s = sharpDecoder(sharp);
  assert.ok(!s.formats.includes('gif') && !s.formats.includes('jxl'));
  assert.ok(['webp', 'avif', 'heic', 'tiff'].every((f) => s.formats.includes(f)));
  // Asked for explicitly, a format still needs a loader in this libvips build.
  const asked = sharpDecoder(sharp, { formats: ['webp', 'jxl'] }).formats;
  assert.deepEqual(asked, sharp.format.jxl?.input?.buffer ? ['webp', 'jxl'] : ['webp']);
  assert.deepEqual(sharpDecoder({ ...sharp, format: { webp: { input: { buffer: true } } } }, { formats: ['webp', 'tiff'] }).formats, ['webp']);
  assert.ok(!browserDecoder().formats.includes('jxl'));
});

test('a plugin that fails on a format pixmix decodes itself falls back to the built-in decoder', async () => {
  const jxl = (await convertAsync(await solidPng(16, 8, '#3080c0'), { format: 'jxl' })).bytes;
  const broken = { name: 'broken', formats: ['jxl', 'jpeg', 'webp'], decode: async () => { throw new Error('no loader'); } };
  const r = await convertAsync(jxl, { format: 'png', decoders: [broken] });
  assert.equal(r.decoder, 'jxl-oxide');
  assert.match(r.notes.join(), /broken could not decode this JXL \(no loader\); used the built-in decoder/);
  assert.equal(PNG.sync.read(Buffer.from(r.bytes)).width, 16);
  // The sync API too, with a sync plugin.
  const jpeg = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).jpeg().toBuffer());
  const syncBroken = { name: 'broken', formats: ['jpeg'], decode: () => { throw new Error('nope'); } };
  assert.equal(convert(jpeg, { format: 'png', decoders: [syncBroken] }).decoder, 'jpeg-js');
  // No built-in decoder to fall back to: the plugin's failure stands.
  const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).webp().toBuffer();
  await assert.rejects(convertAsync(webp, { decoders: [broken] }), { code: 'BAD_WEBP', message: /no loader/ });
  // A limit is final.
  const limited = { name: 'limited', formats: ['jxl'], decode: async () => { throw Object.assign(new Error('too big'), { code: 'LIMIT' }); } };
  await assert.rejects(convertAsync(jxl, { format: 'png', decoders: [limited] }), { message: /too big/ });
  // What the CLI and the dev server do: sharp for JPEG XL, whatever this build can do.
  const viaSharp = await convertAsync(jxl, { format: 'jpeg', decoders: [sharpDecoder(sharp, { formats: ['jxl'] })] });
  assert.equal(viaSharp.format, 'jpeg');
});

test('built-in GIF: the loop count plays as often as in browsers', () => {
  const gif = (loop) => {
    // 2x1, two frames, NETSCAPE loop extension unless loop is null.
    const head = [...Buffer.from('GIF89a'), 2, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
    const ext = loop === null ? [] : [0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, loop & 255, loop >> 8, 0];
    const frame = (c) => [0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 2, 0x44, c, 0];
    return new Uint8Array([...head, ...ext, ...frame(0x01), ...frame(0x51), 0x3b]);
  };
  const plays = (loop) => pkg.inspect(convert(gif(loop)).bytes).plays;
  assert.equal(plays(0), 0, 'forever');
  assert.equal(plays(2), 3, 'two repeats');
  assert.equal(plays(null), 1, 'no loop extension: once');
});

test('sharp: TIFF orientation (a TIFF tag) is carried as EXIF', async () => {
  const tiff = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#3080c0' } }).tiff().withMetadata({ orientation: 6 }).toBuffer();
  const r = await convertAsync(tiff, { format: 'png', decoders: [sharpDecoder(sharp)] });
  const m = await sharp(r.bytes).metadata();
  assert.deepEqual([m.width, m.height, readOrientation(exifOf(r.bytes))], [12, 8, 6], 'stored pixels, orientation as EXIF');
});

test('sharp: AVIF/HEIF, whose rotation libheif applies, is not turned a second time', async () => {
  const avif = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#3080c0' } }).avif().withMetadata({ orientation: 6 }).toBuffer();
  const r = await convertAsync(avif, { format: 'png', decoders: [sharpDecoder(sharp)] });
  const m = await sharp(r.bytes).metadata();
  assert.deepEqual([m.width, m.height], [8, 12]);
  assert.equal(readOrientation(exifOf(r.bytes)), 1);
  assert.ok(r.dropped.some((d) => /libheif applies the rotation/.test(d)));
});

test('sharp: a multi-page TIFF is its first page, not an animation', async () => {
  const page = (w, h, v) => ({ w, h, data: Buffer.alloc(w * h * 3, v) });
  const tiff = (pages) => {
    const parts = [Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0])];
    let off = 8;
    pages.forEach((p, idx) => {
      const n = 10, ifdLen = 2 + n * 12 + 4, bpsOff = off + ifdLen, dataOff = bpsOff + 6;
      const ifd = Buffer.alloc(ifdLen);
      ifd.writeUInt16LE(n, 0);
      [[256, 3, 1, p.w], [257, 3, 1, p.h], [258, 3, 3, bpsOff], [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 1, dataOff], [277, 3, 1, 3], [278, 3, 1, p.h], [279, 4, 1, p.data.length], [284, 3, 1, 1]]
        .forEach(([t, ty, c, v], i) => {
          const o = 2 + i * 12;
          ifd.writeUInt16LE(t, o); ifd.writeUInt16LE(ty, o + 2); ifd.writeUInt32LE(c, o + 4);
          if (ty === 3 && c === 1) ifd.writeUInt16LE(v, o + 8); else ifd.writeUInt32LE(v, o + 8);
        });
      ifd.writeUInt32LE(idx < pages.length - 1 ? dataOff + p.data.length : 0, 2 + n * 12);
      parts.push(ifd, Buffer.from([8, 0, 8, 0, 8, 0]), p.data);
      off = dataOff + p.data.length;
    });
    return Buffer.concat(parts);
  };
  for (const pages of [[page(40, 30, 50), page(40, 30, 200)], [page(40, 30, 50), page(20, 50, 200), page(8, 8, 1)]]) {
    const r = await convertAsync(tiff(pages), { format: 'png', decoders: [sharpDecoder(sharp)] });
    const png = PNG.sync.read(Buffer.from(r.bytes));
    assert.deepEqual([png.width, png.height, png.data[0]], [40, 30, 50]);
    assert.ok(!readChunks(r.bytes).some((c) => c.type === 'acTL'), 'not an APNG');
    assert.ok(r.dropped.includes(`${pages.length - 1} more page${pages.length > 2 ? 's' : ''} (first page kept)`), r.dropped.join());
  }
});

test('sharp: 10- and 12-bit AVIF samples are scaled to 16 bits, not shifted', async () => {
  const src = Buffer.alloc(4 * 4 * 3);
  for (let i = 0; i < src.length; i++) src[i] = (i * 37) % 256;
  for (const bitdepth of [10, 12]) {
    const avif = await sharp(src, { raw: { width: 4, height: 4, channels: 3 } }).avif({ bitdepth, lossless: true }).toBuffer();
    const stored = new Uint16Array(await sharp(avif).toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer().then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
    const r = await convertAsync(avif, { format: 'png', decoders: [sharpDecoder(sharp)] });
    const png = PNG.sync.read(Buffer.from(r.bytes), { skipRescale: true });
    assert.equal(png.depth, 16);
    const max = (1 << bitdepth) - 1, shift = 16 - bitdepth;
    for (let i = 0; i < 16; i++) {
      for (let c = 0; c < 3; c++) assert.equal(png.data[i * 4 + c], Math.round(((stored[i * 3 + c] >> shift) * 65535) / max));
    }
  }
});

test('format detection: generic HEIF brands go by their compatible brands', async () => {
  const avif = Buffer.from(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#3080c0' } }).avif().toBuffer());
  avif.write('mif1', 8, 'latin1');
  assert.equal(detectFormat(new Uint8Array(avif)), 'avif');
  const heic = Buffer.from(avif);
  const size = heic.readUInt32BE(0);
  for (let o = 16; o < size; o += 4) if (heic.toString('latin1', o, o + 4) === 'avif') heic.write('heic', o, 'latin1');
  assert.equal(detectFormat(new Uint8Array(heic)), 'heic');
});

test('the package entry exports the decoder plugins', () => {
  assert.equal(pkg.sharpDecoder, sharpDecoder);
  assert.equal(pkg.browserDecoder, browserDecoder);
});

test('APNG whose default image is not a frame: other formats get frame 0', async () => {
  const [r, g] = [readChunks(new Uint8Array(await solidPng(8, 8, '#ff0000'))), readChunks(new Uint8Array(await solidPng(8, 8, '#00ff00')))];
  const u32 = (...v) => { const b = new Uint8Array(v.length * 4); v.forEach((x, i) => new DataView(b.buffer).setUint32(i * 4, x)); return b; };
  const fctl = new Uint8Array(26);
  fctl.set(u32(0, 8, 8, 0, 0));
  new DataView(fctl.buffer).setUint16(22, 10);
  const idat = (c) => c.find((x) => x.type === 'IDAT').data;
  const apng = writeChunks([r[0], { type: 'acTL', data: u32(1, 0) }, { type: 'IDAT', data: idat(r) }, { type: 'fcTL', data: fctl },
    { type: 'fdAT', data: new Uint8Array([...u32(1), ...idat(g)]) }, { type: 'IEND', data: new Uint8Array(0) }]);
  const j = jpegjs.decode(convert(apng, { format: 'jpeg' }).bytes);
  assert.ok(j.data[1] > 200 && j.data[0] < 50, `green, got ${[...j.data.subarray(0, 3)]}`);
  // Still scrambles and restores as an APNG.
  const frames = (png) => readPng(png).frames.map((f) => Buffer.from(f));
  assert.deepEqual(frames(decode(encode(apng, { key: 'k' }), { key: 'k' })), frames(apng));
});

test('withOrientation patches, adds or makes up the EXIF Orientation', () => {
  const made = withOrientation(null, 6);
  assert.equal(readOrientation(made), 6);
  assert.equal(withOrientation(null, 1), null);
  assert.equal(readOrientation(withOrientation(made, 3)), 3);
  assert.equal(withOrientation(made, 6), made, 'unchanged: the same bytes');
  // No Orientation tag yet: added, the other tags kept.
  const b = Buffer.alloc(26);
  b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4); b.writeUInt16LE(1, 8);
  b.writeUInt16LE(0x0131, 10); b.writeUInt16LE(2, 12); b.writeUInt32LE(4, 14); b.write('abc\0', 18, 'latin1');
  const added = withOrientation(new Uint8Array(b), 8);
  assert.equal(readOrientation(added), 8);
  assert.ok(Buffer.from(added).includes('abc'));
});
