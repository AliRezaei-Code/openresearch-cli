#!/bin/bash
# Assemble the downloadable Linux desktop app bundle: dist/openresearch.
#
# Builds a release `orx`, generates PNG icons from the brand mark, and lays out
# the app dir. The bundle's executable IS `orx`; launched from the .desktop
# entry (no arguments) it enters GUI app mode (see src/commands/app.rs).
# `bin/openresearch` is the real executable; `bin/orx` is a symlink to it so
# agents shelling out to `orx` get this exact build while staying a plain CLI.
# Linux only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/dist/openresearch"

if [[ "$(uname)" != "Linux" ]]; then
  echo "build-linux-app.sh: Linux only (uname=$(uname))" >&2
  exit 1
fi

VERSION="$(sed -n 's/^version *= *"\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -1)"

echo "==> Building release orx (v$VERSION)"
cargo build --release --bin orx --manifest-path "$ROOT/Cargo.toml"

echo "==> Generating icons"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
gen() { node "$ROOT/scripts/generate-icon.mjs" "$TMP/$1" "$2" >/dev/null; }
gen icon-512.png 512
gen icon-256.png 256
gen icon-128.png 128

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/bin" \
  "$APP/share/applications" \
  "$APP/share/icons/hicolor/512x512/apps" \
  "$APP/share/icons/hicolor/256x256/apps" \
  "$APP/share/icons/hicolor/128x128/apps"

cp "$ROOT/target/release/orx" "$APP/bin/openresearch"
chmod +x "$APP/bin/openresearch"
# Agents shell out to `orx` and chat::prepare_env prepends this dir. A symlink,
# not a copy: `launched_as_app_bundle` tells CLI from GUI by comparing argv0
# against the *resolved* executable name, and a copy would defeat that (the
# macOS bundle uses the same trick).
ln -sf openresearch "$APP/bin/orx"

# Marker: distinguishes an app install from a plain `bin/` directory. App-mode
# launch and the update channel both key on it (commands::app::LINUX_APP_MARKER
# / updates::LINUX_APP_MARKER), so it must stay in the packaged app.
touch "$APP/.openresearch-app"

cp "$TMP/icon-512.png" "$APP/share/icons/hicolor/512x512/apps/openresearch.png"
cp "$TMP/icon-256.png" "$APP/share/icons/hicolor/256x256/apps/openresearch.png"
cp "$TMP/icon-128.png" "$APP/share/icons/hicolor/128x128/apps/openresearch.png"

# Exec carries a placeholder prefix — install.sh (and the self-updater) rewrite
# it to the real installed path, which isn't known at build time.
cat > "$APP/share/applications/openresearch.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=OpenResearch
Comment=Local autoresearch dashboard (parallel research agents)
Exec=__PREFIX__/bin/openresearch
Icon=openresearch
Terminal=false
Categories=Development;Science;
Keywords=research;autoresearch;agent;dashboard;
EOF

printf '%s\n' "$VERSION" > "$APP/VERSION"

echo "==> Done: $APP"