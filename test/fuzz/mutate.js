// Deterministic mutations of valid files: generic byte-level ones, and structure-aware ones
// that understand PNG chunks, JPEG segments, JPEG XL boxes, GIF blocks and RIFF chunks well
// enough to aim at lengths, sizes and header fields. PNG CRCs are usually fixed up
// afterwards, so mutants get past the checksum into the decoders.

import { crc32 } from 'node:zlib';

/** splitmix32: small, fast, and the same everywhere. */
export function rng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  const r = {
    u32: next,
    below: (n) => (n <= 1 ? 0 : next() % n),
    chance: (p) => next() / 2 ** 32 < p,
    pick: (arr) => arr[r.below(arr.length)],
    /** Index by weights. */
    weighted: (weights) => {
      let t = next() / 2 ** 32 * weights.reduce((a, b) => a + b, 0);
      for (let i = 0; i < weights.length; i++) if ((t -= weights[i]) < 0) return i;
      return weights.length - 1;
    },
  };
  return r;
}

/** Seed of case `index` in a run seeded with `seed`. */
export const caseSeed = (seed, index) => (Math.imul(seed ^ 0x5bd1e995, 0x27d4eb2d) + Math.imul(index + 1, 0x165667b1)) >>> 0;

const INTERESTING8 = [0, 1, 2, 3, 4, 7, 8, 15, 16, 0x7f, 0x80, 0xfe, 0xff];
const INTERESTING32 = [0, 1, 2, 7, 8, 255, 256, 0x7fff, 0x8000, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];

const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const setBe32 = (b, o, v) => { b[o] = v >>> 24; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
const setBe16 = (b, o, v) => { b[o] = (v >>> 8) & 255; b[o + 1] = v & 255; };
const interesting16 = (r) => r.pick([0, 1, 2, 8, 16, 255, 256, 4096, 0x7fff, 0x8000, 0xfffe, 0xffff, r.below(65536)]);
const randomBytes = (r, n) => Uint8Array.from({ length: n }, () => r.u32() & 255);

// --- watermarks -----------------------------------------------------------------------
// The payloads pixmix carries (see src/watermark/embed.js): a carried watermark (a compiled
// watermark as JSON, or an id) and a visible watermark's stash (JSON, regions, encrypted
// data). These mutate the JSON's values and the regions, so mutants get past JSON.parse.

const utf8 = new TextEncoder(), fromUtf8 = new TextDecoder();
const INTERESTING_NUMBERS = [0, -1, 1, 0.5, 1e-9, 7, 255, 256, 1000, 2000, 65535, 1e6, 1e9, -1e6, 2 ** 32, Number.MAX_SAFE_INTEGER];

function mutateJson(value, r) {
  const leaves = [];
  const walk = (v, set) => {
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) walk(v[k], (x) => { if (x === undefined) { if (Array.isArray(v)) v.splice(Number(k), 1); else delete v[k]; } else v[k] = x; });
      leaves.push({ v, set, container: true });
    } else leaves.push({ v, set });
  };
  walk(value, () => {});
  const leaf = r.pick(leaves.slice(0, -1).length ? leaves.slice(0, -1) : leaves);
  const k = r.below(6);
  if (leaf.container && Array.isArray(leaf.v) && k < 2) {
    if (leaf.v.length) leaf.v.push(...Array(r.pick([1, 3, 40])).fill(leaf.v[0])); // grow a list
  } else if (k === 0) leaf.set(r.pick(INTERESTING_NUMBERS));
  else if (k === 1) leaf.set(typeof leaf.v === 'number' ? leaf.v * r.pick([-1, 2, 10, 1000]) : r.pick(['', 'x', '#fff', 'M0 0L9 9Z', 'M'.repeat(50), null, true, [], {}]));
  else if (k === 2) leaf.set(undefined);
  else if (k === 3 && typeof leaf.v === 'string') leaf.set(leaf.v.replace(/-?\d+/g, (m) => (r.chance(0.2) ? String(r.pick(INTERESTING_NUMBERS)) : m)));
  else leaf.set(r.pick(INTERESTING_NUMBERS));
  return value;
}

