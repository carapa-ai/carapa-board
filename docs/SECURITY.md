# CarapaBoard Security Model

## Trust Model

| Entity                                              | Trust Level     | Rationale                                                        |
| --------------------------------------------------- | --------------- | ---------------------------------------------------------------- |
| Main group                                          | Trusted         | Private self-chat, admin control                                 |
| Non-main groups                                     | Untrusted       | Other users may be malicious                                     |
| Container agents                                    | Sandboxed       | Isolated execution environment                                   |
| WhatsApp messages                                   | User input      | Potential prompt injection                                       |
| Web content (web_view, web_search, web_fetch_image) | Untrusted       | Fetched pages and posts may address the agent (prompt injection) |
| AGENTS.md instructions                              | Soft constraint | Read by agent; not a security boundary                           |

## Integration keys and objective chats

Integration keys need the applicable `objectives:*` scopes as well as the route's scopes for objective chats. Meeting-recording routes resolve the recording's conversation and enforce those same objective scopes before allowing an integration request.

## Public conversation shares

Public conversation event streams are limited to 50 concurrent subscribers per conversation and 5 per client IP. Excess connections receive HTTP 429. Each stream ends after at most 30 minutes; EventSource clients can reconnect.

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute inside Docker containers via `run-agent.sh` (supports claude, codex, pi, opencode, cursor, hermes, omp, prime-agent, and antigravity harnesses — selected through `board_agents.jsonc`, with `AGENT_CMD` as the fallback), providing:

- **Process isolation** — Container processes cannot affect the host
- **Filesystem isolation** — Only explicitly mounted directories are visible
- **No Docker socket access** — Agents cannot create or escape containers
- **One long-lived container per project** — A project's sandbox is reused across runs, not recreated per invocation. State inside it persists until the sandbox is recreated, and eligible chat harnesses keep a warm process between turns. Each run gets its own run directory
- **Non-root execution** — Runs as unprivileged user

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted and which commands are allowed.

**Important:** Claude Code has broad built-in tool capabilities (Bash, file operations, web access, MCP). The container + command allowlists are the hard boundaries. AGENTS.md instructions (including the "Agent in a box" notice) are a soft layer that describes constraints — they are read by the agent and reduce accidental misuse, but are not enforced at the OS level.

### 2. CarapaBox (Container Orchestration Boundary)

CarapaBot never talks to Docker directly. The **CarapaBox** is the only process with Docker access. Agents call `sandbox_*` MCP tools; the sandbox server executes them. This means:

- Agents have no Docker socket access — container escape is not possible via Docker APIs
- Only pre-defined stacks (in `stacks/`) can be started — agents can't spin up arbitrary containers
- Only an admin can add new stacks

Project sandbox lifecycle routes (`/api/sandbox/:stack/*?group=<project>`) need write access to the project; a human caller of stop, like an immediate restart (`restart` without `when=idle`), needs owner-level access, because both interrupt every chat and task run on the sandbox (editors use restart-when-idle). Agent and system callers are unchanged.

### 3. Git Credential Isolation

SSH keys **never enter agent containers**. When an agent calls `sandbox_git`, the sandbox server:

1. Spins up a temporary `alpine/git` container
2. Mounts host SSH keys **read-only** into that container
3. Runs the git command
4. Destroys the container

The agent's container is never involved.

### 4. OPA/Rego Command Policies

Each stack defines `policy.rego` (compiled to `policy.wasm`) controlling exactly which `sandbox_exec` commands are permitted. Everything else is blocked. See [carapa-box/SECURITY.md](../../carapa-box/SECURITY.md) for policy rules and bypass protections.

Note: Claude Code's native Bash tool runs commands **directly inside the container** (not via `sandbox_exec`), so the exec allowlist applies to explicit `sandbox_exec` calls, not to Bash tool usage. The container filesystem isolation is what limits Bash tool damage.

### 5. Mount Security

Container mounts are configured externally via the CarapaBox's stack definitions, which only an admin can modify. Agents cannot influence what gets mounted — mount configuration never passes through CarapaBot at runtime.

### 6. Session Isolation

Each group has isolated Claude Code session data mounted at `~/.claude/` inside the container (sourced from a per-group host path):

- Groups cannot see other groups' conversation history
- Session data includes full message history and files read
- Prevents cross-group information disclosure

### 7. IPC Authorization

Messages and task operations are verified against group identity:

| Operation                   | Main Group | Non-Main Group |
| --------------------------- | ---------- | -------------- |
| Send message to own chat    | ✓          | ✓              |
| Send message to other chats | ✓          | ✗              |
| Schedule task for self      | ✓          | ✓              |
| Schedule task for others    | ✓          | ✗              |
| View all tasks              | ✓          | Own only       |
| Manage other groups         | ✓          | ✗              |

### 8. CORS Configuration

Cross-Origin Resource Sharing is controlled via the `CORS_ORIGIN` environment variable:

| Value                                           | Behaviour                                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| unset (default)                                 | Same-origin only, plus `http://localhost`, `https://localhost` and `capacitor://localhost` (Android app) |
| `*`                                             | Allow all origins (logs a warning at startup)                                                            |
| `https://board.carapa.ai`                       | Restrict to a single production origin                                                                   |
| `https://board.carapa.ai,http://localhost:5173` | Allow multiple comma-separated origins                                                                   |

`credentials: true` is always set so session cookies work for cross-origin requests.

