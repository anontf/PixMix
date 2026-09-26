// Metadata tooling for Node (package export "pixmix/metadata"): policies, applying them to
// files, reading metadata, and the on-disk profile store. encode/decode/convert take a
// policy directly as their `metadata` option.

export {
  applyMetadata, applyMetadataAsync, applyJxlParts, readMetadata, normalizePolicy, normalizeProfile, formatProfile,
  PRESETS, PRESET_NAMES, KINDS, GROUPS,
} from './apply.js';
export { metadataProfileStore, loadMetadataPolicy, DEFAULT_PROFILES_DIR } from './profiles.js';
export { parseExif, writeExif } from './tiff.js';
export { XmpPacket } from './xmp.js';
export { describeIcc, isSrgbIcc, srgbProfile } from './icc.js';
