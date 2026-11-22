# Agent runtimes, persistent scopes, and workspaces

CarapaBoard coordinates several kinds of LLM work. Three independent choices
determine what an invocation knows and can do:

1. **Runtime** — DirectLLM or a CLI agent.
2. **Persistent scope** — a group folder or an objective folder.
3. **Execution workspace** — the repository mounted by CarapaBox.

Do not infer one choice from another. A project can have a repository and still
use DirectLLM. An objective folder can hold the durable context for a run while
the owning project's repository remains available through sandbox-backed
tools. Runtime selection controls how the model is invoked; it does not change
which project or objective owns the conversation and memory.

## The three axes

```text
Persistent scope                    Runtime                         Execution workspace

groups/<project>/              ┌── DirectLLM in CarapaBoard ───┐
  transcripts, rules, memory ──┤                               ├── read-only fs tools ──┐
  objectives/<objective>/      └── CLI via run-agent.sh ───────┘                        │
       state, reports, rules                    │                                       ▼
                                                └──────────────▶ CarapaBox sandbox ──▶ mounted repo
                                                                     CLI CWD
```

- The **persistent scope** supplies identity, transcripts, rules, memories,
  objective state, and artifacts.
- The **runtime** determines whether CarapaBoard calls an HTTP-compatible model
  directly or launches a CLI harness through `run-agent.sh`.
- The **execution workspace** is the project repository as mounted inside the
  effective CarapaBox sandbox. It supplies code and the hard filesystem
  security boundary.

DirectLLM has no process CWD. CarapaBoard assembles its system context from the
group and, when applicable, objective scope. If it calls `ripgrep`,
`read_file`, or `peek_files`, CarapaBoard dispatches that operation to the
project’s effective sandbox and restricts it to the configured workspace
roots. The model receives the tool result; the DirectLLM client itself does not
move into the sandbox.

A DirectLLM chat run makes at most 100 tool rounds (20 for memory reflection,
which fails at its limit). When a chat run reaches the limit, CarapaBoard sends
one more request with `tool_choice: 'none'` asking for a plain-text account of
what was found and what is missing; any tool calls it returns are not executed.
If that request returns no text or fails, the run ends with a visible
"Stopped after N tool rounds…" notice that quotes the start of the last tool
result.

A tool call repeated with the exact same arguments and the exact same result
is not executed a fourth time in a row: the model instead receives a
"Not executed" tool output, and if it asks for the same call again the run ends
with the same no-tools final answer as at the turn limit. Memory-reflection
runs are excluded from this guard.

## Chat mode versus Work mode (Kanban)

Chat and Work are two CarapaBoard execution surfaces. They do not name a model
runtime: Chat can use either DirectLLM or a CLI harness, while every executable
Kanban stage uses a CLI harness in a CarapaBox sandbox.

### Chat mode

An interactive conversation enters through `src/agent-runner.ts`:

1. CarapaBoard resolves the conversation's configured agent binding.
2. A DirectLLM binding is called by the CarapaBoard process. No CLI process is
   spawned and there is no CLI CWD.
3. A CLI binding calls `runContainerAgent()`. The sandbox runner writes
   `args.json` and `prompt.txt` beneath the run's IPC directory, then asks
   CarapaBox to execute `run-agent.sh <run-directory>` inside the effective
   sandbox. `run-agent.sh` starts the selected harness (`claude`, `codex`,
   `pi`, and so on).

   When the user's own chat message (after removing `[CONTEXT_SUMMARY:…]` and
   the group trigger) starts with a slash command such as `/goal tests pass`,
   the runner also writes that trimmed raw text to an optional
   `user-command.txt` beside `prompt.txt`. `prompt.txt` is unchanged. No file
   is written for task or stage runs, scheduled or objective runs, DirectLLM
   runs, commands the Board intercepts itself (DirectLLM `/reflect`), or messages that
   do not start with a command. The file only exposes the command: the
   CarapaBox runtime decides which commands, if any, it forwards to the
   harness as a real slash command, and a runtime that does not know the file
   ignores it.

The CLI chat CWD is resolved per conversation:

- Without a chat worktree, it is the effective container workspace root.
- With `use_worktree`, it is `.worktrees/<selected-branch>` or the generated
  `.worktrees/chat-<conversation-id>` beneath that workspace. When the
  project has no explicit Workspace Path (and the sandbox is neither shared nor
  inherited), the worktree path follows the stack service's working directory
  instead of the conventional `/workspace/<folder>` root, which need not exist
  in custom stacks. The conversation Browser uses the same worktree.
