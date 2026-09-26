// Orientations (1-8, as in EXIF and the JPEG XL header) as pixel moves between the stored
// grid and the image as displayed. RGBA, any sample type.

/** The stored pixel shown at displayed (x, y), for a stored W x H grid, as its index. */
function storedIndex(o, W, H) {
  switch (o) {
    case 2: return (x, y) => y * W + (W - 1 - x);
    case 3: return (x, y) => (H - 1 - y) * W + (W - 1 - x);
    case 4: return (x, y) => (H - 1 - y) * W + x;
    case 5: return (x, y) => x * W + y;
    case 6: return (x, y) => (H - 1 - x) * W + y;
    case 7: return (x, y) => (H - 1 - x) * W + (W - 1 - y);
    case 8: return (x, y) => x * W + (W - 1 - y);
    default: return (x, y) => y * W + x;
  }
}

const valid = (o) => Number.isInteger(o) && o >= 2 && o <= 8;
const swaps = (o) => o >= 5;

function move(data, W, H, o, toDisplay) {
  const dw = swaps(o) ? H : W, dh = swaps(o) ? W : H;
  const at = storedIndex(o, W, H);
  const out = new data.constructor(data.length);
  for (let y = 0, d = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++, d += 4) {
      const s = at(x, y) * 4;
      const [from, to] = toDisplay ? [s, d] : [d, s];
      out[to] = data[from]; out[to + 1] = data[from + 1]; out[to + 2] = data[from + 2]; out[to + 3] = data[from + 3];
    }
  }
  return out;
}

/** Stored W x H RGBA as displayed: {width, height, data} (the input itself for 1). */
export function orientRgba(data, W, H, o) {
  if (!valid(o)) return { width: W, height: H, data };
  return { width: swaps(o) ? H : W, height: swaps(o) ? W : H, data: move(data, W, H, o, true) };
}

/** Displayed w x h RGBA back onto the stored grid: {width, height, data}. */
export function unorientRgba(data, w, h, o) {
  if (!valid(o)) return { width: w, height: h, data };
  const W = swaps(o) ? h : w, H = swaps(o) ? w : h;
  return { width: W, height: H, data: move(data, W, H, o, false) };
}
