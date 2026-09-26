import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { encode, decode, rekey, inspect, convert, WrongKeyError } from '../src/index.js';
import { readSegments, writeSegments, M } from '../src/formats/jpeg/markers.js';
import { decodeFrame } from '../src/formats/jpeg/decode.js';
import { assembleJpeg, encodeScan } from '../src/formats/jpeg/encode.js';
import { encodePixels } from '../src/formats/jpeg/fdct.js';
import { buildOptimalSpec, buildEncodeTable, writeDht, BitWriter } from '../src/formats/jpeg/huffman.js';
import { buildPng } from '../src/convert/png-build.js';

const coefs = (b) => decodeFrame(readSegments(b).segments).components.map((c) => Buffer.from(c.coefs.buffer));
const sameCoefs = (a, b) => coefs(a).every((c, i) => c.equals(coefs(b)[i]));
const pixels = (b) => sharp(b).raw().toBuffer();
const nonCoding = (b) => readSegments(b).segments
  .filter((s) => ![M.DHT, M.SOS, M.DRI].includes(s.marker) && !(s.marker >= 0xc0 && s.marker <= 0xcf))
  .filter((s) => !(s.marker === M.APP15 && Buffer.from(s.data.subarray(0, 7)).toString('latin1') === 'pixmix\0'))
  .map((s) => s.marker.toString(16) + Buffer.from(s.data).toString('hex'));

function gradient(w, h) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    d[o] = (x * 7) & 255; d[o + 1] = (y * 5) & 255; d[o + 2] = ((x ^ y) * 3) & 255; d[o + 3] = 255;
  }
  return d;
}
const fromRaw = (w, h) => sharp(Buffer.from(gradient(w, h)), { raw: { width: w, height: h, channels: 4 } }).removeAlpha();

const VARIANTS = [
  ['baseline 4:2:0', 64, 48, { quality: 80 }],
  ['odd size 4:2:0', 37, 23, { quality: 80 }],
  ['4:4:4', 50, 30, { quality: 90, chromaSubsampling: '4:4:4' }],
  ['progressive 4:2:0', 70, 45, { quality: 85, progressive: true }],
  ['progressive 4:4:4', 33, 65, { quality: 95, progressive: true, chromaSubsampling: '4:4:4' }],
  ['mozjpeg (optimised progressive scans)', 90, 60, { quality: 75, mozjpeg: true }],
  ['tiny (single MCU)', 7, 5, { quality: 90 }],
];

for (const [name, w, h, opts] of VARIANTS) {
  test(`JPEG -> JPEG is lossless: ${name}`, async () => {
    const src = new Uint8Array(await fromRaw(w, h).jpeg(opts).toBuffer());
    for (const transforms of [true, false]) {
      const scrambled = encode(src, { key: 'k', transforms });
      const info = inspect(scrambled);
      assert.equal(info.format, 'jpeg');
      assert.equal(info.scrambled, true);
      assert.equal(info.transforms, transforms);
      const restored = decode(scrambled, { key: 'k' });
      assert.ok(sameCoefs(src, restored), 'identical DCT coefficients');
      assert.ok((await pixels(src)).equals(await pixels(restored)), 'libjpeg decodes identical pixels');
      if (w * h > 64) assert.ok(!(await pixels(src)).equals(await pixels(scrambled)), 'scrambled looks different');
      assert.deepEqual(nonCoding(restored), nonCoding(src), 'APPn/COM/DQT and SOF payload unchanged');
    }
  });
}

test('pixmix-encoded JPEGs: grey, 4:2:2 (flips only), restart intervals', async () => {
  const w = 45, h = 37;
  const grey = gradient(w, h).map((v, i) => (i % 4 === 3 ? 255 : 0));
  for (let i = 0; i < grey.length; i += 4) grey[i] = grey[i + 1] = grey[i + 2] = (i / 4) % 251;
  const cases = [
    ['grey', encodePixels({ width: w, height: h, data: grey }, { grey: true }), 0],
    ['4:2:2', encodePixels({ width: w, height: h, data: gradient(w, h) }, { subsampling: '4:2:2' }), 0],
    ['restarts', encodePixels({ width: w, height: h, data: gradient(w, h) }), 3],
  ];
  for (const [name, { frame, dqt }, restartInterval] of cases) {
    const src = assembleJpeg([dqt], frame, { restartInterval });
    assert.equal((await sharp(src).metadata()).width, w, `${name}: libjpeg reads it`);
    const restored = decode(encode(src, { key: name }), { key: name });
    assert.ok(sameCoefs(src, restored), `${name}: coefficients`);
    assert.ok((await pixels(src)).equals(await pixels(restored)), `${name}: pixels`);
  }
  const [, greyJpeg] = cases[0];
  assert.equal(inspect(assembleJpeg([greyJpeg.dqt], greyJpeg.frame)).components, 1, 'grey is one component');
});

