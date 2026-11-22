# Kanban Module

Core task management, pipeline scheduling, and dataset expansion system for CarapaBoard.

## Overview

The Kanban module drives the core task-execution workflow, providing a board-based task lifecycle, stage-based executions, cronjob-driven scheduling, and dataset row expansion.

## Features

- **Dynamic Stages & Weights**: Flexible column configuration (`queue`, `active`, `done`, `review`) with intelligent type-based sorting and worker configuration.
- **Dataset Execution**: Spawn batch tasks directly from a structured JSON dataset where each row generates a discrete task matching a title/description template.
- **Cronjob Runner**: Schedule recurring and one-time tasks tied directly to specific projects, agents, and models.
- **Task Dependencies**: Specify task prerequisite relationships via `depends_on_ids`.
- **Custom Values & Templates**: Store arbitrary key-value metadata on individual tasks (`custom_values`) to inject context into templates or reports.

## Tools

- `list_tasks(project_id?, stage?, limit?)`: Query active/all tasks on the board. Sorted by stage-type weight (active, testing, queue, review, done); within a stage type by priority then newest created, except done-type stages, which are ordered newest completion first (`completed_at`, falling back to `created_at`).
- `get_task(task_id)`: Retrieve full details for a task.
- `create_task(target_project?, title, description?, status?)`: Create a new task.
- `update_task(task_id, status?, title?, description?, priority?, depends_on_ids?, execute_in_stage?)`: Move or update a task.
- `list_stages(project_id?)`: Return project column/pipeline stages.
- `add_task_comment(task_id, stage_id, comment, persistent?)`: Queue a durable prompt for the next run of one exact active, testing, or review stage. A card's own running agent cannot send a one-shot prompt to the stage it is running; it uses `persistent: true` or another `stage_id`.
- `update_values(task_id, values)`: Inject/overwrite custom key-value pairs.

## Database & Persistence

Task tracking is persisted via the project PostgreSQL or PGlite database layer using Drizzle ORM. Active/historical task messages and execution transcripts are managed by the transcript store layer (`src/modules/transcripts/`).

## Internal responsibility boundaries

- `task-executor.ts` is the compatibility barrel used by routes, recovery, and bootstrap consumers; its public exports remain stable while implementations live under `task/`.
- `task/pipeline.ts` owns execution claims, queue ordering, cancellation, recovery, stage sequencing, and the mutable state required by those flows.
- `task/run-prompts.ts` assembles task and stage prompts, while `task/review-preparation.ts` prepares repository content and reads the content identity used by Testing and Review.
- Top-level `review.ts` and `testing.ts` parse and repair decision formats. `task/review.ts` and `task/testing.ts` own the corresponding lifecycle transitions and side effects.
- Database mutations remain in the database layer; lifecycle modules orchestrate those mutations and preserve the established notification and broadcast order.

## Simplify pass delivery (2026-09-12)

The explicit review target was `src/modules/`, focused on the backend Kanban subsystem and its direct consumers. The worktree started at `a250fb1` with an unstaged, formatting-only edit in `task/review.ts`; that edit was preserved. Independent parallel reviewers were unavailable under the active agent policy, so the reuse, simplification, efficiency, and abstraction lenses were performed locally.

Accepted findings:

- **Reuse:** replaced repeated `stage.type === 'active' && !stage.inactive` searches in review and pipeline lifecycle paths with `getFirstExecutableStage`. The helper has identical first-match semantics and keeps executable-stage selection in `stages.ts`.
- **Simplification:** routed repeated review transition persistence through `applyReviewTransition`, preserving the optional transition guard and the existing direct `updateTask` fallback.

Retained or skipped findings:

- Kept `task-executor.ts` as a compatibility barrel and retained the parser/lifecycle split described above; consolidating either boundary would mix public compatibility, decision parsing, and side effects.
- Did not further split the execution pipeline. Its remaining large control flow shares execution claims, steering barriers, retry state, cancellation, transcript buffers, and finalization ordering; another extraction was not justified without relocating mutable state or changing initialization timing.
- Did not add caching or concurrent work. Stage arrays are small configuration data, and the reviewed paths did not contain repeated I/O or allocation costs with a supported runtime benefit.
- Did not change the similar route-level stage lookup because no consumer contract adjustment was needed for this backend-local cleanup.
- No incidental correctness bug was identified during this pass.

Verification for the executable cleanup covered diff checks; focused review, stage, parser, and review-lifecycle tests (148 passing); focused pipeline and lifecycle tests (144 passing); and `bun verify:changed`, including backend typechecking. No full-suite, deploy, or container validation was run because the change is localized and behavior-preserving.
