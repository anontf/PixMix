// Metadata policies on every format: each preset, set/remove operations checked with
// independent readers (exifr for EXIF/XMP, sharp/libvips, pngjs, jxl-oxide through pixmix's
// decoder), pixmix's own chunks and watermarks surviving every policy, and exact restoring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';
import { PNG } from 'pngjs';
import { deflateSync } from 'node:zlib';
import {
  encode, encodeAsync, decode, decodeAsync, rekey, rekeyAsync, convert, convertAsync, inspect, applyMetadata, applyMetadataAsync,
  readMetadata, PixmixError,
} from '../src/index.js';
import { readPng } from '../src/formats/png/index.js';
import { readChunks, writeChunks } from '../src/formats/png/chunks.js';
import { readSegments, writeSegments } from '../src/formats/jpeg/markers.js';
import { decodeFrame } from '../src/formats/jpeg/decode.js';
import { readJxl, writeJxl } from '../src/formats/jxl/container.js';
import { loadJxlCodec } from '../src/formats/jxl/load.js';
import { parseExif, writeExif, encodeEntry, settableTag } from '../src/meta/tiff.js';
import { normalizePolicy, normalizeProfile, formatProfile, PRESET_NAMES } from '../src/meta/policy.js';
import { metadataProfileStore, loadMetadataPolicy } from '../src/meta/profiles.js';
import { compileWatermark } from '../src/watermark/compile.js';

const KEY = 'meta-key';
const SALT = new Uint8Array(16).fill(5);
const ascii = (s) => Buffer.from(s, 'latin1');
const segment = (marker, payload) => ({ marker, data: new Uint8Array(payload) });

/** An EXIF block like a phone's: owner, device, serials, timestamps, GPS, a MakerNote. */
function phoneExif(orientation = 6) {
  const e = { le: true, ifds: { IFD0: [], Exif: [], GPS: [] }, subIfds: [], makerNoteOffset: null, warnings: [] };
  const put = (name, v) => { const info = settableTag(name); e.ifds[info.ifd].push(encodeEntry(info, v, true)); };
  put('Make', 'Phonemaker'); put('Model', 'P1'); put('Orientation', orientation); put('Artist', 'Jane Doe'); put('Copyright', 'Jane Doe');
  put('DateTime', '2024:05:06 07:08:09'); put('Software', 'Camera 2.0'); put('HostComputer', "Jane's phone");
  put('DateTimeOriginal', '2024:05:06 07:08:09'); put('BodySerialNumber', 'SN-42'); put('LensModel', 'Wide'); put('FNumber', 1.8);
  put('CameraOwnerName', 'Jane'); put('GPSLatitudeRef', 'N'); put('GPSLatitude', [48, 51, 24]); put('GPSLongitudeRef', 'E'); put('GPSLongitude', [2, 17, 40]);
  e.ifds.Exif.push({ tag: 0x927c, type: 7, count: 16, data: Uint8Array.from('Vendor notes 123', (c) => c.charCodeAt(0)) });
  return writeExif(e).tiff;
}

const XMP = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmp:CreatorTool="Editor" xmp:CreateDate="2024-05-06T07:08:09" exif:GPSLatitude="48,51.4N" photoshop:City="Paris" xmpMM:DocumentID="doc-1">
<dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Sunset</rdf:li></rdf:Alt></dc:title>
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

function iptcSegment() {
  const ds = (n, text) => Buffer.concat([Buffer.from([0x1c, 2, n, 0, text.length]), ascii(text)]);
  const iim = Buffer.concat([ds(80, 'Jane Doe'), ds(90, 'Paris'), ds(116, 'Jane 2024'), ds(25, 'sunset')]);
  const head = Buffer.alloc(12);
  head.write('8BIM'); head.writeUInt16BE(0x0404, 4); head.writeUInt32BE(iim.length, 8);
  return segment(0xed, Buffer.concat([ascii('Photoshop 3.0\0'), head, iim, Buffer.alloc(iim.length & 1)]));
}

