#!/usr/bin/env bash
# Builds a signed Android App Bundle (.aab) for a Google Play upload.
# Never calls adb, installs, uploads, or writes a keystore or password.
# See docs/android-play-release.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$UI_DIR/.." && pwd)"
# In a git worktree, untracked state (google-services.json) lives in the main checkout.
STATE_DIR="$REPO_DIR"
GIT_COMMON_DIR="$(git -C "$REPO_DIR" rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -n "$GIT_COMMON_DIR" ]]; then
    STATE_DIR="$(cd "$REPO_DIR" && cd "$GIT_COMMON_DIR/.." && pwd -P)"
fi
BUNDLE="${SCRIPT_DIR}/app/build/outputs/bundle/release/app-release.aab"
ASSETS_DIR="${SCRIPT_DIR}/app/src/main/assets/public"

# `cap sync` rewrites these tracked files when node_modules is reached through a symlink (a worktree).
# The script never restores or reverts any file. The clean-tree check below has no exceptions, so an
# operator edit cannot exist when cap sync starts, and a difference cap sync leaves behind is reported
# at the end for the operator to drop.
GENERATED_FILES=(ui/android/capacitor.settings.gradle ui/android/app/capacitor.build.gradle)
DIRTY_FILES="$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)"
if [[ -n "$DIRTY_FILES" ]]; then
    ONLY_GENERATED=1
    while IFS= read -r line; do
        [[ " ${GENERATED_FILES[*]} " == *" ${line:3} "* ]] || ONLY_GENERATED=0
    done <<< "$DIRTY_FILES"
    if [[ "$ONLY_GENERATED" == "1" ]]; then
        echo "Uncommitted changes in the cap sync outputs (left by an earlier build):" >&2
        echo "$DIRTY_FILES" >&2
        echo "Drop them with: git checkout -- ${GENERATED_FILES[*]}" >&2
    else
        echo "Tracked files have uncommitted changes; commit or revert them so the bundle maps to one commit:" >&2
        echo "$DIRTY_FILES" >&2
    fi
    exit 1
fi
if [[ -z "${ANDROID_RELEASE_KEYSTORE_PROPERTIES:-}" ]]; then
    echo "ANDROID_RELEASE_KEYSTORE_PROPERTIES is not set. Point it at a properties file outside the repository; see docs/android-play-release.md section 1." >&2
    exit 1
fi
if [[ ! -f "$ANDROID_RELEASE_KEYSTORE_PROPERTIES" ]]; then
    echo "ANDROID_RELEASE_KEYSTORE_PROPERTIES points to a missing file: $ANDROID_RELEASE_KEYSTORE_PROPERTIES" >&2
    exit 1
fi
# Gradle and the build steps run from other directories; resolve the path against the caller's directory now.
ANDROID_RELEASE_KEYSTORE_PROPERTIES="$(cd "$(dirname "$ANDROID_RELEASE_KEYSTORE_PROPERTIES")" && pwd -P)/$(basename "$ANDROID_RELEASE_KEYSTORE_PROPERTIES")"
export ANDROID_RELEASE_KEYSTORE_PROPERTIES

GOOGLE_SERVICES="$SCRIPT_DIR/app/google-services.json"
if [[ ! -s "$GOOGLE_SERVICES" ]]; then
    MAIN_GOOGLE_SERVICES="$STATE_DIR/ui/android/app/google-services.json"
    if [[ -s "$MAIN_GOOGLE_SERVICES" ]]; then
        echo "==> Copying google-services.json from $MAIN_GOOGLE_SERVICES"
        cp "$MAIN_GOOGLE_SERVICES" "$GOOGLE_SERVICES"
    else
        echo "google-services.json is missing: $GOOGLE_SERVICES (also not in $MAIN_GOOGLE_SERVICES)" >&2
        echo "Every APK needs Firebase for push notifications. See docs/fcm-setup.md section 2." >&2
        exit 1
    fi
fi
echo "==> Verifying Android dependency patches..."
UPDATER_SOURCE="$UI_DIR/node_modules/@capgo/capacitor-updater/android/src/main/java/ee/forgr/capacitor_updater/CapacitorUpdaterPlugin.java"
if [[ ! -f "$UPDATER_SOURCE" ]] || [[ "$(grep -c 'public boolean resetToBuiltinForCarapa()' "$UPDATER_SOURCE" || true)" != "1" ]]; then
    echo "CapacitorUpdater patch is missing or duplicated; run bun install in ui/ before building." >&2
    exit 1
fi

