// The lab's watermark editor: edits a definition with a form (or its JSON), previews it live
// with the real renderer (the server compiles the text to outlines, the page draws them
// with dist/pixmix-watermark.mjs), and saves it to the repository's watermarks/ directory.

import * as Enc from '/dist/pixmix-encoder.mjs';
import * as Wm from '/dist/pixmix-watermark.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];
const SHAPES = ['sparkle', 'star', 'diamond', 'dot', 'heart', 'line', 'image'];
const POSITIONS = ['before', 'after', 'above', 'below', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];

let list = [], fonts = [], assets = [];
let def = null; // the definition being edited (normalised by the server after each change)
let compiled = null;
let savedId = null; // id of the file it was loaded from (null: not saved yet)
let current = null; // the lab's image, as an ImageBitmap

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const out = await res.json();
  if (!res.ok) throw Object.assign(new Error(out.error), { status: res.status });
  return out;
}

// --- list and pickers ---------------------------------------------------------------------

async function refresh(select) {
  ({ watermarks: list, fonts, assets } = await api('/api/watermarks'));
  // Every watermark picker on the page: its fixed options stay, the watermarks follow.
  for (const el of document.querySelectorAll('select.wm-list')) {
    const keep = el.value;
    for (const o of [...el.options]) if (o.dataset.wm) o.remove();
    for (const w of list) {
      const o = new Option(`${w.name} (${w.id})`, w.id);
      o.dataset.wm = '1';
      el.add(o);
    }
    if ([...el.options].some((o) => o.value === keep)) el.value = keep;
  }
  if (select) $('wmPick').value = select;
  if (!def && list.length) await load(list[0].id);
  else syncPick();
}

/**
 * The picker names what is being edited: the saved watermark, or an extra "not saved" entry
 * for a new one, a copy, or a saved one given another id (Save creates that one).
 */
function syncPick() {
  const pick = $('wmPick');
  pick.querySelector('option[data-unsaved]')?.remove();
  if (!def) return;
  if (savedId && savedId === def.id) { pick.value = savedId; return; }
  const o = new Option(`${def.name} (${def.id}) · not saved`, '');
  o.dataset.unsaved = '1';
  pick.add(o, 0);
  pick.value = '';
}

/** "not saved" with what Save will do, or the file it was loaded from. */
function showSaved() {
  if (savedId === def.id) return status(`watermarks/${def.id}.json`);
  const taken = list.some((w) => w.id === def.id);
  status(taken ? `not saved: watermarks/${def.id}.json already exists (Save asks before replacing it)`
    : savedId ? `not saved: Save creates watermarks/${def.id}.json (${savedId} stays)` : 'not saved', 'bad');
}

function load(id) {
  const w = list.find((x) => x.id === id);
  if (!w) return;
  def = structuredClone(w);
  savedId = id;
  syncPick();
  render();
  return preview();
}

$('wmPick').addEventListener('change', () => load($('wmPick').value)); // (the unsaved entry: stays)
$('wmNew').addEventListener('click', () => {
  def = { id: freeId('new-watermark'), name: 'New watermark', text: 'Vivi', font: fonts[0], stroke: { color: '#000000', width: 0.08 } };
  savedId = null;
  normaliseThen(render);
});
$('wmCopy').addEventListener('click', () => {
  if (!def) return;
  def = { ...structuredClone(def), id: freeId(`${def.id}-copy`), name: `${def.name} (copy)` };
  savedId = null;
  syncPick();
  render();
  preview();
});
$('wmDelete').addEventListener('click', async () => {
  if (!def) return;
  if (!savedId) return status(`${def.id} is not saved yet: there is no file to delete (pick a saved watermark to leave it)`, 'bad');
  const what = savedId === def.id ? `watermarks/${savedId}.json` : `watermarks/${savedId}.json (the file this was loaded from; ${def.id} is not saved)`;
  if (!confirm(`Delete ${what}?`)) return;
  try {
    const id = savedId;
    await api(`/api/watermarks/${id}`, { method: 'DELETE' });
    def = null; savedId = null;
    await refresh();
    status(`deleted ${id}`, 'ok');
  } catch (err) { status(err.message, 'bad'); }
});
$('wmSave').addEventListener('click', async () => {
  if (!def) return;
  const id = def.id, from = savedId;
  const put = () => api(`/api/watermarks/${encodeURIComponent(id)}`, { method: 'PUT', body: def });
  try {
    let out;
    if (from === id) out = await put();
    else if (list.some((w) => w.id === id)) {
      // Another watermark's id: replace that file only when asked to.
      if (!confirm(`watermarks/${id}.json already exists. Replace it with this one?`)) return refused(id);
      out = await put();
    } else {
      // New, a copy, or a saved one under another id: create only, so that another
      // watermark's file is never replaced without asking.
      try {
        out = await api('/api/watermarks', { method: 'POST', body: def });
      } catch (err) {
        if (err.status !== 409) throw err; // (saved meanwhile, from elsewhere)
        if (!confirm(`watermarks/${id}.json already exists. Replace it with this one?`)) return refused(id);
        out = await put();
      }
    }
    def = out.definition;
    savedId = def.id;
    await refresh(def.id);
    render();
    status(`saved watermarks/${def.id}.json${from && from !== def.id ? ` (${from} stays)` : ''}`, 'ok');
  } catch (err) { status(err.message, 'bad'); }
});

