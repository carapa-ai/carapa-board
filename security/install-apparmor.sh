#!/usr/bin/env bash
# Load the CarapaBoard AppArmor profile into the kernel.
# Usage: sudo bash security/install-apparmor.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE="$SCRIPT_DIR/apparmor-board"

if [ ! -f "$PROFILE" ]; then
  echo "ERROR: Profile not found: $PROFILE" >&2
  exit 1
fi

DEST_DIR="/etc/apparmor.d/containers"
DEST="$DEST_DIR/apparmor-board"

mkdir -p "$DEST_DIR"

echo "Installing AppArmor profile: $PROFILE -> $DEST"
cp "$PROFILE" "$DEST"
ln -sf "$DEST" "/etc/apparmor.d/apparmor-board"

if apparmor_parser -r -W "$DEST" 2>&1; then
  echo "Profile loaded successfully"
else
  echo "ERROR: Failed to load profile" >&2
  exit 1
fi

echo "Verifying profile is loaded..."
AA_STATUS="$(aa-status 2>/dev/null || true)"
if grep -q carapabox-board <<<"$AA_STATUS"; then
  echo "OK: carapabox-board profile is active (enforce mode)"
else
  echo "WARNING: Profile loaded but not visible in aa-status. Check for errors." >&2
fi
