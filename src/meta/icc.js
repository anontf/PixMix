// ICC profiles: what inspect shows (description, version, class, colour space), whether a
// profile is plain sRGB (so the "web" preset can drop it: viewers assume sRGB anyway), and a
// compact sRGB profile for "set icc: srgb" on JPEG (PNG uses its sRGB chunk, JPEG XL its
// colour encoding).

const latin1 = new TextDecoder('latin1');
const sig = (b, o) => latin1.decode(b.subarray(o, o + 4));

/** Tag table: signature -> [offset, size], only entries that lie inside the profile. */
function tags(icc) {
  const out = new Map();
  if (icc.length < 132) return out;
  const dv = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const n = Math.min(dv.getUint32(128), Math.floor((icc.length - 132) / 12));
  for (let i = 0; i < n; i++) {
    const e = 132 + 12 * i;
    const off = dv.getUint32(e + 4), size = dv.getUint32(e + 8);
    if (off + size <= icc.length && !out.has(sig(icc, e))) out.set(sig(icc, e), [off, size]);
  }
  return out;
}

/** Text of a 'desc' (v2), 'mluc' (v4) or 'text' tag, or null. */
function tagText(icc, entry) {
  if (!entry) return null;
  const [off, size] = entry;
  const d = icc.subarray(off, off + size);
  if (d.length < 12) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const type = sig(d, 0);
  const clean = (s) => s.replace(/\0[\s\S]*$/, '').trim().slice(0, 200) || null;
  if (type === 'desc') {
    const n = dv.getUint32(8);
    return clean(latin1.decode(d.subarray(12, Math.min(d.length, 12 + n))));
  }
  if (type === 'text') return clean(latin1.decode(d.subarray(8)));
  if (type === 'mluc' && d.length >= 28) {
    const len = dv.getUint32(20), at = dv.getUint32(24);
    if (at + len > d.length) return null;
    let s = '';
    for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(dv.getUint16(at + i));
    return clean(s);
  }
  return null;
}

/**
 * @returns {{bytes: number, description: string|null, copyright: string|null, version: string,
 *   class: string, colourSpace: string, pcs: string, srgb: boolean}|null} null if it is not a profile
 */
export function describeIcc(icc) {
  if (!icc || icc.length < 128 || sig(icc, 36) !== 'acsp') return null;
  const t = tags(icc);
  return {
    bytes: icc.length,
    description: tagText(icc, t.get('desc')),
    copyright: tagText(icc, t.get('cprt')),
    version: `${icc[8]}.${icc[9] >> 4}`,
    class: sig(icc, 12).trim(),
    colourSpace: sig(icc, 16).trim(),
    pcs: sig(icc, 20).trim(),
    srgb: isSrgbIcc(icc),
  };
}

// sRGB primaries adapted to D50 (Bradford), as ICC profiles store them.
const SRGB_XYZ = { rXYZ: [0.4361, 0.2225, 0.0139], gXYZ: [0.3851, 0.7169, 0.0971], bXYZ: [0.1431, 0.0606, 0.7141] };
const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * Whether a profile describes plain sRGB: an RGB matrix/TRC profile with the sRGB
 * colourants and tone curves, and nothing (such as a lookup table) that a colour-managed
 * viewer would prefer over them. Deliberately strict: a false "no" only costs bytes.
 */
export function isSrgbIcc(icc) {
  if (!icc || icc.length < 132 || sig(icc, 36) !== 'acsp' || sig(icc, 16) !== 'RGB ' || sig(icc, 20) !== 'XYZ ') return false;
  const t = tags(icc);
  if (['A2B0', 'A2B1', 'A2B2', 'B2A0', 'D2B0'].some((s) => t.has(s))) return false;
  const dv = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const s15 = (o) => dv.getInt32(o) / 65536;
  for (const [name, want] of Object.entries(SRGB_XYZ)) {
    const e = t.get(name);
    if (!e || e[1] < 20 || sig(icc, e[0]) !== 'XYZ ') return false;
    for (let k = 0; k < 3; k++) if (Math.abs(s15(e[0] + 8 + 4 * k) - want[k]) > 0.0015) return false;
  }
  for (const name of ['rTRC', 'gTRC', 'bTRC']) {
    const curve = trc(icc, dv, t.get(name));
    if (!curve) return false;
    for (const x of [0.02, 0.1, 0.25, 0.5, 0.75, 0.95]) if (Math.abs(curve(x) - srgbDecode(x)) > 0.004) return false;
  }
  return true;
}