/** Mutates a pmWm / pmWs payload (without its signature). */
function watermarkPayload(d, r) {
  if (d.length < 3) return null;
  if (d[0] === 1 && d[1] <= 1 && d[1] === 1) { // carried: u8 1 | u8 1 | JSON
    try {
      return cat(d.subarray(0, 2), utf8.encode(JSON.stringify(mutateJson(JSON.parse(fromUtf8.decode(d.subarray(2))), r))));
    } catch { return null; }
  }
  if (d[0] === 1 && d.length > 5) { // stash: u8 1 | u32 len | JSON | u8 n | regions | u32 len | data
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const jl = dv.getUint32(1);
    if (5 + jl + 1 > d.length) return null;
    if (r.chance(0.5)) {
      try {
        const json = utf8.encode(JSON.stringify(mutateJson(JSON.parse(fromUtf8.decode(d.subarray(5, 5 + jl))), r)));
        const head = new Uint8Array(5);
        head[0] = 1;
        setBe32(head, 1, json.length);
        return cat(head, json, d.subarray(5 + jl));
      } catch { return null; }
    }
    const out = d.slice();
    const regions = out[5 + jl];
    const at = 5 + jl + 1 + 4 * r.below(regions * 5 + 1); // a region field, or the data length
    if (at + 4 <= out.length) setBe32(out, at, r.chance(0.6) ? r.pick(INTERESTING32) : Math.max(0, be32(out, at) + r.below(9) - 4));
    else out[5 + jl] = r.pick(INTERESTING8);
    return out;
  }
  return null;
}

// --- generic -------------------------------------------------------------------------

const GENERIC = {
  bitflip(b, r) {
    const out = b.slice();
    for (let n = 1 + r.below(8); n--;) { const i = r.below(out.length); out[i] ^= 1 << r.below(8); }
    return out;
  },
  byte(b, r) {
    const out = b.slice();
    for (let n = 1 + r.below(4); n--;) out[r.below(out.length)] = r.chance(0.5) ? r.pick(INTERESTING8) : r.u32() & 255;
    return out;
  },
  word(b, r) {
    const out = b.slice();
    const i = r.below(Math.max(1, out.length - 3));
    setBe32(out, i, r.pick(INTERESTING32));
    return out;
  },
  truncate: (b, r) => b.slice(0, r.below(b.length)),
  insert(b, r) {
    const i = r.below(b.length + 1);
    return cat(b.subarray(0, i), randomBytes(r, 1 + r.below(r.chance(0.8) ? 16 : 4096)), b.subarray(i));
  },
  remove(b, r) {
    const i = r.below(b.length), n = 1 + r.below(Math.min(64, b.length - i));
    return cat(b.subarray(0, i), b.subarray(i + n));
  },
  duplicateRange(b, r) {
    const i = r.below(b.length), n = 1 + r.below(Math.min(512, b.length - i));
    const at = r.below(b.length + 1);
    return cat(b.subarray(0, at), b.subarray(i, i + n), b.subarray(at));
  },
  /** Keep a valid-looking prefix, then garbage. */
  randomTail(b, r) {
    const keep = r.below(Math.min(b.length, 64 + r.below(512)));
    return cat(b.subarray(0, keep), randomBytes(r, r.below(2048)));
  },
};

// --- PNG ---------------------------------------------------------------------------

function pngChunks(b) {
  const chunks = [];
  for (let pos = 8; pos + 12 <= b.length;) {
    const len = be32(b, pos);
    if (pos + 12 + len > b.length) break;
    chunks.push({ type: String.fromCharCode(...b.subarray(pos + 4, pos + 8)), data: b.slice(pos + 8, pos + 8 + len), crc: be32(b, pos + 8 + len) });
    pos += 12 + len;
  }
  return chunks;
}

