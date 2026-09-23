// Definition -> compiled watermark: the text laid out with its font and turned into glyph
// outlines, ornaments turned into paths, logos into raw pixels, and gradient angles into
// direction vectors. This is the only part that reads fonts (with opentype.js), so it runs
// where definitions are saved (the dev server, the CLI); everything that draws works from
// the compiled form, which needs no fonts and no trigonometry.
//
// Compiled coordinates are in units of 1/1000 em, y pointing down, the first baseline at 0.

import opentype from 'opentype.js';
import { normalizeDefinition, validateCompiled, FORMAT, COMPILED_VERSION, UNITS } from './schema.js';
import { readPng } from '../formats/png/index.js';
import { toRGBA8 } from '../formats/png/rgba.js';
import { PixmixError } from '../core/params.js';

const parsed = new WeakMap(); // font bytes -> opentype Font

/**
 * @param {object} definition  (normalised or not; it is validated)
 * @param {{font: (name: string) => Uint8Array, asset?: (name: string) => Uint8Array}} sources
 *        font files (TTF/OTF) and logo images (PNG) by name
 * @returns {object} compiled watermark (see schema.js)
 */
export function compileWatermark(definition, { font: fontBytes, asset }) {
  const def = normalizeDefinition(definition);
  const font = loadFont(fontBytes(def.font), def.font);
  const text = layoutText(def, font);
  const box = text.box ? [...text.box] : [0, -700, 0, 0];
  const shapes = [];
  for (const [i, o] of def.ornaments.entries()) {
    const shape = ornament(o, box, text.box ?? box, asset, i);
    shapes.push({ d: shape.d, fill: compilePaint(o.fill ?? def.fill), outline: o.outline, image: shape.image ?? null });
    grow(box, shape.box);
  }
  shapes.push({ d: text.d, fill: compilePaint(def.fill), outline: true, image: null });
  const compiled = {
    format: FORMAT,
    version: COMPILED_VERSION,
    id: def.id,
    name: def.name,
    box: box.map((v, i) => (i < 2 ? Math.floor(v) : Math.ceil(v))),
    size: def.size,
    fit: def.fit,
    anchor: def.anchor,
    margin: def.margin,
    offset: def.offset,
    opacity: def.opacity,
    crisp: def.crisp,
    stroke: def.stroke,
    shadow: def.shadow,
    background: def.background && {
      ...def.background,
      fill: compilePaint(def.background.fill),
      border: def.background.border && { ...def.background.border, fill: compilePaint(def.background.border.fill) },
    },
    shapes,
  };
  return validateCompiled(compiled);
}

function loadFont(bytes, name) {
  if (!bytes) throw new PixmixError(`Unknown font "${name}"`, 'BAD_WATERMARK');
  let font = parsed.get(bytes);
  if (!font) {
    try {
      font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    } catch (err) {
      throw new PixmixError(`Font "${name}" could not be read (${err.message})`, 'BAD_WATERMARK');
    }
    parsed.set(bytes, font);
  }
  return font;
}

/**
 * Lines of glyphs, with kerning and letter spacing, aligned left/centre/right. Characters
 * are mapped one to one (no shaping), which is what short Latin labels need.
 */
function layoutText(def, font) {
  const scale = UNITS / font.unitsPerEm;
  const spacing = def.letterSpacing * UNITS;
  const lines = def.text.split('\n').map((line) => {
    const glyphs = [...line].map((ch) => {
      const g = font.charToGlyph(ch);
      if (!g || (g.index === 0 && ch !== ' ')) throw new PixmixError(`Font "${def.font}" has no glyph for "${ch}"`, 'BAD_WATERMARK');
      return g;
    });
    let x = 0;
    const placed = glyphs.map((g, i) => {
      const at = x;
      x += g.advanceWidth * scale + spacing;
      if (glyphs[i + 1]) x += font.getKerningValue(g, glyphs[i + 1]) * scale;
      return { g, x: at };
    });
    return { placed, width: glyphs.length ? x - spacing : 0 };
  });
  const widest = Math.max(...lines.map((l) => l.width));
  const cmds = [];
  lines.forEach((line, row) => {
    const dx = def.align === 'left' ? 0 : def.align === 'center' ? (widest - line.width) / 2 : widest - line.width;
    const dy = row * def.lineHeight * UNITS;
    for (const { g, x } of line.placed) {
      for (const c of g.path.commands) {
        // Font units are y-up; ours are y-down.
        const pt = (px, py) => [dx + x + px * scale, dy - py * scale];
        if (c.type === 'M' || c.type === 'L') cmds.push([c.type, ...pt(c.x, c.y)]);
        else if (c.type === 'Q') cmds.push(['Q', ...pt(c.x1, c.y1), ...pt(c.x, c.y)]);
        else if (c.type === 'C') cmds.push(['C', ...pt(c.x1, c.y1), ...pt(c.x2, c.y2), ...pt(c.x, c.y)]);
        else if (c.type === 'Z') cmds.push(['Z']);
      }
    }
  });
  const d = pathString(cmds);
  return { d, box: pathBox(parsePathString(d)) };
}

