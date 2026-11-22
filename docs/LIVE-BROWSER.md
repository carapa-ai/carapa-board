# Live agent browser

The Browser tab shares a sandbox Playwright browser through Board →
CarapaBox → an approved exec stream. Applications load inside the sandbox browser
with its existing cookies and network access. The iframe hosts only the trusted
Playwright viewer. No application port, CDP endpoint or dashboard port is
published, and no app headers, URLs or DNS records need changing.

## Interface and authorization

The tab is available in task, conversation and objective workspaces. Objective
Dashboard remains its own view. Browser defaults to the selected task's active
run or the conversation's persistent session and provides a session selector, worktree
context, connection state and Reconnect button. The default branch is always
available without an agent run. Start opens its browser on demand; Restart
clears its cookies and tabs; Close releases it. An optional app URL overrides
the worktree's `.preview-url`, project startup hook or default `http://nginx/` (port 80). The scheme may be omitted: the tab adds `http://` for `localhost`, IP addresses, `.local` and single-label hosts (such as `nginx`) and `https://` for any other host; URLs with a scheme are sent unchanged. Use an
internal localhost URL for apps without nginx. Once connected, the upstream
address bar, back/forward/reload and tab controls navigate the sandbox app.
Dedicated default-branch browsers use the stack service's configured working
directory when the project has no explicit workspace path, and conversation
worktree browsers use `.worktrees/<branch>` beneath it. Explicit project and
shared-sandbox paths, including their worktrees, stay pinned to their
configured workspace.
Conversation browsers say **Shared with agent**: keyboard,
mouse, navigation and tab changes do not pause automation. The viewport is a
stream; host DevTools inspect the viewer.

- `GET /api/projects/:projectId/browser/sessions` discovers the default workspace, authorized persistent conversations, and active task runs; optional `?conversationId=` includes an idle selected conversation.
- `POST /api/projects/:projectId/browser/viewers` accepts `{sessionId}` and issues an
  opaque attachment handle, valid for 30 seconds and one connection. Each user may have at most 8 pending handles; excess requests return 429.
- `POST /api/projects/:projectId/browser/sessions/:sessionId` accepts
  `{action: "start" | "restart" | "close", url?: string}` for persistent contexts.
  URLs are stored as navigation data and never interpolated into exec commands.
- The client obtains an existing one-use `/api/ws-ticket`, then connects to
  `/api/browser/ws?viewerId=…&ticket=…`. The iframe receives credentials in its
  fragment and removes them immediately from its location.

The API requires the normal fresh device signature and authenticated user.
Sharing input requires project owner/editor access (or administrator access),
plus conversation access for conversation-owned runs. Every upgrade rechecks
ownership; live connections recheck it every two seconds. Global API tokens and
session cookies alone cannot upgrade a browser connection. Box credentials stay
on the Board backend. Expired, mismatched and replayed handles fail closed.

Box provides authenticated NDJSON attach, batched input and detach on its
existing HTTP service. It resolves and policy-checks the fixed `browser-viewer`
helper, then owns the Docker exec stream. The helper accepts only a managed
browser context ID (a run ID or persistent session ID), starts
`playwright-cli show --port=0 --host=127.0.0.1`, and connects only to
that server's generated WebSocket. Its registry excludes all other contexts,
including sibling projects sharing the same sandbox. Discovery strips local
connection endpoints and launch environment metadata before sending it to UI.

## Runtime and cleanup

### Sound

Click **Enable sound** (the speaker button) in the embedded viewer to hear the
shared browser. Each attachment starts muted, including after Reconnect, so
playback begins with a local user gesture. Muting, hiding or disconnecting the
viewer stops its audio capture; the app and shared browser continue running.
Normal app playback controls and browser autoplay rules still apply.

Sound includes all tabs in the selected browser session. A private, output-only
PulseAudio server isolates each managed browser from other sessions and host
audio devices. The viewer streams bounded 40 ms stereo PCM packets through the
same authorized Board/Box connection as its frames and input, with no additional
ports or microphone access. Stage video recordings are unchanged and remain
silent.