test('wrong key, double scrambling, PNG-only modes', async () => {
  const src = new Uint8Array(await fromRaw(40, 40).jpeg().toBuffer());
  const s = encode(src, { key: 'right' });
  assert.throws(() => decode(s, { key: 'wrong' }), WrongKeyError);
  assert.throws(() => encode(s, { key: 'x' }), /already scrambled/);
  assert.throws(() => encode(src, { key: 'k', mode: 'pixel' }), /only applies to PNG/);
  assert.equal(inspect(encode(src, { key: 'k', mode: 'mcu' })).mode, 'mcu');
});

test('rekey JPEG, including switching transforms off', async () => {
  const src = new Uint8Array(await fromRaw(64, 40).jpeg({ progressive: true }).toBuffer());
  const a = encode(src, { key: 'one' });
  const b = rekey(a, { from: 'one', to: 'two', transforms: false });
  assert.equal(inspect(b).transforms, false);
  assert.throws(() => decode(b, { key: 'one' }), WrongKeyError);
  assert.ok(sameCoefs(decode(b, { key: 'two' }), src));
});

test('JPEG input defaults to JPEG output; PNG still available', async () => {
  const src = new Uint8Array(await fromRaw(32, 32).jpeg().toBuffer());
  assert.equal(inspect(encode(src, { key: 'k' })).format, 'jpeg');
  assert.equal(inspect(encode(src, { key: 'k', format: 'png' })).format, 'png');
});

// --- previews that would leak the unscrambled image --------------------------------

function exifWithThumbnail() {
  // IFD0 { Orientation = 1 } -> IFD1 { JPEGInterchangeFormat, Length } -> 20 thumbnail bytes
  const b = Buffer.alloc(8 + 18 + 30 + 20);
  b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  b.writeUInt16LE(1, 8);
  b.writeUInt16LE(0x0112, 10); b.writeUInt16LE(3, 12); b.writeUInt32LE(1, 14); b.writeUInt16LE(1, 18);
  b.writeUInt32LE(26, 22); // next IFD
  b.writeUInt16LE(2, 26);
  b.writeUInt16LE(0x0201, 28); b.writeUInt16LE(4, 30); b.writeUInt32LE(1, 32); b.writeUInt32LE(56, 36);
  b.writeUInt16LE(0x0202, 40); b.writeUInt16LE(4, 42); b.writeUInt32LE(1, 44); b.writeUInt32LE(20, 48);
  b.writeUInt32LE(0, 52);
  b.fill(0xab, 56);
  return b;
}

const seg = (marker, payload) => {
  const h = Buffer.alloc(4);
  h[0] = 0xff; h[1] = marker; h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
};

