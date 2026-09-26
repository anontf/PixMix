// XMP packets: a small XML parser (no DTDs, no entities beyond the five predefined ones,
// bounded depth), enough of RDF to list, remove and set top-level properties, and a
// serialiser that writes everything else back as it was.
//
// Properties are identified by namespace URI and local name, so a packet that binds the
// Dublin Core namespace to an unusual prefix still matches "dc:creator". Values: simple
// text, rdf:resource URIs, arrays (rdf:Seq / Bag / Alt, whose items are listed) and structs
// (summarised by their fields).

import { PixmixError } from '../core/params.js';

const MAX_DEPTH = 64;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Well-known namespaces, by the prefix pixmix uses for them (in policies and reports). */
export const NAMESPACES = {
  x: 'adobe:ns:meta/',
  rdf: RDF,
  dc: 'http://purl.org/dc/elements/1.1/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  xmpRights: 'http://ns.adobe.com/xap/1.0/rights/',
  xmpMM: 'http://ns.adobe.com/xap/1.0/mm/',
  stEvt: 'http://ns.adobe.com/xap/1.0/sType/ResourceEvent#',
  stRef: 'http://ns.adobe.com/xap/1.0/sType/ResourceRef#',
  xmpNote: 'http://ns.adobe.com/xmp/note/',
  photoshop: 'http://ns.adobe.com/photoshop/1.0/',
  tiff: 'http://ns.adobe.com/tiff/1.0/',
  exif: 'http://ns.adobe.com/exif/1.0/',
  exifEX: 'http://cipa.jp/exif/1.0/',
  aux: 'http://ns.adobe.com/exif/1.0/aux/',
  crs: 'http://ns.adobe.com/camera-raw-settings/1.0/',
  Iptc4xmpCore: 'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/',
  Iptc4xmpExt: 'http://iptc.org/std/Iptc4xmpExt/2008-02-29/',
  plus: 'http://ns.useplus.org/ldf/xmp/1.0/',
  xmpDM: 'http://ns.adobe.com/xmp/1.0/DynamicMedia/',
  pdf: 'http://ns.adobe.com/pdf/1.3/',
  GPano: 'http://ns.google.com/photos/1.0/panorama/',
  lr: 'http://ns.adobe.com/lightroom/1.0/',
};
const PREFIX_OF = new Map(Object.entries(NAMESPACES).map(([p, u]) => [u, p]));

// How known properties hold their value; anything else is simple text.
const ARRAYS = {
  'dc:creator': 'Seq', 'dc:contributor': 'Bag', 'dc:publisher': 'Bag', 'dc:subject': 'Bag', 'dc:date': 'Seq',
  'dc:rights': 'Alt', 'dc:title': 'Alt', 'dc:description': 'Alt', 'xmpRights:UsageTerms': 'Alt',
  'photoshop:SupplementalCategories': 'Bag', 'xmp:Identifier': 'Bag',
};

export class XmpError extends PixmixError {
  constructor(message) { super(`Unreadable XMP: ${message}`, 'BAD_XMP'); }
}

// --- XML ------------------------------------------------------------------------------

/**
 * @typedef {{t: 'el', name: string, attrs: [string, string][], children: Node[], empty?: boolean}
 *   | {t: 'text', v: string} | {t: 'raw', v: string}} Node
 *   raw: comments, processing instructions and CDATA, written back as they came
 */

const NAME = /^[A-Za-z_:][\w.:\-·À-￿]*/;
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]+);?/g, (m, e) => {
    if (!m.endsWith(';')) throw new XmpError('bare "&"');
    if (e[0] !== '#') {
      if (!(e in ENTITIES)) throw new XmpError(`unknown entity &${e};`);
      return ENTITIES[e];
    }
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) throw new XmpError('bad character reference');
    return String.fromCodePoint(cp);
  });
}

