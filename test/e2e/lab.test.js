// The dev server's lab and demo-site pages, driven in each engine in PIXMIX_BROWSERS.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launch, engines, openPage } from './harness.js';

let proc, base;
before(async () => {
  proc = spawn(process.execPath, [new URL('../../server/server.js', import.meta.url).pathname], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { const m = /http:\/\/[\d.]+:\d+/.exec(String(d)); if (m) resolve(m[0]); });
    proc.on('exit', (c) => reject(new Error(`server exited (${c})`)));
  });
});
after(async () => {
  proc?.kill();
});

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
