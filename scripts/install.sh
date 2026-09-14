#!/bin/bash
# Build Tomo in release mode and install the CLI, the daemon, and the macOS app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${TOMO_BIN_DIR:-$HOME/.local/bin}"
APP_DIR="${TOMO_APP_DIR:-/Applications}"

cd "$ROOT"
echo "== building release binaries"
cargo build --release -p tomod -p tomo-cli
echo "== building app bundle"
pnpm --dir app install --frozen-lockfile
pnpm --dir app tauri build --bundles app

APP_SRC="$(ls -d "$ROOT"/target/release/bundle/macos/*.app | head -1)"
mkdir -p "$BIN_DIR"
install -m 755 target/release/tomo "$BIN_DIR/tomo"
install -m 755 target/release/tomod "$BIN_DIR/tomod"
echo "== installed $BIN_DIR/tomo and $BIN_DIR/tomod"

cp target/release/tomo target/release/tomod "$APP_SRC/Contents/MacOS/"
codesign --force --deep --sign - "$APP_SRC" >/dev/null 2>&1 || true
rm -rf "$APP_DIR/Tomo.app"
cp -R "$APP_SRC" "$APP_DIR/Tomo.app"
echo "== installed $APP_DIR/Tomo.app"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "add $BIN_DIR to your PATH so agents and hooks can find tomo" ;;
esac
echo "next: run 'tomo integrations install' to add hooks for Claude, Codex, and Pi"
