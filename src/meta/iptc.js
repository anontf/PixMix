// IPTC-IIM inside a JPEG's Photoshop APP13 segment ("Photoshop 3.0\0", then 8BIM image
// resources; resource 0x0404 holds the IIM datasets). Enough to list datasets by name,
// remove some, and replace the text of existing ones. Other resources are kept as they are,
// except the IPTC digest (0x0425), which would no longer match once IPTC changes.

import { startsWith } from '../formats/jpeg/markers.js';

const SIG = 'Photoshop 3.0\0';
const IPTC_RESOURCE = 0x0404;
const DIGEST_RESOURCE = 0x0425;

// Record 2 (application) datasets by number.
export const DATASETS = {
  0: 'RecordVersion', 3: 'ObjectTypeReference', 4: 'ObjectAttributeReference', 5: 'ObjectName', 7: 'EditStatus',
  10: 'Urgency', 12: 'SubjectReference', 15: 'Category', 20: 'SupplementalCategories', 22: 'FixtureIdentifier',
  25: 'Keywords', 26: 'ContentLocationCode', 27: 'ContentLocationName', 30: 'ReleaseDate', 35: 'ReleaseTime',
  37: 'ExpirationDate', 38: 'ExpirationTime', 40: 'SpecialInstructions', 42: 'ActionAdvised', 45: 'ReferenceService',
  47: 'ReferenceDate', 50: 'ReferenceNumber', 55: 'DateCreated', 60: 'TimeCreated', 62: 'DigitalCreationDate',
  63: 'DigitalCreationTime', 65: 'OriginatingProgram', 70: 'ProgramVersion', 75: 'ObjectCycle', 80: 'By-line',
  85: 'By-lineTitle', 90: 'City', 92: 'Sub-location', 95: 'Province-State', 100: 'Country-PrimaryLocationCode',
  101: 'Country-PrimaryLocationName', 103: 'OriginalTransmissionReference', 105: 'Headline', 110: 'Credit',
  115: 'Source', 116: 'CopyrightNotice', 118: 'Contact', 120: 'Caption-Abstract', 121: 'LocalCaption',
  122: 'Writer-Editor', 130: 'ImageType', 131: 'ImageOrientation', 135: 'LanguageIdentifier',
};
const NUMBER_OF = new Map(Object.entries(DATASETS).map(([n, name]) => [name.toLowerCase(), Number(n)]));
export const datasetNumber = (name) => NUMBER_OF.get(String(name).toLowerCase()) ?? null;
const datasetName = (rec, ds) => (rec === 2 && DATASETS[ds]) || `${rec}:${ds}`;

const utf8 = new TextDecoder(), latin1 = new TextDecoder('latin1');

/** 8BIM resources of an APP13 payload, or null when it is not one pixmix can read. */
function resources(payload) {
  if (!startsWith(payload, SIG)) return null;
  const out = [];
  let pos = SIG.length;
  while (pos < payload.length) {
    if (pos + 12 > payload.length || !startsWith(payload.subarray(pos), '8BIM')) return null;
    const id = (payload[pos + 4] << 8) | payload[pos + 5];
    const nameLen = payload[pos + 6];
    const dataAt = pos + 6 + 1 + nameLen + ((nameLen + 1) & 1);
    if (dataAt + 4 > payload.length) return null;
    const size = ((payload[dataAt] << 24) | (payload[dataAt + 1] << 16) | (payload[dataAt + 2] << 8) | payload[dataAt + 3]) >>> 0;
    const end = dataAt + 4 + size;
    if (end > payload.length) return null;
    out.push({ id, head: payload.subarray(pos, dataAt), data: payload.subarray(dataAt + 4, end) });
    pos = end + (size & 1);
  }
  return out;
}

/** IIM datasets: {rec, ds, value} (value: raw bytes), or null when malformed. */
function datasets(iim) {
  const out = [];
  let pos = 0;
  while (pos < iim.length) {
    if (iim[pos] === 0) break; // padding
    if (iim[pos] !== 0x1c || pos + 5 > iim.length) return null;
    const rec = iim[pos + 1], ds = iim[pos + 2];
    let len = (iim[pos + 3] << 8) | iim[pos + 4];
    let at = pos + 5;
    if (len & 0x8000) { // extended length: that many bytes of length follow
      const n = len & 0x7fff;
      if (n > 4 || at + n > iim.length) return null;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + iim[at + i];
      at += n;
    }
    if (at + len > iim.length) return null;
    out.push({ rec, ds, value: iim.subarray(at, at + len) });
    pos = at + len;
  }
  return out;
}

