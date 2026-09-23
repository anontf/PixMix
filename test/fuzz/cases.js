// One fuzz case: pick a seed file, mutate it, and run everything a server or a website
// would run on it. Shared by the worker and by in-process reproduction (PIXMIX_FUZZ_CASE).

import { rng, caseSeed, mutate } from './mutate.js';
import { fuzzWatermark } from './fixtures.js';

// Small limits keep each case fast; the fuzzer is after crashes, not big images.
export const FUZZ_LIMITS = {
  maxPixels: 1_000_000,
  maxTotalPixels: 4_000_000,
  maxFrames: 64,
  maxInputBytes: 4 * 2 ** 20,
  maxDecompressedBytes: 32 * 2 ** 20,
  maxMetadataBytes: 2 ** 20,
  maxChunks: 10_000,
  maxScans: 64,
};

/**
 * Loads the pixmix build under test (src/ of this checkout by default; PIXMIX_FUZZ_SRC can
 * point at another copy, e.g. an older commit, to see what the fuzzer finds there).
 */
export async function loadTarget(srcUrl) {
  const [api, compute, sharpPlugin, params, png, markers, jpeg, sharp] = await Promise.all([
    import(new URL('index.js', srcUrl)),
    import(new URL('browser/compute.js', srcUrl)),
    import(new URL('plugins/sharp.js', srcUrl)),
    import(new URL('core/params.js', srcUrl)),
    import(new URL('formats/png/index.js', srcUrl)),
    import(new URL('formats/jpeg/markers.js', srcUrl)),
    import(new URL('formats/jpeg/decode.js', srcUrl)),
    import('sharp').then((m) => m.default),
  ]);
  return {
    ...api,
    compute: compute.compute,
    readPng: png.readPng,
    readSegments: markers.readSegments,
    decodeFrame: jpeg.decodeFrame,
    PixmixError: params.PixmixError,
    decoders: [sharpPlugin.sharpDecoder(sharp, { formats: ['webp', 'avif', 'heic', 'tiff'] })],
  };
}

/** The mutated input of case `index`, and a description of how it was made. */
export function makeCase(fixtures, seed, index) {
  const r = rng(caseSeed(seed, index));
  const f = fixtures[r.weighted(fixtures.map((x) => x.weight))];
  const log = [];
  const bytes = mutate(f.bytes, r, log, fixtures.map((x) => x.bytes));
  return { fixture: f, bytes, log, r };
}

/**
 * Runs every operation on the mutant. Each one may succeed or throw a PixmixError;
 * anything else is returned as a failure.
 * @returns {Promise<{op: string, name: string, message: string, stack: string}[]>}
 */
export async function runCase(t, { fixture, bytes, r }, { key, onOp = () => {} } = {}) {
  const limits = FUZZ_LIMITS;
  const salt = new Uint8Array(16).fill(3);
  const decoders = t.decoders;
  const ops = [
    ['inspect', () => t.inspect(bytes, { limits })],
    ['encode', () => t.encode(bytes, { key, limits, salt })],
    ['encodeAsync', () => t.encodeAsync(bytes, { key, limits, salt, decoders, effort: 1 })],
    ['decode', () => t.decode(bytes, { key, limits })],
    ['decodeAsync', () => t.decodeAsync(bytes, { key, limits, effort: 1 })],
    ['compute', () => t.compute(bytes, key, { animated: true, limits })],
    // Watermarks: the one the file carries (ids resolve to the fuzz watermark), drawn in Node
    // and in the reveal, whose painting errors must be PixmixErrors too.
    ['decodeAsync:watermark', () => t.decodeAsync(bytes, { key, limits, effort: 1, watermark: true, resolveWatermark: () => fuzzWatermark() })],
    ['compute:watermark', () => t.compute(bytes, key, { animated: false, limits, watermark: r.chance(0.5) ? 'embedded' : fuzzWatermark() })],
  ];
  if (fixture.scrambled) ops.push(['rekeyAsync', () => t.rekeyAsync(bytes, { from: key, to: 'other', limits, salt, effort: 1 })]);
  // Converting to each output format covers the decoders and builders the defaults skip.
  const to = r.pick(['png', 'jpeg', 'jxl']);
  ops.push([`convertAsync:${to}`, () => t.convertAsync(bytes, { format: to, limits, decoders })]);
  // Whatever encode accepts must come back: decoding its output may not fail, and PNG pixels
  // and JPEG coefficients must be exactly the input's (pixmix promises lossless).
  if (!fixture.scrambled) ops.push(['roundtrip', () => roundtrip(t, bytes, { key, limits, salt })]);
  // And with a visible watermark on the scrambled image, restoring must still be exact.
  if (!fixture.scrambled && r.chance(0.5)) {
    ops.push(['roundtrip:visible', () => roundtrip(t, bytes, { key, limits, salt, watermark: fuzzWatermark(), visibleWatermark: fuzzWatermark() })]);
  }
  const failures = [];
  const record = (op, err) => failures.push({ op, name: err?.constructor?.name ?? typeof err, message: String(err?.message ?? err), stack: String(err?.stack ?? '') });
  for (const [op, run] of ops) {
    onOp(op);
    try {
      await run();
    } catch (err) {
      if (!(err instanceof t.PixmixError)) { record(op, err); continue; }
      // A wrapped programming error (a TypeError inside a plugin, say) is still a bug.
      if (PROGRAMMING_ERRORS.some((E) => err.cause instanceof E)) record(op, err.cause);
    }
  }
  return failures;
}

const PROGRAMMING_ERRORS = [TypeError, RangeError, ReferenceError, SyntaxError];

async function roundtrip(t, bytes, { key, limits, salt, ...extra }) {
  let scrambled;
  try {
    scrambled = t.encode(bytes, { key, limits, salt, ...extra });
  } catch (err) {
    if (err instanceof t.PixmixError) return; // refusing is fine
    throw err;
  }
  let restored;
  try {
    restored = t.decode(scrambled, { key, limits: { ...limits, maxInputBytes: Infinity } });
  } catch (err) {
    throw new Error(`roundtrip: pixmix cannot decode what it encoded: ${err.message}`, { cause: err });
  }
  const format = t.detectFormat(scrambled);
  const same = (a, b) => a.length === b.length && a.every((x, i) => Buffer.from(x).equals(Buffer.from(b[i])));
  if (format === 'png' && t.detectFormat(bytes) === 'png') {
    if (!same(t.readPng(bytes).frames, t.readPng(restored).frames)) throw new Error('roundtrip: PNG pixels differ');
  } else if (format === 'jpeg' && t.detectFormat(bytes) === 'jpeg') {
    const coefs = (b) => t.decodeFrame(t.readSegments(b).segments).components.map((c) => c.coefs);
    if (!same(coefs(bytes), coefs(restored))) throw new Error('roundtrip: JPEG coefficients differ');
  }
}
