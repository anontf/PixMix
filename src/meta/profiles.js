// Metadata profiles on disk (Node only): metadata-profiles/<id>.json, one saved policy per
// file in canonical form (see normalizeProfile), so the directory can be committed and its
// diffs stay clean. Ids are checked against a strict pattern before they become paths.

import { readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PixmixError } from '../core/params.js';
import { atomicWrite } from '../core/files.js';
import { normalizeProfile, formatProfile, PROFILE_ID, PRESET_NAMES } from './policy.js';

/** The repository's metadata-profiles/ directory (or $PIXMIX_METADATA_PROFILES_DIR). */
export const DEFAULT_PROFILES_DIR = process.env.PIXMIX_METADATA_PROFILES_DIR || fileURLToPath(new URL('../../metadata-profiles/', import.meta.url));

const notFound = (id) => Object.assign(new PixmixError(`Metadata profile "${id}" not found`, 'NOT_FOUND'), { status: 404 });

function checkId(id) {
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new PixmixError(`Invalid metadata profile id "${id}"`, 'BAD_METADATA');
  return id;
}

/** @param {string} [dir] */
export function metadataProfileStore(dir = DEFAULT_PROFILES_DIR) {
  const root = resolve(dir);
  const file = (id) => join(root, `${checkId(id)}.json`);
  return {
    dir: root,

    /** Profiles, sorted by id (files that do not validate are skipped; get() says why). */
    async list() {
      const names = await readdir(root).catch(() => []);
      const ids = names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => PROFILE_ID.test(id)).sort();
      const all = [];
      for (const id of ids) {
        try { all.push(await this.get(id)); } catch { /* skipped */ }
      }
      return all;
    },

    async get(id) {
      const text = await readFile(file(id), 'utf8').catch(() => { throw notFound(id); });
      let obj;
      try { obj = JSON.parse(text); } catch { throw new PixmixError(`Metadata profile "${id}" is not valid JSON`, 'BAD_METADATA'); }
      const profile = normalizeProfile(obj);
      if (profile.id !== id) throw new PixmixError(`Metadata profile file ${id}.json holds id "${profile.id}"`, 'BAD_METADATA');
      return profile;
    },

    /**
     * Validates and writes a profile (atomically). `create`: only if there is none with that
     * id yet (else EXISTS, status 409). @returns the canonical profile
     */
    async save(profile, { create = false } = {}) {
      const normal = normalizeProfile(profile);
      await mkdir(root, { recursive: true });
      await atomicWrite(file(normal.id), formatProfile(normal), create && `Metadata profile "${normal.id}"`);
      return normal;
    },

    async remove(id) {
      if (!existsSync(file(id))) throw notFound(id);
      await rm(file(id));
    },

    async exists(id) { return existsSync(file(id)); },
  };
}

/**
 * A policy from a command-line style reference: a path to a JSON file (a profile or a bare
 * policy), a preset name, or a profile id in the store.
 * @returns {Promise<object|string>}
 */
export async function loadMetadataPolicy(ref, { dir } = {}) {
  if (/[/\\]|\.json$/.test(ref)) {
    let obj;
    try { obj = JSON.parse(await readFile(ref, 'utf8')); } catch (err) { throw new PixmixError(`${ref}: ${err.code === 'ENOENT' ? 'no such file' : 'not valid JSON'}`, 'BAD_METADATA'); }
    return obj;
  }
  if (PRESET_NAMES.includes(ref)) return ref;
  return metadataProfileStore(dir).get(ref);
}
