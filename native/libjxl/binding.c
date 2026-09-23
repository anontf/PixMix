// pixmix's JPEG XL encoder: a thin C layer over libjxl's encoder API, built to WebAssembly
// by scripts/build-libjxl-wasm.sh (output committed in native/libjxl/pkg). pixmix only
// writes lossless files: either pixels (8/16-bit grey, grey+alpha, RGB, RGBA, one frame or
// an animation, tagged sRGB or with an ICC profile), or a JPEG recompressed with its
// reconstruction data. (Lossy pixels, distance > 0, are there for making test inputs.)
//
// One encoder per call sequence, driven from JS (src/formats/jxl/codec.js):
//   e = pmx_new(effort, container, distance)
//   pmx_image(e, ...) then pmx_frame(e, ...) per frame      (pixels)
//   or pmx_jpeg(e, jpeg, len)                               (JPEG recompression)
//   pmx_finish(e); read pmx_out(e) / pmx_out_len(e); pmx_free(e)
// Calls return 0 on success, otherwise a JxlEncoderError code (or -1 for a bad argument).

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten.h>
#include <jxl/color_encoding.h>
#include <jxl/encode.h>

typedef struct {
  JxlEncoder *enc;
  JxlEncoderFrameSettings *fs;
  JxlPixelFormat format;
  float distance;
  int animated;
  uint8_t *out;
  size_t out_len;
} Enc;

static int fail(Enc *e) {
  int code = (int)JxlEncoderGetError(e->enc);
  return code ? code : -1;
}

#define CHECK(call) \
  if ((call) != JXL_ENC_SUCCESS) return fail(e)

// effort 1-10; container 1 forces the ISOBMFF container (needed for JPEG reconstruction
// data); distance 0 = lossless.
EMSCRIPTEN_KEEPALIVE Enc *pmx_new(int effort, int container, float distance) {
  Enc *e = calloc(1, sizeof(Enc));
  if (!e) return NULL;
  e->distance = distance;
  e->enc = JxlEncoderCreate(NULL);
  e->fs = e->enc ? JxlEncoderFrameSettingsCreate(e->enc, NULL) : NULL;
  if (!e->fs ||
      JxlEncoderFrameSettingsSetOption(e->fs, JXL_ENC_FRAME_SETTING_EFFORT, effort) != JXL_ENC_SUCCESS ||
      JxlEncoderUseContainer(e->enc, container ? JXL_TRUE : JXL_FALSE) != JXL_ENC_SUCCESS) {
    if (e->enc) JxlEncoderDestroy(e->enc);
    free(e);
    return NULL;
  }
  return e;
}

// channels: 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA; bits 8 or 16 (samples in native order).
// icc may be NULL (the image is then tagged sRGB). An animation (animated = 1) counts
// tps_num/tps_den ticks per second and plays `loops` times (0 = forever).
EMSCRIPTEN_KEEPALIVE int pmx_image(Enc *e, uint32_t width, uint32_t height, int channels, int bits,
                                   const uint8_t *icc, size_t icc_len, int animated,
                                   uint32_t tps_num, uint32_t tps_den, uint32_t loops) {
  if (channels < 1 || channels > 4 || (bits != 8 && bits != 16)) return -1;
  int alpha = channels == 2 || channels == 4;
  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize = width;
  info.ysize = height;
  info.bits_per_sample = bits;
  info.num_color_channels = channels >= 3 ? 3 : 1;
  info.num_extra_channels = alpha;
  info.alpha_bits = alpha ? bits : 0;
  info.uses_original_profile = e->distance > 0 ? JXL_FALSE : JXL_TRUE; // lossless needs it
  if (animated) {
    info.have_animation = JXL_TRUE;
    info.animation.tps_numerator = tps_num;
    info.animation.tps_denominator = tps_den;
    info.animation.num_loops = loops;
  }
  CHECK(JxlEncoderSetBasicInfo(e->enc, &info));
  if (icc && icc_len) {
    CHECK(JxlEncoderSetICCProfile(e->enc, icc, icc_len));
  } else {
    JxlColorEncoding colour;
    JxlColorEncodingSetToSRGB(&colour, channels < 3 ? JXL_TRUE : JXL_FALSE);
    CHECK(JxlEncoderSetColorEncoding(e->enc, &colour));
  }
  if (e->distance > 0) {
    CHECK(JxlEncoderSetFrameDistance(e->fs, e->distance));
  } else {
    CHECK(JxlEncoderSetFrameLossless(e->fs, JXL_TRUE));
  }
  e->format = (JxlPixelFormat){(uint32_t)channels, bits == 16 ? JXL_TYPE_UINT16 : JXL_TYPE_UINT8,
                               JXL_NATIVE_ENDIAN, 0};
  e->animated = animated;
  return 0;
}

