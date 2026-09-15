#!/usr/bin/env bash
# Build this checkout if needed, then pull the model, index, and wire Cursor.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ ! -f dist/cli/index.js ]]; then
  npm install
  npm run build
fi
exec node "$ROOT/dist/cli/index.js" onboard "$@"
