import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import { encode, decode, rekey, inspect, WrongKeyError } from '../src/index.js';
import { readChunks } from '../src/formats/png/chunks.js';

const DIR = new URL('./fixtures/pngsuite/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.png'));
const valid = files.filter((f) => !f.startsWith('x'));
const corrupt = files.filter((f) => f.startsWith('x'));

const asBuf = (d) => Buffer.from(d.buffer, d.byteOffset, d.byteLength);
const pixels = (bytes) => asBuf(PNG.sync.read(Buffer.from(bytes), { skipRescale: true }).data);
const nonImageChunks = (bytes) =>
  readChunks(bytes).filter((c) => c.type !== 'IDAT' && c.type !== 'pmIx')
    .map((c) => c.type + Buffer.from(c.data).toString('hex'));

const MODES = [{ mode: 'pixel' }, { mode: 'block', block: 4 }, { mode: 'block', block: 3 }];

for (const f of valid) {
  test(`round trip ${f}`, () => {
    const orig = readFileSync(new URL(f, DIR));
    for (const m of MODES) {
      const scrambled = encode(orig, { key: 'secret', ...m });
      // Any decoder must still accept the scrambled file, with the same geometry.
      const sPng = PNG.sync.read(Buffer.from(scrambled), { skipRescale: true });
      const oPng = PNG.sync.read(orig, { skipRescale: true });
      assert.equal(sPng.width, oPng.width);
      assert.equal(sPng.height, oPng.height);
      assert.deepEqual(nonImageChunks(scrambled), nonImageChunks(orig), 'metadata preserved');
      assert.equal(inspect(scrambled).scrambled, true);

      const restored = decode(scrambled, { key: 'secret' });
      assert.ok(pixels(restored).equals(asBuf(oPng.data)), 'pixels restored');
      assert.deepEqual(nonImageChunks(restored), nonImageChunks(orig));
      assert.equal(inspect(restored).scrambled, false);
    }
  });
}

test('scrambling actually moves pixels', () => {
  const orig = readFileSync(new URL('basn6a08.png', DIR));
  const scrambled = encode(orig, { key: 'secret' });
  assert.ok(!pixels(scrambled).equals(pixels(orig)));
});

test('wrong key is rejected', () => {
  const orig = readFileSync(new URL('basn2c08.png', DIR));
  const scrambled = encode(orig, { key: 'right' });
  assert.throws(() => decode(scrambled, { key: 'wrong' }), WrongKeyError);
});

test('rekey swaps key and mode losslessly', () => {
  const orig = readFileSync(new URL('basi2c16.png', DIR));
  const a = encode(orig, { key: 'one' });
  const b = rekey(a, { from: 'one', to: 'two', mode: 'block', block: 4 });
  assert.equal(inspect(b).mode, 'block');
  assert.throws(() => decode(b, { key: 'one' }), WrongKeyError);
  assert.ok(pixels(decode(b, { key: 'two' })).equals(pixels(orig)));
});

test('double scrambling and unscrambled decode are refused', () => {
  const orig = readFileSync(new URL('basn0g08.png', DIR));
  assert.throws(() => decode(orig, { key: 'k' }), /no pixmix marker/);
  assert.throws(() => encode(encode(orig, { key: 'k' }), { key: 'k' }), /already scrambled/);
});

for (const f of corrupt) {
  test(`corrupt input ${f} is rejected`, () => {
    assert.throws(() => encode(readFileSync(new URL(f, DIR)), { key: 'k' }));
  });
}

test('async decode path matches sync', async () => {
  const { unscramblePngDetailedAsync } = await import('../src/formats/png/index.js');
  const orig = readFileSync(new URL('basi6a16.png', DIR));
  const scrambled = encode(orig, { key: 'k', mode: 'block', block: 4 });
  const d = await unscramblePngDetailedAsync(scrambled, { key: 'k' });
  assert.ok(pixels(await d.toPng()).equals(pixels(orig)));
});
