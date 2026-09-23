// JPEG XL codec for 8-bit RGBA, loaded lazily through load.js so pages and servers that
// never see a JPEG XL file do not pay for the WASM:
//   - encoding: libjxl (the single-threaded build from @jsquash/jxl), always lossless here;
//   - decoding and JPEG reconstruction: jxl-oxide, through pixmix's own small binding
//     (native/jxl, built WASM committed in native/jxl/pkg). @jsquash/jxl's decoder is not
//     bit-exact (it colour-converts even sRGB images, turning e.g. (4,255,0) into
//     (3,255,0)), and the published jxl-oxide-wasm package cannot reconstruct JPEGs.
//
// Where the .wasm files come from:
//   - dist bundles: next to this module (build.js copies them as pixmix-jxl-*.wasm);
//   - running from source: node_modules (encoder) and native/jxl/pkg (decoder);
//   - configureJxl({ encoderWasm, decoderWasm }): explicit URLs or bytes, which win.
//
// Lossless JPEG -> JPEG XL transcoding (the JPEG-reconstruction route) needs libjxl's cjxl,
// which pixmix runs from the jxl-wasm package in a child process: servers only.

import encoderFactory from '@jsquash/jxl/codec/enc/jxl_enc.js';
import initDecoder, {
  decode as decodeRaw, decodeAnimation as decodeAnimationRaw, reconstructJpeg as reconstructRaw, lastPanic, __pixmixReset,
} from '../../../native/jxl/pkg/pixmix_jxl.js';
import { PixmixError } from '../../core/params.js';
import { resolveLimits } from '../../core/limits.js';

/* global __PIXMIX_JXL_WASM__ */
const BUNDLED = typeof __PIXMIX_JXL_WASM__ !== 'undefined' ? __PIXMIX_JXL_WASM__ : null;

// jxl_enc defaults (from @jsquash/jxl meta.js), with lossless on.
const ENCODE_DEFAULTS = {
  effort: 7, quality: 100, progressive: false, epf: -1, lossyPalette: false,
  decodingSpeedTier: 0, photonNoiseIso: 0, lossyModular: false, lossless: true,
};

const overrides = {};
let encoder, decoder; // promises, created on first use
let decoderModule; // the compiled decoder, kept to start a fresh instance after a trap

/** @param {{encoderWasm?: string|URL|Uint8Array, decoderWasm?: string|URL|Uint8Array}} opts */
export function configure(opts) {
  Object.assign(overrides, opts);
}

