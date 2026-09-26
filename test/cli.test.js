import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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

test('JPEG XL: encode to .jxl, decode and rekey through the async paths', async () => {
  const src = join(FIX, 'basn2c08.png');
  let r = run(['encode', '-k', 'x', '--format', 'jxl', '--mode', 'block', '--block', '4', '-o', join(dir, 'x.jxl'), src]);
  assert.equal(r.status, 0, r.stderr.toString());
  r = run(['rekey', '-k', 'x', '--to', 'y', '--in-place', join(dir, 'x.jxl')]);
  assert.equal(r.status, 0, r.stderr.toString());
  r = run(['decode', '-k', 'y', join(dir, 'x.jxl')]);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.ok(existsSync(join(dir, 'x.restored.jxl')));
  r = run(['inspect', '--json', join(dir, 'x.restored.jxl')]);
  assert.equal(JSON.parse(r.stdout).format, 'jxl');
});

test('watermarks: carry one, draw one on decode, show one on the scrambled image', async () => {
  const src = await sharp({ create: { width: 400, height: 240, channels: 3, background: '#335577' } }).png().toBuffer();
  writeFileSync(join(dir, 'wm.png'), src);
  let r = run(['encode', '-k', 'w', '--watermark', 'vivi-gold', '--visible-watermark', 'vivi-window', join(dir, 'wm.png')]);
  assert.equal(r.status, 0, r.stderr.toString());
  r = run(['inspect', join(dir, 'wm.scrambled.png')]);
  assert.match(r.stdout.toString(), /watermark: vivi-gold\n.*visible watermark/);
  r = run(['decode', '-k', 'w', '-o', join(dir, 'wm.exact.png'), join(dir, 'wm.scrambled.png')]);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.ok(pixels(join(dir, 'wm.exact.png')).equals(PNG.sync.read(src).data), 'exact without --watermark');
  r = run(['decode', '-k', 'w', '--watermark', 'embedded', '-o', join(dir, 'wm.gold.png'), join(dir, 'wm.scrambled.png')]);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.ok(!pixels(join(dir, 'wm.gold.png')).equals(PNG.sync.read(src).data), 'drawn');
  // A definition file works too (compiled with the fonts of the watermarks directory).
  const def = new URL('../watermarks/vivi-pixel.json', import.meta.url).pathname;
  r = run(['decode', '-k', 'w', '--watermark', def, '-o', join(dir, 'wm.pixel.png'), join(dir, 'wm.scrambled.png')]);
  assert.equal(r.status, 0, r.stderr.toString());
  r = run(['rekey', '-k', 'w', '--to', 'v', '--no-watermark', '-o', join(dir, 'wm.plain.png'), join(dir, 'wm.scrambled.png')]);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.doesNotMatch(run(['inspect', join(dir, 'wm.plain.png')]).stdout.toString(), /watermark/);
  assert.equal(run(['decode', '-k', 'w', '--watermark', 'no-such-mark', join(dir, 'wm.scrambled.png')]).status, 2);
  assert.equal(run(['decode', '-k', 'w', '--visible-watermark', 'vivi-gold', join(dir, 'wm.scrambled.png')]).status, 2);
});

test('--metadata: presets, profiles and policy files on encode, decode and rekey; inspect shows parsed metadata', async () => {
  const src = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#468' } })
    .withExif({ IFD0: { Artist: 'Jane Doe', Make: 'Cam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '48/1 51/1 2400/100' } }).jpeg().toBuffer();
  writeFileSync(join(dir, 'm.jpg'), src);
  let r = run(['inspect', join(dir, 'm.jpg')]);
  assert.match(r.stdout.toString(), /EXIF IFD0: .*Make=Cam .*Artist=Jane Doe/);
  assert.match(r.stdout.toString(), /EXIF GPS: GPSLatitudeRef=N \| GPSLatitude=48, 51, 24/);
  r = run(['encode', '-k', 'm', '--metadata', 'vivi-web', '-f', join(dir, 'm.jpg')]);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.match(r.stderr.toString(), /metadata \(vivi-web\): removed EXIF .*; set EXIF Artist, EXIF Copyright/);
  r = run(['inspect', '--json', join(dir, 'm.scrambled.jpg')]);
  assert.deepEqual(JSON.parse(r.stdout).meta.exif.tags.map((t) => [t.name, t.value]), [['Artist', 'Vivi'], ['Copyright', 'Vivi']]);
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ set: { comment: 'from a file' } }));
  r = run(['decode', '-k', 'm', '--metadata', join(dir, 'policy.json'), '-o', join(dir, 'm.out.jpg'), join(dir, 'm.scrambled.jpg')]);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.match(run(['inspect', join(dir, 'm.out.jpg')]).stdout.toString(), /text Comment: from a file/);
  r = run(['rekey', '-k', 'm', '--to', 'n', '--metadata', 'strip-all', '-o', join(dir, 'm.rk.jpg'), join(dir, 'm.scrambled.jpg')]);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.doesNotMatch(run(['inspect', join(dir, 'm.rk.jpg')]).stdout.toString(), /EXIF/);
  // A directory of its own, and bad references.
  const profiles = join(dir, 'profiles');
  mkdirSync(profiles);
  writeFileSync(join(profiles, 'mine.json'), JSON.stringify({ id: 'mine', preset: 'privacy' }));
  r = run(['encode', '-k', 'm', '--metadata', 'mine', '--metadata-profiles', profiles, '-o', join(dir, 'm2.jpg'), join(dir, 'm.jpg')]);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.match(r.stderr.toString(), /metadata \(mine\): removed EXIF Artist \(owner\), EXIF GPS:GPSLatitudeRef/);
  for (const bad of ['no-such-profile', '../x', join(dir, 'missing.json')]) {
    r = run(['encode', '-k', 'm', '--metadata', bad, '-f', join(dir, 'm.jpg')]);
    assert.equal(r.status, 2, bad);
  }
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ strip: ['pixels'] }));
  r = run(['encode', '-k', 'm', '--metadata', join(dir, 'bad.json'), '-f', join(dir, 'm.jpg')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr.toString(), /unknown kind "pixels"/);
});

