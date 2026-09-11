#!/bin/bash
# Build nsmpl and install it to /Applications, then relaunch. macOS only.
#
#   ./install.sh               # build (release) + quit + install + relaunch
#   ./install.sh --skip-build  # reinstall the last build without rebuilding
#
# Or via npm:  npm run install:app
#
# Why this exists rather than `make install`: that target is Linux's — it drops a
# bare binary in ~/.local/bin next to a .desktop entry. On macOS a bare binary
# has no Info.plist, no icon and no bundle identifier, and the identifier is not
# cosmetic here: the Keychain keys its ACLs off code identity, and this app
# keeps its signing key there. A bundle-less install is not a lesser install, it
# is a different app to the OS.
set -euo pipefail
cd "$(dirname "$0")"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "install.sh is macOS-only (installs a .app to /Applications)." >&2
  echo "On Linux use: make install" >&2
  exit 1
fi

APP_NAME="nsmpl.app"
# Before the rename the bundle was smpl-tool.app, with the same identifier.
LEGACY_APP_NAME="smpl-tool.app"
BUILT="src-tauri/target/release/bundle/macos/$APP_NAME"

if [[ "${1:-}" != "--skip-build" ]]; then
  # `npm run tauri` resolves the CLI out of node_modules/.bin, so on a fresh
  # clone this fails with "tauri: command not found" — which reads like a
  # missing global tool rather than "you have not installed deps yet".
  # Checking for the CLI itself, not just the directory, also catches a
  # half-finished install.
  if [[ ! -x node_modules/.bin/tauri ]]; then
    echo "--- Installing npm dependencies (first build here) ---"
    npm install
  fi
  echo "--- Building nsmpl (release) ---"
  npm run tauri build
fi

if [[ ! -d "$BUILT" ]]; then
  echo "No built app at $BUILT — run without --skip-build first." >&2
  exit 1
fi

echo "--- Quitting running nsmpl (if any) ---"
osascript -e 'quit app "nsmpl"' 2>/dev/null || pkill -x nsmpl 2>/dev/null || true
osascript -e 'quit app "smpl-tool"' 2>/dev/null || pkill -x smpl-tool 2>/dev/null || true
sleep 1

echo "--- Installing to /Applications ---"
rm -rf "/Applications/$APP_NAME"
cp -R "$BUILT" "/Applications/$APP_NAME"
if [[ -d "/Applications/$LEGACY_APP_NAME" ]]; then
  echo "--- Removing the pre-rename /Applications/$LEGACY_APP_NAME ---"
  rm -rf "/Applications/$LEGACY_APP_NAME"
fi

echo "--- Relaunching ---"
open "/Applications/$APP_NAME"

VER=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "/Applications/$APP_NAME/Contents/Info.plist" 2>/dev/null || echo "?")
echo "Installed + relaunched: /Applications/$APP_NAME (v$VER)"

echo
echo "Note: the app is unsigned, so each rebuild gets a fresh ad-hoc signature."
echo "The Keychain trusts the binary that created an entry, so a rebuilt nsmpl"
echo "is a different caller and macOS will ask you to authorise access to its"
echo "key. That is expected in development; 'Always Allow' holds until the next"
echo "rebuild."

echo
echo "Note: this app shells out to ffmpeg, ffprobe and aubio. An app launched"
echo "from Finder does not inherit your shell PATH, so these are resolved by"
echo "absolute path (see src-tauri/src/tools.rs). If one is installed somewhere"
echo "unusual, set NDISC_TOOL_FFMPEG=/full/path/to/ffmpeg and relaunch."
