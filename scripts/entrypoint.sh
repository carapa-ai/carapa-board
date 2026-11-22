#!/bin/bash
# Docker captures stdout/stderr through its configured logging driver.
CERT_DIR="/app/store/certs"
mkdir -p "$CERT_DIR"

# First boot: create a local root CA and a server certificate signed by it.
# Browsers (Firefox in particular) refuse a self-signed CA:TRUE certificate as
# a site's own certificate even after it is imported, so the root and the leaf
# are kept separate. Import store/certs/ca.crt as a trusted authority; see
# docs/tls-cert-trust.md. Extra names: CARAPA_BOARD_CERT_SANS, e.g.
# "DNS:board.home.arpa,IP:192.168.1.20". Existing certificates are kept.
if [ ! -f "$CERT_DIR/server.key" ]; then
    echo "Generating a local CA and server certificate for CarapaBoard..."
    tmp="$(mktemp -d)"
    if [ ! -f "$CERT_DIR/ca.key" ]; then
        (umask 077; openssl req -x509 -nodes -days 3650 -newkey rsa:3072 -sha256 \
            -keyout "$CERT_DIR/ca.key" \
            -out "$CERT_DIR/ca.crt" \
            -subj "/O=CarapaBoard/CN=CarapaBoard Local CA $(date -u +%Y-%m-%d)" \
            -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
            -addext "keyUsage=critical,keyCertSign,cRLSign")
        chmod 644 "$CERT_DIR/ca.crt"
    fi
    sans="DNS:localhost,DNS:carapa-board,IP:127.0.0.1"
    [ -z "${CARAPA_LOCAL_IP:-}" ] || sans="$sans,IP:$CARAPA_LOCAL_IP"
    [ -z "${CARAPA_BOARD_CERT_SANS:-}" ] || sans="$sans,$CARAPA_BOARD_CERT_SANS"
    printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' \
        "$sans" > "$tmp/ext.cnf"
    (umask 077; openssl req -nodes -newkey rsa:2048 -sha256 \
        -keyout "$tmp/server.key" -out "$tmp/server.csr" -subj "/CN=carapa-board")
    openssl x509 -req -in "$tmp/server.csr" -days 825 -sha256 \
        -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" -CAcreateserial \
        -extfile "$tmp/ext.cnf" -out "$tmp/server.crt"
    mv "$tmp/server.crt" "$CERT_DIR/server.crt"
    mv "$tmp/server.key" "$CERT_DIR/server.key"
    rm -rf "$tmp"
    echo "Import CARAPA_DATA_DIR/store/certs/ca.crt as a trusted authority to remove browser warnings (docs/tls-cert-trust.md)."
fi

exec bun src/index.ts