function pngWrite(chunks, fixCrc) {
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)];
  for (const c of chunks) {
    const head = new Uint8Array(8);
    setBe32(head, 0, c.len ?? c.data.length);
    for (let i = 0; i < 4; i++) head[4 + i] = c.type.charCodeAt(i) & 255;
    const crc = new Uint8Array(4);
    setBe32(crc, 0, fixCrc || c.crc === undefined ? crc32(c.data, crc32(head.subarray(4))) >>> 0 : c.crc);
    parts.push(head, c.data, crc);
  }
  return cat(...parts);
}

const PNG = {
  field(chunks, r) {
    // Header-ish chunks: IHDR size/depth/colour, fcTL sizes/offsets, acTL counts, PLTE/tRNS.
    const targets = chunks.map((c, i) => [c, i]).filter(([c]) => ['IHDR', 'fcTL', 'acTL', 'PLTE', 'tRNS', 'pmIx', 'iCCP', 'pHYs', 'eXIf'].includes(c.type));
    if (!targets.length) return false;
    const [c] = r.pick(targets);
    c.data = c.data.slice();
    if (!c.data.length) return false;
    const k = r.below(3);
    if (c.data.length >= 4 && k === 0) setBe32(c.data, 4 * r.below(c.data.length >> 2), r.chance(0.7) ? r.pick(INTERESTING32) : r.below(4096));
    else if (c.data.length >= 4 && k === 1) { // a small change keeps a size plausible
      const o = 4 * r.below(c.data.length >> 2);
      setBe32(c.data, o, Math.max(0, be32(c.data, o) + r.below(33) - 16));
    } else c.data[r.below(c.data.length)] = r.pick(INTERESTING8);
    return true;
  },
  dataBytes(chunks, r) {
    const c = r.pick(chunks);
    if (!c.data.length) return false;
    c.data = GENERIC[r.pick(['bitflip', 'byte', 'truncate', 'insert', 'remove'])](c.data, r);
    return true;
  },
  length(chunks, r) {
    const c = r.pick(chunks);
    c.len = r.chance(0.5) ? c.data.length + r.below(9) - 4 : r.pick(INTERESTING32);
    return true;
  },
  duplicate(chunks, r) {
    const i = r.below(chunks.length);
    chunks.splice(r.below(chunks.length + 1), 0, { ...chunks[i] });
    return true;
  },
  swap(chunks, r) {
    const i = r.below(chunks.length), j = r.below(chunks.length);
    [chunks[i], chunks[j]] = [chunks[j], chunks[i]];
    return true;
  },
  drop(chunks, r) {
    chunks.splice(r.below(chunks.length), 1);
    return true;
  },
  watermark(chunks, r) {
    const c = chunks.find((x) => x.type === 'pmWm' || x.type === 'pmWs');
    const d = c && watermarkPayload(c.data, r);
    if (!d) return false;
    c.data = d;
    return true;
  },
  /** Recompress image data so the bytes inside the zlib stream change, not just the stream. */
  splitData(chunks, r) {
    const i = chunks.findIndex((c) => c.type === 'IDAT' || c.type === 'fdAT');
    if (i < 0 || chunks[i].data.length < 2) return false;
    const c = chunks[i], at = 1 + r.below(c.data.length - 1);
    chunks.splice(i, 1, { type: c.type, data: c.data.slice(0, at) }, { type: c.type === 'fdAT' ? 'fdAT' : 'IDAT', data: c.data.slice(at) });
    return true;
  },
};

// --- JPEG --------------------------------------------------------------------------

function jpegSegments(b) {
  const segs = [];
  let pos = 2;
  while (pos + 4 <= b.length && b[pos] === 0xff) {
    const marker = b[pos + 1];
    if (marker === 0xd9) break;
    const len = (b[pos + 2] << 8) | b[pos + 3];
    let end = pos + 2 + len;
    if (end > b.length) break;
    if (marker === 0xda) { // entropy data runs to the next non-RST marker
      while (end + 1 < b.length && !(b[end] === 0xff && b[end + 1] !== 0 && !(b[end + 1] >= 0xd0 && b[end + 1] <= 0xd7))) end++;
      segs.push({ marker, data: b.slice(pos + 4, pos + 2 + len), ecs: b.slice(pos + 2 + len, end) });
    } else segs.push({ marker, data: b.slice(pos + 4, pos + 2 + len) });
    pos = end;
  }
  return { segs, tail: b.slice(pos) };
}

