# Stage alternatives, A/B experiments and co-stages

Stage alternatives let one project run the same pipeline stage with different run configurations (harness, model, sandbox, persona). They back three features:

| Feature                   | Field           | Purpose                                                                   |
| ------------------------- | --------------- | ------------------------------------------------------------------------- |
| Run one card on a variant | `stage_variant` | Run a single card on the `coding.b` / `testing.b` alternatives            |
| A/B experiment            | `ab_variants`   | Run several implementations of one card side by side and merge the winner |
| Co-review / co-testing    | `co_stages`     | Run extra reviewers or testers on the same implementation                 |

## Stage alternatives

- **Id:** `<base>.<suffix>`, for example `coding.b`, `review.o`, `testing.u`. The suffix matches `^[a-z][a-z0-9]{0,7}$`; `a` denotes the base stage itself. Only `active`, `testing` and `review` stages can have alternatives, and the base must exist.
- **Storage:** alternatives are flat entries in `settings.stages`, edited with the stage editor or `set_project_stages`.
- **Not columns:** `getGroupStages` filters alternatives out, so `coding` and `coding.b` are one board column. `getGroupStagesWithAlternatives` serves config and setup consumers (`get_project_setup` lists them; `list_stages` does not).
- **Inheritance:** an alternative overrides only run config (`OVERRIDABLE_STAGE_KEYS`: `runtimeSelection`, `mainAiUserId`, `workerSandbox`, `record`, `stallTimeoutMs`, `stallGraceMs`) plus its prompt. Type, title, color and transitions always come from the base.
- **Resolution:** `resolveStageForTask(group, stageId, variant)` returns the base merged with `<stageId>.<variant>`; a missing alternative yields the base stage. A task-level `runtimeSelection` still has top precedence and would cancel out the alternative's runtime, unless its `runtimeSelectionStage` limits it to another stage: an override on the coding stage cancels the coding alternative's runtime, one on testing or review does not.
- **Prompts:** the prompt file is `stage-<base>.<suffix>.md` (for example `stage-coding.b.md`) and is written with `set_project_prompt` using the alternative id. An alternative without a prompt file falls back to the base prompt. Once the alternative is removed, a leftover prompt file is ignored (`hasStageAlternative`).

## Running one card on a variant (`stage_variant`)

`stage_variant: "b"` makes this card run `coding.b`, and `testing.b` / `review.b` wherever those exist; other stages use the base. The card is an ordinary task and merges normally. It can only be set (or cleared with `null`; `a` also means the base stages) while the card is in a queue stage and not claimed.

In the task dialogs, tick a single variant in **Run variants** to set it; it works in any checkout mode. Outside worktree mode the row is single-choice. Ticking two or more variants starts an A/B experiment instead (worktree mode only), and the dialogs send `stage_variant: null` then, so a card never stores both. A board card with `stage_variant` set shows a small variant-letter badge.

## A/B experiments (`ab_variants`)

`ab_variants: ["a", "b"]` compares implementations of one card. Each variant becomes its own card with its own branch and worktree and goes through the full pipeline.

**Validation** (`validateAbVariants`), all enforced on create and update:

- at least 2 distinct variants, including at least one non-`a`;
- every non-`a` variant needs a coding (active-stage) alternative; otherwise the error is `Variant "<v>" has no coding stage alternative; use co_stages for review/testing alternatives`;
- project `taskCheckoutMode` is `worktree` and a repository is configured;
- settable only while the card is in a queue stage and before the experiment has forked.

**Fork.** `computeAbForkStage` returns the first executable active base stage where a selected non-`a` variant has an alternative. Stages before it run once on the parent (its own branch, with base configs). When the parent reaches the fork stage it does not run it: `spawnAbVariants` records the parent's branch HEAD as `ab_fork_commit` (the default-branch HEAD when the fork is at the first stage) and creates one child per variant in that stage. Each child has `ab_parent_task_id`, `stage_variant` and its own branch and worktree based on `ab_fork_commit`; a unique index on (`ab_parent_task_id`, `stage_variant`) makes the fork idempotent. A child that never ran copies nothing checkout- or session-related from the parent. Children run in parallel up to `maxParallelWorktrees`.

