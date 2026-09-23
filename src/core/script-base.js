// The URL pixmix was loaded from, for finding its companion files (worker, JPEG XL codec).
// import.meta.url is empty in the IIFE/CJS builds; there the running script stands in, which
// must be read while the bundle's top level runs (document.currentScript is null later).

export const SCRIPT_BASE = import.meta.url
  || (typeof document !== 'undefined' && document.currentScript?.src)
  || (typeof self !== 'undefined' && self.location?.href)
  || undefined;