test('embedded previews and trailing images are stripped by default', async () => {
  const base = await fromRaw(48, 32).jpeg().toBuffer();
  const body = base.subarray(2);
  const jfifThumb = Buffer.concat([Buffer.from('JFIF\0\x01\x01\x00\x00\x01\x00\x01', 'latin1'), Buffer.from([2, 1]), Buffer.alloc(6, 0x55)]);
  const irb = Buffer.concat([
    Buffer.from('Photoshop 3.0\0', 'latin1'),
    Buffer.from('8BIM'), Buffer.from([0x04, 0x0c, 0, 0]), Buffer.from([0, 0, 0, 4]), Buffer.from('THMB'),
    Buffer.from('8BIM'), Buffer.from([0x04, 0x04, 0, 0]), Buffer.from([0, 0, 0, 2]), Buffer.from('ok'),
  ]);
  const src = new Uint8Array(Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, jfifThumb),
    seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifWithThumbnail()])),
    seg(0xe2, Buffer.from('MPF\0 index', 'latin1')),
    seg(0xed, irb),
    body,
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]), // a "secondary image" after EOI
  ]));

  let report;
  const scrambled = encode(src, { key: 'k', onConvert: (r) => { report = r; } });
  assert.deepEqual(report.dropped.sort(), [
    '4 bytes after the image (e.g. secondary images, motion-photo video)',
    'EXIF thumbnail', 'JFIF thumbnail', 'MPF index (secondary images)', 'Photoshop thumbnail',
  ]);
  const { segments, trailing } = readSegments(scrambled);
  assert.equal(trailing.length, 0);
  const text = Buffer.from(scrambled).toString('latin1');
  assert.ok(!text.includes('THMB') && !text.includes('MPF\0') && !text.includes('\xab\xab\xab'));
  assert.ok(text.includes('8BIM\x04\x04'), 'other Photoshop resources kept');
  const exif = segments.find((s) => s.marker === 0xe1).data;
  assert.equal(Buffer.from(exif).readUInt32LE(6 + 22), 0, 'IFD1 unlinked');

  // Opting out keeps everything (but the trailing data, which cannot survive re-encoding).
  const kept = encode(src, { key: 'k', keepThumbnails: true });
  assert.ok(Buffer.from(kept).toString('latin1').includes('THMB'));
});

// --- other formats to JPEG ---------------------------------------------------------

test('PNG -> JPEG maps metadata, flattens alpha and restores losslessly', async () => {
  const w = 40, h = 24;
  const data = gradient(w, h);
  for (let i = 3; i < data.length; i += 16) data[i] = 0; // some transparency
  const bigIcc = Buffer.alloc(70000, 3);
  bigIcc.writeUInt32BE(70000, 0); bigIcc.write('RGB ', 16, 'latin1'); bigIcc.write('acsp', 36, 'latin1');
  const { png } = buildPng({ width: w, height: h, data }, {
    icc: bigIcc, xmp: '<x:xmpmeta/>', comments: ['hi'], density: { x: 11811, y: 11811, unit: 'meter' },
  });
  let report;
  const scrambled = encode(png, { key: 'k', format: 'jpeg', quality: 85, background: '#000000', onConvert: (r) => { report = r; } });
  assert.equal(report.from, 'png');
  assert.equal(report.format, 'jpeg');
  assert.deepEqual(report.transferred.sort(), ['ICC profile', 'XMP', 'comments', 'density']);
  assert.deepEqual(report.dropped, ['transparency (flattened onto #000000)']);

  const restored = decode(scrambled, { key: 'k' });
  const meta = await sharp(restored).metadata();
  assert.equal(meta.icc.length, 70000, 'ICC split over two APP2 segments and reassembled');
  assert.equal(meta.density, 300);
  const plain = convert(png, { format: 'jpeg', quality: 85, background: '#000000' }).bytes;
  assert.ok(sameCoefs(plain, restored));
});

test('truncated JPEG data is zero-filled, not fatal', async () => {
  const full = await fromRaw(64, 64).jpeg().toBuffer();
  const cut = new Uint8Array(Buffer.concat([full.subarray(0, full.length - 200), Buffer.from([0xff, 0xd9])]));
  const s = encode(cut, { key: 'k' });
  assert.ok(sameCoefs(decode(s, { key: 'k' }), cut));
});