The compose file also publishes the Board and PostgreSQL on `127.0.0.1` only; `CARAPA_BOARD_BIND` and `CARAPA_BOARD_DB_BIND` change that.

**Recommendation:** leave `CORS_ORIGIN` unset, or set it to your exact board URL, in any internet-facing deployment to prevent other websites from making authenticated requests on behalf of a logged-in user.

### 9. Client-Side Session Security

The client (web, iOS Capacitor, Android Capacitor) talks to CarapaBoard
over an authenticated, signed channel and gates UI access with a
per-platform app lock. Full details in
[android-security.md](android-security.md); summary:

- **TLS + cert pinning** — HTTPS everywhere. The Android app bundles no
  server certificate: `network_security_config.xml` trusts system and
  user-installed CAs, and a board with a self-signed certificate is trusted
  through a per-server pin taken from the pairing link. Web/iOS rely on the
  OS / browser trust store.
- **Per-request signing** — every API call carries `X-Carapa-Device-ID`,
  `X-Carapa-Timestamp`, and `X-Carapa-Signature` (ECDSA P-256 over
  `timestamp:method:path:body`). The server enforces a 5-minute replay
  window. Private key locations:
  - Android: generated and held inside Android Keystore
    (TEE/StrongBox-bound on most devices). Never enters JS.
  - Web/iOS: WebCrypto-generated PKCS8. With biometric unlock configured,
    the PKCS8 is held only in module memory, encrypted under a WebAuthn-PRF
    key on disk. Without biometric unlock, it lives in plain `localStorage`
    (matches the pre-WebAuthn baseline).
    Admin writes also need a fresh signature from the admin's own device:
    user and membership management, provider accounts, MCP connections, boxes,
    restart/rebuild, AI users and teams, memory audits and history-reflection
    review. Signed-only push routes resolve the user from the device and refuse
    disabled accounts.
- **App lock** — gates UI access independently of the server session:
  - Android: numeric PIN backed by a Keystore HMAC verifier, with a
    3-strikes kill-switch and an optional duress PIN that fires a signed
    "duress" alert before wiping the device handshake key.
  - Web/iOS: WebAuthn biometric unlock. The four session secrets
    (`auth_token`, `device_id`, `device_pub_key`, `device_priv_key`) are
    encrypted under an AES-GCM key derived from the WebAuthn PRF
    extension; without a successful Touch ID / Face ID / Windows Hello /
    hardware-key UV the saved session is undecryptable. Lock engagement
    on idle clears the in-memory plaintext, so signed API calls fail
    closed until the next biometric prompt. Password sign-in on a browser
    with an existing device reuses that device (after a biometric prompt if the
    vault is locked); a cancelled prompt, an ownerless pre-upgrade vault, or a
    different account registers a new device and drops the stale vault blob.

**Live connections.** WebSocket upgrades (`/api/ws`, `/api/live-voice/ws`,
`/api/browser/ws`) enforce the same device approval and revocation as HTTP: a
session bound to a device (ticket or cookie) is refused with 401 when the
device is missing or inactive and 403 when it is not yet approved, and a failed
lookup refuses the upgrade. Deactivating or removing a device closes its open
`/api/ws` sockets. Live-voice sockets do not record the device id and are not
closed on revoke; they are short dictation sessions, and a new upgrade is refused.

WebAuthn unlock has deployment requirements (no bare-IP origins, cert
must be trusted by the browser) — see the troubleshooting section of
the deep-dive doc.

### 10. Credential Handling

**Model-provider credentials are not exposed.** Harnesses send provider requests to CarapaBox's `api-relay` (for example `ANTHROPIC_BASE_URL=http://api-relay:8080/anthropic`). The relay injects the real API key or OAuth subscription token, refreshes OAuth tokens, and forwards upstream through the egress proxy. The sandbox only receives placeholder values such as `ANTHROPIC_API_KEY=sk-ant-dummy-routed-via-relay`. See CarapaBox's README ("API credential relay") and the CarapaBot stack README.

**Exposed to containers:**

- A short-lived CarapaBoard agent token scoped to the sandbox's project (used for board MCP tools through the relay)

**NOT exposed:**

- Provider API keys and OAuth tokens — held by api-relay
- WhatsApp session — held by CarapaWaLink
- Mount allowlist — external, never mounted
- SSH keys — handled by temporary git containers only
- Any paths matching blocked patterns

**Human sessions carry no wildcard permissions.** Browser-session cookies, user JWTs and media tickets get a `tokenScope` from the HTTP auth middleware with only their per-user `group_folder` and an empty `permissions` map. `/mcp/*` replaces it with the permissions for the projects the user can reach (owned and member projects, viewers read-only), never `'*'`. No credential, admins included, holds the `'*': ['*:*']` wildcard; human access is decided from `req.authUser` (project membership or `role === 'admin'`), never from `tokenScope.permissions`.

> **Residual risk:** credentials that an operator places in the shared agent home (`AGENT_HOME`, mounted as `/home/ubuntu`) are readable by agents. Keep provider credential files out of that directory; for example, do not put a Codex `auth.json` there.

**Mail content is untrusted input.** An email can carry prompt injection, so an agent that reads mail must have the smallest possible reach. Over the board MCP server only run/chat tokens of a mail-enabled non-main project get mail tools, and only an explicit allowlist: list folders/emails, read, search, download attachment and save draft. Sending, moving, deleting and marking read stay DirectLLM-only; the tools are pinned to the token's own project (no `project_id`); the main agent, human and OAuth tokens get none. Run mail-processing agents in a dedicated mail project so injected instructions cannot reach other projects' tools or data through the mailbox. CarapaMail additionally enforces per-token account permissions.

