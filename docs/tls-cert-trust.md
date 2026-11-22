# Trusting the CarapaBoard certificate

When `${STORE_DIR}/certs/server.key` and `server.crt` exist at startup, carapa-board boots in HTTPS mode on the same port. On first boot the entrypoint creates them: a local CA (`ca.crt`, with its key `ca.key`) and a server certificate signed by it for `localhost`, `carapa-board`, `127.0.0.1` and any names in `CARAPA_BOARD_CERT_SANS`. Browsers and any container consuming the board's HTTP API (LLM bridge, brain client, kanban API, uploads, MCP transport) must trust **`ca.crt`** — otherwise TLS verification fails with `unable to get local issuer certificate` and the request never reaches the app.

Keep `ca.key` private: anything signed with it is trusted wherever `ca.crt` is.

## Browsers

On the board host the CA is `${CARAPA_DATA_DIR}/store/certs/ca.crt` (`CARAPA_DATA_DIR` defaults to the board checkout). Import it as a trusted **authority**, then reload the board:

- **Firefox** keeps its own store: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import, then tick *Trust this CA to identify websites*. The Ubuntu snap cannot open files inside hidden directories (such as `~/.carapa`); copy `ca.crt` to `~/Downloads` first.
- **Chrome/Chromium on Linux**: `chrome://settings/certificates` → Authorities → Import, or `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n carapa-board -i ca.crt` (package `libnss3-tools`).
- **Other devices** (phones, the Android app, another computer): import the same `ca.crt`, and add the address they use to `CARAPA_BOARD_CERT_SANS` (§7).

Installs created before this layout have no `ca.crt`: their `server.crt` is a self-signed certificate marked as a CA, which Firefox refuses as a site certificate even after importing it (`MOZILLA_PKIX_ERROR_CA_CERT_USED_AS_END_ENTITY`). Move `server.crt` and `server.key` aside and restart carapa-board to generate the CA layout.

## Containers

This guide is **container-agnostic**: it covers the standard `update-ca-certificates` flow that works for any Linux base image (Debian, Ubuntu, Alpine) and any client library that uses the system trust store (curl, wget, libcurl, OpenSSL-linked clients, Python `requests` with `certifi` opt-in, PHP/Guzzle, Node.js with `NODE_EXTRA_CA_CERTS`, etc.). Pick the section that matches how your consumer container is built.

## 0. Reach the board over the shared docker network

Before worrying about cert installation, **make sure your consumer container is on the same docker network as carapa-board and connects via the docker-internal service name**. The shipped cert's `subjectAltName` is issued for `carapa-board` (the service hostname), so this is the URL that will both resolve and pass TLS verification with no extra work:

```yaml
services:
  my-app:
    networks:
      - carapa-board_default       # join the board's network
    environment:
      CARAPA_BOARD_URL: "https://carapa-board:3000"

networks:
  carapa-board_default:
    external: true                  # created by the carapa-board stack
```

Connecting to the board's host IP or a public domain instead is what triggers the SAN headaches in §7 — avoid it unless you have a real reason to (e.g. the consumer runs outside docker).

## 1. Locate the cert on the board host

```bash
# Board startup log line tells you which mode it's in:
#   "Server running with HTTPS"  → certs present, you need this guide
#   "Server running with HTTP (Insecure)" → no TLS, skip everything below

# The CA to trust is ${STORE_DIR}/certs/ca.crt. Confirm where STORE_DIR
# points by checking the board's .env or `docker inspect carapa-board`.
ls "${STORE_DIR:-$HOME/.carapa/store/board}/certs/ca.crt"
```

Copy that file somewhere accessible to your consumer container's build context or bind-mount root. The rest of this guide calls it `carapa-board.crt`. (An install without `ca.crt` uses the older self-signed layout; see *Browsers* above.)

## 2. Quick test (ephemeral, no rebuild)

Useful for verifying the cert works before committing to a permanent install:

```bash
# Copy into the running container
docker cp ./carapa-board.crt <container>:/usr/local/share/ca-certificates/carapa-board.crt

# Rebuild the trust bundle
docker exec <container> update-ca-certificates

# Restart so any long-lived processes re-open their TLS connections
docker restart <container>
```

Changes via `docker cp` are lost the moment the container is recreated (any `docker compose up -d --force-recreate`, image update, host reboot, etc.). For anything beyond a smoke test, use one of the persistent options below.

## 3. Persistent: bind-mount the cert via docker compose

