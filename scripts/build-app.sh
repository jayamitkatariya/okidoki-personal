#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CONFIG="${1:-release}"
# OKIDOKI_SCRATCH lets a second builder work alongside another swift build on .build.
SCRATCH="${OKIDOKI_SCRATCH:-.build}"
echo "▸ Building Okidoki ($CONFIG)…"
swift build -c "$CONFIG" --scratch-path "$SCRATCH"

BIN="$SCRATCH/$CONFIG/Okidoki"
APP="${OKIDOKI_APP_DIR:-build/Okidoki.app}"

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

# Replacing the bundle under a running copy gets it killed for an invalid signature. Quit it first.
if pgrep -fq "$ROOT/$APP/Contents/MacOS/Okidoki"; then
  echo "▸ Quitting the running Okidoki…"
  osascript -e 'tell application id "com.jaykatariya.okidoki" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    pgrep -fq "$ROOT/$APP/Contents/MacOS/Okidoki" || break
    sleep 0.25
  done
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Okidoki"
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp -R Resources/Fonts "$APP/Contents/Resources/Fonts"
cp Resources/BrandMark.png "$APP/Contents/Resources/BrandMark.png"
# Service credentials live in the gitignored .env; the app reads them from service.env in its bundle.
if [ -f .env ]; then
  cp .env "$APP/Contents/Resources/service.env"
  chmod 600 "$APP/Contents/Resources/service.env"
fi
if [ -d Resources/brain ]; then
  cp -R Resources/brain "$APP/Contents/Resources/brain"
fi
if [ -d Resources/stage ]; then
  mkdir -p "$APP/Contents/Resources/stage"
  for f in stage.html stage.js parts.js labels.js expr.js three.module.js three.core.js OrbitControls.js RoomEnvironment.js THREE_LICENSE; do
    [ -f "Resources/stage/$f" ] && cp "Resources/stage/$f" "$APP/Contents/Resources/stage/$f"
  done
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

# Local builds use ad-hoc signing without looking up identities in the Keychain.
# A certificate is used only when the builder explicitly selects one.
IDENTITY="${OKIDOKI_CODESIGN_IDENTITY:--}"

echo "▸ Signing with: $IDENTITY"
codesign --force --deep --options runtime --entitlements Resources/Okidoki.entitlements --sign "$IDENTITY" "$APP"
codesign --verify --verbose=1 "$APP" 2>&1 | tail -1

echo "✓ Built $APP"
