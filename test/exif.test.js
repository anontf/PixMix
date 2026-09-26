// The metadata readers and writers on their own: EXIF (TIFF) parse/write in both byte
// orders, XMP packets, ICC profiles, IPTC. EXIF output is checked with exifr, an
// independent reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import exifr from 'exifr';
import sharp from 'sharp';
import { parseExif, writeExif, entryValue, encodeEntry, settableTag, orientationOf } from '../src/meta/tiff.js';
import { tagName } from '../src/meta/exif-tags.js';
import { XmpPacket, parseXml, serializeXml, emptyPacket } from '../src/meta/xmp.js';
import { describeIcc, isSrgbIcc, srgbProfile } from '../src/meta/icc.js';
import { readIptc, editIptc } from '../src/meta/iptc.js';
import { PixmixError } from '../src/core/params.js';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };

/**
 * A TIFF built independently of pixmix's writer: IFD0 (with Exif and GPS pointers), Exif
 * (with Interop), Interop, GPS, IFD1 with a thumbnail. Entries: [tag, type, value], value a
 * string (ASCII), number list, [n, d] pairs for rationals, or bytes. The MakerNote holds an
 * absolute offset into itself, as many vendors' do.
 */
function buildTiff(le, { ifd0 = [], exif = [], gps = [], interop = [], ifd1 = [], thumbnail = null } = {}) {
  const enc = (type, v) => {
    if (typeof v === 'string') return { count: v.length + 1, bytes: Uint8Array.from([...v].map((c) => c.charCodeAt(0)).concat(0)) };
    if (v instanceof Uint8Array) return { count: v.length, bytes: v };
    const flat = type === 5 || type === 10 ? v.flat() : v;
    const size = type === 5 || type === 10 ? 4 : TYPE_SIZE[type];
    const b = new Uint8Array(flat.length * size);
    const dv = new DataView(b.buffer);
    flat.forEach((x, i) => (size === 1 ? dv.setUint8(i, x) : size === 2 ? dv.setUint16(i * 2, x, le) : dv.setUint32(i * 4, x, le)));
    return { count: type === 5 || type === 10 ? v.length : v.length, bytes: b };
  };
  const ifds = { ifd0: [...ifd0], exif: [...exif], gps: [...gps], interop: [...interop], ifd1: [...ifd1] };
  if (interop.length) ifds.exif.push([0xa005, 4, [0]]);
  if (exif.length) ifds.ifd0.push([0x8769, 4, [0]]);
  if (gps.length) ifds.ifd0.push([0x8825, 4, [0]]);
  if (thumbnail) ifds.ifd1.push([0x0201, 4, [0]], [0x0202, 4, [thumbnail.length]]);
  const order = ['ifd0', 'exif', 'interop', 'gps', 'ifd1'].filter((k) => ifds[k].length);
  // Pass 1: offsets. Each IFD, then its values.
  let pos = 8;
  const at = {}, valueAt = {};
  for (const k of order) {
    ifds[k].sort((a, b) => a[0] - b[0]);
    at[k] = pos;
    pos += 2 + 12 * ifds[k].length + 4;
    valueAt[k] = ifds[k].map(([, type, v]) => { const e = enc(type, v); if (e.bytes.length <= 4) return null; const o = pos; pos += e.bytes.length + (e.bytes.length & 1); return o; });
  }
  const thumbAt = pos;
  if (thumbnail) pos += thumbnail.length;
  const out = new Uint8Array(pos);
  const dv = new DataView(out.buffer);
  out[0] = out[1] = le ? 0x49 : 0x4d;
  dv.setUint16(2, 42, le);
  dv.setUint32(4, 8, le);
  const pointer = { 0xa005: () => at.interop, 0x8769: () => at.exif, 0x8825: () => at.gps, 0x0201: () => thumbAt };
  for (const k of order) {
    dv.setUint16(at[k], ifds[k].length, le);
    ifds[k].forEach(([tag, type, v], i) => {
      const e = enc(type, pointer[tag] ? [pointer[tag]()] : v);
      const o = at[k] + 2 + 12 * i;
      dv.setUint16(o, tag, le); dv.setUint16(o + 2, type, le); dv.setUint32(o + 4, e.count, le);
      if (valueAt[k][i] === null) out.set(e.bytes, o + 8);
      else { dv.setUint32(o + 8, valueAt[k][i], le); out.set(e.bytes, valueAt[k][i]); }
    });
    dv.setUint32(at[k] + 2 + 12 * ifds[k].length, k === 'ifd0' && ifds.ifd1.length ? at.ifd1 : 0, le);
  }
  if (thumbnail) out.set(thumbnail, thumbAt);
  return out;
}

