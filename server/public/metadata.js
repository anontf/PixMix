// The lab's metadata profile editor: edits a profile with a form (or its JSON), shows what it
// does to the current image's metadata (before / after, with the policy's report), and saves
// it to the repository's metadata-profiles/ directory. Every metadata picker on the page
// (select.meta-list) offers the saved profiles.

import * as Enc from '/dist/pixmix-encoder.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const CONVENIENCE = [['artist', 'artist'], ['copyright', 'copyright'], ['title', 'title'], ['description', 'description'], ['software', 'software']];

let presets = [], kinds = [], groups = [];
let list = [];
let profile = null; // the profile being edited, canonical
let savedId = null; // id of the file it was loaded from (null: not saved yet)
let image = null; // the lab's image

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const out = await res.json();
  if (!res.ok) throw Object.assign(new Error(out.error), { status: res.status });
  return out;
}

function status(text, cls = '') {
  $('mdStatus').innerHTML = `<span class="${cls}">${esc(text)}</span>`;
}

// --- list and pickers ---------------------------------------------------------------------

async function refresh(select) {
  ({ profiles: list, presets, kinds, groups } = await api('/api/metadata-profiles'));
  for (const el of document.querySelectorAll('select.meta-list')) {
    const keep = el.value;
    for (const o of [...el.options]) if (o.dataset.md) o.remove();
    for (const p of list) {
      const o = new Option(`${p.name ?? p.id} (${p.id})`, p.id);
      o.dataset.md = '1';
      el.add(o);
    }
    if ([...el.options].some((o) => o.value === keep)) el.value = keep;
  }
  const pick = $('mdPick');
  pick.replaceChildren(...list.map((p) => new Option(`${p.name ?? p.id} (${p.id})`, p.id)));
  if (select) pick.value = select;
  if (!profile && list.length) load(list[0].id);
  else if (!list.length && !profile) newProfile();
  else syncPick();
}

/**
 * The picker names what is being edited: the saved profile, or an extra "not saved" entry
 * for a new one, a copy, or a saved one given another id (Save creates that one).
 */
function syncPick() {
  const pick = $('mdPick');
  pick.querySelector('option[data-unsaved]')?.remove();
  if (!profile) return;
  if (savedId && savedId === profile.id) { pick.value = savedId; return; }
  const o = new Option(`${profile.name ?? profile.id} (${profile.id}) · not saved`, '');
  o.dataset.unsaved = '1';
  pick.add(o, 0);
  pick.value = '';
}

/** "not saved" with what Save will do, or the file it was loaded from. */
function showSaved(edited = false) {
  if (savedId === profile.id) return status(`metadata-profiles/${profile.id}.json${edited ? ' (edited)' : ''}`, edited ? 'bad' : '');
  const taken = list.some((p) => p.id === profile.id);
  status(taken ? `not saved: metadata-profiles/${profile.id}.json already exists (Save asks before replacing it)`
    : savedId ? `not saved: Save creates metadata-profiles/${profile.id}.json (${savedId} stays)` : 'not saved', 'bad');
}

function load(id) {
  const p = list.find((x) => x.id === id);
  if (!p) return;
  profile = structuredClone(p);
  savedId = id;
  syncPick();
  render();
  preview();
}

const refused = (id) => status(`not saved: metadata-profiles/${id}.json already exists (give this one another id)`, 'bad');

function freeId(base) {
  let id = base, n = 2;
  while (list.some((p) => p.id === id)) id = `${base}-${n++}`;
  return id;
}

function newProfile() {
  profile = { id: freeId('new-profile'), name: 'New profile', preset: 'web', set: { copyright: 'Vivi' } };
  savedId = null;
  syncPick();
  render();
  preview();
}