// One full-size frame, interleaved as declared in pmx_image; duration in ticks (animations).
EMSCRIPTEN_KEEPALIVE int pmx_frame(Enc *e, const void *pixels, size_t len, uint32_t duration) {
  if (e->animated) {
    JxlFrameHeader header;
    JxlEncoderInitFrameHeader(&header);
    header.duration = duration;
    CHECK(JxlEncoderSetFrameHeader(e->fs, &header));
  }
  CHECK(JxlEncoderAddImageFrame(e->fs, &e->format, pixels, len));
  return 0;
}

// Lossless JPEG recompression with reconstruction data (jbrd). Like cjxl, the JPEG's Exif,
// XMP and JUMBF become boxes (left uncompressed, so they stay readable without Brotli).
EMSCRIPTEN_KEEPALIVE int pmx_jpeg(Enc *e, const uint8_t *jpeg, size_t len) {
  CHECK(JxlEncoderStoreJPEGMetadata(e->enc, JXL_TRUE));
  CHECK(JxlEncoderFrameSettingsSetOption(e->fs, JXL_ENC_FRAME_SETTING_JPEG_COMPRESS_BOXES, 0));
  CHECK(JxlEncoderAddJPEGFrame(e->fs, jpeg, len));
  return 0;
}

EMSCRIPTEN_KEEPALIVE int pmx_finish(Enc *e) {
  JxlEncoderCloseInput(e->enc);
  size_t cap = 1 << 16, used = 0;
  uint8_t *buf = malloc(cap);
  if (!buf) return -1;
  for (;;) {
    uint8_t *next = buf + used;
    size_t avail = cap - used;
    JxlEncoderStatus status = JxlEncoderProcessOutput(e->enc, &next, &avail);
    used = next - buf;
    if (status == JXL_ENC_SUCCESS) break;
    if (status != JXL_ENC_NEED_MORE_OUTPUT) {
      free(buf);
      return fail(e);
    }
    uint8_t *grown = realloc(buf, cap *= 2);
    if (!grown) {
      free(buf);
      return -1;
    }
    buf = grown;
  }
  e->out = buf;
  e->out_len = used;
  return 0;
}

EMSCRIPTEN_KEEPALIVE uint8_t *pmx_out(Enc *e) { return e->out; }
EMSCRIPTEN_KEEPALIVE size_t pmx_out_len(Enc *e) { return e->out_len; }

EMSCRIPTEN_KEEPALIVE void pmx_free(Enc *e) {
  if (!e) return;
  JxlEncoderDestroy(e->enc);
  free(e->out);
  free(e);
}

// Scratch memory for the JS side.
EMSCRIPTEN_KEEPALIVE void *pmx_malloc(size_t n) { return malloc(n); }
EMSCRIPTEN_KEEPALIVE void pmx_release(void *p) { free(p); }

// libjxl's version as major * 1000000 + minor * 1000 + patch.
EMSCRIPTEN_KEEPALIVE uint32_t pmx_version(void) { return JxlEncoderVersion(); }