BUILD_COMMIT="$(git -C "$REPO_DIR" rev-parse --short=12 HEAD)"
VERSION_CODE="$(sed -n 's/.*"versionCode"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$SCRIPT_DIR/native-shell-version.json")"
if [[ -z "$VERSION_CODE" ]]; then
    echo "Cannot read versionCode from $SCRIPT_DIR/native-shell-version.json" >&2
    exit 1
fi
export BUILD_COMMIT
export VITE_BUILD_COMMIT="$BUILD_COMMIT"
# A public build contains no operator address, whatever ui/.env* or the caller's environment hold.
export VITE_API_URL=""
export VITE_LOCAL_IP=""
export VITE_LOCAL_HOSTNAMES=""
# A public build embeds no OTA update key; boards supply theirs through the pairing link.
unset ANDROID_OTA_PUBLIC_KEY
export ANDROID_VERSION_NAME="${ANDROID_VERSION_NAME:-1.${VERSION_CODE}}"

echo "==> Building CarapaBoard release commit ${BUILD_COMMIT} (versionCode ${VERSION_CODE})"
echo "==> Syncing web assets (vite build + cap sync)..."
(cd "$UI_DIR" && npm run cap:sync)

OTA_METADATA="$UI_DIR/ota/candidate.json"
export ANDROID_OTA_BUILTIN_VERSION="$(sed -n 's/.*"version": "\([a-f0-9]*\)".*/\1/p' "$OTA_METADATA")"
export ANDROID_OTA_BUILTIN_GENERATION="$(sed -n 's/.*"bundleGeneration": \([0-9]*\).*/\1/p' "$OTA_METADATA")"
if [[ -z "$ANDROID_OTA_BUILTIN_VERSION" || -z "$ANDROID_OTA_BUILTIN_GENERATION" ]]; then
    echo "Invalid Android OTA build metadata: $OTA_METADATA" >&2
    exit 1
fi

echo "==> Building release bundle..."
rm -f "$BUNDLE"
(cd "$SCRIPT_DIR" && ./gradlew bundleRelease)
if [[ ! -f "$BUNDLE" ]]; then
    echo "Gradle finished but $BUNDLE does not exist." >&2
    exit 1
fi

echo "==> Checking that the web assets contain no operator address..."
# Decode the values the way Vite's dotenv does (quotes, inline comments) without executing the files.
DOTENV_VALUES_JS='
const fs = require("fs");
const [file, ...names] = process.argv.slice(1);
const text = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
const line = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*\x27(?:\\\x27|[^\x27])*\x27|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\n]+)?\s*(?:#.*)?(?:$|$)/gm;
const found = {};
let match;
while ((match = line.exec(text)) !== null) {
  let value = (match[2] || "").trim();
  const quote = value[0];
  value = value.replace(/^([\x27"`])([\s\S]*)\1$/gm, "$2");
  if (quote === "\"") value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
  found[match[1]] = value;
}
for (const name of names) if (found[name]) process.stdout.write(name + "\0" + found[name] + "\0");
'
for env_file in .env .env.local .env.production .env.production.local; do
    [[ -f "$UI_DIR/$env_file" ]] || continue
    while IFS= read -r -d '' name && IFS= read -r -d '' value; do
        if grep -rqF -- "$value" "$ASSETS_DIR"; then
            echo "The web assets contain the value of ${name} from ui/${env_file}; the bundle is not neutral." >&2
            exit 1
        fi
    done < <(node -e "$DOTENV_VALUES_JS" "$UI_DIR/$env_file" VITE_API_URL VITE_LOCAL_IP VITE_LOCAL_HOSTNAMES)
done

BUNDLE_SIZE="$(wc -c < "$BUNDLE" | tr -d ' ')"
BUNDLE_SHA256="$(sha256sum "$BUNDLE" | cut -d' ' -f1)"
echo "==> Release bundle: ${BUNDLE}"
echo "    size:        ${BUNDLE_SIZE} bytes"
echo "    sha256:      ${BUNDLE_SHA256}"
echo "    versionCode: ${VERSION_CODE}"
echo "    versionName: ${ANDROID_VERSION_NAME}"
echo "    commit:      ${BUILD_COMMIT}"
if ! git -C "$REPO_DIR" diff --quiet -- "${GENERATED_FILES[@]}"; then
    echo "Note: cap sync left changes in ${GENERATED_FILES[*]} (paths of this checkout). They were not reverted; run 'git checkout -- ${GENERATED_FILES[*]}' to drop them." >&2
fi