/** @param {string} src @returns {Node[]} the top-level nodes */
export function parseXml(src) {
  const root = { t: 'el', name: '', attrs: [], children: [] };
  const stack = [root];
  let pos = 0;
  const top = () => stack[stack.length - 1];
  while (pos < src.length) {
    const lt = src.indexOf('<', pos);
    if (lt < 0 || lt > pos) {
      const end = lt < 0 ? src.length : lt;
      top().children.push({ t: 'text', v: decodeEntities(src.slice(pos, end)) });
      pos = end;
      continue;
    }
    if (src.startsWith('<!--', pos)) {
      const end = src.indexOf('-->', pos + 4);
      if (end < 0) throw new XmpError('unterminated comment');
      top().children.push({ t: 'raw', v: src.slice(pos, end + 3) });
      pos = end + 3;
    } else if (src.startsWith('<![CDATA[', pos)) {
      const end = src.indexOf(']]>', pos);
      if (end < 0) throw new XmpError('unterminated CDATA');
      top().children.push({ t: 'text', v: src.slice(pos + 9, end), cdata: true });
      pos = end + 3;
    } else if (src.startsWith('<?', pos)) {
      const end = src.indexOf('?>', pos);
      if (end < 0) throw new XmpError('unterminated processing instruction');
      top().children.push({ t: 'raw', v: src.slice(pos, end + 2) });
      pos = end + 2;
    } else if (src.startsWith('<!', pos)) {
      throw new XmpError('DTDs are not supported');
    } else if (src[pos + 1] === '/') {
      const m = NAME.exec(src.slice(pos + 2, pos + 2 + 1024));
      const close = m && src.indexOf('>', pos + 2 + m[0].length);
      if (!m || close < 0 || src.slice(pos + 2 + m[0].length, close).trim()) throw new XmpError('bad end tag');
      if (stack.length < 2 || top().name !== m[0]) throw new XmpError(`mismatched </${m[0]}>`);
      stack.pop();
      pos = close + 1;
    } else {
      const m = NAME.exec(src.slice(pos + 1, pos + 1 + 1024));
      if (!m) throw new XmpError('bad start tag');
      // Attribute layout (whitespace, quotes) is kept so untouched parts read back as they were.
      const el = { t: 'el', name: m[0], attrs: [], children: [], layout: [] };
      let p = pos + 1 + m[0].length;
      for (;;) {
        const ws = /^\s*/.exec(src.slice(p, p + 4096))[0];
        p += ws.length;
        if (src.startsWith('/>', p)) { el.empty = true; el.tail = ws; p += 2; break; }
        if (src[p] === '>') { el.tail = ws; p++; break; }
        if (!ws) throw new XmpError(`bad attribute in <${el.name}>`);
        const a = NAME.exec(src.slice(p, p + 1024));
        if (!a) throw new XmpError(`bad attribute in <${el.name}>`);
        p += a[0].length;
        const eq = /^\s*=\s*(["'])/.exec(src.slice(p, p + 4096));
        if (!eq) throw new XmpError(`attribute without a value in <${el.name}>`);
        p += eq[0].length;
        const end = src.indexOf(eq[1], p);
        if (end < 0) throw new XmpError('unterminated attribute value');
        const raw = src.slice(p, end);
        if (raw.includes('<')) throw new XmpError('"<" in an attribute value');
        if (el.attrs.some(([n]) => n === a[0])) throw new XmpError(`duplicate attribute ${a[0]}`);
        el.attrs.push([a[0], decodeEntities(raw.replace(/[\t\n\r]/g, ' '))]);
        el.layout.push({ ws, eq: eq[0].slice(0, -1), quote: eq[1], name: a[0], value: el.attrs.at(-1)[1] });
        p = end + 1;
      }
      top().children.push(el);
      if (!el.empty) {
        if (stack.length > MAX_DEPTH) throw new XmpError('nested too deeply');
        stack.push(el);
      }
      pos = p;
    }
  }
  if (stack.length > 1) throw new XmpError(`<${top().name}> is not closed`);
  return root.children;
}

const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s, q = '"') => escText(s).replace(q === '"' ? /"/g : /'/g, q === '"' ? '&quot;' : '&apos;')
  .replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');

/** An attribute as it was written, when it has not changed; else in plain form. */
function attr(n, k, v) {
  const l = n.layout?.find((x) => x.name === k && x.value === v);
  return l ? `${l.ws}${k}${l.eq}${l.quote}${escAttr(v, l.quote)}${l.quote}` : ` ${k}="${escAttr(v)}"`;
}

/** @param {Node[]} nodes @returns {string} */
export function serializeXml(nodes) {
  let out = '';
  const write = (n) => {
    if (n.t === 'text') out += n.cdata ? `<![CDATA[${n.v}]]>` : escText(n.v);
    else if (n.t === 'raw') out += n.v;
    else {
      out += `<${n.name}${n.attrs.map(([k, v]) => attr(n, k, v)).join('')}${n.tail ?? ''}`;
      if (!n.children.length && n.empty) { out += '/>'; return; }
      out += '>';
      for (const c of n.children) write(c);
      out += `</${n.name}>`;
    }
  };
  for (const n of nodes) write(n);
  return out;
}

// --- RDF --------------------------------------------------------------------------------

/** Namespace scope of an element: its xmlns attributes over its parent's. */
function scopeOf(el, parent) {
  let scope = parent;
  for (const [k, v] of el.attrs) {
    if (k === 'xmlns' || k.startsWith('xmlns:')) {
      if (scope === parent) scope = new Map(parent);
      scope.set(k === 'xmlns' ? '' : k.slice(6), v);
    }
  }
  return scope;
}

function resolve(name, scope, isAttr = false) {
  const i = name.indexOf(':');
  const prefix = i < 0 ? '' : name.slice(0, i);
  if (prefix === 'xml') return { uri: XML_NS, local: name.slice(4) };
  if (i < 0 && isAttr) return { uri: '', local: name };
  return { uri: scope.get(prefix) ?? '', local: i < 0 ? name : name.slice(i + 1) };
}

/** The canonical name of a property: pixmix's prefix for known namespaces, else the file's. */
const qname = (uri, local, fallback) => `${PREFIX_OF.get(uri) ?? fallback}:${local}`;

/**
 * An XMP packet, parsed: `descriptions` are the rdf:Description elements holding the
 * properties, each with its namespace scope.
 */
export class XmpPacket {
  /** @param {string} text */
  constructor(text) {
    this.nodes = parseXml(text);
    this.descriptions = [];
    const walk = (nodes, scope, depth) => {
      for (const n of nodes) {
        if (n.t !== 'el') continue;
        const s = scopeOf(n, scope);
        const { uri, local } = resolve(n.name, s);
        if (uri === RDF && local === 'RDF') {
          for (const d of n.children) {
            if (d.t !== 'el') continue;
            const ds = scopeOf(d, s);
            const r = resolve(d.name, ds);
            if (r.uri === RDF && r.local === 'Description') this.descriptions.push({ el: d, scope: ds, rdf: n, rdfScope: s });
          }
        } else if (depth < 4) walk(n.children, s, depth + 1);
      }
    };
    walk(this.nodes, new Map(), 0);
    if (!this.descriptions.length && !this.rdfNode()) throw new XmpError('no rdf:RDF element');
  }

  rdfNode() {
    const find = (nodes, scope) => {
      for (const n of nodes) {
        if (n.t !== 'el') continue;
        const s = scopeOf(n, scope);
        const r = resolve(n.name, s);
        if (r.uri === RDF && r.local === 'RDF') return { el: n, scope: s };
        const deeper = find(n.children, s);
        if (deeper) return deeper;
      }
      return null;
    };
    return find(this.nodes, new Map());
  }

  /**
   * Every top-level property: attributes of rdf:Description and its child elements.
   * @returns {{name: string, uri: string, local: string, value: string|string[]|object}[]}
   */
  properties() {
    const out = [];
    for (const { el, scope } of this.descriptions) {
      for (const [k, v] of el.attrs) {
        if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
        const r = resolve(k, scope, true);
        if (r.uri === RDF || r.uri === XML_NS || !r.uri) continue;
        out.push({ name: qname(r.uri, r.local, k.split(':')[0]), uri: r.uri, local: r.local, value: v });
      }
      for (const c of el.children) {
        if (c.t !== 'el') continue;
        const cs = scopeOf(c, scope);
        const r = resolve(c.name, cs);
        out.push({ name: qname(r.uri, r.local, c.name.split(':')[0]), uri: r.uri, local: r.local, value: valueOf(c, cs, 0) });
      }
    }
    return out;
  }

  /**
   * Removes the properties `match(name)` accepts. @returns {string[]} the names removed
   * @param {(name: string) => boolean} match
   */
  remove(match) {
    const removed = [];
    for (const { el, scope } of this.descriptions) {
      el.attrs = el.attrs.filter(([k]) => {
        if (k === 'xmlns' || k.startsWith('xmlns:')) return true;
        const r = resolve(k, scope, true);
        if (r.uri === RDF || r.uri === XML_NS || !r.uri) return true;
        const name = qname(r.uri, r.local, k.split(':')[0]);
        if (!match(name)) return true;
        removed.push(name);
        return false;
      });
      const kept = [];
      for (let i = 0; i < el.children.length; i++) {
        const c = el.children[i];
        if (c.t === 'el') {
          const r = resolve(c.name, scopeOf(c, scope));
          const name = qname(r.uri, r.local, c.name.split(':')[0]);
          if (match(name)) {
            removed.push(name);
            if (kept.at(-1)?.t === 'text' && !kept.at(-1).v.trim()) kept.pop(); // its indentation
            continue;
          }
        }
        kept.push(c);
      }
      el.children = kept;
    }
    return removed;
  }

  /**
   * Sets a property (replacing it wherever it is). `name` is "prefix:Local" with a prefix
   * from NAMESPACES; arrays get rdf:Seq / Bag / Alt as the property needs.
   * @param {string} name @param {string|string[]} value
   */
  set(name, value) {
    const [prefix, local] = name.split(':');
    const uri = NAMESPACES[prefix];
    this.remove((n) => n === name);
    if (!this.descriptions.length) this.addDescription();
    const d = this.descriptions[0];
    const p = this.bind(d, prefix, uri);
    const rdf = [...d.scope].find(([k, u]) => k && u === RDF)?.[0] ?? 'rdf';
    const kind = ARRAYS[name];
    const values = Array.isArray(value) ? value : [value];
    const el = { t: 'el', name: `${p}:${local}`, attrs: [], children: [] };
    if (!kind) el.children.push({ t: 'text', v: values.join(', ') });
    else {
      const arr = { t: 'el', name: `${rdf}:${kind}`, attrs: [], children: [] };
      for (const v of values) arr.children.push({ t: 'el', name: `${rdf}:li`, attrs: kind === 'Alt' ? [['xml:lang', 'x-default']] : [], children: [{ t: 'text', v }] });
      el.children.push(arr);
    }
    // Indent like the other properties (or one space deeper than the Description).
    const ws = (n) => n?.t === 'text' && !n.v.trim() && n.v.includes('\n');
    const outer = d.rdf.children[d.rdf.children.indexOf(d.el) - 1];
    const closing = ws(outer) ? outer.v : '\n';
    const indent = d.el.children.find(ws)?.v ?? `${closing} `;
    const last = d.el.children.at(-1);
    if (ws(last)) d.el.children.splice(d.el.children.length - 1, 0, { t: 'text', v: indent }, el);
    else d.el.children.push({ t: 'text', v: indent }, el, { t: 'text', v: closing });
    d.el.empty = false;
  }

  /** The prefix `uri` has in the Description's scope, declaring it there if needed. */
  bind(d, prefix, uri) {
    for (const [p, u] of d.scope) if (u === uri && p) return p;
    let p = prefix;
    for (let n = 1; d.scope.has(p); n++) p = `${prefix}${n}`;
    d.el.attrs.push([`xmlns:${p}`, uri]);
    d.scope = new Map(d.scope).set(p, uri);
    return p;
  }

  addDescription() {
    const rdf = this.rdfNode();
    const rdfPrefix = [...rdf.scope].find(([k, u]) => k && u === RDF)?.[0] ?? 'rdf';
    const el = { t: 'el', name: `${rdfPrefix}:Description`, attrs: [[`${rdfPrefix}:about`, '']], children: [] };
    rdf.el.children.push({ t: 'text', v: '\n  ' }, el, { t: 'text', v: '\n ' });
    rdf.el.empty = false;
    this.descriptions.push({ el, scope: rdf.scope, rdf: rdf.el, rdfScope: rdf.scope });
  }

  get empty() {
    return !this.properties().length;
  }

  toString() {
    return serializeXml(this.nodes);
  }
}

function valueOf(el, scope, depth) {
  const res = el.attrs.find(([k]) => { const r = resolve(k, scope, true); return r.uri === RDF && r.local === 'resource'; });
  if (res) return res[1];
  const kids = el.children.filter((c) => c.t === 'el');
  if (!kids.length) {
    // Qualifier-style struct as attributes, or plain text.
    const fields = el.attrs.filter(([k]) => !k.startsWith('xmlns') && !k.startsWith('rdf:') && !k.startsWith('xml:'));
    if (fields.length) return Object.fromEntries(fields);
    return el.children.map((c) => c.v ?? '').join('').trim();
  }
  if (depth > 4) return '…';
  const first = kids[0];
  const r = resolve(first.name, scopeOf(first, scope));
  if (r.uri === RDF && ['Seq', 'Bag', 'Alt'].includes(r.local)) {
    const s = scopeOf(first, scope);
    return first.children.filter((c) => c.t === 'el').map((li) => {
      const v = valueOf(li, scopeOf(li, s), depth + 1);
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  // A struct: rdf:parseType="Resource" fields, or a nested rdf:Description.
  const fieldsOf = (node, s) => {
    const o = {};
    for (const c of node.children) {
      if (c.t !== 'el') continue;
      const cs = scopeOf(c, s);
      const cr = resolve(c.name, cs);
      if (cr.uri === RDF && cr.local === 'Description') Object.assign(o, fieldsOf(c, cs));
      else o[qname(cr.uri, cr.local, c.name.split(':')[0])] = valueOf(c, cs, depth + 1);
    }
    return o;
  };
  return fieldsOf(el, scope);
}

/** An empty packet with the standard wrapper, for when a policy sets XMP on a file without. */
export function emptyPacket() {
  return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
    + '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
    + ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
    + '  <rdf:Description rdf:about=""/>\n'
    + ' </rdf:RDF>\n'
    + '</x:xmpmeta>\n'
    + '<?xpacket end="w"?>';
}

/** Whether `name` is "prefix:Local" with a prefix pixmix knows. */
export const knownProperty = (name) => {
  const m = /^([A-Za-z][\w-]*):([A-Za-z_][\w.-]*)$/.exec(name);
  return !!m && m[1] in NAMESPACES && m[1] !== 'x' && m[1] !== 'rdf';
};