async function wasmBytes(which) {
  const given = overrides[which === 'enc' ? 'encoderWasm' : 'decoderWasm'];
  if (given instanceof Uint8Array || given instanceof ArrayBuffer) return given;
  const url = given
    ? new URL(given, import.meta.url)
    : BUNDLED
      ? new URL(BUNDLED[which], import.meta.url)
      : which === 'enc'
        ? new URL(import.meta.resolve('@jsquash/jxl/codec/enc/jxl_enc.wasm'))
        : new URL('../../../native/jxl/pkg/pixmix_jxl_bg.wasm', import.meta.url);
  const fs = globalThis.process?.getBuiltinModule?.('node:fs');
  if (url.protocol === 'file:' && fs) return fs.readFileSync(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load JPEG XL codec (${url}: ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

const ready = () => (decoder ??= (async () => {
  decoderModule ??= await WebAssembly.compile(await wasmBytes('dec'));
  return initDecoder({ module_or_path: decoderModule });
})().catch((err) => { decoder = null; throw err; }));

// jxl-oxide's buffers get this much per allowed pixel (it works in 32-bit planes, several of
// them for colour conversion and upsampling); WASM caps the total at 4 GiB anyway.
const ALLOC_PER_PIXEL = 64;

function wasmLimits(limits) {
  const l = resolveLimits(limits);
  return { maxPixels: l.maxPixels, maxFrames: l.maxFrames, maxTotal: l.maxTotalPixels, alloc: l.maxPixels * ALLOC_PER_PIXEL };
}

/**
 * First frame, orientation applied, as RGBA: 8-bit (`data` a Uint8Array), or with `high`
 * 16-bit (`data` a Uint16Array, `depth` 16). With `srgb` (default) the pixels are converted
 * to sRGB, matching what the encoder writes; without it they stay in the image's own colour
 * space and `icc` describes it.
 * @returns {Promise<{width: number, height: number, depth: 8|16, data: Uint8Array|Uint16Array, icc: Uint8Array|null}>}
 */
export async function decode(bytes, { srgb = true, high = false, limits } = {}) {
  await ready();
  const l = wasmLimits(limits);
  return guard(() => {
    const d = decodeRaw(bytes, srgb, high, l.maxPixels, l.alloc);
    try {
      const { width, height, channels } = d;
      const icc = d.icc;
      const px = high ? d.takePixels16() : d.takePixels();
      return { width, height, depth: high ? 16 : 8, data: toRgba(px, width * height, channels, high ? 65535 : 255), icc: icc.length ? icc : null };
    } finally {
      d.free();
    }
  });
}

/**
 * Every frame of an animated JPEG XL as full-canvas RGBA, with delays as [ms, 1000].
 * @returns {Promise<{width: number, height: number, frames: {data: Uint8Array, delay: [number, number]}[], plays: number}>}
 */
export async function decodeAnimation(bytes, { srgb = true, limits } = {}) {
  await ready();
  const l = wasmLimits(limits);
  return guard(() => {
    const a = decodeAnimationRaw(bytes, srgb, l.maxPixels, l.maxFrames, l.maxTotal, l.alloc);
    try {
      const { width, height, channels, count, loops } = a;
      const durations = a.durationsMs;
      const all = a.takePixels();
      const per = width * height * channels;
      const frames = [];
      for (let i = 0; i < count; i++) {
        frames.push({ data: toRgba(all.subarray(i * per, (i + 1) * per), width * height, channels), delay: [durations[i], 1000] });
      }
      return { width, height, frames, plays: loops };
    } finally {
      a.free();
    }
  });
}

/** The original JPEG of a losslessly recompressed JPEG XL, or null if it is not one. */
export async function reconstructJpeg(bytes, { limits } = {}) {
  await ready();
  const l = wasmLimits(limits);
  return guard(() => reconstructRaw(bytes, l.maxPixels, l.alloc)) ?? null;
}

/**
 * Runs a call into the decoder, turning whatever it throws into a PixmixError: its own
 * errors are strings ("LIMIT: …" for a limit), and a Rust panic or running out of WASM
 * memory aborts the call as a bare RuntimeError, whose message the panic hook kept.
 * After a trap the instance is dropped, and the next call starts a fresh one.
 * (jxl-oxide 0.12 panics reconstructing some progressive JPEGs; pixmix's own are baseline.)
 */
function guard(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof WebAssembly.RuntimeError) {
      const panic = lastPanicSafe();
      __pixmixReset();
      decoder = null;
      throw new PixmixError(`JPEG XL decoder failed: ${panic || err.message}`, 'BAD_JXL');
    }
    if (err instanceof PixmixError) throw err;
    const message = String(err?.message ?? err);
    if (message.startsWith('LIMIT: ')) throw new PixmixError(message.slice(7), 'LIMIT');
    throw new PixmixError(`JPEG XL decoder failed: ${message}`, 'BAD_JXL');
  }
}

function lastPanicSafe() {
  try {
    return lastPanic();
  } catch {
    return ''; // the instance is too broken to say
  }
}

function toRgba(px, n, channels, max = 255) {
  if (channels === 4) return px.slice();
  const out = new px.constructor(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4, s = i * channels;
    if (channels >= 3) { out[o] = px[s]; out[o + 1] = px[s + 1]; out[o + 2] = px[s + 2]; out[o + 3] = max; }
    else { out[o] = out[o + 1] = out[o + 2] = px[s]; out[o + 3] = channels === 2 ? px[s + 1] : max; }
  }
  return out;
}

/**
 * Lossless by default. @returns {Promise<Uint8Array>} bare codestream
 * An Emscripten module is unusable after an abort (e.g. out of memory), so a failure
 * drops it and the next call loads a fresh one.
 */
export async function encode({ width, height, data }, options = {}) {
  encoder ??= wasmBytes('enc').then((wasmBinary) => encoderFactory({ noInitialRun: true, wasmBinary }));
  let out;
  try {
    const m = await encoder;
    out = m.encode(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height, { ...ENCODE_DEFAULTS, ...options });
  } catch (err) {
    encoder = null;
    throw new PixmixError(`JPEG XL encoding failed: ${err?.message ?? err}`, 'JXL_ENCODE');
  }
  if (!out) throw new PixmixError('JPEG XL encoding failed', 'JXL_ENCODE');
  return new Uint8Array(out);
}

/* global __PIXMIX_CJXL__ */
const CJXL = typeof __PIXMIX_CJXL__ !== 'undefined' ? __PIXMIX_CJXL__ : null;

/** Whether this runtime can transcode JPEG to JPEG XL (Node, with cjxl available). */
export const canTranscode = () => !!globalThis.process?.getBuiltinModule?.('node:child_process');

/**
 * Losslessly recompresses a JPEG into JPEG XL (the JPEG can be reconstructed bit for bit).
 * Runs cjxl in a child process: that build of it calls process.exit, reads files, and
 * predates Node's global fetch (which it must not see).
 * @returns {Promise<Uint8Array>} JPEG XL container
 */
export async function transcodeJpeg(jpeg) {
  return runCjxl(jpeg, 'jpg');
}

/**
 * Runs cjxl on any input it understands (JPEG, PNG/APNG, GIF). Used for JPEG recompression,
 * and by the tests to make animated JPEG XL files.
 */
export async function runCjxl(input, ext, args = []) {
  if (!canTranscode()) throw new PixmixError('JPEG to JPEG XL transcoding needs Node (it runs libjxl cjxl); use mode "pixel" or "block" here', 'UNSUPPORTED');
  const get = (m) => globalThis.process.getBuiltinModule(m);
  const { spawn } = get('node:child_process');
  const fs = get('node:fs');
  const { join } = get('node:path');
  const { tmpdir } = get('node:os');
  const { fileURLToPath } = get('node:url');
  const cjxl = fileURLToPath(CJXL ? new URL(CJXL, import.meta.url) : import.meta.resolve('jxl-wasm/lib/cjxl.js'));
  const dir = fs.mkdtempSync(join(tmpdir(), 'pixmix-'));
  try {
    const inFile = join(dir, `in.${ext}`), output = join(dir, 'out.jxl');
    fs.writeFileSync(inFile, input);
    // cjxl 0.7: JPEG input is transcoded losslessly by default (-j would make it lossy).
    const argv = JSON.stringify(['node', 'cjxl', inFile, output, '--container', '--num_threads=0', '--quiet', ...args]);
    const runner = `delete globalThis.fetch; const c = process.argv[1]; process.argv = ${argv}; require(c);`;
    const { code, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(globalThis.process.execPath, ['-e', runner, cjxl], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (c) => resolve({ code: c, stderr: err }));
    });
    if (code !== 0 || !fs.existsSync(output)) throw new PixmixError(`cjxl failed (${code}): ${stderr.trim().split('\n').pop()}`, 'JXL_ENCODE');
    return new Uint8Array(fs.readFileSync(output));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
