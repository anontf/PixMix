// Watermark tooling for Node (package export "pixmix/watermarks"): definitions, compiling,
// the on-disk store, and the renderer. Decoders and encoders take compiled watermarks.

export {
  normalizeDefinition, formatDefinition, formatJson, validateCompiled, ANCHORS, SHAPES, POSITIONS,
} from './schema.js';
export { compileWatermark, watermarkToSvg } from './compile.js';
export { watermarkStore, loadWatermark, DEFAULT_DIR } from './store.js';
export { renderWatermark, placeWatermark } from './render.js';