Enabling this feature requires the updated viewer assets and a sandbox runtime
with `pulseaudio`, `pulseaudio-utils` and the audio-aware browser helpers. Rebuild
the shared runtime and dependent images, recreate affected sandboxes, then start
a new browser or use **Restart** for an existing one. Restart clears that
browser's tabs and cookies. Older images continue to support silent browsing;
updated helpers report whether the runtime or browser needs restarting.

Verification (2026-09-22): real Chromium through the pinned
`@playwright/cli@0.1.19` produced nonzero audio packets while a second concurrent
browser context remained silent; stopping capture stopped delivery. A browser
check of the published viewer with simulated transport verified its actual Web
Audio output, initial mute, enable/mute/unmute, reconnect reset and 390 px mobile
layout. Playwright typecheck, Board UI typecheck/build and the three existing
browser-session checks passed. These checks do not replace the supported-sandbox
`verify:changed` gate: native `carapa_box_local.sandbox_ps` timed out after 300
seconds, so that gate remains pending. The user subsequently confirmed live
sound playback. The shared audio runtime is promoted to the CarapaBox release
stack consumed by `carapa-box-bot`. Consumers activate that promotion by rebuilding
the public image and recreating the intended consumer instance.

### Session lifetime

Every native harness launch and retry carries an isolated browser context,
independent of the stage recording flag. Tasks retain run ownership.
Conversations use a stable project/conversation/workspace identity persisted in
`ipc/<stack>-<instance>/browser-sessions/`; it contains only browser configuration,
not agent credentials. Its daemon, sockets and discovery registry survive turn
completion, cancellation, and Board restart. A new turn reuses the same browser,
cookies and tabs while it remains open. On-demand default-branch browsing has a separate project-owned
context; select the conversation context to collaborate with that agent. The canonical CLI wrapper
resolves it on each invocation; reused harness daemons read their locked
session's current `active_run` pointer. Proxy settings remain inherited.

Viewer detach stops only its private dashboard and releases its transport and
temporary files. The agent browser and video recording survive. Task completion,
cancellation and restart recovery use one ordered finalizer: stop video, persist
recordings, then close only that run's registry and sockets. Conversation turn
finalization leaves its persistent browser open. Explicit Close/Restart and
sandbox stop/restart release persistent browsers, including idle sessions.
Board also checks persistent browsers once a minute and closes their browser
and hook-owned preview server after **15 minutes** without a visible viewer or
conversation activity. Active agent runs prevent expiry. Multiple viewers are
tracked independently; hidden tabs do not keep a browser alive, and disconnected
clients are detected with a WebSocket heartbeat. Default-branch sessions are
protected while any agent is running in that project.

Activity and completed cleanup persist across Board restarts. Expiry retains the
conversation, browser descriptor, and worktree, but releases browser tabs and
cookies. **Start** reopens the preview; new agent turns receive the managed
`browser-open <sessionId> start` instruction to resume it without starting a
duplicate server. Starts and agent launches wait for any cleanup already in
progress. `BROWSER_IDLE_TIMEOUT_MS` changes the timeout (`900000` by default;
`0` disables expiry).

On native (Mac) runners there is no local Chromium: the tab drives a hub browser
that Board leases through the web-browser sidecar (see
`WEB-BROWSER-SIDECAR.md`, "Browser tab on native runners"). Only external URLs
work there; previews of apps running on the Mac are not supported yet.

Deleted conversations and changed worktree ownership revoke viewing access.
Container shutdown releases any remaining browser resources. Concurrent finalization requests share the same promise. Emergency
container termination still removes its processes and temporary filesystem.

The transport bounds frames at 4 MiB, Box's response queue at 8 MiB, input bodies
at 64 KiB/128 messages and active/pending Box attachments at 64. Disconnect,
backpressure and startup timeout release owned viewer resources. Run termination
ends task viewers; it does not end conversation viewers.
Recording controls, session termination, debugger controls and arbitrary server
methods are rejected by the helper; the embedded UI omits those controls.

## Supported versions and rollout

