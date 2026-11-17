#!/usr/bin/env bash
# Rebuild frontend/vendor/formats/formats.js: smol-toml and yaml as one browser module (needs deno >= 2.4).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
entry="$(mktemp -d)/entry.js"
cat > "$entry" <<'JS'
export { parse as parseToml, stringify as stringifyToml } from "npm:smol-toml@1.4.2"
export { parse as parseYaml, Document as YamlDocument, isScalar, visit as visitYaml } from "npm:yaml@2.8.1"
JS
deno bundle --platform browser --minify "$entry" -o "$here/frontend/vendor/formats/formats.js"
