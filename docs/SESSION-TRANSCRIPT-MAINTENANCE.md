# Session Transcript Maintenance

`groups/**/session-transcripts/` contains immutable per-run diagnostic evidence.
It is not the canonical task or conversation history. The maintenance command
keeps recent run details available, moves older run bundles out of the hot
directory, and expires old diagnostic archives.

## Policy

- Keep run bundles live for 7 days.
- Archive eligible bundles into weekly
  `session-transcripts/archive/week-of-YYYY-MM-DD.tar.gz` files.
- Keep an archive for 30 days after its last creation/update, then delete it.
- Treat every run as one bundle: legacy output, V1 events and manifest, prompt,
  raw provider output, and transcript index sidecars move together.
- Never archive an incomplete V1 events/manifest pair. The command reports the
  bundle, retains it live, and exits unsuccessfully so monitoring can alert.
- Validate an archive before deleting either its live source files or an
  expired archive.

Archived session diagnostics are not restored by task Chat or Run History.
After a bundle leaves the hot directory, the detailed per-run transcript popup
is intentionally unavailable. Canonical task and conversation history remains
under `transcripts/` and follows its separate permanent archive policy.

Board access to `transcripts/` (reads, appends, indexes, moves and
deletes) goes through `src/lib/group-fs.ts`, so a directory the agent swaps for
a symlink is never followed. Locks live under `DATA_DIR/transcript-locks`, one
kernel `flock` file per transcript. When another process (for example
`native-import --update --apply`) holds a transcript's lock, board writers wait
for it instead of dropping the write: the run-reply archive (`cleanupRunDir`)
and chat-entry removal wait up to 30 seconds, and the chat append and
metadata writers queue behind the holder. A wait that times out leaves the
reply spool in place for startup recovery. Deleting a transcript also removes
its flock file, but only when the deleting holder releases the lock, so
exclusion lasts the whole hold (a locker re-checks the inode after winning the
lock).

The daily `transcripts/archive/YYYY-MM-DD.tar.gz` bundles are handled the same
way: archive extraction and bundling happen in board temp space
(`DATA_DIR/tmp/transcripts`), never in the project folder. tar reads a bundle
only from a descriptor pinned in `archive/`, unpacks and packs in the temp
directory (removed afterwards, also on failure), and the rebuilt bundle is
written back atomically. A live transcript that changed after it was copied
into a bundle is kept. Task reset and task delete also scrub the task's
archived copies from these bundles; if a bundle cannot be rewritten, the reset
or delete fails and the task record is kept.

The weekly `session-transcripts/archive/` bundles follow the same rule: the
maintenance command pins `session-transcripts/` and its `archive/`, copies
sources and unpacks the existing weekly bundle into board temp space, builds
the new bundle there, installs it atomically, and deletes sources and expired
bundles only through the pinned directories.

## Command

The command is dry-run-only unless `--apply` is supplied:

```bash
bun run maintain:session-transcripts
bun run maintain:session-transcripts --apply
```

Useful overrides:

```bash
bun run maintain:session-transcripts --project carapa/carapa-board
bun run maintain:session-transcripts \
  --archive-after-days 7 \
  --delete-after-days 30 \
  --report /tmp/session-transcript-maintenance.json
```

Run it inside the CarapaBoard container so it uses the configured `/app/groups`
volume. It creates archives atomically, fsyncs them before replacing an existing
weekly archive, rechecks source metadata before deletion, and prevents
overlapping apply runs with a lock under `data/`.

## Weekly host cron

This example runs every Sunday at 03:15 and appends the JSON report to a host
log. Use the actual absolute path returned by `command -v docker` if Docker is
not `/usr/bin/docker`.

```cron
15 3 * * 0 /usr/bin/docker exec -w /app carapa-board bun run maintain:session-transcripts --apply >> "$HOME/carapa-session-transcript-maintenance.log" 2>&1
```

Install the entry in the host user's crontab only after reviewing one dry run:

```bash
docker exec -w /app carapa-board bun run maintain:session-transcripts
```

The command exits nonzero for incomplete V1 pairs, corrupt archives, unsafe tar
members, or archival failures. A cron monitor should treat a nonzero status as
actionable; affected live files or corrupt archives are retained.