const refused = (id) => status(`not saved: watermarks/${id}.json already exists (give this one another id)`, 'bad');

function freeId(base) {
  let id = base, n = 2;
  while (list.some((w) => w.id === id)) id = `${base}-${n++}`;
  return id;
}

function status(text, cls = '') {
  $('wmStatus').innerHTML = `<span class="${cls}">${esc(text)}</span>`;
}

// --- the form -------------------------------------------------------------------------
// Every field reads and writes `def` by path; sections that are null (stroke, shadow,
// background, border) get a checkbox that switches them on with the defaults.

const get = (path) => path.split('.').reduce((o, k) => o?.[k], def);
function set(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], def)[last] = value;
}

const DEFAULTS = {
  stroke: { color: '#000000', width: 0.08 },
  shadow: { color: '#000000', opacity: 0.5, x: 0.08, y: 0.08 },
  background: { shape: 'box', fill: '#000000', opacity: 0.6 },
  'background.border': { fill: '#ffffff', width: 0.08 },
};

function render() {
  const f = $('wmForm');
  f.replaceChildren();
  if (!def) return;
  const group = (title, ...rows) => {
    const fs = document.createElement('fieldset');
    fs.innerHTML = `<legend>${title}</legend>`;
    fs.append(...rows.flat().filter(Boolean));
    f.append(fs);
    return fs;
  };
  group('Text',
    input('id', 'id', 'text'), input('name', 'name', 'text'), textarea('text', 'text'),
    select('font', 'font', fonts), input('letterSpacing', 'letter spacing (em)', 'number', 0.01),
    input('lineHeight', 'line height', 'number', 0.05), select('align', 'align', ['left', 'center', 'right']));
  group('Size',
    input('size.px', 'fixed size px (empty: relative)', 'number', 1, true), input('size.relative', 'relative size', 'number', 0.001),
    select('size.of', 'of the image’s', ['short', 'long', 'width', 'height', 'diagonal']),
    input('size.min', 'min px', 'number', 1), input('size.max', 'max px', 'number', 1), input('size.snap', 'snap px', 'number', 1),
    input('fit.maxWidth', 'max width (of image)', 'number', 0.01), input('fit.maxHeight', 'max height (of image)', 'number', 0.01),
    input('fit.minSize', 'hide below px', 'number', 1));
  group('Position',
    anchors(), input('margin.relative', 'margin (relative)', 'number', 0.001), input('margin.min', 'margin min px', 'number', 1),
    input('margin.max', 'margin max px', 'number', 1), input('offset.x', 'offset x (em)', 'number', 0.01), input('offset.y', 'offset y (em)', 'number', 0.01));
  group('Look',
    paint('fill', 'fill'), input('opacity', 'opacity', 'range', 0.01), check('crisp', 'crisp pixel edges'));
  optional('stroke', 'Outline', () => [
    input('stroke.color', 'colour', 'color'), input('stroke.width', 'width (em)', 'number', 0.005),
    select('stroke.join', 'join', ['round', 'square']), input('stroke.opacity', 'opacity', 'range', 0.01)]);
  optional('shadow', 'Shadow', () => [
    input('shadow.color', 'colour', 'color'), input('shadow.opacity', 'opacity', 'range', 0.01),
    input('shadow.x', 'x (em)', 'number', 0.01), input('shadow.y', 'y (em)', 'number', 0.01), input('shadow.blur', 'blur (em)', 'number', 0.01)]);
  optional('background', 'Background', () => [
    select('background.shape', 'shape', ['box', 'pill', 'strip']), paint('background.fill', 'fill'),
    input('background.opacity', 'opacity', 'range', 0.01), input('background.radius', 'radius (em)', 'number', 0.01),
    input('background.padding.x', 'padding x (em)', 'number', 0.01), input('background.padding.y', 'padding y (em)', 'number', 0.01),
    optionalInline('background.border', 'border', () => [paint('background.border.fill', 'border fill'), input('background.border.width', 'border width (em)', 'number', 0.005)])]);
  const orn = group('Ornaments');
  def.ornaments.forEach((o, i) => {
    const p = `ornaments.${i}`;
    const box = document.createElement('div');
    box.className = 'wm-orn';
    box.append(select(`${p}.shape`, `#${i + 1} shape`, SHAPES), select(`${p}.position`, 'position', POSITIONS),
      input(`${p}.size`, 'size', 'number', 0.01), ...(o.shape === 'line' ? [input(`${p}.thickness`, 'thickness (em)', 'number', 0.005)] : []),
      input(`${p}.gap`, 'gap (em)', 'number', 0.01), input(`${p}.offset.x`, 'offset x', 'number', 0.01), input(`${p}.offset.y`, 'offset y', 'number', 0.01),
      ...(o.shape === 'image' ? [select(`${p}.src`, 'logo (watermarks/assets)', assets)] : [
        optionalInline(`${p}.fill`, 'own fill', () => [paint(`${p}.fill`, 'fill')], '#ffffff')]),
      check(`${p}.outline`, 'outlined'), button('remove', () => { def.ornaments.splice(i, 1); changed(true); }));
    orn.append(box);
  });
  orn.append(button('add ornament', () => { def.ornaments.push({ shape: 'sparkle', position: 'after' }); changed(true); }));
  $('wmJson').value = JSON.stringify(def, null, 2);
}

