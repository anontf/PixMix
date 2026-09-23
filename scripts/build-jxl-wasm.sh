#!/bin/sh
# Rebuilds native/jxl/pkg (the JPEG XL decoder WASM). Only needed after changing
# native/jxl; the result is committed.
#
# Requirements: rustup with the wasm32-unknown-unknown target, and
#   cargo install wasm-bindgen-cli --version 0.2.128   (must match native/jxl/Cargo.toml)
set -eu
cd "$(dirname "$0")/../native/jxl"
# Panic messages embed source paths; map them to neutral prefixes so the committed binary
# does not carry the builder's home directory.
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--remap-path-prefix=$CARGO_HOME_DIR/registry/src=cargo-registry --remap-path-prefix=$(cd ../.. && pwd)=pixmix --remap-path-prefix=$HOME=~"
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir pkg --out-name pixmix_jxl target/wasm32-unknown-unknown/release/pixmix_jxl.wasm
# A trap (a panic, or running out of WASM memory) leaves the instance's stack pointer and
# heap in an unknown state. wasm-bindgen caches the instance for good, so add a way to drop
# it; codec.js then starts a fresh instance from the compiled module.
cat >> pkg/pixmix_jxl.js <<'EOF'

/** Added by pixmix's build script: forgets the instance after a trap, so init starts afresh. */
export function __pixmixReset() {
    wasm = undefined;
    wasmInstance = undefined;
}
EOF
if grep -a -q "$HOME" pkg/pixmix_jxl_bg.wasm; then echo "error: build output still contains $HOME" >&2; exit 1; fi
ls -l pkg
