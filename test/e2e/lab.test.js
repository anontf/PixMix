// The dev server's lab and demo-site pages, driven in each engine in PIXMIX_BROWSERS.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { launch, engines, openPage } from './harness.js';
import { readMetadata } from '../../src/index.js';

let proc, base, wmDir, mdDir;
before(async () => {
  // The lab saves watermarks and metadata profiles: give it copies of the directories.
  wmDir = mkdtempSync(join(tmpdir(), 'pixmix-lab-wm-'));
  cpSync(new URL('../../watermarks', import.meta.url).pathname, wmDir, { recursive: true });
  mdDir = mkdtempSync(join(tmpdir(), 'pixmix-lab-md-'));
  cpSync(new URL('../../metadata-profiles', import.meta.url).pathname, mdDir, { recursive: true });
  proc = spawn(process.execPath, [new URL('../../server/server.js', import.meta.url).pathname], {
    env: { ...process.env, PORT: '0', PIXMIX_WATERMARKS_DIR: wmDir, PIXMIX_METADATA_PROFILES_DIR: mdDir }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { const m = /http:\/\/[\d.]+:\d+/.exec(String(d)); if (m) resolve(m[0]); });
    proc.on('exit', (c) => reject(new Error(`server exited (${c})`)));
  });
});
after(async () => {
  proc?.kill();
  if (wmDir) rmSync(wmDir, { recursive: true, force: true });
  if (mdDir) rmSync(mdDir, { recursive: true, force: true });
});

/** A photo-like JPEG with EXIF (owner, device, GPS), as a phone would upload. */
const photo = () => sharp({ create: { width: 96, height: 64, channels: 3, background: '#4a7' } })
  .withExif({ IFD0: { Artist: 'Jane Doe', Make: 'Cam', Model: 'P1' }, IFD2: { DateTimeOriginal: '2024:01:02 03:04:05' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '48/1 51/1 2400/100' } })
  .jpeg().toBuffer();

async function encodeInLab(p, { sample, format, where, mode = '' }) {
  await p.selectOption('#sampleType', sample);
  await p.click('#sample');
  await p.waitForFunction(() => !document.querySelector('#encode').disabled);
  await p.selectOption('#format', format);
  await p.selectOption('#where', where);
  if (await p.isVisible('#mode')) await p.selectOption('#mode', mode);
  await p.fill('#duration', '200');
  await p.click('#encode');
  await p.waitForFunction(() => /✓|✗|≈|Error|bad/i.test(document.querySelector('#decMeta').textContent + document.querySelector('#scrMeta').textContent) &&
    document.querySelector('#decMeta').textContent !== 'decoding…', null, { timeout: 90000 });
  return { dec: await p.textContent('#decMeta'), scr: await p.textContent('#scrMeta') };
}

const CASES = [
  // [sample, output format ('' = same as input), mode]
  ['image/png', '', ''], ['image/png', '', 'block'], ['image/png', 'jpeg', ''], ['image/png', 'jxl', 'block'],
  ['image/jpeg', '', ''], ['image/jpeg', 'jxl', ''], ['image/webp', '', 'pixel'], ['jxl', '', 'pixel'],
];