/** APP11: a (minimal, valid) JUMBF superbox labelled c2pa, as C2PA manifests are. */
function jumbf() {
  const jumd = Buffer.concat([Buffer.from([0, 0, 0, 30]), ascii('jumd'), Buffer.alloc(16, 0x11), Buffer.from([3]), ascii('c2pa\0')]);
  const jumb = Buffer.concat([Buffer.from([0, 0, 0, 8 + jumd.length]), ascii('jumb'), jumd]);
  return [...ascii('JP'), 0, 1, 0, 0, 0, 1, ...jumb];
}

let fixtures = null;
/** The same picture as JPEG, PNG, JPEG XL (pixel route) and JPEG XL (JPEG route), with metadata of every kind. */
async function build() {
  if (fixtures) return fixtures;
  const w = 64, h = 48;
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 7) & 255; px[i * 3 + 1] = (i >> 6) * 5; px[i * 3 + 2] = (i * 13) & 255; }
  const base = new Uint8Array(await sharp(px, { raw: { width: w, height: h, channels: 3 } }).withIccProfile('p3').jpeg({ quality: 90 }).toBuffer());
  const { segments } = readSegments(base);
  const jfif = segment(0xe0, [...ascii('JFIF\0'), 1, 2, 1, 0, 72, 0, 72, 0, 0]);
  const extra = [jfif, segment(0xe1, [...ascii('Exif\0\0'), ...phoneExif()]), segment(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/\0'), ...Buffer.from(XMP)]),
    iptcSegment(), segment(0xeb, jumbf()), segment(0xfe, ascii('shot on a phone'))];
  const jpeg = writeSegments([...extra, ...segments.filter((s) => s.marker !== 0xe0 && !(s.marker === 0xe1))]);
  const converted = convert(jpeg, { format: 'png' }).bytes;
  const chunks = readChunks(converted);
  const at = chunks.findIndex((c) => c.type === 'IDAT');
  chunks.splice(at, 0,
    { type: 'tEXt', data: new Uint8Array(Buffer.concat([ascii('Author\0'), ascii('Jane Doe')])) },
    { type: 'tEXt', data: new Uint8Array(Buffer.concat([ascii('Title\0'), ascii('Sunset')])) },
    { type: 'zTXt', data: new Uint8Array(Buffer.concat([ascii('Raw profile type exif\0\0'), deflateSync(ascii('\nexif\n  10\n4578696600004d4d\n'))])) },
    { type: 'tIME', data: Uint8Array.of(0x07, 0xe8, 5, 6, 7, 8, 9) },
    { type: 'vpAg', data: new Uint8Array(9) },
    { type: 'caBX', data: new Uint8Array([...ascii('jumbc2pa')]) },
    { type: 'gAMA', data: Uint8Array.of(0, 0, 0xb1, 0x8f) });
  const png = writeChunks(chunks);
  const jxlPixels = (await convertAsync(png, { format: 'jxl' })).bytes;
  const jx = readJxl(jxlPixels);
  const jxl = writeJxl([...jx.boxes.filter((b) => b.type !== 'ftyp' && b.type !== 'jxlc'), { type: 'jumb', data: new Uint8Array([...ascii('c2pa manifest')]) }], jx.codestream);
  const jxlJpeg = await (await loadJxlCodec()).transcodeJpeg(convert(jpeg).bytes);
  fixtures = { jpeg, png, jxl, jxlJpeg };
  return fixtures;
}

const exifOf = (bytes) => exifr.parse(Buffer.from(bytes), { tiff: true, exif: true, gps: true, xmp: false, iptc: true, icc: true, makerNote: true, translateValues: false, reviveValues: false, mergeOutput: false });
/** XMP as exifr reads it: {namespace prefix: {property: value}}. */
const xmpOf = (bytes) => exifr.parse(Buffer.from(bytes), { tiff: false, xmp: true, mergeOutput: false }).then((x) => x ?? {});

/** Pixels (PNG), coefficients (JPEG) or decoded samples (JPEG XL) that restoring must give back. */
async function essence(bytes) {
  const f = inspect(bytes).format;
  if (f === 'png') return readPng(bytes).frames.map((x) => Buffer.from(x));
  if (f === 'jpeg') return decodeFrame(readSegments(bytes).segments).components.map((c) => Buffer.from(c.coefs.buffer));
  const codec = await loadJxlCodec();
  const jpeg = await codec.reconstructJpeg(bytes).catch(() => null);
  if (jpeg) return essence(jpeg);
  return [Buffer.from((await codec.decode(bytes, { srgb: false })).data)];
}

