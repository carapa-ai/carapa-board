#!/usr/bin/env bash
set -euo pipefail

# Native shell edits must be accompanied by an intentional compatibility bump.
# Android test sources are not shipped in the shell, so they are excluded.
BASE_REF="${1:-${ANDROID_NATIVE_BASE_REF:-}}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "$BASE_REF" ]]; then
  for candidate in origin/develop origin/main develop main; do
    if git -C "$ROOT_DIR" rev-parse --verify "$candidate" >/dev/null 2>&1; then
      BASE_REF="$(git -C "$ROOT_DIR" merge-base HEAD "$candidate")"
      break
    fi
  done
fi
if [[ -z "$BASE_REF" ]]; then
  echo "Unable to resolve a develop/main merge-base; set ANDROID_NATIVE_BASE_REF or pass a base ref" >&2
  exit 2
fi
VERSION_FILE="$ROOT_DIR/ui/android/native-shell-version.json"
CURRENT_CODE="$(sed -n 's/.*"versionCode"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$VERSION_FILE")"
BASE_CODE="$(git -C "$ROOT_DIR" show "$BASE_REF:ui/android/native-shell-version.json" 2>/dev/null | sed -n 's/.*"versionCode"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
if [[ -z "$CURRENT_CODE" || -z "$BASE_CODE" ]]; then
  echo "Unable to read native shell versionCode from current tree or $BASE_REF" >&2
  exit 1
fi
native_files_changed="$(git -C "$ROOT_DIR" diff --name-only "$BASE_REF" -- \
    ui/android/app/src ui/android/app/build.gradle ui/android/app/proguard-rules.pro \
    ui/android/build.gradle ui/android/capacitor.build.gradle \
    ui/android/capacitor.settings.gradle ui/android/settings.gradle \
    ui/android/gradle.properties ui/android/variables.gradle \
    ui/android/app/src/main/AndroidManifest.xml ui/capacitor.config.ts \
    ':(exclude)ui/android/app/src/test' ':(exclude)ui/android/app/src/androidTest')"
native_dependency_changed=0
if git -C "$ROOT_DIR" diff "$BASE_REF" -- ui/package.json |
    grep -Eq '^[+-].*"(@capacitor/|@capgo/|capacitor-)' ; then
  native_dependency_changed=1
fi
if git -C "$ROOT_DIR" diff "$BASE_REF" -- ui/package-lock.json ui/bun.lock |
    grep -Eq '^[+-].*(@capacitor/|@capgo/|capacitor-)' ; then
  native_dependency_changed=1
fi
if git -C "$ROOT_DIR" diff --name-only "$BASE_REF" -- ui/patches/ |
    grep -q . ; then
  native_dependency_changed=1
fi
if [[ -n "$native_files_changed" || "$native_dependency_changed" == 1 ]]; then
  if (( CURRENT_CODE <= BASE_CODE )); then
    echo "Native Android changes require versionCode bump: $BASE_CODE -> $CURRENT_CODE" >&2
    exit 1
  fi
fi
echo "Native shell compatibility versionCode: $BASE_CODE -> $CURRENT_CODE"
