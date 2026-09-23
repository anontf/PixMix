// Fuzz worker: runs the cases it is sent, one at a time, and says when each starts, so the
// parent can tell which case hung or crashed the thread.

import { parentPort, workerData } from 'node:worker_threads';
import { loadTarget, makeCase, runCase } from './cases.js';
import { KEY } from './fixtures.js';

const { fixtures, seed, srcUrl } = workerData;
const target = await loadTarget(srcUrl);

parentPort.on('message', async ({ from, to }) => {
  for (let index = from; index < to; index++) {
    parentPort.postMessage({ type: 'start', index });
    let op = 'mutate';
    let failures, c = { fixture: { name: '?' }, log: [], bytes: new Uint8Array(0) };
    try {
      c = makeCase(fixtures, seed, index);
      failures = await runCase(target, c, { key: KEY, onOp: (name) => { op = name; parentPort.postMessage({ type: 'op', index, op }); } });
    } catch (err) {
      failures = [{ op, name: 'HarnessError', message: String(err?.message ?? err), stack: String(err?.stack ?? '') }];
    }
    const mem = process.memoryUsage();
    parentPort.postMessage({
      type: 'done', index, fixture: c.fixture.name, log: c.log, size: c.bytes.length, failures,
      memory: mem.arrayBuffers + mem.heapUsed,
      ...(failures.length ? { bytes: c.bytes } : {}),
    });
  }
  parentPort.postMessage({ type: 'idle' });
});

parentPort.postMessage({ type: 'ready' });
