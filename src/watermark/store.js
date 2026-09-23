// Watermarks on disk (Node only), laid out so the directory can be committed:
//
//   watermarks/<id>.json            the definition (hand-editable, stable formatting)
//   watermarks/compiled/<id>.json   the compiled watermark decoders fetch (glyph outlines)
//   watermarks/compiled/<id>.svg    a preview of it, for people and code review
//   watermarks/fonts/<name>.ttf     fonts (with their licences), by name
//   watermarks/assets/<name>.png    logos for image ornaments
//
// Every name that becomes a path is checked against a strict pattern first, so nothing can
// point outside the directory.

import { readFile, writeFile, readdir, rename, rm, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDefinition, formatDefinition, formatJson, validateCompiled, ID_PATTERN, FONT_PATTERN, ASSET_PATTERN, FORMAT } from './schema.js';
import { compileWatermark, watermarkToSvg } from './compile.js';
import { PixmixError } from '../core/params.js';

/** The repository's watermarks/ directory (or $PIXMIX_WATERMARKS_DIR). */
export const DEFAULT_DIR = process.env.PIXMIX_WATERMARKS_DIR || fileURLToPath(new URL('../../watermarks/', import.meta.url));

const FONT_EXT = ['.ttf', '.otf'];
const notFound = (what) => Object.assign(new PixmixError(`${what} not found`, 'NOT_FOUND'), { status: 404 });

function checkId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new PixmixError(`Invalid watermark id "${id}"`, 'BAD_WATERMARK');
  return id;
}

/** @param {string} [dir] */
export function watermarkStore(dir = DEFAULT_DIR) {
  const root = resolve(dir);
  const def = (id) => join(root, `${checkId(id)}.json`);
  const out = (id, ext) => join(root, 'compiled', `${checkId(id)}.${ext}`);

  const font = (name) => {
    if (!FONT_PATTERN.test(name)) return null;
    for (const ext of FONT_EXT) {
      const f = join(root, 'fonts', name + ext);
      if (existsSync(f)) return new Uint8Array(readFileSync(f));
    }
    return null;
  };
  const asset = (name) => {
    if (!ASSET_PATTERN.test(name)) return null;
    const f = join(root, 'assets', name);
    return existsSync(f) ? new Uint8Array(readFileSync(f)) : null;
  };
  const compile = (definition) => compileWatermark(definition, { font, asset });

  return {
    dir: root,
    compile,

    /** Definitions, sorted by id. */
    async list() {
      const names = await readdir(root).catch(() => []);
      const ids = names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => ID_PATTERN.test(id)).sort();
      const all = [];
      for (const id of ids) {
        try {
          all.push(normalizeDefinition(JSON.parse(await readFile(def(id), 'utf8'))));
        } catch { /* an invalid file is skipped here; get() reports why */ }
      }
      return all;
    },

    async get(id) {
      const text = await readFile(def(id), 'utf8').catch(() => { throw notFound(`Watermark "${id}"`); });
      return normalizeDefinition(JSON.parse(text));
    },

    /** The compiled watermark, as saved (compiled again if that file is missing). */
    async compiled(id) {
      const text = await readFile(out(id, 'json'), 'utf8').catch(() => null);
      return text ? validateCompiled(JSON.parse(text)) : compile(await this.get(id));
    },

    /** Validates, compiles and writes the definition, the compiled file and its preview. */
    async save(definition) {
      const normal = normalizeDefinition(definition);
      const compiled = compile(normal);
      await mkdir(join(root, 'compiled'), { recursive: true });
      await atomic(def(normal.id), formatDefinition(normal));
      await atomic(out(normal.id, 'json'), formatJson(compiled));
      await atomic(out(normal.id, 'svg'), watermarkToSvg(compiled));
      return { definition: normal, compiled };
    },

    async remove(id) {
      if (!existsSync(def(id))) throw notFound(`Watermark "${id}"`);
      await rm(def(id));
      await rm(out(id, 'json'), { force: true });
      await rm(out(id, 'svg'), { force: true });
    },

    async exists(id) { return existsSync(def(id)); },

    /** Font names (file stems) in fonts/. */
    async fonts() {
      const names = await readdir(join(root, 'fonts')).catch(() => []);
      return names.filter((n) => FONT_EXT.some((e) => n.endsWith(e))).map((n) => n.replace(/\.[^.]+$/, '')).filter((n) => FONT_PATTERN.test(n)).sort();
    },

    async assets() {
      const names = await readdir(join(root, 'assets')).catch(() => []);
      return names.filter((n) => ASSET_PATTERN.test(n)).sort();
    },
  };
}

async function atomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/**
 * A watermark from a command-line style reference: a path to a JSON file (a definition,
 * compiled with the fonts of the store, or an already compiled watermark), or an id in the
 * store.
 */
export async function loadWatermark(ref, { dir } = {}) {
  const store = watermarkStore(dir);
  if (/[/\\]|\.json$/.test(ref)) {
    const obj = JSON.parse(await readFile(ref, 'utf8'));
    return obj?.format === FORMAT ? validateCompiled(obj) : store.compile(obj);
  }
  return store.compiled(ref);
}