test('--key-file: the bytes, without one trailing newline or a BOM; binary keys stay distinct', () => {
  const src = join(FIX, 'basn2c08.png');
  writeFileSync(join(dir, 'bom.key'), '﻿secret\r\n');
  let r = run(['encode', '--key-file', join(dir, 'bom.key'), '-o', join(dir, 'kf.png'), src]);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.equal(run(['decode', '-k', 'secret', '-o', '-', join(dir, 'kf.png')]).status, 0, 'same key as the text');
  writeFileSync(join(dir, 'bin1.key'), Uint8Array.of(0xff, 0xfe, 1));
  writeFileSync(join(dir, 'bin2.key'), Uint8Array.of(0xfe, 0xff, 1)); // both were U+FFFD U+FFFD 1
  r = run(['encode', '--key-file', join(dir, 'bin1.key'), '-o', join(dir, 'kb.png'), src]);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.equal(run(['decode', '--key-file', join(dir, 'bin1.key'), '-o', '-', join(dir, 'kb.png')]).status, 0);
  assert.match(run(['decode', '--key-file', join(dir, 'bin2.key'), '-o', '-', join(dir, 'kb.png')]).stderr.toString(), /does not match/);
  assert.equal(run(['encode', '--key-file', join(dir, 'missing.key'), src]).status, 2);
  assert.equal(run(['encode', '-k', '', src]).status, 2);
});

test('rekey --in-place keeps symlinks and permissions', { skip: process.platform === 'win32' }, async () => {
  const { symlinkSync, chmodSync, statSync, lstatSync } = await import('node:fs');
  const real = join(dir, 'real.scrambled.png');
  assert.equal(run(['encode', '-k', 'a', '-o', real, join(FIX, 'basn2c08.png')]).status, 0);
  chmodSync(real, 0o640);
  const link = join(dir, 'link.png');
  symlinkSync(real, link);
  const r = run(['rekey', '-k', 'a', '--to', 'b', '--in-place', link]);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(statSync(real).mode & 0o777, 0o640);
  assert.equal(run(['decode', '-k', 'b', '-o', '-', link]).status, 0);
});

test('batch outputs never collide, even with -f', () => {
  mkdirSync(join(dir, 'c1'), { recursive: true });
  mkdirSync(join(dir, 'c2'), { recursive: true });
  writeFileSync(join(dir, 'c1', 'x.png'), readFileSync(join(FIX, 'basn2c08.png')));
  writeFileSync(join(dir, 'c2', 'x.png'), readFileSync(join(FIX, 'basn0g08.png')));
  const out = join(dir, 'c-out');
  const r = run(['encode', '-k', 'c', '-f', '-o', out, join(dir, 'c1', 'x.png'), join(dir, 'c2', 'x.png')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr.toString(), /already written for .*c1.x\.png in this run/);
  // The first input's output survives.
  assert.equal(run(['decode', '-k', 'c', '-o', join(dir, 'c-back.png'), join(out, 'x.scrambled.png')]).status, 0);
  assert.ok(pixels(join(dir, 'c-back.png')).equals(pixels(join(FIX, 'basn2c08.png'))));
});

test('inapplicable flags and out-of-range numbers are usage errors', () => {
  const src = join(FIX, 'basn2c08.png');
  for (const args of [
    ['rekey', '-k', 'a', '--to', 'b', '--in-place', '-o', 'x.png', src],
    ['decode', '-k', 'a', '--format', 'jpeg', src], ['rekey', '-k', 'a', '--to', 'b', '--format', 'png', src],
    ['encode', '-k', 'a', '--in-place', src], ['decode', '-k', 'a', '--in-place', src], ['decode', '-k', 'a', '--mode', 'pixel', src],
    ['decode', '-k', 'a', '--quality', '80', src], ['encode', '-k', 'a', '--to', 'b', src], ['inspect', '-o', 'x', src],
    ['encode', '-k', 'a', '--level', '11', src], ['encode', '-k', 'a', '--effort', '12', src], ['encode', '-k', 'a', '--quality', '0', src],
    ['encode', '-k', 'a', '--block', '1', src],
  ]) {
    assert.equal(run(args).status, 2, args.join(' '));
  }
});
