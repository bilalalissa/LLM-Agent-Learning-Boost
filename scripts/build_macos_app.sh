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
APP_EXECUTABLE="LLMAgentLearningBoost"
APP_ICON="$ROOT/native/macos/LLMWikiAgent/Resources/AppIcon.icns"
SWIFT_SOURCE="$ROOT/native/macos/LLMWikiAgent/Sources/LLMWikiAgent/main.swift"
STAGING_SWIFT="$STAGING_ROOT/main.swift"
MACOS_ARCH="${MACOS_ARCH:-}"

detect_sign_identity() {
  if [ -n "${CODE_SIGN_IDENTITY:-}" ]; then
    printf '%s\n' "$CODE_SIGN_IDENTITY"
    return
  fi
  local identity
  identity="$(security find-identity -v -p codesigning 2>/dev/null | awk -F '"' '/Apple Development:/{print $2; exit}')"
  if [ -n "$identity" ]; then
    printf '%s\n' "$identity"
  else
    printf '%s\n' "-"
  fi
}

SIGN_IDENTITY="$(detect_sign_identity)"

cleanup() {
  rm -rf "$STAGING_ROOT"
  rm -rf "$NEW_APP"
}
trap cleanup EXIT

run_with_timeout() {
  local timeout_seconds="$1"
  shift
  "$@" &
  local pid=$!
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      echo "Timed out after ${timeout_seconds}s: $*" >&2
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$pid"
}

copy_dir() {
  local source_dir="$1"
  local target_dir="$2"
  rm -rf "$target_dir"
  mkdir -p "$(dirname "$target_dir")"
  run_with_timeout "${BUILD_COPY_TIMEOUT_SECONDS:-120}" /usr/bin/ditto --noextattr --norsrc "$source_dir" "$target_dir"
}

copy_file() {
  local source_file="$1"
  local target_file="$2"
  mkdir -p "$(dirname "$target_file")"
  run_with_timeout "${BUILD_COPY_TIMEOUT_SECONDS:-120}" /usr/bin/ditto --noextattr --norsrc "$source_file" "$target_file"
}

rm -rf "$STAGING_ROOT"
mkdir -p "$MACOS" "$RESOURCES" "$AGENT"
find "$BUILD" -maxdepth 1 -type d -name 'LLM Agent Learning Boost [0-9]*.app' -exec rm -rf {} + 2>/dev/null || true

if [ ! -f "$APP_ICON" ]; then
  "$ROOT/scripts/generate_app_icon.sh"
fi

copy_file "$SWIFT_SOURCE" "$STAGING_SWIFT"

SWIFTC_ARGS=(
  "$STAGING_SWIFT"
  -o "$MACOS/$APP_EXECUTABLE"
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
  <key>CFBundleExecutable</key><string>LLMAgentLearningBoost</string>
  <key>CFBundleIdentifier</key><string>local.llmagent.learningboost</string>
  <key>CFBundleName</key><string>LLM Agent Learning Boost</string>
  <key>CFBundleDisplayName</key><string>LLM Agent Learning Boost</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.1</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSDocumentsFolderUsageDescription</key><string>Learning Boost reads and updates user-selected Obsidian vaults stored in Documents or iCloud Drive.</string>
  <key>NSDownloadsFolderUsageDescription</key><string>Learning Boost scans user-enabled Downloads watch folders for learning sources.</string>
  <key>NSDesktopFolderUsageDescription</key><string>Learning Boost scans Desktop folders only when the user selects them as capture sources.</string>
  <key>NSNetworkVolumesUsageDescription</key><string>Learning Boost accesses a network vault only when the user explicitly selects that location.</string>
  <key>NSRemovableVolumesUsageDescription</key><string>Learning Boost accesses a removable-drive vault only when the user explicitly selects that location.</string>
</dict>
</plist>
PLIST

copy_file "$APP_ICON" "$RESOURCES/AppIcon.icns"
copy_file "$ROOT/package.json" "$AGENT/package.json"
copy_file "$ROOT/README.md" "$AGENT/README.md"
copy_file "$ROOT/config.example.env" "$RESOURCES/config.example.env"
copy_dir "$ROOT/src" "$AGENT/src"
copy_dir "$ROOT/docs" "$AGENT/docs"
if [ -d "$ROOT/media" ]; then
  copy_dir "$ROOT/media" "$AGENT/media"
fi
find "$AGENT" -name '.DS_Store' -delete

test -f "$AGENT/src/server.mjs"
test -f "$AGENT/package.json"

xattr -cr "$STAGING_APP" 2>/dev/null || true
codesign --force --deep --sign "$SIGN_IDENTITY" "$STAGING_APP"

mkdir -p "$BUILD"
rm -rf "$NEW_APP"
run_with_timeout "${BUILD_COPY_TIMEOUT_SECONDS:-120}" /usr/bin/ditto "$STAGING_APP" "$NEW_APP"
test -f "$NEW_APP/Contents/Resources/agent/src/server.mjs"
xattr -cr "$NEW_APP" 2>/dev/null || true
codesign --force --deep --sign "$SIGN_IDENTITY" "$NEW_APP"
rm -rf "$APP.previous"
if [ -d "$APP" ]; then
  mv "$APP" "$APP.previous"
fi
mv "$NEW_APP" "$APP"
rm -rf "$APP.previous"
find "$BUILD" -maxdepth 1 -type d -name 'LLM Agent Learning Boost [0-9]*.app' -exec rm -rf {} + 2>/dev/null || true

echo "Built: $APP"
