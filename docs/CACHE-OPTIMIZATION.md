# Prompt caching

CarapaBoard uses Anthropic's prompt-cache feature to keep the cost of
multi-turn chats down and the latency low. This doc explains the two
execution paths the board supports, how the system prompt is laid out for
each, and where in the UI you'll see the hit rate.

## Why this matters

Anthropic's prompt cache charges the **cache write** at 1.25× the normal
input price (one-time, when the cache region is first sent) and the
**cache read** at 10% of the normal input price (every subsequent read of
the same region, for up to 5 minutes of inactivity). The same input
content sent without cache control is billed at the full rate. For a
chat where the user sends ten follow-up messages against the same
project, the saving is roughly:

```
                fresh          cache-write      cache-read     total
without cache:  10 × P                    —               —       10 × P
with cache:      1 × P   +   1.25 × P  +  9 × 0.1 × P              ≈ 3.15 × P
```

(`P` = price per uncached input token. Real Anthropic pricing is in
USD/Mtok, but the _ratio_ is what matters: ~3× cheaper on a ten-turn
chat, and the model latency drops too because the cached prefix is
served without re-evaluating the KV cache.)

The board's job is to put a stable, long prefix in front of every
request, mark it as cacheable, and not change it between turns.

## Two execution paths — two cache stories

CarapaBoard has two completely different runtimes. They look the same
from the UI (the same `agent_cmd` slot in the chat selector), but
they're wired up differently under the hood, and only one of them
benefits from the board's prompt-cache work.

### Direct LLM path

Triggered when `agent_cmd` starts with `llm:` (see
[`AGENTS-CONFIG.md`](AGENTS-CONFIG.md)). The board assembles the full
system prompt itself and calls the model's OpenAI-compatible HTTP
endpoint directly. There is no CLI, no CWD, no auto-discovery.

For this path the board **owns the cache region**. It picks the cache
breakpoint, sets `cache_control: { type: "ephemeral" }` on the prefix
block, and the model honors it on every subsequent turn where the
prefix matches.

### Sandbox (CLI agent) path

Triggered when `agent_cmd` is `claude`, `codex`, `opencode`, `pi`,
`gemini`, or any other CLI binary. The board launches the CLI in a
sandbox container whose CWD is the project repository. The CLI then
reads its own `CLAUDE.md`, `.claude/rules/`, `.agent/rules/`, and tool
list from that CWD — and makes its own call to the model.

For this path the board **does not own the cache region**. The CLI does
whatever its upstream does (Claude Code, for example, sets its own
cache breakpoints and emits `cache_creation_input_tokens` /
`cache_read_input_tokens` in its stream-json output, which the board's
parser does pick up — but the _layout_ is the CLI's, not the board's).
Showing a high cache hit % on a CLI run is real and accurate, but the
board contributed zero to it; the number reflects the CLI's own cache
behaviour.

The UI distinguishes the two cases visually — see the _UI_ section
below.

## System prompt layout

The board builds the system prompt in a fixed order so the cache
breakpoint lands at the same byte offset every time. The order is
chosen so the "common prefix" — the region that should hit the cache
across every turn, every user, every conversation on the same project —
is as large as possible.

### Direct LLM path

```
[COMMON PREFIX: cacheable across (project x turn), for every user]
  1. system.md              (project's primary system prompt)
  2. project rules          (.agent/rules/*.md from group folder)
  3. available toolsets     (the toolset list the LLM can call)
  4. shared KBs             (knowledge bases for search_knowledge)

--- CACHE BREAKPOINT ---

[PER-CONVERSATION TAIL: never cached, always sent fresh]
  5. objective rules        (.agent/rules/*.md under the objective,
                             when in an objective chat)
```

The breakpoint is the literal string `=== CACHE_BREAKPOINT ===` (with
surrounding newlines) exported as `CACHE_BREAKPOINT_MARKER` from
[`src/prompt-loader.ts`](../src/prompt-loader.ts). The board injects
this string into the assembled prompt at the right place; the
`prompt-cache.ts` module finds it and converts the layout above into
Anthropic's request shape.

### Sandbox path

