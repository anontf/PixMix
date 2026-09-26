#!/usr/bin/env node
// pixmix command line: encode / decode / rekey / inspect.

import { parseArgs } from 'node:util';
import { readFile, writeFile, rename, mkdir, stat, realpath, chmod, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { encodeAsync, decodeAsync, rekeyAsync, inspect, detectFormat, PixmixError } from '../src/index.js';
import { targetFormat } from '../src/convert/index.js';
import { sharpDecoder } from '../src/plugins/sharp.js';
import { loadWatermark } from '../src/watermark/store.js';
import { loadMetadataPolicy } from '../src/meta/profiles.js';
import { normalizePolicy } from '../src/meta/policy.js';

const USAGE = `Usage:
  pixmix encode  <file...> [options]   scramble images (any supported input -> PNG, JPEG or JPEG XL)
  pixmix decode  <file...> [options]   restore scrambled images
  pixmix rekey   <file...> [options]   change the key (and optionally the mode) losslessly
  pixmix inspect <file...> [--json]    show format, size, scramble info and the parsed metadata

Keys (prefer the file or environment forms; -k ends up in shell history):
  -k, --key <key>          key            --key-file <path>      read key from file (its bytes,
                                                                 without one trailing newline or a
                                                                 leading UTF-8 BOM, so a binary key
                                                                 must not start with EF BB BF)
  $PIXMIX_KEY              key (encode/decode), old key (rekey)
  --to <key> | --to-file <path> | $PIXMIX_NEW_KEY     new key for rekey

Options:
  -o, --out <path>         output file, directory, or "-" for stdout (single input); never
                           the same path for two inputs (e.g. a/x.png and b/x.png) in one run
  --format <png|jpeg|jxl>  output format (default: same as the input when possible, else png)
  --mode <pixel|block|mcu> PNG: block (default; small files) or pixel (~2x larger).
                           JPEG: always mcu. JPEG XL: pixel/block (lossless pixels) or mcu
                           (JPEG route: a DCT-scrambled JPEG inside the JXL; the default for
                           JPEG sources)
  --block <n>              tile size in block mode (default 16)
  --effort <1-9>           JPEG XL encoder effort (default 2 in pixel mode, 7 in block mode)
  --no-transforms          shuffle tiles/MCUs only, without flipping/rotating them
  --progressive | --baseline  JPEG scan structure (encode: default same as a JPEG source,
                           else baseline; decode: default as the original)
  --quality <1-100>        JPEG quality when converting to JPEG (default 90)
  --subsampling <s>        JPEG chroma subsampling when converting: 4:2:0 (default), 4:2:2, 4:4:4
  --background <#rrggbb>   JPEG: colour transparency is flattened onto (default #ffffff)
  --keep-thumbnails        keep embedded previews (they show the UNSCRAMBLED image)
  --level <0-9>            zlib level for PNG output

Watermarks (<wm> is an id in the watermarks directory, or a .json definition / compiled file):
  --watermark <wm>         decode: draw it on the restored image ("embedded": the one the
                           file carries). encode/rekey: carry it, for decoders to draw
  --watermark-ref          encode/rekey: carry only the watermark's id (decoders look it up)
  --visible-watermark <wm> encode/rekey: draw it on the scrambled image too (restoring
                           stays exact: the pixels under it are kept, encrypted, in the file)
  --no-watermark           rekey: remove both watermarks
  --watermarks <dir>       watermarks directory (default: $PIXMIX_WATERMARKS_DIR or pixmix's own)

Metadata (<policy> is a preset: keep, strip-all, privacy, web; a profile id in the
metadata profiles directory; or a .json file holding a profile or a policy):
  --metadata <policy>      encode: the scrambled file's metadata. decode: the restored
                           file's. rekey: apply it again (default: keep what the file has)
  --metadata-profiles <dir>  profiles directory (default: $PIXMIX_METADATA_PROFILES_DIR or pixmix's own)
  --in-place               rekey: overwrite the input (a symlink's target; permissions kept)
  -f, --force              overwrite existing outputs
  --no-sharp               do not use sharp even if installed
  --max-pixels <n>         refuse images (or frames) larger than n pixels (default 100000000)
  --max-frames <n>         refuse animations with more than n frames (default 1000)
  --max-input-bytes <n>    refuse input files larger than n bytes (default 268435456)
  -q, --quiet              only print errors
  --json                   inspect: machine-readable output
  -h, --help

Input "-" reads stdin. Without -o, outputs go next to the input:
  photo.jpg -> photo.scrambled.jpg   (encode; .png with --format png)
  photo.scrambled.jpg -> photo.jpg   (decode)
  photo.scrambled.jpg -> photo.scrambled.rekeyed.jpg (rekey, unless --in-place)

Options that do not apply to the command are usage errors.
Exit codes: 0 success, 1 some files failed (the others are still processed), 2 usage error.`;

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
  progressive: { type: 'boolean' },
  baseline: { type: 'boolean' },
  'keep-thumbnails': { type: 'boolean' },
  watermark: { type: 'string' },
  'watermark-ref': { type: 'boolean' },
  'visible-watermark': { type: 'string' },
  'no-watermark': { type: 'boolean' },
  watermarks: { type: 'string' },
  metadata: { type: 'string' },
  'metadata-profiles': { type: 'string' },
  'in-place': { type: 'boolean' },
  force: { type: 'boolean', short: 'f' },
  'no-sharp': { type: 'boolean' },
  'max-pixels': { type: 'string' },
  'max-frames': { type: 'string' },
  'max-input-bytes': { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

class UsageError extends Error {}

// Options each command uses (besides COMMON: keys, -o, -f, --no-sharp, --max-*, -q, -h); any other
// is a usage error rather than silently ignored.
const SCRAMBLE = ['mode', 'block', 'level', 'effort', 'no-transforms', 'progressive', 'baseline', 'watermark', 'watermark-ref',
  'visible-watermark', 'watermarks', 'metadata', 'metadata-profiles'];
const APPLIES = {
  encode: [...SCRAMBLE, 'format', 'quality', 'subsampling', 'background', 'keep-thumbnails'],
  decode: ['level', 'effort', 'progressive', 'baseline', 'watermark', 'watermarks', 'metadata', 'metadata-profiles'],
  rekey: [...SCRAMBLE, 'no-watermark', 'in-place', 'to', 'to-file'],
  inspect: ['json'],
};
const COMMON = ['key', 'key-file', 'out', 'force', 'no-sharp', 'max-pixels', 'max-frames', 'max-input-bytes', 'quiet', 'help'];

function checkApplicable(command, o) {
  const allowed = new Set([...APPLIES[command], ...(command === 'inspect' ? ['max-pixels', 'max-frames', 'max-input-bytes', 'quiet', 'help'] : COMMON)]);
  const extra = Object.keys(o).filter((k) => !allowed.has(k));
  if (extra.length) throw new UsageError(`${extra.map((k) => `--${k}`).join(', ')} ${extra.length > 1 ? 'do' : 'does'} not apply to ${command}`);
  if (o['in-place'] && o.out !== undefined) throw new UsageError('Use either --in-place or -o');
}

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
  checkApplicable(command, o);
  if (!files.length) throw new UsageError('No input files');
  if (files.filter((f) => f === '-').length > 1) throw new UsageError('stdin ("-") can only be used once');
  if (o.out === '-' && files.length > 1) throw new UsageError('-o - (stdout) needs exactly one input');

  const log = o.quiet ? () => {} : (msg) => process.stderr.write(`${msg}\n`);
  if (command === 'inspect') return runInspect(files, o, limitsFrom(o));

  const opts = await commandOptions(command, o);
  const outDir = await resolveOutDir(o.out, files.length);
  let failed = 0;
  const written = new Map(); // output path -> the input it was written for, in this run
  for (const file of files) {
    try {
      const input = file === '-' ? await readStdin() : await readFile(file);
      const target = outputPath(command, file, o, outDir, outputFormat(command, input, opts));
      // Two inputs with one output name (a/x.png and b/x.png into one directory, or x.png
      // and x.gif): the second would overwrite the first's output, even with --force.
      const key = target === '-' ? null : resolve(target);
      if (key && written.has(key)) throw new PixmixError(`${target} was already written for ${written.get(key)} in this run`, 'EXISTS');
      if (target !== '-' && !o.force && !(command === 'rekey' && o['in-place']) && (await exists(target))) {
        throw new PixmixError(`${target} exists (use --force to overwrite)`, 'EXISTS');
      }
      if (key) written.set(key, file);
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
  if (o.block) opts.block = int(o.block, '--block', 2, 4096);
  if (o.level) opts.level = int(o.level, '--level', 0, 9);
  if (o.effort) opts.effort = int(o.effort, '--effort', 1, 9);
  if (o.format) opts.format = o.format === 'jpg' ? 'jpeg' : o.format;
  if (o.quality) opts.quality = int(o.quality, '--quality', 1, 100);
  if (o.subsampling) opts.subsampling = o.subsampling;
  if (o.background) opts.background = o.background;
  if (o['no-transforms']) opts.transforms = false;
  if (o.progressive && o.baseline) throw new UsageError('Use either --progressive or --baseline');
  if (o.progressive) opts.progressive = true;
  if (o.baseline) opts.progressive = false;
  if (o['keep-thumbnails']) opts.keepThumbnails = true;
  opts.limits = limitsFrom(o);
  Object.assign(opts, await watermarkOptions(command, o));
  if (o.metadata !== undefined) opts.metadata = await metadataPolicy(o.metadata, o['metadata-profiles']);
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
    if (sharp) opts.decoders = [sharpDecoder(sharp, { formats: ['webp', 'avif', 'heic', 'tiff'] })];
  }
  return opts;
}

async function watermarkOptions(command, o) {
  const load = (ref) => loadWatermark(ref, { dir: o.watermarks }).catch((err) => {
    throw new UsageError(`watermark "${ref}": ${err.message}`);
  });
  const out = {};
  if (o['no-watermark']) {
    if (command !== 'rekey') throw new UsageError('--no-watermark only applies to rekey');
    if (o.watermark || o['visible-watermark']) throw new UsageError('Use either --no-watermark or --watermark / --visible-watermark');
    return { watermark: null, visibleWatermark: null };
  }
  if (o['visible-watermark']) {
    if (command === 'decode') throw new UsageError('--visible-watermark applies to encode and rekey');
    out.visibleWatermark = await load(o['visible-watermark']);
  }
  if (o.watermark) {
    if (command === 'decode' && o.watermark === 'embedded') out.watermark = 'embedded';
    else {
      const wm = await load(o.watermark);
      out.watermark = o['watermark-ref'] && command !== 'decode' ? { id: wm.id } : wm;
    }
    if (command === 'decode') out.resolveWatermark = (id) => loadWatermark(id, { dir: o.watermarks });
  } else if (o['watermark-ref']) throw new UsageError('--watermark-ref needs --watermark');
  return out;
}

/** A --metadata reference as a validated policy (a usage error when it is not one). */
async function metadataPolicy(ref, dir) {
  try {
    return normalizePolicy(await loadMetadataPolicy(ref, { dir }));
  } catch (err) {
    throw new UsageError(`metadata "${ref}": ${err.message}`);
  }
}

async function run(command, input, opts) {
  let meta = null;
  const onMetadata = (r) => { meta = r; };
  if (command === 'decode') return { bytes: await decodeAsync(input, { ...opts, onMetadata }), note: describeMetadata(meta) };
  if (command === 'rekey') return { bytes: await rekeyAsync(input, { ...opts, onMetadata }), note: describeMetadata(meta) };
  let report;
  const bytes = await encodeAsync(input, { ...opts, onConvert: (r) => { report = r; } });
  const bits = [];
  if (report.decoder !== 'none') {
    bits.push(`${report.from} -> ${report.format} via ${report.decoder}`);
    if (report.transferred.length) bits.push(`kept ${report.transferred.join(', ')}`);
  }
  if (report.dropped.length) bits.push(`dropped ${report.dropped.join(', ')}`);
  if (report.notes?.length) bits.push(`note: ${report.notes.join('; ')}`);
  if (report.metadata) bits.push(describeMetadata(report.metadata));
  return { bytes, note: bits.join('; ') };
}

/** One line for what a metadata policy did. */
function describeMetadata(r) {
  if (!r) return '';
  const bits = [];
  if (r.removed.length) bits.push(`removed ${r.removed.join(', ')}`);
  if (r.set.length) bits.push(`set ${r.set.join(', ')}`);
  if (r.notes.length) bits.push(`note: ${r.notes.join('; ')}`);
  return `metadata (${r.policy}): ${bits.join('; ') || 'nothing to change'}`;
}

async function runInspect(files, o, limits) {
  let failed = 0;
  const all = [];
  for (const file of files) {
    try {
      const info = inspect(file === '-' ? await readStdin() : await readFile(file), { limits, metadata: true });
      if (o.json) { all.push({ file, ...info }); continue; }
      const dims = info.width ? `${info.width}x${info.height}` : '';
      const scramble = info.scrambled ? `scrambled (${info.mode}${info.block ? ` ${info.block}px` : ''})` : 'not scrambled';
      console.log(`${file}: ${info.format} ${dims} ${scramble}`);
      const parts = info.chunks ?? info.segments ?? info.boxes;
      if (parts) console.log(`  ${info.chunks ? 'chunks' : info.segments ? 'segments' : 'boxes'}: ${parts.map((c) => c.type).join(' ')}`);
      if (info.metadata) console.log(`  metadata: ${info.metadata.join(', ') || 'none'}${info.orientation > 1 ? ` (orientation ${info.orientation})` : ''}`);
      if (info.watermark?.unreadable) console.log(`  watermark: unreadable (${info.watermark.error})`);
      else if (info.watermark) console.log(`  watermark: ${info.watermark.id}${info.watermark.embedded ? '' : ' (id only)'}`);
      if (info.visibleWatermark) console.log('  visible watermark on the scrambled image');
      if (info.meta) for (const line of metadataLines(info.meta)) console.log(`  ${line}`);
    } catch (err) {
      failed++;
      process.stderr.write(`pixmix: ${file}: ${err.message}\n`);
    }
  }
  if (o.json) console.log(JSON.stringify(files.length === 1 ? all[0] ?? null : all, null, 2));
  return failed ? 1 : 0;
}

/** inspect's parsed metadata, a line per block (long values cut short). */
function metadataLines(m) {
  const show = (v) => {
    const s = typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : v && typeof v === 'object' ? (v.bytes !== undefined && Object.keys(v).length === 1 ? `(${v.bytes} bytes)` : JSON.stringify(v)) : String(v);
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
  };
  const lines = [];
  if (m.exif?.error) lines.push(`EXIF: ${m.exif.error}`);
  else if (m.exif) {
    const byIfd = new Map();
    for (const t of m.exif.tags) byIfd.set(t.ifd, [...(byIfd.get(t.ifd) ?? []), `${t.name}=${show(t.value)}`]);
    for (const [ifd, tags] of byIfd) lines.push(`EXIF ${ifd}: ${tags.join(' | ')}`);
    if (!m.exif.tags.length) lines.push('EXIF: no tags');
  }
  if (m.xmp?.error) lines.push(`XMP: ${m.xmp.error}`);
  else if (m.xmp) lines.push(`XMP: ${m.xmp.properties.map((p) => `${p.name}=${show(p.value)}`).join(' | ') || 'no properties'}${m.xmp.extended ? ` (+${m.xmp.extended} extended)` : ''}`);
  if (m.icc?.source === 'codestream') lines.push(`ICC: in the codestream (${m.icc.srgb === true ? 'sRGB' : m.icc.srgb === false ? 'not sRGB' : 'unknown'})`);
  else if (m.icc) lines.push(`ICC: ${m.icc.error ?? `"${m.icc.description ?? 'unnamed'}" v${m.icc.version} ${m.icc.class} ${m.icc.colourSpace}${m.icc.srgb ? ' (sRGB)' : ''}, ${m.icc.bytes} bytes`}`);
  if (m.colour.length) lines.push(`colour: ${m.colour.map((c) => `${c.type}=${show(c.value)}`).join(' | ')}`);
  if (m.density) lines.push(`density: ${m.density.x}x${m.density.y} per ${m.density.unit}`);
  for (const t of m.text) lines.push(`text ${t.keyword}: ${show(t.text)}`);
  if (m.iptc?.length) lines.push(`IPTC: ${m.iptc.map((d) => `${d.name}=${show(d.value)}`).join(' | ')}`);
  if (m.other.length) lines.push(`other: ${m.other.map((o) => `${o.label ?? o.type}${o.value ? ` ${o.value}` : ''} (${o.bytes} bytes)`).join(', ')}`);
  if (m.pixmix.length) lines.push(`pixmix: ${m.pixmix.join(', ')}`);
  return lines;
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
  const name = what.split(' (')[0];
  if (value !== undefined && file !== undefined) throw new UsageError(`Give the ${name} only once`);
  if (value === '') throw new UsageError(`The ${name} is empty`);
  if (value !== undefined) return value;
  if (file !== undefined) return keyFile(file, name);
  if (process.env[env]) return process.env[env];
  throw new UsageError(`Missing ${what}`);
}

/**
 * A key file's bytes, as they are (so binary keys work, and a text file gives the same key
 * as the text itself): only one trailing newline and a leading UTF-8 BOM are removed.
 */
async function keyFile(file, name) {
  let bytes;
  try {
    bytes = new Uint8Array(await readFile(file));
  } catch (err) {
    throw new UsageError(`Cannot read the ${name} file ${file}: ${err.code === 'ENOENT' ? 'no such file' : err.message}`);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  if (bytes.at(-1) === 0x0a) bytes = bytes.subarray(0, bytes.at(-2) === 0x0d ? -2 : -1);
  if (!bytes.length) throw new UsageError(`The ${name} file ${file} is empty`);
  return bytes;
}

/**
 * `inPlace` replaces the file atomically: a symlink's target (the link stays a link), with
 * the permissions it had.
 */
async function write(target, bytes, inPlace) {
  if (target === '-') { process.stdout.write(bytes); return; }
  if (!inPlace) { await writeFile(target, bytes); return; }
  const real = await realpath(target);
  const { mode } = await stat(real);
  const tmp = `${real}.pixmix-tmp`;
  try {
    await writeFile(tmp, bytes, { mode });
    await chmod(tmp, mode); // writeFile's mode is filtered by the umask
    await rename(tmp, real);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function readStdin() {
  const parts = [];
  for await (const chunk of process.stdin) parts.push(chunk);
  return new Uint8Array(Buffer.concat(parts));
}

const exists = (p) => stat(p).then(() => true, () => false);
const size = (n) => (n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(2)} MiB`);

/** The --max-* options as pixmix limits ("Infinity" turns one off). */
function limitsFrom(o) {
  const limits = {};
  for (const [flag, key] of [['max-pixels', 'maxPixels'], ['max-frames', 'maxFrames'], ['max-input-bytes', 'maxInputBytes']]) {
    if (o[flag] === undefined) continue;
    const n = Number(o[flag]);
    if (!(n > 0) || (!Number.isInteger(n) && n !== Infinity)) throw new UsageError(`--${flag} must be a positive integer (or Infinity)`);
    limits[key] = n;
  }
  return limits;
}

function int(v, name, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`${name} must be an integer from ${min} to ${max}`);
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
