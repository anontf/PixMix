#!/usr/bin/env node
// npm run fuzz: the long fuzz run. Settings come from the environment:
//   PIXMIX_FUZZ_ITERATIONS  cases to run (default 20000)
//   PIXMIX_FUZZ_SEED        run seed (default 1); a case is reproducible from seed + index
//   PIXMIX_FUZZ_WORKERS     worker threads (default: half the CPUs, at most 8)
//   PIXMIX_FUZZ_TIMEOUT     budget per case in ms (default 20000)
//   PIXMIX_FUZZ_OUT         directory to write failing inputs to (as <seed>-<index>.bin)
//   PIXMIX_FUZZ_SRC         another copy of pixmix's src/ to fuzz instead of this one
//   PIXMIX_FUZZ_CASE        run just this case index in-process and print what happens
// Exit code 1 when anything failed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFuzz, signature } from './harness.js';
import { buildFixtures, KEY } from './fixtures.js';
import { loadTarget, makeCase, runCase } from './cases.js';

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : Number(process.env[k]));
const seed = env('PIXMIX_FUZZ_SEED', 1);
const srcUrl = process.env.PIXMIX_FUZZ_SRC ? pathToFileURL(`${resolve(process.env.PIXMIX_FUZZ_SRC)}/`).href : undefined;

if (process.env.PIXMIX_FUZZ_CASE !== undefined) {
  const index = Number(process.env.PIXMIX_FUZZ_CASE);
  const fixtures = await buildFixtures();
  const c = makeCase(fixtures, seed, index);
  console.log(`case ${seed}:${index}: ${c.fixture.name}, ${c.bytes.length} bytes, ${c.log.join(' > ')}`);
  if (process.env.PIXMIX_FUZZ_OUT) writeOut(`${seed}-${index}`, c.bytes);
  const t0 = Date.now();
  const failures = await runCase(await loadTarget(srcUrl ?? new URL('../../src/', import.meta.url).href), c, {
    key: KEY, onOp: (op) => console.log(`  ${op} (${Date.now() - t0} ms)`),
  });
  for (const f of failures) console.log(`\n${f.op}: ${f.stack || `${f.name}: ${f.message}`}`);
  console.log(failures.length ? `\n${failures.length} failure(s)` : '\nno failures');
  process.exit(failures.length ? 1 : 0);
}

const iterations = env('PIXMIX_FUZZ_ITERATIONS', 20000);
const opts = { seed, iterations, workers: env('PIXMIX_FUZZ_WORKERS', undefined), timeoutMs: env('PIXMIX_FUZZ_TIMEOUT', 20000), srcUrl };
console.log(`fuzzing ${iterations} cases, seed ${seed}${srcUrl ? `, src ${process.env.PIXMIX_FUZZ_SRC}` : ''}`);
let last = 0;
const { cases, failures, fixtures, ms } = await runFuzz({
  ...opts,
  onProgress: (done) => {
    if (process.stdout.isTTY) process.stdout.write(`\r${done}/${iterations}`);
    else if (done - last >= 1000 || done === iterations) { last = done; console.log(`${done}/${iterations}`); }
  },
  onFailure: (f) => {
    if (process.env.PIXMIX_FUZZ_OUT && f.bytes) writeOut(`${seed}-${f.index}`, f.bytes);
  },
});
if (process.stdout.isTTY) process.stdout.write('\n');

const groups = new Map();
for (const f of failures) {
  const k = signature(f);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(f);
}
console.log(`${cases} cases over ${fixtures.length} seed files in ${(ms / 1000).toFixed(1)} s: ${failures.length} failures, ${groups.size} distinct`);
for (const [k, list] of groups) {
  const f = list[0];
  console.log(`\n[${list.length}x] ${k}`);
  console.log(`  e.g. PIXMIX_FUZZ_SEED=${seed} PIXMIX_FUZZ_CASE=${f.index}  (${f.fixture}: ${(f.log ?? []).join(' > ')})`);
  if (f.stack) console.log(f.stack.split('\n').slice(0, 6).map((l) => `  ${l}`).join('\n'));
}
process.exit(failures.length ? 1 : 0);

function writeOut(name, bytes) {
  mkdirSync(process.env.PIXMIX_FUZZ_OUT, { recursive: true });
  writeFileSync(`${process.env.PIXMIX_FUZZ_OUT}/${name}.bin`, bytes);
}
