<p align="center">
  <img src="ui/assets/icon-only.png" alt="CarapaBoard" width="400">
</p>

<p align="center">
  A personal AI assistant dashboard for coding and work. Chat with agents in your projects; optionally hand work to a kanban board that tests and reviews it.
</p>

## Status

**Alpha (v0.1.0).** Features, configuration variables, API and MCP tool contracts and the database schema change between 0.x releases. Migrations run forward only: back up `store/` before updating, and read [CHANGELOG.md](CHANGELOG.md) first.

**Supported host:** Linux with Docker Engine.

## What It Supports

- **Chat** — Threaded project conversations with CLI harnesses (Claude Code, Codex, Pi, OpenCode, Cursor, Hermes, Muse Code, Grok Build, Mistral Vibe, OMP, Prime Agent, Antigravity) or direct LLM calls, with optional per-conversation worktrees.
- **Kanban board** (optional) — Task cards that agents execute through a pipeline, for work that runs without you and is tested and reviewed. Turn it off per project under **Project Settings → General → Enabled Modes**, or for the whole installation with `ENABLE_KANBAN=false`.
- **Agent stages** — Customizable pipeline per project (stage types `queue`, `active`, `testing`, `review`, `done`). Testing and Review stages run fresh agents that validate and review the change. Each stage can have its own harness, model, and prompt. A/B experiments run variants of a task against each other ([docs/AB-TESTING.md](docs/AB-TESTING.md)).
- **Real-time streaming** — Agent output streams to the UI over WebSocket as it runs.
- **Isolated sandboxes** — Each project runs agents in its own Docker container with only its folder mounted. Projects can't see each other. The sidebar greys out and marks projects whose host is offline or whose sandbox is not running.
- **Per-project memory** — Each project has its own `AGENTS.md`, `.agent/rules/`, and structured memories.
- **Worktrees** — Optional per-task worktrees (`taskCheckoutMode: worktree`) allow parallel tasks; the Changes tab stages and commits per file, shows the default branch's ahead/behind counts against its remote, and offers Fetch, Pull (fast-forward only) and Push; a conversation worktree can be updated from the default branch. The Changes tab appears only for projects with a repository configured.
- **Conversation export** — Download one chat as a zip of static HTML with its images and a shared stylesheet (`GET /api/projects/:pid/conversations/:cid/export`).
- **Multi-user** — Accounts with project roles, device approval, AI personas, and share links.
- **Task dependencies** — Set `depends_on` between cards so a task won't start until its dependencies are done. Enables coordinated multi-agent workflows.
- **Scheduling** — Scheduled chat tasks (one-off or recurring agent runs that post their result in chat), cronjobs (a card per occurrence) and dataset tasks (a card per item of a list).
- **Knowledge bases** — Shared across projects, with tags and document references in the chat composer ([docs/KNOWLEDGE_BASES.md](docs/KNOWLEDGE_BASES.md)).
- **Project mail** — Per-project mailboxes through CarapaMail ([docs/PROJECT-MAIL.md](docs/PROJECT-MAIL.md)).
- **Cost reporting** — Costs of chat and task runs, with an optional per-task limit.
- **Voice** — Live Mode for hands-free conversations, text-to-speech and meeting transcription; needs speech services that you run yourself.
- **Web access** — Agents can search and fetch content.
- **Light & dark appearance** — System, light or dark theme switcher on the Account page, stored per device and applied without a reload.

### Android app

The Android app source is included in `ui/android`. A Google Play release is planned but not available yet, and there is no APK download. Until then, a build is a debug build installed over USB with `ui/android/install-apk.sh`, and it needs your own Firebase project (the build requires `ui/android/app/google-services.json`). See [docs/fcm-setup.md](docs/fcm-setup.md) for the Firebase setup, [docs/android-ota.md](docs/android-ota.md) for web-bundle updates and [docs/android-security.md](docs/android-security.md) for the security architecture. [docs/android-play-release.md](docs/android-play-release.md) lists what is still missing for a Play release.

## Usage