/** A tone curve ('curv' table or gamma, or 'para') as a function, or null. */
function trc(icc, dv, entry) {
  if (!entry || entry[1] < 12) return null;
  const [off, size] = entry;
  const type = sig(icc, off);
  if (type === 'curv') {
    const n = dv.getUint32(off + 8);
    if (12 + 2 * n > size) return null;
    if (n === 0) return (x) => x;
    if (n === 1) { const g = dv.getUint16(off + 12) / 256; return (x) => x ** g; }
    return (x) => {
      const p = x * (n - 1), i = Math.min(n - 2, Math.floor(p)), f = p - i;
      return (dv.getUint16(off + 12 + 2 * i) * (1 - f) + dv.getUint16(off + 14 + 2 * i) * f) / 65535;
    };
  }
  if (type === 'para') {
    const fn = dv.getUint16(off + 8);
    const count = [1, 3, 4, 5, 7][fn];
    if (!count || 12 + 4 * count > size) return null;
    const p = Array.from({ length: count }, (_, i) => dv.getInt32(off + 12 + 4 * i) / 65536);
    const [g, a = 1, b = 0, c = 0, d = 0, e = 0, f = 0] = p;
    if (fn === 0) return (x) => x ** g;
    if (fn === 1) return (x) => (x >= -b / a ? (a * x + b) ** g : 0);
    if (fn === 2) return (x) => (x >= -b / a ? (a * x + b) ** g + c : c);
    if (fn === 3) return (x) => (x >= d ? (a * x + b) ** g : c * x);
    return (x) => (x >= d ? (a * x + b) ** g + e : c * x + f);
  }
  return null;
}

let srgb = null;

/**
 * A compact ICC v2 display profile for sRGB (IEC 61966-2.1): D65 white, the Bradford-adapted
 * colourants, and a 256-entry tone curve shared by the three channels. About 800 bytes.
 * @returns {Uint8Array}
 */
export function srgbProfile() {
  if (srgb) return srgb.slice();
  const enc = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  const xyz = (x, y, z) => {
    const d = new Uint8Array(20);
    const dv = new DataView(d.buffer);
    d.set(enc('XYZ '));
    [x, y, z].forEach((v, i) => dv.setInt32(8 + 4 * i, Math.round(v * 65536)));
    return d;
  };
  const desc = (text) => {
    const d = new Uint8Array(12 + text.length + 1 + 8 + 3 + 67);
    const dv = new DataView(d.buffer);
    d.set(enc('desc'));
    dv.setUint32(8, text.length + 1);
    d.set(enc(text), 12);
    return d; // no Unicode or ScriptCode strings (counts left at 0)
  };
  const textTag = (text) => { const d = new Uint8Array(8 + text.length + 1); d.set(enc('text')); d.set(enc(text), 8); return d; };
  const curv = new Uint8Array(12 + 512);
  const cv = new DataView(curv.buffer);
  curv.set(enc('curv'));
  cv.setUint32(8, 256);
  for (let i = 0; i < 256; i++) cv.setUint16(12 + 2 * i, Math.round(srgbDecode(i / 255) * 65535));
  const entries = [
    ['desc', desc('sRGB')], ['cprt', textTag('No copyright, use freely')], ['wtpt', xyz(0.9505, 1, 1.089)],
    ['rXYZ', xyz(0.436074, 0.222504, 0.013932)], ['gXYZ', xyz(0.385065, 0.716879, 0.097105)],
    ['bXYZ', xyz(0.143080, 0.060617, 0.714173)], ['rTRC', curv], ['gTRC', curv], ['bTRC', curv],
  ];
  const tableEnd = 132 + 12 * entries.length;
  const unique = [...new Set(entries.map(([, d]) => d))];
  const at = new Map();
  let pos = tableEnd;
  for (const d of unique) { at.set(d, pos); pos += d.length + ((4 - (d.length % 4)) % 4); }
  const out = new Uint8Array(pos);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, pos);
  dv.setUint32(8, 0x02100000); // version 2.1
  out.set(enc('mntrRGB XYZ '), 12);
  [2024, 1, 1, 0, 0, 0].forEach((v, i) => dv.setUint16(24 + 2 * i, v));
  out.set(enc('acsp'), 36);
  [0.9642, 1, 0.8249].forEach((v, i) => dv.setInt32(68 + 4 * i, Math.round(v * 65536))); // PCS illuminant, D50
  dv.setUint32(128, entries.length);
  entries.forEach(([s, d], i) => {
    out.set(enc(s), 132 + 12 * i);
    dv.setUint32(136 + 12 * i, at.get(d));
    dv.setUint32(140 + 12 * i, d.length);
  });
  for (const d of unique) out.set(d, at.get(d));
  srgb = out;
  return out.slice();
}