const POLICIES = {
  keep: 'keep',
  'strip-all': 'strip-all',
  privacy: 'privacy',
  web: 'web',
  'web + set': { preset: 'web', set: { artist: 'Vivi', copyright: 'Vivi' } },
  custom: {
    preset: 'privacy', strip: ['text'], remove: ['exif:Make', 'xmp:dc:title', 'iptc:Keywords', 'other:vpAg'],
    set: { copyright: 'Vivi', software: 'pixmix', exif: { DateTime: '2025:01:01 00:00:00' }, xmp: { 'xmpRights:Marked': 'True' }, icc: 'srgb' },
  },
};

for (const format of ['jpeg', 'png', 'jxl', 'jxlJpeg']) {
  test(`metadata policies on ${format}: every preset, checked by independent readers; restoring stays exact`, async () => {
    const f = await build();
    const input = f[format];
    const reference = await essence(format.startsWith('jxl') ? input : (await convertAsync(input)).bytes);
    for (const [name, policy] of Object.entries(POLICIES)) {
      let report;
      const scrambled = await encodeAsync(input, { key: KEY, salt: SALT, metadata: policy, onConvert: (r) => { report = r.metadata; } });
      assert.ok(report, `${name}: reported`);
      const info = inspect(scrambled, { metadata: true });
      assert.ok(info.scrambled, `${name}: marker kept`);
      const restored = await decodeAsync(scrambled, { key: KEY });
      assert.deepEqual(await essence(restored), reference, `${name}: exact restore`);
      assert.deepEqual(readMetadata(restored).exif?.tags, info.meta.exif?.tags, `${name}: the restored file carries the scrambled file's metadata`);
      const m = info.meta;
      const tags = new Set((m.exif?.tags ?? []).map((t) => t.name));
      const xmp = new Set((m.xmp?.properties ?? []).map((p) => p.name));
      const other = (m.other ?? []).map((o) => o.type);
      const jxlRoute = format === 'jxlJpeg';
      // Third-party readers still take the file.
      if (inspect(scrambled).format !== 'jxl') {
        const s = await sharp(Buffer.from(scrambled)).metadata();
        assert.equal(s.width, 64, name);
        await sharp(Buffer.from(scrambled)).raw().toBuffer();
        if (inspect(scrambled).format === 'png') assert.equal(PNG.sync.read(Buffer.from(scrambled)).width, 64);
        const x = await exifOf(scrambled);
        if (tags.has('Artist')) assert.equal(x.ifd0.Artist, name === 'keep' ? 'Jane Doe' : 'Vivi', name);
        if (!tags.size) assert.equal(x?.ifd0?.Make, undefined, name);
      } else {
        const d = await (await loadJxlCodec()).decode(scrambled);
        assert.deepEqual([d.width, d.height].sort(), [48, 64], name); // libjxl moves EXIF orientation 6 into the codestream
      }
      if (name === 'keep') {
        assert.ok(tags.has('GPSLatitude') && tags.has('Artist') && tags.has('MakerNote'), name);
        if (!format.startsWith('jxl')) assert.ok(xmp.has('dc:creator'), name);
      } else if (name === 'strip-all' || name === 'web') {
        // Only what display needs: orientation (not on the pixel route, where the codestream
        // has it; the JPEG route keeps it for the JPEG inside).
        assert.deepEqual([...tags], format === 'jxl' ? [] : ['Orientation'], name);
        assert.equal(m.xmp, null, name);
        assert.deepEqual(m.text, [], name);
        assert.equal(m.iptc, null, name);
        assert.deepEqual(other.filter((t) => t !== 'jbrd'), [], name);
        if (format === 'png') assert.equal(m.icc?.description, 'sP3C', `${name}: a non-sRGB profile is needed to show the colours`);
        if (format === 'png') assert.deepEqual(m.colour.map((c) => c.type), ['gAMA'], `${name}: colour chunks kept`);
      } else if (name === 'privacy') {
        for (const gone of ['GPSLatitude', 'Artist', 'BodySerialNumber', 'DateTimeOriginal', 'DateTime', 'MakerNote', 'CameraOwnerName', 'HostComputer']) assert.ok(!tags.has(gone), `${name}: ${gone}`);
        for (const kept of ['Make', 'Model', 'LensModel', 'FNumber', 'Copyright', 'Orientation']) assert.ok(tags.has(kept), `${name}: keeps ${kept}`);
        if (m.xmp) {
          for (const gone of ['dc:creator', 'exif:GPSLatitude', 'photoshop:City', 'xmp:CreateDate', 'xmpMM:DocumentID']) assert.ok(!xmp.has(gone), `${name}: ${gone}`);
          assert.ok(xmp.has('xmp:CreatorTool') && xmp.has('dc:title'), `${name}: rest of XMP kept`);
        }
        if (format === 'jpeg') {
          assert.deepEqual(m.iptc, [{ name: 'CopyrightNotice', value: 'Jane 2024' }, { name: 'Keywords', value: 'sunset' }]);
          assert.ok(!other.includes('APP11'), 'C2PA removed');
          assert.deepEqual(m.text.map((t) => t.text), ['shot on a phone']);
        }
        if (format === 'png') {
          assert.ok(!other.includes('tIME') && !other.includes('caBX') && other.includes('vpAg'), other.join());
          assert.deepEqual(m.text.map((t) => t.keyword), ['Comment', 'Title']);
        }
        if (format === 'jxl') assert.ok(!other.includes('jumb'));
      } else if (name === 'web + set') {
        assert.deepEqual([...tags].sort(), format === 'jxl' ? ['Artist', 'Copyright'] : ['Artist', 'Copyright', 'Orientation']);
        assert.equal(m.xmp, null, 'no XMP packet is made for the convenience fields');
      } else if (name === 'custom') {
        assert.ok(!tags.has('Make') && tags.has('Model') && tags.has('Software'), name);
        assert.equal(m.exif.tags.find((t) => t.name === 'Copyright').value, 'Vivi');
        assert.equal(m.exif.tags.find((t) => t.name === 'DateTime').value, '2025:01:01 00:00:00');
        assert.ok(xmp.has('xmpRights:Marked') && !xmp.has('dc:title'), [...xmp].join());
        assert.deepEqual(m.xmp.properties.find((p) => p.name === 'dc:rights').value, ['Vivi']);
        assert.equal(m.xmp.properties.find((p) => p.name === 'xmp:CreatorTool').value, 'pixmix');
        assert.deepEqual(m.text, []);
        if (format === 'jpeg') {
          assert.equal(m.icc.description, 'sRGB');
          assert.deepEqual(m.iptc, [{ name: 'CopyrightNotice', value: 'Vivi' }]);
          assert.equal((await xmpOf(scrambled)).xmpRights?.Marked, true);
          assert.equal((await exifOf(scrambled)).icc.ProfileDescription, 'sRGB');
        }
        if (format === 'png') {
          assert.equal(m.icc, null);
          assert.deepEqual(m.colour.map((c) => c.type), ['sRGB', 'gAMA'], 'sRGB replaces the profile and colour chunks');
          assert.ok(!other.includes('vpAg'));
          assert.match(report.notes.join(), /colours display differently/);
        }
        if (format === 'jxl') assert.equal(m.icc.srgb, true, 'tagged sRGB in the codestream');
        if (jxlRoute) assert.equal(readMetadata(await (await loadJxlCodec()).reconstructJpeg(scrambled)).icc.description, 'sRGB', 'the JPEG inside has the sRGB profile');
      }
    }
  });
}

