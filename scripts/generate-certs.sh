#!/bin/bash
# Helper script to generate self-signed certificates for CarapaBoard.
set -euo pipefail

# Read one KEY=value from an env file (never sourced), stripping quotes.
read_env_key() {
    local value
    [[ -f "$1" ]] || return 0
    value=$(sed -n "s/^$2=//p" "$1" | tail -n 1)
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    printf '%s' "$value"
}

# Host source of the running board's /app/store mount (empty without docker or container).
running_store_source() {
    local id
    command -v docker >/dev/null 2>&1 || return 0
    id=$(timeout 10 docker ps -q --filter label=com.docker.compose.service=carapa-board 2>/dev/null | head -n 1) || true
    [[ -n "$id" ]] || return 0
    timeout 10 docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/store"}}{{.Source}}{{end}}{{end}}' "$id" 2>/dev/null || true
}

# Main checkout of the git repository containing the current directory, or "." outside a
# linked worktree. A worktree has no untracked store/, so its fallback is the main checkout's.
main_checkout_dir() {
    local common main
    common=$(git rev-parse --git-common-dir 2>/dev/null) || { echo .; return 0; }
    main=$(cd "$common/.." && pwd -P) || { echo .; return 0; }
    if [[ "$main" == "$(pwd -P)" ]]; then echo .; else echo "$main"; fi
}

# Candidate cert dir for rule number $1 (sets CERT_DIR and CERT_RULE; CERT_DIR is empty when the
# rule has no value; returns 1 past the last rule). Mirrors docker-compose.yml's
# ${CARAPA_DATA_DIR:-${CARAPA_BOARD_SOURCE_DIR:-.}}/store; rules are evaluated lazily, in order:
# env CARAPA_DATA_DIR -> /app/store mount of the running board container ->
# CARAPA_DATA_DIR in the deploy-dir .env -> CARAPA_BOARD_SOURCE_DIR (env, then deploy-dir .env) ->
# the deploy dir itself -> CARAPA_DATA_DIR in the repo-root .env -> ./store (main checkout in a worktree).
DEPLOY_ENV="${CARAPA_BOARD_DEPLOY_DIR:+$CARAPA_BOARD_DEPLOY_DIR/.env}"
select_cert_dir() {
    local data_dir="" store_source
    CERT_DIR=""
    case "$1" in
        1) CERT_RULE="environment CARAPA_DATA_DIR"; data_dir="${CARAPA_DATA_DIR:-}" ;;
        2) CERT_RULE="/app/store mount of the running carapa-board container"
           store_source=$(running_store_source)
           if [[ -n "$store_source" ]]; then CERT_DIR="$store_source/certs"; fi
           return 0 ;;
        3) CERT_RULE="CARAPA_DATA_DIR in $DEPLOY_ENV"; data_dir="$(read_env_key "$DEPLOY_ENV" CARAPA_DATA_DIR)" ;;
        4) CERT_RULE="environment CARAPA_BOARD_SOURCE_DIR"; data_dir="${CARAPA_BOARD_SOURCE_DIR:-}" ;;
        5) CERT_RULE="CARAPA_BOARD_SOURCE_DIR in $DEPLOY_ENV"; data_dir="$(read_env_key "$DEPLOY_ENV" CARAPA_BOARD_SOURCE_DIR)" ;;
        6) CERT_RULE="CARAPA_BOARD_DEPLOY_DIR (compose file directory)"; data_dir="${CARAPA_BOARD_DEPLOY_DIR:-}" ;;
        7) CERT_RULE="CARAPA_DATA_DIR in repo-root .env"; data_dir="$(read_env_key .env CARAPA_DATA_DIR)" ;;
        8) CERT_RULE="implicit fallback"; data_dir="$(main_checkout_dir)" ;;
        *) return 1 ;;
    esac
    if [[ -n "$data_dir" ]]; then CERT_DIR="$data_dir/store/certs"; fi
}

# First rule with a value wins.
CERT_DIR=""
CERT_RULE=""
RULE_INDEX=1
while select_cert_dir "$RULE_INDEX"; do
    RULE_INDEX=$((RULE_INDEX + 1))
    [[ -n "$CERT_DIR" ]] && break
done

if [ -f ui/.env ]; then
    ENV_LOCAL_IP=$(read_env_key ui/.env VITE_LOCAL_IP)
fi

LOCAL_IP="${VITE_LOCAL_IP:-${CARAPA_LOCAL_IP:-${ENV_LOCAL_IP:-192.168.1.10}}}"
echo "Certificate directory: $CERT_DIR (chosen by: $CERT_RULE)"

mkdir -p "$CERT_DIR"

# Same layout as scripts/entrypoint.sh (the image entrypoint): a local CA (ca.crt/ca.key) signs the server
# certificate. Browsers refuse a self-signed CA:TRUE certificate as a site certificate,
# so trust ca.crt (docs/tls-cert-trust.md). --force reissues only the server
# certificate; the CA is kept so existing trust survives.
if [[ "${1:-}" == "--force" ]] || [ ! -f "$CERT_DIR/server.key" ]; then
    if [ ! -f "$CERT_DIR/ca.key" ]; then
        echo "Generating a local CA..."
        (umask 077; openssl req -x509 -nodes -days 3650 -newkey rsa:3072 -sha256 \
            -keyout "$CERT_DIR/ca.key" \
            -out "$CERT_DIR/ca.crt" \
            -subj "/O=CarapaBoard/CN=CarapaBoard Local CA $(date -u +%Y-%m-%d)" \
            -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
            -addext "keyUsage=critical,keyCertSign,cRLSign")
        chmod 644 "$CERT_DIR/ca.crt"
    fi
    echo "Generating a server certificate signed by $CERT_DIR/ca.crt..."
    sans="DNS:localhost,DNS:carapa-board,IP:127.0.0.1,IP:$LOCAL_IP"
    [ -z "${CARAPA_BOARD_CERT_SANS:-}" ] || sans="$sans,$CARAPA_BOARD_CERT_SANS"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' \
        "$sans" > "$tmp/ext.cnf"
    (umask 077; openssl req -nodes -newkey rsa:2048 -sha256 \
        -keyout "$tmp/server.key" -out "$tmp/server.csr" -subj "/CN=carapa-board")
    openssl x509 -req -in "$tmp/server.csr" -days 825 -sha256 \
        -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" -CAcreateserial \
        -extfile "$tmp/ext.cnf" -out "$tmp/server.crt"
    mv "$tmp/server.crt" "$CERT_DIR/server.crt"
    mv "$tmp/server.key" "$CERT_DIR/server.key"
    echo "Trust $CERT_DIR/ca.crt in browsers and clients (docs/tls-cert-trust.md)."
else
    echo "Using existing certificates in $CERT_DIR"
fi

# The Android app bundles no server certificate: it trusts public and
# user-installed CAs, and pins a self-signed board through the pairing link.
echo "SHA-256 of $CERT_DIR/server.crt (pin it from Account → Connect the Android app):"
openssl x509 -in "$CERT_DIR/server.crt" -noout -fingerprint -sha256

echo "Done."