const THUMB = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4]);
const sample = (le) => buildTiff(le, {
  ifd0: [[0x010f, 2, 'Cam'], [0x0110, 2, 'Model 9'], [0x0112, 3, [6]], [0x013b, 2, 'Jane Doe'], [0x011a, 5, [[72, 1]]], [0xc0de, 7, Uint8Array.of(9, 8, 7, 6, 5, 4)]],
  exif: [[0x9003, 2, '2024:01:02 03:04:05'], [0xa431, 2, 'SN-123'], [0x829a, 5, [[1, 250]]], [0x9204, 10, [[-1, 3]]], [0x927c, 7, new Uint8Array(24)]],
  interop: [[0x0001, 2, 'R98']],
  gps: [[0x0001, 2, 'N'], [0x0002, 5, [[48, 1], [51, 1], [2400, 100]]]],
  ifd1: [[0x0103, 3, [6]]],
  thumbnail: THUMB,
});

/** Puts an absolute self-reference into the MakerNote: u32 offset of "abs!" at +8. */
function withSelfReferencingMakerNote(tiff) {
  const e = parseExif(tiff);
  const at = e.makerNoteOffset;
  const out = tiff.slice();
  const dv = new DataView(out.buffer);
  out.set([0x54, 0x45, 0x53, 0x54], at);
  dv.setUint32(at + 4, at + 8, e.le);
  out.set([0x61, 0x62, 0x73, 0x21], at + 8);
  return out;
}

const exifrAll = (tiff) => exifr.parse(tiff, { tiff: true, exif: true, gps: true, interop: true, ifd1: true, makerNote: true, translateValues: false, reviveValues: false, mergeOutput: false });