test('without a policy (or with "keep") files come out exactly as before', async () => {
  const f = await build();
  for (const format of ['jpeg', 'png']) {
    assert.deepEqual(encode(f[format], { key: KEY, salt: SALT, metadata: 'keep' }), encode(f[format], { key: KEY, salt: SALT }));
    assert.deepEqual(convert(f[format], { metadata: { preset: 'keep' } }).bytes, convert(f[format]).bytes);
    let report = null;
    encode(f[format], { key: KEY, salt: SALT, onConvert: (r) => { report = r; } });
    assert.equal(report.metadata, undefined);
  }
  assert.deepEqual(await encodeAsync(f.jxl, { key: KEY, salt: SALT, effort: 1, metadata: 'keep' }), await encodeAsync(f.jxl, { key: KEY, salt: SALT, effort: 1 }));
});

test('pixmix markers and watermarks survive every policy, applied on scrambled files too', async () => {
  const f = await build();
  const wm = compileWatermark({ id: 'meta-test', text: 'Vi', font: 'PixelifySans', size: { px: 9 }, fit: { maxWidth: 1, maxHeight: 1, minSize: 1 } },
    { font: (n) => readFileSync(new URL(`../watermarks/fonts/${n}.ttf`, import.meta.url)) });
  for (const format of ['jpeg', 'png', 'jxl', 'jxlJpeg']) {
    const input = f[format];
    const plain = await encodeAsync(input, { key: KEY, salt: SALT, mode: format === 'jxl' ? 'pixel' : undefined, effort: 1 });
    const reference = await essence(await decodeAsync(plain, { key: KEY }));
    for (const policy of Object.values(POLICIES)) {
      const scrambled = await encodeAsync(input, { key: KEY, salt: SALT, mode: format === 'jxl' ? 'pixel' : undefined, effort: 1, metadata: policy, watermark: wm, visibleWatermark: format === 'jxl' && policy !== 'custom' ? undefined : wm });
      // Once more, directly on the scrambled file.
      const again = (await applyMetadataAsync(scrambled, policy)).bytes;
      for (const s of [scrambled, again]) {
        const info = inspect(s);
        assert.equal(info.watermark?.id, 'meta-test', `${format} ${JSON.stringify(policy)}`);
        assert.deepEqual(await essence(await decodeAsync(s, { key: KEY })), reference, `${format} ${JSON.stringify(policy)}`);
        const drawn = await decodeAsync(s, { key: KEY, watermark: 'embedded', metadata: policy });
        assert.equal(inspect(drawn).scrambled, false);
      }
      const rekeyed = await rekeyAsync(again, { from: KEY, to: 'other', metadata: policy, effort: 1 });
      assert.deepEqual(await essence(await decodeAsync(rekeyed, { key: 'other' })), reference, `${format} rekey`);
      assert.equal(inspect(rekeyed).watermark?.id, 'meta-test');
    }
  }
});