function label(text, el) {
  const l = document.createElement('label');
  l.append(text, el);
  return l;
}

function input(path, text, type, step, nullable = false) {
  const el = document.createElement('input');
  el.type = type;
  el.name = path;
  if (step) el.step = step;
  if (type === 'range') { el.min = 0; el.max = 1; }
  const v = get(path);
  if (type === 'color') {
    // #rrggbbaa: the colour input takes #rrggbb; the alpha is kept.
    el.value = (v ?? '#000000').slice(0, 7);
    el.addEventListener('input', () => { set(path, el.value + (get(path)?.slice(7) ?? '')); changed(); });
  } else {
    el.value = v ?? '';
    el.addEventListener('input', () => {
      if (type === 'text') set(path, el.value);
      else if (el.value === '' && nullable) set(path, null);
      else if (el.value !== '' && Number.isFinite(Number(el.value))) set(path, Number(el.value));
      else return;
      changed();
    });
  }
  return label(text, el);
}

function textarea(path, text) {
  const el = document.createElement('textarea');
  el.name = path;
  el.rows = 2;
  el.value = get(path);
  el.addEventListener('input', () => { set(path, el.value); changed(); });
  return label(text, el);
}

function select(path, text, values) {
  const el = document.createElement('select');
  el.name = path;
  for (const v of values) el.add(new Option(v, v));
  el.value = get(path) ?? values[0];
  el.addEventListener('change', () => { set(path, el.value); changed(path.endsWith('shape')); });
  return label(text, el);
}

function check(path, text) {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.name = path;
  el.checked = !!get(path);
  el.addEventListener('change', () => { set(path, el.checked); changed(); });
  return label(text, el);
}

function button(text, onclick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onclick);
  return b;
}

