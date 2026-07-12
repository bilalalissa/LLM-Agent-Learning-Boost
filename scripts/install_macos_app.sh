#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/build_macos_app.sh"

APP="$ROOT/build/macos/LLM Agent Learning Boost.app"
TARGET_DIR="${LEARNING_BOOST_INSTALL_DIR:-$HOME/Applications}"
TARGET="$TARGET_DIR/LLM Agent Learning Boost.app"
APPLICATIONS_ALIAS="/Applications/LLM Agent Learning Boost.app"

pkill -x LLMWikiAgent >/dev/null 2>&1 || true
pkill -f "$TARGET/Contents/Resources/agent/src/server.mjs" >/dev/null 2>&1 || true
pkill -f "$APPLICATIONS_ALIAS/Contents/Resources/agent/src/server.mjs" >/dev/null 2>&1 || true
pkill -f "$ROOT/build/macos/LLM Agent Learning Boost.app/Contents/Resources/agent/src/server.mjs" >/dev/null 2>&1 || true
ps -axo pid=,ppid=,command= | awk '$2 == 1 && $0 ~ /\/node src\/server\.mjs/ { print $1 }' | xargs -r kill >/dev/null 2>&1 || true
pkill -f "$TARGET/Contents/Resources/agent/src/tab-data-worker.mjs" >/dev/null 2>&1 || true
pkill -f "$TARGET/Contents/Resources/agent/src/auto-ingest-worker.mjs" >/dev/null 2>&1 || true
pkill -f "$TARGET/Contents/Resources/agent/src/startup-learning-backfill-worker.mjs" >/dev/null 2>&1 || true
pkill -f "$TARGET/Contents/Resources/agent/src/capture-scan-worker.mjs" >/dev/null 2>&1 || true
pkill -f "$TARGET/Contents/Resources/agent/src/provider-status-worker.mjs" >/dev/null 2>&1 || true
pkill -f "$ROOT/build/macos/LLM Agent Learning Boost.app/Contents/Resources/agent/src/tab-data-worker.mjs" >/dev/null 2>&1 || true
pkill -f "$ROOT/build/macos/LLM Agent Learning Boost.app/Contents/Resources/agent/src/auto-ingest-worker.mjs" >/dev/null 2>&1 || true
pkill -f "$ROOT/build/macos/LLM Agent Learning Boost.app/Contents/Resources/agent/src/startup-learning-backfill-worker.mjs" >/dev/null 2>&1 || true
pkill -f "$ROOT/build/macos/LLM Agent Learning Boost.app/Contents/Resources/agent/src/capture-scan-worker.mjs" >/dev/null 2>&1 || true
pkill -f "$ROOT/build/macos/LLM Agent Learning Boost.app/Contents/Resources/agent/src/provider-status-worker.mjs" >/dev/null 2>&1 || true
sleep 0.5

mkdir -p "$TARGET_DIR"
if [[ -d "$TARGET" ]]; then
  rm -rf "$TARGET"
fi
/usr/bin/ditto "$APP" "$TARGET"
xattr -cr "$TARGET" 2>/dev/null || true
SIGN_IDENTITY="${CODE_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | awk -F '"' '/Apple Development:/{print $2; exit}')}"
if [[ -z "$SIGN_IDENTITY" ]]; then
  SIGN_IDENTITY="-"
fi
codesign --force --deep --sign "$SIGN_IDENTITY" "$TARGET"
touch "$TARGET"

if [[ "$APPLICATIONS_ALIAS" != "$TARGET" ]]; then
  if [[ -L "$APPLICATIONS_ALIAS" ]]; then
    rm -f "$APPLICATIONS_ALIAS"
  elif [[ -d "$APPLICATIONS_ALIAS" ]]; then
    rm -rf "$APPLICATIONS_ALIAS"
  fi
  ln -s "$TARGET" "$APPLICATIONS_ALIAS" 2>/dev/null || true
fi

echo "Installed: $TARGET"
if [[ -L "$APPLICATIONS_ALIAS" ]]; then
  echo "Applications alias: $APPLICATIONS_ALIAS -> $TARGET"
fi
echo "Open it from /Applications or run: open '$TARGET'"