// 1:90 CodedCharacterSet "ESC % G" means UTF-8.
const isUtf8 = (list) => list.some((d) => d.rec === 1 && d.ds === 90 && d.value.length === 3 && d.value[0] === 0x1b && d.value[1] === 0x25 && d.value[2] === 0x47);

/**
 * The IPTC datasets of an APP13 payload, for display.
 * @returns {{name: string, value: string}[]|null} null when there is no (readable) IPTC
 */
export function readIptc(payload) {
  const res = resources(payload)?.find((r) => r.id === IPTC_RESOURCE);
  const list = res && datasets(res.data);
  if (!list) return null;
  const text = isUtf8(list) ? utf8 : latin1;
  return list.filter((d) => d.rec === 2 && d.ds !== 0).map((d) => ({ name: datasetName(d.rec, d.ds), value: text.decode(d.value).slice(0, 2000) }));
}

/**
 * Edits the IPTC of an APP13 payload: removes the datasets `drop(name)` accepts and
 * replaces the text of existing ones listed in `replace` ({name: text}).
 * @returns {{payload: Uint8Array, removed: string[], replaced: string[]}|null} null when it
 *   cannot be read (callers then treat the whole segment as unreadable)
 */
export function editIptc(payload, drop, replace = {}) {
  const res = resources(payload);
  if (!res) return null;
  const i = res.findIndex((r) => r.id === IPTC_RESOURCE);
  if (i < 0) return { payload, removed: [], replaced: [] };
  const list = datasets(res[i].data);
  if (!list) return null;
  const enc = isUtf8(list) ? (s) => new TextEncoder().encode(s) : (s) => Uint8Array.from(s, (c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63));
  const removed = [], replaced = [];
  const kept = [];
  for (const d of list) {
    const name = datasetName(d.rec, d.ds);
    if (d.rec === 2 && drop(name)) { removed.push(name); continue; }
    const r = d.rec === 2 && Object.keys(replace).find((k) => k.toLowerCase() === name.toLowerCase());
    if (r !== undefined && r !== false) {
      if (!replaced.includes(name)) { kept.push({ ...d, value: enc(replace[r]).subarray(0, 32767) }); replaced.push(name); }
      continue;
    }
    kept.push(d);
  }
  if (!removed.length && !replaced.length) return { payload, removed, replaced };
  // Lengths above 32767 take the extended form: 0x8004, then 4 bytes.
  const head = (d) => (d.value.length < 0x8000 ? Uint8Array.of(0x1c, d.rec, d.ds, d.value.length >> 8, d.value.length & 255)
    : Uint8Array.of(0x1c, d.rec, d.ds, 0x80, 4, d.value.length >>> 24, (d.value.length >> 16) & 255, (d.value.length >> 8) & 255, d.value.length & 255));
  const iim = concat(kept.map((d) => concat([head(d), d.value])));
  const out = [latin1Bytes(SIG)];
  res.forEach((r, k) => {
    if (r.id === DIGEST_RESOURCE) return;
    const data = k === i ? iim : r.data;
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, data.length);
    out.push(r.head, size, data);
    if (data.length & 1) out.push(new Uint8Array(1));
  });
  return { payload: concat(out), removed, replaced };
}

const latin1Bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Resource ids pixmix drops with privacy policies: copies of EXIF and XMP it cannot clean. */
export const COPY_RESOURCES = { 0x0422: 'EXIF copy', 0x0423: 'EXIF copy', 0x0424: 'XMP copy' };

/** Removes the listed 8BIM resources. @returns {{payload, removed: number[]}|null} */
export function dropResources(payload, ids) {
  const res = resources(payload);
  if (!res) return null;
  const removed = res.filter((r) => ids.includes(r.id)).map((r) => r.id);
  if (!removed.length) return { payload, removed };
  const out = [latin1Bytes(SIG)];
  for (const r of res) {
    if (ids.includes(r.id)) continue;
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, r.data.length);
    out.push(r.head, size, r.data);
    if (r.data.length & 1) out.push(new Uint8Array(1));
  }
  return { payload: concat(out), removed };
}
