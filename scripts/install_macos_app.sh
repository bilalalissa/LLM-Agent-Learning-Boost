#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/build_macos_app.sh"

APP="$ROOT/build/macos/LLM Agent Learning Boost.app"
TARGET="/Applications/LLM Agent Learning Boost.app"

pkill -x LLMWikiAgent >/dev/null 2>&1 || true
pkill -f "$TARGET/Contents/Resources/agent/src/server.mjs" >/dev/null 2>&1 || true
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

if [[ -d "$TARGET" ]]; then
  rm -rf "$TARGET"
fi
cp -R "$APP" "$TARGET"
touch "$TARGET"

echo "Installed: $TARGET"
echo "Open it from /Applications or run: open '$TARGET'"
