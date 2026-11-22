# Offline tool-call quality analysis

CarapaBoard can scan live JSONL transcripts and JSONL members inside the daily
`.tar.gz` archives without extracting archives onto disk. The analyzer keeps an
append-aware cursor, an append-only attempt ledger, and regenerated summary
reports under `store/tool-quality/` by default.

```sh
npm run analyze:tool-quality
```

Useful filters and locations:

```sh
# One or more comma-separated project folder names
npm run analyze:tool-quality -- --project carapa-board,another-project

# Restrict source dates and omit archive scanning
npm run analyze:tool-quality -- --since 2026-07-01 --until 2026-07-31 --no-archives

# Read transcripts and write analysis outside their configured defaults
npm run analyze:tool-quality -- --groups-dir /data/groups --output-dir /data/tool-quality
```

## Resume and rewrite behavior

For a live transcript, `scan-state.json` records the completed byte offset,
line count, processed-prefix SHA-256, occurrence counters, and pending calls.
The next run verifies the whole processed prefix before reading only newly
appended complete lines. A partial final JSONL line is left for the next run.
If the file is shorter or its prefix changed, that source is rescanned and
ledger tombstones remove attempts no longer backed by any source.
When a surviving canonical attempt moves within a rewritten source, its line
and byte location are replaced with the newly scanned position.
Previously tracked files and archive members that disappear are reconciled
after current sources are processed. Their attempts are tombstoned only when no
surviving source owns the same canonical event. Project/date filters and
`--no-archives` exclusions are not treated as source removal.

Archives are identified by archive checksum and member name. Members are read
with `tar -xO`; nothing is permanently extracted. Canonical event identities
are independent from source paths, so moving a live transcript into an archive
does not double-count it. Events without provider call IDs use a canonical
content hash plus a per-conversation occurrence index.

## Outputs and evidence

- `attempt-ledger.jsonl` is append-only. `upsert` records add or revise an
  attempt (for example when an appended result closes a pending call), while
  `delete` records tombstone evidence removed by a source rewrite.
- `reports/summary.json` contains overall, harness, effective-model,
  configured-model, reported-model, harness/model, tool, and daily aggregates.
- `reports/summary.md` is a compact human-readable overview.

Each active ledger attempt retains the classifier version, outcome,
confidence, reason, agent-attribution flag, normalized input/output, raw
evidence, conversation/run identity, runtime kind, harness, configured and
reported model IDs when available, timestamp provenance (`event`, `run`, or
`source`), and every owning archive member or live-file line/byte location.
The primary `source` is repointed whenever an owner disappears, while `sources`
retains the complete surviving ownership list. Later
telemetry in the same run backfills model and timestamp metadata onto earlier
tool attempts without changing their canonical identities. To inspect the
current version of an attempt, read the ledger in order and keep the last
operation for each `attemptId` (the analyzer does this when generating
reports).

Model identity is not guessed. Direct LLM entries normally carry the configured
model in their `llm:<harness>:<model>` agent identity. CLI entries retain
configured task run metadata and provider-reported models when those fields are
present. Attempts without reliable model metadata remain visible in the
harness-level aggregate and in explicit `model-unavailable` report buckets.

## Classification boundaries

The deterministic classifier distinguishes success, invalid invocation,
harness error, tool execution error, command/code failure, transport failure,
and unknown. A valid shell command returning a non-zero exit code is a
`code_failure`, not an agent fault. Runtime aliases such as Gemini's
`run_shell_command` and Cursor's `run_terminal` use the same command rules.
Only malformed/unknown calls and invalid parameters are agent-attributable.
Ambiguous or missing results remain `unknown`; the analyzer does not ask an LLM
to guess.
Timeout, network, service-availability, and harness-adapter evidence in command
results takes precedence over a non-zero shell exit code, so infrastructure
failures remain separate from code failures.
The Direct LLM producer serializes caught dispatch failures as completed tool
calls whose textual output begins with `Error:`. The analyzer treats that
specific producer wrapper as explicit failure evidence; arbitrary matching
text from other successful tool results remains successful content.

Re-running the command always regenerates reports from the current ledger, even
when no transcript bytes changed. Attempts whose classifier version is old are
reclassified directly from their retained input, output, explicit error signal,
and raw evidence; transcript bytes are not rescanned for a rules-only change.
Scan-state schema migrations separately preserve prior source ownership while
forcing a controlled rescan, so removed events can still be tombstoned.