Open the web UI at `https://localhost:3000` (from another machine, see [Network access](#network-access)) and sign in (first sign-in: see [Verify](#4-verify)). A fresh installation has one project: your personal assistant, `<username>'s Assistant`, a chat project without a code repository.

Chat is all you need to use CarapaBoard. The kanban board is optional: use it when work should run without you and be tested and reviewed before it counts as done. Steps 2 to 4 below apply only then.

### 1. Chat

1. Open a project and start a conversation.
2. Pick the agent for the conversation. A CLI harness (Claude Code, Codex, Pi, …) runs inside the project's sandbox and can edit files, run commands and use Git. A Direct agent calls an LLM API without a sandbox process and reads the repository through read-only tools.
3. Pick a mode: **Ask**, **Plan**, **Code** or **Debug**. The modes and their prompts can be changed per project.
4. Write what you want. The answer streams in while the agent works.

To work on code, create a project with **New project** in the sidebar and connect its repository in **Project Settings**. Each project gets its own sandbox with only its own folder mounted. If a code project has no repository yet, the chat offers **Set up this project**. For a project that only needs chat and saved files, turn off **Project Settings → General → Code project**.

In a project with a repository, a new conversation can run in its own worktree (**Run this chat in a worktree**). The agent's edits then stay on a separate branch until you commit and merge them in the **Changes** tab.

### 2. Prepare a project for unattended work

A new project has the stages Backlog, Question, In Progress, Completed and Failed: one agent runs a card, and nothing checks the result. Before you hand over work that should be verified, let an agent set the project up. In the project's chat, with a CLI agent:

```text
Use the project-setup skill to set up this project.
```

The `project-setup` skill reads the repository and then proposes, one approval at a time:

- one verification command for the project (tests, typecheck, build)
- startup and browser-preview hooks and Playwright UI testing, when the project has a web UI
- the task checkout mode (`worktree` lets tasks run in parallel)
- project rules in `.agent/rules/`
- the pipeline stages, typically implementation, Testing and Review
- the worker, coding, testing and review prompts

It leaves its repository changes uncommitted for you to review in the **Changes** tab. The skill is part of [carapa-agent-kit](https://github.com/carapa-ai/carapa-agent-kit), which the quick installer puts into the sandbox agent home. Direct agents do not load skills, so use a CLI agent for this step.

### 3. Let an agent write the task cards

Describe the outcome in chat instead of writing cards by hand:

```text
I want to replace session auth with JWT. Explore the code, ask me what is unclear, then create the tasks.
```

With the `task-authoring` skill the agent checks the current behavior in the repository, writes acceptance criteria and a verification plan into each card, splits a large change into an ordered chain of dependent cards, and creates them with `create_task`. Read the cards on the board before you start them. You can still add a card yourself on the board (**Add Task**).

### 4. Run the board

Move a card into an executable stage, for example drag it to **In Progress**. The agent runs in the project's sandbox and the card advances through the pipeline:

- **Testing** and **Review** stages run fresh agents that validate and review the change and return a verdict. A rejected card goes back to coding with the findings.
- A card that needs your input waits in **Question**; a card that could not finish goes to **Failed**.
- Where you drop a card in a column sets its order, which is also the order in which waiting cards run.
- **Depends on** (in the card) holds a card until all its prerequisites reach a done stage, then starts it automatically. The picker lists an A/B experiment only by its parent card; a dependency on the parent follows the variant picked as winner.
- **Start over** resets a card (onto its dependencies' commits when they are not merged), discards its worktree and branch, and leaves starting to the queue, so the card still waits for unfinished dependencies, a paused or stopped project, and free slots. Selecting cards on the board offers **Start over** in the bulk toolbar for cards in queue stages such as Failed; cards in other stages are skipped.
- A merged dependency still counts as merged after the default branch is rebased, as long as its commits are on it with the same patches. If a rebase changed them, use **Start over** or remove the dependency.

### Scheduling

Ask an agent in chat for work that should happen later or repeatedly ("every Monday morning, give me a report about recently modified projects"). It sets up a scheduled task that runs in the chat and posts its result there. The board also has cronjobs, which create a card on a schedule, and dataset tasks, which run one card per item of a list.

## Security

**Agents never get Docker access.** The CarapaBox is the only thing that talks to Docker. Agents call `sandbox_*` MCP tools; the sandbox server executes them. No container escape is possible because agents have no Docker socket.

**Git credentials never enter the sandbox.** When an agent calls `sandbox_git push`, the sandbox server spins up a temporary `alpine/git` container with your SSH keys mounted read-only, runs the git command, then destroys it. The agent's container never sees the keys.

**Only pre-defined stacks can run.** The sandbox server only starts stacks that exist in its `stacks/` directory, which only an admin can modify. Agents can't create arbitrary containers.

**OPA/Rego command policies.** Each stack defines a `policy.rego` (compiled to `policy.wasm`) that controls which commands the orchestrator can launch via `sandbox_exec`. Only approved agent binaries can be started.

See [docs/SECURITY.md](docs/SECURITY.md) for the full security model. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Set up with an agent (strongly recommended)

A working installation needs several parts to line up: CarapaBox and its egress
relay, CarapaBoard, provider accounts, each agent harness's own configuration,
and the agent catalog (`board_agents.jsonc`). A step that is skipped or done in
the wrong order rarely fails loudly; an agent may simply not appear, or a chat may
spin while the relay rejects it.

The [setup skill](.agent/skills/setup/SKILL.md) walks through every step with
you and checks each one, including setting up and testing every agent you
choose. Run it with a coding agent rather than following the manual steps:

1. Clone this repository and open the checkout in Claude Code, Codex, or another
   agent that reads `.claude/skills` or `.agents/skills`.
2. Ask it to set up Carapa. In Claude Code, run `/setup`.

The agent asks before installing anything or making privileged changes, and it
never asks you to paste credentials. Provider accounts are connected in
Board's **Provider accounts** screen. The quick installer and the manual steps
below remain available, and the skill uses them itself.

## Quick install

The [quick installer](.agent/skills/setup/scripts/quick-install.sh) prepares a host installation of CarapaBox and CarapaBoard, creates configuration and secrets, and installs shared agent skills into the sandbox agent home.

From a local CarapaBoard checkout, authenticate to the image registry and run:

```bash
docker login dhi.io
bash .agent/skills/setup/scripts/quick-install.sh
```

The default installation directory is `~/carapa`. Add `--install-dir /absolute/path` to choose another directory, or `--agent-home /absolute/path` to select the directory mounted as `/home/ubuntu`. Use `--help` for all options. `--with-whatsapp` and `--with-brain` are not published yet: the installer exits with code 2 unless `--git-base` hosts those repositories.

Without a checkout, the [public bootstrap](bin/quick-install.sh) downloads the same installer:

```bash
curl -fsSL https://raw.githubusercontent.com/carapa-ai/carapa-board/main/bin/quick-install.sh | bash
```

Follow the [setup skill](.agent/skills/setup/SKILL.md) to finish agent authentication and smoke checks. Shared skill sources and update commands are documented in the [skill distribution guide](.agent/skills/setup/references/agent-skills.md).

For manual installation, follow the requirements and setup steps below.

## Requirements

- Linux host with [Docker Engine](https://docs.docker.com/engine/install/) and `docker compose`
- [Bun](https://bun.sh)
- `docker login dhi.io`: the `Dockerfile` builds on `dhi.io/bun` base images, so any image build needs it, not only the quick install
- [CarapaBox](https://github.com/carapa-ai/carapa-box) (sandbox server), installed and started before CarapaBoard:
  - `docker-compose.yml` declares the `egress_proxy` network as `external: true`, so `docker compose up` fails until that network exists (CarapaBox runs the egress proxy)
  - the `web-browser` service runs `WEB_BROWSER_IMAGE` (default `carapa-bot-agent:latest`), which must exist locally. CarapaBox builds its `carapa-bot` sandbox image as `carapa-bot:<version>` (`stacks/carapa-bot/VERSION`; the quick install runs that build, manually run `build.sh` in CarapaBox's `carapa-bot` stack directory). Set `WEB_BROWSER_IMAGE` to that tag before you start the service; the quick install sets it
  - its default seccomp profile is `../carapa-box/security/seccomp-default.json`, so a `carapa-box` checkout is expected next to this one; set `WEB_BROWSER_SECCOMP_PROFILE` if yours is elsewhere
- By default the Board (port 3000) and PostgreSQL (port 5433) are published on `127.0.0.1` only, so a default install is reachable from the host itself (see [Network access](#network-access))
- gVisor (`runsc`) and the `carapabox-agent` AppArmor profile on the host, for the `web-browser` service (see [docs/WEB-BROWSER-SIDECAR.md](docs/WEB-BROWSER-SIDECAR.md); load the profile with CarapaBox's [`security/install-apparmor.sh`](https://github.com/carapa-ai/carapa-box/blob/HEAD/security/install-apparmor.sh) (`sudo bash security/install-apparmor.sh` from the CarapaBox checkout), and install `runsc` and register it as a Docker runtime by following the [gVisor installation guide](https://gvisor.dev/docs/user_guide/install/))

## Components

| Component                                                         | What it adds                                                     | Required                         | In the v0.1.0 public release            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------- | --------------------------------------- |
| [CarapaBox](https://github.com/carapa-ai/carapa-box)              | Sandboxes                                                        | Required                         | Yes                                     |
| [carapa-agent-kit](https://github.com/carapa-ai/carapa-agent-kit) | Shared agent skills and rules, installed by the quick installer  | Installed by the quick installer | Yes                                     |
| [CarapaMail](https://github.com/carapa-ai/carapa-mail)            | Project mailboxes ([docs/PROJECT-MAIL.md](docs/PROJECT-MAIL.md)) | Optional                         | Yes                                     |
| CarapaBrain                                                       | Objectives (`ENABLE_OBJECTIVES`, off by default)                 | Optional                         | Coming soon (repository not public yet) |
| CarapaWaLink                                                      | WhatsApp access (`ENABLE_WHATSAPP`, off by default)              | Optional                         | Coming soon (repository not public yet) |

## Setup

### 1. Create secrets

CarapaBoard uses file-based secrets (preferred over env vars — they don't appear in `docker inspect` or process listings).

```bash
SECRETS_DIR="$HOME/.carapa/secrets/board"
mkdir -p "$SECRETS_DIR"

# Generate required tokens
openssl rand -hex 30 > "$SECRETS_DIR/carapa_box_api_token"     # must match CarapaBox's token
openssl rand -hex 32 > "$SECRETS_DIR/carapa_board_encryption_key"  # encrypts stored project tokens at rest
openssl rand -hex 30 > "$SECRETS_DIR/postgres_password"            # bundled PostgreSQL

# Browser sidecar token and its SHA-256 digest (no trailing newline) — see docs/WEB-BROWSER-SIDECAR.md
openssl rand -hex 32 | tr -d '\n' > "$SECRETS_DIR/web_browser_sidecar_token"
sha256sum "$SECRETS_DIR/web_browser_sidecar_token" | cut -d' ' -f1 | tr -d '\n' \
  > "$SECRETS_DIR/web_browser_sidecar_token_sha256"

# Create empty placeholders for optional secrets (Docker Compose requires all files to exist)
touch "$SECRETS_DIR/carapa_wa_link_token"   # populate if using WhatsApp (CarapaWaLink)
touch "$SECRETS_DIR/neo4j_password"         # populate if using Neo4j vector memory
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```bash
SECRETS_DIR=/home/youruser/.carapa/secrets/board
CARAPA_BOX_URL=http://localhost:3100
```

See `.env.example` for all available options.

> **Important:** `CARAPA_BOX_API_TOKEN` must be identical in CarapaBoard and CarapaBox. If you use file-based secrets, the same token file should be referenced by both services.

### Frontend env vars (`ui/.env`)

Frontend (`VITE_*`) variables are read from `ui/.env` at build time (not from the root `.env`).

If you use local DNS names/reverse proxy (for example `board.home.arpa`) and want the navbar connection indicator to show **home/local** instead of **remote/cloud**, set:

```bash
# carapa-board/ui/.env
VITE_LOCAL_HOSTNAMES=board.home.arpa,carapa.local,board.example.com
```

Optional related frontend vars:

```bash
VITE_LOCAL_IP=192.168.1.10
VITE_API_URL=https://your-public-domain.com
```

After changing `ui/.env`, rebuild/restart so the frontend bundle is regenerated.

### 3a. Docker mode (production)

```bash
# Load the AppArmor profile (required once per host, persists across reboots)
sudo bash security/install-apparmor.sh

# Create data directories — the container runs as UID 1000 and needs write access.
# CARAPA_DATA_DIR is the PARENT directory under which data/, groups/, and store/
# will be created. It defaults to the project root when unset.
# Example: CARAPA_DATA_DIR=$HOME/carapa-board/data
#   → creates $HOME/carapa-board/data/data/
#   → creates $HOME/carapa-board/data/groups/
#   → creates $HOME/carapa-board/data/store/
# logs/ is always relative to the project root.
DATA_DIR="${CARAPA_DATA_DIR:-.}"
mkdir -p "$DATA_DIR"/{data/ipc,groups,store} ./logs
chown -R 1000:1000 "$DATA_DIR"/data "$DATA_DIR"/groups "$DATA_DIR"/store ./logs

# Build the image (includes CVE scan)
bash build.sh

# Start the service
docker compose up -d
```

When sandbox agents can edit this checkout, deploy from an operator-only
directory instead: Compose trusts every file in the directory it runs in, so a
merged `docker-compose.yml` or `.env` change could otherwise grant itself host
access. Copy `docker-compose.yml` and `.env` to a directory outside every
sandbox mount, set `CARAPA_BOARD_SOURCE_DIR` (and the seccomp profile paths)
in that `.env`, build with `CARAPA_BOARD_DEPLOY_DIR=<dir> bash build.sh`, and
run `docker compose up -d` there. The [quick installer](.agent/skills/setup/scripts/quick-install.sh)
sets this up in `~/.carapa/deploy`.

**CarapaBox mount allowlist:** The board passes host paths (`groups/`, `data/ipc/`) as Docker bind-mount sources when starting agent sandboxes. These paths live under `CARAPA_DATA_DIR` (or the project root when unset). The `CARAPA_DATA_DIR` value must be listed in CarapaBox's `config/mount-allowlist.yaml`, otherwise sandbox starts will fail with a `[SECURITY] Mount path blocked` error:

```yaml
# carapa-box/config/mount-allowlist.yaml
allowed:
  - $HOME/carapa-board/data # your CARAPA_DATA_DIR value
```

If `CARAPA_DATA_DIR` is unset, add the project root directory instead.

### 3b. Host mode (development)

```bash
bun install
npm run pm2:start
```

Host mode needs Linux: the board reads agent-writable folders through `/proc/self/fd` (see `docs/SECURITY.md` §14).

Host mode needs a reachable PostgreSQL: set `DATABASE_URL`, or `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_NAME` plus the `postgres_password` secret. (PGlite is only used for in-memory tests.)

### 4. Verify

```bash
# Check the server is up (the API itself requires a signed-in user).
# The board serves HTTPS with a certificate from its local CA (store/certs/ca.crt).
curl -i --cacert "${CARAPA_DATA_DIR:-.}/store/certs/ca.crt" https://localhost:3000/api/projects   # expect 401 until you sign in
```

Import `${CARAPA_DATA_DIR}/store/certs/ca.crt` into your browser as a trusted authority (Firefox has its own store; see [docs/tls-cert-trust.md](docs/tls-cert-trust.md)), then open `https://localhost:3000`. On its first start (no users yet), the board creates an administrator named `admin` with a random password and prints it once to its log (stderr) as `  username: admin` / `  password: <value>`. Read it with `docker logs carapa-board 2>&1 | sed -n 's/^  password: //p' | tail -n1`; it is not shown again. Sign in, then change it via **Users → admin → Reset password**. The lone administrator's first device is approved automatically; later devices wait until an approved admin device approves them (**Devices**).

Sign in for the first time from the browser profile you will keep using, not a private window: a private window discards its device key when it closes, and the auto-approval is not repeated. If that happens and no approved device is left, approve the waiting admin device directly in the database:

```bash
docker exec carapa-db psql -U carapa -d carapa -c "UPDATE device_keys SET is_approved = true, approved_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), approved_by = user_id WHERE NOT is_approved AND kind = 'interactive' AND user_id = (SELECT id FROM users WHERE username = 'admin')"
```

### Network access

`docker-compose.yml` publishes the Board and PostgreSQL on `127.0.0.1` only, and CORS allows only same-origin requests plus the Android app's origins. To reach the Board from other machines, set `CARAPA_BOARD_BIND=0.0.0.0` (or a LAN address) in `.env`, ideally behind the ingress/TLS setup, and list any other browser origins in `CORS_ORIGIN`. `CARAPA_BOARD_DB_BIND` does the same for the database port; leave it on loopback unless you need remote database access.

CarapaBox's egress relay forwards agent traffic to the Board; by default it connects to `host.docker.internal:3000`, which a loopback-only publish does not serve. Set `CARAPA_BOARD_HOST=carapa-board`, `CARAPA_BOARD_PORT=3000` and `CARAPA_BOARD_PROTOCOL=https` in CarapaBox's `egress-proxy/.env` (the relay shares the `egress_proxy` network with the Board; the quick installer does this), or publish the Board with `CARAPA_BOARD_BIND=0.0.0.0`.

### Uninstall

The uninstaller prints its plan and changes nothing until you add `--yes`. It
finds a quick-installer deployment through `~/.carapa/install.env`, or the
checkout's own Compose project.

```bash
# Containers, networks and Compose volumes of Board and its optional parts
bash .agent/skills/setup/scripts/uninstall.sh --yes

# Everything, CarapaBox included: images, Board data (database, chats,
# projects, certificates), secrets and provider accounts, configuration and
# the installer record, and the sandbox agent home
bash .agent/skills/setup/scripts/uninstall.sh --images --data --secrets --state --agent-home --with-box --yes

# Host components, as root and on their own: AppArmor profiles (and gVisor with --with-box)
sudo bash .agent/skills/setup/scripts/uninstall.sh --host --with-box --yes
```

Postgres data and other files created by Docker as root are listed with the
`sudo rm` command that removes them. Shared images such as `postgres` and the
CarapaBot runtime (removed by CarapaBox's `--images`) are left to their owner.

## Architecture

```
User ──▶ Web UI (React) ──▶ HTTP API + WebSocket ──▶ Chat runner / Task executor
                                                           │
                                                     CarapaBox
                                                           │
                                                      Docker Compose
                                                           │
                                                   Agent Container
                                            (claude / codex / pi / opencode / cursor / …)
                                                           │
                                              sandbox_git ──▶ Temporary git
                                              (SSH keys)       container only
```

Three processes: **CarapaBoard** (the dashboard and agent orchestrator), **CarapaBox** (the sandbox container manager), **CarapaBot** (the agent running inside a sandbox). CarapaBot never talks to Docker directly—all container operations go through the sandbox server over MCP.

Chat and the board are two execution surfaces over the same sandboxes. A chat conversation runs either a CLI harness in the sandbox or a Direct LLM call made by the board itself; every executable board stage runs a CLI harness in the sandbox. See [docs/RUNTIMES-AND-WORKSPACES.md](docs/RUNTIMES-AND-WORKSPACES.md).

### Modules

Optional features are implemented as modules in `src/modules/`. Each module is self-contained with its own config, lifecycle hooks, and documentation. Modules are enabled via environment variables and cleanly disabled when not needed.

| Module       | Purpose                                                                                                 | Enabled by                                      |
| ------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| whisper      | Audio transcription                                                                                     | `WHISPER_API_KEY` or explicit `WHISPER_API_URL` |
| vector-store | Semantic memory search                                                                                  | `ENABLE_VECTOR_STORE=true`                      |
| whatsapp     | WhatsApp messaging through CarapaWaLink (coming soon), see [its README](src/modules/whatsapp/README.md) | `ENABLE_WHATSAPP=true`                          |
| objectives   | SMART goals                                                                                             | `ENABLE_OBJECTIVES=true`                        |

See [docs/MODULES.md](docs/MODULES.md) for the full module architecture and how to write new modules.

## Prompt Management

CarapaBoard uses a hierarchical, decentralized prompt-loading mechanism. This allows each group/project to have its own custom instructions without bloating the global configuration.

### Directory Structure

Prompts are stored in the `.agent/prompts/` directory within each group's home folder (usually under `groups/{folder}/` or `groups/{parentId}/{folder}/`).

| File                | Purpose                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `system.md`         | The base **System Prompt** for the group (used by both chat and worker agents).                                    |
| `worker.md`         | The default **Worker Prompt** used when a task starts executing.                                                   |
| `stage-{id}.md`     | **Stage-specific guidance** composed after `worker.md` (e.g., project review criteria in `stage-review.md`).       |
| `chat-mode-{id}.md` | **Chat-mode prompt** override (e.g., `chat-mode-plan.md`); falls back to the bundled `prompts/chat-modes/{id}.md`. |
| `starters.json`     | **Starter Prompts**: Clickable buttons shown in empty chat conversations.                                          |

The [`project-setup` skill](#2-prepare-a-project-for-unattended-work) generates the worker, stage and system prompts from the repository, so you rarely need to write them by hand.

Testing and review lifecycle instructions, including their required JSON
response formats, are always loaded from CarapaBoard's bundled
`prompts/testing.md` and `prompts/review.md`. Projects customize those stages
through `stage-{id}.md`; a project `.agent/prompts/review.md` is not loaded.
When an enabled Testing stage exists, the board also instructs Review to assess
its evidence without rerunning the validation commands.
The project's `stage-testing.md` sets which data-changing actions are allowed in the task's own isolated environment (preview UI/API, the task's database, migrations added by the diff). Earlier Testing verdicts are not passed to new Testing runs; coding runs still receive them.

### Resolution Hierarchy

When resolving a prompt (e.g., the `system` prompt for a group), the following locations are checked in order:

1.  **Group Home**: `CARAPA_DATA_DIR/groups/{group_path}/.agent/prompts/system.md` (Highest priority)
2.  **Project Templates**: `prompts/{group_folder}.md` (Bundled with the repository, when present)
3.  **Global Fallback**: `prompts/default.md` (Lowest priority)

### Agent Rules

In addition to base prompts, agents automatically load **Contextual Rules** from `.agent/rules/*.md`. Rules come in layers (shared agent home, project group folder, code repository, objective folder); see [docs/RULES.md](docs/RULES.md).

- Rules with `trigger: always_on` in their frontmatter are injected into every system prompt.
- Other rules (the default, `model_decision`) are presented as a discovery list with their description; the agent reads one when it becomes relevant to the current task.

## Key Files

- `src/index.ts` - Process bootstrap: module registration, startup recovery, IPC hooks
- `src/agent-runner.ts` - Chat entry point: runs a conversation turn with a Direct LLM or a CLI harness
- `src/lib/chat-agents.ts` - Loads `board_agents.jsonc` (see [docs/AGENTS-CONFIG.md](docs/AGENTS-CONFIG.md)); hot-reloaded
- `schemas/board_agents.schema.json` - JSON Schema for `board_agents.jsonc` (autocomplete + validation)
- `src/sandbox/process.ts` - Talks to CarapaBox; manages agent runs (re-exported by `src/mcp/mcp-runner.ts`)
- `src/modules/kanban/task-executor.ts` - Kanban task execution (stage pipeline)
- `src/modules/chat/scheduling/task-scheduler.ts` - Runs scheduled tasks
- `src/http-service.ts` - HTTP API and WebSocket server
- `src/db.ts` - Drizzle/PostgreSQL/PGlite operations
- `src/routes/projects.ts`, `src/routes/tasks.ts` - Project and task REST API
- `src/modules/` - Feature modules (chat, kanban, knowledge, objectives, whisper, vector-store, whatsapp, …)
- `src/modules/loader.ts` - Module registry and lifecycle
- `src/modules/transcripts/transcript-store.ts` - File-based task message storage and archival
- `groups/*/transcripts/` - Per-task conversation transcripts (JSONL)
- `groups/*/transcripts/archive/` - Compressed daily transcript archives (.tar.gz)
- `groups/*/logs/` - Per-project run logs
- `ui/src/` - React UI (chat, board, objectives)

## Data Storage

Task and chat transcripts (agent input/output) are stored as JSONL files under `groups/<project>/transcripts/` (for example `<date>-task-<task_id>.output.jsonl` and `<date>-chat-<conversation_id>.output.jsonl`), not in the database. This keeps the database small and focused on metadata.

**Exporting a conversation.** In the chat UI, open "Conversation actions" → "Export as HTML" to download it (not available in the Android app). The endpoint is `GET /api/projects/:pid/conversations/:cid/export` (read access to the conversation required) returns `<slug>.zip` containing `<slug>.html`, `conversation.css` and `images/`. The slug comes from the conversation title (`conversation-<id>` when untitled). Every export carries the same `conversation.css` (source: `src/modules/chat/conversation.css`), so exports of several conversations can be unzipped into one folder and share it; images are named `images/<id-suffix>-<n>-<filename>` to avoid collisions. The HTML has no scripts, inline styles or CDN assets and opens from disk. It includes user and assistant messages with sender names and timestamps, Markdown rendered, and image attachments plus `/artifacts/…` Markdown images from the conversation's own project. Tool calls, thinking, avatars and audio/video/document attachments (listed by filename only) are left out. Images that are missing, outside the project, symlinked, not recognizable as images or over 20 MB (the whole zip is capped at 150 MB, and images that would exceed it are replaced) show an "image not available" placeholder; external `http(s)` images keep their original URL. **Known limit:** there is no automatic redaction, so review the content for secrets and personal data before sharing an export.

**Automatic conversation titles.** After the first completed assistant turn of an untitled chat or objective-chat conversation, the board generates a title in the background (about a minute at most), independent of memory/observation settings. It uses the HTTP-capable binding of the global chat default; without one, or if generation fails, it only logs a warning and the turn is unaffected. Titles are skipped while background work is paused (e.g. during a restart or build), and a title that already exists, including a manual rename, is never overwritten. Kanban task transcripts are not named.

**Transcript archival.** Once per hour, transcripts older than `TRANSCRIPT_ARCHIVE_DAYS` (default: 3) are compressed into daily archives at `groups/<project>/transcripts/archive/YYYY-MM-DD.tar.gz`. Archived transcripts are extracted on demand when the UI requests them—no manual unzipping needed.

**Retention.** Chat messages live only in the transcript files, which are archived but never deleted automatically. The hourly cleanup removes task run log rows older than 30 days from the database.

**Testing recordings.** Run `scripts/cleanup-recordings.sh` on the host to preview
cleanup across all projects in `$CARAPA_DATA_DIR/groups`. The script reads
`CARAPA_DATA_DIR` from the repository's `.env`; an exported value takes precedence.
`.env` values may be quoted and are read literally without shell expansion;
relative paths are resolved from the repository directory.
The script reports only the matching count
and total bytes. It selects persisted task `.webm` recordings older than three
days by modification time; add `--days N` to change the threshold, or `--days 0`
to select all ages. Use `--project carapa-board` to limit cleanup to one project
folder, or `--all` for all projects (the default). Add `--apply` to delete.
Active IPC recordings and other artifacts are retained; deleted recordings
disappear from the task's recording list. The script requires Bash and GNU
find/stat (Linux).

## Project Settings

Each project has configurable settings accessible from the project settings dialog in the UI.

| Setting                  | Default                       | Description                                                                                                           |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `defaultSandbox`         | `carapa-bot`                  | Sandbox stack name (maps to a `stacks/` directory in CarapaBox)                                                       |
| `defaultSandboxService`  | `agent`                       | Service name inside the Docker Compose stack where agents run. Override when the agent container has a different name |
| `taskCheckoutMode`       | `shared`                      | Where tasks run: `shared` checkout, dedicated `branch`, or isolated `worktree`                                        |
| `maxParallelWorktrees`   | `1`                           | Concurrent task slots (1–10); only effective with `taskCheckoutMode: worktree`                                        |
| `kanbanRuntimeSelection` | _(inherit)_                   | Structured harness, model, and optional reasoning override for Kanban tasks                                           |
| `kanbanTaskCostLimitUsd` | _(none)_                      | Per-task USD limit; once a card's run cost reaches it, automatic runs stop and the card moves to Backlog              |
| `chatRuntimeSelection`   | _(inherit)_                   | Structured harness, model, and optional reasoning override for chat conversations                                     |
| `codeEnabled`            | on (off for a main assistant) | **Code project**: off for a project that only needs chat and saved files, without a repository                        |

| Env variable                  | Default   | Description                                                                                                                                         |
| ----------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRANSCRIPT_ARCHIVE_DAYS`     | `3`       | Days to keep transcript files uncompressed before archiving                                                                                         |
| `CARAPA_BOARD_PUBLIC_ORIGINS` | _(unset)_ | Comma-separated public origins (e.g. `https://board.example.com`) that enable [MCP OAuth](#authentication) for remote MCP clients; unset = disabled |

## Authentication

Sign-in is always required for all API endpoints (`/api/*`, `/uploads/*`). There is no unauthenticated single-user mode and no master API token. On the first start with an empty users table, the board creates the `admin` user with a random password and writes it once to stderr (see [Verify](#4-verify)); change it after signing in. Static UI files are served without auth.

**Browser (user accounts):** The web UI shows a username/password login. On success, the server sets an `HttpOnly` `carapa_session` cookie containing a signed session token, so sessions survive server restarts. Administrators manage users on the **Users** page. Browsers and the Android app register a device key pair and sign their requests; new devices wait for administrator approval (**Admin → Devices**). See [docs/android-security.md](docs/android-security.md).

**Remote MCP clients (OAuth 2.1):** with `CARAPA_BOARD_PUBLIC_ORIGINS` set, a standard MCP client can connect by browser login instead of a copied token, e.g. `claude mcp add --transport http carapa https://<board>/mcp/carapa-board`. The board serves RFC 9728/8414 discovery, dynamic client registration, PKCE (S256) authorization, rotating refresh tokens, and `/auth.md` for agents, only on the listed origins (the request host must match an entry; other hosts get 404). The user picks the target (their main project or one project; a parent project also includes its direct child projects, each limited to the user's own access to it), read or write access, and a duration, and confirms with a device signature. `cmo_…` access tokens work only on `/mcp/carapa-board` of the origin they were issued for. The knowledge-base MCP tools accept an optional `target_project` and apply the user's own knowledge-base role (viewer = read-only; no membership = not visible; admins are not role-restricted). Browser-session and user-token calls to `/mcp/*` get the same reach as the user's per-user main (owned and member projects, viewers read-only), admins included. Human sessions (browser cookie, user token, media ticket) carry no wildcard permissions at all: the HTTP auth middleware gives them an empty `permissions` map, and `/mcp/*` replaces it with the user's per-project reach, never `'*'`.

**Programmatic (user session token):** For scripts, curl, or external integrations, sign in as a user to get a session token, then send it as a Bearer token:

```bash
CA="${CARAPA_DATA_DIR:-.}/store/certs/ca.crt"   # the board's local CA, see Verify
TOKEN=$(curl -s --cacert "$CA" -X POST https://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<your password>"}' | jq -r .token)
curl --cacert "$CA" -H "Authorization: Bearer $TOKEN" https://localhost:3000/api/projects
```

## Development

### Running with pm2 (recommended)

pm2 keeps the process alive. Bun runs TypeScript directly — no build step needed.

```bash
npm install -g pm2
bun install
npm run pm2:start
```

### After code changes

```bash
pm2 restart carapa-board
```

### After UI changes

```bash
npm run rebuild
```

### Other commands

| Command            | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `npm run dev`      | Run with `bun --watch` (auto-restart on file changes) |
| `npm run pm2:logs` | Tail pm2 logs                                         |
| `npm run pm2:stop` | Stop the process                                      |
| `pm2 status`       | Check process health                                  |

## FAQ

**When should I use chat, and when the board?**

Use chat when you are there to steer: questions, exploration, planning, and changes you want to watch and direct. Use the board when the work should run without you: a card states the outcome, waits for its turn and its dependencies, and passes through Testing and Review stages with fresh agents before it is done. Stages can use different agents, models, and prompts. See [Usage](#usage).

**How do git operations work securely?**

The agent calls `sandbox_git push` (an MCP tool). The sandbox server handles it by running a temporary `alpine/git` container with your SSH keys mounted read-only from the host. The agent's container never touches the keys. When the git command finishes, the temp container is destroyed.

**Is this secure?**

Agents run in Docker containers without Docker socket access. They can only run pre-approved commands in pre-defined stacks. See [docs/SECURITY.md](docs/SECURITY.md) for the full model.

## Troubleshooting

**`lockfile had changes, but lockfile is frozen` during Docker build**

The Dockerfile uses `bun install --frozen-lockfile`, which requires `bun.lock` to exactly match `package.json`. If you added, removed, or updated a dependency, regenerate the lockfile first:

```bash
bun install
```

Then commit the updated `bun.lock` and rebuild. `build.sh` includes a pre-flight check that catches this before starting the Docker build.

## License

Copyright (c) 2026 Regun Software SRL

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE).

The shared agent skills and rules in [carapa-agent-kit](https://github.com/carapa-ai/carapa-agent-kit) are a separate repository under the Apache License 2.0; this license does not cover them.

**Personal / self-hosted use** — free and unrestricted. Run it on your own server for yourself, your family, or your homelab.

**Enterprise / commercial use** — requires a separate commercial license. Contact **hello@carapa.ai** for pricing and terms.

This project includes code derived from NanoClaw under the MIT License. See [NOTICE](NOTICE) for attribution.
