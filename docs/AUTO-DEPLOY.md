# Auto-Deploy Pipeline

Automatically deploy carapa-board (or any managed service) when a kanban task completes its execution stage.

## How it works

The deploy triggers whenever a task's status becomes `deploy`, regardless of how it got there:

1. **Manual drag**: user drags a card to the `deploy` column in the UI
2. **Agent completion**: agent finishes in `in_progress` and `deploy` is the next done stage
3. **Agent sets status**: agent explicitly moves its task to `deploy` via MCP tool

In all cases, `triggerDeploy()` fires:

1. CarapaBoard merges the task branch and calls the `build_service` MCP tool on CarapaBox. Tasks of one project that reach `deploy` within a short window are batched: their branches are merged one after the other and the build runs once
2. CarapaBox builds the Docker image. A service built by the host runner (`build: host-request`) is queued, and the board polls `build_service_status` until the build settles
3. The task stays in `deploy` stage after a successful build (`completed_at` is set). The build does not restart the running service: the restart is handled by the service health watcher or manually (see [Administrator restart](#administrator-restart))

```
Task status becomes 'deploy'
  (manual drag / agent completion / agent sets status)
        |
        v
  triggerDeploy()
        |
        +---> merge task branch(es)
        +---> MCP: build_service { name: "carapa-board" }
        |         |
        |         +---> image build
        |         +---> host-request build: queued, board polls
        |               build_service_status until it settles
        |
        +---> Success: stay in deploy stage (completed_at set)
        +---> Failure: move to failed stage with error
```

## Setup

### 1. Add a "deploy" stage to your project

In project settings, add a stage with id `deploy`. It can be either:

- **`done` type** (recommended): placed after the last active stage. The task auto-advances to `deploy` when the agent finishes. No sandbox slot consumed.
- **`active` type**: `drainProjectQueue` picks it up like any active stage, but the deploy intercept fires instead of running an agent.

Example stage configuration:

```
backlog (queue) -> in_progress (active) -> deploy (done) -> completed (done)
```

### 2. Set `deployService` in project settings

In the project settings dialog, set **Deploy Service** to the managed service name (e.g., `carapa-board`). This must match a key in CarapaBox's `config/managed-services.yaml`.

### 3. Configure the managed service in CarapaBox

**`carapa-box/config/managed-services.yaml`:**

```yaml
carapa-board:
  composeDir: $CARAPA_BOARD_STACK_DIR
  buildDir: $CARAPA_BOARD_DIR
  healthUrl: https://host.docker.internal:3000/health
  service: carapa-board
```

- `composeDir`: operator-only directory holding the deployment `docker-compose.yml` and `.env`. Supports `$ENV_VAR` substitution.
- `buildDir`: the carapa-board checkout used as the Docker build context (defaults to `composeDir`).
- `healthUrl`: optional, for external health monitoring. CarapaBox expands `$ENV_VAR` in it but does not poll it.
- `service`: the compose service name (used for log retrieval on failure).

Keep `composeDir` outside every sandbox mount. Agents edit the repository, and
Compose trusts every file in the directory it runs in, so a deployment from the
checkout lets a merged `docker-compose.yml` change grant itself host access.
See CarapaBox `docs/managed-services.md`.

**`carapa-box/.env`:**

```
CARAPA_BOARD_DIR=/path/to/carapa-board
CARAPA_BOARD_STACK_DIR=/path/to/operator/carapa-board-deploy
```

### 4. Health endpoint

CarapaBoard exposes `GET /health` (auth-exempt) returning `{ status: 'ok', uptime: <seconds>, started_at }`.

## Self-deploy

When carapa-board deploys itself, the deploy stage only builds the new image through `build_service`. The running board keeps serving until it is restarted, so the task settles in the `deploy` stage like any other build.

### Restart recovery

When an execution or recovery transition persists a task's move into the `deploy` stage before calling `triggerDeploy(..., { skipMerge: true })`, it writes the pipeline-owned `deploy_pending_dispatch` marker in the same `updateTask` call. `runDeploy()` clears `deploy_pending_dispatch` immediately before calling the build or deploy service (and on failed or skipped deploys).

At boot, `recoverPendingDeployDispatches()` scans non-archived cards in the `deploy` stage of projects with `deployService` configured:

- An undispatched deploy handoff (still carrying `deploy_pending_dispatch` and no `deploy_host_build` receipt) is dispatched once via `triggerDeploy(task, group, { skipMerge: true })`.
- Boot recovery of finished runs (`recoverStalledRuns`) never calls `triggerDeploy` and never waits for a build. When a recovered run, Testing verdict or Review verdict moves a card into a done-type `deploy` stage, it only writes `deploy_pending_dispatch` in that same update; this dispatch step then starts the build without blocking startup. For an active `deploy` stage recovery only moves the card; queue admission and the deploy intercept start the build.
- A card whose build was already dispatched (`deploy_pending_dispatch` cleared, `deploy_host_build` present—resumed instead by `recoverPendingHostBuilds()`—or self-deploy in progress after the marker was cleared before calling the deploy service) is never rebuilt by boot recovery. A card in an active `deploy` stage whose host build is resumed is held from the queue for the rest of that stage visit (any later move of the card ends the hold).

### Administrator build

The admin Build app button, its restart and the endpoints behind them are off unless `CARAPA_BOARD_DEPLOY_SERVICE` is set in `.env` (empty by default); disabled endpoints answer 404 and the UI hides the button and restart banner.

`POST /api/admin/rebuild-board` (admin Build) asks CarapaBox to build the `CARAPA_BOARD_DEPLOY_SERVICE` image in the background and pauses new automatic background jobs meanwhile. A failed build raises the `deploy_failed` toast with a "View log" dialog showing the last 20 000 characters of the output.

When `BOARD_BUILD_FAILURE_PROJECT` names a project folder, a failed build also opens a card in that project, started in its first active stage and owned by the requesting admin. The card is created at priority -100, -99, … in creation order (never above -1), so it sorts ahead of normal cards (priority 0 or higher) in its stage by priority; a running card still shows first in the column, and a card with a due retry or an older card admitted by a Run on Entry stage can still start first. The title is `Build failed at <short commit>: <failing step command>`; the description holds the commit, the failing step, the failure lines (extracted from the full build output, not only the dialog's tail) and an instruction to fix the cause so the step passes. If no step can be identified, the title instead includes a short hash of the extracted failure lines with step numbers and timings removed, so the same failure at the same commit gets the same title on every retry, while different unidentified failures at the same commit do not share a card. If an open card with the same title already exists, the new failure lines are added to it as a comment instead. A card-creation error is logged ("Build-failure card creation failed") and does not affect the build flow. A later successful build archives marked cards that never started and leaves a stage note on those that have started. A green build handles at most ten marked cards, taken in board order (oldest build-failure card first), so with more than ten open the rest wait for a later green build. Unset or empty turns the feature off.

### Administrator restart

`POST /api/restart` (admin Restart) waits before restarting the board: it pauses new automatic background jobs, then waits until the in-flight background jobs (titles, reflection, memory audits, indexing) and running direct-LLM chat turns are done, at most 10 minutes after the request, and then restarts. Users can still start chat turns during the wait; turns still running at the deadline are cut off. The pending status lists what it waits on (`waitingOn`, direct chat turns as `direct-chat`). `DELETE /api/restart` cancels the wait, and `force=1` restarts at once. A memory audit that was still applying when the process died returns to Ready with a note at the next start and is not replayed; apply it again from Memory Review. CLI-harness chats and task runs run in sandboxes and are reattached after a restart, so the restart does not wait for them. When a reattached chat run finishes, it hands off the conversation's queued follow-ups like a live turn: prompts and form answers that arrived during recovery are released or started, and a follow-up whose message can no longer be found is closed as an error instead of staying in Running. After a restart, a queued follow-up whose conversation is still locked by a run that died with the old process (its lease is reclaimed once its heartbeat has been silent for 5 minutes) is dispatched normally; one queued behind a turn that is still running waits and dispatches when that turn ends, but at most the agent timeout plus 15 minutes after its last event (a blocker still present then is hung; the give-up is logged and the follow-up closed as below); one that cannot be dispatched (its message was already taken by a live turn or is gone, dispatch throws, or the wait limit passed) is closed instead of being retried: as completed when the message was already answered, otherwise as an error with a visible "could not be processed" message. Each recovery decision is logged at info level ("Recovering direct follow-up run").

## Key files

| File                                      | Role                                             |
| ----------------------------------------- | ------------------------------------------------ |
| `src/modules/kanban/task/deploy.ts`       | `triggerDeploy()` function and intercept points  |
| `src/http-service.ts`                     | `/health` endpoint                               |
| `src/routes/projects.ts`                  | `deployService` in allowed settings whitelist    |
| `src/types.ts`                            | `deployService` field on `ProjectSettings`       |
| CarapaBox                                 | `build_service` and `build_service_status` tools |
| `carapa-box/config/managed-services.yaml` | Service registry with env var substitution       |

## Failure modes

| Scenario                             | Behavior                                                              |
| ------------------------------------ | --------------------------------------------------------------------- |
| Build fails                          | Task moves to `failed` stage with build output                        |
| `deployService` not set              | Deploy intercept is skipped; task completes normally                  |
| `composeDir` empty (env var missing) | Immediate failure with diagnostic message                             |
| Host build not picked up in 10 min   | Task moves to `failed` stage; the message names the host build runner |
| Host build runs longer than 3 hours  | Task moves to `failed` stage                                          |
| CarapaBox unreachable                | MCP call throws; task moves to `failed` stage with a `Deploy error`   |
