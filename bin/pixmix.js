#!/usr/bin/env node
// pixmix command line: encode / decode / rekey / inspect.

import { parseArgs } from 'node:util';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { encodeAsync, decodeAsync, rekeyAsync, inspect, detectFormat, PixmixError } from '../src/index.js';
import { targetFormat } from '../src/convert/index.js';
import { sharpDecoder } from '../src/plugins/sharp.js';

const USAGE = `Usage:
  pixmix encode  <file...> [options]   scramble images (any supported input -> PNG, JPEG or JPEG XL)
  pixmix decode  <file...> [options]   restore scrambled images
  pixmix rekey   <file...> [options]   change the key (and optionally the mode) losslessly
  pixmix inspect <file...> [--json]    show format, size, metadata and scramble info

Keys (prefer the file or environment forms; -k ends up in shell history):
  -k, --key <key>          key            --key-file <path>      read key from file
  $PIXMIX_KEY              key (encode/decode), old key (rekey)
  --to <key> | --to-file <path> | $PIXMIX_NEW_KEY     new key for rekey

Options:
  -o, --out <path>         output file, directory, or "-" for stdout (single input)
  --format <png|jpeg|jxl>  output format (default: same as the input when possible, else png)
  --mode <pixel|block|mcu> PNG: pixel (default) or block. JPEG: always mcu. JPEG XL: pixel/block
                           (lossless pixels) or mcu (JPEG route: a DCT-scrambled JPEG inside
                           the JXL; the default for JPEG sources)
  --block <n>              tile size in block mode (default 8)
  --effort <1-9>           JPEG XL encoder effort (default 2 in pixel mode, 7 in block mode)
  --no-transforms          JPEG: shuffle MCUs only, without flipping/rotating them
  --quality <1-100>        JPEG quality when converting to JPEG (default 90)
  --subsampling <s>        JPEG chroma subsampling when converting: 4:2:0 (default), 4:2:2, 4:4:4
  --background <#rrggbb>   JPEG: colour transparency is flattened onto (default #ffffff)
  --keep-thumbnails        keep embedded previews (they show the UNSCRAMBLED image)
  --level <0-9>            zlib level for PNG output
  --in-place               rekey: overwrite the input
  -f, --force              overwrite existing outputs
  --no-sharp               do not use sharp even if installed
  -q, --quiet              only print errors
  --json                   inspect: machine-readable output
  -h, --help

Input "-" reads stdin. Without -o, outputs go next to the input:
  photo.jpg -> photo.scrambled.jpg   (encode; .png with --format png)
  photo.scrambled.jpg -> photo.jpg   (decode)
  photo.scrambled.jpg -> photo.scrambled.rekeyed.jpg (rekey, unless --in-place)`;