$('mdPick').addEventListener('change', () => load($('mdPick').value));
$('mdNew').addEventListener('click', newProfile);
$('mdCopy').addEventListener('click', () => {
  if (!profile) return;
  profile = { ...structuredClone(profile), id: freeId(`${profile.id}-copy`), name: `${profile.name ?? profile.id} (copy)` };
  savedId = null;
  syncPick();
  render();
  preview();
});
$('mdDelete').addEventListener('click', async () => {
  if (!profile) return;
  if (!savedId) return status(`${profile.id} is not saved yet: there is no file to delete (pick a saved profile to leave it)`, 'bad');
  const what = savedId === profile.id ? `metadata-profiles/${savedId}.json` : `metadata-profiles/${savedId}.json (the file this was loaded from; ${profile.id} is not saved)`;
  if (!confirm(`Delete ${what}?`)) return;
  try {
    const id = savedId;
    await api(`/api/metadata-profiles/${id}`, { method: 'DELETE' });
    profile = null; savedId = null;
    await refresh();
    status(`deleted ${id}`, 'ok');
  } catch (err) { status(err.message, 'bad'); }
});
$('mdSave').addEventListener('click', async () => {
  if (!profile) return;
  const id = profile.id, from = savedId;
  const put = () => api(`/api/metadata-profiles/${encodeURIComponent(id)}`, { method: 'PUT', body: profile });
  try {
    let out;
    if (from === id) out = await put();
    else if (list.some((p) => p.id === id)) {
      // Another profile's id: replace that file only when asked to.
      if (!confirm(`metadata-profiles/${id}.json already exists. Replace it with this one?`)) return refused(id);
      out = await put();
    } else {
      // New, a copy, or a saved one under another id: create only, so that another
      // profile's file is never replaced without asking.
      try {
        out = await api('/api/metadata-profiles', { method: 'POST', body: profile });
      } catch (err) {
        if (err.status !== 409) throw err; // (saved meanwhile, from elsewhere)
        if (!confirm(`metadata-profiles/${id}.json already exists. Replace it with this one?`)) return refused(id);
        out = await put();
      }
    }
    profile = out;
    savedId = profile.id;
    await refresh(profile.id);
    render();
    status(`saved metadata-profiles/${profile.id}.json${from && from !== profile.id ? ` (${from} stays)` : ''}`, 'ok');
  } catch (err) { status(err.message, 'bad'); }
});

// --- the form -------------------------------------------------------------------------
// The form is the profile: every edit rebuilds it from the fields (fromForm), validates it
// with the encoder's own rules, and previews it.

/** "Tag=value" lines: numbers become numbers, [..] JSON lists, the rest text. */
function parseLines(text, where) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf('=');
    if (i < 1) throw new Error(`${where}: "${line}" is not name=value`);
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    out[k] = v === '' ? null : /^\[.*\]$/.test(v) ? JSON.parse(v) : where !== 'text' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return out;
}
const toLines = (obj) => Object.entries(obj ?? {}).map(([k, v]) => `${k}=${v === null ? '' : Array.isArray(v) ? JSON.stringify(v) : v}`).join('\n');

function fromForm() {
  const f = $('mdForm');
  const val = (name) => f.elements[name].value;
  const p = { id: val('id').trim() };
  if (val('name').trim()) p.name = val('name').trim();
  if (val('description').trim()) p.description = val('description').trim();
  if (val('preset') !== 'keep') p.preset = val('preset');
  const keep = kinds.filter((k) => val(`kind.${k}`) === 'keep'), strip = kinds.filter((k) => val(`kind.${k}`) === 'strip');
  if (keep.length) p.keep = keep;
  if (strip.length) p.strip = strip;
  const remove = [...groups.filter((g) => f.elements[`group.${g}`].checked), ...val('patterns').split('\n').map((s) => s.trim()).filter(Boolean)];
  if (remove.length) p.remove = remove;
  const set = {};
  for (const [k] of CONVENIENCE) if (val(`set.${k}`)) set[k] = val(`set.${k}`);
  const comments = val('set.comment').split('\n').filter((s) => s.trim());
  if (comments.length) set.comment = comments.length === 1 ? comments[0] : comments;
  if (val('set.orientation')) set.orientation = Number(val('set.orientation'));
  if (f.elements['set.icc'].checked) set.icc = 'srgb';
  for (const [k, where] of [['exif', 'exif'], ['xmp', 'xmp'], ['text', 'text']]) {
    const m = parseLines(val(`set.${k}`), where);
    if (Object.keys(m).length) set[k] = m;
  }
  if (val('set.xmpPacket').trim()) set.xmpPacket = val('set.xmpPacket');
  if (Object.keys(set).length) p.set = set;
  return p;
}

