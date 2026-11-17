#!/usr/bin/env bash
# Rebuild frontend/vendor/tree-sitter-cel/ from bufbuild/tree-sitter-cel (needs nix).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
rev="${1:-fd2e8efaa07e71e46dcc1d5c4c85556a742d8c36}"
work="$here/vendor_build"
mkdir -p "$work" && cd "$work"
[ -d tree-sitter-cel ] || git clone https://github.com/bufbuild/tree-sitter-cel
cd tree-sitter-cel && git fetch -q origin && git checkout -q "$rev"
export EM_CACHE="$work/emcache"
nix shell nixpkgs#tree-sitter nixpkgs#emscripten -c tree-sitter build --wasm -o tree-sitter-cel.wasm .
cp tree-sitter-cel.wasm LICENSE queries/highlights.scm "$here/frontend/vendor/tree-sitter-cel/"
