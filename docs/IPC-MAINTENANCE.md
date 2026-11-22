# IPC maintenance

Board keeps provider session IDs in its database and supplies them when resuming
conversations and tasks. Native history lives in stable provider storage;
`sessions/` contains disposable runtime files. There is no archive/restore cycle.

The hourly scheduler invokes `prune-ipc.sh --apply --days=7` through CarapaBox.
It does not change canonical transcript archives or session-transcript retention.

| Artifact                        | Policy                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ipc/*/sessions/*`              | Remove runtime directories inactive for 7 days.                                                                                                                            |
| `ipc/*/codex-home`              | Stable Codex history, databases and configuration; never age-pruned.                                                                                                       |
| `ipc/*/pi-sessions`             | Stable native Pi history for both chat and task runs; never age-pruned.                                                                                                    |
| `ipc/*/antigravity-home`        | Stable native Antigravity profiles, conversation databases, artifacts and configuration identities; never age-pruned. Explicit custom/OAuth homes stay externally managed. |
| `ipc/*/recordings/*`            | Remove empty directories older than 1 day. Never remove recording files.                                                                                                   |
| `ipc/*/browser-sessions/*.json` | After a 1-day grace period, close and remove descriptors whose project or conversation no longer exists. Valid persistent browsers remain discoverable.                    |
| `ipc/*/runs/*`                  | Existing completion/recovery cleanup continues to own these directories.                                                                                                   |

A warm daemon may cache its native ID in `sessions/`; this is not the durable
source for reopening an evicted conversation. Board's explicit ID takes precedence.
Antigravity's auth/profile fingerprints stay with native history, so removing
runtime files does not disable its configuration compatibility checks.

Session sweeps run even when the instance has active or retained runs. Each
retained run protects only the session named by its `session_dir` or persistent
`args.json` conversation key, including completed runs awaiting Board recovery.
Other idle sessions remain eligible. The sandbox checks runtime artifact ages,
live processes and lifecycle locks again before removal. Directory-only changes,
such as moving native homes out, do not reset the inactivity period; empty
directories use their own modification time. It never sends signals to reclaim
a session. Errors retain affected data, and session symlinks are not traversed.

Running Board runs and retained IPC run directories still prevent recording and
browser-descriptor cleanup for that instance. A failed session sweep or a bad
browser descriptor no longer blocks the other retention steps.

Run `prune-ipc.sh` through CarapaBox in the target sandbox for a preview. Add
`--apply` to prune and optionally `--days=N` to override the default age. Stopped
or outdated sandboxes retain runtime files until the updated command can run.
Sweeps target registered projects' effective sandbox instances; unknown historical
instances require operator review.

The database must contain the correct native session ID. Pi reports missing
history rather than creating an empty session with the old ID. Older fresh Pi
tasks can adopt the explicitly requested history from Pi's cwd-scoped default
storage. Antigravity retains provider configuration compatibility checks for
histories moved to the shared home.
