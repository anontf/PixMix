// Smoke run of the fuzzer (test/fuzz): a fixed seed and a few hundred cases, so every
// `npm test` sends mutated files of every format through every entry point. The long run
// is `npm run fuzz`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFuzz, signature } from './fuzz/harness.js';

test('fuzz smoke run: mutated inputs only ever succeed or throw a PixmixError', async () => {
  const { cases, failures } = await runFuzz({ seed: 20260923, iterations: 300, workers: 2, timeoutMs: 20000 });
  assert.equal(cases, 300);
  const report = failures.map((f) => `${signature(f)}\n  case ${f.index} (${f.fixture}: ${(f.log ?? []).join(' > ')})`);
  assert.deepEqual(report, []);
});
