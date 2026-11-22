# Build Info

Read-only MCP tool exposing which Board, Brain and Box builds are running.

## Tools

- `get_build_info()`: Returns `{ version, buildTime, startedAt, services, serverWebBuild }` (permission `tasks:read`).
  - Top-level `version` is `BUILD_VERSION`, `buildTime` is `BUILD_TIME` (or `null`), `startedAt` is the ISO start time of the Board process.
  - `services.board`: the same `{ version, buildTime, startedAt }`.
  - `services.brain`: `{ commit, buildTime, startedAt, url }` for the calling project's Brain, read from its unauthenticated `GET /version` (`buildTime`/`startedAt` are `null` when the Brain does not return them as strings); `{ error: "no brain configured for <group>" }` when none resolves.
  - `services.box`: `{ version, buildTime, startedAt }` from CarapaBox `GET /health`. Missing fields are `null`; `startedAt` is derived from `uptime` (seconds) when absent.
  - `serverWebBuild`: `{ status }` (`idle`|`building`|`ready`|`failed`) of the last administrator-requested server & web build. Every caller sees the status. A failed build also carries `error` and `failureLines` (secret-scrubbed failing lines, at most 40) for the CarapaBoard repository's project, its parent project, and admin OAuth users; every other caller sees the status only.
  - Brain and Box are fetched in parallel with a 3 s timeout each. Any failure (network, non-2xx, bad JSON, timeout) becomes `{ error }` for that service only; the tool never throws.

Inference limits: `buildTime` only proves a commit is live if the deploy built develop HEAD after that commit was merged; a manual build from another checkout can mislead; `version` may be a file fingerprint rather than a git sha; `commit` is a git short sha only when the build supplied one ("unknown" or a fingerprint otherwise).
