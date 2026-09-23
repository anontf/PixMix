// Recompiles every definition in watermarks/ (after editing one by hand, or after changing
// the compiler): writes watermarks/compiled/<id>.json and .svg. With --check it only reports
// compiled files that are out of date, and exits 1 if there are any.
//
//   npm run watermarks            node scripts/watermarks.js --check

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { watermarkStore } from '../src/watermark/store.js';
import { formatJson } from '../src/watermark/schema.js';

const check = process.argv.includes('--check');
const store = watermarkStore();
let stale = 0;
for (const def of await store.list()) {
  const want = formatJson(store.compile(def));
  const have = await readFile(join(store.dir, 'compiled', `${def.id}.json`), 'utf8').catch(() => null);
  if (check) {
    if (want !== have) { stale++; console.log(`out of date: ${def.id}`); }
    continue;
  }
  await store.save(def);
  console.log(`${want === have ? 'unchanged' : 'compiled '} ${def.id}`);
}
process.exitCode = stale ? 1 : 0;
