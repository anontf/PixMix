// Native PNG samples -> 8-bit RGBA for canvas animation frames.

export function toRGBA8(img, pixels) {
  const { width, height, depth, colorType } = img.ihdr;
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  const plte = img.chunks.find((c) => c.type === 'PLTE')?.data;
  const trns = img.chunks.find((c) => c.type === 'tRNS')?.data;
  const wide = depth === 16;
  const sample = (i) => (wide ? (pixels[i] << 8) | pixels[i + 1] : pixels[i]);
  const to8 = depth === 16 ? (v) => v >> 8 : depth < 8 ? (v) => (v * 255) / ((1 << depth) - 1) : (v) => v;
  const pb = img.pixelBytes;
  const key16 = (off) => (trns[off] << 8) | trns[off + 1];

  for (let p = 0, o = 0; p < n; p++, o += 4) {
    const i = p * pb;
    switch (colorType) {
      case 0: {
        const v = sample(i);
        out[o] = out[o + 1] = out[o + 2] = to8(v);
        out[o + 3] = trns && v === key16(0) ? 0 : 255;
        break;
      }
      case 2: {
        const s = wide ? 2 : 1;
        const r = sample(i), g = sample(i + s), b = sample(i + 2 * s);
        out[o] = to8(r); out[o + 1] = to8(g); out[o + 2] = to8(b);
        out[o + 3] = trns && r === key16(0) && g === key16(2) && b === key16(4) ? 0 : 255;
        break;
      }
      case 3: {
        const v = pixels[i];
        out[o] = plte[v * 3]; out[o + 1] = plte[v * 3 + 1]; out[o + 2] = plte[v * 3 + 2];
        out[o + 3] = trns && v < trns.length ? trns[v] : 255;
        break;
      }
      case 4: {
        const s = wide ? 2 : 1;
        out[o] = out[o + 1] = out[o + 2] = to8(sample(i));
        out[o + 3] = to8(sample(i + s));
        break;
      }
      default: {
        const s = wide ? 2 : 1;
        out[o] = to8(sample(i)); out[o + 1] = to8(sample(i + s));
        out[o + 2] = to8(sample(i + 2 * s)); out[o + 3] = to8(sample(i + 3 * s));
      }
    }
  }
  return out;
}
