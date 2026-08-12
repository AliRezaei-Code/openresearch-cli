#!/bin/bash
# Assemble the downloadable macOS app bundle: OpenResearch.app.
#
# Builds a release `orx`, generates AppIcon.icns from the brand mark, and lays
# out dist/OpenResearch.app. The bundle's executable IS `orx`; launched from the
# bundle it enters GUI app mode (see src/commands/app.rs). macOS only.
#
# The result is UNSIGNED — Gatekeeper will warn on first open (right-click →
# Open, or `xattr -dr com.apple.quarantine`). Signing + notarization is separate.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/dist/OpenResearch.app"
CONTENTS="$APP/Contents"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "build-macos-app.sh: macOS only (uname=$(uname))" >&2
  exit 1
fi

VERSION="$(sed -n 's/^version *= *"\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -1)"
echo "==> Building release orx (v$VERSION)"
cargo build --release --bin orx --manifest-path "$ROOT/Cargo.toml"

echo "==> Generating AppIcon.icns"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
gen() { node "$ROOT/scripts/generate-icon.mjs" "$ICONSET/$1" "$2" >/dev/null; }
gen icon_16x16.png 16
gen icon_16x16@2x.png 32
gen icon_32x32.png 32
gen icon_32x32@2x.png 64
gen icon_128x128.png 128
gen icon_128x128@2x.png 256
gen icon_256x256.png 256
gen icon_256x256@2x.png 512
gen icon_512x512.png 512
gen icon_512x512@2x.png 1024

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cp "$ROOT/target/release/orx" "$CONTENTS/MacOS/OpenResearch"
chmod +x "$CONTENTS/MacOS/OpenResearch"
iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"
sed "s/__VERSION__/$VERSION/g" "$ROOT/macos/Info.plist" > "$CONTENTS/Info.plist"
printf 'APPL????' > "$CONTENTS/PkgInfo"

# Refresh Launch Services so Finder/Dock pick up the new icon immediately.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP" 2>/dev/null || true

echo "==> Done: $APP"