function render() {
  const f = $('mdForm');
  f.replaceChildren();
  if (!profile) return;
  const p = profile;
  const group = (title, ...els) => {
    const fs = document.createElement('fieldset');
    fs.innerHTML = `<legend>${title}</legend>`;
    fs.append(...els);
    f.append(fs);
    return fs;
  };
  group('Profile', input('id', 'id', p.id), input('name', 'name', p.name ?? ''), input('description', 'description', p.description ?? '', 'textarea'));
  const presetSel = select('preset', 'preset', presets, p.preset ?? 'keep');
  group('Start from', presetSel);
  const grid = document.createElement('div');
  grid.className = 'md-kinds';
  for (const k of kinds) grid.append(select(`kind.${k}`, k, [['', 'as preset'], ['keep', 'keep'], ['strip', 'strip']], p.keep?.includes(k) ? 'keep' : p.strip?.includes(k) ? 'strip' : ''));
  group('Kinds', grid);
  const known = (p.remove ?? []).filter((r) => groups.includes(r));
  group('Remove', ...groups.map((g) => check(`group.${g}`, g, known.includes(g))),
    input('patterns', 'patterns, one per line (exif:Make, exif:GPS/*, xmp:dc:creator, iptc:City, text:Author, other:APP13)', (p.remove ?? []).filter((r) => !groups.includes(r)).join('\n'), 'textarea', 'md-lines'));
  const s = p.set ?? {};
  group('Set', ...CONVENIENCE.map(([k, label]) => input(`set.${k}`, label, s[k] ?? '')),
    input('set.comment', 'comments, one per line', [].concat(s.comment ?? []).join('\n'), 'textarea'),
    select('set.orientation', 'orientation', [['', 'as it is'], ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [String(n), String(n)])], s.orientation ? String(s.orientation) : ''),
    check('set.icc', 'tag as sRGB', s.icc === 'srgb'),
    input('set.exif', 'EXIF tags: Tag=value (empty value removes)', toLines(s.exif), 'textarea', 'md-lines'),
    input('set.xmp', 'XMP properties: prefix:Name=value', toLines(s.xmp), 'textarea', 'md-lines'),
    input('set.text', 'PNG text: Keyword=value', toLines(s.text), 'textarea', 'md-lines'),
    input('set.xmpPacket', 'replace the whole XMP packet', s.xmpPacket ?? '', 'textarea', 'md-lines'));
  $('mdJson').value = JSON.stringify(p, null, 2);
  showSaved();
  syncPick();
}

function label(text, el) {
  const l = document.createElement('label');
  l.append(text, el);
  return l;
}

function input(name, text, value, type = 'text', cls = '') {
  const el = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') el.type = type;
  else el.rows = 2;
  if (cls) el.className = cls;
  el.name = name;
  el.value = value;
  el.addEventListener('input', changed);
  return label(text, el);
}

function select(name, text, options, value) {
  const el = document.createElement('select');
  el.name = name;
  for (const o of options) el.add(Array.isArray(o) ? new Option(o[1], o[0]) : new Option(o, o));
  el.value = value;
  el.addEventListener('change', changed);
  return label(text, el);
}

function check(name, text, on) {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.name = name;
  el.checked = on;
  el.addEventListener('change', changed);
  return label(text, el);
}

let timer = null;
function changed() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      profile = Enc.normalizeProfile(fromForm());
      $('mdJson').value = JSON.stringify(profile, null, 2);
      showSaved(true);
      syncPick();
      preview();
    } catch (err) { status(err.message, 'bad'); }
  }, 150);
}

$('mdJson').addEventListener('change', () => {
  try {
    profile = Enc.normalizeProfile(JSON.parse($('mdJson').value));
    render();
    preview();
  } catch (err) { status(err.message, 'bad'); }
});