test('set and remove, read back by exifr: EXIF tags, XMP properties, whole packets, comments, groups', async () => {
  const f = await build();
  const policy = {
    remove: ['exif:GPS/*', 'exif:*Serial*', 'exif:0x927c', 'xmp:exif:GPS*', 'xmp:photoshop:*', 'text:Comment'],
    set: { exif: { ImageDescription: 'A sunset', Rating: 5, XResolution: 300, Artist: null }, xmp: { 'dc:subject': ['sun', 'sea'], 'dc:creator': null } },
  };
  for (const format of ['jpeg', 'png']) {
    const { bytes, metadata: report } = convert(f[format], { metadata: policy });
    const x = await exifOf(bytes);
    assert.equal(x.gps, undefined);
    assert.equal(x.exif.BodySerialNumber ?? x.exif.SerialNumber, undefined);
    assert.equal(x.exif.MakerNote, undefined);
    assert.equal(x.ifd0.ImageDescription, 'A sunset');
    assert.equal(x.ifd0.Rating, 5);
    assert.equal(x.ifd0.XResolution, 300);
    assert.equal(x.ifd0.Artist, undefined);
    assert.equal(x.ifd0.Make, 'Phonemaker');
    const xmp = await xmpOf(bytes);
    assert.deepEqual(xmp.dc.subject, ['sun', 'sea']);
    assert.equal(xmp.dc.creator, undefined);
    assert.equal(xmp.dc.title?.value ?? xmp.dc.title, 'Sunset');
    assert.equal(xmp.photoshop, undefined);
    assert.equal(xmp.exif?.GPSLatitude, undefined);
    assert.equal(xmp.xmp.CreatorTool, 'Editor');
    assert.equal(readMetadata(bytes).text.some((t) => t.keyword === 'Comment'), false);
    assert.ok(report.removed.some((r) => /MakerNote/.test(r)) && report.set.includes('EXIF ImageDescription') && report.set.includes('XMP dc:subject'), JSON.stringify(report));
  }
  // A whole packet, replaced; comments set.
  const packet = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:format>image/jpeg</dc:format></rdf:Description></rdf:RDF></x:xmpmeta>';
  const out = convert(f.jpeg, { metadata: { set: { xmpPacket: packet, xmp: { 'dc:rights': 'Vivi' }, comment: ['one', 'two ✓'] } } }).bytes;
  const x = await xmpOf(out);
  assert.equal(x.dc.format, 'image/jpeg');
  assert.equal(x.dc.creator, undefined);
  assert.equal(x.dc.rights?.value ?? x.dc.rights, 'Vivi');
  assert.deepEqual(readMetadata(out).text.map((t) => t.text), ['one', 'two ✓']);
  // PNG keyword text.
  const png = convert(f.png, { metadata: { set: { text: { Source: 'pixmix lab', Title: 'Soleil ✓' }, comment: 'hello' } } }).bytes;
  const text = Object.fromEntries(readMetadata(png).text.map((t) => [t.keyword, t]));
  assert.equal(text.Source.text, 'pixmix lab');
  assert.equal(text.Title.text, 'Soleil ✓');
  assert.equal(text.Title.type, 'iTXt', 'non-Latin-1 text goes in iTXt');
  assert.equal(text.Comment.text, 'hello');
  assert.ok((await sharp(Buffer.from(png)).metadata()).comments.some((c) => c.keyword === 'Source' && c.text === 'pixmix lab'));
});