// --- ornaments ---------------------------------------------------------------------------
// Shapes are drawn in a unit box centred on 0,0 (y down), then scaled and placed next to the
// text's ink box.

const K = 0.5522847498; // cubic Bézier circle constant

const SHAPE_PATHS = {
  sparkle: [['M', 0, -0.5], ['Q', 0.07, -0.07, 0.5, 0], ['Q', 0.07, 0.07, 0, 0.5], ['Q', -0.07, 0.07, -0.5, 0], ['Q', -0.07, -0.07, 0, -0.5], ['Z']],
  diamond: [['M', 0, -0.5], ['L', 0.32, 0], ['L', 0, 0.5], ['L', -0.32, 0], ['Z']],
  dot: [
    ['M', 0.5, 0], ['C', 0.5, K / 2, K / 2, 0.5, 0, 0.5], ['C', -K / 2, 0.5, -0.5, K / 2, -0.5, 0],
    ['C', -0.5, -K / 2, -K / 2, -0.5, 0, -0.5], ['C', K / 2, -0.5, 0.5, -K / 2, 0.5, 0], ['Z'],
  ],
  heart: [['M', 0, 0.45], ['C', -0.55, 0.08, -0.5, -0.5, 0, -0.22], ['C', 0.5, -0.5, 0.55, 0.08, 0, 0.45], ['Z']],
  star: (() => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.2 : 0.5;
      pts.push([i ? 'L' : 'M', r * Math.cos(a), r * Math.sin(a) + 0.04]);
    }
    return [...pts, ['Z']];
  })(),
};

function ornament(o, box, textBox, asset, i) {
  const tw = textBox[2] - textBox[0], th = textBox[3] - textBox[1];
  let w = o.size * UNITS, h = w;
  if (o.shape === 'line') {
    w = o.position === 'above' || o.position === 'below' ? o.size * tw : o.size * UNITS;
    h = o.thickness * UNITS;
  }
  let image = null;
  if (o.shape === 'image') {
    image = logo(asset, o.src, i);
    w = (h * image.width) / image.height;
  }
  const gap = o.gap * UNITS;
  const midX = (textBox[0] + textBox[2]) / 2, midY = (textBox[1] + textBox[3]) / 2;
  const [cx, cy] = {
    before: [textBox[0] - gap - w / 2, midY],
    after: [textBox[2] + gap + w / 2, midY],
    above: [midX, textBox[1] - gap - h / 2],
    below: [midX, textBox[3] + gap + h / 2],
    'top-left': [textBox[0] - gap, textBox[1]],
    'top-right': [textBox[2] + gap, textBox[1]],
    'bottom-left': [textBox[0] - gap, textBox[3]],
    'bottom-right': [textBox[2] + gap, textBox[3]],
  }[o.position];
  const x = cx + o.offset.x * UNITS, y = cy + o.offset.y * UNITS;
  const rect = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
  if (o.shape === 'image') {
    const b = rect.map(Math.round);
    return { d: pathString([['M', b[0], b[1]], ['L', b[2], b[1]], ['L', b[2], b[3]], ['L', b[0], b[3]], ['Z']]), box: b, image: { ...image, box: b } };
  }
  const unit = o.shape === 'line'
    ? [['M', -0.5, -0.5], ['L', 0.5, -0.5], ['L', 0.5, 0.5], ['L', -0.5, 0.5], ['Z']]
    : SHAPE_PATHS[o.shape];
  const cmds = unit.map(([t, ...v]) => [t, ...v.map((n, k) => (k % 2 ? y + n * h : x + n * w))]);
  const d = pathString(cmds);
  return { d, box: pathBox(parsePathString(d)) };
}

function logo(asset, src, i) {
  const bytes = asset?.(src);
  if (!bytes) throw new PixmixError(`watermark ornaments[${i}].src: unknown asset "${src}"`, 'BAD_WATERMARK');
  const img = readPng(bytes);
  const { width, height } = img.ihdr;
  if (width > 256 || height > 256) throw new PixmixError(`watermark ornaments[${i}].src: logos can be at most 256×256 pixels`, 'BAD_WATERMARK');
  const rgba = toRGBA8(img, img.pixels);
  let bin = '';
  for (let k = 0; k < rgba.length; k += 0x8000) bin += String.fromCharCode(...rgba.subarray(k, k + 0x8000));
  return { width, height, rgba: btoa(bin) };
}

// --- paths ---------------------------------------------------------------------------------

/** Commands -> "M1 2L3 4…" with whole-unit coordinates. */
function pathString(cmds) {
  return cmds.map(([t, ...v]) => t + v.map((n) => Math.round(n) || 0).join(' ')).join('');
}

/** "M1 2L…" -> [['M', 1, 2], …]; the same parser the renderer uses. */
export function parsePathString(d) {
  const out = [];
  const re = /([MLQCZ])|(-?\d+(?:\.\d+)?)/g;
  let m, cur = null;
  while ((m = re.exec(d))) {
    if (m[1]) { cur = [m[1]]; out.push(cur); } else cur.push(Number(m[2]));
  }
  return out;
}

