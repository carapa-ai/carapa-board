# CarapaBoard Requirements

## Philosophy

### Small Enough to Understand

Each service should be something you can read and understand individually. The system is composed of focused services that communicate via MCP:
CarapaBoard, CarapaBot (main orchestrator/assistant, per project agents), CarapaBox, CarapaWaLink, CarapaMail.
Each service has a clear boundary and a small codebase.

### Security Through True Isolation

Instead of application-level permission systems trying to prevent agents from accessing things, agents run in actual Docker containers. The isolation is at the OS level and the containers are hardened (docker hardened images, no-new-privileges, seccomp, apparmor). Agents can only see what's explicitly mounted. Bash access and YOLO is safe because commands run inside the container, not on the host.

API KEYS and Git credentials never enter the sandbox at all:

- for cloud LLM providers, the keys are injected by a separate `api-relay` container. Optional secrets scrubbing - sensitive env variables are redacted in the LLM prompts / tool responses.
- for remote git operations, the sandbox server spins up a temporary `alpine/git` container with SSH keys mounted read-only, runs the git command, and destroys it.

---

## Vision

A personal coding/work assistant used through project chat, with an optional kanban board for unattended, verified work.

**Core components:**

- **CarapaBoard** as the primary interface — create projects, chat with the agents, and optionally write task cards, execute agents and track progress on the board
- **CarapaBot** - with Claude Code, Codex, Pi, OpenCode, Cursor, Hermes, OMP, Prime Agent, or Antigravity as the agent harness (runs inside Docker containers)
- **Docker containers** for isolated agent execution
- **CarapaBox** as the container orchestrator (agents never touch Docker directly)
- **Optional modules** enabled by environment variables, for example WhatsApp access through CarapaWaLink (see [MODULES.md](MODULES.md))
- **Persistent memory** per project (AGENTS.md and .agent/rules files)
- **Scheduled tasks** that run Claude and can message back
- **Web access** for search and browsing

---

## Architecture Decisions

### Service-Oriented Design

The system is composed of independent services, each running in its own process/container:

- **CarapaBoard** — kanban board, HTTP API, WebSocket, scheduler, orchestration
- **CarapaBox** — the only thing that talks to Docker; manages container lifecycle and controls filters trafic using egress-proxy
- **CarapaWaLink** — WhatsApp session management and messaging, exposed via MCP
- **CarapaMail** — email proxy send/receive with filtering (AI evals optional), exposed via MCP

All inter-service communication uses MCP (Model Context Protocol). This means agents running inside containers can use the same tools that the orchestrator uses — a single protocol for both service-to-service and agent-to-service communication.

### Git Credential Isolation

Agents never see SSH keys. When an agent calls `sandbox_git push`, the sandbox server:

1. Spins up a temporary `alpine/git` container
2. Mounts host SSH keys **read-only** into that container
3. Runs the git command
4. Destroys the container

The agent's container is never involved.

### Pre-Defined Stacks Only

The sandbox server only starts stacks defined in its `stacks/` directory, which only an admin can modify. Agents can't create arbitrary containers or escape their sandbox.

### OPA/Rego Command Policies

Each stack defines a `policy.rego` (compiled to `policy.wasm`) that controls which commands the orchestrator can launch via `sandbox_exec`. Only approved agent binaries can be started. See [carapa-box/SECURITY.md](../../carapa-box/SECURITY.md).

### Message Routing (WhatsApp)

- A router listens to WhatsApp and routes messages based on configuration
- Only messages from registered groups are processed
- Trigger: `@Capa` prefix (case insensitive), configurable via `ASSISTANT_NAME` env var
- Unregistered groups are ignored completely

### Kanban Task Execution

- Projects map to isolated sandbox environments
- Task cards describe work to be done
- Each project can have customizable pipeline stages with their own agent, model, and prompt
- Agent output streams to the UI over WebSocket in real time

### Memory System

- **Per-project memory**: Each project has a folder with its own `AGENTS.md` and `.agent/rules`
- **Cross-project memory**: A user's personal main agent can recall memories from the projects that user can reach. There is no global `AGENTS.md` file.
- Agent runs in the project's folder and automatically inherits that project's `AGENTS.md`

### Scheduled Tasks

- Users can ask Claude to schedule recurring or one-time tasks from any group
- Tasks run as full agents in the context of the group that created them
- Tasks have access to all tools including Bash (safe in container)
- Tasks can optionally send messages to their group via `send_message` tool, or complete silently
- Task runs are logged to the database with duration and result
- Schedule types: cron expressions, intervals (ms), or one-time (ISO timestamp)
- From main: can schedule tasks for any group, view/manage all tasks
- From other groups: can only manage that group's tasks

### Group Management

- New groups are added explicitly via the main channel
- Groups are registered in the database
- Each group gets a dedicated folder under `groups/`
- Groups can have additional directories mounted via project settings

### Main Channel Privileges

- Each user has a personal main project (`main-<username>`), the control project for that user. With the optional WhatsApp module it is typically linked to the operator's self-chat. Set `WHATSAPP_SELF_CHAT_MAIN` to the operator's main project folder to enable first-pairing auto-link; the shared WhatsApp session does not identify its Board owner. An explicit unlink or link to a group is respected until the main is explicitly linked to self-chat again. Existing links are preserved.
- Can schedule tasks for the projects its owner can reach
- Can view and manage tasks of the projects its owner can reach

---

## Integration Points

### WhatsApp

- Managed by carapa-wa-link service (separate container/process)
- Uses carapa-wa-link MCP service for WhatsApp Web connection
- Exposed to CarapaBoard via the carapa-wa-link MCP tools (for example `send_message`, `get_new_messages`)
- QR code authentication during setup

### Scheduler

- Built-in scheduler runs on the host, invokes containers for task execution via CarapaBox
- Custom `carapa-board` MCP server (inside container) provides scheduling tools
- Tools: `schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `pause_task`, `resume_task`, `cancel_task`, `send_message`
- Tasks stored in PostgreSQL/PGlite with run history
- Scheduler loop checks for due tasks every minute

### Web Access

- Built-in WebSearch and WebFetch tools
- Standard Claude Code capabilities

---

## Setup & Deployment

### Deployment

- Production: Docker Compose (`bash build.sh && docker compose up -d`), including PostgreSQL
- Development: host mode via pm2 or `bun --watch`; Bun runs TypeScript directly
- `npm run rebuild` rebuilds the UI and restarts pm2

---
