// The dev server's lab and demo-site pages, driven in each engine in PIXMIX_BROWSERS.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import omggif from 'omggif';
import { launch, engines, openPage } from './harness.js';
import { readMetadata } from '../../src/index.js';

const { GifWriter } = omggif;

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
      await p.evaluate(() => { for (const id of ['scrMeta', 'decMeta']) document.getElementById(id).textContent = ''; });
      await p.click('#encode');
      await p.waitForFunction(() => /✓|✗|≈|Error/.test(document.querySelector('#decMeta').textContent + document.querySelector('#scrMeta').textContent), null, { timeout: 60000 });
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

  test('lab editors: saving never replaces another file without asking; the picker names what is edited', async () => {
    const { page: p, errors } = await openPage(browser);
    await p.goto(base);
    await p.waitForFunction(() => document.querySelectorAll('#wmPick option').length === 3 && document.querySelector('#mdForm input[name="id"]'));
    const editors = [
      { pre: 'wm', dir: wmDir, other: 'vivi-gold', from: 'vivi-pixel', form: '#wmForm' },
      { pre: 'md', dir: mdDir, other: 'vivi-web', from: 'vivi-privacy', form: '#mdForm' },
    ];
    for (const { pre, dir, other, from, form } of editors) {
      const file = (id) => join(dir, `${id}.json`);
      const picked = () => p.$eval(`#${pre}Pick`, (s) => s.selectedOptions[0]?.textContent);
      const otherBefore = readFileSync(file(other), 'utf8');
      const dialogs = [];
      const onDialog = (d) => { dialogs.push(d.message()); d.dismiss(); };
      p.on('dialog', onDialog);
      // New, given an existing id: Save asks, and declining leaves the file alone.
      await p.click(`#${pre}New`);
      await p.waitForFunction((s) => /not saved/.test(document.querySelector(s).textContent), `#${pre}Status`);
      assert.match(await picked(), /· not saved$/);
      await p.fill(`${form} input[name="id"]`, other);
      await p.waitForFunction(([s, o]) => document.querySelector(s).textContent.includes(`${o}.json already exists`), [`#${pre}Status`, other]);
      await p.click(`#${pre}Save`);
      await p.waitForFunction((s) => /^not saved: .* already exists \(give/.test(document.querySelector(s).textContent), `#${pre}Status`);
      assert.equal(dialogs.length, 1);
      assert.match(dialogs[0], new RegExp(`${other}\\.json already exists`));
      assert.equal(readFileSync(file(other), 'utf8'), otherBefore);
      // Delete on something unsaved says why it does nothing.
      await p.click(`#${pre}Delete`);
      await p.waitForFunction((s) => /is not saved yet: there is no file to delete/.test(document.querySelector(s).textContent), `#${pre}Status`);
      assert.equal(dialogs.length, 1);
      // Duplicate: the picker names the copy; Save creates it.
      await p.selectOption(`#${pre}Pick`, from);
      await p.waitForFunction(([s, f]) => document.querySelector(s).textContent.endsWith(`/${f}.json`), [`#${pre}Status`, from]);
      await p.click(`#${pre}Copy`);
      await p.waitForFunction((s) => /-copy\) · not saved$/.test(document.querySelector(s).selectedOptions[0]?.textContent), `#${pre}Pick`);
      await p.click(`#${pre}Save`);
      await p.waitForFunction((s) => /^saved .*-copy\.json/.test(document.querySelector(s).textContent), `#${pre}Status`);
      assert.ok(existsSync(file(`${from}-copy`)));
      assert.match(await picked(), new RegExp(`\\(${from}-copy\\)$`));
      // A saved one given another (taken) id: asks too, and keeps both files.
      await p.fill(`${form} input[name="id"]`, other);
      await p.waitForFunction(([s, o]) => document.querySelector(s).textContent.includes(`${o}.json already exists`), [`#${pre}Status`, other]);
      await p.click(`#${pre}Save`);
      await p.waitForFunction((s) => /^not saved: .* already exists \(give/.test(document.querySelector(s).textContent), `#${pre}Status`);
      assert.equal(dialogs.length, 2);
      assert.equal(readFileSync(file(other), 'utf8'), otherBefore);
      assert.ok(existsSync(file(`${from}-copy`)));
      p.off('dialog', onDialog);
      // Clean up the copy.
      await p.selectOption(`#${pre}Pick`, `${from}-copy`);
      await p.waitForFunction((s) => /-copy\.json$/.test(document.querySelector(s).textContent), `#${pre}Status`);
      p.once('dialog', (d) => d.accept());
      await p.click(`#${pre}Delete`);
      await p.waitForFunction((s) => /^deleted/.test(document.querySelector(s).textContent), `#${pre}Status`);
      assert.equal(existsSync(file(`${from}-copy`)), false);
    }
    assert.deepEqual(errors, []);
    await p.close();
  });

  test('lab: a bad file clears the old results; hidden choices reset; animated restores match', async () => {
    const { page: p, errors } = await openPage(browser);
    await p.goto(base);
    await encodeInLab(p, { sample: 'image/png', format: '', where: 'browser' });
    await p.setInputFiles('#file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello, not an image') });
    await p.waitForFunction(() => /notes\.txt/.test(document.querySelector('#origMeta').textContent));
    assert.deepEqual(await p.evaluate(() => ({
      stages: ['origStage', 'scrStage', 'decStage'].map((id) => document.getElementById(id).childElementCount),
      enabled: ['encode', 'replay', 'rekey', 'publish'].filter((id) => !document.getElementById(id).disabled),
      text: ['scrMeta', 'decMeta', 'chunks'].map((id) => document.getElementById(id).textContent),
    })), { stages: [0, 0, 0], enabled: [], text: ['', '', ''] });
    // A new image while the previous one still decodes: its result never lands.
    await p.selectOption('#sampleType', 'image/png');
    await p.click('#sample');
    await p.waitForFunction(() => !document.querySelector('#encode').disabled);
    await p.fill('#duration', '1500');
    await p.click('#encode');
    await p.waitForFunction(() => document.querySelector('#decMeta').textContent === 'decoding…', null, { timeout: 30000 });
    await p.selectOption('#sampleType', 'image/jpeg');
    await p.click('#sample');
    await p.waitForFunction(() => /^JPEG/.test(document.querySelector('#origMeta').textContent));
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(await p.textContent('#decMeta'), '');
    // "mcu" is the JPEG route: offered for JPEG XL from a JPEG, and reset when it no longer applies.
    await p.selectOption('#format', 'jxl');
    assert.equal(await p.isVisible('#transforms'), true);
    await p.selectOption('#mode', 'mcu');
    await p.selectOption('#format', 'png');
    assert.equal(await p.inputValue('#mode'), '');
    await p.selectOption('#format', 'jxl');
    await p.selectOption('#mode', 'pixel');
    assert.equal(await p.isVisible('#transforms'), false, 'no JPEG MCUs in pixel mode');
    await p.selectOption('#mode', '');
    await p.selectOption('#sampleType', 'image/png');
    await p.click('#sample');
    await p.waitForFunction(() => /^PNG/.test(document.querySelector('#origMeta').textContent));
    assert.equal(await p.$eval('#modeMcu', (o) => o.hidden), true, 'no JPEG route for a PNG');
    assert.equal(await p.isVisible('#transforms'), false);
    // An animated GIF, restored exactly: its frames (fdAT) are image data, not metadata.
    const w = 24, h = 16, gif = Buffer.alloc(4096);
    const gw = new GifWriter(gif, w, h, { loop: 0, palette: [0xff0000, 0x00ff00, 0x0000ff, 0xffffff] });
    for (let f = 0; f < 3; f++) gw.addFrame(0, 0, w, h, Uint8Array.from({ length: w * h }, (_, i) => (i + f * 5) % 4), { delay: 10 });
    await p.setInputFiles('#file', { name: 'anim.gif', mimeType: 'image/gif', buffer: gif.subarray(0, gw.end()) });
    await p.waitForFunction(() => /^GIF/.test(document.querySelector('#origMeta').textContent));
    await p.selectOption('#format', 'png');
    await p.fill('#duration', '200');
    await p.click('#encode');
    await p.waitForFunction(() => /✓|✗|≈|Error|bad/i.test(document.querySelector('#decMeta').textContent + document.querySelector('#scrMeta').textContent) &&
      document.querySelector('#decMeta').textContent !== 'decoding…', null, { timeout: 60000 });
    const dec = await p.textContent('#decMeta');
    assert.match(dec, /✓ pixel-identical/, dec);
    assert.match(dec, /✓ metadata chunks identical/, dec);
    assert.match(await p.textContent('#chunks'), /fdAT/, 'an APNG with frame data');
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
