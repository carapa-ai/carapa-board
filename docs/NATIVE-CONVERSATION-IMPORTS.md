# Importing Native AI Conversations

CarapaBoard can import native conversations from Claude, Codex, Gemini, Cursor,
VS Code Chat, and Antigravity. The importer preserves clean user/assistant
dialogue and available telemetry while excluding tool traces,
private thinking, synthetic system envelopes, IDE context, subagents, and
conversations created by CarapaBoard itself.

Both the bulk command and interactive `codex://threads/<id>` importer store
schema-valid compact V1 run pairs and create durable conversation history
through the shared V1 projector and central append service. Provider-specific
parsers remain supported only as native-to-V1 adapters at this import boundary.

The command is dry-run-only unless `--apply` is supplied. Always review the
dry-run report before importing.

## Supported sources

| Source       | Native location                                | Notes                                                     |
| ------------ | ---------------------------------------------- | --------------------------------------------------------- |
| Claude       | `~/.claude/projects/**/*.jsonl`                | Includes model and token telemetry when present           |
| Codex        | `~/.codex/sessions/**/*.jsonl`                 | Existing Codex imports are recognized                     |
| Gemini       | `~/.gemini/tmp/**/chats/*.json`                | Includes model and token telemetry when present           |
| Cursor       | `~/.cursor/projects/**/agent-transcripts/`     | Supports current nested JSONL and legacy text transcripts |
| VS Code Chat | VS Code `workspaceStorage` / `globalStorage`   | Workspace/empty-window chats, `.json` and newer `.jsonl`  |
| Antigravity  | `~/.gemini/antigravity-ide/conversations/*.pb` | Must first be decoded with the supplied decoder           |

## Quick start

Run commands from the `carapa-board` repository.

Preview every supported provider:

```bash
bun scripts/import-native-conversations.ts --source all
```

Preview one provider:

```bash
bun scripts/import-native-conversations.ts --source claude
```

Apply exactly the same selection after reviewing the report:

```bash
bun scripts/import-native-conversations.ts --source claude --apply
```

Imports use deterministic, provider-scoped conversation IDs. Running the same
command again is safe: previously imported conversations are reported as
`existing` instead of being duplicated.

## Command options

```text
--source <name>       claude, codex, gemini, cursor, vscode, antigravity, or all
--apply               Write transcripts and database records
--update              Update already imported conversations (dry run without --apply)
--reflect             With --apply, admit recent imports and --update appends to the live memory reflector
--reflect-max-age-days <n>
                      Recency window for --reflect in days (default 7)
--explain <id>        Explain what happened to sessions whose id contains <id>
--include-incomplete  Include conversations ending with an unanswered user turn
--project <id>        Restrict imports to one Board project ID
--since <date>        Include conversations on or after this date
--until <date>        Include conversations on or before this date
--project-map <file>  Read explicit native-source-to-project mappings from JSON
--claude-home <dir>   Override the Claude home directory
--codex-home <dir>    Override the Codex home directory
--gemini-home <dir>   Override the Gemini home directory
--cursor-home <dir>   Override the Cursor home directory
--vscode-home <dir>   Override the VS Code User data directory
--antigravity-home    Read decoded Antigravity data from this directory
```

Dates may be timestamps or date-only values. A date-only `--until` value covers
the entire day.

Examples:

```bash
bun scripts/import-native-conversations.ts \
  --source cursor \
  --project carapa-board \
  --since 2026-07-01 \
  --until 2026-07-31
```

```bash
bun scripts/import-native-conversations.ts \
  --source all \
  --claude-home /data/host-claude \
  --codex-home /data/sandbox-codex
```

## Project mapping

When a native session contains a trustworthy working directory, the importer
matches it against registered repositories. It uses an exact match first, then
the longest matching repository path.

Sessions are not guessed into a project. Unresolved or ambiguous sessions are
skipped and their mapping keys are printed in the dry-run report. Add those
keys to a JSON mapping file:

