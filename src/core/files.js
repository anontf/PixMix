// File writing for the stores on disk (watermarks, metadata profiles). Node only.

import { writeFile, rename, rm, link } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PixmixError } from './params.js';

/**
 * Writes through a temporary file of its own (concurrent saves must not share one), so
 * readers never see half a file. With `create` (what the file is, for the error), an existing
 * file is an EXISTS error (status 409) instead: a hard link fails atomically when the name is
 * taken, so of concurrent creations exactly one succeeds.
 * @param {string} file @param {string} text @param {string|false} [create]
 */
export async function atomicWrite(file, text, create) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, text);
  try {
    if (!create) return await rename(tmp, file);
    await link(tmp, file).catch((err) => {
      if (err?.code === 'EEXIST') throw Object.assign(new PixmixError(`${create} already exists`, 'EXISTS'), { status: 409 });
      throw err;
    });
  } finally {
    await rm(tmp, { force: true });
  }
}
