# `web_view` browser sidecar

Static retrieval and the `web_view({url})` interface are unchanged; the optional
`offset` input only reads later chunks of a long page. When a page
needs a browser, Board starts an ephemeral extraction agent with the project's
configured harness/model. Its Playwright CLI connects through the API relay to
a Board-owned browser session:

```
project agent → API relay /board-api → Board /api/web-browser/sessions/:id/cdp
                                      → web-browser sidecar → website
```

The control connection uses authenticated WebSockets. Website traffic originates
directly from the sidecar, without Squid or project domain allowlists. The
operator chose direct reachability: host/LAN destinations may be reachable, and
this service does not enforce public-only destinations. Host firewall rules are
unchanged.

## Deployment

The `web-browser` Compose service reuses `carapa-bot-agent:latest` (override with
`WEB_BROWSER_IMAGE`). That image must include Chromium and Bun; the project
sandbox must include Playwright CLI with CDP endpoint/header support. The host
must already provide `runsc`, `carapabox-agent`, and the shared seccomp profile
from the CarapaBox repository. Compose defaults to
`../carapa-box/security/seccomp-default.json`; set `WEB_BROWSER_SECCOMP_PROFILE`
to the profile location when the repositories are not siblings.

The service overrides the agent entrypoint with the read-only Board-owned
`src/modules/web/sidecar` service. It has no project, agent-home or Board-data
mounts, no published port, and no Docker socket. It runs as UID 1000 with a
read-only root, dropped capabilities, the Chromium sandbox, and temporary
profiles. The separate `browser_egress` bridge connects Board and the sidecar.

Provision two files in Board's existing `SECRETS_DIR` before deployment:

- `web_browser_sidecar_token`: a random 32-byte token encoded as hexadecimal,
  readable only by the service owner; mounted only into Board.
- `web_browser_sidecar_token_sha256`: the SHA-256 hexadecimal digest of that
  token, excluding its trailing newline; mounted only into the sidecar. A browser
  reading the digest cannot use it as a management credential.

Preserve existing tokens when redeploying. Start the sidecar, enable the relay's
internal WebSocket route, then deploy Board. Existing clients with a `board-api`
service need `"websocketPaths": ["/api/web-browser/sessions/"]` in that service's
relay configuration. No Squid/network-policy reload is required. Board never
uses Docker to manage this service.

Settings and defaults:

| Setting                           | Default                         |
| --------------------------------- | ------------------------------- |
| `WEB_BROWSER_SIDECAR_URL`         | `http://web-browser:3210`       |
| `WEB_BROWSER_AGENT_GATEWAY_URL`   | `ws://api-relay:8080/board-api` |
| `WEB_BROWSER_MAX_SESSIONS`        | 4                               |
| `WEB_BROWSER_AGENT_TIMEOUT_MS`    | 90000                           |
| `WEB_BROWSER_TAB_MAX_SESSIONS`    | 2                               |
| `WEB_BROWSER_TAB_LEASE_MS`        | 1200000                         |
| `WEB_BROWSER_TAB_MAX_LIFETIME_MS` | 14400000 (Board only)           |

The timeout must agree between Board and the sidecar. The same holds for
`WEB_BROWSER_TAB_LEASE_MS`; `WEB_BROWSER_TAB_MAX_SESSIONS` is read by the
sidecar, and `WEB_BROWSER_TAB_MAX_LIFETIME_MS` only by Board. Health at `/health` is
liveness; exercise a session to verify Chromium startup and external access.

## Ownership and cleanup

Board mints a separate capability for each group/run/session and sends it to the
CLI in the CDP connection header, never in a URL or prompt. The gateway forwards
only to its recorded session; callers cannot choose an upstream. Browsers use
separate Chromium processes and profiles. Capacity includes pending launches.

Completion, cancellation and timeout revoke access and clean both the local CLI
connection and remote browser in parallel, with a 15-second cleanup deadline.
The sidecar independently expires sessions if Board crashes. Restart recovery
also deletes sessions by their deterministic IDs. Expiration/crashes close active
connections. Capacity, startup and sidecar outages return explicit errors;
there is no project-local Chromium fallback.

### Browser tab on native runners

A native (Mac) CarapaBox runner has no local Chromium. When Start or Restart is
used in the Browser tab for a project on such a runner, Board leases a hub
browser for that persistent browser and the runner's `browser-open` connects to
it through the same gateway as `web_view`:

