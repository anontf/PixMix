import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sha256, hmacSha256, hkdf } from '../src/core/sha256.js';
import { ChaChaRng } from '../src/core/prng.js';
import { computeLayout, applyMap } from '../src/core/layout.js';
import { makeParams } from '../src/core/params.js';

const hex = (u8) => Buffer.from(u8).toString('hex');

test('sha256/hmac/hkdf match node:crypto', () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 1000]) {
    const data = new Uint8Array(len).map((_, i) => (i * 31 + 7) & 255);
    assert.equal(hex(sha256(data)), createHash('sha256').update(data).digest('hex'));
    const key = data.subarray(0, Math.min(len, 100));
    assert.equal(hex(hmacSha256(key, data)), createHmac('sha256', key).update(data).digest('hex'));
    const salt = new Uint8Array([1, 2, 3]);
    assert.equal(hex(hkdf(data.length ? data : new Uint8Array([9]), salt, key, 77)),
      Buffer.from(hkdfSync('sha256', data.length ? data : new Uint8Array([9]), salt, key, 77)).toString('hex'));
  }
});

test('chacha20 keystream matches RFC 8439 A.1 vector #1', () => {
  const rng = new ChaChaRng(new Uint8Array(32), new Uint8Array(12));
  const words = Array.from({ length: 4 }, () => rng.nextU32() >>> 0);
  const bytes = Buffer.alloc(16);
  words.forEach((w, i) => bytes.writeUInt32LE(w, i * 4));
  assert.equal(bytes.toString('hex'), '76b8e0ada0f13d90405d6ae55386bd28');
});

test('layouts are permutations and reversible', () => {
  const salt = new Uint8Array(16);
  for (const [w, h, p] of [
    [1, 1, { mode: 'pixel' }], [7, 5, { mode: 'pixel' }],
    [17, 9, { mode: 'block', block: 4 }], [3, 3, { mode: 'block', block: 8 }], [16, 16, { mode: 'block', block: 8 }],
  ]) {
    const { map } = computeLayout('k', makeParams({ ...p, salt }), w, h);
    assert.equal(new Set(map).size, w * h);
    for (const bpp of [1, 2, 3, 4, 6, 8]) {
      const src = new Uint8Array(w * h * bpp).map((_, i) => i * 13);
      const back = applyMap(applyMap(src, map, bpp, 'scramble'), map, bpp, 'unscramble');
      assert.deepEqual(back, src);
    }
  }
});

test('layout is deterministic and key-dependent', () => {
  const params = makeParams({ mode: 'pixel', salt: new Uint8Array(16) });
  const a = computeLayout('alpha', params, 32, 32).map;
  assert.deepEqual(computeLayout('alpha', params, 32, 32).map, a);
  assert.notDeepEqual(computeLayout('beta', params, 32, 32).map, a);
  // Pin the v1 stream: a change here means existing images would no longer decode.
  assert.equal(hex(sha256(new Uint8Array(a.buffer))).slice(0, 16), PINNED_PIXEL_V1);
});

const PINNED_PIXEL_V1 = '36c1ca99d8b68327';

test('package.json engines: the Node versions that have what pixmix needs', async () => {
  // JPEG XL and native zlib use process.getBuiltinModule (Node 20.16 / 22.3), keys the global crypto.
  const { engines } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(engines.node, '^20.16.0 || >=22.3.0');
  assert.equal(typeof process.getBuiltinModule, 'function');
  assert.equal(typeof globalThis.crypto?.getRandomValues, 'function');
});
