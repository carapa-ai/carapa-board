# Agent Rules System

Rules are markdown files delivered to an agent when it starts. Rules with `trigger: always_on` in their frontmatter are loaded into its context; all other rules (the default trigger is `model_decision`) are listed with their description and path, and the agent reads one when it becomes relevant. They shape agent behavior — coding conventions, domain knowledge, safety constraints, personality.

---

## Rule Layers

Rules can come from multiple directories. The execution surface, selected
runtime, and CLI CWD determine which layers are actually delivered; the Board
does not concatenate every directory for every invocation. More specific
layers extend broader ones and are emitted later when CarapaBot synthesizes a
combined instruction file.

```
Layer 0 — Box defaults        /home/ubuntu/.agent/rules/
Layer 1 — Group/main rules    groups/<group_folder>/.agent/rules/     (mounted as /workspace/group/.agent/rules/)
Layer 2 — Project rules       <project-repo>/.agent/rules/          (mounted as /workspace/<repo>/.agent/rules/)
Layer 3 — Objective rules     groups/<group_folder>/objectives/<objId>/.agent/rules/
```

### Layer 0 — Box defaults

Shared across all agents running in the same CarapaBox instance. Use for:

- Infrastructure knowledge (available services, network layout)
- Global conventions (commit style, code review norms)
- Shared tool configurations
- this is mounted from AGENT_HOME as `/home/ubuntu/` (all boxes sharing an AGENT_HOME will automatically share the rules and the skills)

**Location on host**: configured per box in `config/stacks/<stack>/home/.agent/rules/`
**Visible to agent at**: `/home/ubuntu/.agent/rules/`

### Layer 1 — Group rules

Per-group rules visible to agents started from the group's chat context (e.g., the main assistant). Use for:

- Cross-project knowledge (licensing decisions, architecture overview)
- Scheduling guides, workflow preferences
- Memories and observations from chat interactions

**Location on host**: `groups/<group_folder>/.agent/rules/`
**Visible to agent at**: `/workspace/group/.agent/rules/`

### Layer 2 — Project rules (from the code repository)

Rules, skills, and `AGENTS.md` committed directly to the code repository that agents work on. These are the standard Claude Code conventions (`.agent/rules/`, `.agent/skills/`, `AGENTS.md`) that coding agents pick up when the repo is mounted into their sandbox. Use for:

- Coding conventions and implementation workflow
- Domain model, API contracts, architecture docs
- Debugging playbooks, verification checklists
- Project-specific skills (e.g., review, deploy)

**Location on host**: `<repo-path>/.agent/rules/`, `<repo-path>/.agent/skills/`, `<repo-path>/AGENTS.md`
**Visible to agent at**: `/workspace/<repo>/.agent/rules/`, etc. (repo mounted at `/workspace/<repo>`)

### Layer 3 — Objective rules

Per-objective rules for CarapaBrain agents working on a specific SMART objective. Use for:

- Objective-specific evaluation criteria
- Custom skills (e.g., evaluate-proposal)
- Domain knowledge scoped to the objective's goal

**Location on host**: `groups/<group_folder>/objectives/<objId>/.agent/rules/`
**Visible to agent at**: `/workspace/group/objectives/<objId>/.agent/rules/`

---

## What Each Execution Surface Loads

