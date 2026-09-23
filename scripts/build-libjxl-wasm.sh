#!/bin/sh
# Rebuilds native/libjxl/pkg (the JPEG XL encoder WASM, with and without SIMD: libjxl plus
# native/libjxl/binding.c).
# Only needed after changing the binding or the pinned versions; the result is committed.
#
# Requirements: Linux x86-64 with curl, tar and python3 (no system compiler). Emscripten,
# CMake, Ninja, libjxl and its dependencies are downloaded on first run into a work
# directory outside the repository, $PIXMIX_LIBJXL_WORK (default ~/.cache/pixmix-libjxl).
#
#   BUILD_OPT=-O3 ./scripts/build-libjxl-wasm.sh   # default -Os (see README for the trade-off)
set -eu

LIBJXL_VERSION=0.12.0
LIBJXL_SHA256=03e9be69a30be4011f559da75328b6d7cea8ad921fabfbd551ce10bf45cdc992
EMSDK_VERSION=6.0.10
CMAKE_VERSION=3.31.8
NINJA_VERSION=1.12.1
OPT="${BUILD_OPT:--Os}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${PIXMIX_LIBJXL_WORK:-$HOME/.cache/pixmix-libjxl}"
mkdir -p "$WORK/bin"
cd "$WORK"

# --- tools ------------------------------------------------------------------------
if [ ! -x emsdk/emsdk ]; then
  curl -sSL "https://github.com/emscripten-core/emsdk/archive/refs/tags/$EMSDK_VERSION.tar.gz" | tar xz
  mv "emsdk-$EMSDK_VERSION" emsdk
fi
if [ ! -d "emsdk/upstream/emscripten" ] || ! grep -q "$EMSDK_VERSION" emsdk/upstream/emscripten/emscripten-version.txt 2>/dev/null; then
  emsdk/emsdk install "$EMSDK_VERSION"
  emsdk/emsdk activate "$EMSDK_VERSION"
fi
if [ ! -x bin/cmake ]; then
  curl -sSL "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VERSION/cmake-$CMAKE_VERSION-linux-x86_64.tar.gz" | tar xz
  rm -rf cmake && mv "cmake-$CMAKE_VERSION-linux-x86_64" cmake && ln -sf ../cmake/bin/cmake bin/cmake
fi
if [ ! -x bin/ninja ]; then
  curl -sSL -o ninja.zip "https://github.com/ninja-build/ninja/releases/download/v$NINJA_VERSION/ninja-linux.zip"
  python3 -c "import zipfile; zipfile.ZipFile('ninja.zip').extractall('bin')" && chmod +x bin/ninja
fi
EMSDK="$WORK/emsdk"
PATH="$WORK/bin:$EMSDK/upstream/emscripten:$PATH"

# --- sources: the release tarball, and the dependency commits its deps.sh pins ------------
SRC="libjxl-$LIBJXL_VERSION"
if [ ! -d "$SRC" ]; then
  curl -sSL -o "$SRC.tar.gz" "https://github.com/libjxl/libjxl/archive/refs/tags/v$LIBJXL_VERSION.tar.gz"
  echo "$LIBJXL_SHA256  $SRC.tar.gz" | sha256sum -c -
  tar xzf "$SRC.tar.gz"
fi
for dep in brotli:google/brotli highway:google/highway skcms:google/skcms; do
  name="${dep%%:*}" project="${dep#*:}"
  [ -n "$(ls -A "$SRC/third_party/$name")" ] && continue
  sha=$(sed -n "s/^THIRD_PARTY_$(echo "$name" | tr a-z A-Z)=\"\([0-9a-f]*\)\".*/\1/p" "$SRC/deps.sh")
  mkdir -p "$SRC/third_party/$name"
  curl -sSL "https://github.com/$project/tarball/$sha" | tar xz -C "$SRC/third_party/$name" --strip-components=1
done

# --- build ------------------------------------------------------------------------
# Two variants: with WebAssembly SIMD (pixmix_libjxl.*, used wherever the engine has it) and
# without (pixmix_libjxl_nosimd.*, for engines that lack it); codec.js picks at run time.
# Source paths (in assertion messages) are mapped to neutral prefixes so the committed
# binaries carry no home directory.
MAP="-ffile-prefix-map=$WORK/$SRC=libjxl -ffile-prefix-map=$EMSDK=emsdk -ffile-prefix-map=$REPO=pixmix"
OUT="${PIXMIX_LIBJXL_OUT:-$REPO/native/libjxl/pkg}"
mkdir -p "$OUT"