```
[COMMON PREFIX]
  1. system.md

--- CACHE BREAKPOINT ---
```

Items 2, 3, 4, and 5 are **deliberately omitted** for the sandbox path
because the CLI auto-discovers all of them from its CWD. The board
must not inject them — that would:

1. Duplicate what the CLI will read on its own.
2. Make the cache key depend on content the CLI agent doesn't care
   about (objective rules, for example, are only useful inside a
   specific objective folder — the CLI's own rules engine reads them
   from disk when needed, not from the system prompt).

The breakpoint is still emitted in the sandbox path so the Anthropic
prompt cache (if the CLI ends up using one) would anchor at the same
byte offset as the Direct LLM path. Keeping the layout consistent
makes the cache-debugging story uniform across both paths.

## Where the segments come from

Two filesystem roots, two different rules:

| Segment          | Loaded from                       | Why                                                                                                                                 |
| ---------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `system.md`      | group folder                      | Board-stored asset. The CLI does NOT read this — it reads `CLAUDE.md` from CWD.                                                     |
| project rules    | group folder                      | Board-stored `.agent/rules/*.md`. The CLI reads its own copy from CWD.                                                              |
| toolsets         | in-memory registry                | Built from `getToolsetsSystemPrompt`. The CLI builds its own tool list from its own tool plugins.                                   |
| shared KBs       | DB query                          | `KnowledgeService.getSharedKBs(group_folder)`. The CLI hits the board's MCP tools on demand.                                        |
| user preferences | DB query                          | `loadPreferencesCascade(user_id, project_id)`. Not part of the system prompt: appended to the user prompt in `src/agent-runner.ts`. |
| objective rules  | group folder, under the objective | `.agent/rules/*.md` under `groups/{folder}/objectives/{oid}/`.                                                                      |

> **Group folder vs repo folder.** The system prompt is always loaded
> from the **group folder** (`groups/{parent}/{folder}/` or
> `groups/{folder}/` for top-level groups). The **repo folder**
> (`group.settings.repositoryLocation`) is the CLI's CWD; the board
> never reads prompt content from it. Mixing the two would create a
> cache key that depended on whether the repo was bind-mounted.

## Cache key and invalidation

The Anthropic prompt cache keys on the **byte-level prefix up to the
last `cache_control` marker**. Two requests hit the same cached region
iff everything before the marker is byte-identical. The board's design
guarantees that by:

1. **Fixed load order.** The system prompt is always assembled as
   `systemPrompt + projectRules + toolsetInfo + sharedKbsInfo` (then
   the marker, then the user section). A new file under
   `.agent/rules/` invalidates the cache for _every_ conversation on
   the project — this is correct, because the rules changed.
2. **TTL caches in the board** ([`src/prompt-loader.ts`](../src/prompt-loader.ts),
   [`src/system-prompt-builder.ts`](../src/system-prompt-builder.ts),
   [`src/modules/tools/registry.ts`](../src/modules/tools/registry.ts))
   keep the per-component file reads and DB queries from re-running
   on every turn. TTL is **60 s** — a normal back-and-forth chat is
   well under that, so the board doesn't refetch every turn and risk
   a spurious cache miss from a slightly different order or whitespace.
   The full-prompt cache sweeps expired entries on writes and holds at most
   500 entries, evicting the oldest first.

   Tests: [`src/prompt-cache.test.ts`](../src/prompt-cache.test.ts)
   locks the layout invariants and the Anthropic detection logic.

3. **Cache key for the full-prompt cache** (in
   `system-prompt-builder.ts`):

   ```ts
   {
     (group, parent, conv, base, mode, directLlm, liveMode, personaVoice);
   }
   ```

   Anything that affects the assembled string is part of the key:
   the group folder, the parent (for nested groups), the conversation
   (so a turn in objective-A doesn't accidentally hit the cache built
   for objective-B), the chat mode, the execution path (Direct LLM vs
   sandbox), and the Live Mode and persona-voice flags. The user is not
   part of the key because user preferences are not in the system prompt.

