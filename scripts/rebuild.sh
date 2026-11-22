#!/usr/bin/env bash
#
# Zero-downtime rebuild for carapa-board
#
# With Bun there's no TypeScript compilation step — Bun runs .ts directly.
# This script rebuilds the UI and restarts the pm2 process.
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

echo "▸ Building UI ..."
(cd "$DIR/ui" && npm run build)

echo "▸ Restarting pm2 process ..."
if pm2 describe carapa-board > /dev/null 2>&1; then
    pm2 restart carapa-board
else
    echo "  pm2 process not running — starting fresh"
    pm2 start ecosystem.config.cjs
fi

echo "✓ Done."
