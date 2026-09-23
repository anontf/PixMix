import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { PNG } from 'pngjs';

const CLI = new URL('../bin/pixmix.js', import.meta.url).pathname;
const FIX = new URL('./fixtures/pngsuite/', import.meta.url).pathname;
const run = (args, { env = {}, input } = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, PIXMIX_KEY: '', PIXMIX_NEW_KEY: '', ...env }, input });
const pixels = (file) => PNG.sync.read(readFileSync(file)).data;

const dir = mkdtempSync(join(tmpdir(), 'pixmix-cli-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('encode / decode next to the input, key from env', () => {
  writeFileSync(join(dir, 'a.png'), readFileSync(join(FIX, 'basn6a08.png')));
  let r = run(['encode', join(dir, 'a.png')], { env: { PIXMIX_KEY: 'k1' } });
  assert.equal(r.status, 0, r.stderr.toString());
  assert.ok(existsSync(join(dir, 'a.scrambled.png')));
  r = run(['decode', join(dir, 'a.scrambled.png')], { env: { PIXMIX_KEY: 'k1' } });
  assert.equal(r.status, 1, 'refuses to overwrite a.png');
  assert.match(r.stderr.toString(), /exists/);
  r = run(['decode', '-f', join(dir, 'a.scrambled.png')], { env: { PIXMIX_KEY: 'k1' } });
  assert.equal(r.status, 0, r.stderr.toString());
  assert.ok(pixels(join(dir, 'a.png')).equals(PNG.sync.read(readFileSync(join(FIX, 'basn6a08.png'))).data));
});

test('rekey with key files, in place', () => {
  writeFileSync(join(dir, 'old.key'), 'k1\n');
  writeFileSync(join(dir, 'new.key'), 'k2\n');
  const f = join(dir, 'a.scrambled.png');
  let r = run(['rekey', '--in-place', '--key-file', join(dir, 'old.key'), '--to-file', join(dir, 'new.key'), '--mode', 'block', '--block', '4', f]);
  assert.equal(r.status, 0, r.stderr.toString());
  r = run(['decode', '-k', 'k1', '-o', '-', f]);
  assert.equal(r.status, 1);
  assert.match(r.stderr.toString(), /does not match/);
  r = run(['inspect', '--json', f]);
  assert.equal(JSON.parse(r.stdout).mode, 'block');
});

test('stdin to stdout pipe', () => {
  const src = readFileSync(join(FIX, 'basn2c08.png'));
  const enc = run(['encode', '-k', 'p', '-o', '-', '-'], { input: src });
  assert.equal(enc.status, 0, enc.stderr.toString());
  const dec = run(['decode', '-k', 'p', '-o', '-', '-'], { input: enc.stdout });
  assert.equal(dec.status, 0, dec.stderr.toString());
  assert.ok(PNG.sync.read(dec.stdout).data.equals(PNG.sync.read(src).data));
});

test('batch into an output directory, WebP via sharp, partial failure', async () => {
  await sharp({ create: { width: 20, height: 10, channels: 3, background: '#3366aa' } }).webp().toFile(join(dir, 'w.webp'));
  writeFileSync(join(dir, 'junk.png'), 'not an image');
  const out = join(dir, 'out');
  const r = run(['encode', '-k', 'k', '-o', out, join(dir, 'w.webp'), join(FIX, 'basn0g08.png'), join(dir, 'junk.png')]);
  assert.equal(r.status, 1, 'one input failed');
  const err = r.stderr.toString();
  assert.match(err, /w\.webp -> .*w\.scrambled\.png.*webp -> png via sharp/);
  assert.match(err, /junk\.png: Unrecognised image format/);
  assert.ok(existsSync(join(out, 'w.scrambled.png')) && existsSync(join(out, 'basn0g08.scrambled.png')));
});

test('usage errors exit 2', () => {
  assert.equal(run(['encode', 'x.png']).status, 2, 'missing key');
  assert.equal(run(['frobnicate', 'x']).status, 2);
  assert.equal(run(['encode', '-k', 'a', '--key-file', 'f', 'x']).status, 2);
  assert.equal(run(['--help']).status, 0);
});

test('JPEG stays JPEG: .scrambled.jpg and back, lossless', async () => {
  const src = await sharp({ create: { width: 40, height: 24, channels: 3, background: '#aa3355' } }).jpeg().toBuffer();
  writeFileSync(join(dir, 'p.jpg'), src);
  let r = run(['encode', '-k', 'j', join(dir, 'p.jpg')]);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.ok(existsSync(join(dir, 'p.scrambled.jpg')));
  r = run(['decode', '-k', 'j', '-o', join(dir, 'p.back.jpg'), join(dir, 'p.scrambled.jpg')]);
  assert.equal(r.status, 0, r.stderr.toString());
  const [a, b] = await Promise.all([join(dir, 'p.jpg'), join(dir, 'p.back.jpg')].map((f) => sharp(f).raw().toBuffer()));
  assert.ok(a.equals(b));
  r = run(['encode', '-k', 'j', '--format', 'png', '-o', join(dir, 'p.png'), join(dir, 'p.jpg')]);
  assert.match(r.stderr.toString(), /jpeg -> png via jpeg-js/);
  r = run(['encode', '-k', 'j', '--mode', 'block', join(dir, 'p.jpg'), '-o', join(dir, 'x.jpg')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr.toString(), /only applies to PNG/);
});
