import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { GifWriter } from 'omggif';
import sharp from 'sharp';
import { PNG } from 'pngjs';
import { encode, encodeAsync, decode, convert, inspect } from '../src/index.js';
import { sharpDecoder } from '../src/plugins/sharp.js';
import { buildPng } from '../src/convert/png-build.js';
import { readChunks } from '../src/formats/png/chunks.js';
import { readOrientation } from '../src/meta/exif.js';
import { readPng } from '../src/formats/png/index.js';
import { toRGBA8 } from '../src/formats/png/rgba.js';
import { readSegments, writeSegments, isSof } from '../src/formats/jpeg/markers.js';
import { assembleJpeg, encodeScan } from '../src/formats/jpeg/encode.js';
import { encodePixels } from '../src/formats/jpeg/fdct.js';

const W = 48, H = 32;
const ascii = (s) => Buffer.from(s, 'latin1');
const chunk = (png, type) => readChunks(png).find((c) => c.type === type)?.data;
const chunkTypes = (png) => readChunks(png).map((c) => c.type);
const rgbaOf = (png) => {
  const p = PNG.sync.read(Buffer.from(png));
  return new Uint8Array(p.data);
};

function gradient(w = W, h = H) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    data[o] = (x * 255) / w; data[o + 1] = (y * 255) / h; data[o + 2] = 128; data[o + 3] = 255;
  }
  return data;
}

function tiffWithOrientation(value) {
  const b = Buffer.alloc(26);
  b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  b.writeUInt16LE(1, 8); // one entry
  b.writeUInt16LE(0x0112, 10); b.writeUInt16LE(3, 12); b.writeUInt32LE(1, 14); b.writeUInt16LE(value, 18);
  b.writeUInt32LE(0, 22);
  return b;
}

function fakeIcc(space, size = 3000) {
  const icc = Buffer.alloc(size, 7);
  icc.writeUInt32BE(size, 0);
  icc.write(space, 16, 'latin1');
  icc.write('acsp', 36, 'latin1');
  return icc;
}

const segment = (marker, payload) => {
  const head = Buffer.alloc(4);
  head[0] = 0xff; head[1] = marker; head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
};

