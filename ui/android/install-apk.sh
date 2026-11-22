#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$UI_DIR/.." && pwd)"
PACKAGE="ai.carapa.board"
ACTIVITY="${PACKAGE}/.MainActivity"
# In a git worktree, untracked state (store/) lives in the main checkout.
STATE_DIR="$REPO_DIR"
GIT_COMMON_DIR="$(git -C "$REPO_DIR" rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -n "$GIT_COMMON_DIR" ]]; then
    STATE_DIR="$(cd "$REPO_DIR" && cd "$GIT_COMMON_DIR/.." && pwd -P)"
fi
APK="${SCRIPT_DIR}/app/build/outputs/apk/debug/app-debug.apk"
REMOTE_APK="/data/local/tmp/carapa-board-debug.apk"
# Written after each build so SKIP_BUILD=1 can reinstall the same APK on another device.
BUILD_INFO="${SCRIPT_DIR}/app/build/outputs/apk/debug/install-build-info.env"
SKIP_BUILD="${SKIP_BUILD:-0}"
ADB_WAIT_SECONDS="${ADB_WAIT_SECONDS:-60}"
BUILD_COMMIT="$(git -C "$UI_DIR/.." rev-parse --short=12 HEAD)"
if [[ -n "$(git -C "$UI_DIR/.." status --porcelain)" ]]; then
    DIRTY_FINGERPRINT="$({
        git -C "$UI_DIR/.." diff HEAD --binary
        git -C "$UI_DIR/.." ls-files --others --exclude-standard | sort | while IFS= read -r file; do
            printf '%s\n' "$file"
            sha256sum "$UI_DIR/../$file"
        done
    } | sha256sum | cut -c1-8)"
    BUILD_LABEL="${BUILD_COMMIT}-dirty-${DIRTY_FINGERPRINT}"
else
    BUILD_LABEL="$BUILD_COMMIT"
fi
if [[ "$SKIP_BUILD" == "1" ]]; then
    if [[ ! -f "$APK" || ! -f "$BUILD_INFO" ]]; then
        echo "SKIP_BUILD=1 needs a previous build of this script: missing $APK or $BUILD_INFO" >&2
        exit 1
    fi
    # shellcheck disable=SC1090
    source "$BUILD_INFO"
    BUILD_LABEL="$SAVED_BUILD_LABEL"
    ANDROID_OTA_BUILTIN_VERSION="$SAVED_OTA_BUILTIN_VERSION"
    ANDROID_OTA_BUILTIN_GENERATION="$SAVED_OTA_BUILTIN_GENERATION"
fi
export BUILD_COMMIT="$BUILD_LABEL"
export VITE_BUILD_COMMIT="$BUILD_LABEL"

export PATH="${HOME}/Android/Sdk/platform-tools:${PATH}"

adb_cmd() {
    if [[ -n "${ANDROID_SERIAL:-}" ]]; then
        adb -s "$ANDROID_SERIAL" "$@"
    else
        adb "$@"
    fi
}

wait_for_device() {
    echo "==> Waiting for device (up to ${ADB_WAIT_SECONDS}s)..."
    local deadline=$((SECONDS + ADB_WAIT_SECONDS))
    while (( SECONDS < deadline )); do
        local state
        if [[ -n "${ANDROID_SERIAL:-}" ]]; then
            state="$(adb devices 2>/dev/null | awk -v serial="$ANDROID_SERIAL" '$1 == serial { print $2 }')"
        else
            state="$(adb devices 2>/dev/null | awk '$2 == "device" { print $2; exit }')"
        fi
        if [[ "$state" == "device" ]]; then
            adb_cmd get-state >/dev/null 2>&1 && return 0
        fi
        sleep 2
    done
    echo "No device in 'device' state. Check USB cable and USB debugging." >&2
    adb devices -l >&2 || true
    exit 1
}

if [[ -z "${ANDROID_SERIAL:-}" ]]; then
    CONNECTED_SERIALS="$(adb devices 2>/dev/null | awk '$2 == "device" { print $1 }' || true)"
    if (( $(printf '%s\n' "$CONNECTED_SERIALS" | grep -c .) > 1 )); then
        echo "More than one device is connected; set ANDROID_SERIAL to the target serial:" >&2
        printf '  %s\n' $CONNECTED_SERIALS >&2
        exit 1
    fi