/** Exact bounds of a path, curves included (extrema of each segment). */
function pathBox(cmds) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  let px = 0, py = 0;
  const add = (x, y) => grow(box, [x, y, x, y]);
  const extrema = (p0, p1, p2, p3) => { // t in (0,1) where the derivative is zero
    if (p3 === undefined) { const den = p0 - 2 * p1 + p2; return den ? [(p0 - p1) / den] : []; }
    const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
    if (Math.abs(a) < 1e-9) return b ? [-c / b] : [];
    const disc = b * b - 4 * a * c;
    return disc < 0 ? [] : [(-b + Math.sqrt(disc)) / (2 * a), (-b - Math.sqrt(disc)) / (2 * a)];
  };
  for (const [t, ...v] of cmds) {
    if (t === 'M' || t === 'L') { [px, py] = v; add(px, py); continue; }
    if (t === 'Z') continue;
    const xs = [px, ...v.filter((_, k) => k % 2 === 0)], ys = [py, ...v.filter((_, k) => k % 2 === 1)];
    const at = (p, s) => (p.length === 3
      ? (1 - s) ** 2 * p[0] + 2 * (1 - s) * s * p[1] + s * s * p[2]
      : (1 - s) ** 3 * p[0] + 3 * (1 - s) ** 2 * s * p[1] + 3 * (1 - s) * s * s * p[2] + s ** 3 * p[3]);
    for (const s of [...extrema(...xs), ...extrema(...ys)]) if (s > 0 && s < 1) add(at(xs, s), at(ys, s));
    px = xs.at(-1); py = ys.at(-1);
    add(px, py);
  }
  return Number.isFinite(box[0]) ? box : null;
}

function grow(box, b) {
  if (!b) return;
  box[0] = Math.min(box[0], b[0]); box[1] = Math.min(box[1], b[1]);
  box[2] = Math.max(box[2], b[2]); box[3] = Math.max(box[3], b[3]);
}

/** CSS angle -> unit direction (0deg points up, 90deg right); rounded so it is stable. */
function compilePaint(p) {
  if (typeof p === 'string') return p;
  const a = (p.angle * Math.PI) / 180;
  const r = (n) => Math.round(n * 1e6) / 1e6 || 0;
  return { type: 'linear', dir: [r(Math.sin(a)), r(-Math.cos(a))], stops: p.stops };
}

// --- preview ---------------------------------------------------------------------------------

/**
 * An SVG of the compiled watermark at 1 em = `size` px, for previews and code review. The
 * stroke is approximated with SVG's own stroke; drawing always goes through render.js.
 */
export function watermarkToSvg(c, size = 48) {
  const s = size / UNITS;
  const pad = UNITS * ((c.background ? Math.max(c.background.padding.x, c.background.padding.y) : 0) + (c.stroke?.width ?? 0) + 0.3);
  const [x0, y0, x1, y1] = [c.box[0] - pad, c.box[1] - pad, c.box[2] + pad, c.box[3] + pad];
  const defs = [];
  const fill = (p, id) => {
    if (typeof p === 'string') return p;
    defs.push(`<linearGradient id="${id}" x1="${0.5 - p.dir[0] / 2}" y1="${0.5 - p.dir[1] / 2}" x2="${0.5 + p.dir[0] / 2}" y2="${0.5 + p.dir[1] / 2}">${
      p.stops.map((st) => `<stop offset="${st.at}" stop-color="${st.color.slice(0, 7)}"${st.color.length > 7 ? ` stop-opacity="${(parseInt(st.color.slice(7), 16) / 255).toFixed(3)}"` : ''}/>`).join('')}</linearGradient>`);
    return `url(#${id})`;
  };
  const parts = [];
  if (c.background) {
    const b = c.background;
    const px = b.padding.x * UNITS, py = b.padding.y * UNITS;
    const w = c.box[2] - c.box[0] + 2 * px, h = c.box[3] - c.box[1] + 2 * py;
    const r = b.shape === 'pill' ? h / 2 : Math.min(b.radius * UNITS, h / 2);
    parts.push(`<rect x="${c.box[0] - px}" y="${c.box[1] - py}" width="${w}" height="${h}" rx="${r}" fill="${fill(b.fill, 'bg')}" fill-opacity="${b.opacity}"${
      b.border ? ` stroke="${fill(b.border.fill, 'bd')}" stroke-width="${b.border.width * UNITS}"` : ''}/>`);
  }
  c.shapes.forEach((sh, i) => {
    if (sh.image) return;
    const stroke = c.stroke && sh.outline ? ` stroke="${c.stroke.color}" stroke-opacity="${c.stroke.opacity}" stroke-width="${c.stroke.width * UNITS * 2}" stroke-linejoin="${c.stroke.join === 'square' ? 'miter' : 'round'}" paint-order="stroke"` : '';
    parts.push(`<path d="${sh.d}" fill="${fill(sh.fill, `f${i}`)}"${stroke}/>`);
  });
  const w = Math.ceil((x1 - x0) * s), h = Math.ceil((y1 - y0) * s);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}"${c.opacity < 1 ? ` opacity="${c.opacity}"` : ''}>` +
    `${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${parts.join('')}</svg>\n`;
}