for (const le of [true, false]) {
  const order = le ? 'II' : 'MM';
  test(`EXIF ${order}: parsed into IFDs, written back so an independent reader agrees`, async () => {
    const tiff = sample(le);
    const e = parseExif(tiff);
    assert.equal(e.le, le);
    assert.deepEqual(Object.keys(e.ifds), ['IFD0', 'Exif', 'Interop', 'GPS', 'IFD1']);
    assert.deepEqual(e.warnings, []);
    const v = (ifd, tag) => entryValue(ifd, e.ifds[ifd].find((x) => x.tag === tag), e.le);
    assert.equal(v('IFD0', 0x013b), 'Jane Doe');
    assert.equal(v('IFD0', 0x0112), 6);
    assert.equal(v('Exif', 0x829a), 0.004);
    assert.equal(v('Exif', 0x9204), +(-1 / 3).toPrecision(8));
    assert.deepEqual(v('GPS', 0x0002), [48, 51, 24]);
    assert.equal(orientationOf(e), 6);
    assert.equal(tagName('IFD0', 0xc0de), '0xc0de');

    for (const target of [le, !le]) {
      const { tiff: out, notes } = writeExif(e, { le: target });
      assert.deepEqual(notes, []);
      assert.equal(out[0], target ? 0x49 : 0x4d);
      const back = parseExif(out);
      for (const ifd of Object.keys(e.ifds)) {
        assert.deepEqual(back.ifds[ifd].map((x) => [x.tag, entryValue(ifd, x, back.le)]), e.ifds[ifd].map((x) => [x.tag, entryValue(ifd, x, e.le)]), `${ifd} in ${target ? 'II' : 'MM'}`);
      }
      const unknown = back.ifds.IFD0.find((x) => x.tag === 0xc0de);
      assert.deepEqual([...unknown.data], [9, 8, 7, 6, 5, 4], 'unknown tags kept byte for byte');
      assert.deepEqual([...back.ifds.IFD1.find((x) => x.tag === 0x0201).blobs[0]], [...THUMB], 'thumbnail data moves with its offset');
      const x = await exifrAll(out);
      assert.equal(x.ifd0.Artist, 'Jane Doe');
      assert.equal(x.ifd0.Orientation, 6);
      assert.equal(x.exif.BodySerialNumber ?? x.exif.SerialNumber, 'SN-123');
      assert.equal(x.exif.ExposureTime, 0.004);
      assert.deepEqual(x.gps.GPSLatitude, [48, 51, 24]);
      assert.equal(x.interop.InteropIndex, 'R98');
      assert.equal(x.ifd1.Compression, 6);
    }
  });

  test(`EXIF ${order}: removing tags keeps the MakerNote where its own offsets point`, async () => {
    const tiff = withSelfReferencingMakerNote(sample(le));
    const e = parseExif(tiff);
    const was = e.makerNoteOffset;
    e.ifds.IFD0 = e.ifds.IFD0.filter((x) => x.tag !== 0x013b && x.tag !== 0x0110); // Artist, Model
    delete e.ifds.GPS;
    delete e.ifds.IFD1;
    const { tiff: out, notes } = writeExif(e);
    assert.deepEqual(notes, []);
    const back = parseExif(out);
    assert.equal(back.makerNoteOffset, was, 'pinned to its old offset');
    const ptr = new DataView(out.buffer).getUint32(was + 4, le);
    assert.equal(String.fromCharCode(...out.subarray(ptr, ptr + 4)), 'abs!', 'the vendor pointer still lands');
    assert.ok(!back.ifds.GPS && !back.ifds.IFD1);
    const x = await exifrAll(out);
    assert.equal(x.ifd0.Artist, undefined);
    assert.equal(x.gps, undefined);
    assert.equal(x.ifd0.Make, 'Cam');
    // Values that no longer fit before it go after it; it stays.
    e.ifds.IFD0.push(encodeEntry(settableTag('ImageDescription'), 'x'.repeat(400), e.le));
    const grown = writeExif(e);
    assert.deepEqual(grown.notes, []);
    assert.equal(parseExif(grown.tiff).makerNoteOffset, was);
    assert.equal((await exifrAll(grown.tiff)).ifd0.ImageDescription, 'x'.repeat(400));
    // Only an offset the layout has already passed moves it, and the writer says so.
    const moved = writeExif({ ...e, makerNoteOffset: 4 });
    assert.match(moved.notes.join(), /MakerNote moved/);
    assert.equal(parseExif(moved.tiff).ifds.Exif.find((x2) => x2.tag === 0x927c).data.length, 24);
  });
}

