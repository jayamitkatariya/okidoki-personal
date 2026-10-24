#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CONFIG="${1:-release}"
echo "▸ Building Okidoki ($CONFIG)…"
swift build -c "$CONFIG"

BIN=".build/$CONFIG/Okidoki"
APP="build/Okidoki.app"

# --- brain sidecar (TypeScript, Bun) ---
if command -v bun >/dev/null 2>&1 && [ -f brain/src/server.ts ]; then
  echo "▸ Bundling the TypeScript brain…"
  if [ ! -d brain/node_modules ]; then
    (cd brain && bun install >/dev/null)
  fi
  # Moss ships a native binary per platform, which can't live inside the bundle: keep it external
  # and copy its packages next to server.js, where Bun resolves them at runtime.
  (cd brain && bun build src/server.ts --outfile dist/server.js --target=bun --external @moss-js/moss >/dev/null)
  rm -rf Resources/brain
  mkdir -p Resources/brain/node_modules
  cp brain/dist/server.js Resources/brain/server.js
  if [ -d brain/node_modules/@moss-js ]; then
    cp -R brain/node_modules/@moss-js Resources/brain/node_modules/@moss-js
  fi
fi

# --- react control panel ---
if command -v bun >/dev/null 2>&1 && [ -f web/package.json ]; then
  if [ ! -d web/node_modules ]; then
    echo "▸ Installing control panel dependencies…"
    (cd web && bun install >/dev/null)
  fi
  echo "▸ Building the React control panel…"
  (cd web && bun run build >/dev/null)
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Okidoki"
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp -R Resources/Fonts "$APP/Contents/Resources/Fonts"
cp Resources/BrandMark.png "$APP/Contents/Resources/BrandMark.png"
if [ -d Resources/brain ]; then
  cp -R Resources/brain "$APP/Contents/Resources/brain"
fi
if [ -d web/dist ]; then
  cp -R web/dist "$APP/Contents/Resources/web"
fi

if [ ! -f build/AppIcon.icns ]; then
  echo "▸ Rendering app icon…"
  swift scripts/make-icon.swift build/icon
  ICONSET="build/AppIcon.iconset"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" build/icon/AppIcon-1024.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" build/icon/AppIcon-1024.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o build/AppIcon.icns
fi
cp build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)"/\1/')"
if [ -z "${IDENTITY:-}" ]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | grep "Apple Development" | head -1 | sed 's/.*"\(.*\)"/\1/')"
fi
if [ -z "${IDENTITY:-}" ]; then
  IDENTITY="-"
fi

echo "▸ Signing with: $IDENTITY"
codesign --force --deep --options runtime --entitlements Resources/Okidoki.entitlements --sign "$IDENTITY" "$APP"
codesign --verify --verbose=1 "$APP" 2>&1 | tail -1

echo "✓ Built $APP"