for (const { name: engine, skip } of await engines()) describe(engine, { skip }, () => {
  let browser;
  before(async () => { browser = await launch(engine); });
  after(() => browser?.close());

  for (const where of ['server', 'browser']) {
    for (const [sample, format, mode] of CASES) {
      test(`lab: ${sample} -> ${format || 'same'}${mode ? ` (${mode})` : ''} on ${where}`, async () => {
        const { page: p, errors } = await openPage(browser);
        await p.goto(base);
        const r = await encodeInLab(p, { sample, format, where, mode });
        // Engines that can't encode WebP (Safari) generate a PNG sample and say so.
        if (sample === 'image/webp') assert.match(await p.textContent('#origMeta'), /^WEBP|can't encode WEBP/);
        assert.match(r.dec, /✓ pixel-identical/, `${r.scr}\n${r.dec}`);
        assert.match(r.dec, /✓ metadata chunks identical/, r.dec);
        assert.deepEqual(errors, []);
        await p.close();
      });
    }
  }

  test('lab watermark editor: live preview, save to disk, then decode with it', async () => {
    const { page: p, errors } = await openPage(browser);
    await p.goto(base);
    await p.waitForFunction(() => document.querySelectorAll('#wmPick option').length === 3);
    await p.selectOption('#wmPick', 'vivi-window');
    await p.waitForFunction(() => /size .* px/.test(document.querySelector('#wmInfo').textContent), null, { timeout: 20000 });
    for (const bg of ['dark', 'small', 'large', 'light']) {
      await p.selectOption('#wmBg', bg);
      await p.waitForFunction((b) => document.querySelector('#wmInfo').textContent.startsWith({ dark: '800×500', small: '160×100', large: '4000×2600', light: '800×500' }[b]), bg);
    }
    // A new one, edited in the form.
    const id = `lab-${engine}`;
    await p.click('#wmNew');
    await p.waitForFunction(() => /not saved/.test(document.querySelector('#wmStatus').textContent));
    await p.fill('#wmForm input[name="id"]', id);
    await p.fill('#wmForm textarea[name="text"]', 'Hi Vivi');
    await p.selectOption('#wmForm select[name="font"]', 'PressStart2P-Regular');
    await p.check('#wmForm input[name="shadow:on"]');
    await p.waitForFunction(() => /"text": "Hi Vivi"/.test(document.querySelector('#wmJson').value) && /"shadow": \{/.test(document.querySelector('#wmJson').value), null, { timeout: 10000 });
    const before = await p.textContent('#wmInfo');
    await p.fill('#wmForm input[name="size.max"]', '20');
    await p.fill('#wmForm input[name="size.relative"]', '0.5');
    await p.waitForFunction((b) => document.querySelector('#wmInfo').textContent !== b && /size 20\.0 px/.test(document.querySelector('#wmInfo').textContent), before);
    await p.click('#wmSave');
    await p.waitForFunction(() => /^saved watermarks/.test(document.querySelector("#wmStatus").textContent));
    const saved = JSON.parse(readFileSync(join(wmDir, `${id}.json`), 'utf8'));
    assert.equal(saved.text, 'Hi Vivi');
    assert.equal(saved.size.max, 20);
    assert.ok(saved.shadow && existsSync(join(wmDir, 'compiled', `${id}.json`)));
    // It is now offered for encoding and decoding.
    await p.waitForFunction((w) => [...document.querySelectorAll('#decWm option, #encWm option')].filter((o) => o.value === w).length === 2, id);
    await p.selectOption('#sampleType', 'image/jpeg');
    await p.click('#sample');
    await p.waitForFunction(() => !document.querySelector('#encode').disabled);
    await p.selectOption('#encWm', id);
    await p.selectOption('#visWm', 'vivi-pixel');
    await p.fill('#duration', '200');
    await p.click('#encode');
    await p.waitForFunction(() => /✓|✗|≈|Error/.test(document.querySelector('#decMeta').textContent), null, { timeout: 60000 });
    const dec = await p.textContent('#decMeta');
    assert.match(dec, /✓ pixel-identical/, dec);
    assert.match(dec, new RegExp(`watermark ${id} drawn`));
    assert.match(await p.textContent('#scrMeta'), new RegExp(`carries ${id} · visible watermark`));
    // Delete it again.
    p.once('dialog', (d) => d.accept());
    await p.click('#wmDelete');
    await p.waitForFunction(() => /deleted/.test(document.querySelector('#wmStatus').textContent));
    assert.equal(existsSync(join(wmDir, `${id}.json`)), false);
    assert.deepEqual(errors, []);
    await p.close();
  });

  test('lab metadata profiles: before/after, save, encode and decode with them', async () => {
    const { page: p, errors } = await openPage(browser);
    await p.goto(base);
    await p.waitForFunction(() => document.querySelectorAll('#mdPick option').length === 2 && document.querySelectorAll('#encMetadata option').length === 6);
    await p.setInputFiles('#file', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: await photo() });
    await p.waitForFunction(() => !document.querySelector('#encode').disabled);
    // The default web profile: everything goes but the orientation, Vivi is set.
    await p.selectOption('#mdPick', 'vivi-web');
    await p.waitForFunction(() => /after \(vivi-web\)/.test(document.querySelector('#mdDiff').textContent), null, { timeout: 20000 });
    const rows = await p.$$eval('#mdDiff tr', (trs) => trs.map((tr) => [tr.className, ...[...tr.cells].map((c) => c.textContent)]));
    const row = (k) => rows.find((r) => r[1] === k);
    assert.deepEqual(row('EXIF GPS:GPSLatitude'), ['gone', 'EXIF GPS:GPSLatitude', '48, 51, 24', '']);
    assert.deepEqual(row('EXIF IFD0:Artist'), ['changed', 'EXIF IFD0:Artist', 'Jane Doe', 'Vivi']);
    assert.equal(row('EXIF IFD0:Copyright')[0], 'new');
    assert.match(await p.textContent('#mdReport'), /set: EXIF Artist, EXIF Copyright/);
    // A new one, edited in the form, saved.
    const id = `lab-${engine}`;
    await p.click('#mdNew');
    await p.waitForFunction(() => /not saved/.test(document.querySelector('#mdStatus').textContent));
    await p.fill('#mdForm input[name="id"]', id);
    await p.selectOption('#mdForm select[name="preset"]', 'privacy');
    await p.fill('#mdForm input[name="set.copyright"]', '');
    await p.fill('#mdForm input[name="set.artist"]', 'Vivi Lab');
    await p.fill('#mdForm textarea[name="set.exif"]', 'Software=pixmix lab');
    await p.selectOption('#mdForm select[name="kind.icc"]', 'strip');
    await p.waitForFunction((i) => new RegExp(`"id": "${i}"`).test(document.querySelector('#mdJson').value) && /pixmix lab/.test(document.querySelector('#mdJson').value)
      && /after \(/.test(document.querySelector('#mdDiff').textContent) && document.querySelector('#mdDiff').textContent.includes(i), id, { timeout: 20000 });
    await p.click('#mdSave');
    await p.waitForFunction(() => /^saved metadata-profiles/.test(document.querySelector('#mdStatus').textContent));
    assert.deepEqual(JSON.parse(readFileSync(join(mdDir, `${id}.json`), 'utf8')), { id, name: 'New profile', preset: 'privacy', strip: ['icc'], set: { artist: 'Vivi Lab', exif: { Software: 'pixmix lab' } } });
    await p.waitForFunction((i) => [...document.querySelectorAll('#encMetadata option, #decMetadata option')].filter((o) => o.value === i).length === 2, id);
    // Encoding with it, on the server and in the browser: the scrambled file carries it, and
    // decoding with strip-all gives the same pixels with only the orientation left.
    for (const where of ['server', 'browser']) {
      await p.selectOption('#encMetadata', id);
      await p.selectOption('#decMetadata', where === 'server' ? '' : 'strip-all');
      await p.selectOption('#where', where);
      await p.fill('#duration', '200');
      await p.click('#encode');
      await p.waitForFunction(() => /✓|✗|≈|Error|bad/i.test(document.querySelector('#decMeta').textContent) && document.querySelector('#decMeta').textContent !== 'decoding…', null, { timeout: 60000 });
      const scr = await p.textContent('#scrMeta'), dec = await p.textContent('#decMeta');
      assert.match(scr, new RegExp(`metadata ${id}: removed .*EXIF Artist.*GPS.*set EXIF Artist, EXIF Software`), scr);
      assert.match(dec, /✓ pixel-identical/, dec);
      assert.match(dec, /✓ metadata chunks identical/, dec);
      if (where === 'browser') assert.match(dec, /restored with metadata strip-all/);
      const shown = await p.evaluate(async () => Array.from(new Uint8Array(await (await fetch(document.querySelector('#decStage img').src)).arrayBuffer())));
      const tags = readMetadata(new Uint8Array(shown)).exif?.tags.map((t) => [t.name, t.value]) ?? [];
      const names = tags.map(([n]) => n);
      if (where === 'browser') assert.deepEqual(tags, [], 'strip-all on decode (orientation 1 needs no EXIF)');
      else {
        assert.deepEqual(tags.filter(([n]) => n === 'Artist' || n === 'Software'), [['Software', 'pixmix lab'], ['Artist', 'Vivi Lab']]); // by tag number
        assert.ok(names.includes('Make') && !names.some((n) => /GPS|DateTime/.test(n)), names.join());
      }
    }
    p.once('dialog', (d) => d.accept());
    await p.click('#mdDelete');
    await p.waitForFunction(() => /deleted/.test(document.querySelector('#mdStatus').textContent));
    assert.equal(existsSync(join(mdDir, `${id}.json`)), false);
    assert.deepEqual(errors, []);
    await p.close();
  });

  test('lab rekey, wrong decode key, then publish to the demo site', async () => {
    const { page: p, errors } = await openPage(browser);
    await p.goto(base);
    await encodeInLab(p, { sample: 'image/jpeg', format: '', where: 'server' });
    await p.fill('#newKey', 'second key');
    await p.click('#rekey');
    await p.waitForFunction(() => /re-keyed/.test(document.querySelector('#scrMeta').textContent) && /✓ pixel-identical/.test(document.querySelector('#decMeta').textContent), null, { timeout: 60000 });
    await p.fill('#decKey', 'wrong');
    await p.click('#replay');
    await p.waitForFunction(() => /WrongKeyError/.test(document.querySelector('#decMeta').textContent), null, { timeout: 30000 });
    await p.fill('#decKey', '');
    await p.click('#publish');
    await p.waitForFunction(() => /published/.test(document.querySelector('#pubMeta').textContent));

    await p.goto(`${base}/site.html`);
    await p.waitForFunction(() => {
      const imgs = [...document.querySelectorAll('.gallery img')];
      return imgs.length && imgs.every((i) => i.dataset.pixmixState === 'done');
    }, null, { timeout: 60000 });
    assert.deepEqual(errors, []);
    await p.close();
  });
});
