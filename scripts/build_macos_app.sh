#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build/macos"
APP="$BUILD/LLM Agent Learning Boost.app"
NEW_APP="$BUILD/.LLM Agent Learning Boost.app.new"
STAGING_ROOT="${TMPDIR:-/tmp}/llm-agent-learning-boost-build.$$"
STAGING_APP="$STAGING_ROOT/LLM Agent Learning Boost.app"
CONTENTS="$STAGING_APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
AGENT="$RESOURCES/agent"
APP_ICON="$ROOT/native/macos/LLMWikiAgent/Resources/AppIcon.icns"
SWIFT_SOURCE="$ROOT/native/macos/LLMWikiAgent/Sources/LLMWikiAgent/main.swift"
STAGING_SWIFT="$STAGING_ROOT/main.swift"
MACOS_ARCH="${MACOS_ARCH:-}"

cleanup() {
  rm -rf "$STAGING_ROOT"
  rm -rf "$NEW_APP"
}
trap cleanup EXIT

rm -rf "$STAGING_ROOT"
mkdir -p "$MACOS" "$RESOURCES" "$AGENT"

if [ ! -f "$APP_ICON" ]; then
  "$ROOT/scripts/generate_app_icon.sh"
fi

cp "$SWIFT_SOURCE" "$STAGING_SWIFT"

SWIFTC_ARGS=(
  "$STAGING_SWIFT"
  -o "$MACOS/LLMWikiAgent"
  -framework AppKit
  -framework WebKit
  -framework ServiceManagement
  -framework UserNotifications
)
if [ -n "$MACOS_ARCH" ]; then
  SWIFTC_ARGS=(-target "$MACOS_ARCH-apple-macosx13.0" "${SWIFTC_ARGS[@]}")
fi
swiftc "${SWIFTC_ARGS[@]}"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>LLMWikiAgent</string>
  <key>CFBundleIdentifier</key><string>local.llmagent.learningboost</string>
  <key>CFBundleName</key><string>LLM Agent Learning Boost</string>
  <key>CFBundleDisplayName</key><string>LLM Agent Learning Boost</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.1</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST

cp "$APP_ICON" "$RESOURCES/AppIcon.icns"
cp "$ROOT/package.json" "$AGENT/package.json"
cp "$ROOT/README.md" "$AGENT/README.md"
cp "$ROOT/config.example.env" "$RESOURCES/config.example.env"
cp -R "$ROOT/src" "$AGENT/src"
cp -R "$ROOT/docs" "$AGENT/docs"
if [ -d "$ROOT/media" ]; then
  cp -R "$ROOT/media" "$AGENT/media"
fi
find "$AGENT" -name '.DS_Store' -delete

test -f "$AGENT/src/server.mjs"
test -f "$AGENT/package.json"

mkdir -p "$BUILD"
rm -rf "$NEW_APP"
cp -R "$STAGING_APP" "$NEW_APP"
test -f "$NEW_APP/Contents/Resources/agent/src/server.mjs"
rm -rf "$APP.previous"
if [ -d "$APP" ]; then
  mv "$APP" "$APP.previous"
fi
mv "$NEW_APP" "$APP"
rm -rf "$APP.previous"

echo "Built: $APP"
