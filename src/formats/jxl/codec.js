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
import initDecoder, { decode as decodeRaw, reconstructJpeg as reconstructRaw, lastPanic } from '../../../native/jxl/pkg/pixmix_jxl.js';

/* global __PIXMIX_JXL_WASM__ */
const BUNDLED = typeof __PIXMIX_JXL_WASM__ !== 'undefined' ? __PIXMIX_JXL_WASM__ : null;

// jxl_enc defaults (from @jsquash/jxl meta.js), with lossless on.
const ENCODE_DEFAULTS = {
  effort: 7, quality: 100, progressive: false, epf: -1, lossyPalette: false,
  decodingSpeedTier: 0, photonNoiseIso: 0, lossyModular: false, lossless: true,
};

const overrides = {};
let encoder, decoder; // promises, created on first use

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

const ready = () => (decoder ??= wasmBytes('dec').then((wasm) => initDecoder({ module_or_path: wasm })));

/**
 * First frame, orientation applied, as 8-bit RGBA. With `srgb` (default) the pixels are
 * converted to sRGB, matching what the encoder writes; without it they stay in the image's
 * own colour space and `icc` describes it.
 * @returns {Promise<{width: number, height: number, data: Uint8Array, icc: Uint8Array|null}>}
 */
export async function decode(bytes, { srgb = true } = {}) {
  await ready();
  const d = guard(() => decodeRaw(bytes, srgb));
  try {
    const { width, height, channels } = d;
    const icc = d.icc;
    return { width, height, data: toRgba(d.takePixels(), width * height, channels), icc: icc.length ? icc : null };
  } finally {
    d.free();
  }
}

/** The original JPEG of a losslessly recompressed JPEG XL, or null if it is not one. */
export async function reconstructJpeg(bytes) {
  await ready();
  return guard(() => reconstructRaw(bytes)) ?? null;
}

// A Rust panic aborts the call as a bare RuntimeError; recover the message it left. (jxl-oxide
// 0.12 panics reconstructing some progressive JPEGs; pixmix's own JPEGs are baseline.)
function guard(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof WebAssembly.RuntimeError) throw new Error(`JPEG XL decoder failed: ${lastPanic() || err.message}`);
    throw new Error(`JPEG XL decoder failed: ${err?.message ?? err}`);
  }
}

function toRgba(px, n, channels) {
  if (channels === 4) return px;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4, s = i * channels;
    if (channels >= 3) { out[o] = px[s]; out[o + 1] = px[s + 1]; out[o + 2] = px[s + 2]; out[o + 3] = 255; }
    else { out[o] = out[o + 1] = out[o + 2] = px[s]; out[o + 3] = channels === 2 ? px[s + 1] : 255; }
  }
  return out;
}

/** Lossless by default. @returns {Promise<Uint8Array>} bare codestream */
export async function encode({ width, height, data }, options = {}) {
  encoder ??= wasmBytes('enc').then((wasmBinary) => encoderFactory({ noInitialRun: true, wasmBinary }));
  const m = await encoder;
  const out = m.encode(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height, { ...ENCODE_DEFAULTS, ...options });
  if (!out) throw new Error('JPEG XL encoding failed');
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
  if (!canTranscode()) throw new Error('JPEG to JPEG XL transcoding needs Node (it runs libjxl cjxl); use mode "pixel" or "block" here');
  const get = (m) => globalThis.process.getBuiltinModule(m);
  const { spawn } = get('node:child_process');
  const fs = get('node:fs');
  const { join } = get('node:path');
  const { tmpdir } = get('node:os');
  const { fileURLToPath } = get('node:url');
  const cjxl = fileURLToPath(CJXL ? new URL(CJXL, import.meta.url) : import.meta.resolve('jxl-wasm/lib/cjxl.js'));
  const dir = fs.mkdtempSync(join(tmpdir(), 'pixmix-'));
  try {
    const input = join(dir, 'in.jpg'), output = join(dir, 'out.jxl');
    fs.writeFileSync(input, jpeg);
    const runner = 'delete globalThis.fetch; const [c, i, o] = process.argv.slice(1);' +
      // cjxl 0.7: JPEG input is transcoded losslessly by default (-j would make it lossy).
      "process.argv = ['node', 'cjxl', i, o, '--container', '--num_threads=0', '--quiet']; require(c);";
    const { code, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(globalThis.process.execPath, ['-e', runner, cjxl, input, output], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (c) => resolve({ code: c, stderr: err }));
    });
    if (code !== 0 || !fs.existsSync(output)) throw new Error(`cjxl failed (${code}): ${stderr.trim().split('\n').pop()}`);
    return new Uint8Array(fs.readFileSync(output));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