- The lease ID is `browser-tab-<40 hex>`, derived from the persistent browser ID
  (`browser-<40 hex>`). Board writes only the gateway URL
  (`PLAYWRIGHT_MCP_CDP_ENDPOINT`) into the browser descriptor. The per-lease
  token is passed solely as `PLAYWRIGHT_MCP_CDP_HEADERS` in the environment of
  that one `sandbox_exec`; it is never written to disk. An already live lease is
  reused by Restart.
- The sidecar caps each lease at `WEB_BROWSER_TAB_LEASE_MS` (default 20 minutes)
  and Board renews it every third of that window, so the lease follows the
  browser while it is in use. Renewal stops, and the lease is deleted, once
  `WEB_BROWSER_TAB_MAX_LIFETIME_MS` (default 4 hours) has elapsed since it was
  created; Start opens a new one. If Board stops (crash or restart), renewal
  stops and the sidecar expires the lease within one window. After a Board
  restart the next Start deletes any leftover session with the same ID and
  creates a fresh lease. `web_view`'s `WEB_BROWSER_AGENT_TIMEOUT_MS` lifetime is
  unchanged; renewal is only accepted for tab leases.
- Tab leases use a separate pool of `WEB_BROWSER_TAB_MAX_SESSIONS` (default 2),
  so they neither reduce nor are limited by `WEB_BROWSER_MAX_SESSIONS`. When the
  pool is full, Start fails with an explicit capacity error; there is no local
  fallback.
- The lease is deleted at the sidecar on explicit Close, idle expiry
  (`BROWSER_IDLE_TIMEOUT_MS`), sandbox stop or restart, and after a failed first
  Start (including a runner that disconnects during dispatch). A descriptor that
  carries the hub endpoint marks a browser that used a lease, so these paths
  still delete the sidecar session after a Board restart emptied its memory.
- Board replicates the rewritten descriptor to the runner (strict flush) before
  it runs `browser-open`, because the Mac reads its own copy.
- Docker boxes keep running Chromium locally: no lease and no descriptor
  endpoint.

**Deploy Board and the `web-browser` sidecar together** whenever the sidecar
code changes (it accepts the `browser-tab-` ID prefix, a separate capacity and
`PATCH /sessions/:id` renewal). A new Board against an old sidecar fails tab
starts with a sidecar error; an old Board is unaffected by the new sidecar. Pass
`WEB_BROWSER_TAB_MAX_SESSIONS` and `WEB_BROWSER_TAB_LEASE_MS` to the sidecar
(the bundled Compose file does).

Project browser viewing/recording remains a separate lifecycle. Existing GPU
browser policies remain useful for local project workflows, but are no longer
prerequisites for `web_view` browser startup.

## Verification

Run Board's verifier in its supported Carapa sandbox. The web tests cover
retrieval/caching, cancellation, capacity, session credentials, crash/expiry
cleanup and the real Board-to-sidecar WebSocket transport. The relay has a Node
integration test covering direct forwarding, early frames, authentication and
disabled/unauthorized paths, alongside its existing provider tests.

For rollout acceptance, exercise an interactive page and invoke Times Trader's
`times-trader-research-check --only board_web_view`. Confirm successful source
content from Apple Newsroom without changing its project egress policy. The
runtime smoke check must also confirm temporary session deletion.

Rollback requires restoring the previous Board image and relay source/config
snapshot together. Stop only `web-browser` once no extraction uses it; preserve
all project sandboxes and shared proxy policies.

## Delivery evidence — 2026-09-13

- Supported Board sandbox verifier: **2,752 tests**, all gates green; deployment
  image gates also passed. Box typechecks and **13 relay tests** passed.
- Sidecar: Chrome **152.0.7977.82** changed a controlled page's heading through
  JavaScript interaction and loaded **Newsroom - Apple** directly. Test-session
  deletion returned **204**.
- Production Times Trader MCP `web_view`: **4,267 characters**, status **ok**.
  Evidence: `/workspace/data/connection-checks/research-20260913T115402061472Z.json`
  inside Times Trader. The recorded run `run-1789300370713-1oxqvs` confirms a
  dedicated remote CDP session through `/board-api` and cleared browser-proxy
  settings. Its completed-session credential was rejected with **403**. Board,
  relay and sidecar were healthy after the check.
- Project Squid/domain policies and host firewall rules were unchanged.
- Previous Board image retained as `carapa-board:before-web-browser-20260913`;
  deployed image ID is
  `sha256:36928506952f108a8be80efc4b3e4da8879a60b1f8435417f7c11c7ecd6d5324`.