4. **Toolset cache invalidation.** When the user calls `load_toolset`
   in the middle of a chat, the toolset list changes. The
   `getToolsetsSystemPrompt` and the group's full-prompt cache are invalidated
   immediately ([`src/modules/tools/core-tools.ts`](../src/modules/tools/core-tools.ts)
   calls `resetToolsetPromptCache(group_folder)`); resets do the same. The next
   `buildSystemPrompt` rebuilds with the new list.

## Anthropic conversion — `src/prompt-cache.ts`

`buildAnthropicSystemBlocks(systemPrompt, baseUrl)` is the bridge
between the assembled string and the Anthropic request body:

1. If the `baseUrl` doesn't look Anthropic (i.e. not `api.anthropic.com`
   and not via the api-relay `/anthropic/` path), the function returns
   `null` and the system prompt stays in `messages[0]` as a plain
   string. **No `cache_control` is sent** to non-Anthropic backends.
2. If the system prompt doesn't contain the breakpoint marker (sandbox
   path, or a future layout that doesn't need one), the function also
   returns `null` — there is no cache region to anchor.
3. If the prefix is below Anthropic's 1024-token minimum for a
   cacheable region, the function returns `null`. Sending
   `cache_control` on a sub-1024-token region is silently ignored by
   the API and billed as a cache write at full price — worse than
   sending nothing.
4. Otherwise, returns two blocks:

   ```json
   [
     {
       "type": "text",
       "text": "<prefix>",
       "cache_control": { "type": "ephemeral" }
     },
     { "type": "text", "text": "<suffix>" }
   ]
   ```