```json
{
  "cwd:/home/user/projects/carapa": "carapa",
  "gemini-hash:0123456789abcdef": "carapa-board",
  "cursor-project:home-user-projects-carapa-carapa-box": "carapa-box"
}
```

Keys may contain `*`, which matches any characters including `/`, for example
`"cwd:/tmp/claude-1000/*": "carapa-board"`. An exact key always wins; otherwise
the most specific matching pattern (most literal characters) is used. Equally
specific patterns pointing to different projects are not guessed: the session is
skipped and the key is listed under `ambiguousMappings` in the report.

Map values must be actual CarapaBoard project IDs, such as `carapa-box`, rather
than display paths such as `carapa/carapa-box`.

Use the mapping file explicitly:

```bash
bun scripts/import-native-conversations.ts \
  --source all \
  --project-map /path/to/native-conversation-project-map.json
```

The shared mapping file used by this workspace is:

```text
ai-knowledge-base/groups/carapa/carapa-board/artifacts/imports/native-conversation-project-map.json
```

The importer defaults to this file under the configured groups directory
(`CARAPA_DATA_DIR/groups`, or `groups` under the working directory when unset).
Inside the running CarapaBoard container the default is:

```text
/app/groups/carapa/carapa-board/artifacts/imports/native-conversation-project-map.json
```

Use `--project-map` to override this location. A missing default file is optional;
a missing explicitly supplied file is an error.

## Understanding the dry-run report

The command prints JSON so it can be saved or processed by other tools. Important
fields include:

- `discovered`: native files or sessions found
- `parsed`: sessions successfully parsed
- `importable`: new conversations ready to import
- `imported`: conversations written during an `--apply` run
- `existing`: conversations already imported
- `orphanTranscript`: sessions skipped because a transcript file already exists
  at the conversation's path without a conversation row; the file is never
  overwritten or deleted
- `failed`: sessions whose import raised an error (listed under `failures`);
  the batch continues and the command exits non-zero
- `boardOwned`: CarapaBoard-created sessions deliberately excluded
- `subagent`: sidechains or subagent sessions excluded
- `empty`: sessions without usable dialogue
- `incomplete`: sessions ending with an unanswered user turn
- `malformed`: files that could not be parsed safely
- `unmatched` and `ambiguous`: sessions without a reliable project mapping
- `filtered`: sessions excluded by source, project, or date filters

The report also includes a bounded preview and unresolved mapping information.
Treat `importable` as the number that `--apply` should add.

After applying, rerun the same command without `--apply`. A successful,
idempotent import should report those conversations as `existing` and no longer
as `importable`.

## Updating partial imports

An import can be incomplete: the native session may have continued after it was
imported, or an earlier run stored a wrong cost. Run `--explain <session-id>` to
see how the stored import differs. For an already imported session the report
keeps the `skipped: already imported as conv-...` line and adds a `comparison`
object (keyed by `<provider> <session id>`) without writing anything:

- `transcript`: native vs. stored message and turn counts, the number of stored
  telemetry entries, and `unexpectedLines` (stored lines not in the native export)
- `timestamps`: native vs. stored `last_user_at` and `last_assistant_at`
- `missingTurns`: native turn IDs absent from the transcript, and absent from
  `external_run_costs`
- `runCosts`: per turn, native vs. stored cost and token totals
- `status`: `complete`, `partial` (something is missing or differs),
  `diverged` (the stored transcript has lines the native export lacks), or
  `missing_transcript`, with a `reasons` list

An archived transcript counts as existing: planning restores it from the
project archive first (the round-trip restore that opening the conversation
performs), so `missing_transcript` means no live or archived transcript.

Claude and Gemini user messages carry their own source timestamp. Imports made
before that stamped them with the assistant reply's time; `--update` accepts
those stored user lines as the native ones (it never rewrites them), so such
conversations are not reported as `diverged`.

`--update` repairs `partial` and `missing_transcript` conversations. Without
`--apply` it is a dry run that reports what would change and writes nothing.
Per session it reports `updated`, `unchanged`, or `refused` under `update`
(`unchanged` sessions are only counted) and in `counts`. With `--apply`, it:

- appends only the missing transcript lines (existing lines are never rewritten)
  and installs the V1 pair of any turn that has none
- inserts missing run-cost rows and corrects the cost and token columns of
  rows that differ; rows that already match are not touched
- sets `last_user_at`, `last_assistant_at` and `preview` only when the native
  value is newer or the stored value is empty. `preview` follows the timestamps:
  it is replaced when either advances, or when it is empty
- advances `read_at` to the new `last_assistant_at` when that timestamp moves
  forward on a conversation that was fully read (`read_at` set and not older
  than the stored `last_assistant_at`), so imported history that was already
  reviewed does not turn unread. An unread conversation keeps its `read_at`,
  and `read_at` never moves backwards
- leaves `pinned`, `title`, `objective_id` and `group_folder` alone
- never deletes transcripts, V1 pairs, or conversation rows

A conversation is `refused` when its stored transcript contains lines that are
not in the native export, typically because the Board continued the
conversation after the import. Nothing is written for a refused session. The
check is repeated under the transcript lock before appending. The importer may
run while the Board runs because both use the same kernel lock (unless the
logged in-process fallback is active). Re-running
`--update --apply` is idempotent, and safe after an interruption. Sessions
skipped by the usual filters (for example incomplete sessions without
`--include-incomplete`) are not updated.

## Reflecting imported history and recovered memories into long-term memory

Conversation import does not run the live memory reflector by default. With
`--reflect --apply`, sessions imported for the first time in that run and
`--update` appends whose newest message (`max(lastUserAt, lastAssistantAt)`) is
within the recency window (default 7 days, `--reflect-max-age-days <n>`) are
admitted to the live reflector: the importer only writes a durable pending row
for the appended byte range (the whole transcript for a first import), and the
running Board's periodic sweep processes it within minutes. Only the
conversation's own project is affected, and the project's memory settings
(`disableObservations`, `observer.excludeGroups`, `ENABLE_MEMORY_REFLECTOR`) and privacy
routing still apply when the Board processes the row. Without `--apply`,
`--reflect` only reports how many sessions would be admitted (`reflect.wouldAdmit`).
Older history keeps the reviewed path below: after
reviewing the imported conversations and gathering surviving native-agent memory
files under the project's `.agent/memories/` directory, generate a separate
high-precision, time-aware memory preview:

```bash
bun scripts/reflect-conversation-history.ts \
  --project carapa-board \
  --output /app/groups/carapa-board/artifacts/history-reflection/preview.json
```

The preview:

- reads regular and objective conversations, restoring archived transcripts
  when necessary;
- recursively reads Markdown and text files under `.agent/memories/`;
- preserves original message timestamps and message-ID provenance;
- prefers the original `sourceMtime` recorded in a neighboring
  `.native-memory-import.json` when its SHA-256 still matches the recovered
  file, otherwise uses the file's filesystem modification timestamp;
- uses that verified modification timestamp as the file's only temporal anchor
  and records `memory-file:.agent/memories/...` provenance;
- extracts only durable candidate decisions, constraints, lessons, preferences,
  and major outcomes;
- reconciles candidates against the complete bi-temporal memory history;
- writes a review manifest, but does not change memories,
  rules, vectors, or graph facts.

The selected source timestamp and native-origin metadata are retained in the
review manifest. A native import manifest is never trusted when its recorded
SHA-256 differs from the recovered file. The timestamp is a `valid_from`
fallback, not an expiry date: an old recovered memory remains currently valid
with an open-ended interval unless later evidence explicitly supersedes or
invalidates it. Dates mentioned inside a recovered file are not used because the
source timestamp is the only independently available temporal evidence.

Both evidence sources are enabled by default. They can be isolated for
diagnostics or staged runs:

```bash
bun scripts/reflect-conversation-history.ts \
  --project carapa-board \
  --memory-files-only

bun scripts/reflect-conversation-history.ts \
  --project carapa-board \
  --conversations-only
```

### Batch-reflect project history from both sources