const OPTIONS = {
  key: { type: 'string', short: 'k' },
  'key-file': { type: 'string' },
  to: { type: 'string' },
  'to-file': { type: 'string' },
  out: { type: 'string', short: 'o' },
  mode: { type: 'string' },
  block: { type: 'string' },
  format: { type: 'string' },
  level: { type: 'string' },
  effort: { type: 'string' },
  quality: { type: 'string' },
  subsampling: { type: 'string' },
  background: { type: 'string' },
  'no-transforms': { type: 'boolean' },
  'keep-thumbnails': { type: 'boolean' },
  'in-place': { type: 'boolean' },
  force: { type: 'boolean', short: 'f' },
  'no-sharp': { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

class UsageError extends Error {}

const PAST = { encode: 'encoded', decode: 'decoded', rekey: 're-keyed' };

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values: o, positionals } = parsed;
  const [command, ...files] = positionals;
  if (o.help || !command) { console.log(USAGE); return 0; }
  if (!['encode', 'decode', 'rekey', 'inspect'].includes(command)) throw new UsageError(`Unknown command "${command}"`);
  if (!files.length) throw new UsageError('No input files');
  if (files.filter((f) => f === '-').length > 1) throw new UsageError('stdin ("-") can only be used once');
  if (o.out === '-' && files.length > 1) throw new UsageError('-o - (stdout) needs exactly one input');

  const log = o.quiet ? () => {} : (msg) => process.stderr.write(`${msg}\n`);
  if (command === 'inspect') return runInspect(files, o);

  const opts = await commandOptions(command, o);
  const outDir = await resolveOutDir(o.out, files.length);
  let failed = 0;
  for (const file of files) {
    try {
      const input = file === '-' ? await readStdin() : await readFile(file);
      const target = outputPath(command, file, o, outDir, outputFormat(command, input, opts));
      if (target !== '-' && !o.force && !(command === 'rekey' && o['in-place']) && (await exists(target))) {
        throw new PixmixError(`${target} exists (use --force to overwrite)`, 'EXISTS');
      }
      const { bytes, note } = await run(command, input, opts);
      await write(target, bytes, command === 'rekey' && o['in-place']);
      log(`${PAST[command]} ${file === '-' ? 'stdin' : file} -> ${target === '-' ? 'stdout' : target}  ${size(bytes.length)}${note ? `  (${note})` : ''}`);
    } catch (err) {
      failed++;
      process.stderr.write(`pixmix: ${file}: ${err.message}\n`);
    }
  }
  return failed ? 1 : 0;
}

async function commandOptions(command, o) {
  const opts = {};
  if (o.mode) opts.mode = o.mode;
  if (o.block) opts.block = int(o.block, '--block');
  if (o.level) opts.level = int(o.level, '--level');
  if (o.effort) opts.effort = int(o.effort, '--effort');
  if (o.format) opts.format = o.format === 'jpg' ? 'jpeg' : o.format;
  if (command !== 'encode') delete opts.format;
  if (o.quality) opts.quality = int(o.quality, '--quality');
  if (o.subsampling) opts.subsampling = o.subsampling;
  if (o.background) opts.background = o.background;
  if (o['no-transforms']) opts.transforms = false;
  if (o['keep-thumbnails']) opts.keepThumbnails = true;
  if (command === 'rekey') {
    opts.from = await keyFrom(o.key, o['key-file'], 'PIXMIX_KEY', 'old key (-k, --key-file or $PIXMIX_KEY)');
    opts.to = await keyFrom(o.to, o['to-file'], 'PIXMIX_NEW_KEY', 'new key (--to, --to-file or $PIXMIX_NEW_KEY)');
    if (opts.mode === 'pixel') delete opts.block;
  } else {
    opts.key = await keyFrom(o.key, o['key-file'], 'PIXMIX_KEY', 'key (-k, --key-file or $PIXMIX_KEY)');
  }
  if (command === 'encode' && !o['no-sharp']) {
    const sharp = await import('sharp').then((m) => m.default, () => null);
    // JPEG and GIF stay on the built-in decoders so the CLI, servers and browsers agree
    // pixel for pixel; sharp fills in the formats pixmix cannot decode itself.
    if (sharp) opts.decoders = [sharpDecoder(sharp, { formats: ['webp', 'avif', 'heic', 'tiff', 'jxl'] })];
  }
  return opts;
}

async function run(command, input, opts) {
  if (command === 'decode') return { bytes: await decodeAsync(input, opts) };
  if (command === 'rekey') return { bytes: await rekeyAsync(input, opts) };
  let report;
  const bytes = await encodeAsync(input, { ...opts, onConvert: (r) => { report = r; } });
  const bits = [];
  if (report.decoder !== 'none') {
    bits.push(`${report.from} -> ${report.format} via ${report.decoder}`);
    if (report.transferred.length) bits.push(`kept ${report.transferred.join(', ')}`);
  }
  if (report.dropped.length) bits.push(`dropped ${report.dropped.join(', ')}`);
  return { bytes, note: bits.join('; ') };
}

