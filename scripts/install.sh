#!/bin/bash
# Build Tomo in release mode and install the CLI, the daemon, and the macOS app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${TOMO_BIN_DIR:-$HOME/.local/bin}"
APP_DIR="${TOMO_APP_DIR:-/Applications}"
WITH_CONFIG=0
for arg in "$@"; do
  case "$arg" in
    --with-config) WITH_CONFIG=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

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

# macOS saves each permission you grant against the app's designated requirement. Ad-hoc
# signing ("-") makes that requirement a cdhash, which changes with every build, so every
# install looks like a new app and asks for camera, files and the rest again. A stable
# identity pins the requirement to the certificate instead, and the grants survive.
# Only an identity named for Tomo is used: signing with whatever else is in the keychain
# would put another project's name on this app.
SIGN_ID="${TOMO_SIGN_ID:-}"
if [ -z "$SIGN_ID" ] && security find-identity -v -p codesigning 2>/dev/null | grep -q '"Tomo Local Signing"'; then
  SIGN_ID="Tomo Local Signing"
fi
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="-"
  echo "== signing ad-hoc, so macOS asks for permissions again after every install."
  echo "   To make the grants stick, create a self-signed code signing certificate once:"
  echo "   Keychain Access > Certificate Assistant > Create a Certificate,"
  echo "   name 'Tomo Local Signing', type 'Code Signing', then run this script again."
else
  echo "== signing as '$SIGN_ID'"
fi
codesign --force --sign "$SIGN_ID" "$APP_SRC/Contents/MacOS/tomo" "$APP_SRC/Contents/MacOS/tomod"
codesign --force --sign "$SIGN_ID" "$APP_SRC"
rm -rf "$APP_DIR/Tomo.app"
cp -R "$APP_SRC" "$APP_DIR/Tomo.app"
echo "== installed $APP_DIR/Tomo.app"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "add $BIN_DIR to your PATH so agents and hooks can find tomo" ;;
esac
echo "next: run 'tomo integrations install' to add hooks for Claude, Codex, and Pi"

if [ "$WITH_CONFIG" = 1 ]; then
  DATA_DIR="${TOMO_DATA_DIR:-$HOME/Library/Application Support/tomo}"
  mkdir -p "$DATA_DIR"
  if [ -f "$DATA_DIR/config.toml" ] && ! cmp -s "$DATA_DIR/config.toml" personal/config.toml; then
    BACKUP="$DATA_DIR/config.toml.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$DATA_DIR/config.toml" "$BACKUP"
    echo "== saved the old config as $BACKUP"
  fi
  cp personal/config.toml "$DATA_DIR/config.toml"
  echo "== installed personal/config.toml"
fi

"$HOME/.local/bin/tomo" daemon stop >/dev/null 2>&1 && echo "== stopped the running daemon; the app or the next tomo call starts the new one" || true