Inside the CarapaBoard container, one command creates a combined review preview
for every registered project that has imported conversations, verified recovered
native memories, or both:

```bash
bun scripts/reflect-project-history.ts \
  --observer-agent llm:direct:gpt-6.1-terra \
  --reflector-agent llm:direct:gpt-6.1-terra
```

The command is dry-run by default. It:

- accepts only files declared by a native import manifest whose current SHA-256
  still matches;
- includes regular, objective, and archived imported conversations;
- groups both source types by registered CarapaBoard project;
- reconciles recovered memory candidates first, then conversation candidates
  against the resulting shadow timeline, so the direct conversations can
  deduplicate, correct, supersede, or invalidate recovered summaries;
- writes one combined history-reflection manifest under each project's
  `artifacts/history-reflection/` directory;
- writes a checkpointed batch index under
  `main/artifacts/history-reflection/`;
- prints the batch-index path and exact resume command before starting the first
  project;
- atomically checkpoints after every recovered file, conversation, and
  reflection batch, and reuses completed extraction and reflection work;
- continues previewing other projects when one project has an extraction error.

The final JSON output contains the batch-index path and per-project counts.
Review both the batch index and its referenced project manifests. Then apply the
exact reviewed batch:

```bash
bun scripts/reflect-project-history.ts \
  --apply /app/groups/main/artifacts/history-reflection/project-history-batch-....json
```

Apply performs no LLM calls. Before changing memory, it verifies the complete
project source inventory, import-manifest and source-file fingerprints, reviewed
project-manifest fingerprints, conversation transcripts, and each project's
memory baseline. It
checkpoints after every project, so an interrupted multi-project apply can
safely skip projects already marked applied.

Resume a long preview with its original cutoff and source extraction cache:

```bash
bun scripts/reflect-project-history.ts \
  --resume /app/groups/main/artifacts/history-reflection/project-history-batch-....json \
  --observer-agent llm:direct:gpt-6.1-terra \
  --reflector-agent llm:direct:gpt-6.1-terra
```

If repeated extraction or reflection failures are not worth retrying, finalize
the checkpoints already collected without making another LLM call:

```bash
bun scripts/reflect-project-history.ts \
  --accept-partial /app/groups/main/artifacts/history-reflection/project-history-batch-....json
```

This retains every successfully checkpointed memory operation, marks every
candidate that has not yet been accounted for as explicitly skipped, archives
the original failures as ignored warnings, and makes the resulting projects
reviewable. Apply still performs the normal source, chronology, manifest, and
memory-baseline validation. The partial state and ignored failures remain
visible in the Memory Review UI. Projects already applied or in preview are
left untouched; a project whose manifest is missing or unreadable is marked
`error` without stopping the rest of the batch.

The same recovery is available directly in the Memory Review batch header as
**Ignore errors & continue**. Reviewed UI apply trusts the stored preview and
human decisions, so later transcript or baseline drift does not discard the
review; only database-integrity conflicts can still stop a write.

Use `--project <id>` for a single-project trial. `--since` and `--until` filter
conversations by their creation time and verified files by their authoritative
source modification time. Use `--conversations-only` or
`--native-memories-only` for diagnostics; the normal backfill should use both.

### Review history proposals in CarapaBoard

Administrators can review a batch at `/memory-review` instead of editing its
JSON manifests. The page polls active batches, shows per-project extraction
progress, and enables review as soon as a project preview is complete.

Review decisions are stored in an atomic `.review.json` sidecar beside the
project reflection manifest. The original preview remains unchanged. Each
proposal can be approved, rejected, edited and approved, or approved and marked
for a later memory eval. Rejecting a proposal only records a human rejection; it
does not delete source conversations or recovered-memory evidence. Explicit
forget operations are mandatory privacy actions and cannot be rejected, edited,
or exported for eval.

Apply remains disabled while the batch command is still writing, while any
proposal is undecided, or when source, manifest, or memory-baseline validation
has become stale. Project-level Apply builds and validates a derived manifest
from the reviewed decisions and then uses the normal history-memory lifecycle.
Eval-marked operations are exported after successful apply to:

