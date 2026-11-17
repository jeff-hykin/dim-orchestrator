#!/usr/bin/env bash
# Rebuild frontend/vendor/elk/: elkjs's API as a browser module, and its layout worker as it ships (needs deno, curl).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
version="${1:-0.10.0}"
entry="$(mktemp -d)/entry.js"
echo "export { default as ELK } from \"npm:elkjs@$version/lib/elk-api.js\"" > "$entry"
deno bundle --platform browser --minify "$entry" -o "$here/frontend/vendor/elk/elk-api.js"
curl -sfL -o "$here/frontend/vendor/elk/elk-worker.min.js" "https://cdn.jsdelivr.net/npm/elkjs@$version/lib/elk-worker.min.js"
curl -sfL -o "$here/frontend/vendor/elk/LICENSE" "https://cdn.jsdelivr.net/npm/elkjs@$version/LICENSE.md"
