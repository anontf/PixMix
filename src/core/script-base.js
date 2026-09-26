// The URL pixmix was loaded from, for finding its companion files (worker, JPEG XL codec).
// import.meta.url is empty in the IIFE/CJS builds; there the running script stands in, which
// must be read while the bundle's top level runs (document.currentScript is null later).

export const SCRIPT_BASE = import.meta.url
  || (typeof document !== 'undefined' && document.currentScript?.src)
  || (typeof self !== 'undefined' && self.location?.href)
  || undefined;

/**
 * A module URL given to one of the configure*() calls, made absolute (relative to `here`, as
 * import() there would resolve it) so that it means the same in a Web Worker. Bare
 * specifiers are left alone.
 */
export function absoluteModuleUrl(url, here) {
  const s = String(url);
  if (!/^(\.{0,2}\/|[a-z][a-z\d+.-]*:)/i.test(s)) return s;
  try {
    return new URL(s, here || SCRIPT_BASE).href;
  } catch {
    return s;
  }
}