The embedded dashboard and the CarapaBot select-menu renderer
(`browser-select-menu.cjs` in the CarapaBox `stacks/carapa-bot/bin` directory, not in this repository) are built from the carapa-playwright fork of Microsoft Playwright,
https://github.com/carapa-ai/playwright, branch `carapa-browser-viewer-1.66`. The
shipped files were built from commit
`58ef715f610229f18c3e332be2e8f01926094122`. Clone it as the sibling
`carapa-playwright` checkout:

```sh
git clone -b carapa-browser-viewer-1.66 https://github.com/carapa-ai/playwright ../carapa-playwright
```

The default checkout path is `../carapa-playwright`; override it with
`PLAYWRIGHT_ROOT`. Build and publish only the dashboard with:

```sh
npm run build:browser-viewer
# If the Playwright checkout has not been installed yet:
npm run build:browser-viewer -- --install
```

The publisher reads the Playwright version from
`packages/playwright-core/package.json`, rebases dashboard asset paths, enables
interactive mode by default, and preserves the Board-owned bridge and embed
CSS. Upstream files are excluded from formatting.

The fork branch is rebased onto upstream commit `95e5dca31`, the commit npm
records for `playwright-core 1.66.0-alpha-1794252756000`. The CarapaBot runtime
pins `@playwright/cli@0.1.24`, which uses that `playwright-core`, so the viewer
frontend and the runtime backend come from the same upstream source. The helper
rejects a mismatched runtime explicitly.
Any runtime version update must update the stack pin and repeat live checks.

### Updating the iframe without rebuilding Board

The Compose service can mount only the published viewer directory over the image's
`/app/ui/dist/browser-viewer` path. The mount is commented out in `docker-compose.yml`;
uncomment it to use this workflow:

```yaml
- ${BROWSER_VIEWER_DIR:-./ui/public/browser-viewer}:/app/ui/dist/browser-viewer:ro
```

After uncommenting it, the first rollout needs one normal Compose recreation so this mount is attached:

```sh
docker compose up -d
```

After that, rebuild and publish the viewer on the Docker host. The running Board
container sees the changed files immediately; no Board image build or service
redeploy is needed:

```sh
npm run build:browser-viewer
```

If the mounted directory is outside the checkout, set `BROWSER_VIEWER_DIR` in
the deployment environment and use the same variable when publishing. Refresh
or reopen the Browser tab after publishing. This updates static iframe assets
only; Board backend changes and incompatible Playwright runtime changes still
require their normal deployments.

Deploy the updated Box service, canonical runtime tools/image, and built Board UI
and backend together. Existing environment settings `CARAPA_BOX_URL` and
`CARAPA_BOX_API_TOKEN` provide the transport connection; no new environment
variables or published ports are needed. Older warm protocol daemons retire at
their next turn while preserving native resume state. Pre-upgrade runs without
a managed browser marker are excluded from run discovery. Existing per-run
conversation browsers move to the persistent lifecycle on their next turn.
Browsers remain memory-resident until explicitly closed or their sandbox stops.

Each persistent context lazily creates one browser with multiple tabs. It is
reused across turns and viewer reconnects. Separate conversations and the
project default workspace use separate browser processes and cookie stores;
there is no global browser pool or single tab shared between unrelated contexts.

## Original live-viewer verification evidence (2026-09-13)

- Board `bun run verify:changed` in its supported Carapa sandbox: **2,742 tests,
  all gates green**, including the dedicated browser suite and UI build.
- Box typecheck and five focused transport tests: auth, invalid targets, ordered
  input, disconnect ownership, cancellation while attaching, bounded output and
  bounded request bodies. Existing trusted-bin policy applies unchanged.
- Canonical runtime typecheck; 14 protocol/Codex lifecycle tests; CLI context,
  recording lifecycle and image pin checks passed.
- Actual demo-site image: HTTP dashboard, isolated simultaneous runs, live frames,
  shared navigation, mouse/keyboard input, tab creation/selection/closure,
  reconnect, cancellation and finalized WebM video (checked with ffprobe).
