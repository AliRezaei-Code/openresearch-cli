#!/bin/bash
# Sign, notarize, and package dist/OpenResearch.app into a distributable DMG.
#
# Run scripts/build-macos-app.sh first. This script is env-driven so it works
# both locally (unsigned, for a quick DMG) and in CI (fully signed + notarized):
#
#   MACOS_SIGN_IDENTITY   "Developer ID Application: NAME (TEAMID)".
#                         Unset → skip signing (UNSIGNED dmg; Gatekeeper warns).
#   MACOS_NOTARY_PROFILE  notarytool keychain profile (see `notarytool
#                         store-credentials`). Unset → skip notarization.
#
# See macos/DISTRIBUTION.md for the full setup and the CI wiring.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/dist/OpenResearch.app"
DMG="$ROOT/dist/OpenResearch.dmg"
EXE="$APP/Contents/MacOS/OpenResearch"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "package-macos-app.sh: macOS only" >&2
  exit 1
fi
if [[ ! -d "$APP" ]]; then
  echo "package-macos-app.sh: $APP not found — run scripts/build-macos-app.sh first" >&2
  exit 1
fi

if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
  echo "==> Codesigning with hardened runtime"
  # Sign inside-out: the nested executable first, then the bundle.
  codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$EXE"
  codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$APP"
  codesign --verify --strict --verbose=2 "$APP"
else
  echo "==> MACOS_SIGN_IDENTITY unset — building an UNSIGNED bundle (local test only)."
fi

# Notarize + staple the .app itself first, so it still launches when a user drags
# it out of the DMG and first opens it offline (a DMG-only staple wouldn't cover
# the extracted app).
if [[ -n "${MACOS_NOTARY_PROFILE:-}" ]]; then
  echo "==> Notarizing the app (submitting to Apple; can take a few minutes)"
  APP_ZIP="$ROOT/dist/OpenResearch-app.zip"
  ditto -c -k --keepParent "$APP" "$APP_ZIP"
  xcrun notarytool submit "$APP_ZIP" --keychain-profile "$MACOS_NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f "$APP_ZIP"
fi

echo "==> Creating DMG"
rm -f "$DMG"
hdiutil create -volname "OpenResearch" -srcfolder "$APP" -ov -format UDZO "$DMG" >/dev/null
[[ -n "${MACOS_SIGN_IDENTITY:-}" ]] && codesign --force --timestamp --sign "$MACOS_SIGN_IDENTITY" "$DMG"

if [[ -n "${MACOS_NOTARY_PROFILE:-}" ]]; then
  echo "==> Notarizing and stapling the DMG"
  xcrun notarytool submit "$DMG" --keychain-profile "$MACOS_NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
else
  echo "==> MACOS_NOTARY_PROFILE unset — skipping notarization (downloads would warn)."
fi

echo "==> Done: $DMG"