test('progressive JPEGs stay progressive through scramble and restore; option overrides', async () => {
  const prog = new Uint8Array(await fromRaw(96, 64).jpeg({ progressive: true }).toBuffer());
  const s = encode(prog, { key: 'k' });
  assert.equal(inspect(s).progressive, true);
  const r = decode(s, { key: 'k' });
  assert.equal(inspect(r).progressive, true);
  assert.ok(sameCoefs(r, prog));
  assert.equal((await sharp(r).metadata()).isProgressive, true);
  assert.ok((await pixels(r)).equals(await pixels(prog)));

  const base = new Uint8Array(await fromRaw(96, 64).jpeg().toBuffer());
  const forced = encode(base, { key: 'k', progressive: true });
  assert.equal(inspect(forced).progressive, true);
  assert.equal(inspect(decode(forced, { key: 'k' })).progressive, true, 'restored like the scrambled file');
  assert.equal(inspect(encode(prog, { key: 'k', progressive: false })).progressive, false);
  assert.equal(inspect(rekey(s, { from: 'k', to: 'j' })).progressive, true);
  // With partial edge MCUs the scrambled file has to be baseline, but restores progressive.
  const odd = new Uint8Array(await fromRaw(70, 45).jpeg({ progressive: true }).toBuffer());
  const so = encode(odd, { key: 'k' });
  assert.equal(inspect(so).progressive, false);
  const ro = decode(so, { key: 'k' });
  assert.equal(inspect(ro).progressive, true);
  assert.ok(sameCoefs(ro, odd));
  assert.equal(inspect(decode(rekey(so, { from: 'k', to: 'j' }), { key: 'j' })).progressive, true);
  // Pixel sources can be written progressive too.
  const png = convert(new Uint8Array(await fromRaw(40, 30).png().toBuffer()), { format: 'jpeg', progressive: true }).bytes;
  assert.equal(inspect(png).progressive, true);
});

test('stray bytes before a marker and Motion-JPEG frames without DHT decode like libjpeg', async () => {
  // Coded with the Annex K tables, so it still decodes once its DHT is removed.
  const src = new Uint8Array(await fromRaw(56, 40).jpeg({ quality: 85, optimiseCoding: false }).toBuffer());
  const { segments } = readSegments(src);
  const at = 2 + 4 + segments[0].data.length; // after APP0
  const stray = new Uint8Array(Buffer.concat([src.subarray(0, at), Buffer.from([0, 0, 0x12, 0xff, 0]), src.subarray(at)]));
  assert.equal(readSegments(stray).damaged, true);
  assert.equal(readSegments(src).damaged, false);
  const noDht = writeSegments(segments.filter((s) => s.marker !== M.DHT));
  for (const [name, bytes] of [['stray bytes', stray], ['no DHT', noDht]]) {
    const ref = await sharp(bytes, { failOn: 'none' }).raw().toBuffer();
    const scrambled = encode(bytes, { key: 'k' });
    assert.ok(readSegments(scrambled).segments.some((s) => s.marker === M.DHT), `${name}: tables written`);
    const restored = decode(scrambled, { key: 'k' });
    assert.ok(sameCoefs(restored, src), `${name}: coefficients`);
    assert.ok(ref.equals(await pixels(restored)), `${name}: libjpeg pixels`);
  }
});

test('an overflowed DC predictor is written as wrapped differences libjpeg reads', async () => {
  // Corrupt but libjpeg-decodable: every block adds 2047 to the DC, running past 16 bits.
  const blocks = 40;
  const dcFreq = new Uint32Array(257), acFreq = new Uint32Array(257);
  dcFreq[11] = acFreq[0] = blocks;
  const dcSpec = buildOptimalSpec(dcFreq), acSpec = buildOptimalSpec(acFreq);
  const dcT = buildEncodeTable(dcSpec), acT = buildEncodeTable(acSpec);
  const w = new BitWriter();
  for (let b = 0; b < blocks; b++) { w.put(dcT.code[11], dcT.size[11]); w.put(2047, 11); w.put(acT.code[0], acT.size[0]); }
  const src = writeSegments([
    { marker: M.DQT, data: Uint8Array.from([0, ...Array(64).fill(1)]) },
    { marker: M.SOF0, data: Uint8Array.from([8, 0, 8, (blocks * 8) >> 8, (blocks * 8) & 255, 1, 1, 0x11, 0]) },
    { marker: M.DHT, data: writeDht([{ tableClass: 0, id: 0, spec: dcSpec }, { tableClass: 1, id: 0, spec: acSpec }]) },
    { marker: M.SOS, data: Uint8Array.from([1, 1, 0, 0, 63, 0]), ecs: w.result() },
  ]);
  const ref = await pixels(src);
  for (const progressive of [false, true]) {
    const scrambled = encode(src, { key: 'k', progressive });
    await pixels(scrambled); // libjpeg reads it
    const restored = decode(scrambled, { key: 'k' });
    assert.ok(sameCoefs(restored, src));
    assert.ok(ref.equals(await pixels(restored)));
  }
});