- A disposable demo-site worktree served a real CMS page with **HTTP 200 through
  `http://nginx:8082/`**. The worktree and preview were removed afterwards.
- A standalone loopback app in the CarapaBot sandbox passed the same live
  integration probe without nginx. This image lacks ffprobe; its finalized
  recording was checked for a nonempty WebM container.
- UI browser checks load the actual vendored frontend and integration bridge
  against a protocol fixture; live browser checks separately exercise the real
  sandbox CLI/helper. The running Box service was not replaced for these tests.

Reproduce the bounded runtime probe through Box with
`browser-viewer-check [internal-url]`. `browser-delivery-check` exposes the fixed
Board/Box verification entrypoints inside their development sandboxes.

## Persistent-session correction (2026-09-13)

Implemented default-branch Start/Restart/Close and an app URL input, stable
conversation ownership across turns, per-context tab reuse, and authenticated
idle discovery. Verification for this correction is tracked separately below.

- Backend discovery/action tests cover no-run defaults, turn completion, shared
  sandboxes, revoked conversation access, replaced worktrees and safe exec argv.
- `browser-persistence-check [main]` is a disposable native probe for on-demand
  startup, worktree preview resolution, warm-turn reuse, cookies, multiple tabs,
  interactive viewing between turns, detach/reconnect and explicit restart.
- Passed locally: Board backend/UI typechecks and UI production build; 88 IPC
  execution tests, two discovery/authorization/action tests, the ordered recording
  finalizer test, three mounted Browser pane tests, and three canonical CLI
  environment/session-reuse tests. Box typecheck and five transport tests passed.
  Runtime typecheck, recording lifecycle and image-version checks passed.
- Native `carapa_box_local` calls to `sandbox_exec`, `sandbox_ps`, and a fresh
  `sandbox_list` timed out after 300 seconds. The configured controller's
  health/authenticated tool-listing check passed outside the restricted shell.
  This distinguishes a native MCP connection failure from a stopped controller.
- At that point, the supported-sandbox `verify:changed`, real browser UI test,
  and demo-site/default branch/localhost persistence probes were unverified.
  A host attempt at the daemon suites produced 4 passes and 10 failures/timeouts;
  host Node child execution also reported EPERM. Those suites need the supported
  sandbox and are not counted as passing verification.
- Resume by reconnecting `carapa_box_local`, inspecting current sandbox/probe
  state, then running `browser-delivery-check verify`, `transport`, `lifecycle`,
  `browser`, and `runtime` in Board's development sandbox. Run
  `browser-persistence-check main` in demo-site and the argument-free probe in
  CarapaBot; repeat the recording probe after the wrapper change.
  Board/Box services were not restarted, and the canonical runtime was not
  promoted to the Box release stack copy.

### demo-site default-directory fix and completed checks (2026-09-13)

The failing default context used Board's conventional `/workspace/demo-site`, but
demo-site's service runs from `/var/www/demo-site`. Its worktree contexts already had
explicit paths. The helper now resolves the service directory for dedicated
default contexts, including its CLI shim and viewer; it reports missing explicit
directories before launching Playwright. Board computes that selection on Start
and retains existing session IDs. Helper/Box failures retain their diagnostic
detail, with Board's existing credential redaction applied before display/logging.

- Reproduced the exact default-session failure through Board's production
  `SandboxClient` REST transport to the existing `carapa_box_local` controller.
  Updated only demo-site's default descriptor in place and verified successful Start
  and live frame delivery through Box's authenticated viewer endpoint. Detached
  the diagnostic viewer, leaving the default browser running.
- Passed `browser-persistence-check main` in demo-site, including a nonexistent
  conventional directory, the service directory fallback, default viewer frames,
  nginx port 80, a localhost app, worktree preview lookup, warm turns, cookies,
  tab reuse, detach/reconnect, restart and isolated registries. Probe sessions
  were cleaned up; existing worktree browsers were left untouched.
- Supported Board sandbox `verify:changed` passed: **2,746 tests**, plus **one
  browser test**; backend and UI gates were green. The supported harness suites
  passed **14 tests**. Three focused Board discovery/action tests, backend
  typecheck and three canonical CLI session tests also passed locally.