```text
.agent/evals/history-memory.jsonl
```

The eval file is idempotent and self-contained, so the larger reflection
artifacts may be archived or deleted after a successful apply.

The same page also has an **Existing memories** mode. It lists active
project-wide memories and lets an administrator edit them, permanently delete
them through the normal privacy-erasure lifecycle, or mark/unmark them in the
same `history-memory.jsonl` eval corpus. Editing an eval-marked memory refreshes
its expected eval content.

Large runs can reuse unchanged candidate extraction results:

```bash
bun scripts/reflect-conversation-history.ts \
  --project carapa-board \
  --resume /app/groups/carapa-board/artifacts/history-reflection/preview.json
```

After reviewing the manifest, apply that exact file:

```bash
bun scripts/reflect-conversation-history.ts \
  --apply /app/groups/carapa-board/artifacts/history-reflection/preview.json
```

Apply does not call the LLM again. It revalidates evidence, chronology, temporal
operations, source transcript hashes, recovered-file content and timestamps, and
the memory baseline. It refuses to proceed if any source or memory changed after
preview. Successful apply marks the manifest as applied; replay is idempotent.

## Importing data from a host or sandbox

The importer must run where it can access the CarapaBoard database. When
CarapaBoard is running in Docker, copy or mount the native provider directory
into the container, then use the corresponding home override.

For example, to stage Cursor data:

```bash
docker cp /path/to/.cursor/. carapa-board:/app/data/tmp/cursor-import/
```

Preview it:

```bash
docker exec carapa-board \
  bun scripts/import-native-conversations.ts \
  --source cursor \
  --cursor-home /app/data/tmp/cursor-import \
  --project-map /app/groups/carapa/carapa-board/artifacts/imports/native-conversation-project-map.json
```

Apply only after checking the preview:

```bash
docker exec carapa-board \
  bun scripts/import-native-conversations.ts \
  --source cursor \
  --cursor-home /app/data/tmp/cursor-import \
  --project-map /app/groups/carapa/carapa-board/artifacts/imports/native-conversation-project-map.json \
  --apply
```

Use the same pattern with `--claude-home`, `--codex-home`, or `--gemini-home`.
Remove staged copies after the import if they are no longer needed; native
transcripts may contain sensitive content.

## Importing Antigravity conversations

Antigravity stores its native conversations as protobuf blobs. Do not feed
those files directly to the importer. The decoder queries the local,
authenticated Antigravity language server through its official trajectory RPC
and writes temporary decoded JSON.

Antigravity IDE must be running and connected to the environment containing the
sessions.

Create a temporary decoding directory:

```bash
ANTIGRAVITY_IMPORT_DIR="$(mktemp -d)"
bun scripts/decode-antigravity-conversations.ts \
  --output "$ANTIGRAVITY_IMPORT_DIR"
```

If auto-discovery cannot find the Antigravity process, the decoder also accepts:

```text
--home <dir>         Default: ~/.gemini/antigravity-ide
--config-home <dir>  Default: ~/.config/Antigravity IDE
--endpoint <url>     Override the discovered language-server endpoint
--pid <number>       Select a particular Antigravity process
```

Preview and apply the decoded output:

```bash
bun scripts/import-native-conversations.ts \
  --source antigravity \
  --antigravity-home "$ANTIGRAVITY_IMPORT_DIR" \
  --project-map /path/to/native-conversation-project-map.json
```

```bash
bun scripts/import-native-conversations.ts \
  --source antigravity \
  --antigravity-home "$ANTIGRAVITY_IMPORT_DIR" \
  --project-map /path/to/native-conversation-project-map.json \
  --apply
```

When the database is only accessible inside Docker, copy the decoded directory
into the container and run the same dry-run/apply sequence there:

```bash
docker cp "$ANTIGRAVITY_IMPORT_DIR/." \
  carapa-board:/app/data/tmp/antigravity-import/

docker exec carapa-board \
  bun scripts/import-native-conversations.ts \
  --source antigravity \
  --antigravity-home /app/data/tmp/antigravity-import \
  --project-map /app/groups/carapa/carapa-board/artifacts/imports/native-conversation-project-map.json
```