test('strip-all keeps what display needs: orientation in PNG and JPEG, ICC, PNG colour chunks; JPEG XL EXIF goes', async () => {
  const f = await build();
  for (const format of ['jpeg', 'png']) {
    const out = convert(f[format], { metadata: 'strip-all' }).bytes;
    const s = await sharp(Buffer.from(out)).metadata();
    assert.equal(s.orientation, 6, format);
    assert.ok(s.icc, format);
    assert.equal(readMetadata(out).exif.tags.length, 1);
    const reset = convert(f[format], { metadata: { preset: 'strip-all', strip: ['orientation'] } }).bytes;
    assert.equal((await sharp(Buffer.from(reset)).metadata()).orientation, undefined, 'stripping the orientation changes how it displays');
    const turned = convert(f[format], { metadata: { preset: 'strip-all', set: { orientation: 3 } } }).bytes;
    assert.equal((await sharp(Buffer.from(turned)).metadata()).orientation, 3);
  }
  const { bytes, metadata } = await convertAsync(f.jxl, { metadata: { preset: 'strip-all', strip: ['icc'] } });
  assert.equal(readMetadata(bytes).exif, null);
  assert.match(metadata.notes.join(), /codestream and cannot change without re-encoding/);
  // Encoding re-encodes the pixels, so there the profile can go.
  const scrambled = await encodeAsync(f.jxl, { key: KEY, effort: 1, metadata: { strip: ['icc'] } });
  assert.equal(inspect(scrambled).srgb, true);
});

test('the web preset drops a plain sRGB profile and keeps others', async () => {
  const srgb = new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#336699' } }).withIccProfile('srgb').jpeg().toBuffer());
  const p3 = new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#336699' } }).withIccProfile('p3').jpeg().toBuffer());
  const a = convert(srgb, { metadata: 'web' });
  assert.equal(readMetadata(a.bytes).icc, null);
  assert.match(a.metadata.removed.join(), /plain sRGB/);
  assert.equal(readMetadata(convert(p3, { metadata: 'web' }).bytes).icc.description, 'sP3C');
  assert.equal(readMetadata(convert(srgb, { metadata: 'strip-all' }).bytes).icc.srgb, true, 'strip-all keeps any profile');
});

