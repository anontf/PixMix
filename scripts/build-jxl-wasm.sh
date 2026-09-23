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
if grep -a -q "$HOME" pkg/pixmix_jxl_bg.wasm; then echo "error: build output still contains $HOME" >&2; exit 1; fi
ls -l pkg