Add `--apply` only after resolving or accepting every reported unmatched
session. Delete both temporary decoded copies afterward.

## Codex compatibility command

Existing automation may continue to use:

```bash
bun scripts/import-codex-conversations.ts
```

It is a compatibility wrapper around the unified importer. New automation
should prefer `import-native-conversations.ts --source codex`.

The chat composer also recognizes an exact `codex://threads/<id>` deep link and
imports that one locally available Codex session. It shares the native-to-V1
normalizer, pair installer, durable projector, and run-cost projection used by
the bulk importer. Both paths partition multi-turn sessions into independently
valid compact V1 pairs, validate them before commit, and archive them under
`session-transcripts`.

## Importing Claude history in Docker

Docker Compose can mount Claude homes read-only (the two mount lines are
commented out in `docker-compose.yml`; uncomment them first): `CLAUDE_IMPORT_SESSIONS_HOST_DIR`
(host Claude, e.g. `~/.claude`) at `/app/claude-import`, and `AGENT_HOME/.claude`
(sandbox Claude) at `/app/claude-agent-import`. Recreate the container after
changing them, then preview and apply:

```bash
docker exec -w /app carapa-board bun scripts/import-native-conversations.ts \
  --source claude --claude-home /app/claude-import
docker exec -w /app carapa-board bun scripts/import-native-conversations.ts \
  --source claude --claude-home /app/claude-import --apply
```

Use `/app/claude-agent-import` for sandbox history. Sessions CarapaBoard created
itself are skipped automatically.

VS Code Chat history works the same way: set `VSCODE_IMPORT_SESSIONS_HOST_DIR`
to the VS Code User data directory (e.g. `~/.config/Code/User`), and mount it
at `/app/vscode-import` (the repository's Compose files have no such mount; add it
in a local Compose override), then pass `--source vscode --vscode-home /app/vscode-import`.

## Required V1 import behavior

The V1 conversion is a prerequisite for legacy
retirement. It must preserve the existing import safety properties while
changing the stored representation:

- Generate one or more V1 manifest/event pairs for every imported native
  session, partitioned so each reconstructed run obeys the V1 lifecycle rules;
  do not write provider-shaped or legacy Board transcript rows.
- Validate the complete V1 pair before any durable conversation is installed.
- Persist the durable projection through the generic V1 consumer and central
  append service used by supported harnesses.
- Preserve deterministic provider-scoped conversation IDs, native session and
  entity IDs where available, project/objective attribution, timestamps, and
  idempotent re-import behavior.
- Derive imported run/model/token/cost records from V1 run and usage events
  instead of a second importer-only telemetry projection.
- Retain or reference the native source as migration evidence when conversion
  fails or exposes semantics that V1 cannot represent.
- Retained sanitized inputs under
  `src/modules/transcripts/fixtures/native-import/source` exercise Claude,
  Codex CLI/VS Code, Gemini, Cursor text/JSONL, VS Code Chat, and Antigravity
  against the compact `CarapaRunEventV1` contract. Do not introduce a second
  Board-side V1 envelope or adapter.

## Safety and failure behavior

- Dry runs do not write transcript files or database records.
- Unmatched and ambiguous sessions are skipped.
- Empty, malformed, subagent, Board-owned, and incomplete sessions are skipped
  by default.
- A failed import cleans up its newly installed transcript and V1 pairs without
  deleting an already existing import or an identical pair recovered from an
  interrupted attempt. Only files created by that attempt are removed, and a
  cleanup error is logged rather than swallowed.
- One failing session is counted as `failed` and does not stop later sessions.
- `--reflect` writes admission rows only together with `--apply`, only for the
  imported conversation's own project, and only for a transcript inside that
  project's group directory. A failed admission counts as `failed` for that
  session; the import itself is kept. If the importer stops between the
  transcript write and the admission, that range is not reflected; use the
  history reflection path for it.
