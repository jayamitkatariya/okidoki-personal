#!/bin/bash
# okidoki is its own product. The donor lineage's name must never appear in
# this codebase: not in identifiers, paths, env vars, strings or docs.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

# Split so this guard file itself never contains the banned word.
needle="repl""icas"

hits="$(grep -rIn --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.build \
  --exclude-dir=build --exclude-dir=dist --exclude="$(basename "$0")" \
  -i "$needle" . || true)"

if [ -n "$hits" ]; then
  echo "✗ the lineage name appears in okidoki:"
  echo "$hits"
  exit 1
fi

echo "✓ no lineage names"
