#!/bin/zsh
# Builds the AcmeDesk fixture app (scripts/cu-fixture/AcmeDesk.swift) into build/cu-fixture/AcmeDesk.app.
set -euo pipefail
ROOT="${0:A:h:h:h}"
OUT="$ROOT/build/cu-fixture/AcmeDesk.app"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS"
swiftc -O -o "$OUT/Contents/MacOS/AcmeDesk" "$ROOT/scripts/cu-fixture/AcmeDesk.swift"
cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.okidoki.acmedesk</string>
  <key>CFBundleName</key><string>AcmeDesk</string>
  <key>CFBundleExecutable</key><string>AcmeDesk</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>3.0</string>
  <key>LSUIElement</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
codesign --force --sign - "$OUT" >/dev/null 2>&1 || true
echo "$OUT"