No rebuild required, but the cert is shared from the host filesystem:

```yaml
services:
  my-app:
    volumes:
      - /host/path/to/carapa-board.crt:/usr/local/share/ca-certificates/carapa-board.crt:ro
    # The trust bundle must be rebuilt AFTER the mount is in place — at
    # build time the file isn't there yet. Wrap your entrypoint:
    entrypoint: ["/bin/sh", "-c", "update-ca-certificates && exec /original/entrypoint"]
```

Substitute `/original/entrypoint` with whatever the image normally runs (check the image's Dockerfile or `docker inspect <image> --format '{{.Config.Entrypoint}} {{.Config.Cmd}}'`). For images that use shell-form `CMD`, `exec "$@"` with the original CMD passed through works as well.

## 4. Persistent: bake into the Dockerfile

Cleanest if you control the image — the cert ships with the image, no runtime wiring:

```dockerfile
COPY carapa-board.crt /usr/local/share/ca-certificates/carapa-board.crt
RUN update-ca-certificates
```

That single `RUN` writes the merged bundle to `/etc/ssl/certs/ca-certificates.crt`, which is what every OpenSSL-linked client picks up by default.

## 5. Alpine images need the tooling

The `update-ca-certificates` script is in the `ca-certificates` package, which is **not** installed in `alpine:latest` by default. Add it before the install step:

```dockerfile
RUN apk add --no-cache ca-certificates
COPY carapa-board.crt /usr/local/share/ca-certificates/carapa-board.crt
RUN update-ca-certificates
```

Debian/Ubuntu base images (`debian`, `ubuntu`, `php`, `node`, `python` slim variants) ship it already.

## 6. Verify

Inside the consumer container, hit the board over the shared network:

```bash
curl -v https://carapa-board:3000/health
# Expect: "SSL certificate verify ok" and 200 OK with {"status":"ok",...}
```

If you see `unable to get local issuer certificate` (or `self-signed certificate`), the trust update didn't apply — or you installed `server.crt` instead of `ca.crt` — usually because the entrypoint ran the app before `update-ca-certificates`, or the bind-mount path is wrong, or the file ended up in `/etc/ssl/certs/` directly (it should be in `/usr/local/share/ca-certificates/`, with the merge step doing the symlink).

If you see `Could not resolve host`, the consumer isn't on `carapa-board_default` — re-check §0.

## 7. When you can't use the docker hostname

If your consumer genuinely can't reach the board via `carapa-board:3000` — e.g. it runs outside docker, or on a different host entirely — you'll be using an IP or external DNS name that the default cert's SAN doesn't cover, and TLS will reject with `subjectAltName does not match`. Verify what the cert covers with:

```bash
openssl x509 -in carapa-board.crt -noout -text | grep -A1 'Subject Alternative Name'
```

The right fix is to **reissue the server certificate with the names consumers actually use**. The CA stays the same, so nothing that already trusts `ca.crt` needs updating:

```bash
# In the board's .env (comma-separated openssl subjectAltName entries):
CARAPA_BOARD_CERT_SANS=DNS:carapa-board.your-domain.example,IP:192.168.1.10

# Move the current server certificate aside and restart; the entrypoint
# signs a new one with the existing CA.
mv "$STORE_DIR/certs/server.crt" "$STORE_DIR/certs/server.crt.old"
mv "$STORE_DIR/certs/server.key" "$STORE_DIR/certs/server.key.old"
docker compose up -d --force-recreate carapa-board
```

Don't try to "patch around it" with `/etc/hosts` tricks or `verify: false` in production — the SAN exists for a reason, and a correctly-issued cert is cheaper than a class of debugging sessions every time something changes.

## 8. Alternative: per-client trust (no system changes)

If you'd rather not touch the system trust store — for example, only one library in the container needs to talk to the board — most clients accept a CA file directly:

| Client | How |
|---|---|
| Node.js | `NODE_EXTRA_CA_CERTS=/path/to/carapa-board.crt` env var |
| Python `requests` | `requests.get(..., verify='/path/to/carapa-board.crt')` |
| Go `net/http` | Add to `tls.Config.RootCAs` |
| Guzzle / PHP | `['verify' => '/path/to/carapa-board.crt']` |
| curl | `--cacert /path/to/carapa-board.crt` |

System-wide trust is simpler when multiple libraries need it; per-client trust is cleaner when you want the cert dependency to live with the code that needs it.
