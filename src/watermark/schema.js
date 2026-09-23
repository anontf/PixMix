// Watermark definitions (what people write and commit) and compiled watermarks (what gets
// drawn), both validated strictly. A definition names a font and holds text; compiling it
// (compile.js, at save time) turns the text into glyph outlines, so drawing never needs a
// font. Compiled watermarks also arrive from untrusted places (a URL, or a scrambled file
// that carries one), so their validation bounds every size and count.
//
// Lengths in a definition are in em (the font size), except where a name says otherwise
// (px, or a fraction of the image). Normalising fills in every default and writes keys in
// one fixed order, so saved files diff cleanly.

import { PixmixError } from '../core/params.js';

export const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
export const FONT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const ASSET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.png$/;
export const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];
export const SHAPES = ['sparkle', 'star', 'diamond', 'dot', 'heart', 'line', 'image'];
export const POSITIONS = ['before', 'after', 'above', 'below', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
export const FORMAT = 'pixmix-watermark';
export const COMPILED_VERSION = 1;

// Bounds for compiled watermarks (untrusted input).
const MAX_PATH = 200000; // characters of path data, all shapes together
const MAX_SHAPES = 24;
const MAX_IMAGE = 256; // logo pixels per side
const UNITS = 1000; // compiled coordinates: 1000 per em

const fail = (path, msg) => { throw new PixmixError(`watermark ${path}: ${msg}`, 'BAD_WATERMARK'); };

// --- field specs -------------------------------------------------------------------
// Each spec normalises one value: n(value, path) -> normalised value, or throws.

// A missing value takes the default; without one it is required.
const missing = (dflt, p) => (dflt === undefined ? fail(p, 'is required') : dflt);

const num = (min, max, dflt) => (v, p) => {
  if (v === undefined) return missing(dflt, p);
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(p, 'must be a number');
  if (v < min || v > max) fail(p, `must be between ${min} and ${max}`);
  return v;
};
const optNum = (min, max) => (v, p) => (v === undefined || v === null ? null : num(min, max)(v, p));
const int = (min, max) => (v, p) => {
  num(min, max)(v, p);
  if (!Number.isInteger(v)) fail(p, 'must be a whole number');
  return v;
};
const bool = (dflt) => (v, p) => {
  if (v === undefined) return missing(dflt, p);
  if (typeof v !== 'boolean') fail(p, 'must be true or false');
  return v;
};
const oneOf = (values, dflt) => (v, p) => {
  if (v === undefined) return missing(dflt, p);
  if (!values.includes(v)) fail(p, `must be one of ${values.join(', ')}`);
  return v;
};
const str = (pattern, max, dflt, what = 'text') => (v, p) => {
  if (v === undefined && dflt !== undefined) return dflt;
  if (typeof v !== 'string') fail(p, `must be a string`);
  if (v.length > max) fail(p, `must be at most ${max} characters`);
  if (pattern && !pattern.test(v)) fail(p, `is not a valid ${what}`);
  return v;
};

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const color = (dflt) => (v, p) => {
  if (v === undefined) return missing(dflt, p);
  if (typeof v !== 'string' || !COLOR.test(v)) fail(p, 'must be a colour like #rrggbb or #rrggbbaa');
  const h = v.slice(1).toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`;
};

/** A solid colour, or a linear gradient: angle in degrees as in CSS (180 = top to bottom). */
const paint = (dflt) => (v, p) => {
  if (v === undefined) return missing(dflt, p);
  if (typeof v === 'string') return color()(v, p);
  const g = object({
    type: oneOf(['linear']),
    angle: num(0, 360, 180),
    stops: list(object({ at: num(0, 1), color: color() }), 2, 8),
  })(v, p);
  if (g.stops.some((s, i) => i && s.at < g.stops[i - 1].at)) fail(`${p}.stops`, 'must be in increasing order');
  return g;
};

function object(fields, { nullable = false, dflt } = {}) {
  return (v, p) => {
    if (v === undefined && dflt !== undefined) v = dflt;
    if (v === null && nullable) return null;
    if (v === undefined) v = {};
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(p, nullable ? 'must be an object or null' : 'must be an object');
    for (const k of Object.keys(v)) if (!(k in fields)) fail(p ? `${p}.${k}` : k, 'is not a known field');
    const out = {};
    for (const [k, spec] of Object.entries(fields)) out[k] = spec(v[k], p ? `${p}.${k}` : k);
    return out;
  };
}

function list(spec, min, max) {
  return (v, p) => {
    if (v === undefined && min === 0) return [];
    if (!Array.isArray(v)) fail(p, 'must be a list');
    if (v.length < min || v.length > max) fail(p, `must have ${min}–${max} entries`);
    return v.map((x, i) => spec(x, `${p}[${i}]`));
  };
}

const text = (v, p) => {
  str(null, 200)(v, p);
  const lines = v.split('\n');
  if (!v.trim() || lines.length > 4) fail(p, 'must be 1–4 non-empty lines');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(v)) fail(p, 'must not contain control characters');
  return v;
};

// Placement and style are shared by definitions and compiled watermarks.
const PLACEMENT = {
  size: object({
    px: optNum(1, 2000), // absolute em size; wins over relative
    relative: num(0.001, 1, 0.03), // fraction of the reference length below
    of: oneOf(['short', 'long', 'width', 'height', 'diagonal'], 'short'),
    min: num(1, 2000, 10),
    max: num(1, 2000, 48),
    snap: num(0, 256, 0), // round the size down to a multiple (crisp pixel fonts)
  }),
  fit: object({
    maxWidth: num(0.05, 1, 0.5), // of the image width
    maxHeight: num(0.05, 1, 0.25),
    minSize: num(0, 200, 6), // px of em below which the watermark is left out
  }),
  anchor: oneOf(ANCHORS, 'bottom-right'),
  margin: object({ relative: num(0, 0.5, 0.02), min: num(0, 2000, 4), max: num(0, 2000, 32) }),
  offset: object({ x: num(-20, 20, 0), y: num(-20, 20, 0) }),
};

const style = (paintSpec) => ({
  opacity: num(0, 1, 1),
  crisp: bool(false), // hard pixel edges (no anti-aliasing), for pixel fonts
  stroke: object({
    color: color('#000000'),
    width: num(0.001, 1, 0.1),
    join: oneOf(['round', 'square'], 'round'),
    opacity: num(0, 1, 1),
  }, { nullable: true, dflt: null }),
  shadow: object({
    color: color('#000000'),
    opacity: num(0, 1, 0.5),
    x: num(-2, 2, 0.08),
    y: num(-2, 2, 0.08),
    blur: num(0, 2, 0),
  }, { nullable: true, dflt: null }),
  background: object({
    shape: oneOf(['box', 'pill', 'strip'], 'box'),
    fill: paintSpec('#000000'),
    opacity: num(0, 1, 0.6),
    radius: num(0, 5, 0.25),
    padding: object({ x: num(0, 5, 0.5), y: num(0, 5, 0.3) }),
    border: object({ fill: paintSpec('#ffffff'), width: num(0.001, 1, 0.08) }, { nullable: true, dflt: null }),
  }, { nullable: true, dflt: null }),
});

const ORNAMENT = object({
  shape: oneOf(SHAPES, 'sparkle'),
  position: oneOf(POSITIONS, 'after'),
  size: num(0.05, 4, 0.5), // em; for a line above/below: its length as a fraction of the text width
  thickness: num(0.01, 1, 0.06), // lines only
  gap: num(-2, 4, 0.15),
  offset: object({ x: num(-4, 4, 0), y: num(-4, 4, 0) }),
  fill: (v, p) => (v === undefined || v === null ? null : paint()(v, p)), // null: the text fill
  outline: bool(true), // gets the stroke, like the text
  src: (v, p) => (v === undefined || v === null ? null : str(ASSET_PATTERN, 68, undefined, 'asset name (name.png)')(v, p)),
});

const DEFINITION = object({
  id: str(ID_PATTERN, 48, undefined, 'id (lowercase letters, digits and dashes)'),
  name: (v, p) => (v === undefined ? undefined : str(null, 80)(v, p)),
  text,
  font: str(FONT_PATTERN, 64, undefined, 'font name'),
  letterSpacing: num(-1, 2, 0),
  lineHeight: num(0.5, 4, 1.2),
  align: oneOf(['left', 'center', 'right'], 'left'),
  fill: paint('#ffffff'),
  ...PLACEMENT,
  ...style(paint),
  ornaments: list(ORNAMENT, 0, 8),
});

/**
 * Validates a definition and returns it normalised: every field present, in a fixed order.
 * @returns {object}
 */
export function normalizeDefinition(def) {
  const out = DEFINITION(def, '');
  out.name ??= out.id; // keeps its place in the key order
  for (const [i, o] of out.ornaments.entries()) {
    if (o.shape === 'image' && !o.src) fail(`ornaments[${i}].src`, 'is required for an image');
    if (o.shape !== 'image' && o.src) fail(`ornaments[${i}].src`, 'only applies to an image');
  }
  if (out.size.min > out.size.max) fail('size.min', 'must not exceed size.max');
  if (out.margin.min > out.margin.max) fail('margin.min', 'must not exceed margin.max');
  return out;
}

/** The definition as saved on disk: normalised, two-space indented, final newline. */
export function formatDefinition(def) {
  return formatJson(normalizeDefinition(def));
}

/**
 * JSON with two-space indents, except that small objects and lists of plain values stay on
 * one line ({ "x": 0, "y": 0 }), which keeps files short and diffs to the lines that changed.
 */
export function formatJson(value) {
  const write = (v, indent) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    const entries = Array.isArray(v) ? v.map((x) => [null, x]) : Object.entries(v);
    const key = (k) => (k === null ? '' : `${JSON.stringify(k)}: `);
    if (!entries.length) return Array.isArray(v) ? '[]' : '{}';
    if (entries.every(([, x]) => x === null || typeof x !== 'object')) {
      const flat = entries.map(([k, x]) => key(k) + JSON.stringify(x)).join(', ');
      if (flat.length + indent.length <= 90) return Array.isArray(v) ? `[${flat}]` : `{ ${flat} }`;
    }
    const inner = `${indent}  `;
    const body = entries.map(([k, x]) => inner + key(k) + write(x, inner)).join(',\n');
    return Array.isArray(v) ? `[\n${body}\n${indent}]` : `{\n${body}\n${indent}}`;
  };
  return `${write(value, '')}\n`;
}

// --- compiled watermarks ---------------------------------------------------------------

const PATH_CHARS = /^[MLQCZ0-9 .-]*$/;
const coord = num(-1e6, 1e6);

const compiledPaint = (dflt) => (v, p) => {
  if (v === undefined) return missing(dflt, p);
  if (typeof v === 'string') return color()(v, p);
  return object({
    type: oneOf(['linear']),
    dir: list(num(-1, 1), 2, 2), // unit vector along the gradient (trigonometry stays at compile time)
    stops: list(object({ at: num(0, 1), color: color() }), 2, 8),
  })(v, p);
};

const SHAPE = object({
  d: (v, p) => {
    str(null, MAX_PATH)(v, p);
    if (!PATH_CHARS.test(v)) fail(p, 'has characters outside M L Q C Z and numbers');
    return v;
  },
  fill: compiledPaint(),
  outline: bool(true),
  image: object({
    width: int(1, MAX_IMAGE),
    height: int(1, MAX_IMAGE),
    box: list(coord, 4, 4), // x0, y0, x1, y1 in units
    rgba: str(/^[A-Za-z0-9+/]*={0,2}$/, Math.ceil((MAX_IMAGE * MAX_IMAGE * 4) / 3) + 4),
  }, { nullable: true, dflt: null }),
});

const COMPILED = object({
  format: oneOf([FORMAT]),
  version: (v, p) => { if (v !== COMPILED_VERSION) fail(p, `unsupported version ${v}`); return v; },
  id: str(ID_PATTERN, 48, undefined, 'id'),
  name: str(null, 80),
  box: list(coord, 4, 4), // ink bounds of everything but the background, in units, y down
  ...PLACEMENT,
  ...style(compiledPaint),
  shapes: list(SHAPE, 1, MAX_SHAPES),
});

/**
 * Validates a compiled watermark (e.g. fetched, or read from a scrambled file). Throws
 * PixmixError('BAD_WATERMARK') on anything unexpected, including oversized data.
 */
export function validateCompiled(obj) {
  const c = COMPILED(obj, '');
  if (c.shapes.reduce((n, s) => n + s.d.length, 0) > MAX_PATH) fail('shapes', 'hold too much path data');
  for (const [i, s] of c.shapes.entries()) {
    if (s.image && s.image.rgba.length !== 4 * Math.ceil((s.image.width * s.image.height * 4) / 3)) {
      fail(`shapes[${i}].image.rgba`, 'does not match its size');
    }
  }
  return c;
}

export { UNITS };
