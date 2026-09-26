// Metadata policies: what to keep, strip, remove and set, declared as plain data so they can
// be saved as profiles, sent to a server or a Web Worker, and applied the same way to PNG,
// JPEG and JPEG XL (see apply.js).
//
//   metadata: 'web'                                  a preset
//   metadata: { preset: 'privacy', strip: ['text'], remove: ['exif:Make'],
//               set: { copyright: 'Vivi', exif: { Software: 'pixmix' } } }
//
// Kinds: exif, xmp, icc, colour (PNG sRGB/gAMA/cHRM/cICP/mDCV/cLLI), text (PNG text chunks,
// JPEG comments), density, orientation (the EXIF Orientation tag), other (every other
// chunk, segment or box: Photoshop/IPTC, JUMBF/C2PA, unknown ones). Image data, structure
// (PLTE, tRNS, JFIF, Adobe APP14, …) and pixmix's own chunks are never touched.

import { PixmixError } from '../core/params.js';
import { settableTag, encodeEntry } from './tiff.js';
import { knownProperty, XmpPacket } from './xmp.js';
import { IFDS } from './exif-tags.js';

export const KINDS = ['exif', 'xmp', 'icc', 'colour', 'text', 'density', 'orientation', 'other'];
export const GROUPS = ['gps', 'serials', 'makernote', 'owner', 'timestamps', 'history', 'thumbnail', 'c2pa'];
export const PRESET_NAMES = ['keep', 'strip-all', 'privacy', 'web'];
const CONVENIENCE = ['artist', 'copyright', 'title', 'description', 'software'];

/**
 * - keep: everything as it is (the default).
 * - strip-all: only what displaying the pixels needs: the ICC profile, PNG colour chunks
 *   and the orientation (EXIF is cut down to the Orientation tag; JPEG XL orientation lives
 *   in the codestream, so its EXIF goes entirely).
 * - privacy: removes location, device serial numbers, maker notes, owner and creator names,
 *   timestamps, editing history and document ids, thumbnails and C2PA manifests; keeps
 *   the rest.
 * - web: strip-all, and an ICC profile that is plain sRGB goes too (viewers assume sRGB).
 *   Meant to be combined with `set` (copyright, artist, …).
 */
export const PRESETS = {
  keep: { strip: [], groups: [] },
  'strip-all': { strip: ['exif', 'xmp', 'text', 'density', 'other'], groups: [] },
  privacy: { strip: [], groups: ['gps', 'serials', 'makernote', 'owner', 'timestamps', 'history', 'thumbnail', 'c2pa'] },
  web: { strip: ['exif', 'xmp', 'text', 'density', 'other'], groups: [], dropSrgbIcc: true },
};