function jpegWrite({ segs, tail }) {
  const parts = [Uint8Array.of(0xff, 0xd8)];
  for (const s of segs) {
    const head = Uint8Array.of(0xff, s.marker, 0, 0);
    setBe16(head, 2, s.len ?? s.data.length + 2);
    parts.push(head, s.data);
    if (s.ecs) parts.push(s.ecs);
  }
  parts.push(tail.length ? tail : Uint8Array.of(0xff, 0xd9));
  return cat(...parts);
}

const JPEG = {
  watermark(j, r) {
    const sig = (s) => s.marker === 0xef && s.data[6] === 0x2d && s.data[9] === 0; // "pixmix-w?\0"
    const s = j.segs.find(sig);
    if (!s) return false;
    const stash = s.data[8] === 0x73;
    const body = s.data.subarray(10 + (stash ? 2 : 0));
    const d = watermarkPayload(body, r);
    if (!d || d.length > 65000) return false;
    s.data = cat(s.data.subarray(0, 10 + (stash ? 2 : 0)), d);
    return true;
  },
  sof(j, r) {
    const s = j.segs.find((x) => x.marker >= 0xc0 && x.marker <= 0xcf && x.marker !== 0xc4 && x.marker !== 0xc8 && x.marker !== 0xcc);
    if (!s) return false;
    s.data = s.data.slice();
    const what = r.below(8);
    const size = () => (r.chance(0.5) ? interesting16(r) : 1 + r.below(200));
    const sampling = () => r.pick([0x00, 0x11, 0x12, 0x21, 0x22, 0x44, 0x41, 0x14, 0x33, 0x0f, 0xf0, 0xff, 0x10, 0x01]);
    if (what === 0) setBe16(s.data, 1, size()); // height
    else if (what === 1) setBe16(s.data, 3, size()); // width
    else if (what === 2) s.data[5] = r.pick([0, 1, 2, 3, 4, 5, 255]); // components
    else if (what === 3) s.data[7 + 3 * r.below(4)] = sampling();
    else if (what === 4) for (let i = 0; i < 4; i++) s.data[7 + 3 * i] = sampling(); // every component's
    else if (what === 5) s.data[8 + 3 * r.below(4)] = r.pick([0, 1, 3, 4, 255]); // quant table
    else if (what === 6) s.data = s.data.subarray(0, r.below(s.data.length));
    else s.marker = r.pick([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc9, 0xcd]);
    return true;
  },
  sos(j, r) {
    const scans = j.segs.filter((x) => x.marker === 0xda);
    if (!scans.length) return false;
    const s = r.pick(scans);
    s.data = s.data.slice();
    const ns = s.data[0], o = 1 + ns * 2;
    const what = r.below(5);
    if (what === 0) s.data[0] = r.pick([0, 1, 2, 3, 4, 5, 255]);
    else if (what === 1) s.data[1 + 2 * r.below(Math.max(1, ns))] = r.pick([0, 1, 2, 3, 4, 255]); // component id
    else if (what === 2) s.data[2 + 2 * r.below(Math.max(1, ns))] = r.pick([0x00, 0x11, 0x44, 0x04, 0x40, 0xff]); // tables
    else if (what === 3) s.data[o + r.below(2)] = r.pick([0, 1, 5, 6, 63, 64, 255]); // Ss / Se
    else s.data[o + 2] = r.pick([0x00, 0x01, 0x10, 0x11, 0x0d, 0xd0, 0xee, 0xff]); // Ah/Al
    return true;
  },
  dht(j, r) {
    const tables = j.segs.filter((x) => x.marker === 0xc4);
    if (!tables.length) return false;
    const s = r.pick(tables);
    s.data = s.data.slice();
    s.data[r.below(Math.min(17, s.data.length))] = r.pick([0, 1, 2, 16, 17, 0x10, 0x13, 0xff, r.u32() & 255]);
    return true;
  },
  dri(j, r) {
    const at = j.segs.findIndex((x) => x.marker === 0xda);
    const data = new Uint8Array(r.chance(0.9) ? 2 : r.below(4));
    if (data.length >= 2) setBe16(data, 0, r.pick([0, 1, 2, 3, 0xffff]));
    j.segs.splice(Math.max(0, at), 0, { marker: 0xdd, data });
    return true;
  },
  ecs(j, r) {
    const scans = j.segs.filter((x) => x.ecs?.length);
    if (!scans.length) return false;
    const s = r.pick(scans);
    const op = r.below(4);
    if (op === 3) { // an RST marker, or a stray marker, in the middle of the data
      const i = r.below(s.ecs.length + 1);
      s.ecs = cat(s.ecs.subarray(0, i), Uint8Array.of(0xff, r.pick([0xd0, 0xd3, 0xd7, 0xd9, 0xc4, 0x01])), s.ecs.subarray(i));
    } else s.ecs = GENERIC[['bitflip', 'byte', 'truncate'][op]](s.ecs, r);
    return true;
  },
  length(j, r) {
    const s = r.pick(j.segs);
    s.len = r.chance(0.5) ? s.data.length + 2 + r.below(9) - 4 : interesting16(r);
    return true;
  },
  payload(j, r) {
    const s = r.pick(j.segs);
    if (!s.data.length) return false;
    s.data = GENERIC[r.pick(['bitflip', 'byte', 'truncate', 'insert'])](s.data, r);
    return true;
  },
  duplicate(j, r) {
    const s = r.pick(j.segs);
    j.segs.splice(r.below(j.segs.length + 1), 0, { ...s });
    return true;
  },
  swap(j, r) {
    const i = r.below(j.segs.length), k = r.below(j.segs.length);
    [j.segs[i], j.segs[k]] = [j.segs[k], j.segs[i]];
    return true;
  },
  drop(j, r) {
    j.segs.splice(r.below(j.segs.length), 1);
    return true;
  },
  /** Many copies of one scan: a cheap file that makes a decoder do a lot of passes. */
  repeatScan(j, r) {
    const scans = j.segs.filter((x) => x.marker === 0xda);
    if (!scans.length) return false;
    const s = r.pick(scans);
    const at = j.segs.indexOf(s);
    j.segs.splice(at, 0, ...Array.from({ length: 1 + r.below(300) }, () => ({ ...s })));
    return true;
  },
  trailing(j, r) {
    j.tail = cat(Uint8Array.of(0xff, 0xd9), randomBytes(r, r.below(256)));
    return true;
  },
};