- The native MCP read still timed out after 300 seconds; the same controller's
  approved REST tool path worked. No alternative controller, Docker access from
  Board, additional ports, policy changes, service restart or runtime promotion
  was needed. Board backend source changes await the normal application build;
  the mounted runtime helper and repaired demo-site descriptor are already active.

### Conversation discovery after restart (2026-09-13)

Boot recovery previously cleared `conversation.worktree_path` for idle chats,
and recovered-run finalization also cleared it after a turn. The checkout and
browser survived, but browser authorization correctly rejected the now-unbound
context, leaving only the default branch in the dropdown. Recovery now preserves
conversation worktree bindings; explicit removal/merge remains responsible for
clearing them.

The two affected demo-site checkouts and their Git branches were verified through
approved Box reads before restoring their null database paths with the existing
conversation database helper. Production discovery and authorization now return
both original conversation browser IDs alongside the default browser. Browsers,
cookies, tabs and worktrees were not recreated. The supported Board sandbox
`verify:changed` passed all **72 selected recovery tests**, including idle
browser discovery after boot and worktree retention after a recovered warm turn.
The restored links are live; the recovery source fix awaits the next Board build.

## Projects without nginx

Add `.agent/start-browser.sh` alongside `.agent/worktree-setup.sh`. Worktree setup
prepares dependencies; the browser hook starts the selected checkout's app on
demand. URL resolution is: explicit URL, existing `.preview-url`, startup hook,
then `http://nginx/`. An agent's existing live browser can also be viewed directly,
regardless of which internal URL its tests chose.

The approved sandbox `browser-open` helper invokes the fixed hook with Bash from
the selected checkout. The hook inherits that context's Playwright environment
and receives `CARAPA_BROWSER_URL_FILE`, an absolute file path for publishing its
ready HTTP/HTTPS URL. Start the server in the foreground, wait for readiness, and
write the URL atomically (temporary file followed by rename). Keep the hook alive
while its app is available and handle SIGTERM for project-specific cleanup.
No caller-supplied shell command or host port is introduced.

The helper supervises one hook per browser context with bounded logs and a
60-second readiness deadline. Repeated Start reuses it; Start after an app failure
restarts it and navigates the surviving browser to its new URL. Viewer detach
and conversation turn completion preserve the app. Explicit Close/Restart and
sandbox shutdown release its owned processes. Existing nginx services and apps
opened with an explicit URL retain their own lifecycle.

CarapaBoard's hook uses the existing `scripts/ui-sandbox/start.ts` launcher. It
starts the real UI/backend with disposable seeded data, simulated integrations,
and dynamically allocated loopback ports, then signs the shared browser in as
the fixture administrator through the normal login/device flow. This is a local
development preview, not the deployed Board or its production data. It works in
the default checkout and prepared worktrees. The URL is published automatically
and appears in the viewer's address bar; users do not need to know the port.
Browser tests also use dynamic loopback URLs, but their test-owned servers stop
at teardown. Both the launcher and browser-test runtime retain Board's injected
session and discovery directories for managed runs, including unrecorded runs.

Runtime verification: `browser-app-check` exercises a disposable localhost hook,
live viewing, repeated Start, app recovery, explicit Restart/Close, failure
diagnostics and cleanup. `browser-app-check board` exercises CarapaBoard's real
hook, authenticated UI, streaming and complete lifecycle in its sandbox.

Verification on 2026-09-13: both probes passed in Board's supported sandbox via
the existing Box controller. The real Board probe also invoked the browser-test
runtime and confirmed it reused the authenticated shared page. The generic probe
verified recovery after its app stopped while the browser survived. Board's
`verify:changed` passed all selected gates with **2,746 tests**; its browser-test
phase was not selected, so live coverage came from the two explicit probes.
No new host ports, DNS records, policy changes or service restart were needed.
The canonical mounted runtime hook is available now; Board's new URL placeholder
and longer startup timeout await its normal build. The CarapaBox release copy
has not been promoted.
