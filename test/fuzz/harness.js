// Runs fuzz cases in worker threads with a time budget per case. A case fails when an
// operation throws anything but a PixmixError, takes longer than the budget (a hang: the
// worker is terminated and replaced), kills its worker (a crash, or running out of heap),
// or makes the process's memory run away.

import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { buildFixtures } from './fixtures.js';
import { makeCase } from './cases.js';

const WORKER = new URL('./worker.js', import.meta.url);
const DEFAULT_SRC = new URL('../../src/', import.meta.url).href;

/**
 * Groups failures that are the same bug. Exceptions: error type, where it was thrown and
 * the start of the message (whichever operation ran into it). Hangs and crashes: the
 * operation and the seed file's format.
 */
export function signature(f) {
  if (f.kind !== 'exception') return `${f.kind} in ${f.op} (${f.fixture?.split(':')[0]})`;
  const line = (f.stack ?? '').split('\n').find((l) => /^\s+at /.test(l)) ?? '';
  const [, fn = '', file = ''] = /at (?:(\S+) \()?(?:.*\/)?([^/:()]+)(?::\d+)*\)?$/.exec(line.trim()) ?? [];
  const message = (f.message ?? '').replace(/\d+/g, '#').split(/[:;(]/)[0].slice(0, 60);
  return `${f.name} at ${fn || '<anonymous>'} (${file}): ${message}`;
}

/**
 * @param {object} o
 * @param {number} [o.seed=1] @param {number} [o.iterations=1000]
 * @param {number} [o.workers] default: half the CPUs, at most 8
 * @param {number} [o.timeoutMs=20000] budget per case (all its operations together)
 * @param {number} [o.rssLimitMb] kill everything when the process grows past this
 * @param {string} [o.srcUrl] pixmix's src/ directory to fuzz, as a file: URL
 * @param {(f: object) => void} [o.onFailure] @param {(done: number) => void} [o.onProgress]
 * @returns {Promise<{cases: number, failures: object[], fixtures: string[], ms: number}>}
 */
export async function runFuzz({
  seed = 1, iterations = 1000, workers, timeoutMs = 20000, rssLimitMb, srcUrl = DEFAULT_SRC,
  heapLimitMb = 1024, batch = 20, onFailure = () => {}, onProgress = () => {}, fixtures,
} = {}) {
  const started = Date.now();
  fixtures ??= await buildFixtures();
  const count = Math.max(1, Math.min(workers ?? Math.min(8, Math.ceil(availableParallelism() / 2)), Math.ceil(iterations / batch)));
  rssLimitMb ??= 1024 + count * 1024;
  const failures = [];
  const fail = (f) => { failures.push(f); onFailure(f); };
  let next = 0, done = 0;
  const pending = []; // batches handed back by replaced workers
  const takeBatch = () => {
    if (pending.length) return pending.shift();
    if (next >= iterations) return null;
    const b = { from: next, to: Math.min(iterations, next + batch) };
    next = b.to;
    return b;
  };

  return new Promise((resolve, reject) => {
    const slots = [];
    let closed = false, deathsInARow = 0;
    const close = () => {
      closed = true;
      clearInterval(watchdog);
      for (const s of slots) { s.dead = true; s.worker.terminate(); }
    };
    const finish = () => {
      if (closed || slots.some((s) => s.busy) || pending.length || next < iterations) return;
      close();
      resolve({ cases: done, failures, fixtures: fixtures.map((f) => f.name), ms: Date.now() - started });
    };
    const assign = (s) => {
      const b = takeBatch();
      s.batch = b;
      if (!b) { s.busy = false; finish(); return; }
      s.busy = true;
      s.next = b.from;
      s.worker.postMessage(b);
    };
    // A worker that hung or died: record its case, and carry on after it in a new one.
    const replace = (s, kind, detail) => {
      if (s.dead || closed) return;
      s.dead = true;
      if (s.index !== null) {
        deathsInARow = 0;
        let c = { fixture: {} }; // cases are deterministic: rebuild its input for the report
        try { c = makeCase(fixtures, seed, s.index); } catch { /* reported as it is */ }
        fail({ kind, index: s.index, op: s.op, fixture: c.fixture.name, log: c.log, bytes: c.bytes, ...detail });
        done++;
        onProgress(done);
        s.next = s.index + 1;
      } else if (++deathsInARow > 5) { // workers that die before running anything
        close();
        reject(new Error(`fuzz workers keep dying: ${detail.message}`));
        return;
      }
      if (s.batch && s.next < s.batch.to) pending.push({ from: s.next, to: s.batch.to });
      s.worker.terminate();
      slots[slots.indexOf(s)] = spawn();
    };
    const spawn = () => {
      const s = { worker: null, busy: false, batch: null, next: 0, index: null, op: '', since: 0, dead: false };
      s.worker = new Worker(WORKER, {
        workerData: { fixtures, seed, srcUrl },
        resourceLimits: { maxOldGenerationSizeMb: heapLimitMb },
        stdout: true, // decoders that print (libvips warnings, WASM codecs) stay quiet
        stderr: true,
      });
      s.worker.stdout.resume();
      s.worker.stderr.resume();
      s.worker.on('message', (m) => {
        if (m.type === 'ready') assign(s);
        else if (m.type === 'start') { s.index = m.index; s.op = ''; s.since = Date.now(); }
        else if (m.type === 'op') s.op = m.op;
        else if (m.type === 'done') {
          s.index = null;
          s.next = m.index + 1;
          deathsInARow = 0;
          done++;
          for (const f of m.failures) fail({ kind: 'exception', index: m.index, fixture: m.fixture, log: m.log, bytes: m.bytes, ...f });
          onProgress(done);
        } else if (m.type === 'idle') assign(s);
      });
      s.worker.on('error', (err) => replace(s, err?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'crash', { name: err?.code ?? err?.name, message: err?.message, stack: err?.stack }));
      s.worker.on('exit', (code) => { if (!s.dead) replace(s, 'crash', { name: 'exit', message: `worker exited with code ${code}` }); });
      return s;
    };
    for (let i = 0; i < count; i++) slots.push(spawn());

    const watchdog = setInterval(() => {
      const now = Date.now();
      for (const s of [...slots]) {
        if (s.index !== null && now - s.since > timeoutMs) replace(s, 'hang', { name: 'timeout', message: `case took more than ${timeoutMs} ms` });
      }
      const rss = process.memoryUsage.rss() / 2 ** 20;
      if (rss > rssLimitMb) {
        for (const s of [...slots]) if (s.index !== null) replace(s, 'memory', { name: 'rss', message: `process grew to ${Math.round(rss)} MiB` });
      }
    }, 100);
  });
}