// --- JPEG XL container ---------------------------------------------------------------

function jxlBoxes(b) {
  const boxes = [];
  for (let pos = 12; pos + 8 <= b.length;) {
    let size = be32(b, pos);
    if (size === 0) size = b.length - pos;
    if (size < 8 || pos + size > b.length) break;
    boxes.push({ type: String.fromCharCode(...b.subarray(pos + 4, pos + 8)), data: b.slice(pos + 8, pos + size) });
    pos += size;
  }
  return boxes;
}

function jxlWrite(boxes) {
  const parts = [Uint8Array.of(0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a)];
  for (const x of boxes) {
    const head = new Uint8Array(x.big ? 16 : 8);
    if (x.big) { setBe32(head, 0, 1); setBe32(head, 8, x.bigHi ?? 0); setBe32(head, 12, x.size ?? x.data.length + 16); }
    else setBe32(head, 0, x.size ?? x.data.length + 8);
    for (let i = 0; i < 4; i++) head[4 + i] = x.type.charCodeAt(i) & 255;
    if (x.cut !== undefined) { parts.push(head.subarray(0, Math.max(x.cut, 1))); break; }
    parts.push(head, x.data);
  }
  return cat(...parts);
}

const JXL = {
  watermark(boxes, r) {
    const x = boxes.find((b) => b.type === 'pmWm' || b.type === 'pmWs');
    const d = x && watermarkPayload(x.data, r);
    if (!d) return false;
    x.data = d;
    return true;
  },
  size(boxes, r) {
    const x = r.pick(boxes);
    const k = r.below(4);
    if (k === 0) x.size = x.data.length + 8 + r.below(17) - 8;
    else if (k === 1) x.size = r.pick([0, 1, 2, 7, 8, 9, 0xffffffff]);
    else if (k === 2) { x.big = true; if (r.chance(0.5)) x.size = r.pick(INTERESTING32); if (r.chance(0.3)) x.bigHi = r.pick([1, 0x7fffffff, 0xffffffff]); }
    else x.big = true;
    return true;
  },
  codestream(boxes, r) {
    const x = boxes.find((b) => b.type === 'jxlc' || b.type === 'jxlp');
    if (!x) return false;
    // Mostly the headers (first bytes), where sizes and frame counts live.
    const d = x.data.slice();
    const at = x.type === 'jxlp' ? 4 : 0;
    const span = r.chance(0.7) ? Math.min(d.length - at, 24) : d.length - at;
    for (let n = 1 + r.below(4); n-- && span > 0;) d[at + r.below(span)] ^= 1 << r.below(8);
    x.data = r.chance(0.2) ? d.subarray(0, at + r.below(d.length - at)) : d;
    return true;
  },
  payload(boxes, r) {
    const x = r.pick(boxes);
    if (!x.data.length) return false;
    x.data = GENERIC[r.pick(['bitflip', 'byte', 'truncate', 'insert'])](x.data, r);
    return true;
  },
  /** jxlc -> jxlp parts (or the reverse order of the parts). */
  split(boxes, r) {
    const i = boxes.findIndex((b) => b.type === 'jxlc');
    if (i < 0 || boxes[i].data.length < 2) return false;
    const d = boxes[i].data, at = 1 + r.below(d.length - 1);
    const part = (idx, last, bytes) => { const h = new Uint8Array(4); setBe32(h, 0, (last ? 0x80000000 : 0) | idx); return { type: 'jxlp', data: cat(h, bytes) }; };
    const parts = [part(0, false, d.subarray(0, at)), part(1, true, d.subarray(at))];
    if (r.chance(0.3)) parts.reverse();
    boxes.splice(i, 1, ...parts);
    return true;
  },
  duplicate(boxes, r) {
    boxes.splice(r.below(boxes.length + 1), 0, { ...r.pick(boxes) });
    return true;
  },
  swap(boxes, r) {
    const i = r.below(boxes.length), k = r.below(boxes.length);
    [boxes[i], boxes[k]] = [boxes[k], boxes[i]];
    return true;
  },
  drop(boxes, r) {
    boxes.splice(r.below(boxes.length), 1);
    return true;
  },
  /** The file ends inside a box header (a 64-bit size one, sometimes). */
  cutHeader(boxes, r) {
    const i = r.below(boxes.length);
    boxes.length = i + 1;
    const x = boxes[i];
    x.big = r.chance(0.5);
    x.cut = r.below(x.big ? 16 : 8);
    return true;
  },
};