`runOpenAiCompatible` (in
[`src/modules/chat/direct-llm.ts`](../src/modules/chat/direct-llm.ts))
places the blocks at the top level of the request body as `system`
(Anthropic's canonical location) and blanks `messages[0]` to keep
the existing pruning math honest. The OpenAI SDK's
`extra_body` passthrough is what makes this work — `system` is an
unknown field to the SDK and gets sent as a top-level request body
key, which is exactly what Anthropic reads.

## UI

The cache stats come back in the run telemetry as three fields:

- `tok_cache_read` — tokens served from the cache this turn
- `tok_cache_write` — tokens written into the cache this turn
- `tok_input` — fresh input tokens (full price)

`tok_cache_read` + `tok_cache_write` + `tok_input` is the
"cacheable input" denominator. The hit rate is:

```
read / (read + write + fresh)
```

The UI shows this in three places, all in
[`ui/src/components/board/task-detail-dialog.tsx`](../ui/src/components/board/task-detail-dialog.tsx):

1. **Dialog summary** (the row under the run metadata) — shows
   `write↑ read↓` next to `out · in`, and a coloured `%` badge with
   a `Direct LLM` / `CLI` label.
2. **Runs tab row** — same `%` badge, compact.
3. **RunDivider** (the per-run marker in the chat) — compact
   `<n>%` chip.

The badge color is **path-aware** because the two paths mean
different things by the same number:

| Path                                         | Source of the cache stats                                 | Badge            | Tooltip                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| `llm:*` + Claude model                       | board's `cache_control` via `extra_body.system`           | primary (accent) | "Anthropic prompt cache — the board's cache_control markers are active for this run"                     |
| `llm:*` + non-Claude                         | underlying API call (no `cache_control` was sent)         | muted            | "Cache stats from the underlying API call. Not driven by the board's cache_control markers on CLI runs." |
| CLI agent (`claude`, `codex`, `opencode`, …) | the CLI's own underlying call — board contributed nothing | muted            | "Cache stats from the underlying API call. Not driven by the board's cache_control markers on CLI runs." |

A high cache hit % on a CLI run is real (you saved money), but the
"accent" colour is reserved for the path where the board's work is
what's producing the savings. This is a deliberate choice to keep
the badge honest.

The two helper functions in the file make the classification simple:

- `getRunPath(run)` — returns `{ isDirectLlm, isAnthropic,
cacheControlActive, label }`. `cacheControlActive` is the single
  source of truth for "did the board send `cache_control` for this
  run?".
- `getCacheHitPct(run)` — returns the percentage (0–100) or `null`
  when there's no cacheable input at all.

`isAnthropic` is a client-side heuristic that matches the model name
against `/claude/i`. This is accurate for every real configuration:
when the user picks `llm:claude-*` in `board_agents.jsonc`, the model
string is `claude-…` regardless of whether the actual baseUrl is
`api.anthropic.com` directly, the api-relay, or any other
Anthropic-compatible proxy. (Anthropic model IDs always start with
`claude-`.)

## Failure modes

What you should know if a cache hit is suddenly 0%:

- **`baseUrl` is not Anthropic.** `isAnthropicBaseUrl` returns
  `false` for everything except the Anthropic direct URL, the
  api-relay `/anthropic/` path, or anything with `anthropic` in the
  URL. If you point an `llm:claude-*` entry at, say, a local
  llama.cpp server, the `Direct LLM` badge will appear in the UI but
  the `%` will be muted and the underlying model probably won't
  honour `cache_control` at all.

- **The prefix is below 1024 tokens.** Anthropic ignores the
  `cache_control` marker on sub-1024-token prefixes. With a tiny
  `system.md` and no project rules, the prefix might be only a few
  hundred tokens — and the marker is skipped on purpose
  (`buildAnthropicSystemBlocks` returns `null`). The cache hit % on
  such a project will be 0% by design.

- **A file changed.** Editing `system.md` or any file under
  `.agent/rules/` invalidates the cache for the whole project. The
  TTL caches in the board are 60 s; if you change a file and then
  immediately send a message, the board may still have the old
  content in its own cache and re-emit it, getting a cache hit on
  the _old_ region. (Worst case 60 s; usually immediate.) Editing a
  toolset has the same effect via `resetToolsetPromptCache`.

- **The conversation crossed a toolset change.** When the user calls
  `load_toolset`, the toolset list grows, the cache key changes, and
  the next turn writes a new cache region. Read % is 0% for that
  turn only.

## Adding a new cacheable segment

When you want to add a new piece of the system prompt to the common
prefix (so it gets the cache hit too):

1. Add the loader to `buildSystemPrompt` in
   [`src/system-prompt-builder.ts`](../src/system-prompt-builder.ts).
2. Append it to `prefix` inside `assembleSystemPrompt` (it goes
   before the `CACHE_BREAKPOINT_MARKER`).
3. If the segment is "Direct LLM only" or "sandbox only", wrap the
   loader in an `isDirectLlm` check; the assembly itself is mode-
   agnostic.
4. If the segment is slow to load, add a TTL cache in
   `prompt-loader.ts` (or `modules/tools/registry.ts` for toolset-
   adjacent content) and invalidate it from any code path that
   mutates the source.
5. Update the prefix composition in the doc block on
   `BuildSystemPromptOptions` so the diagram stays in sync with the
   code.
6. If the new segment is "user-specific" (varies per user), keep it out
   of the system prompt. User preferences are appended to the user
   prompt instead, so the prefix stays identical for every user.

## Future improvements

Things that would push the hit rate higher but aren't done yet:

- **Server-side prompt-cache status for CLI agents.** Today, the
  board trusts the CLI to set its own cache. We could pre-send the
  full system prompt from the board with our own `cache_control`,
  then have the CLI just continue the conversation — but the CLI
  doesn't accept a pre-built system prompt, so this would mean a
  custom transport or a wrapper script.

- **Cache TTL override.** Anthropic lets you set
  `cache_control.ttl` to `5m` or `1h` for longer-lived regions. We
  hard-code `ephemeral` (5 min) for now. The project-rule file is a
  good candidate for `1h` because it changes rarely — but only if we
  can guarantee the prefix never shifts in that window (no
  user-preference reordering, no chat-mode swaps, etc.).

- **Auto-detect Anthropic from the model list.** Right now
  `isAnthropic` matches the model name. A more accurate check would
  also confirm the model supports prompt caching
  (Anthropic exposes this per-model, not globally), so we could
  gracefully fall back to non-cached for older / non-supporting
  models.

- **Per-(project, user) cache stats in the project dashboard.** The
  run-divider badge is a per-run signal. Aggregating the same fields
  across the runs of a project would let the project owner see the
  "average cache hit % for this project" trend over time — useful
  for confirming the optimization is paying off at scale.
