// Entry for the <script> build. With a key on the tag, images reveal themselves:
//
//   <script src="pixmix-decoder.min.js" data-key="site-key" data-effect="blocks"></script>
//
// Also: data-duration, data-selector, and data-worker="false" to decode on the main thread.
//
// Without data-key nothing runs automatically; call PixMix.revealAll({ key }) instead.

import { revealAll } from './index.js';

export * from './index.js';

const script = typeof document !== 'undefined' ? document.currentScript : null;
if (script?.dataset.key) {
  const opts = {
    key: script.dataset.key,
    effect: script.dataset.effect,
    duration: script.dataset.duration ? Number(script.dataset.duration) : undefined,
    selector: script.dataset.selector,
    worker: script.dataset.worker === 'false' ? false : undefined, // data-worker="false"
  };
  for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
  const start = () => revealAll(opts);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
