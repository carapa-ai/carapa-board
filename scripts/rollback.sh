#!/bin/bash
# Rollback carapa-board to the previous image (tagged :rollback during last deploy).
# Usage: ./scripts/rollback.sh
# Set CARAPA_BOARD_STACK_DIR when the deployment Compose project lives outside
# this checkout (the managed service's composeDir).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${CARAPA_BOARD_STACK_DIR:-$(dirname "$SCRIPT_DIR")}"
SERVICE="carapa-board"
ROLLBACK_TAG="${SERVICE}:rollback"
LATEST_TAG="${SERVICE}:latest"
HEALTH_URL="http://localhost:3000/health"

# Check rollback image exists
if ! docker image inspect "$ROLLBACK_TAG" >/dev/null 2>&1; then
    echo "ERROR: No rollback image found ($ROLLBACK_TAG)." >&2
    echo "A deploy must have run at least once to create a rollback image." >&2
    exit 1
fi

echo "Retagging $ROLLBACK_TAG → $LATEST_TAG"
docker tag "$ROLLBACK_TAG" "$LATEST_TAG"

echo "Stopping current container..."
cd "$PROJECT_DIR"
docker compose down || true

echo "Starting with rollback image..."
docker compose up -d

echo "Waiting for health check..."
for i in $(seq 1 30); do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
        echo "Rollback successful — service is healthy."
        exit 0
    fi
    sleep 1
done

echo "WARNING: Health check timed out after 30s." >&2
echo "Check logs: docker compose logs --tail=50 $SERVICE" >&2
exit 1