See [Agent runtimes, persistent scopes, and workspaces](RUNTIMES-AND-WORKSPACES.md#chat-mode-versus-work-mode-kanban)
for the complete CLI spawn paths and CWD rules.

| Invocation          | Rules selected by CarapaBoard or the CLI CWD                                                                  | Box defaults                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| DirectLLM chat      | Group rules, plus objective rules for an objective conversation, are assembled by CarapaBoard                 | Not available through the container home because no CLI container is invoked      |
| CLI chat            | Rules under the resolved chat CWD: normally group/project rules, or the conversation worktree's project rules | Available inside the sandbox; CarapaBot explicitly combines them for Codex and PI |
| Work/Kanban stage   | Project rules under the repository root or task worktree CWD                                                  | Available inside the sandbox; CarapaBot explicitly combines them for Codex and PI |
| Brain objective CLI | Objective rules when the objective folder is the resolved CWD                                                 | Available inside the sandbox; delivery depends on the selected harness            |

For Codex and PI, `run-agent.sh` handles harnesses that do not natively load
`.agent/rules`:

1. It reads eligible Markdown files from `/home/ubuntu/.agent/rules/`.
2. It then reads eligible files from `<CLI-CWD>/.agent/rules/`.
3. It writes the same composed content to `AGENTS.override.md` for Codex and
   `.pi/SYSTEM.md` for PI in the CLI CWD before launching either harness.
4. `always_on` bodies are embedded. `model_decision` rules are listed by
   description and path so the harness can load them on demand.

Both generated files are refreshed on each relevant cold launch and removed
when no eligible source rules remain. A hand-authored override is not removed.
Warm processes retain the instructions loaded when that process started; rule
changes take effect after the warm process is recreated.

Other CLI harnesses use their native instruction mechanisms and compatibility
paths such as `.claude/rules` and `.gemini/rules`. Consult the harness binding
before assuming that `/home/ubuntu/.agent/rules` is a native discovery path.

There is no automatic inheritance from Layer 1 to Layer 2. A group rule is not
visible to a repository-backed Kanban agent merely because both belong to the
same CarapaBoard project. Put cross-project rules in Layer 0 or duplicate them
in the repository when the selected runtime cannot consume Layer 0.

---

## Skills

Skills follow the same layering as rules. They are markdown files (typically `SKILL.md`) in `.agent/skills/<skill-name>/` directories.

```
/home/ubuntu/.agent/skills/              → box-level skills (all agents)
groups/<group_folder>/.agent/skills/      → group-level skills (main chat)
<repo>/.agent/skills/                    → project-level skills (from code repo, used by coding agents)
objectives/<objId>/.agent/skills/        → objective-level skills (brain agents)
```

The box-level skills and rules, and the group and objective templates under
`/home/ubuntu/.agent/scopes/{group,objective}`, are installed from the
`carapa-agent-kit` repository (`platform/`, `group/`, `objective/`).

---

## Rule File Conventions

- **Filename**: lowercase with hyphens, `.md` extension. Optional numeric prefix for ordering (e.g., `01-project-context.md`, `02-implementation-workflow.md`).
- **Format**: Markdown with clear headings. Keep each file focused on one concern.
- **Size**: Keep rules concise. Every `always_on` rule is loaded into context in full, and every other rule contributes its description — bloated rules waste context window.
- **Naming suggestions**:
  - `tool-behavior.md` — tool usage patterns and constraints
  - `session-reflections.md` — meta-observations about agent effectiveness

---

## Transcript memory (not rules)

Automatic transcript memory is the **Board memory reflector** (`src/modules/memory/tool-reflector.ts`), enabled with `ENABLE_MEMORY_REFLECTOR=true`. It writes structured memories, never files under `.agent/rules/`:

- **Inputs and outputs**: after chats and tasks it reads the run's bounded transcript range and reconciles durable facts with structured group memory through `recall`, `memorize`, and `forget`. Conversation evidence remains primary. The manual `/reflect` command runs the same reflector on the current conversation.
- **Cross-group access**: child memories are not copied to parent or main projects; they read them through `recall` (parent: direct children; main: all projects).
- **Prompt composition**: `prompts/tool-reflector.md` is combined with one editable source profile under `prompts/reflector-profiles/`: DirectLLM conversation, CLI agent conversation, or autonomous Kanban task. The source profile changes how transcript evidence is interpreted, not the reflector runtime or persistent scope.
- **Repository inspection**: the reflector may use only `recall`, `ripgrep`, `read_file`, and `peek_files` for inspection. The filesystem tools execute read-only in the project's effective CarapaBox sandbox; they clarify or verify material claims rather than becoming an independent source of broad memories.
- **Writer**: CarapaBoard validates and applies every memory mutation. This is the **Board memory reflector**, not CarapaBrain's objective-local session reflector.

See [Agent runtimes, persistent scopes, and workspaces](RUNTIMES-AND-WORKSPACES.md)
for how these direct support LLMs inspect repositories without acquiring a CWD.

---

## Propagating Rules

### To groups and objectives (shared templates)

Skills and rules that every group or objective should have live in the
`carapa-agent-kit` repository: `platform/` for all agents, `group/` for project
groups and `objective/` for CarapaBrain objectives. Propose a change with the
`propose_changes` tool (layer `platform`, `group_template` or `objective_template`)
and approve it in chat; Board then commits it to the kit. Approval refuses and
rolls back a promotion if any written file cannot be staged (for example,
because it is gitignored). Agents receive it after the next `scripts/install.sh`
run from the kit. Skill proposal file paths are
relative, at most 6 segments; each segment starts with a letter, digit or `_` (so
`__init__.py` works); `..`, absolute paths and hidden (dot) names are rejected.

### To project repos

Project rules live in the repo's `.agent/rules/` directory. Update them via normal code changes (commits, PRs). Task agents pick up changes on next run since they get a fresh repo mount.

### To box defaults

Box-level rules require updating the box configuration (`config/stacks/<stack>/home/.agent/rules/`). Changes take effect on next container start.

---

## Memory vs Rules

Both persist knowledge, but serve different purposes:

|                 | Rules                                                                        | Memories (DB)                      |
| --------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| **Storage**     | Filesystem (`.md` files)                                                     | DB via `memorize` MCP tool         |
| **Loaded**      | `always_on` rules on agent start; others on demand from a listed description | On-demand via `recall` MCP tool    |
| **Scope**       | Layer-dependent (box/group/project/objective)                                | Group-scoped (main: owner's reach) |
| **Best for**    | Stable conventions, domain knowledge, workflows                              | Facts, decisions, contacts, events |
| **Editable by** | Humans and agents (file writes)                                              | Agents via MCP tools               |
| **Persistence** | Survives container restarts                                                  | Survives container restarts        |

Use `always_on` rules for things that should **always** be in context. Use memories for things that should be **searchable** when needed.
A lesson may live in both places: a rule loads only in its own scope, while the main agent and child-project agents can recall shared memory, so adding a rule is no reason to invalidate a memory that states the same lesson.

---

## AGENTS.md

Each group has an `AGENTS.md` file (`groups/<group_folder>/AGENTS.md`) that serves as a persistent memory file for the group. This is loaded alongside rules but is typically edited by agents to track project state, decisions, and context that evolves over time. `CLAUDE.md` and `GEMINI.md` are symlinks to `AGENTS.md` for agent compatibility. The board maintains these links (and the `.claude/rules` and `.gemini/rules` links to `.agent/rules`) only inside the project folder: it never follows a link out of it, and it refuses a `.agent`, `.claude` or `.gemini` entry that is a symlink.

The global `AGENTS.md` at the repository root provides project-wide context (tech stack, setup commands, architecture overview) and is visible to project task agents.