test('EXIF: set values get the right types, and bad ones are refused', async () => {
  const e = parseExif(sample(true));
  const put = (name, value) => {
    const info = settableTag(name);
    const list = (e.ifds[info.ifd] ??= []);
    const i = list.findIndex((x) => x.tag === info.tag);
    const entry = encodeEntry(info, value, e.le);
    if (i >= 0) list[i] = entry; else list.push(entry);
  };
  put('Artist', 'Vivi'); put('Copyright', 'Vivi ©'); put('DateTime', '2025:02:03 04:05:06'); put('Software', 'pixmix');
  put('XResolution', 300); put('FNumber', 2.8); put('ExposureBiasValue', '-2/3'); put('Orientation', 1); put('XPAuthor', 'Vivi ✓');
  put('UserComment', 'hello'); put('LensSpecification', [24, 70, 2.8, 2.8]);
  const x = await exifr.parse(writeExif(e).tiff, { tiff: true, exif: true, xmp: false, translateValues: false, reviveValues: false });
  assert.equal(x.Artist, 'Vivi');
  assert.equal(x.Copyright, 'Vivi ©');
  assert.equal(x.ModifyDate, '2025:02:03 04:05:06');
  assert.equal(x.Software, 'pixmix');
  assert.equal(x.XResolution, 300);
  assert.equal(x.FNumber, 2.8);
  assert.ok(Math.abs(x.ExposureCompensation - -2 / 3) < 1e-9);
  assert.equal(x.Orientation, 1);
  assert.deepEqual(x.LensInfo ?? x.LensSpecification, [24, 70, 2.8, 2.8]);
  const back = parseExif(writeExif(e).tiff);
  assert.equal(entryValue('IFD0', back.ifds.IFD0.find((t) => t.tag === 0x9c9d), true), 'Vivi ✓');
  assert.equal(entryValue('Exif', back.ifds.Exif.find((t) => t.tag === 0x9286), true), 'hello');
  for (const [name, value] of [['Orientation', 9], ['DateTime', 'yesterday'], ['XResolution', -1], ['Artist', 5], ['MakerNote', 'x'], ['ExifIFDPointer', 1], ['StripOffsets', 1], ['LensSpecification', [1, 2]], ['NoSuchTag', 'x']]) {
    assert.throws(() => encodeEntry(settableTag(name), value, true), (err) => err instanceof PixmixError && err.code === 'BAD_METADATA', name);
  }
});

test('EXIF: hostile input is skipped with warnings or refused with a PixmixError', () => {
  const t = sample(true);
  const dv = new DataView(t.buffer);
  // IFD1 pointing back at IFD0: a loop.
  const loop = t.slice();
  const n0 = dv.getUint16(8, true);
  new DataView(loop.buffer).setUint32(8 + 2 + 12 * n0, 8, true);
  assert.match(parseExif(loop).warnings.join(), /loops back/);
  // An entry whose value lies far outside, and one with an unknown type.
  const bad = t.slice();
  new DataView(bad.buffer).setUint32(10 + 4, 0x7fffffff, true); // first entry's count
  new DataView(bad.buffer).setUint16(10 + 12 + 2, 99, true); // second entry's type
  const e = parseExif(bad);
  assert.equal(e.warnings.length, 2);
  assert.ok(writeExif(e).tiff.length > 8);
  for (const junk of [new Uint8Array(0), Uint8Array.of(0x49, 0x49, 42, 0), Uint8Array.of(0x4d, 0x4d, 0, 43, 0, 0, 0, 8), Uint8Array.of(0x49, 0x49, 42, 0, 255, 255, 255, 255)]) {
    assert.throws(() => parseExif(junk), (err) => err instanceof PixmixError && err.code === 'BAD_EXIF');
  }
  // Random bytes after a valid header: never anything but a PixmixError.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
  for (let i = 0; i < 300; i++) {
    const b = t.slice();
    for (let k = 0; k < 6; k++) b[8 + (rnd() * 7) % (b.length - 8)] = rnd();
    try {
      const m = parseExif(b);
      writeExif(m);
      for (const [ifd, l] of Object.entries(m.ifds)) for (const en of l) entryValue(ifd, en, m.le);
    } catch (err) {
      assert.ok(err instanceof PixmixError, String(err));
    }
  }
});

test('EXIF: SubIFDs are followed and written back', () => {
  // IFD0 with SubIFDs = [one IFD holding a tag and its own strip].
  const le = true;
  const b = new Uint8Array(96);
  const dv = new DataView(b.buffer);
  b.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  dv.setUint16(8, 1, le);
  dv.setUint16(10, 0x014a, le); dv.setUint16(12, 4, le); dv.setUint32(14, 1, le); dv.setUint32(18, 26, le);
  dv.setUint32(22, 0, le);
  dv.setUint16(26, 3, le);
  dv.setUint16(28, 0x0100, le); dv.setUint16(30, 4, le); dv.setUint32(32, 1, le); dv.setUint32(36, 640, le);
  dv.setUint16(40, 0x0111, le); dv.setUint16(42, 4, le); dv.setUint32(44, 1, le); dv.setUint32(48, 80, le);
  dv.setUint16(52, 0x0117, le); dv.setUint16(54, 4, le); dv.setUint32(56, 1, le); dv.setUint32(60, 4, le);
  dv.setUint32(64, 0, le);
  b.set([1, 2, 3, 4], 80);
  const e = parseExif(b);
  assert.equal(e.subIfds.length, 1);
  const back = parseExif(writeExif(e).tiff);
  assert.equal(entryValue('SubIFD0', back.subIfds[0].find((x) => x.tag === 0x0100), true), 640);
  assert.deepEqual([...back.subIfds[0].find((x) => x.tag === 0x0111).blobs[0]], [1, 2, 3, 4]);
});