// --- GIF / RIFF ----------------------------------------------------------------------

function gifField(b, r) {
  const out = b.slice();
  const k = r.below(4);
  if (k === 0) { out[6 + r.below(4)] = r.pick([0, 1, 0xff, 0x7f]); return out; } // screen size
  if (k === 1) { out[10] = r.u32() & 255; return out; } // packed fields: palette flag and size
  // An image descriptor (0x2c): its geometry, or its LZW minimum code size.
  const starts = [];
  for (let i = 13; i < out.length - 10; i++) if (out[i] === 0x2c) starts.push(i);
  if (!starts.length) return GENERIC.byte(b, r);
  const s = r.pick(starts);
  if (k === 2) setBe16(out, s + 1 + 2 * r.below(4), interesting16(r));
  else out[s + 10 + (out[s + 9] & 0x80 ? 3 << ((out[s + 9] & 7) + 1) : 0)] = r.pick([0, 1, 2, 8, 11, 12, 13, 31, 32, 255]);
  return out;
}

function riffField(b, r) {
  const out = b.slice();
  const dv = new DataView(out.buffer);
  if (out.length < 8) return GENERIC.byte(b, r);
  const offs = [4];
  for (let pos = 12; pos + 8 <= out.length;) { offs.push(pos + 4); const n = dv.getUint32(pos + 4, true); pos += 8 + n + (n & 1); }
  dv.setUint32(r.pick(offs), r.chance(0.5) ? r.pick(INTERESTING32) : dv.getUint32(4, true) + r.below(9) - 4, true);
  return out;
}