async function runInspect(files, o) {
  let failed = 0;
  const all = [];
  for (const file of files) {
    try {
      const info = inspect(file === '-' ? await readStdin() : await readFile(file));
      if (o.json) { all.push({ file, ...info }); continue; }
      const dims = info.width ? `${info.width}x${info.height}` : '';
      const scramble = info.scrambled ? `scrambled (${info.mode}${info.block ? ` ${info.block}px` : ''})` : 'not scrambled';
      console.log(`${file}: ${info.format} ${dims} ${scramble}`);
      const parts = info.chunks ?? info.segments ?? info.boxes;
      if (parts) console.log(`  ${info.chunks ? 'chunks' : info.segments ? 'segments' : 'boxes'}: ${parts.map((c) => c.type).join(' ')}`);
      if (info.metadata) console.log(`  metadata: ${info.metadata.join(', ') || 'none'}${info.orientation > 1 ? ` (orientation ${info.orientation})` : ''}`);
    } catch (err) {
      failed++;
      process.stderr.write(`pixmix: ${file}: ${err.message}\n`);
    }
  }
  if (o.json) console.log(JSON.stringify(files.length === 1 ? all[0] ?? null : all, null, 2));
  return failed ? 1 : 0;
}

const EXT = { png: 'png', jpeg: 'jpg', jxl: 'jxl' };

function outputFormat(command, input, opts) {
  const from = detectFormat(input);
  if (!from) throw new PixmixError('Unrecognised image format', 'UNSUPPORTED');
  return command === 'encode' ? targetFormat(from, opts.format) : from;
}

function outputPath(command, file, o, outDir, format) {
  if (o.out === '-') return '-';
  if (command === 'rekey' && o['in-place']) {
    if (file === '-') throw new PixmixError('--in-place cannot be used with stdin');
    return file;
  }
  if (o.out && !outDir) return o.out;
  const name = file === '-' ? 'stdin' : basename(file);
  const stem = name.slice(0, name.length - extname(name).length);
  const ext = EXT[format] ?? format;
  const out = command === 'encode' ? `${stem}.scrambled.${ext}`
    : command === 'decode' ? `${stem.replace(/\.scrambled$/, '') || stem}${stem.endsWith('.scrambled') ? '' : '.restored'}.${ext}`
    : `${stem}.rekeyed.${ext}`;
  return join(outDir ?? (file === '-' ? '.' : dirname(file)), out);
}

/** -o is a directory when it already is one, ends with "/", or there are several inputs. */
async function resolveOutDir(out, count) {
  if (!out || out === '-') return null;
  const isDir = out.endsWith('/') || count > 1 || (await stat(out).then((s) => s.isDirectory(), () => false));
  if (!isDir) return null;
  await mkdir(out, { recursive: true });
  return out;
}

async function keyFrom(value, file, env, what) {
  if (value !== undefined && file !== undefined) throw new UsageError(`Give the ${what.split(' (')[0]} only once`);
  if (value !== undefined) return value;
  if (file !== undefined) return (await readFile(file, 'utf8')).replace(/\r?\n$/, '');
  if (process.env[env]) return process.env[env];
  throw new UsageError(`Missing ${what}`);
}

async function write(target, bytes, atomic) {
  if (target === '-') { process.stdout.write(bytes); return; }
  if (!atomic) { await writeFile(target, bytes); return; }
  const tmp = `${target}.pixmix-tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, target);
}

async function readStdin() {
  const parts = [];
  for await (const chunk of process.stdin) parts.push(chunk);
  return new Uint8Array(Buffer.concat(parts));
}

const exists = (p) => stat(p).then(() => true, () => false);
const size = (n) => (n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(2)} MiB`);

function int(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`${name} must be an integer`);
  return n;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    if (err instanceof UsageError) {
      process.stderr.write(`pixmix: ${err.message}\nRun "pixmix --help" for usage.\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`pixmix: ${err.message}\n`);
      process.exitCode = 1;
    }
  },
);