- An explicit `work_dir`, used by scoped callers such as objective work, is
  resolved beneath the effective workspace for standalone sandboxes and
  beneath the inherited workspace root for shared sandboxes.

Chat sessions are conversation-scoped. Eligible Claude and Codex chat bindings
may keep a warm harness process, but every cold start still follows the same
`run-agent.sh` path.

### Work mode (Kanban)

Moving or executing a card in an executable stage enters through
`src/modules/kanban/task-executor.ts` and the task pipeline:

1. The stage resolves its worker harness, model, prompt, and sandbox settings.
2. The pipeline calls `runContainerAgent()` with the task and stage identity.
3. The sandbox runner creates or reuses the task worktree when the project's
   `taskCheckoutMode` is `worktree`.
4. As in CLI chat, it writes a run-specific IPC payload and asks CarapaBox to
   execute `run-agent.sh <run-directory>` inside the sandbox.

The Kanban CLI CWD is the task's `.worktrees/<task-branch>` when branch-per-task
execution is enabled; otherwise it is the effective workspace root/shared
checkout. Each executable stage is a separately tracked agent invocation.
Active/coding stages may use an eligible warm process. Testing and Review use
fresh isolated processes, except for a same-stage format-repair continuation.

The group folder remains separately mounted as project context (normally
`/workspace/group`); it is not automatically the CLI CWD when a repository or
worktree is selected. Agent processes live in the sandbox and are independent
of the CarapaBoard and CarapaBox service processes after launch.

| Surface           | Entry point                                              | CLI spawned? | Normal execution location                                                |
| ----------------- | -------------------------------------------------------- | ------------ | ------------------------------------------------------------------------ |
| Chat + DirectLLM  | `src/agent-runner.ts`                                    | No           | CarapaBoard process; repository access only through sandbox-backed tools |
| Chat + CLI        | `src/agent-runner.ts` → sandbox runner → `run-agent.sh`  | Yes          | Effective workspace root or conversation worktree                        |
| Work/Kanban stage | task executor/pipeline → sandbox runner → `run-agent.sh` | Yes          | Effective workspace root or task worktree                                |

### Task worktree binding across restarts

In `worktree` checkout mode a task owns the branch `branch_name` and its
`.worktrees/<branch>` folder. The startup sweep (`sweepOrphanedWorktrees()`)
clears the stored `worktree_path` only for tasks that are not running and sit in
a done-type stage. Cards in executable stages (pending re-execution), cards
parked in queue stages (Question, Backlog, Failed) and A/B experiment variants
keep their binding, because their branch is unmerged and the folder is retained
on purpose.

The Changes tab's default-branch integration (status, update from the default
branch) needs only the task branch and its `.worktrees/<branch>` folder, not
`worktree_path`. If the folder is missing, it reports "Task worktree is
missing…"; a task without a branch reports "The task has no branch."

## Components and access

| Component                                 | Runtime location                                                  | Persistent scope                      | Repository access                                                                            | Mutation authority                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| DirectLLM chat                            | CarapaBoard process; HTTP-compatible model API                    | Group or objective conversation       | Read-only through permitted sandbox-backed filesystem tools                                  | Only through explicitly permitted board tools                                                                      |
| CLI chat agent                            | CLI launched by `run-agent.sh` inside the CarapaBox sandbox       | Group or objective conversation       | Mounted repository or conversation worktree is the CLI CWD                                   | May edit the mounted workspace and use the CLI's sandbox tools                                                     |
| Kanban stage agent                        | CLI launched by `run-agent.sh` inside the CarapaBox sandbox       | Task and stage                        | Mounted repository or task worktree is the CLI CWD                                           | May edit the mounted workspace and use the CLI's sandbox tools                                                     |
| DirectLLM filesystem tools                | `fs-tool.sh` commands executed in the effective CarapaBox sandbox | Authorized project from the tool call | Read-only within the primary and configured extra workspace roots                            | None                                                                                                               |
| Board memory reflector                    | Direct runtime selected by `defaults.reflector`                   | Group owning the source transcript    | May inspect repository files read-only to verify a material project claim                    | Returns a validated envelope; CarapaBoard is the only memory writer                                                |
| CarapaBrain assessment                    | CLI launched by CarapaBrain through `run-agent.sh`                | One objective folder                  | Not implied by the objective path; use project tools or tasks when repository work is needed | Writes objective state, reports, dashboards, and may manage board tasks through MCP                                |
| Brain curator and Brain session reflector | Direct OpenAI-compatible calls from the CarapaBrain service       | One objective folder                  | No implicit repository CWD                                                                   | The Brain curator produces a context brief; the Brain session reflector only condenses objective-local reflections |