// --- driver ------------------------------------------------------------------------

const formatOf = (b) => (b[0] === 0x89 && b[1] === 0x50 ? 'png' : b[0] === 0xff && b[1] === 0xd8 ? 'jpeg'
  : b[0] === 0 && b[4] === 0x4a && b[5] === 0x58 ? 'jxl' : b[0] === 0x47 && b[1] === 0x49 ? 'gif'
    : b[0] === 0x52 && b[1] === 0x49 ? 'riff' : 'other');

/** One structure-aware mutation, or null when the file does not have the structure. */
function structured(b, r, log) {
  const fmt = formatOf(b);
  if (fmt === 'png') {
    const chunks = pngChunks(b);
    if (!chunks.length) return null;
    const carries = chunks.some((c) => c.type === 'pmWm' || c.type === 'pmWs');
    const name = carries && r.chance(0.35) ? 'watermark' : r.pick(Object.keys(PNG));
    if (!PNG[name](chunks, r)) return null;
    const fix = r.chance(0.85);
    log.push(`png.${name}${fix ? '' : ' (bad crc)'}`);
    return pngWrite(chunks, fix);
  }
  if (fmt === 'jpeg') {
    const j = jpegSegments(b);
    if (!j.segs.length) return null;
    const carries = j.segs.some((s) => s.marker === 0xef && s.data[6] === 0x2d);
    const name = carries && r.chance(0.35) ? 'watermark' : r.pick(Object.keys(JPEG));
    if (!JPEG[name](j, r)) return null;
    log.push(`jpeg.${name}`);
    return jpegWrite(j);
  }
  if (fmt === 'jxl') {
    const boxes = jxlBoxes(b);
    if (!boxes.length) return null;
    const carries = boxes.some((b) => b.type === 'pmWm' || b.type === 'pmWs');
    const name = carries && r.chance(0.35) ? 'watermark' : r.pick(Object.keys(JXL));
    if (!JXL[name](boxes, r)) return null;
    log.push(`jxl.${name}`);
    return jxlWrite(boxes);
  }
  if (fmt === 'gif') { log.push('gif.field'); return gifField(b, r); }
  if (fmt === 'riff') { log.push('riff.size'); return riffField(b, r); }
  return null;
}

/**
 * 1-3 mutations of `bytes`; `log` collects what was done, for the report.
 * @param {Uint8Array} bytes @param {ReturnType<typeof rng>} r @param {string[]} log
 * @param {Uint8Array[]} [others] other seeds, for splicing
 */
export function mutate(bytes, r, log, others = []) {
  let b = bytes;
  for (let n = 1 + r.weighted([6, 3, 1]); n--;) {
    if (!b.length) break;
    let next = null;
    if (r.chance(0.6)) next = structured(b, r, log);
    if (!next && others.length && r.chance(0.05)) {
      const o = r.pick(others);
      next = cat(b.subarray(0, r.below(b.length)), o.subarray(r.below(o.length)));
      log.push('splice');
    }
    if (!next) {
      const name = r.pick(Object.keys(GENERIC));
      next = GENERIC[name](b, r);
      log.push(name);
    }
    b = next;
  }
  // Byte-level mutations of a PNG usually break a CRC; mostly repair them to get further in.
  if (formatOf(b) === 'png' && r.chance(0.7)) {
    const chunks = pngChunks(b);
    if (chunks.length) {
      const fixed = pngWrite(chunks, true);
      const end = 8 + chunks.reduce((n, c) => n + 12 + c.data.length, 0);
      b = cat(fixed, b.subarray(end));
    }
  }
  return b;
}