**After the fork** children are independent. A child still uses `<stage>.<variant>` at later stages where configured (`resolveStageForTask`), and a rework loop stays on its own branch. The fork copies the parent's `co_stages` to every child; `resolveCoStages` ignores a `co_stages` entry for a stage the child's own variant already replaces.

**No auto-merge.** Experiment cards (children and the parent, `isAbExperimentTask`) never merge automatically; they complete in their done stage and keep their branch and worktree. A forked parent cannot be run manually: `POST /api/projects/:pid/tasks/:tid/execute` answers 409.

**Winner pick.** `POST /api/projects/:pid/tasks/:fid/ab/winner {taskId}` (`pickAbWinner` in `src/modules/kanban/task/ab-winner.ts`) is user-only: agent credentials are refused and there is deliberately no MCP tool. The chosen child must be done. A compare-and-set claim guarantees exactly one winner. Only the winner's branch is merged (through the normal deploy merge path, bypassing the experiment gate); the parent is then completed, losers are left untouched, and no build or deploy starts. The winner keeps its done stage. A failed merge releases the claim so the user can retry. A merge conflict sends the variant to rework; a non-conflict checkpoint failure puts the variant back in its done stage so it stays selectable.

**UI.** The stage editor adds and edits alternatives, the task dialog has a variant selector, cards show variant badges, and the parent shows a comparison panel with "Merge this variant" and a per-variant Dismiss.

## Co-review and co-testing (`co_stages`)

`co_stages: ["review.o", "testing.u"]` is a per-task list (never a stage setting) of extra stage alternatives that also judge the same implementation.

- **Validation** (`validateCoStages`): each entry must be a configured alternative whose base is a review or testing stage (`Unknown co-stage …` / `… base stage "<x>" must be a review or testing stage`). Duplicates are dropped, order is kept, `null` or `[]` clears.
- **When it can change:** only while the task is not claimed or running; a chain in progress finishes with the list it started with.
- **Where to set it:** `create_task` / `update_task`, the HTTP task create and update routes, and the task dialog chip selector.
- **Review chain** (`task/review-chain.ts`): the stage's own runtime reviews first, then each review entry serially, all on the same commit. Every reviewer runs; verdicts accumulate in `custom_values.review_chain`. The decision is made once after the last reviewer (`aggregateReviewChain`): all must approve, otherwise the issues of all rejecting reviewers are combined into one rejection. Issues and summaries from approving reviewers are kept on that rejection as non-blocking notes (`advisory_issues`, `advisory_summary` in `review_history`) and shown to the coder; they never count toward progress tracking. Recovered verdicts go through the same chain. A manual Review run continues a chain in progress with the next reviewer and starts over only when no chain is in progress or another run interrupted it ("Start over" always starts over). When a chain starts, an extra reviewer whose effective runtime is identical to the primary run's (same harness, model and reasoning; Auto selections are never skipped) is dropped from the chain and a note is appended to the task transcript. Re-review context is per reviewer: each reviewer's prompt lists only the earlier rejected issues raised by its own stage, never those of another reviewer.
- **Testing chain** (`task/testing-chain.ts`): the stage's own runtime tests first, then each testing entry serially on the same commit and tree. It short-circuits: the first fail or block stops the chain and sends the card back. The card advances only after the last tester passed. State lives in `custom_values.testing_chain` while extra testers remain.

## MCP and HTTP fields

| Field           | Tools / routes                                        | Notes                                     |
| --------------- | ----------------------------------------------------- | ----------------------------------------- |
| `stage_variant` | `create_task`, `update_task`, HTTP task create/update | Queue stage, not claimed                  |
| `ab_variants`   | same                                                  | Validation above                          |
| `co_stages`     | same                                                  | Validation above                          |
| winner pick     | HTTP only                                             | `POST …/ab/winner`, user session required |

Use `get_project_setup` to discover valid alternative ids; `list_stages` returns base stages only.

## Limitations

- A variant with its own `review.<v>` is judged by a different reviewer, which confounds score comparison between variants.
- Variants share `ab_fork_commit` as their base, but review's rebase onto the default branch runs per child, so bases can differ slightly if the default branch moves between reviews.
- Review and testing alternatives cannot fork an experiment; use `co_stages` for them.
- A task-level `runtimeSelection` overrides alternative runtimes of the stage it applies to (all stages by default, or the one in `runtimeSelectionStage`), so leave it unset on experiment cards or limit it to a stage without alternatives.
