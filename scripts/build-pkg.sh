#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="$ROOT_DIR/CSXS/manifest.xml"
DIST_DIR="$ROOT_DIR/dist"
STAGE_DIR="$ROOT_DIR/.pkg-stage"
PAYLOAD_ROOT="$STAGE_DIR/payload"
TARGET_EXT_DIR="$PAYLOAD_ROOT/Library/Application Support/Adobe/CEP/extensions/Veo-Bridge"

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "ERROR: manifest not found: $MANIFEST_PATH"
  exit 1
fi

if ! command -v pkgbuild >/dev/null 2>&1; then
  echo "ERROR: pkgbuild is not available on this macOS machine."
  exit 1
fi

read_manifest_attr() {
  local attr="$1"
  local value
  value="$(sed -n "s/.*${attr}=\"\([^\"]*\)\".*/\1/p" "$MANIFEST_PATH" | head -n 1)"
  printf '%s' "$value"
}

BUNDLE_VERSION="$(read_manifest_attr "ExtensionBundleVersion")"
BUNDLE_ID="$(read_manifest_attr "ExtensionBundleId")"

if [[ -z "$BUNDLE_VERSION" ]]; then
  BUNDLE_VERSION="0.0.0"
fi
if [[ -z "$BUNDLE_ID" ]]; then
  BUNDLE_ID="com.veobridge.bundle"
fi

PKG_IDENTIFIER="${BUNDLE_ID}.pkg"
PKG_NAME="Veo-Bridge-${BUNDLE_VERSION}.pkg"
PKG_PATH="$DIST_DIR/$PKG_NAME"
PKG_SIGN_IDENTITY="${PKG_SIGN_IDENTITY:-}"

mkdir -p "$DIST_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$TARGET_EXT_DIR"

copy_item() {
  local rel="$1"
  if [[ ! -e "$ROOT_DIR/$rel" ]]; then
    echo "ERROR: missing required path: $rel"
    exit 1
  fi
  cp -R "$ROOT_DIR/$rel" "$TARGET_EXT_DIR/$rel"
}

copy_item "CSXS"
copy_item "css"
copy_item "js"
copy_item "jsx"
copy_item "index.html"
copy_item "gallery.html"

rm -f "$PKG_PATH"

PKGBUILD_ARGS=(
  --root "$PAYLOAD_ROOT"
  --identifier "$PKG_IDENTIFIER"
  --version "$BUNDLE_VERSION"
  --install-location "/"
  "$PKG_PATH"
)

if [[ -n "$PKG_SIGN_IDENTITY" ]]; then
  PKGBUILD_ARGS=(--sign "$PKG_SIGN_IDENTITY" "${PKGBUILD_ARGS[@]}")
fi

pkgbuild "${PKGBUILD_ARGS[@]}"
rm -rf "$STAGE_DIR"

echo "Build complete: $PKG_PATH"
if [[ -n "$PKG_SIGN_IDENTITY" ]]; then
  echo "Signed with identity: $PKG_SIGN_IDENTITY"
else
  echo "Package is unsigned. For distribution, set PKG_SIGN_IDENTITY."
fi
