#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="$ROOT_DIR/CSXS/manifest.xml"
CONFIG_PATH="$ROOT_DIR/.zxp-build.env"
DIST_DIR="$ROOT_DIR/dist"
STAGE_DIR="$ROOT_DIR/.zxp-stage"

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "ERROR: manifest not found: $MANIFEST_PATH"
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

safe_name() {
  printf '%s' "$1" | sed 's/[^A-Za-z0-9._-]/-/g'
}

BUNDLE_ID_SAFE="$(safe_name "$BUNDLE_ID")"
ZXP_NAME="${BUNDLE_ID_SAFE}-${BUNDLE_VERSION}.zxp"

if [[ ! -f "$CONFIG_PATH" ]]; then
  ZXP_CMD_DEFAULT="$(command -v ZXPSignCMD 2>/dev/null || true)"
  cat > "$CONFIG_PATH" <<CFG
# Auto-generated on first run.
# Paths can contain spaces. No quotes needed.
ZXPSIGN_CMD=${ZXP_CMD_DEFAULT}
CERT_PATH=${ROOT_DIR}/.certs/VeoBridgeCert.p12
CERT_PASSWORD=
CERT_COUNTRY=US
CERT_STATE=NA
CERT_COMMON_NAME=Veo Bridge Dev
CERT_ORG=Veo Bridge
CERT_ORG_UNIT=Extensions
CFG
  echo "Created config: $CONFIG_PATH"
  echo "You can keep defaults."
fi

read_config_value() {
  local key="$1"
  awk -F'=' -v key="$key" '
    $0 ~ /^[[:space:]]*#/ { next }
    index($0, "=") == 0 { next }
    {
      k=$1
      sub(/^[[:space:]]+/, "", k)
      sub(/[[:space:]]+$/, "", k)
      if (k == key) {
        v=substr($0, index($0, "=")+1)
        sub(/^[[:space:]]+/, "", v)
        sub(/[[:space:]]+$/, "", v)
        print v
      }
    }
  ' "$CONFIG_PATH" | tail -n 1
}

ZXPSIGN_CMD="$(read_config_value "ZXPSIGN_CMD")"
CERT_PATH="$(read_config_value "CERT_PATH")"
CERT_PASSWORD="$(read_config_value "CERT_PASSWORD")"
CERT_COUNTRY="$(read_config_value "CERT_COUNTRY")"
CERT_STATE="$(read_config_value "CERT_STATE")"
CERT_COMMON_NAME="$(read_config_value "CERT_COMMON_NAME")"
CERT_ORG="$(read_config_value "CERT_ORG")"
CERT_ORG_UNIT="$(read_config_value "CERT_ORG_UNIT")"

if [[ -z "$ZXPSIGN_CMD" ]]; then
  ZXPSIGN_CMD="$(command -v ZXPSignCMD 2>/dev/null || true)"
fi
if [[ -z "$ZXPSIGN_CMD" ]]; then
  ZXPSIGN_CMD="$(command -v ZXPSignCmd 2>/dev/null || true)"
fi
if [[ -z "$ZXPSIGN_CMD" ]]; then
  for candidate in \
    "$HOME/.local/bin/ZXPSignCMD" \
    "$HOME/.local/bin/ZXPSignCmd" \
    "/opt/homebrew/bin/ZXPSignCMD" \
    "/opt/homebrew/bin/ZXPSignCmd" \
    "/usr/local/bin/ZXPSignCMD" \
    "/usr/local/bin/ZXPSignCmd"
  do
    if [[ -x "$candidate" ]]; then
      ZXPSIGN_CMD="$candidate"
      break
    fi
  done
fi

if [[ -z "$ZXPSIGN_CMD" ]]; then
  echo "ERROR: ZXPSignCMD not found."
  echo "Install ZXPSignCMD and set ZXPSIGN_CMD in $CONFIG_PATH"
  exit 1
fi

if [[ ! -x "$ZXPSIGN_CMD" ]]; then
  if ! command -v "$ZXPSIGN_CMD" >/dev/null 2>&1; then
    echo "ERROR: ZXPSignCMD is not executable: $ZXPSIGN_CMD"
    exit 1
  fi
fi

if [[ -z "$CERT_PATH" ]]; then
  CERT_PATH="$ROOT_DIR/.certs/VeoBridgeCert.p12"
fi

if [[ ! -f "$CERT_PATH" ]]; then
  mkdir -p "$(dirname "$CERT_PATH")"
  if [[ -z "$CERT_PASSWORD" ]]; then
    echo "No certificate found. Creating one-time self-signed cert."
    read -r -s -p "Enter certificate password: " CERT_PASSWORD
    echo
    read -r -s -p "Repeat certificate password: " CERT_PASSWORD_CONFIRM
    echo
    if [[ "$CERT_PASSWORD" != "$CERT_PASSWORD_CONFIRM" ]]; then
      echo "ERROR: passwords do not match"
      exit 1
    fi
  fi

  "$ZXPSIGN_CMD" -selfSignedCert \
    "${CERT_COUNTRY:-US}" \
    "${CERT_STATE:-NA}" \
    "${CERT_ORG:-Veo Bridge}" \
    "${CERT_COMMON_NAME:-Veo Bridge Dev}" \
    "$CERT_PASSWORD" \
    "$CERT_PATH" \
    -orgUnit "${CERT_ORG_UNIT:-Extensions}"

  echo "Created certificate: $CERT_PATH"
fi

if [[ -z "$CERT_PASSWORD" ]]; then
  read -r -s -p "Enter certificate password: " CERT_PASSWORD
  echo
fi

mkdir -p "$DIST_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

copy_item() {
  local rel="$1"
  if [[ ! -e "$ROOT_DIR/$rel" ]]; then
    echo "ERROR: missing required path: $rel"
    exit 1
  fi
  cp -R "$ROOT_DIR/$rel" "$STAGE_DIR/$rel"
}

copy_item "CSXS"
copy_item "css"
copy_item "js"
copy_item "jsx"
copy_item "index.html"
copy_item "gallery.html"

OUT_PATH="$DIST_DIR/$ZXP_NAME"
rm -f "$OUT_PATH"

"$ZXPSIGN_CMD" -sign "$STAGE_DIR" "$OUT_PATH" "$CERT_PATH" "$CERT_PASSWORD"
rm -rf "$STAGE_DIR"

echo "Build complete: $OUT_PATH"