/** A baseline JPEG from jpeg-js with extra metadata segments spliced in after SOI. */
function jpegWithMetadata({ icc, exif, xmp, comment, dpi } = {}) {
  const base = jpeg.encode({ width: W, height: H, data: Buffer.from(gradient()) }, 90).data;
  let body = base.subarray(2);
  if (body[0] === 0xff && body[1] === 0xe0) body = body.subarray(2 + body.readUInt16BE(2)); // drop jpeg-js JFIF
  const segs = [];
  if (dpi) {
    const jfif = Buffer.alloc(14);
    jfif.write('JFIF\0', 0, 'latin1'); jfif[5] = 1; jfif[6] = 1; jfif[7] = 1;
    jfif.writeUInt16BE(dpi, 8); jfif.writeUInt16BE(dpi, 10);
    segs.push(segment(0xe0, jfif));
  }
  if (exif) segs.push(segment(0xe1, Buffer.concat([ascii('Exif\0\0'), exif])));
  if (xmp) segs.push(segment(0xe1, Buffer.concat([ascii('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(xmp)])));
  if (icc) {
    // Split across two APP2 segments, deliberately written out of order.
    const half = Math.ceil(icc.length / 2);
    const part = (seq, data) => segment(0xe2, Buffer.concat([ascii('ICC_PROFILE\0'), Buffer.from([seq, 2]), data]));
    segs.push(part(2, icc.subarray(half)), part(1, icc.subarray(0, half)));
  }
  if (comment) segs.push(segment(0xfe, ascii(comment)));
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), ...segs, body]));
}

const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>';

test('JPEG -> PNG carries ICC, EXIF, XMP, density and comments', () => {
  const icc = fakeIcc('RGB ');
  const exif = tiffWithOrientation(6);
  const src = jpegWithMetadata({ icc, exif, xmp: XMP, comment: 'hello', dpi: 300 });
  const r = convert(src, { format: 'png' });
  assert.equal(r.from, 'jpeg');
  assert.equal(r.decoder, 'jpeg-js');
  assert.deepEqual(r.transferred.sort(), ['EXIF', 'ICC profile', 'XMP', 'comments', 'density']);
  assert.deepEqual(r.dropped, []);

  const iccp = chunk(r.bytes, 'iCCP');
  const nul = iccp.indexOf(0);
  assert.ok(Buffer.from(inflateSync(iccp.subarray(nul + 2))).equals(icc), 'ICC reassembled in order');
  assert.ok(Buffer.from(chunk(r.bytes, 'eXIf')).equals(exif));
  assert.equal(readOrientation(chunk(r.bytes, 'eXIf')), 6);
  assert.ok(Buffer.from(chunk(r.bytes, 'iTXt')).toString('utf8').endsWith(XMP));
  assert.equal(Buffer.from(chunk(r.bytes, 'pHYs')).readUInt32BE(0), Math.round(300 / 0.0254));
  assert.equal(Buffer.from(chunk(r.bytes, 'tEXt')).toString('latin1'), 'Comment\0hello');
  // Chunk order rules: iCCP/eXIf before image data.
  const types = chunkTypes(r.bytes);
  assert.ok(types.indexOf('iCCP') < types.indexOf('IDAT') && types.indexOf('eXIf') < types.indexOf('IDAT'));

  // Pixels are exactly what the JPEG decodes to.
  const ref = jpeg.decode(src, { useTArray: true, formatAsRGBA: true });
  assert.deepEqual(rgbaOf(r.bytes), new Uint8Array(ref.data));
});

test('JPEG input encodes to a scrambled PNG that restores exactly', () => {
  const src = jpegWithMetadata({ icc: fakeIcc('RGB '), exif: tiffWithOrientation(3), dpi: 72 });
  let report;
  const scrambled = encode(src, { key: 'k', format: 'png', mode: 'block', block: 8, onConvert: (r) => { report = r; } });
  assert.equal(report.from, 'jpeg');
  assert.equal(inspect(scrambled).scrambled, true);
  const restored = decode(scrambled, { key: 'k' });
  const plain = convert(src, { format: 'png' }).bytes;
  assert.deepEqual(rgbaOf(restored), rgbaOf(plain));
  for (const t of ['iCCP', 'eXIf', 'pHYs']) assert.deepEqual(chunk(restored, t), chunk(plain, t));
  assert.ok(!chunkTypes(restored).includes('pmIx'));
});

test('inspect reports JPEG metadata and orientation', () => {
  const info = inspect(jpegWithMetadata({ exif: tiffWithOrientation(8), xmp: XMP }));
  assert.equal(info.format, 'jpeg');
  assert.equal(info.scrambled, false);
  assert.deepEqual([info.width, info.height], [W, H]);
  assert.deepEqual(info.metadata, ['exif', 'xmp']);
  assert.equal(info.orientation, 8);
});

test('CMYK ICC profiles are dropped with a reason', () => {
  const r = convert(jpegWithMetadata({ icc: fakeIcc('CMYK') }), { format: 'png' });
  assert.ok(!chunk(r.bytes, 'iCCP'));
  assert.deepEqual(r.dropped, ['ICC profile (CMYK colour space)']);
});

test('colour type selection is lossless and minimal', () => {
  const cases = [];
  // 20x20 = 400 pixels, so fully distinct colours cannot fit a palette.
  const make = (fill) => { const d = new Uint8Array(20 * 20 * 4); for (let i = 0; i < 400; i++) d.set(fill(i), i * 4); return d; };
  cases.push(['grey', make((i) => [i & 255, i & 255, i & 255, 255]), 0, 8]);
  cases.push(['grey+alpha', make((i) => [i & 255, i & 255, i & 255, i >> 1]), 4, 8]);
  cases.push(['2 colours', make((i) => (i % 2 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 3, 1]);
  cases.push(['palette+alpha', make((i) => [i % 10, 50, 0, i % 3 ? 255 : 0]), 3, 8]);
  cases.push(['rgb', make((i) => [i & 255, i >> 2, (i * 7) & 255, 255]), 2, 8]);
  cases.push(['rgba', make((i) => [i & 255, i >> 2, (i * 7) & 255, i & 255]), 6, 8]);
  for (const [name, data, colorType, depth] of cases) {
    const { png } = buildPng({ width: 20, height: 20, data });
    const ihdr = chunk(png, 'IHDR');
    assert.equal(ihdr[9], colorType, `${name}: colour type`);
    assert.equal(ihdr[8], depth, `${name}: depth`);
    assert.deepEqual(rgbaOf(png), data, `${name}: pixels`);
  }
});

test('ICC profile space constrains the colour type', () => {
  const grey = new Uint8Array(8 * 8 * 4).map((_, i) => (i % 4 === 3 ? 255 : 90));
  const rgb = buildPng({ width: 8, height: 8, data: grey }, { icc: fakeIcc('RGB ') });
  assert.notEqual(chunk(rgb.png, 'IHDR')[9], 0, 'RGB profile forbids grey PNG');
  assert.ok(chunk(rgb.png, 'iCCP'));
  const colour = gradient(8, 8);
  const bad = buildPng({ width: 8, height: 8, data: colour }, { icc: fakeIcc('GRAY') });
  assert.deepEqual(bad.dropped, ['ICC profile (GRAY profile on a colour image)']);
  assert.deepEqual(rgbaOf(bad.png), colour);
});

test('animated GIF becomes an APNG with every frame, its delays and loop count', () => {
  const buf = Buffer.alloc(8192);
  const gw = new GifWriter(buf, 4, 4, { loop: 2, palette: [0xff0000, 0x00ff00, 0x0000ff, 0xffffff] });
  gw.addFrame(0, 0, 4, 4, [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3], { delay: 20 });
  gw.addFrame(1, 1, 2, 2, [3, 3, 3, 3], { delay: 0, disposal: 2 }); // partial, then cleared
  gw.addFrame(0, 0, 1, 1, [1], { delay: 5 });
  const gif = new Uint8Array(buf.subarray(0, gw.end()));
  const r = convert(gif);
  assert.equal(r.from, 'gif');
  assert.deepEqual(r.dropped, []);
  assert.ok(r.transferred.includes('animation'));
  const info = inspect(r.bytes);
  assert.deepEqual([info.animated, info.frames, info.plays, info.colorType], [true, 3, 2, 3]);
  const fctl = readChunks(r.bytes).filter((c) => c.type === 'fcTL').map((c) => [Buffer.from(c.data).readUInt16BE(20), Buffer.from(c.data).readUInt16BE(22)]);
  assert.deepEqual(fctl, [[20, 100], [10, 100], [5, 100]], 'delays, with 0 played as 10 like browsers do');
  const frames = readPng(r.bytes).frames;
  // frame 1: frame 0 with the 2x2 white square composited in; frame 2: the square disposed.
  const px = (f, x, y) => [...toRGBA8({ ...readPng(r.bytes), pixels: frames[f] }, frames[f]).subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
  assert.deepEqual(px(1, 1, 1), [255, 255, 255, 255]);
  assert.deepEqual(px(2, 1, 1), [0, 0, 0, 0], 'disposal 2 cleared it');
  assert.deepEqual(px(2, 0, 0), [0, 255, 0, 255]);
  // Scrambles and restores like any APNG.
  const restored = decode(encode(gif, { key: 'k' }), { key: 'k' });
  assert.deepEqual(readPng(restored).frames.map((f) => Buffer.from(f)), frames.map((f) => Buffer.from(f)));
  // Other formats keep the first frame.
  assert.deepEqual(convert(gif, { format: 'jpeg' }).dropped, ['animation (first frame kept)']);
});

test('formats without a built-in decoder ask for a plugin', async () => {
  const webp = await sharp(Buffer.from(gradient()), { raw: { width: W, height: H, channels: 4 } }).webp({ lossless: true }).toBuffer();
  assert.throws(() => encode(webp, { key: 'k' }), /pass a decoder plugin/);
  assert.throws(() => encode(webp, { key: 'k', decoders: [sharpDecoder(sharp)] }), { code: 'ASYNC_DECODER' });
  assert.throws(() => encode(jpegWithMetadata(), { key: 'k', format: 'avif' }), /not supported yet/);
});

test('sharp plugin: lossless WebP with ICC + EXIF + XMP', async () => {
  const src = gradient();
  const webp = await sharp(Buffer.from(src), { raw: { width: W, height: H, channels: 4 } })
    .withIccProfile('p3')
    .withExif({ IFD0: { Copyright: 'pixmix test' } })
    .withXmp(XMP)
    .webp({ lossless: true })
    .toBuffer();
  let report;
  const scrambled = await encodeAsync(webp, { key: 'k', decoders: [sharpDecoder(sharp)], onConvert: (r) => { report = r; } });
  assert.equal(report.from, 'webp');
  assert.equal(report.decoder, 'sharp');
  assert.deepEqual(report.transferred.sort(), ['EXIF', 'ICC profile', 'XMP']);
  const restored = decode(scrambled, { key: 'k' });
  // The stored (P3-encoded) values, not an sRGB conversion, since the P3 profile travels along.
  const stored = await sharp(webp).ensureAlpha().keepIccProfile().raw().toBuffer();
  assert.deepEqual(rgbaOf(restored), new Uint8Array(stored), 'stored WebP pixels survive exactly');
  assert.match(Buffer.from(chunk(restored, 'eXIf')).toString('latin1'), /pixmix test/);
});

test('sharp plugin: AVIF uses sharp-provided metadata', async () => {
  const avif = await sharp(Buffer.from(gradient()), { raw: { width: W, height: H, channels: 4 } })
    .withIccProfile('p3')
    .avif({ lossless: true })
    .toBuffer();
  const r = await (await import('../src/index.js')).convertAsync(avif, { decoders: [sharpDecoder(sharp)] });
  assert.equal(r.from, 'avif');
  assert.ok(r.transferred.includes('ICC profile'));
  const p = PNG.sync.read(Buffer.from(r.bytes));
  assert.equal(p.width, W);
  assert.equal(p.height, H);
});

test('lossless output of a lossy source carries a size note; JPEG output does not', () => {
  const src = jpegWithMetadata();
  let report;
  encode(src, { key: 'k', format: 'png', onConvert: (r) => { report = r; } });
  assert.equal(report.notes.length, 1);
  assert.match(report.notes[0], /jpeg is lossy/);
  encode(src, { key: 'k', onConvert: (r) => { report = r; } });
  assert.deepEqual(report.notes ?? [], []);
});

// --- the built-in JPEG decoder against libjpeg -------------------------------------

/** A 4:4:4 JPEG built by pixmix's writer, with `edit(segments)` applied. */
function builtJpeg(edit = (s) => s, { w = W, h = H, subsampling = '4:4:4' } = {}) {
  const { frame, dqt } = encodePixels({ width: w, height: h, data: gradient(w, h).map((v, i) => (i % 4 === 2 ? (i * 7) & 255 : v)) }, { subsampling });
  return writeSegments(edit(readSegments(assembleJpeg([dqt], frame, { progressive: false })).segments, frame));
}
const meanDiff = async (jpegBytes, png) => {
  const ref = await sharp(jpegBytes, { failOn: 'none' }).ensureAlpha().raw().toBuffer();
  const mine = rgbaOf(png);
  let s = 0;
  for (let i = 0; i < ref.length; i++) s += Math.abs(ref[i] - mine[i]);
  return s / ref.length;
};
const withSof = (segments, change) => segments.map((s) => (isSof(s.marker) ? change(s) : s));
const app14 = (transform) => ({ marker: 0xee, data: Uint8Array.from([0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, transform]) });

test('built-in JPEG decoder picks the colour transform like libjpeg (RGB-coded files)', async () => {
  const cases = {
    'YCbCr, no markers': (s) => s,
    'Adobe transform 0': (s) => [app14(0), ...s],
    'component ids R G B': (s) => withSof(s, (sof) => {
      const data = sof.data.slice();
      data[6] = 0x52; data[9] = 0x47; data[12] = 0x42;
      return { ...sof, data };
    }).map((x) => (x.marker === 0xda ? { ...x, data: Uint8Array.from(x.data, (b, i) => (i === 1 ? 0x52 : i === 3 ? 0x47 : i === 5 ? 0x42 : b)) } : x)),
    'JFIF wins over Adobe transform 0': (s) => [{ marker: 0xe0, data: ascii('JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00') }, app14(0), ...s],
  };
  for (const [name, edit] of Object.entries(cases)) {
    const src = builtJpeg(edit);
    const d = await meanDiff(src, convert(src, { format: 'png' }).bytes);
    assert.ok(d < 1.5, `${name}: mean difference to libjpeg ${d.toFixed(2)}`);
  }
});

test('built-in JPEG decoder refuses what pixmix cannot decode, like the JPEG path', () => {
  const src = builtJpeg();
  const code = (bytes) => { try { convert(bytes, { format: 'png' }); return 'ok'; } catch (err) { return err.code; } };
  assert.equal(code(builtJpeg((s) => withSof(s, (sof) => ({ ...sof, data: Uint8Array.from(sof.data, (b, i) => (i ? b : 12)), marker: 0xc1 })))), 'UNSUPPORTED', '12-bit');
  for (const marker of [0xc3, 0xc9, 0xc5]) assert.equal(code(builtJpeg((s) => withSof(s, (sof) => ({ ...sof, marker })))), 'UNSUPPORTED', marker.toString(16));
  assert.equal(code(src.subarray(0, 40)), 'BAD_JPEG');
});

test('built-in JPEG decoder reads what libjpeg tolerates: truncation, stray bytes, no DHT, DQT between scans', async () => {
  const full = builtJpeg();
  const noDht = (() => {
    // A frame coded with the Annex K tables, then without its DHT (Motion-JPEG style).
    const std = new Uint8Array(jpeg.encode({ width: W, height: H, data: gradient() }, 90).data);
    return [std, writeSegments(readSegments(std).segments.filter((s) => s.marker !== 0xc4))];
  })();
  const at = 2 + 4 + readSegments(full).segments[0].data.length;
  const cases = {
    truncated: [full, full.subarray(0, Math.floor(full.length * 0.6))],
    'stray bytes': [full, Uint8Array.from([...full.subarray(0, at), 0, 0, 7, ...full.subarray(at)])],
    'no DHT': noDht,
  };
  for (const [name, [ref, bytes]] of Object.entries(cases)) {
    const png = convert(bytes, { format: 'png' }).bytes;
    const d = await meanDiff(bytes, png);
    assert.ok(d < 1.5, `${name}: mean difference to libjpeg ${d.toFixed(2)}`);
    if (name !== 'truncated') assert.ok((await meanDiff(ref, png)) < 1.5, `${name}: the intact image`);
  }
  // Table 0 redefined before the second of three single-component scans.
  const { frame, dqt } = encodePixels({ width: W, height: H, data: gradient() }, { subsampling: '4:4:4' });
  const segs = [dqt, { marker: 0xc0, data: frame.sof }];
  frame.components.forEach((_, only) => {
    if (only === 1) segs.push({ marker: 0xdb, data: Uint8Array.from([0, ...Array(64).fill(40), 1, ...Array(64).fill(3)]) });
    const s = encodeScan(frame, { only });
    segs.push({ marker: 0xc4, data: s.dht }, { marker: 0xda, data: s.sos, ecs: s.ecs });
  });
  const redefined = writeSegments(segs);
  assert.ok((await meanDiff(redefined, convert(redefined, { format: 'png' }).bytes)) < 1.5, 'DQT between scans');
});

test('built-in JPEG decoder: CMYK is converted by formula, and the report says so', () => {
  const cmyk = builtJpeg((s, frame) => {
    const out = withSof(s, (sof) => {
      const data = new Uint8Array(sof.data.length + 3);
      data.set(sof.data);
      data[5] = 4;
      data.set([4, 0x11, 0], sof.data.length);
      return { ...sof, data };
    });
    // The 4th component (K) repeats the first's coefficients in a scan of its own.
    const k = encodeScan({ ...frame, components: [{ ...frame.components[0], id: 4 }] });
    const i = out.findIndex((x) => x.marker === 0xda);
    out.splice(i + 1, 0, { marker: 0xc4, data: k.dht }, { marker: 0xda, data: k.sos, ecs: k.ecs });
    return out;
  });
  for (const [name, bytes] of [['Adobe CMYK', writeSegments([app14(0), ...readSegments(cmyk).segments])], ['no Adobe segment', cmyk]]) {
    const r = convert(bytes, { format: 'png' });
    assert.ok(r.dropped.some((d) => /^CMYK colours \(converted to RGB by formula/.test(d)), name);
  }
  const ycck = writeSegments([app14(2), ...readSegments(cmyk).segments]);
  assert.ok(convert(ycck, { format: 'png' }).dropped.some((d) => d.startsWith('YCCK colours')));
});
