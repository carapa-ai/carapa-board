#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [secrets-directory]" >&2
  exit 2
fi

if [[ $# -eq 1 ]]; then
  SECRETS_TARGET="$1"
  if [[ "$SECRETS_TARGET" != /* ]]; then
    SECRETS_TARGET="$REPO_DIR/$SECRETS_TARGET"
  fi
else
  SECRETS_TARGET="${SECRETS_DIR:-$REPO_DIR/store/secrets}"
fi

SIGNING_KEY_PATH="$SECRETS_TARGET/android_ota_private_key"
PUBLIC_KEY_PATH="$REPO_DIR/store/android-ota/public-key.base64"

if [[ -e "$SIGNING_KEY_PATH" || -e "$PUBLIC_KEY_PATH" ]]; then
  echo "Refusing to overwrite existing Android OTA signing material." >&2
  echo "Private: $SIGNING_KEY_PATH" >&2
  echo "Public:  $PUBLIC_KEY_PATH" >&2
  exit 1
fi

mkdir -p "$SECRETS_TARGET" "$(dirname "$PUBLIC_KEY_PATH")"
umask 077
openssl genpkey -algorithm Ed25519 -out "$SIGNING_KEY_PATH"
openssl pkey -in "$SIGNING_KEY_PATH" -pubout -outform DER \
  | tail -c 32 \
  | base64 | tr -d '\n' > "$PUBLIC_KEY_PATH"
printf '\n' >> "$PUBLIC_KEY_PATH"
chmod 600 "$SIGNING_KEY_PATH" "$PUBLIC_KEY_PATH"

echo "Created Android OTA signing material."
echo "Private Docker secret: $SIGNING_KEY_PATH"
echo "APK public key:       $PUBLIC_KEY_PATH"
echo "Keep the private key backed up; losing it requires another USB bootstrap install."
