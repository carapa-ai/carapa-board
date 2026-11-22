#!/bin/bash
# Usage: ./build.sh [--no-cache] [--sync] [--cve]
#   --no-cache: Build docker images without cache
#   --sync: Build UI and sync to Capacitor (Android/iOS)
#   --cve: Run security vulnerability scan (requires docker scout or trivy)
#
set -e

echo "══════════════════════════════════════════════════════════"
echo "  Carapa-Board — Build & CVE Scan"
echo "══════════════════════════════════════════════════════════"

# ── Ensure local directories exist ──────────────────────────────────────
# If Docker creates these during 'compose up', they are owned by root.
# Creating them here ensures they are owned by the current user.
echo "Ensuring volume directories exist..."
mkdir -p logs

# ── Build all images ────────────────────────────────────────────────────
BUILD_ARGS=""
if [[ "${1:-}" == "--no-cache" ]]; then
    BUILD_ARGS="--no-cache"
    shift
fi

echo ""

# Catch stale lockfile before Docker build (--frozen-lockfile would fail inside the container)
if command -v bun &>/dev/null; then
    echo "Checking bun.lock is up to date..."
    if ! bun install --dry-run --frozen-lockfile 2>/dev/null; then
        echo ""
        echo "⚠  bun.lock is out of sync with package.json."
        echo "   Run 'bun install' and commit the updated bun.lock, then retry."
        exit 1
    fi
fi

# ── Optional Cert Generation ──────────────────────────────────────────
if [[ "$*" == *"--certs"* ]]; then
    echo ""
    echo "Managing security certificates..."
    ./scripts/generate-certs.sh
    echo ""
    echo "💡 TIP: You MUST now use https:// instead of http://"
    echo "   Web:   https://localhost:3000"
    echo "   App:   Ensure ui/src/lib/api-config.ts has your correct local IP."
fi

# CARAPA_BOARD_DEPLOY_DIR: operator-only directory holding the deployment
# docker-compose.yml and .env. Unset keeps the repository Compose project.
COMPOSE=(docker compose)
if [[ -n "${CARAPA_BOARD_DEPLOY_DIR:-}" ]]; then
    COMPOSE+=(-f "$CARAPA_BOARD_DEPLOY_DIR/docker-compose.yml")
fi

echo "Building hardened images...${BUILD_ARGS:+ (no cache)}"
"${COMPOSE[@]}" build $BUILD_ARGS

# ── Optional Android Sync ──────────────────────────────────────────────
if [[ "$*" == *"--sync"* ]]; then
    echo ""
    echo "Syncing Capacitor Android project..."
    if [ -d "ui/android" ]; then
        cd ui
        if [ ! -x node_modules/.bin/vite ]; then
            echo "Installing UI dependencies (bun install)..."
            bun install --frozen-lockfile
        fi
        npm run cap:sync
        cd ..
    else
        echo "⚠  No ui/android directory found, skipping sync."
    fi
fi


# ── Optional CVE Scan ──────────────────────────────────────────────────
if [[ "$*" == *"--cve"* ]]; then
    IMAGE="carapa-board:latest"
    echo "Scanning $IMAGE for CVEs..."
    if command -v docker &>/dev/null && docker scout version &>/dev/null 2>&1; then
        docker scout cves "$IMAGE" --only-severity critical,high 2>/dev/null || true
    elif command -v trivy &>/dev/null; then
        trivy image "$IMAGE" --severity CRITICAL,HIGH 2>/dev/null || true
    else
        echo "  (no CVE scanner found — install docker scout or trivy)"
    fi
fi