### 11. Process log privacy and retention

Process logs are operational diagnostics, not a transcript or artifact store. The
shared logger recursively omits credential and user-payload fields with bounded
presence/size metadata, strips URL queries, and bounds arbitrary strings and
collections. Operational error and process output remains available in bounded
form after embedded credentials and payload assignments are scrubbed. Routine
success diagnostics stay at debug level. Do not use process logs to retain
prompts, messages, provider responses, or attachments.

Project folder slugs, session IDs, filenames, filesystem paths, and explicitly
logged stack locations are operational diagnostics and remain visible. Session
cookies, credentials, and authorization values remain secret. Slow HTTP
warnings include the concrete query-free route plus its Express route pattern.
Slow database warnings include the SQL operation, referenced tables, and a
bounded statement with literals and comments removed; bound parameter values
are never logged.

In Docker deployments, the `carapa-board` service pins the `json-file` driver and
uses 10 MiB files with 5 rotated files by default (50 MiB maximum per container).
Operators may override `LOG_MAX_SIZE` and `LOG_MAX_FILES`. Deployments using
another logging driver must configure that driver's retention separately. In
host/PM2 deployments, install and configure `pm2-logrotate` with an equivalent
size/retention policy. When `LOG_FILE` is set (Docker sets `/app/logs/board.log`),
the board also writes a size-rotated copy (`LOG_FILE_MAX_SIZE`, `LOG_FILE_MAX_FILES`)
that is redacted and bounded exactly like stderr. These settings apply only to process logs and do not
change canonical transcript or artifact retention.

### 12. Project privacy mode: cross-project reads

`settings.privacyMode` (`off`, `local_memory`, `strict`) gates a project's own
egress. It also limits what other projects may read from it. Content owned by
project S may enter a run of a different project R only if S's mode does not
require local handling for the purpose, or R is `strict` (the only mode in which
every consumer of R, agent runtime included, is gated local). For memories the
purpose is `memory`, so memories of a `local_memory` or `strict` project are
visible to other projects only when the reader is `strict`. The same project is
always allowed; an unknown or absent reader is treated as `off`.

Speech normalization is checked per project with the `helper` purpose and falls back to plain sentence splitting when refused.

Two memory paths apply this rule:

- **Memory capsule:** `resolveAuthorizedRelatedGroups` drops parent, child and
  `memorySourceProjects` sources that the reader may not receive, after the user
  access check.
- **`recall` tool:** the recall scope is filtered at call time (permissions are
  baked into the token at issue time and may predate a mode change). When the
  filtered scope is empty, `recall` returns no memories without querying the backend.

**Inheritance.** A parent project and the main project are at least as strict as
their strictest descendant, because they can read descendants' folders, task
transcripts and memories by design (a child's folder lives inside its parent's,
and the main project sees every group). `getEffectivePrivacyMode` therefore
returns the strictest of a project's own mode and the modes of every group that
has it as an ancestor; for the main project that is every registered group. All
gates (runtime, egress, memory, tool and cross-project checks) use the effective
mode, while the settings API keeps `privacyMode` as the own value and adds the
read-only `effectivePrivacyMode` and `privacyModeInheritedFrom` (folder of the
strictest descendant, or null). Consequence (intended): as soon as any project is
`strict`, its parent chain and the main project run under `strict` (local agent
runtime only, web/image tools refused, memories gated). Projects with no mode
anywhere below them are unchanged, and inheritance can only make a project
stricter, never looser.

Each skip logs `privacy_cross_project_skip` with the path, the reader and a
count, never other project names or content. Projects without `privacyMode`
are unaffected, and a main-project wildcard scope is unchanged until some
project sets a mode. The failure mode is withheld memories, never widened access.
Parent/main transcript and filesystem reads and memory writes into another
project are outside this rule.

**Web tools.** `web_search`, `web_view` and `web_fetch_image` have the `web`
privacy purpose and are refused in `strict` mode. `web_fetch_image` uses the
same public-URL guard as `web_view` (public http(s) targets only, every
redirect hop re-validated).