function anchors() {
  const grid = document.createElement('div');
  grid.className = 'wm-anchors';
  grid.setAttribute('role', 'radiogroup');
  for (const a of ANCHORS) {
    const b = button('', () => { set('anchor', a); changed(true); });
    b.title = a;
    b.setAttribute('aria-label', a);
    b.setAttribute('aria-pressed', String(def.anchor === a));
    grid.append(b);
  }
  return label('anchor', grid);
}

/** A solid colour (with alpha) or a linear gradient with its stops. */
function paint(path, text) {
  const v = get(path);
  const box = document.createElement('div');
  box.className = 'wm-paint';
  const kind = document.createElement('select');
  kind.add(new Option('solid', 'solid'));
  kind.add(new Option('gradient', 'linear'));
  kind.value = typeof v === 'string' ? 'solid' : 'linear';
  kind.addEventListener('change', () => {
    const c = typeof v === 'string' ? v : v.stops[0].color;
    set(path, kind.value === 'solid' ? c : { type: 'linear', angle: 180, stops: [{ at: 0, color: c }, { at: 1, color: '#000000' }] });
    changed(true);
  });
  box.append(label(text, kind));
  if (typeof v === 'string') box.append(colour(path, 'colour'));
  else {
    box.append(input(`${path}.angle`, 'angle°', 'number', 1));
    v.stops.forEach((st, i) => {
      const stop = document.createElement('div');
      stop.className = 'wm-inline';
      stop.append(colour(`${path}.stops.${i}.color`, `stop ${i + 1}`), input(`${path}.stops.${i}.at`, 'at', 'number', 0.01));
      box.append(stop);
    });
    box.append(button('+ stop', () => { v.stops.push({ at: 1, color: v.stops.at(-1).color }); changed(true); }));
    if (v.stops.length > 2) box.append(button('− stop', () => { v.stops.pop(); changed(true); }));
  }
  return box;
}

/** Colour plus alpha, stored as #rrggbb or #rrggbbaa. */
function colour(path, text) {
  const v = get(path);
  const c = document.createElement('input');
  c.type = 'color';
  c.value = v.slice(0, 7);
  const a = document.createElement('input');
  a.type = 'range'; a.min = 0; a.max = 255; a.step = 1;
  a.value = v.length > 7 ? parseInt(v.slice(7), 16) : 255;
  a.title = 'alpha';
  const write = () => { set(path, c.value + (Number(a.value) === 255 ? '' : Number(a.value).toString(16).padStart(2, '0'))); changed(); };
  c.addEventListener('input', write);
  a.addEventListener('input', write);
  const l = label(text, c);
  l.append(a);
  return l;
}

function optional(path, title, rows) {
  const fs = document.createElement('fieldset');
  const on = get(path) !== null && get(path) !== undefined;
  const legend = document.createElement('legend');
  legend.append(check2(path, title, on));
  fs.append(legend);
  if (on) fs.append(...rows());
  $('wmForm').append(fs);
}

function optionalInline(path, text, rows, dflt) {
  const on = get(path) !== null && get(path) !== undefined;
  const box = document.createElement('div');
  box.className = 'wm-inline';
  box.append(check2(path, text, on, dflt));
  if (on) box.append(...rows());
  return box;
}

function check2(path, text, on, dflt) {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.name = `${path}:on`;
  el.checked = on;
  el.addEventListener('change', () => { set(path, el.checked ? structuredClone(dflt ?? DEFAULTS[path] ?? {}) : null); changed(true); });
  return label(text, el);
}

$('wmJson').addEventListener('change', () => {
  try {
    def = JSON.parse($('wmJson').value);
    changed(true);
  } catch (err) { status(`JSON: ${err.message}`, 'bad'); }
});

// --- preview ---------------------------------------------------------------------------

let timer = null, seq = 0;
/** After an edit: preview soon; `rebuild` also redraws the form (its shape changed). */
function changed(rebuild = false) {
  clearTimeout(timer);
  if (rebuild) normaliseThen(render);
  else timer = setTimeout(() => normaliseThen(() => { $('wmJson').value = JSON.stringify(def, null, 2); }), 120);
}