fi

if [[ "$SKIP_BUILD" == "1" ]]; then
    echo "==> SKIP_BUILD=1: reusing existing APK for build ${BUILD_LABEL}"
else
    echo "==> Building CarapaBoard commit ${BUILD_LABEL}"
    OTA_PUBLIC_KEY_FILE="${ANDROID_OTA_PUBLIC_KEY_FILE:-$STATE_DIR/store/android-ota/public-key.base64}"
    if [[ ! -s "$OTA_PUBLIC_KEY_FILE" ]]; then
        echo "Android OTA public key is missing: $OTA_PUBLIC_KEY_FILE" >&2
        echo "Run scripts/generate-android-ota-keys.sh with the same signing-key path used by Docker Compose." >&2
        exit 1
    fi
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
        echo "CapacitorUpdater patch is missing or duplicated; run bun install in ui/ before installing." >&2
        exit 1
    fi
    echo "==> Syncing web assets (vite build + cap sync)..."
    (cd "$UI_DIR" && npm run cap:sync)

    OTA_METADATA="$UI_DIR/ota/candidate.json"
    export ANDROID_OTA_BUILTIN_VERSION="$(sed -n 's/.*"version": "\([a-f0-9]*\)".*/\1/p' "$OTA_METADATA")"
    export ANDROID_OTA_BUILTIN_GENERATION="$(sed -n 's/.*"bundleGeneration": \([0-9]*\).*/\1/p' "$OTA_METADATA")"
    export ANDROID_OTA_PUBLIC_KEY="$(tr -d '\r\n' < "$OTA_PUBLIC_KEY_FILE")"
    if [[ -z "$ANDROID_OTA_BUILTIN_VERSION" || -z "$ANDROID_OTA_BUILTIN_GENERATION" || -z "$ANDROID_OTA_PUBLIC_KEY" ]]; then
        echo "Invalid Android OTA build metadata or public key." >&2
        exit 1
    fi

    echo "==> Building debug APK..."
    (cd "$SCRIPT_DIR" && ./gradlew assembleDebug)
    echo "==> Checking that the APK contains Firebase (google_app_id)..."
    SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
    AAPT2="$(find "$SDK_ROOT/build-tools" -name aapt2 -type f 2>/dev/null | sort -V | tail -n 1 || true)"
    APKANALYZER="$(find "$SDK_ROOT/cmdline-tools" -name apkanalyzer -type f 2>/dev/null | sort -V | tail -n 1 || true)"
    if [[ -n "$AAPT2" ]]; then
        RESOURCES="$("$AAPT2" dump resources "$APK" 2>/dev/null || true)"
    elif [[ -n "$APKANALYZER" ]]; then
        RESOURCES="$("$APKANALYZER" resources names --config default --type string "$APK" 2>/dev/null || true)"
    else
        RESOURCES=""
        echo "Note: neither aapt2 nor apkanalyzer found under $SDK_ROOT; skipping the google_app_id check." >&2
    fi
    if [[ -n "$AAPT2$APKANALYZER" ]]; then
        if grep -q 'google_app_id' <<<"$RESOURCES"; then
            echo "==> APK contains google_app_id (Firebase present)"
        else
            echo "The built APK has no google_app_id resource: Firebase is missing, push notifications would not work." >&2
            exit 1
        fi
    fi
    printf 'SAVED_BUILD_LABEL=%q\nSAVED_OTA_BUILTIN_VERSION=%q\nSAVED_OTA_BUILTIN_GENERATION=%q\n' \
        "$BUILD_LABEL" "$ANDROID_OTA_BUILTIN_VERSION" "$ANDROID_OTA_BUILTIN_GENERATION" > "$BUILD_INFO"
fi

wait_for_device

echo "==> Installing on device..."
adb_cmd push "$APK" "$REMOTE_APK"
INSTALL_STATUS=0
INSTALL_OUTPUT="$(adb_cmd shell pm install -r -d -t "$REMOTE_APK" 2>&1)" || INSTALL_STATUS=$?
printf '%s\n' "$INSTALL_OUTPUT"
adb_cmd shell rm -f "$REMOTE_APK" >/dev/null 2>&1 || true
if [[ "$INSTALL_OUTPUT" == *INSTALL_FAILED_UPDATE_INCOMPATIBLE* ]]; then
    echo "The device already has ${PACKAGE} signed with a different key than this build's debug key." >&2
    echo "This script never uninstalls it (that would erase its login, PIN and device registration)." >&2
    echo "Use a device without the app, or build with the key it was signed with." >&2
    exit 1