The guard blocks loopback, private, link-local, reserved and multicast IPv4
and IPv6 ranges. IPv6 forms that embed an IPv4 address (IPv4-mapped and
SIIT `::ffff:0:a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) are judged by
the embedded address; local-use NAT64 `64:ff9b:1::/48` and Teredo `2001::/32`
are blocked outright. `web_view` reads at most 20 MB of response body
(counted after decompression) and refuses larger pages; results above 500,000
characters are not cached.

**Knowledge bases.** Search and verification use the querying project's own
mode (embedding, Jev and the LLM verifier are gated per consumer). On the write
side, `save_to_knowledge` and `update_knowledge_document` refuse with
`PrivacyRefusal` when the writing project is `strict` and the knowledge base is
also shared with any other project that is not `strict` (the refusal is logged as
`privacy_refusal`, target `knowledge_base:<id>`, and does not name the other
project). Writers in `off` or `local_memory` are unaffected, since their content
was already produced by their own cloud agent. The REST file upload, metadata, and save-message write routes enforce the same refusal for agent tokens. When a knowledge base tool
reaches another project through `target_project`, the cross-project rule
applies with the calling project as reader (purpose `agent`) on top of the
`memories:read`/`memories:write` grant: a strict target is refused for a
non-strict caller (logged as `privacy_cross_project_skip`, path `knowledge`,
without naming the target). The strict write guard is evaluated for both the
calling and the target project, and the search and filename helpers use the
calling project's mode. Knowledge bases have no owner
project and documents carry no provenance, so a person who later shares a
knowledge base with a non-strict project exposes the content already in it; that
deliberate human action, like Knowledge Hub uploads, is not gated.

### 13. Web content screening

`web_view` and `web_search` results are text from the open internet and may
contain instructions aimed at the agent reading them. Two soft layers apply
(`src/modules/web/content-safety.ts`, applied in `src/modules/web/tools.ts`):

- **Envelope.** Every successful result is wrapped in
  `<untrusted-web-content source="<url or web_search>">` with a note that the
  content is data, not instructions. A literal `</untrusted-web-content` inside
  the content is escaped so it cannot close the envelope. Errors and "no
  results" messages are not wrapped. For `web_view` each chunk of up to
  `WEB_VIEW_MAX_CHARS` characters (default 50,000) is taken before wrapping (the
  envelope adds a small fixed overhead). The `next: offset=` paging line is
  placed after the closing tag, outside the screened content, so page text
  cannot forge or alter it. Each chunk is screened separately.
- **Jev screening.** When `JEV_URL` is set and `WEB_CONTENT_SCREENING` is not
  `off`, one Jev `noul` question asks whether the content tries to instruct an
  AI agent. A score at or above `WEB_INJECTION_THRESHOLD` (default `0.8`) adds a
  warning line inside the envelope. The mode is warn-only: content is never
  blocked or redacted. Screening fails open: on a Jev error, timeout or invalid
  answer the content is returned with `(Automatic injection check unavailable.)`.
  Verdicts are cached in memory by content hash (500 entries) and each screened
  result logs `Web content screened` (tool, hostname, size, score, flag, latency,
  project; never content).

Configuration: `WEB_CONTENT_SCREENING` (`warn` default, or `off`) and
`WEB_INJECTION_THRESHOLD`.

This is defence in depth, not a boundary. A classifier can miss an attack and
the agent may still follow injected text; container isolation, command
allowlists and egress limits remain the boundary.

`web_fetch_image` also screens text inside the image: it is transcribed by the
local vision runtime `defaults.imageOcr` (never a remote or non-image runtime;
images can come from private chats) and the transcription goes through the same
envelope and Jev screening. When no local vision runtime is configured, the
image is saved but its text is not transcribed or screened. The image itself is
still untrusted data.

### 14. Board file access in agent-writable folders

A sandbox agent can write its project folder `groups/<folder>/`. Nested
children live at `groups/<parent>/<child>/`, and a shared owner mounts its whole
subtree, so a parent agent can even replace a child's folder. The agent can
therefore swap any directory in there for a symlink at any moment (to another
project's folder, to `/etc`, to a FIFO). Real folders also contain intended
relative links (`.claude -> .agent`, `CLAUDE.md -> AGENTS.md`,
`.claude/rules -> ../.agent/rules`), so links cannot simply be banned.
Transcript lock state is board-only under `DATA_DIR`, not in the agent-writable group directory. Transcript locks use kernel `flock` locks, released on process exit; if FFI is unavailable, the logged in-process fallback cannot protect concurrent CLI writers.

The swap race: a guard that checks a path (`realpath` + prefix, `lstat`, an
O_NOFOLLOW on the leaf only) and lets the caller reopen the same path later
loses when a directory is swapped between the check and the use.

Rule: board code that reads agent-writable folders uses `src/lib/group-fs.ts`
(`openGroupDir`, `openParentDir`, `readFileAt`, `readGroupFile`, ...) and no
path-based check-then-use. Every directory is opened one segment at a time with
`O_NOFOLLOW`, later operations go through the pinned descriptor
(`/proc/self/fd/<fd>/<name>`, one segment only), and leaves must be regular
files opened with `O_NONBLOCK`, so FIFOs and devices are refused without
blocking. Directory segments are not opened with `O_DIRECTORY | O_NOFOLLOW`:
gVisor follows a symlink to a directory with that combination. Relative links
are followed only on request (`followInternalLinks`), only when the target
stays lexically inside the base directory, and only after re-walking the
substituted path with the same per-segment `O_NOFOLLOW` (at most 8 links).

- **Linux only, fail closed.** Without `/proc/self/fd` every function throws
  `GroupFsError('unsupported')`. Host-mode development therefore needs Linux.
- **Symlinked group folders are refused.** A group folder an admin replaced by
  a symlink is rejected (`symlink`) and logged once as a warning naming the
  folder. Only `GROUPS_DIR` itself may be a deployment symlink.
- Errors other than "not found" (`ELOOP`, `ENOTDIR`, `EACCES`, `EIO`) surface as
  `GroupFsError` with `errno`; they are never reported as a missing file.

Writes and serving use the same pinning. `writeFileAt` writes a temp file
(`.<leaf>.<pid>-<uuid>.tmp`, `O_CREAT | O_EXCL | O_NOFOLLOW`) in the pinned
parent and renames it over the leaf, so a planted leaf link or hardlink is
replaced and its target is never touched; the in-place mode (`atomic: false`)
and `appendFileAt` open with `O_NOFOLLOW | O_NONBLOCK`, never truncate before
`fstat` shows a regular file with `nlink === 1`, and refuse links and hardlinks.
`renameAt`, `removeAt` (recursive removal walks descriptors, so an entry swapped
for a link is only unlinked) and `copyTree` (links copied as links, FIFOs and
devices skipped) follow the same rule. Files are served with `sendPinnedFile`,
not `res.sendFile(path)`: Express `send` re-resolves a path when it streams, so
the response goes out through `/proc/self/fd/<fd>` of the handle opened (and
sniffed with `detectMimetypeForHandle`) after the checks. That link pins the
inode, so a later swap of the original path cannot change what is sent, while
Range, ETag and Last-Modified keep working; the handle is closed once, also
when the client aborts.

IPC run and session directories (`DATA_DIR/ipc/<stack>-<inst>/runs/<runId>`, `sessions/<key>`) are agent-writable in the shared single-host layout, so they are accessed through `src/lib/ipc-fs.ts`: `DATA_DIR/ipc` is the only trusted anchor, every segment below it is opened with `O_NOFOLLOW` (a symlinked run or stack directory throws `symlink`), writes are temp file + rename in the pinned directory, and reads are capped and non-blocking (a link, FIFO, device or oversized file reads as missing and is logged once). IPC and group replica pulls also walk from their trusted tree anchor using group-fs, with pinned-parent writes (full files are replaced atomically; appends are written in place to a regular, single-link file opened `O_NOFOLLOW` under the pinned parent; an append needs an existing regular prefix of at least the chunk offset, so a missing or short prefix is refused and never zero-filled, and a failed append is pulled again from Box, never pushed back) and descriptor-relative deletes; unsafe path segments are refused. The run-dir `pid`, `exit_code` and `metrics_complete` markers, the V1 sidecars (`output.v1.meta.json`, `output.v1.jsonl`: live waiter, interrupted-run repair, cleanup archiving and recovery) and the warm-session pointer (`session_dir` and the session's `codex.appserver.out`) use these helpers; a refused V1 file fails the live waiter and leaves the spool in place during repair, and a refused warm-session file reads as no diagnostic. Other existing IPC call sites migrate in follow-up work.

Starter prompts (`.agent/prompts/starters.json`) are read through group-fs
with a regular-file check and the prompt size cap. Their parent directory is
pinned for reads, atomic temp-and-rename writes, and deletes; leaf symlinks
are never followed. Internal prompt-directory links remain supported.

Transcript and prompt viewing (`readContainedText`) reads through group-fs:
a path outside the group, a FIFO or device, a leaf link that is absolute or leaves the group, or a file
over 128 MiB reads as unavailable. The group directory itself is walked from
the groups directory without following links, so a symlinked group folder is
refused. Other readers and the write and serving side
migrate in follow-up work; until then `resolveContainedRealPath` (behind
`isContainedWritePath` / `mkdirContained`) and `transcript-fs-safe` keep their
known race.

`scripts/check-group-fs.ts` (a `verify.sh` phase and a CI test) fails on raw `fs` use in files that derive group paths unless `scripts/group-fs-allowlist.json` lists them with a reason and a ratcheting `max`.

Raw file bytes served to the browser (artifacts, uploads, and the group, repo and extra-mount `files/*/content` routes) always carry `X-Content-Type-Options: nosniff`; active content (HTML, SVG, XML and other `+xml` types, via `isActiveContentMimetype`) also gets `Content-Security-Policy: sandbox; default-src 'none'` and `Content-Disposition: attachment`, so scripts in an agent-written file never run with the board session. `<img>` previews are unaffected.

Who may change project files: only board admins and explicit project owners or editors (`canEditProjectLocalFiles`, in `src/routes/_helpers.ts`) may save through the editor or call `POST /api/projects/:pid/files/group/{rename,move,delete}`; viewers, chat-only users and agent tokens get 403. Those three routes refuse symlinks (source, path component or destination) and the board-managed paths in `PROTECTED_GROUP_PATHS` (`src/lib/group-file-ops.ts`: agent config and rule dirs, `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, `.mcp.json`, queue, logs, recordings, transcripts, `objectives` and each objective root with its state/events/decisions/dashboard, the `artifacts` folder itself, and nested child projects). Extra mounts stay read-only and unreachable through them.

### 15. Cross-project agent asks

`ask_project_agent` lets one project's chat agent prompt another project's chat agent in a new conversation, without waiting for an answer.

- **Allowed callers** are decided server-side from the registered projects, never from arguments: a per-user main (`is_main` with a `user_id`, including objective runs in that project) for any project its user may post in, and a parent project (`settings.isParent`) for its direct children. Child-to-parent, sibling, grandchild, unrelated and `is_main` without `user_id` callers are refused.
- **No task runs, no OAuth.** Task-run tokens and OAuth grants are refused.
- **Reach and state.** The target must not be the caller, the caller needs `chat:write` on it (viewer-narrowed projects are refused), chat must be enabled and the project must not be paused or stopped.
- **Privacy.** The prompt leaves the caller project, so the `agent` purpose is checked with `crossProjectReadAllowed(caller, target, 'agent')`: a caller whose effective privacy mode requires local handling (a main project inherits the strictest mode of all projects) may only ask a `strict` target.
- **Owner.** The human owner is the user who triggered the calling run, else the calling conversation's owner, else the caller project's user. The owner must be an admin or an explicit `owner`/`editor` of the target. The new conversation is owned by that user, who sees it in the target's chat list and can post in it.
- **Continuing a conversation.** With `conversation_id` the ask continues an existing, non-objective conversation of the target project instead of creating one. The human owner must be able to post there in the UI (`userMayPostInConversation`: admin, or `editor`/`owner` on the conversation); a conversation with a pending ask, or with a turn in progress, is refused (the ask always starts its own turn, so that turn's end settles it; a message is never queued behind another turn). Messages stay agent-attributed. Ownership and members are never changed.
- **Runtime choice.** Optional `runtime_selection` (`harnessId`, `modelId`, optional `reasoning`) sets the harness and model of a new conversation and is refused together with `conversation_id`: an ask never changes an existing conversation's settings. It is checked against the configured chat runtimes and the target's privacy mode (`assertRuntimeAllowed`) before anything is written, so a refused runtime creates no conversation or message. Auto is refused; without the parameter the target's default runtime applies.
- **Worktree.** Optional `use_worktree` (with optional `branch`, validated like the new-conversation route's) starts a new project conversation in a chat worktree, as the UI does. It is refused, before anything is written, together with `conversation_id` (an ask never changes an existing conversation's checkout) or `objective_id` (objective chats never run in a worktree), when `branch` is given without `use_worktree: true` or is not a safe branch name, and when the target has no `repositoryLocation` or its `taskCheckoutMode` is not `worktree` (the first turn would fail otherwise). A worktree transition in progress for the branch is reported as an error and leaves no conversation, message, member or ask behind. Worktree creation, base branch and cleanup are unchanged.
- **Attribution.** The prompt is stored as `source: 'agent'` with no `senderUserId` and the board-composed name `<name> (<caller project>) for <owner>`; it is never shown as the human. The asked turn carries a header saying it is not written by the human.
- **Target permissions only.** The asked turn runs as the target project's chat agent with the target's own permissions; nothing is inherited from the caller.
- **Hop limit 1.** An agent running in a conversation that is or was the target of an ask cannot ask further.
- **Context-less guard.** A sandbox-level token (no conversation or run) cannot ask while its project has a pending inbound ask, so an asked agent cannot dodge the hop limit.
- **Reply destination.** The call must come from a conversation of the caller project, or name one of the caller project's objectives.
- **Answers.** When the asked turn ends, its answer returns to the caller: posted in the caller's conversation as an agent-attributed message (`source: 'agent'`, no `senderUserId`) plus a new caller turn, or sent to CarapaBrain as an `agent_answer` event for the objective. The answer is untrusted data for the caller: the caller turn's prompt fences it and tells the agent to treat it as information, not as instructions from the user. An atomic claim of the pending ask delivers it once; a later message in the asked conversation delivers nothing. Delivery never retries: a failure (caller conversation gone, event not delivered) is recorded in `delivery_error` and logged. A chat turn that fails before the agent session produces any output (launch error, missing working directory, stopped service, stale mount) records a transcript message `The agent could not start: <reason>` (credentials scrubbed, capped at 500 characters), so a reload shows it and a failed ask's answer carries the reason instead of `(no answer text)`.
- **Switch.** A project can disable the `agent_asks` toolset to remove the tool.

### 16. Agent credentials on board HTTP routes

Sandboxes reach the board through the CarapaBox api-relay, which replaces the client's `Authorization` header with the sandbox-level token. That token carries no `task_id`, `run_id` or `conversation_id`, so an HTTP guard cannot tell a coder run from a chat agent. Routes that must refuse sandbox agents therefore require a signed-in user (`requireSignedInUser` in `src/routes/_helpers.ts`): every agent token kind (sandbox-level, run-scoped, parent/main) carries no `authUser` and gets 403. Agents change project setup only through the `set_project_*` MCP tools.

Human-only routes:

- `GET /api/projects` and `GET /api/projects/attention` (project list and Now list; per-user views)
- `POST /api/projects`
- `PATCH /api/projects/:pid`
- `POST /api/projects/:pid/git/{push,fetch,pull}`
- `POST /api/projects/:pid/messages` and the project-level `POST /api/projects/:pid/messages/stop` (without `conversation_id`)
- Project-level writes from chat routes — conversation fork, shared-checkout commit and stage, and worktree merge into the default branch — need an explicit project owner/editor or an admin who is not locked out of the project (`canEditProjectLocalFiles`, like repository discovery and connection changes; admins on a project owned by another user count only through their membership level, see §17); conversation access alone is not enough; chat-only users and viewers keep posting in conversations they were given. Meeting recording (`/meetings/record` start, chunk, transcript, stop and cancel) writes the conversation's transcript and audio into the project's artifacts, so a human session needs owner or editor membership (viewers and chat-only users get 403); board admins keep it wherever `adminBypassesProject` applies (not on a project owned by another user, where only their membership level counts), and an integration key is exempt only from the viewer write denial and still needs its `meetings:*` scopes; it acts as the key's owner, so that owner needs project membership beyond conversation access (a board admin owner passes by the same admin bypass). Live `meeting_transcript` events carry the recording's project and are delivered only to users who can see that project or that shared conversation (a personal main only to its owner, whatever membership rows say), decided per recipient from the database at delivery rather than from the socket access cache, and are dropped when the recording's conversation no longer belongs to that project, and the chat stops the local recording when the access check returns 403 or `canRecord: false`. A recording is bound to the project it started in: it is usable only while that folder still names an existing project that holds the recording's conversation, so after the project is renamed or deleted (or its folder name reused) chunk, transcript, stop and cancel answer 404 for everyone, admins included, and a stop already in progress re-checks the binding before each artifact write and persists nothing (the response reports the transcript as not saved).

Admin-only routes use `requireAdmin` (`src/routes/_helpers.ts`), so agent credentials get 403 there too.

Agents reply with `send_message` and reach other projects only with `ask_project_agent`.

### 17. Projects owned by another user, personal mains and chat-only users

A project owned by another user (the group has a `user_id` that is not the caller's) is closed to board admins. An admin is refused there by `enforceProjectAccess`, the `_helpers` access helpers (`userCanAccessGroup`, `userHasExplicitGroupAccess`, both wrappers over the `canAccessProject` membership predicate, and so uploads, artifacts, memories, observations, sandbox, shells and handoff), run routes, memory-source grants and live WebSocket delivery, unless they are an explicit `project_members` member. A member admin gets exactly that membership level, like any user: no bypass and no extra rights. The predicate is `isOwnedByOtherUser` (`src/lib/project-ownership.ts`). A project created from the UI (`POST /api/projects`) records its creator as `projects.user_id` (also as an owner member), so it is closed to other admins from the start; migration `0109_project_owner_backfill` set `user_id` on existing ordinary projects that had no owner and exactly one owner member (projects with zero or several owner members stay ownerless). An ownerless project (no `user_id`) now means one without a registered owner or owner member, such as a CLI- or discovery-created project; it keeps the admin bypass, because nobody else could reach it. So do an admin's own projects.

An admin password reset of another user (`PATCH /api/users/:id`) is logged, notifies that user, and ends that user's existing sessions: every password change bumps `users.token_version`, user session JWTs carry it as `tv`, and the auth middleware, `/api/auth/check`, `/api/ws-ticket` and the WebSocket upgrade refuse (401) a user JWT issued under an older version, so the sliding cookie re-issue cannot extend it. A user changing their own password always gets a fresh session cookie, so a cookie session stays signed in; a Bearer-only caller (native client) has its Bearer JWT refused (401) afterwards, because no new Bearer token is issued. Such a client restores its session through the device-signed `POST /api/auth/token` exchange, which signs with the current version. Agent/MCP tokens, OAuth tokens and device (integration) JWTs are not affected. Sockets already open at reset time are not closed, and media tickets minted before the reset (8 h TTL, one file URL each, not tied to `token_version`) stay valid until they expire. Disabling an account (`PATCH /api/users/:id {disabled:true}`) refuses its WebSocket upgrades (401), stops live event delivery to it, closes its open `/api/ws` and live-voice sockets and ends its open browser viewers (the viewer's 2 s ownership re-check fails); re-enabling lets it connect again.

Admins cannot grant themselves access either: `POST`/`DELETE /api/projects/:pid/members` on a project owned by another user need the registered project owner (`projects.user_id`; for a personal main too): an owner-level membership row held by anyone else, admin or not, does not count. Only a project with no registered owner falls back to its owner members, and only there does the admin bypass of `requireOwnerOrAdmin` stay. The knowledge-base member routes apply the same rule to a KB that has an owner member. A KB has no registered owner, so its owner member rows are its only ownership, and an admin holding one counts as that KB's owner. `ask_project_agent` has no admin exemption: the asking human, admin or not, needs explicit owner/editor access to the target, except for an ownerless target.

A per-user main (`is_main` with `user_id`) is stricter: reachable only by its registered owner, who can access every conversation there, including system-created conversations. Project and conversation membership rows do not admit anyone else, so even an admin with stray membership rows is refused. Human access is decided from ownership and membership, never from the session's `tokenScope.group_folder`. Adding a memory source needs owner or editor access to the source.

WhatsApp group and session routes are admin-only; linking and unlinking also require project editor/owner access under these ownership rules, and another user's personal main cannot be unlinked.

Admin tools refuse projects owned by another user too: memory audits (including projects related to that project), history-reflection review (including move targets), the admin bypass of the conversation ACL (an admin in such a project gets what a normal user gets; only the registered owner has access in a personal main, so its conversations cannot be shared: `POST /api/projects/:pid/conversations/:cid/members` answers 400 and writes no row). Live WebSocket events, live-activity snapshots and replays of such a project are not delivered to board admins who are neither members nor, for a personal main, the owner.

The project-level admin shortcuts follow the same rule through `adminBypassesProject` (`src/lib/project-ownership.ts`): conversation creation, posting, stop and the implicit-user conversation filters, task moves between projects, project deletion and published-app sharing, MCP OAuth consent and token scope, mail (`mailRole`), meeting recordings, personal preferences, browser control, the chat-only restriction on uploaded files, and knowledge-base file favorites. An admin on a project owned by another user is refused there unless they hold a membership, and then gets that level. Knowledge bases use their member rows as ownership: an admin passes a KB's guards (documents, listing, sharing, member list, favorites, MCP OAuth tools) only while the KB has no owner member (`adminBypassesKb`); otherwise only their own KB membership counts. Admin-only global operations (user management, provider accounts (the global view lists, edits, deletes and reconnects no project key of a project owned by another user; the `get_provider_usage` agent tool returns no project integration keys at all), device pairing, privacy mode, deploy service, the sandbox binding settings (`defaultSandbox`, `defaultSandboxService`, `defaultSandboxInstance`, `sandboxOwnership`; an unchanged value passes), and extra mounts and extra workspace roots (`extraMounts`, `workspaceRoots`; an unchanged value passes), platform proposals, Codex thread import) stay admin-only; the Codex import also needs editor access when the admin is only a member. Repository discovery never adds an admin as a member of an existing child project owned by another user (`discoveryMembershipProjectIds`). CarapaBox serves a project's integration tokens by sandbox name, so no name (a folder name or a configured `defaultSandboxInstance`, compared case-insensitively) may belong to two projects: creating, renaming or configuring one onto another project's name is refused, and repository discovery adds a suffix to a taken name. Collisions that already exist are only reported by a warning at startup, and a parent and its children share a sandbox by inheritance, which is not a collision.

A project's integrations (Project settings → Integrations) are CarapaBox project-scope keys bound to a sandbox name `{stack, instance}`; Board stores nothing, and Box serves a key to whichever project uses that name. They are managed through `/api/projects/:pid/integrations` by callers with owner-level access to the project that owns the sandbox (for an inheriting child that is the parent), reads included, on a signed-in human device with a fresh signature, decided before any Box request: editors, viewers and chat-only users are refused, and a board admin passes only where `adminBypassesProject` applies. A caller who is not a board admin cannot name an IP address, a host name without a dot or a port as an integration's host. Project deletion, personal-main archive and folder rename therefore delete keys by name, first, before the project is removed, the main archived or the folder renamed: every key whose instance equals the released folder name on any stack and, for deletion and archive, every key on the project's own binding. Another project using the same name loses its keys too (intended). If Box cannot list or delete the keys, the deletion, folder rename or archive does not happen (502 for deletion and rename); other changes saved earlier in the same request are not rolled back and keys already deleted are not restored. Changing or clearing a configured `defaultSandboxInstance` releases that name the same way: its keys (any stack) are deleted before the settings are saved, and a Box failure answers 502 with nothing saved; a name equal to the project's folder after the request, or an unchanged value, releases nothing. A name that an in-flight folder rename or instance change is about to take is reserved in process until that request ends, and other renames, instance changes, project creation and WhatsApp group registration (`POST /api/groups`, and `registerGroup` for any new folder) are refused for it with the usual conflict status; a rename that still finds its target taken answers 409. Integrations removed by a rename or an instance change must be added again. Without `CARAPA_BOX_API_TOKEN` no Box call is made.

`GET /api/projects/:pid/members` lists account names and levels, so it is limited to admins (any project) and the project's owners (the registered owner and anyone holding an owner membership, except on a personal main, where only the registered owner counts); editors, viewers and chat-only users get 403. `enforceProjectAccess` lets this one read through so that an admin outside a project owned by another user reaches the handler, which makes the decision. The kanban board and chat page read it only for author filters and treat that 403 as an empty list, and the project menu offers Share only to admins and owners.

The `main-` folder prefix is reserved for per-user mains: project create, folder rename and repository discovery refuse it. Creating a user fails with 409 when their `main-<username>` folder is already taken, and MCP grants a logged-in user their main's permissions only when that main is an `is_main` project they own. Archiving a personal main clears a stored `defaultSandboxInstance` equal to its own folder, so the username can be created again.

The viewer write gate is the `enforceProjectAccess` denylist (it includes `/meetings`: recording a meeting needs owner or editor membership for a human session, so viewers get 403; chat-only users are refused by the implicit-user allowlist; the exceptions are narrow: a board admin who bypasses the project is not gated by membership, and an integration key skips only this viewer denial, so it still needs the `meetings:*` scopes and its owner's project access: an owner with only conversation access is refused by the implicit-user gate, while a board admin owner passes by the admin bypass without a membership row); the route-table test in `src/routes/projects-access.test.ts` walks the real routers and checks that every `/projects/:` write route is denied to viewers or listed with the reason it is not.

Chat-only users (conversation members without project membership) may read `/uploads`, `/artifacts` and `/api/wa-media` files only when a conversation they belong to references them (`implicitUserMayReadGroupFile`); uploads under `artifacts/upload/<conversation>/` follow that conversation's access.

## Privilege Comparison

| Capability     | Main Group                                       | Non-Main Group                                                 |
| -------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| Group folder   | `/workspace/group` (rw)                          | `/workspace/group` (rw)                                        |
| Network access | Restricted through the CarapaBox egress proxy    | Restricted through the CarapaBox egress proxy                  |
| MCP tools      | Own project and the projects its owner can reach | Own project; a parent project also reaches its direct children |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                            │
│  WhatsApp Messages / Web UI Input (potentially malicious)        │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input validation
┌──────────────────────────────────────────────────────────────────┐
│                   CARAPABOARD HOST PROCESS (TRUSTED)             │
│  • Message routing                                               │
│  • IPC authorization                                             │
│  • Mount validation (external allowlist)                         │
│  • Credential filtering                                          │
│  • No direct Docker access                                       │
└────────────────────────────────┬─────────────────────────────────┘
                                 │ MCP tool calls
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                   CARAPA-BOX (DOCKER GATEWAY)                    │
│  • Only process with Docker socket access                        │
│  • Enforces pre-defined stacks only                              │
│  • Enforces OPA/Rego command policies (policy.wasm)              │
│  • Handles git via temporary SSH containers                      │
└────────────────────────────────┬─────────────────────────────────┘
                                 │ Explicit mounts only
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                DOCKER CONTAINER (ISOLATED/SANDBOXED)             │
│  • Agent CLI via run-agent.sh (claude/codex/pi/opencode/…)       │
│  • Bash / file operations (sandboxed to mounted paths)           │
│  • Network access (restricted through squid-proxy)               │
│  • No Docker socket                                              │
│  • Cannot modify security config or mount allowlist              │
│  • AGENTS.md: soft constraints read by agent                     │
│  • apparmor profile                                              │
└──────────────────────────────────────────────────────────────────┘
```