// What each removal group covers, per kind. Names are globs (case-insensitive).
const GROUP_EXIF = {
  gps: { ifds: ['GPS'] },
  serials: { tags: [0xa431, 0xa435, 0xc62f] },
  makernote: { tags: [0x927c, 0xc634] },
  owner: { tags: [0x013b, 0xa430, 0x9c9d, 0x013c, 0xa437, 0xa438] },
  timestamps: { tags: [0x0132, 0x9003, 0x9004, 0x9010, 0x9011, 0x9012, 0x9290, 0x9291, 0x9292], gpsTags: [0x07, 0x1d] },
  history: { tags: [0xa420] },
  thumbnail: { ifds: ['IFD1'] },
};
const GROUP_XMP = {
  gps: ['exif:GPS*', 'photoshop:City', 'photoshop:State', 'photoshop:Country', 'Iptc4xmpCore:Location', 'Iptc4xmpCore:CountryCode',
    'Iptc4xmpExt:LocationCreated', 'Iptc4xmpExt:LocationShown'],
  serials: ['aux:SerialNumber', 'aux:LensSerialNumber', 'aux:ImageNumber', 'exifEX:BodySerialNumber', 'exifEX:LensSerialNumber'],
  owner: ['dc:creator', 'dc:contributor', 'photoshop:AuthorsPosition', 'photoshop:CaptionWriter', 'aux:OwnerName', 'exifEX:CameraOwnerName',
    'exifEX:Photographer', 'exifEX:ImageEditor', 'xmpRights:Owner', 'Iptc4xmpCore:CreatorContactInfo', 'tiff:Artist', 'plus:ImageCreator',
    'plus:CopyrightOwner'],
  timestamps: ['xmp:CreateDate', 'xmp:ModifyDate', 'xmp:MetadataDate', 'photoshop:DateCreated', 'exif:DateTimeOriginal',
    'exif:DateTimeDigitized', 'tiff:DateTime', 'dc:date'],
  history: ['xmpMM:*', 'photoshop:DocumentAncestors', 'exif:ImageUniqueID'],
  thumbnail: ['xmp:Thumbnails', 'GImage:*', 'GDepth:*'],
};
const GROUP_IPTC = {
  gps: ['City', 'Sub-location', 'Province-State', 'Country-PrimaryLocationCode', 'Country-PrimaryLocationName', 'ContentLocationCode', 'ContentLocationName'],
  owner: ['By-line', 'By-lineTitle', 'Contact', 'Writer-Editor'],
  timestamps: ['DateCreated', 'TimeCreated', 'DigitalCreationDate', 'DigitalCreationTime'],
  history: ['OriginalTransmissionReference'],
};
const GROUP_TEXT = { owner: ['Author'], timestamps: ['Creation Time', 'date:*'] };
const GROUP_OTHER = { timestamps: ['tIME'], c2pa: ['caBX', 'APP11', 'jumb'] };

const RESOLVED = Symbol('pixmix.metadataPolicy');
const bad = (message) => new PixmixError(`Metadata policy: ${message}`, 'BAD_METADATA');