async function normaliseThen(after) {
  const mine = ++seq;
  try {
    const r = await api('/api/watermarks/preview', { method: 'POST', body: def });
    if (mine !== seq) return;
    def = r.definition;
    compiled = r.compiled;
    showSaved();
    syncPick();
    after?.();
    draw();
  } catch (err) {
    if (mine === seq) status(err.message, 'bad');
  }
}

const preview = () => normaliseThen();

const BACKGROUNDS = {
  light: [800, 500, (g, w, h) => { const s = g.createLinearGradient(0, 0, w, h); s.addColorStop(0, '#fbf7ee'); s.addColorStop(1, '#dfe6ee'); return s; }],
  dark: [800, 500, (g, w, h) => { const s = g.createLinearGradient(0, 0, w, h); s.addColorStop(0, '#1d1f2b'); s.addColorStop(1, '#0b0c12'); return s; }],
  small: [160, 100, photo],
  large: [4000, 2600, photo],
};

function photo(g, w, h) {
  const s = g.createLinearGradient(0, 0, w, h);
  s.addColorStop(0, '#1b2a6b'); s.addColorStop(0.5, '#e0668a'); s.addColorStop(1, '#ffc46b');
  return s;
}

document.addEventListener('lab:image', async (e) => {
  try {
    if (!e.detail) throw new Error('no image');
    const bytes = Enc.detectFormat(e.detail) === 'jxl' ? (await Enc.convertAsync(e.detail, { format: 'png' })).bytes : e.detail;
    current = await createImageBitmap(new Blob([bytes]));
  } catch { current = null; }
  if ($('wmBg').value === 'current') draw();
});
$('wmBg').addEventListener('change', draw);
$('wmZoom').addEventListener('change', draw);

function draw() {
  if (!compiled) return;
  const c = $('wmCanvas');
  const g = c.getContext('2d');
  const bg = $('wmBg').value;
  // "current image" before one is loaded (or when it can't be decoded): the light background, said so.
  const fallback = bg === 'current' && !current ? 'no image loaded above, so on the light background · ' : '';
  if (bg === 'current' && current) {
    c.width = current.width; c.height = current.height;
    g.drawImage(current, 0, 0);
  } else {
    const [w, h, fill] = BACKGROUNDS[bg === 'current' ? 'light' : bg];
    c.width = w; c.height = h;
    g.fillStyle = fill(g, w, h);
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,.35)';
    for (let x = 0; x < w; x += Math.max(20, w / 16)) g.fillRect(x, 0, 1, h);
  }
  const t0 = performance.now();
  const patch = Wm.renderWatermark(compiled, c.width, c.height);
  const ms = performance.now() - t0;
  const z = $('wmZoomCanvas');
  if (!patch) {
    $('wmInfo').textContent = `${fallback}hidden on ${c.width}×${c.height}: smaller than fit.minSize`;
    z.width = z.height = 1;
    return;
  }
  const sheet = new OffscreenCanvas(patch.width, patch.height);
  sheet.getContext('2d').putImageData(new ImageData(Wm.patchToRGBA8(patch), patch.width, patch.height), 0, 0);
  g.drawImage(sheet, patch.x, patch.y);
  const place = Wm.placeWatermark(compiled, c.width, c.height);
  // Zoomed crop around the watermark, pixel for pixel.
  const k = Number($('wmZoom').value), pad = 8;
  const sx = Math.max(0, patch.x - pad), sy = Math.max(0, patch.y - pad);
  const sw = Math.min(c.width - sx, patch.width + 2 * pad), sh = Math.min(c.height - sy, patch.height + 2 * pad);
  z.width = sw * k; z.height = sh * k;
  const zg = z.getContext('2d');
  zg.imageSmoothingEnabled = false;
  zg.drawImage(c, sx, sy, sw, sh, 0, 0, sw * k, sh * k);
  $('wmInfo').innerHTML = `${fallback}<b>${c.width}×${c.height}</b> · size <b>${place.em.toFixed(1)} px</b> · ${patch.width}×${patch.height} px at ${patch.x},${patch.y} · rendered in ${ms.toFixed(1)} ms`;
}

refresh().catch((err) => status(err.message, 'bad'));
