// JPEG XL codec, loaded lazily through load.js so pages and servers that never see a JPEG
// XL file do not pay for the WASM. Two WASM modules, both pixmix's own small bindings:
//   - encoding: libjxl (native/libjxl, built WASM committed in native/libjxl/pkg), always
//     lossless here: 8/16-bit pixels with an ICC profile or sRGB, animations, and lossless
//     JPEG recompression. It runs anywhere, browsers included;
//   - decoding and JPEG reconstruction: jxl-oxide (native/jxl, built WASM committed in
//     native/jxl/pkg). libjxl's own decoder is not bit-exact through the published builds
//     (@jsquash/jxl's colour-converts even sRGB images, turning e.g. (4,255,0) into
//     (3,255,0)), and the published jxl-oxide-wasm package cannot reconstruct JPEGs.
//
// Where the .wasm files come from:
//   - dist bundles: next to this module (build.js copies them as pixmix-jxl-*.wasm);
//   - running from source: native/libjxl/pkg (encoder) and native/jxl/pkg (decoder);
//   - configureJxl({ encoderWasm, encoderWasmNoSimd, decoderWasm }): explicit URLs or
//     bytes, which win.
// The encoder comes in two builds, with WebAssembly SIMD (faster) and without (for engines
// that lack it); the one this engine can run is picked on first use.

import createEncoder from '../../../native/libjxl/pkg/pixmix_libjxl.mjs';
import initDecoder, {
  decode as decodeRaw, decodeAnimation as decodeAnimationRaw, reconstructJpeg as reconstructRaw, lastPanic, __pixmixReset,
} from '../../../native/jxl/pkg/pixmix_jxl.js';
import { iccSpace } from './icc.js';
import { PixmixError } from '../../core/params.js';
import { resolveLimits } from '../../core/limits.js';

/* global __PIXMIX_JXL_WASM__ */
const BUNDLED = typeof __PIXMIX_JXL_WASM__ !== 'undefined' ? __PIXMIX_JXL_WASM__ : null;

const overrides = {};
let encoder, decoder; // promises, created on first use
let decoderModule; // the compiled decoder, kept to start a fresh instance after a trap

/**
 * @param {{encoderWasm?: string|URL|Uint8Array, encoderWasmNoSimd?: string|URL|Uint8Array,
 *   decoderWasm?: string|URL|Uint8Array}} opts  encoderWasm is used where the engine has
 *   WebAssembly SIMD, encoderWasmNoSimd elsewhere
 */
export function configure(opts) {
  Object.assign(overrides, opts);
}

// The smallest module using a SIMD instruction (i8x16.splat of an i32.const 0; the same
// probe as wasm-feature-detect). Engines without SIMD (e.g. some WebKit builds) cannot even
// compile the SIMD encoder, so they get the plain one.
const SIMD_PROBE = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11);
export const hasSimd = () => {
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
};

const SOURCE = {
  enc: '../../../native/libjxl/pkg/pixmix_libjxl.wasm',
  encNoSimd: '../../../native/libjxl/pkg/pixmix_libjxl_nosimd.wasm',
  dec: '../../../native/jxl/pkg/pixmix_jxl_bg.wasm',
};
const OPTION = { enc: 'encoderWasm', encNoSimd: 'encoderWasmNoSimd', dec: 'decoderWasm' };

async function wasmBytes(which) {
  const given = overrides[OPTION[which]];
  if (given instanceof Uint8Array || given instanceof ArrayBuffer) return given;
  const url = new URL(given ?? (BUNDLED ? BUNDLED[which] : SOURCE[which]), import.meta.url);
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
 * to sRGB; without it they stay in the image's own colour space and `icc` describes it.
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
 * Every frame of an animated JPEG XL as full-canvas 8-bit RGBA, with delays as [ms, 1000].
 * Without `srgb` the pixels keep the image's colour space, which `icc` then describes (unless
 * `icc: false`, which saves decoding the first frame once more).
 * @returns {Promise<{width: number, height: number, frames: {data: Uint8Array, delay: [number, number]}[], plays: number, icc: Uint8Array|null}>}
 */