/** Glob (with * and ?) to an anchored, case-insensitive RegExp. */
function glob(s) {
  return new RegExp(`^${s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}
const anyOf = (globs) => { const res = globs.map(glob); return (name) => res.some((r) => r.test(name)); };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const checkKeys = (obj, allowed, where) => {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw bad(`unknown ${where} "${k}" (known: ${allowed.join(', ')})`);
};
const str = (v, where, max = 2000) => {
  if (typeof v !== 'string') throw bad(`${where} must be text`);
  if (v.length > max) throw bad(`${where} is longer than ${max} characters`);
  if (v.includes('\0')) throw bad(`${where} must not contain NUL characters`);
  return v;
};
const kindList = (v, where) => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw bad(`${where} must be a list of kinds`);
  for (const k of v) if (!KINDS.includes(k)) throw bad(`unknown kind "${k}" in ${where} (known: ${KINDS.join(', ')})`);
  return [...new Set(v)];
};

/**
 * PNG text keywords: 1-79 Latin-1 characters, no leading, trailing or double spaces.
 * XMP and ImageMagick's raw profiles have their own kinds.
 */
export function checkKeyword(k) {
  if (typeof k !== 'string' || !/^[\x20-\x7e\xa1-\xff]{1,79}$/.test(k) || /^ | $| {2}/.test(k)) throw bad(`text keyword "${k}" is not a valid PNG keyword`);
  if (k === 'XML:com.adobe.xmp' || /^Raw profile type /i.test(k)) throw bad(`text keyword "${k}" is reserved`);
  return k;
}

/**
 * Compiles a removal entry: a group name, or "exif:[IFD/]glob", "xmp:prefix:glob",
 * "iptc:glob", "text:glob", "other:glob".
 */
function compileRemoval(entry) {
  if (typeof entry !== 'string' || !entry || entry.length > 100) throw bad('remove entries must be short strings');
  if (GROUPS.includes(entry)) return { group: entry };
  const m = /^(exif|xmp|iptc|text|other):(.+)$/.exec(entry);
  if (!m) throw bad(`cannot read remove entry "${entry}" (a group: ${GROUPS.join(', ')}; or exif:Name, xmp:dc:creator, iptc:By-line, text:Author, other:APP13)`);
  const [, kind, rest] = m;
  if (kind === 'exif') {
    const [a, b] = rest.includes('/') ? rest.split('/', 2) : [null, rest];
    const ifd = a === null ? null : IFDS.find((x) => x.toLowerCase() === a.toLowerCase()) ?? (/^subifd\d*$/i.test(a) ? 'SubIFD' : undefined);
    if (ifd === undefined) throw bad(`unknown IFD "${a}" in "${entry}" (known: ${IFDS.join(', ')}, SubIFD)`);
    if (!b) throw bad(`"${entry}" names no tag`);
    return { kind, ifd, test: glob(b), source: entry };
  }
  if (kind === 'xmp' && !/^[^:]+:.+$/.test(rest)) throw bad(`"${entry}" must name prefix:property (e.g. xmp:dc:creator, xmp:exif:GPS*)`);
  return { kind, test: glob(rest), source: entry };
}

/**
 * Validates a policy (a preset name, a policy object or a saved profile) and resolves it
 * against its preset. Throws a PixmixError (code BAD_METADATA) naming the problem.
 */
export function normalizePolicy(input) {
  if (input?.[RESOLVED]) return input;
  if (typeof input === 'string') input = { preset: input };
  if (!isObject(input)) throw bad('must be a preset name or an object');
  checkKeys(input, ['id', 'name', 'description', 'preset', 'keep', 'strip', 'remove', 'set'], 'field');
  const presetName = input.preset ?? 'keep';
  const preset = PRESETS[presetName];
  if (!preset) throw bad(`unknown preset "${presetName}" (known: ${PRESET_NAMES.join(', ')})`);
  const keep = kindList(input.keep, 'keep');
  const strip = kindList(input.strip, 'strip');
  const both = keep.find((k) => strip.includes(k));
  if (both) throw bad(`"${both}" is in both keep and strip`);
  const kinds = Object.fromEntries(KINDS.map((k) => [k, (preset.strip.includes(k) || strip.includes(k)) && !keep.includes(k) ? 'strip' : 'keep']));

  if (input.remove !== undefined && !Array.isArray(input.remove)) throw bad('remove must be a list');
  if (input.remove?.length > 64) throw bad('remove has more than 64 entries');
  const removals = (input.remove ?? []).map(compileRemoval);
  const groups = new Set([...preset.groups, ...removals.filter((r) => r.group).map((r) => r.group)]);
  const patterns = removals.filter((r) => r.kind);

  const set = normalizeSet(input.set);
  const policy = {
    name: input.id ?? (input.keep || input.strip || input.remove || input.set ? 'custom' : presetName),
    preset: presetName,
    kinds,
    dropSrgbIcc: !!preset.dropSrgbIcc && kinds.icc === 'keep' && !keep.includes('icc'),
    groups,
    patterns,
    set,
  };
  policy.noop = KINDS.every((k) => kinds[k] === 'keep') && !groups.size && !patterns.length && !policy.dropSrgbIcc && set.empty;
  Object.defineProperty(policy, RESOLVED, { value: true });
  return policy;
}

function normalizeSet(set) {
  const out = { exif: [], xmp: [], text: [], comments: null, xmpPacket: null, icc: null, orientation: null, convenience: {}, empty: true };
  if (set === undefined) return out;
  if (!isObject(set)) throw bad('set must be an object');
  checkKeys(set, [...CONVENIENCE, 'comment', 'orientation', 'icc', 'exif', 'xmp', 'xmpPacket', 'text'], 'set field');
  for (const k of CONVENIENCE) if (set[k] !== undefined) out.convenience[k] = str(set[k], `set.${k}`);
  if (set.comment !== undefined) {
    const list = Array.isArray(set.comment) ? set.comment : [set.comment];
    if (list.length > 16) throw bad('set.comment has more than 16 comments');
    out.comments = list.map((c, i) => str(c, `set.comment[${i}]`, 16384));
  }
  if (set.orientation !== undefined) {
    if (!Number.isInteger(set.orientation) || set.orientation < 1 || set.orientation > 8) throw bad('set.orientation must be 1-8');
    out.orientation = set.orientation;
  }
  if (set.icc !== undefined) {
    if (set.icc !== 'srgb') throw bad('set.icc can only be "srgb"');
    out.icc = 'srgb';
  }
  const map = (obj, where, max) => {
    if (!isObject(obj)) throw bad(`${where} must be an object`);
    const entries = Object.entries(obj);
    if (entries.length > max) throw bad(`${where} has more than ${max} entries`);
    return entries;
  };
  if (set.exif !== undefined) {
    for (const [name, value] of map(set.exif, 'set.exif', 64)) {
      try {
        const info = settableTag(name);
        if (value !== null) encodeEntry(info, value, true); // validates the value
        out.exif.push({ info, value });
      } catch (err) {
        throw err?.code === 'BAD_METADATA' ? bad(`set.exif: ${err.message}`) : err;
      }
    }
  }
  if (set.xmp !== undefined) {
    for (const [name, value] of map(set.xmp, 'set.xmp', 64)) {
      if (!knownProperty(name)) throw bad(`set.xmp: "${name}" is not prefix:Property with a known prefix (dc, xmp, xmpRights, photoshop, Iptc4xmpCore, …)`);
      if (value !== null) {
        const list = Array.isArray(value) ? value : [value];
        if (!list.length || list.length > 64) throw bad(`set.xmp["${name}"] needs 1-64 values`);
        list.forEach((v, i) => str(v, `set.xmp["${name}"]${Array.isArray(value) ? `[${i}]` : ''}`));
      }
      out.xmp.push({ name, value });
    }
  }
  if (set.xmpPacket !== undefined) {
    str(set.xmpPacket, 'set.xmpPacket', 60000);
    try { new XmpPacket(set.xmpPacket); } catch (err) { throw bad(`set.xmpPacket: ${err.message}`); }
    out.xmpPacket = set.xmpPacket;
  }
  if (set.text !== undefined) {
    for (const [keyword, value] of map(set.text, 'set.text', 32)) {
      checkKeyword(keyword);
      if (keyword === 'Comment') throw bad('set.text: use set.comment for comments');
      out.text.push({ keyword, text: value === null ? null : str(value, `set.text["${keyword}"]`, 16384) });
    }
  }
  out.empty = !Object.keys(out.convenience).length && !out.comments && !out.orientation && !out.icc
    && !out.exif.length && !out.xmp.length && !out.xmpPacket && !out.text.length;
  return out;
}

// --- matching --------------------------------------------------------------------------

/**
 * Why an EXIF tag goes (a group name or the pattern), or null.
 * @param {import('./policy.js').Policy} p @param {string} ifd @param {number} tag @param {string} name
 */
export function exifRemoval(p, ifd, tag, name) {
  for (const g of p.groups) {
    const d = GROUP_EXIF[g];
    if (!d) continue;
    if (d.ifds?.includes(ifd) || (ifd !== 'GPS' && d.tags?.includes(tag)) || (ifd === 'GPS' && d.gpsTags?.includes(tag))) return g;
  }
  const hex = `0x${tag.toString(16).padStart(4, '0')}`;
  for (const r of p.patterns) {
    if (r.kind !== 'exif') continue;
    if (r.ifd && r.ifd !== ifd && !(r.ifd === 'SubIFD' && ifd.startsWith('SubIFD'))) continue;
    if (r.test.test(name) || r.test.test(hex)) return r.source;
  }
  if (p.kinds.orientation === 'strip' && ifd === 'IFD0' && tag === 0x0112) return 'orientation';
  const s = p.set.exif.find((e) => e.value === null && e.info.tag === tag && e.info.ifd === ifd);
  return s ? `set.exif.${s.info.name}` : null;
}

const byGroup = (table) => Object.fromEntries(Object.entries(table).map(([g, globs]) => [g, anyOf(globs)]));
const MATCHERS = { xmp: byGroup(GROUP_XMP), iptc: byGroup(GROUP_IPTC), text: byGroup(GROUP_TEXT), other: byGroup(GROUP_OTHER) };

/**
 * Why an XMP property, IPTC dataset, text keyword or other chunk/segment/box goes, or null.
 * @param {'xmp'|'iptc'|'text'|'other'} kind
 */
export function removal(p, kind, name) {
  const m = MATCHERS[kind];
  for (const g of p.groups) if (m[g]?.(name)) return g;
  for (const r of p.patterns) if (r.kind === kind && r.test.test(name)) return r.source;
  if (kind === 'xmp' && p.kinds.orientation === 'strip' && name === 'tiff:Orientation') return 'orientation';
  if (kind === 'xmp' && p.set.xmp.some((e) => e.value === null && e.name === name)) return `set.xmp.${name}`;
  if (kind === 'text' && p.set.text.some((e) => e.text === null && e.keyword === name)) return `set.text.${name}`;
  return null;
}

/** Whether any removal could apply to `kind` (so a file's block of it must be looked into). */
export function touches(p, kind) {
  if (kind === 'exif') return p.groups.size > 0 || p.patterns.some((r) => r.kind === 'exif') || p.kinds.orientation === 'strip' || p.set.exif.length > 0;
  const m = kind === 'xmp' ? GROUP_XMP : kind === 'iptc' ? GROUP_IPTC : kind === 'text' ? GROUP_TEXT : GROUP_OTHER;
  return [...p.groups].some((g) => m[g]) || p.patterns.some((r) => r.kind === kind)
    || (kind === 'xmp' && (p.kinds.orientation === 'strip' || p.set.xmp.length > 0))
    || (kind === 'text' && p.set.text.some((e) => e.text === null));
}

// --- profiles ----------------------------------------------------------------------------

/** Profile ids: like watermark ids, and never a preset name (those are resolved first). */
export const PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/**
 * A saved profile in canonical form (validated, fixed key order, empty fields left out), so
 * files written from it diff cleanly: id, name, description, preset, keep, strip, remove,
 * set (convenience fields first, then comment, orientation, icc, exif, xmp, xmpPacket, text;
 * the tag / property / keyword maps sorted).
 */
export function normalizeProfile(profile) {
  if (!isObject(profile)) throw bad('a profile must be an object');
  normalizePolicy(profile); // everything is validated there
  const { id, name, description } = profile;
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw bad(`profile id "${id}" must be lowercase letters, digits and dashes`);
  if (PRESET_NAMES.includes(id)) throw bad(`profile id "${id}" is a preset name`);
  const out = { id };
  if (name !== undefined) out.name = str(name, 'name', 80);
  if (description !== undefined) out.description = str(description, 'description', 500);
  if (profile.preset !== undefined && profile.preset !== 'keep') out.preset = profile.preset;
  for (const k of ['keep', 'strip']) if (profile[k]?.length) out[k] = KINDS.filter((x) => profile[k].includes(x));
  if (profile.remove?.length) out.remove = [...new Set(profile.remove)];
  const set = profile.set;
  if (set && Object.keys(set).length) {
    const s = {};
    for (const k of [...CONVENIENCE, 'comment', 'orientation', 'icc']) if (set[k] !== undefined) s[k] = set[k];
    for (const k of ['exif', 'xmp']) if (set[k] && Object.keys(set[k]).length) s[k] = sorted(set[k]);
    if (set.xmpPacket !== undefined) s.xmpPacket = set.xmpPacket;
    if (set.text && Object.keys(set.text).length) s.text = sorted(set.text);
    if (Object.keys(s).length) out.set = s;
  }
  return out;
}

const sorted = (obj) => Object.fromEntries(Object.keys(obj).sort((a, b) => a.localeCompare(b, 'en')).map((k) => [k, obj[k]]));

/** A profile as its file holds it: canonical, two-space JSON, a final newline. */
export const formatProfile = (profile) => `${JSON.stringify(normalizeProfile(profile), null, 2)}\n`;