test('JPEG XL made from a JPEG: policies go through the JPEG, so it can still be rebuilt', async () => {
  const f = await build();
  const codec = await loadJxlCodec();
  const { bytes, report: metadata } = await applyMetadataAsync(f.jxlJpeg, { preset: 'privacy', set: { comment: 'hi' }, strip: ['icc'] });
  assert.ok(readJxl(bytes).boxes.some((b) => b.type === 'jbrd'));
  const jpeg = await codec.reconstructJpeg(bytes);
  const m = readMetadata(jpeg);
  assert.equal(m.exif.tags.some((t) => t.name === 'GPSLatitude'), false);
  assert.deepEqual(m.text.map((t) => t.text), ['hi']);
  assert.equal(m.icc, null);
  assert.ok(metadata.removed.length);
  // Synchronously, only the boxes change and the reconstruction data goes.
  const sync = applyMetadata(f.jxlJpeg, 'strip-all');
  assert.ok(!readJxl(sync.bytes).boxes.some((b) => b.type === 'jbrd'));
  assert.match(sync.report.removed.join(), /JPEG reconstruction data/);
  assert.equal((await codec.decode(sync.bytes)).height, 64);
});

test('unreadable metadata is removed rather than kept when a policy needs it; hostile blocks never throw anything but PixmixErrors', async () => {
  const f = await build();
  const { segments } = readSegments(f.jpeg);
  const broken = writeSegments(segments.map((s) => {
    if (s.marker === 0xe1 && s.data[0] === 0x45) return { ...s, data: new Uint8Array([...ascii('Exif\0\0'), 0x49, 0x49, 42, 0, 0xff, 0xff, 0, 0]) };
    if (s.marker === 0xe1) return { ...s, data: new Uint8Array([...ascii('http://ns.adobe.com/xap/1.0/\0'), ...ascii('<x:xmpmeta><unclosed>')]) };
    if (s.marker === 0xed) return { ...s, data: s.data.subarray(0, 20) };
    return s;
  }));
  const { bytes, metadata } = convert(broken, { metadata: 'privacy' });
  const m = readMetadata(bytes);
  assert.equal(m.exif, null);
  assert.equal(m.xmp, null);
  assert.ok(!m.other.some((o) => o.type === 'APP13'));
  assert.match(metadata.removed.join(), /EXIF \(unreadable/);
  assert.match(metadata.removed.join(), /XMP \(unreadable/);
  assert.equal(convert(broken, { metadata: 'keep' }).bytes.length, convert(broken).bytes.length, 'kept as it is when nothing asks to change it');
  // Byte flips all over the metadata segments.
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 20;
  for (let i = 0; i < 150; i++) {
    const b = f.jpeg.slice();
    for (let k = 0; k < 8; k++) b[20 + (rnd() % 1500)] = rnd() & 255;
    for (const policy of Object.values(POLICIES)) {
      try {
        const out = applyMetadata(b, policy).bytes;
        readMetadata(out);
      } catch (err) {
        assert.ok(err instanceof PixmixError, `${err?.stack}`);
      }
    }
  }
});

test('policies are validated strictly, with messages that name the problem', () => {
  const bad = [
    'nope', 5, { preset: 'nope' }, { keep: ['exif'], strip: ['exif'] }, { strip: ['pixels'] }, { remove: ['everything'] }, { remove: ['exif:NoIFD/Make'] },
    { set: { exif: { Orientation: 12 } } }, { set: { exif: { MakerNote: 'x' } } }, { set: { xmp: { 'foo:bar': 'x' } } }, { set: { text: { 'bad  key': 'x' } } },
    { set: { text: { 'XML:com.adobe.xmp': 'x' } } }, { set: { icc: 'p3' } }, { set: { artist: 'x'.repeat(3000) } }, { set: { xmpPacket: '<a>' } }, { extra: 1 },
    { set: { comment: Array(20).fill('x') } }, { set: { unknown: 1 } },
  ];
  for (const p of bad) assert.throws(() => normalizePolicy(p), (err) => err instanceof PixmixError && err.code === 'BAD_METADATA' && /^Metadata policy: /.test(err.message), JSON.stringify(p));
  assert.throws(() => encode(new Uint8Array(8), { key: 'k', metadata: 'nope' }), (err) => err.code === 'BAD_METADATA' || err.code === 'UNSUPPORTED');
  for (const name of PRESET_NAMES) assert.equal(normalizePolicy(name).preset, name);
  assert.equal(normalizePolicy('keep').noop, true);
  assert.equal(normalizePolicy({ preset: 'web', set: { artist: 'Vivi' } }).noop, false);
});

test('profiles: canonical files, a store with strict ids, and the committed defaults', async () => {
  const p = normalizeProfile({ set: { exif: { Software: 'b', Artist: 'a' }, copyright: 'Vivi' }, remove: ['gps', 'gps'], preset: 'privacy', name: 'N', id: 'my-profile' });
  assert.deepEqual(Object.keys(p), ['id', 'name', 'preset', 'remove', 'set']);
  assert.deepEqual(Object.keys(p.set), ['copyright', 'exif']);
  assert.deepEqual(Object.keys(p.set.exif), ['Artist', 'Software']);
  assert.deepEqual(p.remove, ['gps']);
  assert.equal(formatProfile(p), `${JSON.stringify(p, null, 2)}\n`);
  for (const id of ['web', 'Bad', '../x', 'a/b', '', 'x'.repeat(60)]) assert.throws(() => normalizeProfile({ id }), PixmixError, id);

  const dir = mkdtempSync(join(tmpdir(), 'pixmix-profiles-'));
  try {
    const store = metadataProfileStore(dir);
    await store.save({ id: 'site', preset: 'web', set: { artist: 'Vivi' } });
    assert.deepEqual((await store.list()).map((x) => x.id), ['site']);
    assert.equal(readFileSync(join(dir, 'site.json'), 'utf8'), formatProfile({ id: 'site', preset: 'web', set: { artist: 'Vivi' } }));
    writeFileSync(join(dir, 'broken.json'), '{nope');
    assert.deepEqual((await store.list()).map((x) => x.id), ['site'], 'invalid files are skipped');
    await assert.rejects(store.get('broken'), PixmixError);
    await assert.rejects(store.get('../site'), PixmixError);
    assert.equal((await loadMetadataPolicy('site', { dir })).set.artist, 'Vivi');
    assert.equal(await loadMetadataPolicy('privacy', { dir }), 'privacy');
    writeFileSync(join(dir, 'p.json'), JSON.stringify({ preset: 'strip-all' }));
    assert.deepEqual(await loadMetadataPolicy(join(dir, 'p.json')), { preset: 'strip-all' });
    await store.remove('site');
    await assert.rejects(store.remove('site'), (err) => err.code === 'NOT_FOUND');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The repository's profiles are valid and in canonical form.
  const repo = new URL('../metadata-profiles/', import.meta.url).pathname;
  const files = readdirSync(repo).filter((n) => n.endsWith('.json'));
  assert.ok(files.includes('vivi-web.json'));
  for (const n of files) assert.equal(readFileSync(join(repo, n), 'utf8'), formatProfile(JSON.parse(readFileSync(join(repo, n), 'utf8'))), n);
  const web = await metadataProfileStore(repo).get('vivi-web');
  const out = convert((await build()).jpeg, { metadata: web });
  assert.deepEqual(out.metadata.set, ['EXIF Artist', 'EXIF Copyright']);
  assert.equal(out.metadata.policy, 'vivi-web');
});

test('decode and rekey take a policy too; sync decode needs the tools loaded (they are, through pixmix)', async () => {
  const f = await build();
  const scrambled = encode(f.jpeg, { key: KEY });
  let report;
  const restored = decode(scrambled, { key: KEY, metadata: 'strip-all', onMetadata: (r) => { report = r; } });
  assert.match(report.removed.join(), /EXIF/);
  assert.deepEqual(readMetadata(restored).exif.tags.map((t) => t.name), ['Orientation']);
  const rekeyed = rekey(scrambled, { from: KEY, to: 'k2', metadata: { preset: 'web', set: { artist: 'Vivi' } } });
  assert.deepEqual(readMetadata(rekeyed).exif.tags.map((t) => [t.name, t.value]), [['Orientation', 6], ['Artist', 'Vivi']]);
  assert.deepEqual(await essence(decode(rekeyed, { key: 'k2' })), await essence(decode(scrambled, { key: KEY })));
  const kept = rekey(scrambled, { from: KEY, to: 'k2' });
  assert.deepEqual(readMetadata(kept).exif.tags, readMetadata(scrambled).exif.tags, 'rekey keeps metadata by default');
});