export async function decodeAnimation(bytes, { srgb = true, icc: wantIcc = !srgb, limits } = {}) {
  await ready();
  const l = wasmLimits(limits);
  const anim = guard(() => {
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
  // The ICC profile is the same for every frame; the still-image call reports it.
  const icc = wantIcc && !srgb ? (await decode(bytes, { srgb: false, limits })).icc : null;
  return { ...anim, icc };
}

/** The original JPEG of a losslessly recompressed JPEG XL, or null if it is not one. */
export async function reconstructJpeg(bytes, { limits } = {}) {
  await ready();
  const l = wasmLimits(limits);
  return guard(() => reconstructRaw(bytes, l.maxPixels, l.alloc)) ?? null;
}

/**
 * Runs a call into the decoder, turning what it throws into a PixmixError: its own errors
 * are strings ("LIMIT: …" for a limit), and a Rust panic or running out of WASM memory
 * aborts the call as a bare RuntimeError, whose message the panic hook kept.
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
    if (typeof err !== 'string') throw err; // not from the decoder: a bug on this side
    if (err.startsWith('LIMIT: ')) throw new PixmixError(err.slice(7), 'LIMIT');
    throw new PixmixError(`JPEG XL decoder failed: ${err}`, 'BAD_JXL');
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

// --- encoding (libjxl) ---------------------------------------------------------------

// libjxl's JxlEncoderError codes, for messages.
const ENC_ERRORS = { 1: 'generic error', 2: 'out of memory', 3: 'JPEG bitstream reconstruction data could not be written', 4: 'bad input', 0x80: 'unsupported feature', 0x81: 'API misuse' };

const loadEncoder = () => (encoder ??= wasmBytes(hasSimd() ? 'enc' : 'encNoSimd').then((wasmBinary) => createEncoder({ wasmBinary })).catch((err) => {
  encoder = null;
  throw err;
}));

/**
 * Runs one encode on a fresh libjxl encoder; `feed(m, e, copyIn)` adds the input. libjxl's
 * own errors (a bad JPEG to recompress, say) become PixmixErrors with `code` JXL_ENCODE and
 * libjxl's number as `status`. A trap (an abort, or running out of WASM memory) leaves the
 * module unusable, so it is dropped and the next call loads a fresh one.
 */
async function runEncoder({ effort = 7, container = false, distance = 0 }, feed) {
  const m = await loadEncoder();
  const fail = (message, status) => Object.assign(new PixmixError(message, 'JXL_ENCODE'), status ? { status } : {});
  const buffers = [];
  let e = 0;
  try {
    e = m._pmx_new(effort, container ? 1 : 0, distance);
    if (!e) throw fail('JPEG XL encoder could not be created (out of memory?)');
    const copyIn = (bytes) => {
      const p = m._pmx_malloc(bytes.length || 1);
      if (!p) throw fail('JPEG XL encoder is out of memory');
      buffers.push(p);
      m.HEAPU8.set(bytes, p);
      return p;
    };
    const check = (code, what) => {
      if (code) throw fail(`JPEG XL encoding failed (${what}: ${ENC_ERRORS[code] ?? `error ${code}`})`, code);
    };
    feed(m, e, copyIn, check);
    check(m._pmx_finish(e), 'finish');
    const p = m._pmx_out(e), n = m._pmx_out_len(e);
    return m.HEAPU8.slice(p, p + n);
  } catch (err) {
    if (err instanceof PixmixError) throw err;
    if (!(err instanceof WebAssembly.RuntimeError) && !/abort/i.test(err?.message ?? String(err))) throw err; // a bug on this side
    encoder = null;
    e = 0;
    buffers.length = 0;
    throw Object.assign(fail(`JPEG XL encoder failed: ${err?.message ?? err}`), { cause: err });
  } finally {
    for (const p of buffers) m._pmx_release(p);
    if (e) m._pmx_free(e);
  }
}

/**
 * The fewest channels that lose nothing: grey unless some pixel has colour, alpha unless
 * every pixel is opaque. An ICC profile pins the colour model (a GRAY profile needs grey
 * pixels, an RGB one colour ones); callers drop profiles that do not fit (see iccFits).
 */
function channelsOf(frames, max, iccSpace) {
  let grey = iccSpace !== 'RGB ', opaque = true;
  for (const d of frames) {
    for (let o = 0; o < d.length && (grey || opaque); o += 4) {
      if (grey && (d[o] !== d[o + 1] || d[o] !== d[o + 2])) grey = false;
      if (opaque && d[o + 3] !== max) opaque = false;
    }
  }
  if (iccSpace === 'GRAY') grey = true;
  return (grey ? 1 : 3) + (opaque ? 0 : 1);
}

// Tick rate for an animation: the delays' common denominator when that is small enough to
// keep them exact (GIF: 100, APNG: often 100 or 1000), else milliseconds.
function ticksPerSecond(delays) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  let tps = 1;
  for (const [, den] of delays) {
    tps = (tps / gcd(tps, den || 100)) * (den || 100);
    if (tps > 100000) return 1000;
  }
  return tps;
}

/**
 * Lossless by default: `{ width, height, data }` as RGBA (8-bit Uint8Array, or 16-bit
 * Uint16Array with `depth: 16`), tagged with `icc` (which must fit, see iccFits) or else
 * sRGB. With `frames` ([{data, delay: [num, den] seconds}], full-canvas 8-bit RGBA) and
 * `plays` (0 = forever) it writes an animation instead.
 * @param {{effort?: number, distance?: number}} [options] distance > 0 is lossy (tests only)
 * @returns {Promise<Uint8Array>} a bare codestream, or a container when it needs level 10
 *          (16-bit lossless); see container.js wrapCodestream
 */
export async function encode({ width, height, data, depth = 8, icc = null, frames = null, plays = 0 }, { effort = 7, distance = 0 } = {}) {
  const animated = !!frames;
  const list = animated ? frames : [{ data, delay: [0, 1] }];
  const bits = !animated && depth === 16 ? 16 : 8;
  const max = bits === 16 ? 65535 : 255;
  const channels = channelsOf(list.map((f) => f.data), max, icc ? iccSpace(icc) : null);
  const tps = animated ? ticksPerSecond(list.map((f) => f.delay)) : 1;
  return runEncoder({ effort, distance }, (m, e, copyIn, check) => {
    const iccPtr = icc ? copyIn(icc) : 0;
    check(m._pmx_image(e, width, height, channels, bits, iccPtr, icc ? icc.length : 0, animated ? 1 : 0, tps, 1, plays >>> 0), 'image header');
    let p = 0; // one frame buffer, reused (libjxl copies each frame in)
    for (const f of list) {
      const px = pack(f.data, width * height, channels, bits);
      if (p) m.HEAPU8.set(px, p);
      else p = copyIn(px);
      // Every frame is shown for at least one tick: JPEG XL folds zero-length frames into
      // the next one, which would change the frame count (and so the per-frame scramble).
      const ticks = Math.max(1, Math.round((f.delay[0] * tps) / (f.delay[1] || 100)));
      check(m._pmx_frame(e, p, px.length, animated ? ticks : 0), 'frame');
    }
  });
}

/** RGBA samples reduced to `channels` (1 grey, 2 grey+alpha, 3 RGB, 4 RGBA), as bytes. */
function pack(rgba, n, channels, bits) {
  const Out = bits === 16 ? Uint16Array : Uint8Array;
  let out;
  if (channels === 4) out = rgba instanceof Out ? rgba : Out.from(rgba);
  else {
    out = new Out(n * channels);
    for (let i = 0, o = 0; i < n; i++) {
      const s = i * 4;
      if (channels >= 3) { out[o++] = rgba[s]; out[o++] = rgba[s + 1]; out[o++] = rgba[s + 2]; }
      else out[o++] = rgba[s];
      if (channels === 2) out[o++] = rgba[s + 3];
    }
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength); // native (little) endian
}

/** Always true now: JPEG recompression runs in the bundled WASM, browsers included. */
export const canTranscode = () => true;

/**
 * Losslessly recompresses a JPEG into JPEG XL (the JPEG can be reconstructed bit for bit).
 * Like cjxl, the JPEG's Exif, XMP and JUMBF become boxes.
 * @returns {Promise<Uint8Array>} JPEG XL container
 */
export async function transcodeJpeg(jpeg, { effort = 7 } = {}) {
  return runEncoder({ effort, container: true }, (m, e, copyIn, check) => {
    check(m._pmx_jpeg(e, copyIn(jpeg), jpeg.length), 'JPEG recompression');
  });
}
