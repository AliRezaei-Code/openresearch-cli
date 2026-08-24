#!/bin/bash
# Package dist/openresearch into the downloadable tarball plus a self-contained
# install.sh: the Linux analogue of the macOS DMG. The tarball name carries no
# version (like OpenResearch.dmg) — the version lives in linux-app.json, which
# the release workflow generates right beside the upload.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/dist/openresearch"
DIST="$ROOT/dist"

if [[ "$(uname)" != "Linux" ]]; then
  echo "package-linux-app.sh: Linux only (uname=$(uname))" >&2
  exit 1
fi
if [[ ! -f "$APP/.openresearch-app" ]]; then
  echo "package-linux-app.sh: $APP missing — run scripts/build-linux-app.sh first" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64) ARCH="x86_64" ;;
  aarch64) ARCH="aarch64" ;;
  *) echo "package-linux-app.sh: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

TARBALL="$DIST/OpenResearch-linux-$ARCH.tar.gz"
echo "==> Packaging $TARBALL"
tar -C "$DIST" -czf "$TARBALL" openresearch
sha256sum "$TARBALL" | awk '{print $1}' > "$TARBALL.sha256"

cat > "$DIST/install.sh" <<'INSTALL'
#!/bin/bash
# Install or uninstall the OpenResearch desktop app for this user.
#
#   ./install.sh                 install to ~/.local/share/openresearch/app
#   ./install.sh --prefix PATH   install to PATH (the app root itself)
#   ./install.sh --uninstall     remove the app and its menu entry
#
# Everything lands under the user's home — no sudo. The app self-updates by
# swapping its own root (checksum-verified), so it must stay writable by this
# user; don't install it with sudo or it can't update itself.
set -euo pipefail

MODE="install"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/openresearch/app"
if [[ "${1:-}" == "--uninstall" ]]; then
  MODE="uninstall"
  shift
fi
if [[ "${1:-}" == "--prefix" ]]; then
  APP_DIR="${2:?--prefix needs a path}"
  shift 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$HERE/openresearch"
MENU_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"

if [[ "$MODE" == "uninstall" ]]; then
  rm -rf "$APP_DIR"
  rm -f "$MENU_DIR/openresearch.desktop"
  rm -f "$ICON_DIR/512x512/apps/openresearch.png" \
        "$ICON_DIR/256x256/apps/openresearch.png" \
        "$ICON_DIR/128x128/apps/openresearch.png"
  echo "OpenResearch uninstalled."
  exit 0
fi

if [[ ! -f "$SOURCE/.openresearch-app" ]]; then
  echo "install.sh: $SOURCE doesn't look like an OpenResearch app (no .openresearch-app marker)" >&2
  exit 1
fi

echo "==> Installing OpenResearch to $APP_DIR"
mkdir -p "$(dirname "$APP_DIR")" "$MENU_DIR" \
  "$ICON_DIR/512x512/apps" "$ICON_DIR/256x256/apps" "$ICON_DIR/128x128/apps"

# Keep a rollback copy when replacing: the app may be running (its inode stays
# alive) and the self-updater uses the same rename dance.
if [[ -d "$APP_DIR" ]]; then
  rm -rf "$APP_DIR.old"
  mv "$APP_DIR" "$APP_DIR.old"
fi
cp -a "$SOURCE" "$APP_DIR"
rm -rf "$APP_DIR.old"

# Wire the menu entry + icon; the .desktop Exec must point at this install.
# The tree copy is rewritten too — the self-updater rewrites both on every
# swap, so a fresh install should match what a swap would produce.
sed -i "s|^Exec=.*|Exec=$APP_DIR/bin/openresearch|" \
  "$APP_DIR/share/applications/openresearch.desktop"
sed "s|^Exec=.*|Exec=$APP_DIR/bin/openresearch|" \
  "$APP_DIR/share/applications/openresearch.desktop" > "$MENU_DIR/openresearch.desktop"
chmod +x "$APP_DIR/bin/openresearch"
cp "$APP_DIR/share/icons/hicolor/512x512/apps/openresearch.png" "$ICON_DIR/512x512/apps/"
cp "$APP_DIR/share/icons/hicolor/256x256/apps/openresearch.png" "$ICON_DIR/256x256/apps/"
cp "$APP_DIR/share/icons/hicolor/128x128/apps/openresearch.png" "$ICON_DIR/128x128/apps/"

update-desktop-database "$MENU_DIR" 2>/dev/null || true
echo "==> Done. Launch OpenResearch from your app grid (or run $APP_DIR/bin/openresearch)."
INSTALL
chmod +x "$DIST/install.sh"

echo "==> Done: $TARBALL (+ .sha256, install.sh at $DIST/install.sh)"