elif (( INSTALL_STATUS != 0 )); then
    exit "$INSTALL_STATUS"
fi

echo "==> Clearing launch-scoped log evidence..."
adb_cmd logcat -c
echo "==> Arming one-shot embedded bundle activation in app-private storage..."
adb_cmd shell run-as "$PACKAGE" mkdir -p files
adb_cmd shell run-as "$PACKAGE" touch files/carapa-activate-embedded-once
echo "==> Launching ${PACKAGE}..."
adb_cmd shell am start -n "$ACTIVITY" >/dev/null

PACKAGE_DUMP="$(adb_cmd shell dumpsys package "$PACKAGE")"
INSTALLED_VERSION="$(printf '%s\n' "$PACKAGE_DUMP" | sed -n 's/.*versionName=\([^ ]*\).*/\1/p' | head -n 1 | tr -d '\r')"
INSTALLED_VERSION_CODE="$(printf '%s\n' "$PACKAGE_DUMP" | sed -n 's/.*versionCode=\([^ ]*\).*/\1/p' | head -n 1 | tr -d '\r')"
EXPECTED_VERSION="1.0-${BUILD_LABEL}"
EXPECTED_VERSION_CODE="$(sed -n 's/.*"versionCode"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$UI_DIR/android/native-shell-version.json")"
if [[ "$INSTALLED_VERSION" != "$EXPECTED_VERSION" || "$INSTALLED_VERSION_CODE" != "$EXPECTED_VERSION_CODE" ]]; then
    echo "Installed package metadata mismatch: versionName=${INSTALLED_VERSION:-unknown} (expected ${EXPECTED_VERSION}), versionCode=${INSTALLED_VERSION_CODE:-unknown} (expected ${EXPECTED_VERSION_CODE})" >&2
    exit 1
fi
echo "==> Installed package versionName: ${INSTALLED_VERSION}"
echo "==> Installed package versionCode: ${INSTALLED_VERSION_CODE}"
echo "==> Embedded bundle generation: ${ANDROID_OTA_BUILTIN_GENERATION}"
echo "==> Verifying the active web build..."
BUILD_LOG=""
RUNTIME_LOG=""
for _ in $(seq 1 20); do
    CURRENT_LOG="$(adb_cmd logcat -d 2>/dev/null || true)"
    BUILD_LOG="$(printf '%s\n' "$CURRENT_LOG" | grep -F -e "[carapa-build] web build ${BUILD_LABEL}" -e "[carapa-build] sidebar build ${BUILD_LABEL}" | tail -n 1 || true)"
    RUNTIME_LOG="$(printf '%s\n' "$CURRENT_LOG" | grep -F '[carapa-ota-runtime]' | tail -n 1 || true)"
    [[ -n "$BUILD_LOG" && -n "$RUNTIME_LOG" ]] && break
    sleep 1
done
if [[ -z "$BUILD_LOG" ]]; then
    echo "Active web build did not match ${BUILD_LABEL}; inspect the app before proceeding." >&2
    exit 1
fi
for expected in \
    '"activeBundleId":"builtin"' \
    '"activeBundleVersion":"'"$ANDROID_OTA_BUILTIN_VERSION"'"' \
    '"activeGeneration":'"$ANDROID_OTA_BUILTIN_GENERATION" \
    '"nativeVersionCode":'"$INSTALLED_VERSION_CODE" \
    '"nativeVersionName":"'"$EXPECTED_VERSION"'"' \
    '"webBuild":"'"$BUILD_LABEL"'"'; do
    if [[ "$RUNTIME_LOG" != *"$expected"* ]]; then
        echo "Active updater runtime verification failed; missing ${expected}" >&2
        echo "Runtime evidence: ${RUNTIME_LOG:-none}" >&2
        exit 1
    fi
done
echo "Verified active updater bundle: builtin (${ANDROID_OTA_BUILTIN_VERSION})"
echo "Verified active web build: ${BUILD_LABEL}"
