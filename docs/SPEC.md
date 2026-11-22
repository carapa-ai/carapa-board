# CarapaBoard Specification

A personal AI coding/work assistant built around a kanban board, chat, and SMART objectives. Agents run inside isolated Docker containers managed by a separate process (CarapaBox). The product is consumed primarily through a web UI and a native mobile app (Android today, iOS in the pipeline). WhatsApp remains available as a legacy optional I/O channel.

This document is the architecture-level reference. For deeper dives see the per-topic docs cross-linked throughout.

---

## Table of Contents

1. [Vision & Non-Goals](#vision--non-goals)
2. [Service Topology](#service-topology)
3. [Clients & Authentication](#clients--authentication)
4. [Project Modes](#project-modes)
5. [Module System](#module-system)
6. [Folder Structure](#folder-structure)
7. [Persistence](#persistence)
8. [Configuration](#configuration)
9. [Task Execution Pipeline](#task-execution-pipeline)
10. [Memory, Rules & Knowledge](#memory-rules--knowledge)
11. [Scheduling](#scheduling)
12. [MCP Surface](#mcp-surface)
13. [Optional Channels (WhatsApp, Email)](#optional-channels-whatsapp-email)
14. [Deployment & Auto-Deploy](#deployment--auto-deploy)
15. [Security](#security)

---

## Vision & Non-Goals

CarapaBoard is a **self-hosted, multi-user assistant** organized around projects. Each project is a folder (`groups/<project_id>/`) with its own memory, rules, transcripts, and isolated execution. Users sign in with their own account; access to projects, conversations, and knowledge bases is controlled per-resource via membership rows (`projectMembers`, `kbMembers`, `conversationMembers`). New devices are enrolled with admin approval (`/admin/devices/:deviceId/approve`).

Three per-project modes determine the primary surface:

- **kanban** — task cards with stages and an agent executor per stage
- **chat** — conversation thread with the agent (and/or a DirectLLM provider for lightweight replies)
- **objectives** — SMART-goal dashboard powered by CarapaBrain

Hard rules:

- **CarapaBoard never touches Docker.** Container lifecycle and any shell execution flows through CarapaBox MCP tools.
- **Agents never see real credentials or git keys.** LLM keys are injected by an `api-relay` container; SSH keys live in a temporary sidecar container that the agent's container never communicates with.
- **Access is verified per resource.** Auth middleware (`requireAuth`, `requireAdmin`, `requireProjectOwnerOrAdmin`, `requireKbOwnerOrAdmin`, `requireConversationOwnerOrAdmin`) gates every protected route; membership rows decide visibility.
- **Modular architecture** Each service has a clear boundary; there is no plugin framework, just a registration-based [module system](#module-system).

Non-goals:

- No public, multi-tenant hosting — this is a self-hosted product.
- No anonymous access; everything sits behind authenticated users + approved devices.

---

## Service Topology

```
                    ┌──────────────────────────────┐
                    │  Clients                     │
                    │  ├─ Web (Vite/React)         │
                    │  ├─ Android (Capacitor)      │
                    │  └─ iOS (planned, Capacitor) │
                    └──────────────┬───────────────┘
                                   │ HTTPS + signed requests
                                   │ (X-Carapa-Signature, ECDSA P-256)
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│  CarapaBoard (Bun process)                                   │
│  • HTTP API + WebSocket (Express on bun)                     │
│  • Module registry: kanban, chat, objectives, knowledge,     │
│    memory, transcripts, gitnexus, fs, web, push, whisper,    │
│    vector-store, whatsapp (optional)                         │
│  • Scheduler (cron / interval / once)                        │
│  • Built-in MCP server (tools that agents call back into)    │
│  • FCM push sender                                           │
│  • Brain event publisher                                     │
└────────────┬────────────────────────────────┬────────────────┘
             │ MCP                            │ REST + MCP
             ▼                                ▼
   ┌────────────────────┐         ┌─────────────────────────┐
   │  CarapaBox         │         │  CarapaBrain (optional) │
   │  • Docker gateway  │         │  • Objectives engine    │
   │  • Stacks, exec,   │         │  • Generates dashboards │
   │    git sidecar     │         │  • Calls board MCP to   │
   │  • Egress proxy +  │         │    create/update tasks  │
   │    api-relay       │         └─────────────────────────┘
   └─────────┬──────────┘
             │ docker compose
             ▼
   ┌──────────────────────────────┐
   │  Agent containers            │
   │  claude / codex / pi /       │
   │  opencode (via run-agent.sh) │
   │  No Docker socket.           │
   │  Network egress through squid│
   │  + api-relay credential      │
   │  injection.                  │
   └──────────────────────────────┘

   Optional:
   ┌─────────────────┐   ┌─────────────────┐
   │ CarapaWaLink    │   │ CarapaMail      │
   │ (WhatsApp MCP)  │   │ (email MCP)     │
   └─────────────────┘   └─────────────────┘
```

| Component        | Role                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **CarapaBoard**  | This repo. Bun process. HTTP/WS, scheduler, module host, MCP server, brain event publisher, FCM sender.                                     |
| **CarapaBox**    | Separate repo. Only process with Docker socket access. Manages stacks, executes `sandbox_*` MCP tools, runs the egress proxy and api-relay. |
| **CarapaBrain**  | Optional. Event-driven objectives engine. Receives events from board over REST, writes back via the board's MCP.                            |
| **CarapaWaLink** | Optional. WhatsApp Web bridge exposed as MCP.                                                                                               |
| **CarapaMail**   | Optional. Email send/receive with AI filtering, exposed as MCP.                                                                             |

All inter-service communication is MCP except the board → brain event channel, which is a thin authenticated REST API.

---

## Clients & Authentication

CarapaBoard is consumed by three client types from one codebase (`ui/`):

| Client                           | Notes                             |
| -------------------------------- | --------------------------------- |
| Web (Vite/React/TanStack Router) | Served from `ui/dist/`            |
| Android (Capacitor)              | `ui/android/` — production target |
| iOS (Capacitor)                  | Planned; same UI codebase         |

### Signed Request Handshake

Every API call carries three headers:

- `X-Carapa-Device-ID` — stable per-install ID
- `X-Carapa-Timestamp` — ISO-8601; server enforces a 5-minute replay window
- `X-Carapa-Signature` — base64 ECDSA P-256 over `timestamp:method:path:body`

Key material:

- **Android**: keypair generated and held inside Android Keystore (TEE / StrongBox where available). Never enters JS or the WebView.
- **Web / iOS**: WebCrypto-generated P-256 keypair. The PKCS8 blob is protected at one of three tiers, per-user:
  1. **WebAuthn-PRF biometric vault** — preferred when the platform supports the PRF extension (Touch ID / Face ID / Windows Hello / hardware key). Session secrets are AES-GCM-wrapped under a PRF-derived key; without a successful UV the vault is undecryptable.
  2. **Argon2id PIN vault** ([`ui/src/lib/pin-vault.ts`](../ui/src/lib/pin-vault.ts)) — for browsers without WebAuthn-PRF. The user picks a PIN; `argon2id` (64 MB / 3 iterations / parallelism 1) over `pin + per-user salt` derives a 256-bit AES-GCM key that wraps `{ deviceId, pubKey, privKey }`. The wrapped blob lives in `localStorage[pin_vault_<username>]`; the plaintext per-user blob is removed at enrolment. Five wrong PINs in a 30-minute window wipe the vault, forcing a fresh login and admin device re-approval.
  3. **Plain `localStorage`** — last-resort fallback when neither biometric nor PIN is configured.

The server verifies the signature on every protected route. There is no master bearer token; machine-to-machine callers use a user session token or a per-project agent token (carapa-brain calls back into the board with its per-project agent token).

### App Lock

UI-level gate independent of the server session:

- **Android**: numeric PIN backed by a Keystore HMAC verifier; 3-strikes kill-switch; optional duress PIN that fires a signed alert before wiping the handshake key.
- **Web / iOS**: WebAuthn (Touch ID / Face ID / Windows Hello / hardware key). The four session secrets are encrypted under a PRF-derived AES-GCM key; without a successful UV the saved session is undecryptable.

Full details in [`docs/android-security.md`](android-security.md).

### Push Notifications (Android, FCM)

The `push` module ([`src/modules/push/`](../src/modules/push/)) sends FCM v1 messages via a server-account JSON credential mounted at `FCM_SERVICE_ACCOUNT_PATH`. The Android client registers its token at bootstrap; the board sends payloads for: new chat messages, task state changes, brain event responses, and form prompts.

Failed and needs-input pushes of objective-tagged tasks moved by an agent wait for the objective's handling and are sent only if the task is still in that stage afterwards ([details](OBJECTIVES.md#held-failed-and-question-notifications)).

Sensitive content is **never put in the push body**. Pushes either ping the client to fetch, or carry a payload ID the client retrieves over the signed-request channel. Setup: [`docs/fcm-setup.md`](fcm-setup.md).

---

## Project Modes

A project's `settings.mode` selects its primary surface:

| Mode         | UI route                                                              | Use case                                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kanban`     | `board.$projectId.tsx`                                                | Task cards with stages; executor runs an agent CLI per stage                                                                                                                                                                                                                                                                                                                          |
| `chat`       | `chat.$projectId.tsx`                                                 | Conversation thread; lightweight turns can be served by **DirectLLM** with board-managed tools, including sandbox-backed repository inspection, and the same thread can hand off to a sandboxed agent CLI when the work needs containerized execution. The two co-exist within one conversation. See [Agent runtimes, persistent scopes, and workspaces](RUNTIMES-AND-WORKSPACES.md). |
| `objectives` | `objectives.$projectId.tsx` + `objective.$projectId.$objectiveId.tsx` | SMART goals dashboard powered by CarapaBrain                                                                                                                                                                                                                                                                                                                                          |

Messages posted by agents on a user's behalf (`source: 'agent'`) are shown with an "Agent" badge and a bot icon, as another participant and never as the viewing user, and are not listed as conversation participants.

`settings.enabledModes` can restrict which modes appear in the UI for a project. Listing `objectives` in it enables both the Objectives UI and CarapaBrain events for the project. Project membership (`projectMembers`) determines which users see the project at all and what role they hold within it.

---

## Module System

Optional capabilities are packaged as modules registered explicitly at boot in [`src/index.ts`](../src/index.ts). The contract is in [`src/modules/types.ts`](../src/modules/types.ts):

```ts
interface CarapaModule {
  name: string;
  isEnabled(): boolean;
  init?(): Promise<void>;
  shutdown?(): Promise<void>;
  registerTools?(server, deps): void; // adds MCP tools
  getRouter?(): express.Router; // adds HTTP routes
  getConfigFlags?(): Record<string, unknown>; // surfaces flags to UI
}
```

Lifecycle: **register → init (fault-tolerant) → registerTools → getRouter → getConfigFlags → shutdown**.

| Module         | Gate                                                                 | Adds                                                                  |
| -------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `kanban`       | default on (`ENABLE_KANBAN!=false`)                                  | Cards, stages, task executor, datasets, cron-driven tasks             |
| `chat`         | default on (`ENABLE_CHAT!=false`)                                    | Conversations, DirectLLM, scheduled chat tasks                        |
| `objectives`   | `ENABLE_OBJECTIVES=true`                                             | SMART objectives, brain event publisher, dashboard serve              |
| `knowledge`    | always on                                                            | Two-stage RAG over project-shared knowledge bases                     |
| `memory`       | always (core code, not a `CarapaModule`)                             | `memorize` / `recall` / `forget` MCP tools + memory reflector         |
| `transcripts`  | always (core code, not a `CarapaModule`)                             | JSONL task-message store under `groups/<id>/transcripts/`             |
| `gitnexus`     | `ENABLE_GITNEXUS=true` (default off)                                 | Code-intelligence MCP tools (`impact`, `query`, `context`, `rename`)  |
| `fs`           | default on                                                           | Sandbox-bound filesystem tools (`read_file`, `ripgrep`, `peek_files`) |
| `web`          | always on                                                            | Web search/fetch tools                                                |
| `whisper`      | `WHISPER_API_KEY` or `WHISPER_API_URL` set                           | Voice transcription                                                   |
| `vector-store` | `ENABLE_VECTOR_STORE=true`                                           | Neo4j embeddings backing `memorize`/`recall` and `knowledge`          |
| `push`         | `FCM_PROJECT_ID` + service account (core code, not a `CarapaModule`) | Android push notifications                                            |
| `whatsapp`     | `ENABLE_WHATSAPP=true`                                               | Optional WhatsApp I/O via CarapaWaLink                                |
| `live-voice`   | always on                                                            | Live Mode voice utterances through the Whisper-compatible client      |
| `tts`          | `ENABLE_TTS!=false` (default on)                                     | Text-to-speech                                                        |

Two siblings under `src/modules/` are **infrastructure, not modules**:

- `src/modules/messaging/` — provider-registry abstraction (`setMessagingProvider`); the whatsapp module plugs into it.
- `src/modules/tools/` — central tool registry (`TOOLSET_MODULES`), authorization, MCP dispatch.

Disabled modules are zero-cost — core code checks for module availability at runtime and falls back gracefully. New modules don't require core changes; see [`docs/MODULES.md`](MODULES.md).

---

## Folder Structure

```
carapa-board/
├── AGENTS.md, CLAUDE.md→AGENTS.md     # repo-level agent memory
├── docs/                              # this document and friends
├── prompts/                           # system prompt overrides per project / role
├── drizzle/                           # SQL migrations + journal (committed)
│
├── src/
│   ├── index.ts                       # bootstrap: register modules, init, start HTTP, hooks
│   ├── http-service.ts                # HTTP + WebSocket server, mounts module routers
│   ├── config.ts                      # env-derived config
│   ├── types.ts                       # shared backend types
│   ├── db.ts, db/                     # drizzle schema + queries (Postgres / PGlite)
│   ├── logger.ts
│   ├── crypto-verify.ts               # signed-request verification
│   ├── recovery.ts, state-manager.ts  # in-flight run recovery on restart
│   ├── group-dir.ts, group-bootstrap.ts
│   ├── agent-runner.ts                # chat-mode agent invocation
│   ├── mcp/                           # MCP server + bridge + sandbox client
│   ├── routes/                        # HTTP routes: tasks, conversations, kanban,
│   │                                  # memories, objectives, push, datasets, …
│   ├── sandbox/                       # CarapaBox MCP client
│   ├── stream/                        # stream parsing for agent output
│   ├── lib/                           # shared helpers
│   ├── concurrency/                   # per-project run queue
│   └── modules/
│       ├── loader.ts, types.ts        # CarapaModule contract + lifecycle
│       ├── messaging/                 # provider registry (infrastructure)
│       ├── tools/                     # tool registry (infrastructure)
│       ├── kanban/                    # cards, stages, executor, cron, review, datasets
│       ├── chat/                      # conversations, scheduling/, DirectLLM
│       ├── objectives/                # SMART goals + brain client
│       ├── knowledge/                 # two-stage RAG
│       ├── memory/                    # memorize/recall/forget + observer
│       ├── transcripts/               # JSONL task message store
│       ├── gitnexus/                  # code-intelligence tools
│       ├── fs/                        # sandbox-bound fs tools
│       ├── web/                       # web search/fetch
│       ├── whisper/                   # voice transcription
│       ├── vector-store/              # Neo4j embeddings
│       ├── push/                      # FCM sender + payload store
│       └── whatsapp/                  # optional legacy I/O
│
├── ui/                                # Vite + React + Capacitor
│   ├── src/                           # web UI
│   └── android/                       # Capacitor Android project (FCM, signing, app lock)
│
├── groups/<project_id>/               # per-project working directory (gitignored)
│   ├── AGENTS.md                      # project memory (CLAUDE.md, GEMINI.md symlinks)
│   ├── .agent/rules/                  # project-scoped rules
│   ├── logs/                          # streamed run logs
│   ├── transcripts/<task>.jsonl       # message history per task
│   └── objectives/<oid>/              # objective folders (when in objectives mode)
│
├── store/                             # longer-lived state (gitignored)
├── data/                              # PGlite data when not using Postgres (gitignored)
├── ipc/                               # active run snapshots (gitignored)
└── logs/                              # process logs
```

Container topology note: the host has all of these paths. The board container
has `groups/`, `data/`, `store/`, and `ipc/`, but not project repositories.
Agent containers see only what CarapaBox explicitly mounts: normally a group
data directory at `/workspace/group` and a repository at the effective
container workspace root. `group.settings.repositoryLocation` is only the
**host-side bind-mount source**; it is not a usable path inside either
container. Inside the agent container, use the resolved `workspacePath` (for
example `/workspace/<repo>` or a configured absolute path). DirectLLM remains
in the board process, while its permitted filesystem tools execute read-only
against that mounted workspace through CarapaBox. See
[Agent runtimes, persistent scopes, and workspaces](RUNTIMES-AND-WORKSPACES.md).

### Project files

Group-folder paths below are group-relative. Browsing (`GET /api/projects/:pid/files/group[/content]`) follows normal project read access; the list response carries `canManage`. The routes that change files are allowed for board admins and explicit project **owners and editors** only (403 for viewers, chat-only users and agent tokens):

| Route                                                              | Purpose                                                                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `GET`/`PUT /api/projects/:pid/files/editable-content`              | Board editor load and compare-and-swap save of a text file                                     |
| `POST /api/projects/:pid/files/group/rename` `{ path, newName }`   | Rename a file or folder in place                                                               |
| `POST /api/projects/:pid/files/group/move` `{ path, destination }` | Move into a folder (`''` = group root)                                                         |
| `POST /api/projects/:pid/files/group/delete` `{ path }`            | Delete a file, or a folder recursively (stops at the first error and reports what was removed) |
| `DELETE /api/projects/:pid/artifacts/*path`                        | Delete an artifact file (project write access: owner, editor, admin)                           |

Rename, move and delete answer 400 for invalid paths, 403 for protected paths and links, 404 for a missing source and 409 for an existing target (no overwrite or merge), then broadcast `artifacts_changed` or `group_files_changed`. They never reach extra mounts or the Repo source. See [SECURITY.md](SECURITY.md) §14.

**Favorite files.** A user marks files as personal favorites per project; they are stored server-side (`file_favorites`, per user and project, so they follow the user across devices) and are not shared. Any member who can read the project (viewers included) may use them, since they change no project data. Folders cannot be favorited, and neither can Repo or extra-mount files.

| Route                                                                                                | Purpose                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/projects/:pid/files/favorites`                                                             | The caller's favorites, newest first: `{ favorites: [{ id, kind, path \| kbId + filename, name, createdAt }] }`. Group files that no longer exist are dropped during the read (an existence check that errors keeps the entry)                                                                               |
| `PUT /api/projects/:pid/files/favorites` `{ kind, path }` or `{ kind: 'knowledge', kbId, filename }` | Idempotent add. `kind: 'group'` takes a group-relative file path (Group folder, `artifacts/...`, `objectives/<id>/...`); folders, missing files, absolute or `..` paths and the board-managed paths of SECURITY.md §14 are refused (400/403/404). Knowledge documents need read access to the knowledge base |
| `DELETE /api/projects/:pid/files/favorites` (same body)                                              | Idempotent remove                                                                                                                                                                                                                                                                                            |

Group rename, move and delete (and the artifact delete) keep favorites in step for every user of the project: a renamed or moved file, or a file inside a renamed or moved folder, keeps its favorite at the new path; a deleted file or folder drops the favorites below it. A rename or move is recorded in `file_favorite_moves` before the file changes (a failed record aborts the change) and settled in the transaction that rewrites the favorites; if that did not finish, the next favorites read or file change completes or discards the record from the filesystem state, and nothing is pruned meanwhile. Favorites work of a project runs under one in-process lock. Project rename moves the rows with the project, and project delete removes them (foreign-key cascade plus the explicit project-data delete).

**Files tab menu.** In the chat Files tab, every file and folder row of the Group folder, Artifacts and Objective sections has one actions menu: the row "…" button, a right-click, Shift+F10 or the context-menu key on a focused row, or a long-press on touch. It offers **Open** (files), **Download** (files), **Copy path** (the same `@path` reference that dragging the row into the composer inserts, folders with a trailing `/`) and, only when the list response's `canManage` is true (owners, editors and admins; hidden, never disabled), **Rename** (also F2; inline, Enter saves, Esc cancels), **Move…** and **Delete** (also the Delete key; confirms, and names the entry count of a folder). The board-managed folders listed in SECURITY.md §14 answer 403 (the menu still offers the edits; the toast shows the server message). **Move…** opens a dialog with a lazy folder tree of the whole group folder (folders only, a Load more row for paged folders, tree keyboard keys, Enter selects) and calls the `move` route; a server error (for example 409 when the name exists in the destination) shows as a toast and the dialog stays open. The tree leaves out the moved folder itself, the board-managed folders (the fixed names of SECURITY.md §14) and, in a parent project, the direct child project folders, each with everything below it; the current parent is greyed, `objectives` and `objectives/<id>` can be expanded but not chosen, and `artifacts` can be chosen. After the move, focus lands on the moved row when it is visible, otherwise on a neighbouring row. Repo, extra mounts and extra workspace roots (`settings.workspaceRoots`, one read-only section each, labelled with its path and left out when it is an extra mount or lies inside one) are read-only: they only get Open, Download and Copy path. Open preview tabs follow a rename or move and close on delete; an editor tab with unsaved changes asks before the change. Files in the Group folder, Artifacts, Objective and Repo sections also offer **Open in new tab** and **Copy link** (hidden when the project has no chat mode), and Ctrl/Cmd+click or middle-click on a file row opens the same link in a new tab. The link is the chat deep link `/chat/<project>?[conversationId=<id>&]file=<source>:<path>`, where `source` is `group` (path relative to the group folder) or `repo` (relative to the repo root; a conversation worktree needs `conversationId`). The chat route opens that file in the preview panel on load and keeps the param so a reload reopens it; a value with an unknown source, an absolute path or `..` is ignored. Files (not folders) of the Group folder, Artifacts and Objective sections, and knowledge documents, offer **Add to favorites** / **Remove from favorites** (by current state) in the same menu, to everyone who can read the project (not gated on `canManage`); Repo, extra mounts, extra workspace roots and folders do not offer it, and a failure shows a toast. Favorites are stored per user via `GET`/`PUT`/`DELETE /api/projects/:pid/files/favorites` (see Favorite files above), so they are the same on every device. They appear in a **Favorites** section listed first (an accordion in tree view, the first folder entry in list and grid views), left out entirely while the user has none. It is one flat list of all the user's favorites in the project, newest first, on chat and objective pages alike (an objective page also shows favorites from other objectives, Artifacts, the Group folder and Knowledge). Each row shows the file name, its thumbnail where the home section has one, and its origin (Artifacts, Group folder, Objective `<id>`, or the knowledge base name, with any folder below the section root). A favorite opens the same preview tab as in its home section and offers that section's Open, Download, Open in new tab, Copy link and Copy path where it has them (knowledge documents only Open), can be dragged into the composer the same way, and has **Remove from favorites**; Rename, Move… and Delete stay in the home section, and a rename, move or delete there refetches the favorites, as does `artifacts_changed`. Searching filters the favorites by file name. **Image preview.** An image opened in the preview pane is fitted whole into the pane at 1x and zooms (1x to 8x) with the mouse wheel, double-click or double-tap (toggles 1x and 2.5x), drag-panning while zoomed, and a two-finger pinch around the pinch point; a failing image falls back to the download preview.

---

## Persistence

- **Primary store**: PostgreSQL when `DATABASE_URL` is set; **PGlite** (embedded) otherwise. Same schema either way, via Drizzle ORM.
- **Schema**: `src/db/schema.ts` is the TypeScript source of truth; migrations live in `drizzle/` with a squashed baseline at `0000_baseline.sql`. Boot runs drizzle's `migrate()` only; see [`.agent/rules/09-database-migrations.md`](../.agent/rules/09-database-migrations.md).
- **Casing**: pure `camelCase` throughout TS models, Drizzle schemas, and API payloads; legacy `snake_case` is confined to specific historical column mappings.
- **File-backed state** complements the DB:
  - `groups/<id>/transcripts/<task>.jsonl` — task message history (managed by the `transcripts` module)
  - `ipc/` — active run snapshots used by `recovery.ts` after restart
  - `groups/<id>/logs/` — streamed agent logs

Core tables: `projects`, `tasks`, `active_runs`, `conversations`, `scheduled_tasks`, `task_run_logs`, `cronjobs`, `objectives`, `memories`, `knowledge_bases`, `knowledge_base_shares`, `users`, `device_keys`, `device_pairings`, `device_push_tokens`. The `task_messages` table still exists but is no longer written, and `chat_messages` is retired: task and chat messages live in the JSONL transcripts.

---

## Configuration

Four layers, resolved most-specific first:

1. **Task runtime selection** — an individual task can set `runtimeSelection` (harness, model, and optional reasoning) as its sole task-level runtime override. By default it applies to every stage; `runtimeSelectionStage` limits it to one executable base stage (`active`, `testing` or `review`), and every other stage then resolves its own runtime. Cronjobs and dataset tasks carry both fields and copy them to the tasks they spawn.
2. **Per-stage overrides** (inside `settings.stages[]`) — each stage can pin its own structured runtime, `workerSandbox`, and prompt.
3. **Project settings** (DB row on `projects.settings`) — `mode`, `enabledModes`, stages, prompts, custom values + card template, structured Kanban/chat runtime selections, timeout, additional mounts, `deployService`, `brainContainer`, encrypted `brainAuthToken`, `repositoryLocation`. Edited via the UI's Project Settings dialog or `PATCH /api/projects/:pid` (signed-in users only; agents use the `set_project_*` MCP tools).
4. **Global runtime catalog** (`data/board_agents.jsonc`) — stage-specific Kanban defaults (keyed by stage type such as `active`/`testing`/`review`, with exact stage-ID keys as overrides) and the final Kanban fallback, plus the global defaults for chat and auxiliary workflows.

Stage alternatives (`coding.b`, `review.o`), per-card variants, A/B experiments and `co_stages` extra reviewers/testers are documented in [AB-TESTING.md](AB-TESTING.md).

A child project inherits its parent's stages (and their stage prompts) while it has no stage list of its own. Editing the stages creates an override. "Inherit from parent" in the project settings Board tab, or `set_project_stages` with `inherit_from_parent: true`, removes the override so parent stage changes apply again; it is refused while a non-archived card sits in a stage the parent lacks. The child's own `stage-*.md` prompt files stay on disk but are no longer used. "Reset to parent stages" in the stage editor still only copies the parent's stages into an override.

Operational configuration remains in the process environment (`.env`, see `.env.example`), including credentials, ports, module gates, and sandbox defaults.

The effective runtime for a task run is resolved as **task `runtimeSelection` (all stages, or only its `runtimeSelectionStage`) → effective stage `runtimeSelection` → project `kanbanRuntimeSelection` → global stage default → global Kanban fallback**. The chosen harness, provider-facing model, and reasoning settings are materialized together from that catalog binding.

An `auto` selection in that chain is resolved to a concrete tier model only when the run starts a fresh session; continuing sessions keep the recorded model, and the decision is stored in `custom_values.routing[stageId]`. An explicit concrete model always wins. See [Auto in Kanban](AGENTS-CONFIG.md#auto-in-kanban).

### Agent entries and per-stage tool profiles

Each structured runtime selection resolves through `board_agents.jsonc` (loaded by `src/lib/chat-agents.ts`). A catalog binding combines a harness with per-run settings:

```jsonc
{
  "harnesses": {
    "claude": { "label": "Claude Code", "kind": "cli", "agentCmd": "claude" },
  },
  "models": {
    "research": {
      "label": "Research",
      "bindings": {
        "claude": {
          "agent": "research",
          "model": "research",
          "env": { "ANTHROPIC_BASE_URL": "http://llama-proxy:8881" },
        },
      },
    },
  },
}
```

`agent` and `model` are independent levers for tool scoping at different layers:

- **`agent`** is passed as `--agent <name>` to Claude Code (other CLIs not yet wired). The CLI loads `.claude/agents/<name>.md` and applies role-shaping system prompt + its own tool restrictions before the request leaves the CLI.
- **`model`** carries the profile name through to `body.model` on the wire. When the request hits the egress proxy's `llama-proxy`, that profile name is matched against `tool_profiles.json` and `body.tools[]` is filtered to the profile's allow-list. This is **local-LLM-only**; setting `model` to a profile name against the real Anthropic API would be rejected upstream.

Either field is optional. Use both for compounding effects: the CLI restricts at its layer, the proxy enforces at the wire, and the slim deterministic prefix produces stable cache identity per (stage, agent) pair. See [`carapa-box/egress-proxy/README.md`](../../carapa-box/egress-proxy/README.md#tool-profiles) for the proxy-side schema and reload mechanism.

Stage-level tool scoping is achieved by defining the appropriate catalog bindings and setting each stage's `runtimeSelection` to the desired harness/model pair.

Secrets can be loaded from a `SECRETS_DIR` directory (file-per-secret) when env-var-style storage isn't desired.

---

## Task Execution Pipeline

For projects in **kanban mode**, the executor is [`src/modules/kanban/task-executor.ts`](../src/modules/kanban/task-executor.ts). The pipeline:

```
User / agent / cron / scheduler triggers run
   │
   ▼
drainProjectQueue (per-project concurrency)
   │
   ▼
Stage resolved (queue → active → done) via stages.ts
   │
   ▼
(optional) Orchestrator phase
   │  • runs planning agent with orchestrator prompt
   │  • output injected into worker context
   ▼
Worker phase
   │  • CarapaBox sandbox_start (if not already running)
   │  • run-agent.sh launches the selected harness (claude | codex | pi | opencode | *-acp | agy-sdk)
   │  • stdout/stderr streamed → stream parser → task transcript (JSONL)
   │  • board's MCP server is reachable to the agent: it can call
   │    update_task / update_values / add_task_comment / send_message /
   │    create_task / memorize / recall / search_knowledge / gitnexus_* / …
   ▼
Stage transition (next active, or done)
   │
   ▼
If next stage == 'deploy' → triggerDeploy() via build_service MCP tool
   │
   ▼
task_completed event → CarapaBrain (if objectives enabled and configured)
```

Key properties:

- **Per-project run queue** in `src/concurrency/` prevents concurrent stage runs colliding on the same workspace.
- **Recovery**: `recovery.ts` reads `ipc/` snapshots on boot and re-attaches to active runs that survived a board restart. A re-attached run in a project without a dedicated task worktree holds the task's shared-checkout lease while it is watched, and a merge started by its recovered Testing or Review verdict, or by its successful move into a done stage, reuses that lease; a lease wait logs a warning after 30 s.
- **Streaming**: `src/stream/` parses provider-specific output (claude, codex, pi, opencode, ACP harnesses, and others) into a canonical event shape consumed by WebSocket subscribers.
- **Custom values**: project settings can declare typed fields (`score`, `summary`, ...) that the worker is prompted to fill via the `update_values` MCP tool; cards render them via a per-project HTML template. Pipeline-owned keys (review, cost-limit, merge, routing, failure and `testing_*` bookkeeping; see `src/modules/kanban/pipeline-owned-values.ts`) cannot be written by task-run credentials through `update_values` or the task POST/PATCH routes: the whole call is rejected, while credentials without a `task_id` (brain, user sessions) and pipeline-internal code are unaffected.
- **Review rework handoff**: when a card returns to an active stage after a review rejection, the implementation run receives the latest rejection in full (issues, reviewer summary, comparison decision and reason). Earlier rejections are summarized one line each, oldest first (round, short commit, progress label, up to three truncated issues), and issues that recur across rounds, including the latest, are highlighted with an instruction to take a materially different approach. The added section is capped at about 2,500 characters; the oldest rounds are dropped first and reported as omitted. This is per card: it is built from `custom_values.review_history`, which keeps the last 20 rejections.
- **Re-review context**: on a re-review (the card's `custom_values.review_history` contains rejected rounds), the review worker's change-inventory block gains an "Earlier rejected review rounds" section: one line per rejected round, oldest first (round number, comparison progress label if present, up to three truncated issues plus `+K more`). The rounds list is capped at about 2,500 characters — the oldest rounds are dropped first and reported as omitted, the latest rejected round is never omitted, and the delta sub-block and framing render outside that budget. It shows no commit ids and never includes advisory notes. Below the rounds, "Files changed since the last rejected round" lists the main repository's `diff --numstat` lines since the last rejected round, or `(no changes since the last rejected round)` when empty, or `(delta unavailable)` when the recorded commit is missing/invalid, the branch was rebased or force-pushed since that round, the base branch was merged in meanwhile, or git failed; the review still starts in that case. A first review (no rejected rounds, or only approved multi-reviewer records) gets a byte-identical block and runs no extra git commands. The base review stage, extra reviewers (`co_stages`) and A/B review alternatives share the single `enteringReview` prompt assembly in `src/modules/kanban/task/pipeline.ts`, but each reviewer is an independent opinion on every round: a rejected round records which review stage id raised each blocking issue (`reviewers[].stage_id` and `reviewers[].issues` for a multi-reviewer round, `stage_id` on the entry for a single-reviewer round), and the list shows a reviewer only the issues its own stage raised. Round numbers stay card-level, so a round in which this reviewer raised nothing leaves a gap, and when no line remains the heading and list are omitted while the files-changed sub-block and framing stay. Entries written before per-stage attribution are shown in full only when the current round has no extra reviewers, and to no reviewer otherwise. The comparison progress label is computed over the merged issues of all reviewers, so it appears only on lines of rounds a single reviewer judged. The coder's rework handoff still receives the combined rejection.
- **Per-task cost limit**: the project setting `kanbanTaskCostLimitUsd` (USD, default none) caps what one card may spend. A numeric `cost_limit_usd` custom value on a card (set via `update_values`) overrides the project setting for that card; non-positive or non-numeric values are ignored. The limit is checked before an automatic run starts (queue drain, auto-advance, review rework, and run-on-entry recovery hooks), comparing the sum of the card's `active_runs.cost_usd` (null counts as 0) with the limit. At or above it, no run is created: the card moves to `backlog` without a stage-entry event, one system message is appended and one `needs_input` notification is sent (tracked by the `cost_limit_hit_at` custom value, which is cleared once the limit is no longer exceeded or a user starts a run). Run cost is only recorded when a run completes, so a running run is never killed; the next automatic start is what is blocked. Runs a user starts explicitly (including moving the card into an executable stage), and restart-recovery continuations of an already admitted run, bypass the limit. It applies in addition to objective cost limits: for a card linked to an objective, whichever limit is hit first applies, and objective budgets are unchanged.
- **Testing verdicts in run history**: a Testing run's process status says only that the agent finished, so each testing run (including testing alternatives such as `testing.b`) also carries the tester's verdict as `active_runs.testing_decision` (`pass`, `fail` or `blocked`), written by `handleTestingDecision`. A run without a stored verdict keeps `null`. The runs API (`testingDecision`) and `get_task` `recentRuns[].testingDecision` return it, and the task dialog's Run History shows a finished testing run as green "Passed", red "Failed" or amber "Blocked"; an unknown verdict keeps "Success".
- **Execution phase**: the server derives one `phase` per task in `src/modules/kanban/task-phase.ts`: `running`, `preparing`, `queued`, `waiting`, `stalled` or `idle`, with precedence running > preparing > queued > waiting > stalled (the task `error` starts with `Stalled`) > idle. There is no `error` phase; `error` stays its own field. An error-marked task can still be running, preparing or queued (a real claim wins) and is never `waiting`. `GET /projects/:pid/tasks` and the MCP `list_tasks` and `get_task` tools return `phase`; the `running`, `queued`, `waiting` and `preparing` booleans remain on the list API for compatibility. The board card and the task dialog read this phase through `ui/src/lib/task-phase.ts`, overlaid by the WebSocket live/stalled signals.
- **Datasets**: a project can be configured as a dataset processor (one task per row); `dataset-tools.ts` exposes MCP tools to mark rows complete. Manually moving a row's card to a done stage (Completed or Deploy) also advances the batch to the next row.

A manual move of a card to a done stage (drag and drop or the bulk "Move to…" menu) merges the task branch inside the request, before the new status is saved. While the merge runs the board shows the card first in the target Done column with a "Merging…" indicator, and keeps it there across task-list refetches and websocket updates until the response and a follow-up refetch have delivered the server state. If the merge fails, or the request errors, the card returns to the stage it came from and the usual error toast is shown; in a bulk move only the failed cards return. This is client-side display state only: other tabs and a page reload mid-merge keep showing the server's previous status. The move waits at most 30 s for the shared-checkout lease and at most 30 s for the project git lock; if either wait runs out it answers `409 { error: "Checkout is busy: <shared-checkout lease | project git lock> is held by <holder>. Try again later." }`, saves nothing and never starts that merge later (in a bulk move this 409 answers the whole request while no card has been saved; after the first card was completed, a holder that appears later fails only the card it blocks, reported in `mergeFailures`).

Moving a running card with a human single or bulk `PATCH` to a queue stage stops the run and keeps the queue stage. Moving it to an execution stage other than its run's stage (taken from the active run row) stops the old run like the Stop button, but keeps the chosen stage without the `Stopped by user` error, then drains the queue so that stage's run starts; the stopped run's late completion or pending steering does not move the card back. A move to the run's own stage leaves the run going, and a manual move to a done stage is still refused while the card runs. A single-card manual completion reserves the card until the done status is written, so no run can start while it waits for the checkout and merges. Every agent `update_task` stage change of a card with a live execution claim is a graceful handoff bound to the card's current run, whoever calls (the card's own run, another task's agent, a chat agent or Brain): the run is steered to finish its turn with a short handoff summary (a caller other than the card's own run is told the card was moved by another agent), interrupted after 30 s if it does not, and the card lands on the requested stage once the turn ends. The `update_task` call returns normally and writes no `Stopped by user` entry. If no handoff can be installed (for example an orphaned run row after a board restart, with no in-process claim, or a claim whose run row does not exist yet because the run is still waiting for a sandbox slot and has no turn to finish), `update_task` falls back to the hard stop with the chosen stage kept. Agents cannot move a card into a Review stage while its required Testing stage lacks stored passing evidence (`testing_head_sha` or `testing_tree_sha`); `update_task`, single and bulk `PATCH` and `POST /execute?stage=` refuse it, and humans can still do it.

`POST /projects/:pid/tasks/bulk-start-over` with `{ ids }` starts over several cards at once, for humans only (agent credentials get 403; `ids` must be a non-empty array, an unknown project gives 404). It shares its reset sequence with `POST /execute?reset=true` (reset base, worktree or branch discard, transcript and `output`/`error`/`session_id` cleared, testing failure count reset, fresh review round). Only cards of the project that sit in a `queue` stage and have no active run are processed; the others are skipped with the reason `not_found`, `not_queue_stage` or `running` and are not modified. Every processed card moves to the first executable stage (no such stage gives 400). When a selected card depends on another selected card, the dependent card is reset first so the dependency's branch still exists when its reset base is resolved; other cards keep the request order. Cards are processed one at a time and a failure does not stop the batch; a forked A/B experiment parent is refused with the same error as `POST /execute` and listed in `failed`. When at least one card was reset, the project failure counter is cleared and the queue is drained once; the endpoint never starts the executor itself. The 200 response is `{ ok, reset: string[], skipped: [{ task_id, reason }], failed: [{ task_id, error, conversationIds? }] }`; a failed card (for example a worktree held by a conversation, `conversationIds`) keeps its transcript, fields and stage.

`add_task_comment` refuses a one-shot prompt from a card's own run (its token names the card, or its run id belongs to a run of the card) to the stage that card is currently running or starting, because it would be steered back into the same turn; the error points to `persistent: true` for a later run of that stage or to another `stage_id`. One-shot comments to other stages, persistent notes, and comments from other tasks' agents, chat agents, Brain or humans are unaffected. Persistent notes can be read back via `get_task` (`persistentStageComments`).

### Merge risk gate

A project can opt in to a human check before risky changes reach its default branch. The gate is off for every project whose default branch has no `.agent/merge-risk.json`, and for tasks without a task branch or projects outside `worktree`/`branch` checkout mode. The classifier is [`src/modules/kanban/task/merge-risk-gate.ts`](../src/modules/kanban/task/merge-risk-gate.ts).

Rules file (JSON; at most 100 rules; unknown keys are rejected):

```json
{
  "rules": [
    {
      "id": "db-migration",
      "paths": ["drizzle/**"],
      "reason": "Schema change"
    },
    {
      "id": "env-read",
      "paths": ["src/**/*.ts"],
      "added_line_pattern": "process\\.env\\.",
      "reason": "New env var"
    }
  ]
}
```

- `id`: `^[a-z0-9][a-z0-9-]{0,63}$`, unique. `paths`: 1..50 globs. `reason`: at most 200 characters.
- `added_line_pattern` (optional JS regex) is tested against the added lines of `git diff -U0` for each matching file; without it, touching a matching path is enough. Renames are classified by both the old and the new path (`--no-renames`).
- The file is read from the **default branch** only, never from the task branch or worktree, because the coding agent can edit its own branch. Any change the task branch makes to `.agent/merge-risk.json` is itself a `merge-risk-config` finding.
- The diff range is merge-base(default branch, task head) .. task head sha.

Fail-closed cases, each a finding that gates the merge: the file exists but is invalid JSON, violates the schema or has an invalid regex or glob (`merge-risk-invalid-config`); a git command fails, including reading the default branch (`merge-risk-error`); a per-file diff exceeds 1 MB or the branch changes more than 2000 files (`merge-risk-too-large`).

A gated branch merges only when the proposals table has an applied approval for the exact head sha: a row with `kind = 'merge'`, `name = <task id>`, `base_hash = <head sha>`, `status = 'applied'` and `decided_by` set. A row for another sha does not count, so a later commit needs a new approval. There is no bypass; the A/B winner merge is gated too, and its 409 carries the approval for a human caller.

`mergeTaskBranchWithResolution` classifies before waiting for the shared-checkout lease and again under the project git lock. The classified head sha is then enforced at merge execution: immediately before the sandbox merge call, `mergeTaskBranchToDefault` re-reads the task branch head (git only, so it is safe inside the merge's database transaction) and refuses with `approval_required` if it differs from the classified sha. The sandbox merge takes a branch name rather than a commit, so the remaining gap is one git round-trip, not an atomic pin. Manual completion merges without `mergeTaskBranchWithResolution` and runs the same checks. A blocked merge returns failure kind `approval_required` and the card gets a system notice starting `**Review approved, human approval required**` with the head sha and the findings (rule id, file, reason). The notice parks the card in the initial stage (review approval, deploy and completion merges) or reports the 409 (manual completion), which for a human caller also carries the approval (see Merge approval flow). It never starts the conflict resolver or another reviewer, and the merge-retry sweep ignores a card whose latest merge notice is this one. Each gate decision is logged at info level with task id, project, source, head sha and rule ids (paths and diff content are not logged).

carapa-board ships its own `.agent/merge-risk.json` (security boundaries, CI/deploy files, destructive migrations).

#### Merge approval flow

When the gate parks a card, the Board calls `requestMergeApproval` ([`src/modules/proposals/merge-approval.ts`](../src/modules/proposals/merge-approval.ts)) from the review, deploy/completion and manual-completion paths. It creates a proposal of kind `merge` (`target_layer = project`, `name = <task id>`, `base_hash = <head sha>`, rationale = head sha plus findings, approve action `merge_task`, deny action `none`) in a new project conversation of the task's project titled `Merge approval: <task title>`, whatever objective the task carries (the objective may belong to another project). The conversation shows under Now → Needs you and renders as an approval card (task link, short head sha, findings, Approve/Deny) instead of a file diff. It is idempotent per (task id, head sha): a pending, in-flight or applied row for the pair is reused. The approval-required task notice ends with a link to that conversation. Only the Board creates `merge` rows: `propose_changes` refuses the kind, and `merge_task` is valid only for kind `merge` (which accepts only `merge_task` or `none`).

Who may decide: a signed-in user session with write access to the conversation, through the existing `POST /projects/:pid/proposals/:id/approve|deny` routes. Agent tokens are refused. There is no admin requirement; project members approve their own project's merges. The first decision wins (compare-and-set claim), so a double click or two users deciding at once act once.

Approve ([`merge-approval-decision.ts`](../src/modules/proposals/merge-approval-decision.ts)), serialized per task:

- The task branch head is re-read. If it is not `base_hash`, the row becomes `stale` with the result `The branch changed after this was requested. A new approval was requested.`, the head is classified again and a new approval is requested for it (a branch that no longer needs approval just goes stale). Nothing merges.
- Otherwise the row becomes `applied`. A card parked from the review stage is then merged through the parked-merge retry path (`mergeTaskBranchWithResolution(task, group, 'recovery')`, then `completeApprovedMerge`), after checking it is still parked. A merge failure after approval follows the retry sweep's handling and leaves the row `applied`, because the approval is valid for that sha; an environment failure additionally posts a `**Review approved, merge pending**` notice so the retry sweep merges the card once the environment is repaired.
- A card parked from deploy or completion is only recorded: approval does not move it. The notice tells the person to move the card again, and the gate then passes.
- A task that no longer exists or is archived makes the row `failed` (`Task no longer exists`) for approve and deny alike; a task with a `merge_commit` is a no-op success.

A human's own action counts as the approval after a confirmation. When the gate holds a manual move to a done stage (bulk `PATCH /projects/:pid/tasks/bulk`, where the entry in `mergeFailures` carries it, or single `PATCH /projects/:pid/tasks/:fid`, where the 409 body does) or a "Merge this variant" pick (`POST /projects/:pid/tasks/:fid/ab/winner`, 409), the response also carries `approval: { proposalId, headSha, findings }` for the held task. Only human sessions get it; agent and other non-human callers receive the unchanged error. The Board shows one confirmation dialog listing each task, its short head sha and its findings. Cancel changes nothing and the approval stays pending in Needs you. Approve and merge posts `POST /projects/:pid/proposals/:id/approve` for each listed task, so the decision still goes through `decideProposal`: it is bound to the exact head sha, a moved head gives `stale` (the result text is shown and nothing is retried) and `decided_by` is the user. For each `applied` result the dialog then repeats the original action (the same move, or the same winner pick), which passes the gate as usual; the approve call never merges a card that is not parked in review. A variant that is already in a done stage is not parked, so its approval only records the decision and the winner is recorded and the parent completed by `pickAbWinner`.

Deny marks the row `denied` and posts the task notice `**Merge denied by <user>**`; the card stays parked. A new commit after approval changes the head, so the gate blocks it again and a new approval is requested. `reconcileInterruptedProposals` records `merge` rows left in `applying` by a restart as `failed` with a hint and never merges.

#### Prompt proposals

`propose_changes` also accepts kind `prompt`: a system, worker or stage prompt of a project, applied on approval exactly as `set_project_prompt` would ([`prompt-proposals.ts`](../src/modules/proposals/prompt-proposals.ts), using `applyProjectPrompt` from [`project-prompts.ts`](../src/modules/project-setup/project-prompts.ts)). The row is stored under the proposing project (`project_id`, so the card stays in the caller's chat) and carries a `set_prompt` approve action (`target_project`, `expected_revision`, `prompt_type`, `stage_id?`, `content`, at most 100,000 characters; null or blank removes the prompt). `name` must be `system`, `worker` or `stage-<stage id with . replaced by ->`, `target_layer` must be `project`, and the deny action may only be `none`. `set_prompt` is invalid for every other kind.

- **Who may propose:** a caller holding `project_setup:read` on `target_project`. Creation checks `expected_revision` (from `get_project_setup`) and the stage target with the same messages as `set_project_prompt`. `base_hash` is the sha256 of the current prompt (empty when absent) and `base_files` holds the old content.
- **Who may approve:** a signed-in user session (agent tokens are refused) with write access to the conversation, plus owner or editor access to `target_project` (`assertPromptApprover`). A signed-in admin also qualifies, except on another user's personal main project. Viewers, chat-only users, non-members and any lookup failure get 403 and nothing is written. Deny needs only conversation access.
- **Card:** shows the target project, the prompt file and a line diff between the live prompt and the proposed text. `targetChanged` is set when the live prompt no longer matches `base_hash`.
- **Staleness:** staleness is the hash of the single prompt, not the whole setup revision, which changes with any stage or prompt edit. Approve re-reads the prompt inside a per-file serialize lock; if its hash differs from `base_hash` the row becomes `stale` ("The prompt changed after this was proposed. Nothing was written."). Otherwise the prompt is written and the result is "Applied `<file>` to `<project>`, setup revision `<rev>`". Deny marks the row `denied` ("Dismissed.").
- **Audit:** `decided_by`, `decided_at` and `result` (including the revision) are recorded on the row. A restart while `applying` marks the row `failed`; it is never replayed.
- **Known limits:** direct UI and `set_project_prompt` writes do not take the proposal lock, so a small race window remains between the staleness check and the write. `readPrompt` caches for 5 s (`src/routes/_helpers.ts`), so an edit made within that window may not be seen by the check.

### Failure, review pause and recovery stages

Cards that stop making automatic progress are parked in a queue stage rather than left running:

- **Testing retry limit** and **review pause** (rejection cap, no-progress threshold or a `pause` comparison): parked in the Question stage, else an explicit Backlog stage, else the first queue stage (`getTestingBlockedStage`). The rejection cap counts rejections since the last human retry: a human move out of Question to an executable stage records the current `rejection_count` as the pipeline-owned `rejection_cap_base` and resets `no_progress_count`, while moves by agents (including the recovery agent) or the system do not. `rejection_count` itself is never reset.
- **Execution failure** (including restart recovery and deploy failures): parked in the Failed stage (`getFailedStage`).
- `backlog` is the human-only stage: it has no recovery agent, and a card there waits for a person.
- **Merge failure kinds** (`TaskBranchMergeFailureKind`): `conflict` returns the card to implementation with a merge-conflict prompt; `environment` parks it with a merge-pending notice that the merge-retry sweep retries; `approval_required` (the [merge risk gate](#merge-risk-gate)) parks it with a human-approval notice that is never retried automatically.
- **Accepted with nits**: a review that approves but lists nits reopens the same card in an executable stage for a polish pass and re-review, at most `MAX_NIT_POLISH_ROUNDS` (2) times (`nit_round_count`). Once the cap is hit, or a re-review after an earlier polish round sees the same head commit as the previous nit review (`last_review_head`, so the polish pass added nothing), the card merges and the nits are recorded as notes with verdict `accepted with nits (polish cap reached)`.

A queue stage with `runOnEntry: true` (normally Question and Failed) starts a one-shot recovery agent when a card enters it; the entry is recorded as a durable `stage_entry_events` row. The recovery agent may reset counters and move the card back to `in_progress`, `testing` or `review`.

To stop "recovery hook → work → failure → recovery hook" from looping forever, automatic entries share a budget of `MAX_AUTOMATIC_RECOVERY_RUNS` (2) hook runs per task, counted across all `runOnEntry` queue stages. The count covers entry events created since the task's latest human trigger (`lastTriggerSource = 'user'` at `lastTriggeredAt`), or all of them when there is none. A user-triggered transition always fires the hook and opens a new window. The human marker is overwritten when an agent moves the card with `update_task` (it sets `lastTriggerSource = 'agent'`), so after a recovery agent has moved the card, later parks count every historical event. In practice a human reset after earlier exhaustion therefore buys fewer than `MAX_AUTOMATIC_RECOVERY_RUNS` further automatic runs; this errs toward escalating to a human sooner, never toward looping.

When the budget is spent, the card is still parked in the Question or Failed stage, but no stage-entry event is created, so no recovery agent runs. The board appends a system message ("Automatic recovery exhausted after N runs — human decision required") and sends a `needs_input` notification, and the card waits for a human decision. The check lives in `updateTask` (`src/modules/kanban/db-kanban.ts`), so every automatic parking path respects it.

Chat-mode runs use a similar agent invocation path through `agent-runner.ts` but without the kanban stage machine — they just stream into the conversation.

---

## Memory, Rules & Knowledge

Three orthogonal mechanisms feed an agent context:

| Mechanism           | Storage                                                                      | Loaded                                    | Best for                                                  |
| ------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| **Rules**           | `.agent/rules/*.md` files at four layers (Box / Group / Project / Objective) | Auto, on agent start                      | Stable conventions, domain knowledge                      |
| **Memories**        | `memories` table (+ Neo4j vectors when `vector-store` is on)                 | On-demand via `recall` MCP tool           | Facts, decisions, evolving observations                   |
| **Knowledge Bases** | Filesystem + Neo4j vectors                                                   | On-demand via `search_knowledge` MCP tool | Long-form documentation, research, shared across projects |

Rules layering ([`docs/RULES.md`](RULES.md)):

```
Layer 0 — Box defaults          /home/ubuntu/.agent/rules/
Layer 1 — Group/main rules      groups/<pid>/.agent/rules/      → /workspace/group/.agent/rules/
Layer 2 — Project repo rules    <repo>/.agent/rules/            → /workspace/<repo>/.agent/rules/
Layer 3 — Objective rules       groups/<pid>/objectives/<oid>/.agent/rules/
```

The **Board memory reflector** reads transcript chunks and reconciles durable
facts with structured group memory; the `memory` module supports `memorize`,
`recall`, and `forget`.
Reflector memories restating an open card through a shared reference ID are
skipped or invalidated; the sweep invalidates only untouched live-reflector
memories (never edited, not applied by History Review).
The reflector may use tightly scoped, read-only repository inspection to
clarify or verify material project claims, but the transcript remains its
primary evidence. The reflector also keeps confirmed answers to the user's explicit command,
location, configuration, and rationale questions, even when they came from
repository docs, code, or git history. Reflector evidence keeps transcript
order: a message without its own timestamp takes the timestamp of the next
timestamped line of its admitted range (else the nearest previous one, else the
file's modification time). A conversation's turns within one idle window are
reflected as one range: a pending range absorbs the next turn even when
bookkeeping lines sit between them, unless that gap holds a user or assistant
message. A queued live reflection job re-reads its admitted run's end when it
runs, and retires the run if the admitted prefix no longer matches the
transcript. Durable pending live rows are also queued by a periodic sweep
(default every 2 min, rows idle for at least 10 min), not only at startup. Before reading any transcript, the sweep skips rows of gated projects (memory disabled, excluded group, `disableObservations`) and legacy task-source rows, which are left intact (not retired, not replayed). Rows whose transcript is missing, unreadable or no longer matches are only discovered while the sweep validates the row, and a row that fails to read does not abort the rest of the batch. A row the sweep has selected (skipped, or queued while still pending) stays unchanged and is offered again only after another idle window, behind rows not yet selected, so unprocessable or in-flight rows neither get re-read on every sweep nor keep other rows out of the 50-row batch. A live range that fails three times in a row, with no chunk completed in between (rate limits excluded), is retired as dead-lettered with a warning, so later ranges of that conversation proceed. `memorize` accepts an optional camelCase
`validFrom` ISO timestamp for when a fact became effective. `memorize` rejects
create/supersede content over 400 characters, and agent writes without a
`sourceRef` default to `task:<id>` or `conversation:<id>` from the run context.
`recall` returns
only currently-valid memories by default; passing an `asOf` ISO timestamp
performs point-in-time recall, including facts that were valid then but have
since been superseded. Every returned memory includes `validFrom`, `validTo`,
`source`, and `sourceRef` so agents can reason about its validity window and
provenance. Callers cannot set `validTo` or supersession metadata directly.
With `ENABLE_VECTOR_STORE=true`, recall additionally hits a Neo4j vector index
for semantic search.

Knowledge Bases ([`docs/KNOWLEDGE_BASES.md`](KNOWLEDGE_BASES.md)) use a **two-stage RAG**: Stage 1 is Neo4j vector recall scoped to KBs shared with the active project; Stage 2 is an LLM verifier that drops chunks with structural mismatches (e.g. "benefits" vs "risks") before they reach the agent.

---

## Scheduling

Two kinds of schedule, run by one scheduler loop (`startSchedulerLoop` in `src/modules/chat/scheduling/task-scheduler.ts`):

- **Chat-context scheduler** ([`src/modules/chat/scheduling/`](../src/modules/chat/scheduling/)) — `scheduled_tasks` table. Cron / interval / once. Runs full agents in a group's context; tasks can call `send_message` or finish silently. Exposed to agents via `schedule_task` / `list_scheduled_tasks` / `pause_task` / `resume_task` / `cancel_task`. Pausing a task during a run lets the run finish and keeps the task paused, with its next occurrence computed.
- **Project-level cronjobs** ([`src/modules/kanban/cron-tools.ts`](../src/modules/kanban/cron-tools.ts)) — `cronjobs` table. Triggers kanban task creation on a schedule.

The loop starts only when both `ENABLE_CHAT` and `ENABLE_SCHEDULER` are on, so cronjobs do not fire while the chat module is disabled.

---

## MCP Surface

### Tools the board exposes to agents

Built in `src/mcp/` and contributed by modules via `registerTools()`. Per-group active toolsets gate which subset an agent sees.

| Category               | Tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kanban                 | `create_task`, `update_task`, `update_values`, `add_task_comment`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Chat scheduling        | `schedule_task`, `list_scheduled_tasks`, `pause_task`, `resume_task`, `cancel_task`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Memory                 | `memorize`, `recall`, `forget`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Knowledge              | `search_knowledge`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Objectives             | `create_objective`, `update_objective`, `list_objectives`, `get_objective`, `delete_objective`, `move_objective`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Agents                 | `ask_project_agent` (new conversation in another project, or an existing one via `conversation_id`; `objective_id` targets that objective's chat; optional `runtime_selection` sets the harness and model of a new conversation; optional `use_worktree` (+ `branch`) starts it in a chat worktree of a worktree-mode project with a repository; returns at once; per-user mains and parents only; the answer arrives asynchronously in the caller's conversation as a message carrying an "Open conversation" link to the asked conversation: the token's conversation, else `reply_to_conversation_id` (a running chat of the calling project and of the ask owner; chat agents pass the `conversation_id` from their AGENT_CONTEXT), else as an `agent_answer` event for `reply_to_objective_id`) |
| Messaging              | `send_message` (routes to active provider — currently WhatsApp when enabled)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Filesystem (sandboxed) | `read_file`, `ripgrep`, `peek_files`, ...                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Web                    | `web_search`, `web_view`, `web_fetch_image`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GitNexus               | `gitnexus_query`, `gitnexus_context`, `gitnexus_impact`, `gitnexus_rename`, `gitnexus_detect_changes`, `gitnexus_analyze`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Admin                  | `register_group` and cross-project ops, gated by `requireAdmin`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Tools the board consumes

| From CarapaBox | `sandbox_start`, `sandbox_stop`, `sandbox_exec`, `sandbox_git`, `sandbox_logs`, `sandbox_status`, `sandbox_list`, `sandbox_ps`, `build_service`, `build_service_status` |
| From CarapaWaLink (optional) | messaging tools such as `send_message`, `set_typing`, `get_new_messages`, `list_chats` |
| From CarapaMail (optional) | `carapamail_*` send/receive/filter — proxied to DirectLLM (`src/modules/mail/`). Over MCP only a fixed read + draft allowlist reaches a mail-enabled non-main project's own tokens (see Email below); `carapamail_download_attachment` is overridden board-side to re-host the file under `/uploads` |

---

## Optional Channels (WhatsApp, Email)

These were primary in earlier versions of CarapaBoard. With the native mobile app handling on-the-go access and FCM handling notifications, they are now **opt-in modules** for users who want them.

### WhatsApp

- Gated by `ENABLE_WHATSAPP=true` and a configured `MCP_WHATSAPP_URL` pointing at a running CarapaWaLink.
- Inbound: CarapaWaLink polls WhatsApp Web; the board polls CarapaWaLink for messages and dispatches them to the project bound to the WhatsApp group/JID.
- Outbound: `send_message` MCP tool, or direct call via the messaging provider registry.
- Trigger-word matching (e.g. `@Capa`), assistant name (`ASSISTANT_NAME`), and group registration semantics are **WhatsApp-module concerns**, not product-level concepts. See the `whatsapp` module's README for routing rules.
- Privilege checks for WhatsApp-originated actions go through the same auth path as everything else: the WhatsApp group is mapped to a project, and project membership decides what the resulting agent can do.

### Email

- CarapaMail is a separate service exposing send/receive/filter as MCP. The board can be wired to it for agents that need email I/O.
- DirectLLM auto-discovers CarapaMail's tools and proxies them with the project's `carapaMailToken` (`src/modules/mail/`). One exception is **attachment downloads**: CarapaMail returns a short-lived link whose host is CarapaMail itself (reachable by the board, not by the user's browser). So the board overrides `carapamail_download_attachment` — it fetches the bytes server-side and re-hosts them under the project's `/uploads/<folder>/...`, then surfaces a browser-openable link in the reply. The board also sends `x-carapamail-public-base` so CarapaMail mints a link the board can fetch.
- Over MCP (objective, kanban and chat harness runs) a mail-enabled non-main project's own token gets only `carapamail_list_folders`, `_list_emails`, `_read_email`, `_search`, `_download_attachment` and `_save_draft` (once CarapaMail offers it), with no `project_id` parameter. The main agent, mail-disabled projects, human and OAuth tokens get none. See [PROJECT-MAIL.md](PROJECT-MAIL.md#agent-access-over-mcp).

---

## Deployment & Auto-Deploy

### Hosting

- The board itself ships as a Docker image built from `Dockerfile`. `docker-compose.yml` runs it.
- Alternative: bare-host `pm2` (`ecosystem.config.cjs`) is supported but no longer the recommended path.
- Bun runs TypeScript directly — there is no build step for the backend. The UI builds with Vite (`cd ui && npm run build`).

### Auto-Deploy Pipeline

A project with `settings.deployService` set and a `deploy` stage can build its service when a task lands in the deploy stage. The board merges the task branch and calls `build_service` on CarapaBox:

1. CarapaBox builds the image; a `build: host-request` service is queued for the host runner
2. For a queued build the board polls `build_service_status` until it settles
3. The running service is not restarted by the build; the restart is a separate step (admin Restart, or the service watcher)

Outcomes:

| Scenario                        | Result                                               |
| ------------------------------- | ---------------------------------------------------- |
| Build succeeds                  | Task stays in `deploy` stage with `completed_at` set |
| Build fails or CarapaBox errors | Task moves to `failed` stage with logs attached      |

Full pipeline doc: [`docs/AUTO-DEPLOY.md`](AUTO-DEPLOY.md).

### Health Endpoint

`GET /health` is auth-exempt and returns `{ status: 'ok', uptime: <seconds>, started_at }` — used by the service watcher (`src/service-watcher.ts`) which monitors sandbox stack health and exposes results to the UI.

---

## Security

Summary; full model in [`docs/SECURITY.md`](SECURITY.md) and [`docs/android-security.md`](android-security.md).

| Boundary                | Mechanism                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent ↔ host            | Docker container; agent has no Docker socket                                                                                                                           |
| Agent ↔ Docker control  | CarapaBox is the only Docker-aware process; only pre-defined stacks                                                                                                    |
| Agent commands          | Per-stack OPA/Rego policy compiled to `policy.wasm`; CLI exec only via allowed binaries                                                                                |
| Agent ↔ LLM credentials | `api-relay` container injects auth at proxy time; agent never sees keys                                                                                                |
| Agent ↔ git credentials | Temporary `alpine/git` sidecar with read-only SSH mount; agent's container is never involved                                                                           |
| Agent ↔ host filesystem | Only explicitly mounted paths visible; `mount-allowlist.json` validates additions                                                                                      |
| Client ↔ board          | TLS + ECDSA P-256 signed requests (replay-windowed); cert pinned on Android                                                                                            |
| User ↔ device           | Per-platform app lock (Android Keystore HMAC PIN; WebAuthn biometric on web/iOS)                                                                                       |
| Cross-project           | User identity + membership rows (`projectMembers`, `kbMembers`, `conversationMembers`) verified per request; users cannot read/write resources they aren't a member of |
| Brain ↔ board           | Per-project agent token (bearer) inbound; per-project encrypted `brainAuthToken` for outbound                                                                          |
| Secrets at rest         | `CARAPA_BOARD_ENCRYPTION_KEY` for `brainAuthToken`; Keystore / WebAuthn-PRF for client device keys                                                                     |

The hard boundary is **container isolation + the CarapaBox/api-relay/git-sidecar split**. Everything else (rules text, prompt-level constraints, AGENTS.md notices) is a soft layer above that.
