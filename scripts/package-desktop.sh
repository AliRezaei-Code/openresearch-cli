#!/usr/bin/env bash

set -euo pipefail

target="${1:?usage: scripts/package-desktop.sh <target-triple>}"
archive_dir="${2:-target/distrib}"
output_dir="${3:-target/desktop}"

case "$target" in
  aarch64-apple-darwin)
    format="dmg"
    export CI=true
    extension="dmg"
    platform="macos"
    arch="arm64"
    ;;
  x86_64-apple-darwin)
    format="dmg"
    export CI=true
    extension="dmg"
    platform="macos"
    arch="x64"
    ;;
  aarch64-unknown-linux-musl)
    format="appimage"
    extension="AppImage"
    platform="linux"
    arch="arm64"
    ;;
  x86_64-unknown-linux-musl)
    format="appimage"
    extension="AppImage"
    platform="linux"
    arch="x64"
    ;;
  aarch64-pc-windows-msvc)
    format="nsis"
    extension="exe"
    platform="windows"
    arch="arm64"
    ;;
  x86_64-pc-windows-msvc)
    format="nsis"
    extension="exe"
    platform="windows"
    arch="x64"
    ;;
  *)
    echo "Unsupported desktop target: $target" >&2
    exit 1
    ;;
esac

input_dir="target/${target}/release"
extract_dir="$(mktemp -d)"
packager_dir="$output_dir/.packager-$target"
manifest_backup=""

cleanup() {
  rm -rf "$extract_dir" "$packager_dir"
  if [[ -n "$manifest_backup" ]]; then
    cp "$manifest_backup" Cargo.toml
    rm -f "$manifest_backup"
  fi
}
trap cleanup EXIT

if [[ "$platform" == "windows" ]]; then
  artifact_name="OpenResearch-${platform}-${arch}-setup.${extension}"
else
  artifact_name="OpenResearch-${platform}-${arch}.${extension}"
fi

archive=""
for candidate in \
  "$archive_dir/openresearch-cli-$target.tar.xz" \
  "$archive_dir/openresearch-cli-$target.tar.gz" \
  "$archive_dir/openresearch-cli-$target.zip"
do
  if [[ -f "$candidate" ]]; then
    archive="$candidate"
    break
  fi
done

if [[ -z "$archive" ]]; then
  echo "Could not find the cargo-dist archive for $target in $archive_dir" >&2
  exit 1
fi

rm -rf "$input_dir" "$packager_dir"
mkdir -p "$input_dir" "$output_dir"
rm -f "$output_dir/$artifact_name" "$output_dir/$artifact_name.sha256"
tar -xf "$archive" -C "$extract_dir"

binary_extension=""
if [[ "$platform" == "windows" ]]; then
  binary_extension=".exe"
fi
for binary in openresearch orx; do
  binary_name="$binary$binary_extension"
  binary_source="$(find "$extract_dir" -type f -name "$binary_name" -print -quit)"
  if [[ -z "$binary_source" ]]; then
    echo "Could not find $binary_name in $archive" >&2
    exit 1
  fi
  cp "$binary_source" "$input_dir/$binary_name"
  chmod +x "$input_dir/$binary_name"
done

if [[ -n "${APPLE_SIGNING_IDENTITY:-}" || -n "${WINDOWS_CERTIFICATE_THUMBPRINT:-}" ]]; then
  manifest_backup="$(mktemp)"
  cp Cargo.toml "$manifest_backup"
fi

if [[ "$format" == "dmg" && -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  python3 -c 'import json, pathlib, sys; path = pathlib.Path("Cargo.toml"); text = path.read_text(); path.write_text(text.replace("signing-identity = \"-\"", "signing-identity = " + json.dumps(sys.argv[1]), 1))' "$APPLE_SIGNING_IDENTITY"
fi

if [[ "$format" == "nsis" && -n "${WINDOWS_CERTIFICATE_THUMBPRINT:-}" ]]; then
  python_command="python3"
  if ! command -v "$python_command" >/dev/null 2>&1; then
    python_command="python"
  fi
  "$python_command" -c 'import json, pathlib, sys; path = pathlib.Path("Cargo.toml"); text = path.read_text(); text += "\n[package.metadata.packager.windows]\ncertificate-thumbprint = " + json.dumps(sys.argv[1]) + "\ndigest-algorithm = \"sha256\"\ntimestamp-url = \"http://timestamp.digicert.com\"\n"; path.write_text(text)' "$WINDOWS_CERTIFICATE_THUMBPRINT"

  ORX_DESKTOP_SIGN_FILES="$input_dir/openresearch.exe;$input_dir/orx.exe" powershell.exe -NoProfile -NonInteractive -Command '
    $signTool = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if (-not $signTool) { throw "Could not find signtool.exe" }
    foreach ($file in $env:ORX_DESKTOP_SIGN_FILES.Split(";")) {
      & $signTool.FullName sign /fd sha256 /sha1 $env:WINDOWS_CERTIFICATE_THUMBPRINT /d OpenResearch /tr http://timestamp.digicert.com /td sha256 $file
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
  '
fi

cargo packager \
  --release \
  --formats "$format" \
  --target "$target" \
  --out-dir "$packager_dir"

package="$(find "$packager_dir" -maxdepth 1 -type f -name "*.${extension}" -print -quit)"
if [[ -z "$package" ]]; then
  echo "cargo-packager did not produce a .${extension} package for $target" >&2
  exit 1
fi

mv "$package" "$output_dir/$artifact_name"

package="$output_dir/$artifact_name"
if [[ "$format" == "nsis" && -n "${WINDOWS_CERTIFICATE_THUMBPRINT:-}" ]]; then
  ORX_DESKTOP_SIGN_FILES="$input_dir/openresearch.exe;$input_dir/orx.exe;$package" powershell.exe -NoProfile -NonInteractive -Command '
    foreach ($file in $env:ORX_DESKTOP_SIGN_FILES.Split(";")) {
      $signature = Get-AuthenticodeSignature $file
      if ($signature.Status -ne "Valid") {
        throw "Invalid Authenticode signature for ${file}: $($signature.Status)"
      }
    }
  '
fi

package_name="$(basename "$package")"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$output_dir" && sha256sum "$package_name") > "$package.sha256"
else
  (cd "$output_dir" && shasum -a 256 "$package_name") > "$package.sha256"
fi
