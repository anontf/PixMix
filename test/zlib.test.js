// node:zlib and the fflate path (browsers, other runtimes) must accept the same streams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

const native = await import('../src/formats/png/zlib.js');
const saved = process.getBuiltinModule;
process.getBuiltinModule = undefined;
const js = await import('../src/formats/png/zlib.js?fflate');
process.getBuiltinModule = saved;

test('the Adler-32 checksum is checked on both paths; trailing bytes are tolerated on both', () => {
  const raw = new Uint8Array(5000).map((_, i) => (i * 7) ^ (i >> 3));
  const z = new Uint8Array(zlib.deflateSync(raw));
  const bad = z.slice();
  bad[bad.length - 1] ^= 1;
  const trailing = new Uint8Array([...z, 1, 2, 3, 4, 5]);
  for (const { inflateUpTo } of [native, js]) {
    assert.deepEqual(inflateUpTo(z, raw.length), raw);
    assert.throws(() => inflateUpTo(bad, raw.length));
    assert.deepEqual(inflateUpTo(trailing, raw.length), raw);
  }
});