const PACKET = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="test">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:d="http://purl.org/dc/elements/1.1/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/" xmp:CreatorTool="Editor 1.0" exif:GPSLatitude="48,51.4N">
   <d:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li><rdf:li>John</rdf:li></rdf:Seq></d:creator>
   <d:rights><rdf:Alt><rdf:li xml:lang="x-default">© Jane &amp; co</rdf:li></rdf:Alt></d:rights>
   <exif:GPSLongitude>2,17.6E</exif:GPSLongitude>
   <!-- a comment -->
   <xmp:Thumbnails><rdf:Alt><rdf:li rdf:parseType="Resource"><xmpGImg:image xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/">/9j/4AAQ</xmpGImg:image></rdf:li></rdf:Alt></xmp:Thumbnails>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

test('XMP: parsed and written back unchanged; properties by namespace, whatever the prefix', async () => {
  assert.equal(serializeXml(parseXml(PACKET)), PACKET);
  const doc = new XmpPacket(PACKET);
  const props = Object.fromEntries(doc.properties().map((p) => [p.name, p.value]));
  assert.deepEqual(props['dc:creator'], ['Jane Doe', 'John']);
  assert.deepEqual(props['dc:rights'], ['© Jane & co']);
  assert.equal(props['xmp:CreatorTool'], 'Editor 1.0');
  assert.equal(props['exif:GPSLatitude'], '48,51.4N');
  assert.equal(props['exif:GPSLongitude'], '2,17.6E');
  assert.deepEqual(doc.remove((n) => n.startsWith('exif:GPS') || n === 'dc:creator' || n === 'xmp:Thumbnails').sort(), ['dc:creator', 'exif:GPSLatitude', 'exif:GPSLongitude', 'xmp:Thumbnails']);
  doc.set('dc:rights', 'Vivi');
  doc.set('dc:creator', ['Vivi']);
  doc.set('photoshop:Credit', 'Vivi Studio');
  doc.set('photoshop:Source', 'a <b> & "c"');
  const text = doc.toString();
  assert.equal(new XmpPacket(text).properties().find((p) => p.name === 'photoshop:Source').value, 'a <b> & "c"');
  assert.match(text, /xmlns:photoshop="http:\/\/ns\.adobe\.com\/photoshop\/1\.0\/"/, 'undeclared namespace declared');
  assert.match(text, /<d:creator>/, 'the file\'s own prefix is reused');
  assert.match(text, /<!-- a comment -->/);
  const x = await exifr.parse(Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(text)])), Buffer.from([0xff, 0xd9])]), { xmp: true, tiff: false });
  assert.equal(x.rights?.value ?? x.rights, 'Vivi');
  assert.equal(x.creator, 'Vivi');
  assert.equal(x.Credit, 'Vivi Studio');
  assert.equal(x.GPSLatitude, undefined);
  assert.equal(x.CreatorTool, 'Editor 1.0');
  const fresh = new XmpPacket(emptyPacket());
  fresh.set('xmp:CreatorTool', 'pixmix');
  assert.deepEqual(new XmpPacket(fresh.toString()).properties().map((p) => [p.name, p.value]), [['xmp:CreatorTool', 'pixmix']]);
});

const segment = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);