Tool visibility still depends on project permissions, enabled toolsets, and a
valid sandbox configuration. A DirectLLM binding does not automatically make
every board tool available.

## Choosing a runtime

Choose by the capabilities required for the work, not by whether the project
has a repository.

| Work                                                                  | Preferred runtime                              |
| --------------------------------------------------------------------- | ---------------------------------------------- |
| Conversation, planning, classification, or memory processing          | DirectLLM                                      |
| Small read-only repository search or file lookup                      | DirectLLM with sandbox-backed filesystem tools |
| File edits, shell commands, tests, builds, Git, or browser automation | CLI agent through `run-agent.sh`               |
| Long or complex repository investigation                              | CLI agent, optionally delegated from DirectLLM |

A project without a repository will usually use DirectLLM more often, but it
can still use a CLI harness when its task needs the harness's tools. Conversely,
a repository-backed project can use DirectLLM for fast chat and read-only code
inspection.

## Board memory reflector source profiles

The Board memory reflector always uses the base prompt `prompts/tool-reflector.md`.
CarapaBoard appends one editable source profile according to the meaning of the
reflected transcript:

| Observed source                    | Editable profile                                        |
| ---------------------------------- | ------------------------------------------------------- |
| Interactive DirectLLM conversation | `prompts/reflector-profiles/direct-llm-conversation.md` |
| Interactive CLI conversation       | `prompts/reflector-profiles/run-agent-conversation.md`  |
| Autonomous Kanban task run         | `prompts/reflector-profiles/kanban-task.md`             |

The profiles interpret evidence; they do not redefine what is valuable. Direct
and CLI conversations use the same admission threshold, while the CLI profile
filters operational transcript noise. The Kanban profile treats the task
description as a work order rather than a statement of user preferences and
focuses on durable outcomes, reusable constraints, and unresolved follow-up.

Profile selection describes the source transcript, not the runtime selected by
`defaults.reflector`. The reflector itself remains a board-managed DirectLLM call.
Repository rule files remain execution instructions and are not loaded as
reflector instructions.

## Path vocabulary

Use the following terms consistently in documentation and logs:

| Term                     | Example                                                                           | Meaning                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Group folder             | `groups/demo-site/` on the board host; `/workspace/group` in a standalone sandbox | Persistent project data such as transcripts, rules, reflections, and artifacts                                                                        |
| Objective folder         | `groups/demo-site/objectives/obj-123/` or `/workspace/group/objectives/obj-123`   | Persistent state and instructions for one objective                                                                                                   |
| Host repository location | `group.settings.repositoryLocation`, for example `/home/user/src/demo-site`       | Host-side bind-mount source supplied to CarapaBox; never a usable container path                                                                      |
| Container workspace root | `/workspace/demo-site`, `/workspace`, or a configured absolute `workspacePath`    | Repository path inside the effective sandbox and the normal CLI CWD                                                                                   |
| Extra workspace root     | An absolute path from `workspaceRoots`                                            | Extra sandbox path for read-only filesystem tools and, as a read-only section, the chat Files tab; a board admin sets it; a trailing slash is ignored |

For a shared parent-owned sandbox, child projects may resolve beneath the
parent container root, for example `/workspace/<child>`. Always use the
effective sandbox settings rather than constructing a container path from the
host repository location. A trailing slash in `workspacePath` is normalized
when computing the container workspace root.

## Which reflector?

CarapaBoard and CarapaBrain have separate components historically called a
"reflector":

- The **Board memory reflector** reconciles conversation-derived observations
  with group-scoped structured memory. Its LLM receives read-only inspection
  tools, returns a validated memory-operation envelope, and never writes the
  database or files directly.
- The **Brain session reflector** condenses `session-reflections.md` inside one
  objective folder when it exceeds its configured threshold. It is part of the
  objective-agent feedback loop and does not reconcile CarapaBoard's structured
  memory.

Qualify the name in documentation, logs, and architecture discussions whenever
the surrounding subsystem is not already unambiguous.

## Related documentation

- [Agent configuration](AGENTS-CONFIG.md) — Direct and CLI harness bindings and defaults.
- [Rules and memory](RULES.md) — persistent rule layers.
- [System specification](SPEC.md) — overall CarapaBoard architecture.
- [SMART objectives](OBJECTIVES.md) — CarapaBrain integration and objective folders.
