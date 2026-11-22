# SMART Objectives & CarapaBrain Integration

## Overview

CarapaBoard supports SMART objectives — goal-level entities that sit above kanban tasks. Objectives are tracked and assessed by **CarapaBrain**, a persistent external service that receives events from the board, processes objectives, manages tasks, and generates dashboard pages.

Objectives are per-project. Any project (including the main group) can have objectives.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CarapaBoard                                                    │
│  • objectives table (PostgreSQL/PGlite) — CRUD + API + MCP tools │
│  • objective folders (create, serve static dashboards)          │
│  • event publisher → POST events to brain REST API              │
│  • objectives UI mode (iframe dashboard + chat)                 │
│  • objective chat (reuse chat component with objective_id)      │
└──────────────────┬──────────────────────────────────────────────┘
                   │ REST API (bearer token auth)
                   │ POST /events, GET /health
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  CarapaBrain (persistent container, same Docker network)        │
│  • Receives events from board                                   │
│  • In-memory priority queue (disk-persisted)                    │
│  • Event subscription engine (cron, task events, objective      │
│    events, manual triggers)                                     │
│  • LLM-powered objective assessment loop                        │
│  • Generates static HTML dashboards per objective               │
│  • Creates/updates/closes kanban tasks via board MCP tools      │
│  • Interactive SMART objective setup skill                      │
└──────────────────┬──────────────────────────────────────────────┘
                   │ reads/writes
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  Shared Filesystem (mounted volumes)                            │
│  groups/{project_id}/objectives/{objective_id}/                   │
└─────────────────────────────────────────────────────────────────┘
```

### Communication Flow

| Direction          | Method                    | Purpose                                               |
| ------------------ | ------------------------- | ----------------------------------------------------- |
| Board → Brain      | REST API (`POST /events`) | Push events (task completed, user message, webhook)   |
| Brain → Board      | MCP tools                 | Create/update tasks, send messages, update objectives |
| Brain → Filesystem | Direct write              | Reports, dashboards, state, event logs                |
| Board → UI         | Serve static files        | Iframe brain-generated dashboards                     |
| Board ↔ UI         | REST + WebSocket          | Objective CRUD, chat messages, real-time updates      |

### Key Design Decisions

- **Brain is an active agent**, not a passive observer. It creates and manages kanban tasks as part of objective processing.
- **No shared database.** Board owns the DB; brain communicates via REST API and MCP tools.
- **Dashboards are static HTML.** Brain generates them; board serves them via iframe. Zero rendering logic on the board side.
- **Event-driven, not polling.** Brain reacts to events from the board. Cron triggers are the exception (internal to brain).

---

## Data Model

### Database Table: `objectives`

```sql
CREATE TABLE objectives (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft', -- draft | active | achieved | failed | paused
  priority INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,                      -- ISO timestamp
  progress INTEGER NOT NULL DEFAULT 0, -- 0-100
  specific TEXT,                      -- SMART: what exactly
  measurable TEXT,                    -- SMART: metrics + target (JSON)
  achievable TEXT,                    -- SMART: rationale
  relevant TEXT,                      -- SMART: link to broader goal
  time_bound TEXT,                    -- SMART: deadline + milestones (JSON)
  trigger_config TEXT,                -- JSON: event subscriptions for brain
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT,
  event_runtime_selection JSONB,      -- runtime override for event-triggered runs
  work_dir TEXT,                      -- agent working directory of the objective
  cost_limit_usd REAL,                -- NULL or >= 0
  move_source_project TEXT            -- set while a move to another project is unfinished
);
```

### Objective Folder Structure

Created at `groups/{project_id}/objectives/{objective_id}/`:

```
├── .agent/rules/                     ← written by brain setup skill
│   ├── objective-definition.md       ← full SMART breakdown
│   ├── assessment-prompt.md          ← LLM assessment instructions
├── triggers.json                     ← event subscription config
├── .claude/rules/                    ← symlink to ../.agent/rules/ (compat)
├── reports/                          ← timestamped assessment reports
│   └── 2026-03-12T09-00-00.md
├── assets/                           ← user/agent uploaded files
├── dashboard/
│   ├── index.html                    ← brain-generated static page
│   └── styles.css                    ← shared styles (symlinked)
├── transcripts/                      ← legacy chat summaries; read-only migration input
│   └── {conversation_id}.jsonl
├── events.jsonl                      ← append-only event log
├── board-cost-metrics.json           ← Board-owned derived cost accounting
├── board-cost-report.json            ← Board-owned windowed cost report
├── board-brain-state-events.json     ← Board-owned durable state-event outbox
└── state.json                        ← Brain-owned status, progress, and runtime state
```

Events the brain handles itself carry `skipped: true` in `events.jsonl` and may add an optional `skipReason` string. The Events tab shows it (cut at 200 characters) as the "No run" reason, falling back to a generic text when it is absent or not a non-empty string.

`.agent/rules/` is the canonical rules directory. `.claude/rules/` and `.gemini/rules/` are symlinks to it for agent compatibility.

The board writes `.claude/rules/objective-context.md`. It follows only its own `.claude -> .agent` link and refuses links that leave the objective folder.

CarapaBrain is the only process that writes `state.json`. Board status and
runtime changes reach Brain through `objective_updated` events; Board never
merges its own snapshot into that file. This ownership boundary prevents an
atomic rename by either service from discarding fields written concurrently by
the other. State-affecting events remain in the Board outbox until Brain
acknowledges them and are retried after Board or Brain availability changes.
Permanently rejected events are dropped with a log; authentication failures
remain queued. The outbox retains at most 500 replayed task events per
objective, dropping the oldest task events first, never state events. The
serialized outbox also has an 8 MiB limit; if state events alone fill it,
enqueue failures are logged.

---

Interactive objective chats use the same conversation handler, execution runner,
queue admission, stop logic, and transcript store as project chats. Objective
scope supplies ownership checks, the objective working directory and rules,
Brain events, and objective cost accounting. Autonomous Brain assessments retain
their separate event-driven lifecycle.

Objective cost limits are independent of the per-task cost limit applied to
individual Kanban cards; see the per-task cost limit in
[SPEC.md](SPEC.md#task-execution-pipeline). Activating an objective (REST or
MCP `update_objective`) is refused while its cost limit is reached.

Whenever the Board refreshes an objective's cost metrics it also writes
`board-cost-report.json`, a derived windowed report that dashboards can read
instead of re-parsing session logs. It has rolling `1d`/`7d`/`30d`/`all`
windows (total, runs, `byGroup` and `byCategory` USD, and the Brain cache-hit
ratio), plus zero-filled `daily` (last 14 UTC days) and `hourly` (last 24 UTC
hours) series. Costs fall in three groups: `trigger` (`run-stats.jsonl` lines,
category `trigger:<triggerType>`), `chat` (priced objective chat transcript
entries, priced by `model_pricing.jsonc`; the retained pre-Board cost appears
only in `all` as `chat:historical`) and `kanban` (`active_runs` costs of linked
tasks, category `kanban:<project>`). Items without a parseable timestamp count
only in `all`. `windows.all.totalUsd` equals `totalCostUsd` in
`board-cost-metrics.json`; a failure to write the report never affects cost
accounting or limits. A forked objective chat counts only the turns
after its fork point, not the parent turns its transcript inherited.

The canonical chat history for both scopes is
`groups/<parent>/<project>/transcripts/<date>-chat-<conversation_id>.output.jsonl`
(the parent directory is omitted for top-level projects). All application reads,
writes, forks, and archives use that common history directly. Objective HTTP and
WebSocket routes supply scope and presentation metadata.

---

## REST API Endpoints

### Objectives CRUD

| Method | Route                                     | Description                                                                   |
| ------ | ----------------------------------------- | ----------------------------------------------------------------------------- |
| POST   | `/api/projects/:pid/objectives`           | Create objective                                                              |
| GET    | `/api/projects/:pid/objectives`           | List objectives                                                               |
| GET    | `/api/projects/:pid/objectives/:oid`      | Get objective details                                                         |
| PUT    | `/api/projects/:pid/objectives/:oid`      | Update objective                                                              |
| DELETE | `/api/projects/:pid/objectives/:oid`      | Delete objective + cleanup folder                                             |
| POST   | `/api/projects/:pid/objectives/:oid/move` | Move to another project (body `{ target_project }`), keeping the objective ID |

### Moving an objective

`POST /api/projects/:pid/objectives/:oid/move` and the `move_objective` MCP tool
move an objective to another project. The caller needs write access to both
projects (humans: owner or editor, or admin; agents: `objectives:write` on both)
or the call fails with 403.

A move is refused, and nothing changes, when the target project is missing or
equals the source, the objective is `active`, a brain run, an objective chat run or
a run of a task tagged with the objective is active, a cronjob or dataset task (archived ones too) still references the
objective (their IDs are listed in the error), the objective has no folder in
the source project (its setup never finished), or the target already has a
folder for the objective.

In one database transaction the objective's `project_id` is set to the target
and `work_dir` is recomputed. All of its memory versions (superseded and
invalidated ones included) get the target `group_folder`, as do their
transcript-evidence and evidence-certificate rows. Memory IDs, `objective_id`,
`valid_from` and other timestamps stay unchanged. Both projects' memory
lifecycle locks are held (sorted folder order), and the move aborts if either
privacy epoch changes. History-apply receipts (`memory_history_apply_operations`)
stay with the source project: they belong to a project-level History Review
manifest and have no memory or objective link, and the manifest's resume check
requires all of its receipts to carry the applying project.

After the commit the Neo4j Memory/Entity nodes of those memories are re-homed,
the objective folder is moved to the target project (rename, or copy plus remove)
and its board-owned `.claude/rules/objective-context.md` is rewritten with the
new Project ID. Other files, including the brain's `state.json`, are untouched.
The response is
`{ objective, movedMemories, vectorStoreUpdated, folderMoved, contextUpdated, notified, movedConversations, skippedTranscripts, conversationStepComplete }`.
`vectorStoreUpdated: false` means the vector store was configured but failed or
was unreachable; `contextUpdated: false` means the context file rewrite failed
or was refused; `notified` is the outcome of publishing `objective_created`
(`delivered`, `queued` for durable replay, `skipped` when the brain is not
configured, or `failed`, which keeps the move open for a retry). The status, run and schedule-reference checks are repeated
inside the transaction under a `FOR UPDATE` lock on the objective row. The
writers that attach work to an objective (creating or re-pointing a cronjob or
dataset task, and starting a chat run or a task run tagged with the objective) take a `FOR SHARE` lock
on the same row, so none of them can interleave with a move. Cronjob and dataset
task writers also check the objective still belongs to their project. A
conversation still outside the objective's project (not yet backfilled) is not
continued: running it fails with an error that names the objective's new project.
A `memorize` that waited on the source
project's memory lifecycle lock re-checks the objective's owner once it holds
the lock, so a memory cannot land in the source project after the move. The
vector-store write that follows an embedding takes the same lock and re-reads
the memory first, so an embedding that was in flight during a move is dropped
instead of restoring the source project's scope in Neo4j.

The folder copy fallback (used when rename fails, e.g. across filesystems) copies
to `<target>.moving-in`, hides the source as `<source>.moving-out`, renames the
copy into place and only then deletes the hidden source. A failed step leaves
the source intact; a leftover `.moving-out` folder is removed on the next call.
If the process dies after hiding the source but before the copy is renamed into
place, the next call finishes that rename (or restores the source when no copy
exists).
A folder that exists in both projects is never overwritten or merged. A
`.moving-out` folder that could not be removed counts as an unfinished folder
step: `move_source_project` stays set and each retry tries the removal again.
While it is set, an objective run (chat or tagged task) in the target project is
refused with a "still being moved" error, both when the run is inserted and when
the folder would be initialised, so nothing starts ahead of the move.
`folderMoved` is true only when the folder is in place and nothing of it is left
in the source.
An objective edit or budget pause rewrites the objective-context file while
`move_source_project` is set only once the folder is in place in the target; before
that the move writes the file itself. Deleting an objective archives and removes
everything an unfinished move left: the target folder and a partial
`<target>/<id>.moving-in`, and the source folder and `<source>/<id>.moving-out`.
Each copy is archived to its own folder under `store/objectives/`
(`<id>`, `<id>.moving-in`, `<id>.from-<source>`, `<id>.moving-out-from-<source>`),
so none overwrites another.

The move records the project it started from in `objectives.move_source_project`
and clears it once every later step has finished: the Neo4j update, the
conversation move, the folder move, the context rewrite and the `objective_created` event. While it is set,
repeating the same request (same `objective_id` and `target_project`, for REST
the original `:pid`) completes the remaining steps; the stored source is also
what the caller is authorized against (`objectives:write` on it and on the
target). The context file is rewritten after the folder move and before the
event, so the target brain never reads a folder that still names the source. A
step that keeps failing leaves the marker set and the event is republished by
each retry. With the marker clear, a repeated call (including the original REST request) changes nothing. A move to a
third project is refused while the marker is set.

Conversations move along. Every chat with the objective's `objective_id` that
is not in the target project gets the target `group_folder`, so it shows up in
the target's objective chat list and opens with its full transcript. Per chat
(a failure is logged and never fails the whole move): the live
`chat-<id>.output.jsonl` and its `.transcript-index.json` sidecar are moved to
the target `transcripts/` dir (under the transcript locks); a chat with no live
file gets its transcript restored into the target `transcripts/` dir from the
source project's `transcripts/archive/*.tar.gz` bundles with the regular
archive-restore code. The source bundles are never touched. A transcript that
already exists in the target wins and is never overwritten. A chat whose
transcript is missing everywhere, or could not be moved, is still re-homed
and counted in `skippedTranscripts`. The response adds
`movedConversations`, `skippedTranscripts` and `conversationStepComplete`;
`conversationStepComplete: false` (a chat could not be listed or re-homed) keeps
`move_source_project` set, and a repeated call retries.

Backfill: calling the move for an objective that already sits in the target
(marker clear) moves chats of the objective still left in other projects, for
example from a move made before conversations followed. The caller also needs
write access to each of those projects (403 otherwise, nothing changes), and the
call is refused with 409 while one of those chats has a run in progress. When
no such chat remains, the call is a no-op.

Stays behind in the source project: proposals, notifications, dashboards,
harness session files and run/cost records. Tasks need no change (their
`objective_id` may already point at another project). The source project's brain
keeps the now-paused objective registered until it restarts.

### Objective Chat

An objective chat is a normal chat: it uses the regular conversation routes and
differs only by its `objective_id` and its working folder
(`groups/<project>/objectives/<oid>`). There are no `/objectives/:oid/messages`
or `/objectives/:oid/conversations` routes.

The objective page labels its chat column "Objective chat" ("New objective chat" before the first message) so users can tell the chat runs in the objective folder. The objective title and status appear once, in the objective bar. An empty new objective chat shows the project's starter prompts like a normal chat.

| Method | Route                                                               | Objective use                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/projects/:pid/conversations`                                  | `?objective_id=<oid>` lists that objective's chats (project chats exclude them)                                                                                                            |
| POST   | `/api/projects/:pid/conversations`                                  | Body `objective_id` creates an objective chat; the objective must belong to `:pid`                                                                                                         |
| POST   | `/api/projects/:pid/messages`                                       | Send a message. An existing conversation's `objective_id` selects the objective (brain event, cost); a new one takes body `objective_id`. Signed-in users only; agent credentials get 403. |
| POST   | `/api/projects/:pid/conversations/mark-all-read`                    | Body `objective_id` scopes it to one objective                                                                                                                                             |
| POST   | `/api/projects/:pid/conversations/:cid/{read,resolve-pending,fork}` | Work unchanged; a fork keeps the `objective_id`; fork needs explicit project owner/editor or admin                                                                                         |
| PATCH  | `/api/projects/:pid/conversations/:cid`                             | Rename / pin                                                                                                                                                                               |
| DELETE | `/api/projects/:pid/conversations/:cid`                             | Delete                                                                                                                                                                                     |

Sending publishes the `objective_message` brain event and, on completion,
refreshes the objective's cost and run statistics.

An agent can open or continue an objective chat with
`ask_project_agent({ project_id, objective_id })` (add `conversation_id` to
continue; add `runtime_selection` to pick the harness and model of a new chat; `use_worktree` is refused, as objective chats never run in a worktree). The turn runs as a board-run chat turn like a human message, but
does not publish `objective_message`, so no brain chat session is left open.

### Objective Dashboard

| Method | Route                                            | Description                              |
| ------ | ------------------------------------------------ | ---------------------------------------- |
| GET    | `/api/projects/:pid/objectives/:oid/dashboard/*` | Serve static files from dashboard folder |

---

## MCP Tools

Defined in `src/modules/objectives/tools.ts` and registered by the objectives module:

- **create_objective** — create a new objective in a project
- **update_objective** — update objective fields (status, progress, etc.)
- **list_objectives** — list objectives for a project
- **get_objective** — get objective details
- **delete_objective** — delete objective and cleanup folder
- **move_objective** — move an objective, its memories and folder to another project (see [Moving an objective](#moving-an-objective))
- **ack_objective_task_event** — the brain reports that the run handling a `task_failed` / `task_question` event ended (`group_folder`, `objective_id`, `task_id`, `event_type`, optional `event_timestamp`, `outcome`: `handled` | `failed` | `skipped`); settles the held notification (see [Held notifications](#held-failed-and-question-notifications)). Needs `objectives:write` on the objective's project; task-run tokens are refused, and an ack without a matching hold is a no-op

Authorization follows the same model as tasks:

- Same-project: always allowed
- Parent → child: allowed if parent has `isParent: true`
- Main group: can access all projects
- `move_objective` needs `objectives:write` on both the source and the target project

An objective's runtime is the optional `eventRuntimeSelection`. When it is
null or omitted, the objective inherits the same effective runtime as the
project's Kanban tasks: structured project `kanbanRuntimeSelection`, then the
configured global Kanban fallback. Board resolves that runtime at event time
and does not persist it in the objective; CarapaBrain's process-level default
is not used. The legacy `agent_cmd`/`agent_model` request fields are rejected.

Events the brain originates (cron, startup, self-reminder) never pass through
Board, so the brain reads the runtime from
`GET /projects/:pid/objectives/:oid/runtime-tiers`: `effective` is exactly what
Board attaches to that objective's events, and `tiers.fast|balanced|frontier`
are the runtimes the objective's Auto tier map resolves to (harness, model,
reasoning, session key and env always come from one resolved runtime, so a
trigger can name a tier instead of a model id). See
`src/modules/objectives/README.md` for the response shape.

Runs without an objective use `GET /projects/:pid/runtime-tiers[?harness=<id>]` for the same response shape (see `docs/AGENTS-CONFIG.md`).

---

## Event Publishing

Board publishes events to brain's REST API on key actions. Implementation in `src/modules/objectives/brain-client.ts`.

### Event Types

| Event               | Trigger Point                                                                                                     | Payload                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `task_completed`    | Task moves to done stage                                                                                          | `{ project_id, task_id, title, output }`                                                        |
| `task_failed`       | An objective-owned task execution/deploy fails or the task enters Failed                                          | `{ project_id, task_id, objective_id, status?, title?, source?, error? }`                       |
| `task_question`     | An objective-owned task enters the Question/attention-required stage                                              | `{ project_id, task_id, objective_id, status, title, source, reason? }`                         |
| `objective_message` | User sends message in objective chat                                                                              | `{ project_id, objective_id, content }`                                                         |
| `objective_created` | New objective created, or moved into this project                                                                 | `{ project_id, objective_id, title }`                                                           |
| `objective_updated` | Objective metadata changed                                                                                        | `{ project_id, objective_id, changes }`                                                         |
| `agent_answer`      | The agent asked via `ask_project_agent` with `reply_to_objective_id` and no caller conversation finished its turn | `{ project_id, objective_id, ask_id, target_project_id, conversation_id, status, answer, url }` |

`agent_answer` carries the full text of the asked project agent's last reply (`status` is `answered`, `failed` or `needs_input`; `url` opens the asked conversation). It is published once per ask and never retried. CarapaBrain must accept the type: it currently rejects unknown event types with HTTP 400, which the board treats as permanent, so the event is dropped (and logged) until it does.

A move publishes `objective_created` for the target project, so the target
sandbox's brain registers the objective, and broadcasts the WebSocket
`objective_updated` event for both projects.

### Event Payload Format

```json
{
  "type": "task_completed",
  "project_id": "carapa-board",
  "task_id": "task-xxx",
  "objective_id": null,
  "timestamp": "2026-03-12T09:00:00.000Z",
  "data": {}
}
```

### `task_question` semantics

`task_question` is published only for a real transition from a non-Question
stage into the configured Question stage. Updating a task that is already in
Question does not publish a duplicate. The transition may originate from the
`update_task` agent tool, a manual API/UI update, a bulk update, a no-progress
review pause, or an unresolved merge conflict.

A no-progress review pause parks the card in Question when configured (otherwise
Backlog, then the first queue stage) and publishes the event for the parked
card. Publication does not depend on the recovery hook: it is still published
when the automatic-recovery budget suppressed the hook run (see
[Failure, review pause and recovery stages](SPEC.md#failure-review-pause-and-recovery-stages)).

In a project without an active Question stage, the needs-input fallback stage
(`getTestingBlockedStage`: an active Backlog stage, else the first queue stage)
stands in for it, so a blocked card still reaches its objective. The event is
published when the card's own run moves it from an executable stage into that
fallback (`update_task` or the stage handoff at the end of the run) and when a
blocked Testing outcome parks it there. The own-run decision is made when
`update_task` is called and stored on the durable handoff request, so a restart
before finalization still publishes; a handoff record without it publishes
nothing. Moves by other agents, humans, the API, bulk updates and the system do
not publish, and neither does a queue-to-queue move. An agent move into a
fallback that is a Failed stage publishes only `task_failed`. An own-run move into the
fallback for another reason (such as a deferral) also publishes; the objective
acknowledges it. Projects with a Question stage are unchanged.

The task must have a persisted, non-empty `objective_id`; unowned tasks do not
produce objective events. The event is routed directly to that objective and is
not inferred from `project_id`.

```json
{
  "type": "task_question",
  "project_id": "qes",
  "task_id": "task-123",
  "objective_id": "obj-123",
  "timestamp": "2026-07-25T13:30:00.000Z",
  "data": {
    "status": "question",
    "title": "Validate signing flow",
    "source": "agent_update",
    "reason": "Optional detail for review or merge-conflict pauses"
  }
}
```

`source` is one of `agent_update`, `manual_update`, `bulk_update`,
`testing_blocked`, `review_no_progress`, or `merge_conflict`. Historical Question transitions are
not replayed after deployment.

When an agent moves an objective-tagged task into Question
(`update_task`, or the stage handoff at the end of a run), the board does not
notify the user right away. It holds the "Task needs your attention" entry and
phone push while the objective handles the event; see
[Held notifications](#held-failed-and-question-notifications).
The handoff event is still published once after a board restart that
interrupts it.
Once the task leaves Question or Failed (or the queue stage a project without
them parks blocked and failed tasks in), any unread "needs your attention" or
failure entry for it is acknowledged, so it no longer shows in Now or the bell.
An entry that is stored after the task has left (a held or late delivery) is
hidden the same way. A later return to Question or Failed sends a fresh one.

### `task_failed` semantics

`task_failed` uses the same direct ownership rule. Execution and deployment
failures publish it with their error details. Explicit transitions into Failed
through `update_task`, manual UI/API updates, or bulk updates publish it with a
`source` of `agent_update`, `manual_update`, or `bulk_update`. Updating a task
already in Failed does not emit a duplicate. Untagged tasks do not produce an
objective event, and historical Failed transitions are not replayed.

An agent-requested move into Failed is held the same way as Question.

### Held failed and question notifications

For an objective-tagged task, the "failed" and "needs input" notification
(in-app Replies entry and phone push) waits for the objective's agent, because
the objective may already resolve the task. Every site that publishes a
`task_failed` / `task_question` brain event holds its notification:

- agent stage moves into Question or Failed (`update_task`, the stage handoff
  at the end of a run), and the card's own run moving into the fallback stage
  of a project without a Question stage;
- manual and bulk moves into Failed through the API (manual moves into Question
  never notify);
- execution failures and execution errors of a run;
- deploy failures and deploy errors;
- testing blocked or failure limit reached (when the task lands in a Question
  stage, or in the fallback stage of a project without one);
- review no-progress or rejection cap parking the task in Question.

These always notify immediately: sites that publish no brain event (budget
limits, privacy gate, recovery, a blocked testing outcome that lands in neither
a Question nor the fallback stage), untagged tasks, and `completed` notifications.

The board persists the notification as a hold (`objective_task_event_holds`:
task, project, objective, held stage, event type, event `timestamp`, the
notification arguments, state) before publishing the event, then reads the
2xx `/events` response of the brain:

```json
"delivery": { "status": "enqueued" | "dropped", "objective_id": "obj-123", "reason": "optional" }
```

- **Released immediately** (notification sent as usual) when the publish is
  `skipped` or `failed`, when the brain answers without a `delivery` field
  (brain unreachable or answer missing), or when `delivery.status` is `dropped`.
- **Kept** when the brain answers `enqueued`, or the event is queued in the
  replay outbox.
- **Released by ack**: when the objective run that carried the event ends, the
  brain calls `ack_objective_task_event`. If the task is still in the held
  stage the notification is sent; if the agent moved it, the hold is dropped.
- **Fallback**: a hold not acked within 30 minutes
  (`OBJECTIVE_EVENT_HOLD_TIMEOUT_MS`) is settled the same way. The board checks
  every minute and at startup, so holds survive a restart.

Each hold moves `held` → `notified` | `dropped` with a guarded SQL transition,
so it notifies at most once. Each settled hold logs one info line,
`Objective task event hold settled`, with `state` (`notified` | `dropped`),
`reason` (`not_handled` | `ack` | `timeout`), `held_ms` and, for a dropped hold,
`task_status`.

### Cronjob ownership

Cronjobs may carry an optional `objective_id`. Both scheduled occurrences and
manual “run now” operations copy that ID to the generated task. Agents creating
recurring work for an objective must pass `objective_id` to `create_cronjob`;
ownership is not inferred from project membership or task descriptions.

Cronjob create/update endpoints validate that the referenced objective belongs
to the cronjob's project. Clearing `objective_id` makes future generated tasks
unowned; it does not rewrite tasks generated previously.

### Dataset task ownership

Dataset tasks may also carry an optional `objective_id`. Every generated row
task inherits it, including rows spawned after normal advancement, resume,
startup recovery, or restart. Create/update endpoints validate that the
objective belongs to the dataset task's project.

Agents creating objective-owned datasets must pass `objective_id` to
`create_dataset_task`. Clearing ownership affects only future row tasks and
does not rewrite previously generated rows.

### Objective execution gate

Objective-owned work starts automatically only while the owning objective has
status `active`:

- Project queue draining skips linked task cards whose objective is draft,
  paused, achieved, failed, or missing.
- Scheduled cron occurrences advance their schedule without generating a task.
- Dataset advancement, startup recovery, and resume do not generate the next
  row task.

Activating an objective drains the queues of every project that has linked
task cards, so held cards start right away.

Unowned work is unaffected. Work already running is not stopped when an
objective leaves Active. Explicit task execution, cron “run now,” and dataset
run/restart actions are manual overrides and may start the specifically
requested work without enabling other tasks owned by that objective.

### Configuration

Set per project in **Project Settings**:

- `brainContainer` — the container name of the brain instance (from CarapaBox stack creation). A child project whose `brainContainer` names its parent's Brain shares that Brain, and its objectives' queued events are read from the parent's folder.
- `brainAuthToken` — the Bearer token the board uses when calling the brain's API. Stored encrypted at rest using `CARAPA_BOARD_ENCRYPTION_KEY`. Inherited from the parent group if not set on the project itself.

There is **no global `CARAPA_BRAIN_AUTH_TOKEN`** on the board side. Each project (or its parent group) must have a `brainAuthToken` configured in settings. Projects without a token will skip brain event publishing.

The brain URL is discovered at runtime from `sandbox_ps`: it is the service's HTTP ingress address. A brain without one is not discoverable. Projects without `brainContainer` set will skip brain event publishing.

The Brain Auth Token field (Project Settings → Integrations) tests the connection with `POST /api/projects/:pid/test-brain-connection`. Results: `accepted` (the brain accepted the token), `rejected` (HTTP 401/403), `error` (any other HTTP status), `no-container` / `no-token` (nothing to test), `not-found` (no running container with that name in `sandbox_ps`), `no-endpoint` (the container runs but has no HTTP ingress; `not-found` and `no-endpoint` are distinguished only for the project's own saved or inherited brain container or one running a project the caller can access, and any other typed name, admins excepted, gets `not-found` without a probe so the test cannot reveal which containers exist), `discovery-failed` (`sandbox_ps` could not be read), and `unreachable` (the brain was found but the connection failed or timed out; an optional `code` names the transport error). The response never contains the URL, host, port or token; the dialed URL is logged by the board.

**Brain container configuration** (`carapa-brain`):

- `CARAPA_BRAIN_AUTH_TOKEN` — the brain's own inbound auth secret. The board does **not** need this value; it is only used by the brain container itself.
- When calling back to the board, the brain authenticates with its per-project agent token (in a CarapaBox deployment the api-relay supplies it as `BOARD_TOKEN`), not a shared Board-wide token.

### Behavior

- Fire-and-forget: board does not block on brain responses
- Retry transient failures up to 3 attempts, with a delay that grows linearly (1 s, then 2 s)
- Log errors but never throw — brain being down must not break the board

---

## UI: Objectives Mode

A third project mode alongside `kanban` and `chat`.

### Project Mode

```typescript
type ProjectMode = 'kanban' | 'chat' | 'objectives';
```

### Routes

| Route                                  | Component                               | Purpose        |
| -------------------------------------- | --------------------------------------- | -------------- |
| `/objectives/:project_id`              | `objectives.$projectId.tsx`             | Dashboard grid |
| `/objective/:project_id/:objective_id` | `objective.$projectId.$objectiveId.tsx` | Detail + chat  |

### Dashboard View

Card grid populated from `GET /api/projects/:pid/objectives`. Each card shows:

- Title
- Status badge (draft/active/achieved/failed/paused)
- Progress indicator
- Deadline
- Last check-in date

Click opens detail view.

### Detail View

- **Top:** iframe loading `dashboard/index.html` from brain
- **Bottom/tab:** objective chat (reused chat component with `objective_id`)
- **Sidebar/header:** SMART fields summary, edit controls

### Dashboard Refresh

By default a pushed update (objective update or `objective_dashboard_updated`) reloads the iframe from its original URL, which closes any in-frame page the user navigated to. A dashboard can take over refreshes with two `postMessage` types:

- `{ type: 'carapa-dashboard-handles-refresh' }`: the dashboard posts this to `window.parent`. The board accepts it only when `event.source` is the dashboard iframe's `contentWindow`; messages from any other source are ignored.
- `{ type: 'carapa-dashboard-refresh' }`: after opt-in, each pushed refresh posts this (no data, target origin `'*'` because the sandboxed frame has an opaque origin) to the iframe instead of reloading it. The dashboard decides what to do, e.g. reload its home view or ignore it while a report is open.

Without an opt-in, pushed refreshes keep reloading the frame. The manual "Refresh dashboard" button always hard-reloads the frame, even after opt-in. The opt-in is cleared whenever the board reloads or changes the frame (manual button, 6-hour path-token renewal, different objective), so the new document must opt in again.

### Dashboard Access

The dashboard iframe is sandboxed without cookies, so `POST /api/projects/:pid/objectives/:oid/dashboard-ticket` returns a short-lived `ticket` and an 8-hour signed `pathToken` (`…/dashboard/t/<token>/…`, minted for signed-in users only). A path token authenticates only a GET below its own objective's dashboard and is bound to the issuing user: on every request the user must still exist, not be disabled, and hold viewer-or-higher access to the project. A token stops working as soon as the user loses project access or is disabled, even before its 8 hours end. A non-string (for example repeated) `ticket` query parameter is ignored and the request gets 401.

### Dashboard Styling

Brain-generated dashboards match board's visual identity:

- Background: `#030303`, accent: `#22d3ee` (cyan)
- Fonts: Space Grotesk (headings), Inter (body), JetBrains Mono (metrics)
- Components: glass cards, progress bars, status badges
- Shared `styles.css` symlinked into each objective's dashboard folder

---

## Objective Setup Flow

1. User initiates objective creation (UI button or chat)
2. Board routes setup conversation to CarapaBrain
3. Brain runs interactive SMART walkthrough:
   - Specific: What exactly do you want to accomplish?
   - Measurable: How will you track progress? What metrics?
   - Achievable: What resources/constraints?
   - Relevant: Why does this matter?
   - Time-bound: Deadline? Milestones?
4. Brain creates objective folder with `.agent/rules/` files
5. Brain calls board API to register objective record
6. Brain initializes `state.json` and trigger subscriptions
7. Board confirms to user

---

## Implementation Files

### New Files

| File                                                  | Purpose                                              |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `src/modules/objectives/brain-client.ts`              | HTTP client for brain REST API (events, auth, retry) |
| `ui/src/routes/objectives.$projectId.tsx`             | Objectives dashboard grid                            |
| `ui/src/routes/objective.$projectId.$objectiveId.tsx` | Objective detail + chat                              |
| `ui/src/components/ObjectiveCard.tsx`                 | Objective card component                             |

### Modified Files

| File                                                          | Changes                                                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/db/schema.ts`, `src/modules/objectives/db-objectives.ts` | `objectives` table, CRUD queries                                                                                              |
| `src/modules/objectives/types.ts`, `src/types.ts`             | `Objective` interface; `ProjectSettings.mode`                                                                                 |
| `src/routes/objectives.ts`                                    | Objectives REST endpoints                                                                                                     |
| `src/modules/objectives/tools.ts`                             | Objective MCP tools                                                                                                           |
| `src/modules/kanban/task/objective-events.ts`                 | Event publishing on task completion/failure                                                                                   |
| `src/config.ts`                                               | `ENABLE_OBJECTIVES`; brain URL and token are resolved per project from `ProjectSettings` (`brainContainer`, `brainAuthToken`) |
| `ui/src/lib/api.ts`                                           | Add objective API client functions                                                                                            |
| `ui/src/types.ts`                                             | Add `Objective` type                                                                                                          |

---

## Relationship Summary

| Responsibility                     | Owner                       |
| ---------------------------------- | --------------------------- |
| Objective data (PostgreSQL/PGlite) | CarapaBoard                 |
| Objective folders                  | Shared filesystem           |
| Objective CRUD API + MCP tools     | CarapaBoard                 |
| Objective UI (dashboard, chat)     | CarapaBoard                 |
| Event publishing                   | CarapaBoard                 |
| Event processing + queue           | CarapaBrain                 |
| LLM assessment                     | CarapaBrain                 |
| Dashboard HTML generation          | CarapaBrain                 |
| Task creation from objectives      | CarapaBrain (via board MCP) |
| SMART setup skill                  | CarapaBrain                 |
| Trigger/subscription engine        | CarapaBrain                 |