/** A 4:4:4 frame relabelled with every component sampled 2x2 (12 blocks per MCU). */
function sampled2x2(w, h) {
  const { frame, dqt } = encodePixels({ width: w, height: h, data: gradient(w, h) }, { subsampling: '4:4:4' });
  const mcusX = Math.ceil(w / 16), mcusY = Math.ceil(h / 16);
  const sof = frame.sof.slice();
  for (let i = 0; i < 3; i++) sof[7 + i * 3] = 0x22;
  const components = frame.components.map((c) => {
    const blocksW = mcusX * 2, blocksH = mcusY * 2;
    const coefs = new Int16Array(blocksW * blocksH * 64);
    for (let by = 0; by < c.realH; by++) coefs.set(c.coefs.subarray(by * c.blocksW * 64, (by * c.blocksW + c.realW) * 64), by * blocksW * 64);
    return { ...c, h: 2, v: 2, blocksW, blocksH, coefs };
  });
  return { dqt, frame: { ...frame, sof, hmax: 2, vmax: 2, mcusX, mcusY, components } };
}

test('more than 10 blocks per MCU: one scan per component, which libjpeg reads', async () => {
  const { frame, dqt } = sampled2x2(64, 48);
  for (const progressive of [false, true]) {
    const src = assembleJpeg([dqt], frame, { progressive });
    assert.equal(readSegments(src).segments.filter((s) => s.marker === M.SOS).length, progressive ? 3 + 4 : 3);
    const ref = await pixels(src);
    for (const opts of [{}, { progressive: !progressive }]) {
      const scrambled = encode(src, { key: 'k', ...opts });
      assert.ok(!ref.equals(await pixels(scrambled)), 'libjpeg reads the scrambled file');
      const restored = decode(scrambled, { key: 'k' });
      assert.ok(sameCoefs(restored, src));
      assert.ok(ref.equals(await pixels(restored)));
      assert.ok(ref.equals(await pixels(decode(rekey(scrambled, { from: 'k', to: 'j' }), { key: 'j' }))));
    }
  }
  // With partial edge MCUs such scans cannot hold what scrambling moves into the padding.
  const odd = sampled2x2(40, 24);
  const src = assembleJpeg([odd.dqt], odd.frame);
  await pixels(src);
  assert.throws(() => encode(src, { key: 'k' }), (err) => err.code === 'UNSUPPORTED');
});

/** One scan per component, with a DQT redefining tables 0 and 1 before the second scan. */
function dqtBetweenScans(w, h) {
  const { frame, dqt } = encodePixels({ width: w, height: h, data: gradient(w, h) }, { subsampling: '4:4:4' });
  const coarse = { marker: M.DQT, data: Uint8Array.from([0, ...Array(64).fill(40), 1, ...Array(64).fill(3)]) };
  const segs = [dqt, { marker: M.SOF0, data: frame.sof }];
  frame.components.forEach((_, only) => {
    if (only === 1) segs.push(coarse);
    const { dht, sos, ecs } = encodeScan(frame, { only });
    segs.push({ marker: M.DHT, data: dht }, { marker: M.SOS, data: sos, ecs });
  });
  return writeSegments(segs);
}

test('quantisation tables redefined between scans keep the image', async () => {
  const src = dqtBetweenScans(48, 32);
  const ref = await pixels(src);
  for (const progressive of [false, true]) {
    const scrambled = encode(src, { key: 'k', progressive });
    const restored = decode(scrambled, { key: 'k' });
    assert.ok(sameCoefs(restored, src));
    assert.ok(ref.equals(await pixels(restored)), 'libjpeg decodes the same image');
    assert.equal(readSegments(restored).segments.filter((s) => s.marker === M.DQT).length, 1);
    assert.ok(ref.equals(await pixels(decode(rekey(scrambled, { from: 'k', to: 'j' }), { key: 'j' }))));
  }
  // A plain file keeps its DQT segments byte for byte.
  const plain = new Uint8Array(await fromRaw(48, 32).jpeg().toBuffer());
  assert.deepEqual(nonCoding(decode(encode(plain, { key: 'k' }), { key: 'k' })), nonCoding(plain));
});
