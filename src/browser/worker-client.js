// Runs compute() in a Web Worker when the page allows it, inline otherwise. One worker is
// shared by all reveals; requests queue inside it. If the worker cannot start (no Worker,
// a CSP that forbids it, the file missing) pixmix quietly falls back to the main thread.

import { compute } from './compute.js';
import { SCRIPT_BASE } from '../core/script-base.js';
import { PixmixError, WrongKeyError } from '../core/params.js';

/* global __PIXMIX_WORKER__ */
const WORKER = typeof __PIXMIX_WORKER__ !== 'undefined' ? __PIXMIX_WORKER__ : new URL('./worker.js', import.meta.url).href;

let worker = null;
let broken = false;
let nextId = 1;
const pending = new Map();

function start(url) {
  const target = new URL(url ?? WORKER, SCRIPT_BASE);
  // Workers must be same-origin; a same-origin module that imports a CDN copy is allowed.
  const sameOrigin = typeof location === 'undefined' || target.origin === location.origin;
  const src = sameOrigin ? target : URL.createObjectURL(new Blob([`import ${JSON.stringify(target.href)};`], { type: 'text/javascript' }));
  const w = new Worker(src, { type: 'module' });
  w.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.ok) p.resolve(data.result);
    else p.reject(rebuildError(data.error));
  };
  w.onerror = (e) => {
    e.preventDefault?.();
    broken = true;
    worker = null;
    for (const p of pending.values()) p.fallback();
    pending.clear();
  };
  return w;
}

function rebuildError({ name, message, code }) {
  if (code === 'WRONG_KEY') return new WrongKeyError();
  const err = code ? new PixmixError(message, code) : new Error(message);
  if (name && !code) err.name = name;
  return err;
}

/**
 * @param {Uint8Array} bytes
 * @param {{animated?: boolean, worker?: boolean|string, watermark?: object|'embedded'|null}} [opts]
 *        worker false: inline; a string: worker script URL
 */
export function computeAnywhere(bytes, key, { animated = true, worker: use = true, watermark = null } = {}) {
  const inline = () => compute(bytes, key, { animated, watermark });
  if (!use || broken || typeof Worker === 'undefined') return inline();
  try {
    worker ??= start(typeof use === 'string' ? use : undefined);
  } catch {
    broken = true;
    return inline();
  }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, fallback: () => inline().then(resolve, reject) });
    worker.postMessage({ id, bytes, key, animated, watermark }); // copied, so the fallback still has it
  });
}
