# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 22.11.2026

First public release. CarapaBoard is a personal AI work assistant: you chat with
agents in your projects and can optionally hand work to a kanban board that
tests and reviews it. Its agents run in Docker sandboxes managed by
[CarapaBox](https://github.com/carapa-ai/carapa-box).

This is an alpha. Configuration variables, API and MCP tool contracts and the
database schema can still change between 0.x releases, and migrations run
forward only: back up `store/` before every update and read this file first.

### Requirements

- Linux host with Docker Engine and `docker compose`
- CarapaBox 0.1.0, installed and started before the Board (it provides the
  `egress_proxy` network and the `carapa-bot:<version>` sandbox image)
- `docker login dhi.io`, because the images build on `dhi.io/bun` base images
- gVisor (`runsc`) and CarapaBox's `carapabox-agent` AppArmor profile, for the
  shared browser sidecar
- PostgreSQL is bundled in `docker-compose.yml`; no separate database is needed

The recommended way to install is the setup skill: open the checkout in Claude
Code and run `/setup`, or ask another coding agent that reads `.claude/skills`
or `.agents/skills` to set up Carapa. It installs CarapaBox and the Board,
connects provider accounts and configures and tests each agent you choose. The
quick installer (`.agent/skills/setup/scripts/quick-install.sh`) and the manual
steps in the README remain available. `.agent/skills/setup/scripts/uninstall.sh`
removes an installation again (it only shows its plan until you pass `--yes`).

### Changed

- `docker-compose.yml` publishes the Board (3000) and PostgreSQL (5433) on
  `127.0.0.1` only. Set `CARAPA_BOARD_BIND=0.0.0.0` (or a LAN address) and
  `CARAPA_BOARD_DB_BIND` in `.env` to publish them elsewhere. The quick
  installer's Board override follows the same rule, also publishes on the Docker
  host gateway for CarapaBox's health check, and points CarapaBox's egress relay
  at `carapa-board:3000`. A manual install needs the same relay settings
  (README, _Network access_).
- `CORS_ORIGIN` unset now means same-origin only, plus the Android/Capacitor
  origins (`http://localhost`, `https://localhost`, `capacitor://localhost`),
  instead of every origin. `CORS_ORIGIN=*` still allows every origin and logs a
  warning at startup.
- Upgrade note: a deployment that is reached from the LAN, or from another
  browser origin, must now set `CARAPA_BOARD_BIND=0.0.0.0` and, if it relies on
  cross-origin access, `CORS_ORIGIN` in its `.env`.

### Added

- **Kanban board** with a configurable stage pipeline per project (queue,
  active, testing, review and done stages), each stage with its own agent,
  model and prompt
- **Task execution**: shared, branch or per-task worktree checkouts; task
  dependencies; steering and interrupting a running task; interrupted tasks
  continue after a Board restart; Testing and Review stages return structured
  verdicts; A/B experiments across variants of a task
- **Chat** with project conversations, optional per-conversation worktrees and
  merge controls, and export of a conversation as static HTML
- **Agent harnesses** behind one run protocol: Claude Code, Codex, Pi, OpenCode,
  Cursor, Hermes, Muse Code, Grok Build, Mistral Vibe, OMP, Prime Agent and
  Antigravity, plus a Direct mode that calls an LLM API without a CLI harness.
  Sign-ins are connected once in **Provider accounts** and never copied into
  the sandbox
- **Importers** for existing Claude Code and Codex conversations and memories
- **Projects and subprojects**: each project gets its own sandbox with only its
  own folder mounted; a parent project can share a workspace sandbox with its
  children
- **Multi-host execution**: a Board can act as a hub for CarapaBox runners on
  other machines, with per-project placement and browser viewer and shell tabs
  for remote projects
- **Memory**: `memorize`, `recall` and `forget` tools for agents, with facts
  that are versioned over time instead of overwritten
- **Privacy modes** per project, which limit cross-project memory reads and
  which helper LLM calls may leave the machine
- **Knowledge bases** shared across projects, with tags, thumbnails and document
  references in the chat composer
- **Scheduled tasks**, cronjobs and dataset tasks
- **Project mail** through [CarapaMail](https://github.com/carapa-ai/carapa-mail),
  with per-project accounts
- **Cost reporting** for chat and task runs
- **Artifacts and apps**: topic-scoped artifacts, publishing a project app for
  browser access from outside, a shared browser sidecar, and file previews for
  images, video, audio and JSON
- **Voice** (needs your own speech services): Live Mode for hands-free
  conversations, text-to-speech with replay, and meeting recording with
  real-time transcription
- **AI personas and teams** with avatars, per-conversation persona modes and
  handoffs
- **Multi-user** accounts with project roles, device approval and share links
- **Sidebar "Now" view** of what needs your attention
- **HTTPS from first boot** with a local CA (`store/certs/ca.crt`) that you can
  import into your browser; see `docs/tls-cert-trust.md`
- **Light and dark themes**

### Off by default

Enable these in `.env` when you need them:

- `ENABLE_MEMORY_REFLECTOR`: automatic memory extraction from transcripts. It
  needs its own model (`defaults.reflector` in `board_agents.jsonc`); the setup
  skill asks whether to turn it on
- `ENABLE_GITNEXUS`: code-graph integration, used together with
  `docker-compose.gitnexus.yml`
- `AUTO_RESTART_OUTDATED_SANDBOXES`: restarts idle project sandboxes onto
  rebuilt images, one at a time
- `ENABLE_OBJECTIVES` and `ENABLE_WHATSAPP`: need CarapaBrain and CarapaWaLink,
  which are not public yet (see Known limitations)

The Board warns at startup when HTTP authentication is disabled.

### Removed

- Data written by pre-0.1.0 development builds is no longer upgraded on read:
  testing verdicts missing from run history, objective cost metrics seeded from
  `state.json`, persona emotes read from the filesystem when no manifest was
  stored, and flat Cursor "Stuck on" error messages rendered as a Bash block.
  Such old records show less detail instead of being converted.

### Security

- Agents have no Docker access: only CarapaBox talks to Docker, and it starts
  only admin-defined stacks under OPA/Rego command policies
- Git credentials never enter the sandbox: pushes run in a short-lived sidecar
  container with the SSH keys mounted read-only
- Sandboxes get short-lived, project-scoped agent tokens, separate from the
  master API token, and limited to the tools and stages they need
- Viewer accounts are read-only across tasks, cronjobs, datasets, settings,
  artifacts and git push
- File operations on uploads, artifacts, transcripts and generated files refuse
  symlinks that point outside their directory
- Secrets and private keys are redacted from logs
- The image has no known HIGH or CRITICAL vulnerability findings at release

See `docs/SECURITY.md` for the full model and `SECURITY.md` to report a
vulnerability.

### Known limitations

- Objectives (CarapaBrain) and WhatsApp (CarapaWaLink) are coming soon; their
  repositories are not public yet, so the quick installer refuses
  `--with-brain` and `--with-whatsapp` (exit 2) unless `--git-base` hosts them
- The Android app is source only: there is no Play Store release or APK
  download, and building it needs your own Firebase project
  (`docs/fcm-setup.md`)
- Claude Code, Codex and Pi are verified end to end by the setup skill. The
  other harnesses have setup recipes in
  `.agent/skills/setup/references/agent-runtimes.md`, marked where they have not
  been verified yet; OpenCode is not wired to the provider relay
- Live Mode, text-to-speech and meeting transcription need speech-to-text and
  text-to-speech servers that you run yourself (`LIVE_STT_API_URL`,
  `TTS_API_URL`)

[Unreleased]: https://github.com/carapa-ai/carapa-board/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/carapa-ai/carapa-board/releases/tag/v0.1.0