// --- before / after -----------------------------------------------------------------------

document.addEventListener('lab:image', (e) => { image = e.detail; preview(); });

const show = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : v && typeof v === 'object' ? (v.bytes !== undefined && Object.keys(v).length === 1 ? `(${v.bytes} bytes)` : JSON.stringify(v)) : String(v));

/** Parsed metadata as [label, value] rows, for comparing. */
function rows(m) {
  const out = [];
  const seen = new Map();
  const add = (k, v) => { const n = (seen.get(k) ?? 0) + 1; seen.set(k, n); out.push([n > 1 ? `${k} #${n}` : k, show(v)]); };
  if (m.exif?.error) add('EXIF', m.exif.error);
  for (const t of m.exif?.tags ?? []) add(`EXIF ${t.ifd}:${t.name}`, t.value);
  if (m.xmp?.error) add('XMP', m.xmp.error);
  for (const p of m.xmp?.properties ?? []) add(`XMP ${p.name}`, p.value);
  if (m.xmp?.extended) add('XMP extended', `${m.xmp.extended} segments`);
  if (m.icc) add('ICC', m.icc.source === 'codestream' ? `in the codestream (${m.icc.srgb ? 'sRGB' : 'not sRGB'})` : m.icc.error ?? `"${m.icc.description ?? 'unnamed'}" ${m.icc.colourSpace}${m.icc.srgb ? ' (sRGB)' : ''}, ${m.icc.bytes} bytes`);
  for (const c of m.colour) add(`colour ${c.type}`, c.value);
  if (m.density) add('density', `${m.density.x}×${m.density.y} per ${m.density.unit}`);
  for (const t of m.text) add(`text ${t.keyword}`, t.text);
  for (const d of m.iptc ?? []) add(`IPTC ${d.name}`, d.value);
  for (const o of m.other) add(`other ${o.label ?? o.type}`, o.value ?? `${o.bytes} bytes`);
  return out;
}

let seq = 0;
async function preview() {
  if (!profile) return;
  const mine = ++seq;
  if (!image) {
    $('mdDiff').replaceChildren();
    $('mdReport').textContent = 'Load an image above to see what the profile does to its metadata.';
    return;
  }
  const decoders = [Enc.browserDecoder()];
  try {
    // What encoding does: the input as it will be scrambled, without and with the policy.
    const [before, after] = await Promise.all([Enc.convertAsync(image, { decoders }), Enc.convertAsync(image, { decoders, metadata: profile })]);
    if (mine !== seq) return;
    const a = rows(Enc.readMetadata(before.bytes)), b = new Map(rows(Enc.readMetadata(after.bytes)));
    const keys = [...a.map(([k]) => k), ...[...b.keys()].filter((k) => !a.some(([x]) => x === k))];
    const was = new Map(a);
    const tr = keys.map((k) => {
      const cls = !b.has(k) ? 'gone' : !was.has(k) ? 'new' : was.get(k) !== b.get(k) ? 'changed' : '';
      return `<tr class="${cls}"><td>${esc(k)}</td><td>${esc(was.get(k) ?? '')}</td><td>${esc(b.get(k) ?? '')}</td></tr>`;
    });
    $('mdDiff').innerHTML = `<table><tr><th></th><th>before</th><th>after (${esc(profile.id)})</th></tr>${tr.join('') || '<tr><td colspan="3">no metadata</td></tr>'}</table>`;
    const r = after.metadata;
    $('mdReport').innerHTML = `<b>${after.format.toUpperCase()}</b> · removed: ${esc(r.removed.join(', ') || 'nothing')} · set: ${esc(r.set.join(', ') || 'nothing')}`
      + (r.notes.length ? ` · <span class="bad">${esc(r.notes.join('; '))}</span>` : '');
  } catch (err) {
    if (mine === seq) $('mdReport').innerHTML = `<span class="bad">${esc(err.message)}</span>`;
  }
}

refresh().catch((err) => status(err.message, 'bad'));