test('XMP: hostile packets are refused with a PixmixError', () => {
  const bad = [
    '<!DOCTYPE x [<!ENTITY a "aaaa">]><x:xmpmeta xmlns:x="adobe:ns:meta/">&a;</x:xmpmeta>',
    '<a>&unknown;</a>', '<a><b></a>', '<a', '<a x="1" x="2"/>', '<a x=1/>', `${'<a>'.repeat(200)}${'</a>'.repeat(200)}`,
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>', '<a>&#0;</a>', '<a>&#xd800;</a>', '<?xpacket', '<![CDATA[x',
  ];
  for (const s of bad) assert.throws(() => new XmpPacket(s), (err) => err instanceof PixmixError && err.code === 'BAD_XMP', s.slice(0, 40));
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
  for (let i = 0; i < 300; i++) {
    const chars = [...PACKET];
    for (let k = 0; k < 4; k++) chars[(rnd() * 97) % chars.length] = '<>&"/=:x '[rnd() % 9];
    try {
      const d = new XmpPacket(chars.join(''));
      d.properties(); d.remove((n) => n.startsWith('dc:')); d.set('dc:rights', 'v'); d.toString();
    } catch (err) {
      assert.ok(err instanceof PixmixError, String(err));
    }
  }
});

test('ICC: descriptions, sRGB detection, and a compact sRGB profile that colour-manages as sRGB', async () => {
  const icc = async (p) => new Uint8Array((await sharp({ create: { width: 2, height: 2, channels: 3, background: '#808080' } }).withIccProfile(p).png().toBuffer().then((b) => sharp(b).metadata())).icc);
  assert.equal(isSrgbIcc(await icc('srgb')), true);
  assert.equal(isSrgbIcc(await icc('p3')), false);
  assert.equal(describeIcc(await icc('p3')).description, 'sP3C');
  const mine = srgbProfile();
  assert.ok(mine.length < 1100);
  assert.deepEqual({ ...describeIcc(mine), bytes: 0 }, { bytes: 0, description: 'sRGB', copyright: 'No copyright, use freely', version: '2.1', class: 'mntr', colourSpace: 'RGB', pcs: 'XYZ', srgb: true });
  assert.equal(describeIcc(Uint8Array.of(1, 2, 3)), null);
  assert.equal(isSrgbIcc(new Uint8Array(200)), false);
});

test('IPTC: datasets listed, removed and replaced; the digest goes', () => {
  const ds = (rec, n, text) => Buffer.concat([Buffer.from([0x1c, rec, n, 0, text.length]), Buffer.from(text, 'latin1')]);
  const iim = Buffer.concat([ds(1, 90, '\x1b%G'), ds(2, 80, 'Jane'), ds(2, 90, 'Paris'), ds(2, 116, 'Jane 2024'), ds(2, 25, 'cat')]);
  const res = (id, data) => { const h = Buffer.alloc(12); h.write('8BIM'); h.writeUInt16BE(id, 4); h.writeUInt32BE(data.length, 8); return Buffer.concat([h, data, Buffer.alloc(data.length & 1)]); };
  const payload = new Uint8Array(Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), res(0x0404, iim), res(0x0425, Buffer.alloc(16, 1)), res(0x03ed, Buffer.alloc(16, 2))]));
  assert.deepEqual(readIptc(payload), [{ name: 'By-line', value: 'Jane' }, { name: 'City', value: 'Paris' }, { name: 'CopyrightNotice', value: 'Jane 2024' }, { name: 'Keywords', value: 'cat' }]);
  const out = editIptc(payload, (n) => n === 'City' || n === 'By-line', { CopyrightNotice: 'Vivi ✓' });
  assert.deepEqual(out.removed, ['By-line', 'City']);
  assert.deepEqual(out.replaced, ['CopyrightNotice']);
  assert.deepEqual(readIptc(out.payload), [{ name: 'CopyrightNotice', value: 'Vivi ✓' }, { name: 'Keywords', value: 'cat' }]);
  assert.ok(!Buffer.from(out.payload).includes(Buffer.alloc(16, 1)), 'digest dropped');
  assert.ok(Buffer.from(out.payload).includes(Buffer.alloc(16, 2)), 'other resources kept');
  assert.equal(editIptc(payload.subarray(0, 30), () => true), null, 'truncated: unreadable');
});