build_variant() { # name, extra compiler flags
  FLAGS="$OPT $2 -DNDEBUG $MAP"
  BUILD="build$OPT$1"
  emcmake cmake -S "$SRC" -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="$FLAGS" -DCMAKE_CXX_FLAGS="$FLAGS" \
    -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF -DJPEGXL_ENABLE_WASM_THREADS=OFF \
    -DJPEGXL_ENABLE_TOOLS=OFF -DJPEGXL_ENABLE_DOXYGEN=OFF -DJPEGXL_ENABLE_MANPAGES=OFF \
    -DJPEGXL_ENABLE_BENCHMARK=OFF -DJPEGXL_ENABLE_EXAMPLES=OFF -DJPEGXL_ENABLE_JNI=OFF \
    -DJPEGXL_ENABLE_SJPEG=OFF -DJPEGXL_ENABLE_OPENEXR=OFF \
    -DJPEGXL_ENABLE_SKCMS=ON -DJPEGXL_ENABLE_TCMALLOC=OFF \
    -DJPEGXL_ENABLE_PLUGINS=OFF -DJPEGXL_ENABLE_FUZZERS=OFF -DJPEGXL_ENABLE_DEVTOOLS=OFF \
    -DJPEGXL_FORCE_SYSTEM_BROTLI=OFF -DJPEGXL_FORCE_SYSTEM_HWY=OFF -DJPEGXL_BUNDLE_LIBPNG=OFF > "$BUILD.log"
  cmake --build "$BUILD" --target jxl jxl_cms >> "$BUILD.log"
  LIBS=$(find "$BUILD" -name 'libjxl.a' -o -name 'libjxl_cms.a' -o -name 'libhwy.a' -o -name 'libbrotlienc.a' -o -name 'libbrotlicommon.a' -o -name 'libskcms*.a' | sort)
  # ES module glue; pixmix always hands it the WASM bytes (wasmBinary), so it never fetches
  # or touches the file system, and it runs unchanged in Node, browsers and workers.
  emcc $FLAGS -I "$SRC/lib/include" -I "$BUILD/lib/include" -c "$REPO/native/libjxl/binding.c" -o "$BUILD/binding.o"
  em++ $FLAGS "$BUILD/binding.o" $LIBS -o "$OUT/pixmix_libjxl$1.mjs" \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createEncoder -sENVIRONMENT=web,worker \
    -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=1MB -sFILESYSTEM=0 \
    -sDYNAMIC_EXECUTION=0 -sINCOMING_MODULE_JS_API=wasmBinary -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
    -sASSERTIONS=0 -g0 --no-entry
  if strings "$OUT/pixmix_libjxl$1.wasm" "$OUT/pixmix_libjxl$1.mjs" | grep -q -e "$HOME" -e /home/; then
    echo "error: build output contains a home directory path" >&2; exit 1
  fi
}
build_variant "" -msimd128
build_variant _nosimd ""
# Both variants export the same functions, so one glue serves both (pixmix passes the
# bytes of whichever .wasm it picked); the glues differ only in the default file name.
if ! sed 's/pixmix_libjxl_nosimd\.wasm/pixmix_libjxl.wasm/g' "$OUT/pixmix_libjxl_nosimd.mjs" | cmp -s - "$OUT/pixmix_libjxl.mjs"; then
  echo "error: the SIMD and non-SIMD glue differ" >&2; exit 1
fi
rm "$OUT/pixmix_libjxl_nosimd.mjs"

# The licences that come with the binary: libjxl (BSD-3-Clause, plus its patent grant),
# Highway (BSD-3-Clause option of its dual licence), Brotli (MIT), skcms (BSD-3-Clause).
for f in libjxl:LICENSE libjxl:PATENTS highway:third_party/highway/LICENSE-BSD3 \
  brotli:third_party/brotli/LICENSE skcms:third_party/skcms/LICENSE; do
  printf '=== %s (%s) ===\n\n' "${f%%:*}" "$(basename "${f#*:}")"
  cat "$SRC/${f#*:}"
  printf '\n'
done > "$OUT/THIRD_PARTY_LICENSES.txt"
ls -l "$OUT"
