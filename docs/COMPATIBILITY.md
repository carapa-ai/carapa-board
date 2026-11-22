# Compatibility policy

CarapaBoard keeps compatibility paths when removing them would make existing
project configuration or historical data unreadable. Pre-release adapters may
be removed once the repository has a canonical writer and no current caller.

## Compatibility intentionally retained

- Project bootstrap keeps `CLAUDE.md` and `GEMINI.md` links to `AGENTS.md`, and
  `.claude/rules` and `.gemini/rules` links to `.agent/rules`. Agent CLIs still
  discover project instructions through those names.
- Transcript lookup and archival keep dated, undated, and UUID-era filename
  support. These are read-only discovery paths for historical transcripts;
  current writes use canonical dated names.
- The database migration baseline seeder remains required for installations
  originally created with `drizzle-kit push` and for the squashed baseline.
  Normal incremental migrations still run through Drizzle's `migrate()`.
- Both worktree-isolated and locked shared-checkout Git execution remain
  supported.
- CarapaBox calls remain REST-first with MCP fallback for transport resilience.

## Compatibility removed

- Project `defaultAgent`/`defaultModel` and stage `workerAgent`/`workerModel`
  runtime overrides are discarded. Kanban execution resolves only structured
  runtime selections and the global structured defaults.
- Task-level `agent_name`/`model` runtime overrides are no longer read or
  written. The task columns are dropped and existing values are discarded;
  only a structured task `runtimeSelection` can override inherited runtime
  configuration.
- Recovery `args.json` accepts only `groupFolder`, `taskId`, `conversationId`,
  and `sessionId`. The current launcher writes these canonical fields.
- `AUTO_START_SANBOXES` is no longer recognized; use
  `AUTO_START_SANDBOXES`.
- Objective creation rejects individual SMART fields. Put structured SMART or
  OKR values in `metadata`.
- The HTTP bridge exposes DB conversation IDs and canonical conversation
  transcripts only. Omit `session_id` (or send `null`) to start over; legacy
  CLI session pass-through, `/reset`, Claude session indexes, and direct Claude
  session-file retrieval are not supported.
- On-demand sandbox startup ignores stale conversation-keyed or task-marked
  index records. It does not rewrite or delete the stale on-disk data merely by
  loading it.
