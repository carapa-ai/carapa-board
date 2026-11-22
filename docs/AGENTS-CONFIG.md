# Agents configuration (`board_agents.jsonc`)

CarapaBoard reads its list of available agents and LLM endpoints from `board_agents.jsonc` inside the board's `DATA_DIR`. The file is JSON with comments and trailing commas allowed, hot-reloaded on save, and shared between the chat UI, task executor, and the in-board memory/LLM client.

Source of truth: [`ChatAgentOption`](../src/lib/chat-agents.ts) in `src/lib/chat-agents.ts`.

For the distinction between runtime selection, group/objective persistence,
and repository access, see
[Agent runtimes, persistent scopes, and workspaces](RUNTIMES-AND-WORKSPACES.md).

## Version 2: independent runtime choices

The required format is a versioned object. It separates reusable endpoint configuration (`connections`), execution programs (`harnesses`), model metadata, and optional shortcuts (`presets`). A model is selectable with a harness only when that model contains a binding for the harness.

```jsonc
{
  "version": 2,
  "connections": {
    "local": {
      "baseUrl": "http://host.docker.internal:8881/v1",
      "wireApi": "chat_completions",
      "disabled": false,
      "env": { "ANTHROPIC_AUTH_TOKEN": "ollama" },
    },
  },
  "harnesses": {
    "direct": { "label": "Direct", "kind": "direct" },
    "claude-code": {
      "label": "Claude Code",
      "kind": "cli",
      "agentCmd": "claude",
      "sessionFamily": "claude",
      "icon": "/harness-icons/anthropic.svg",
    },
  },
  "models": {
    "qwen-3.6": {
      "label": "Qwen 3.6",
      "contextSize": 81920,
      "capabilities": ["image"],
      "reasoning": {
        "options": ["off", "low", "medium", "high"],
        "default": "medium",
      },
      "bindings": {
        "direct": {
          "connection": "local",
          "model": "qwen3.6",
          "maxTokens": 32768,
        },
        "claude-code": { "connection": "local", "model": "qwen3.6" },
      },
    },
  },
  "defaults": {
    "chat": {
      "harnessId": "direct",
      "modelId": "qwen-3.6",
      "reasoning": "medium",
    },
    "observer": { "harnessId": "direct", "modelId": "memory-pipeline" },
    "reflector": { "harnessId": "direct", "modelId": "memory-pipeline" },
    "transcription": { "harnessId": "direct", "modelId": "gemma4-e4b" },
    "imageOcr": { "harnessId": "direct", "modelId": "qwen-3.6" },
    "peekFiles": {
      "harnessId": "direct",
      "modelId": "qwen-3.6",
      "reasoning": "low",
    },
    "commitMessage": {
      "harnessId": "direct",
      "modelId": "qwen-3.6",
      "reasoning": "low",
    },
    "kanban": {
      "fallback": {
        "harnessId": "claude-code",
        "modelId": "qwen-3.6",
        "reasoning": "high",
      },
      "stages": {
        "active": {
          "harnessId": "direct",
          "modelId": "qwen-3.6",
          "reasoning": "medium",
        },
        "testing": {
          "harnessId": "direct",
          "modelId": "qwen-3.6",
          "reasoning": "medium",
        },
        "review": {
          "harnessId": "direct",
          "modelId": "qwen-3.6",
          "reasoning": "medium",
        },
      },
    },
  },
  "presets": {
    "fast": {
      "label": "Fast",
      "harnessId": "direct",
      "modelId": "qwen-3.6",
      "reasoning": "off",
    },
  },
}
```

All v2 names use camelCase. `defaults.chat` controls new chat conversations. `defaults.reflector` selects the runtime of the Board memory reflector, which runs after chats and tasks once `ENABLE_MEMORY_REFLECTOR=true` (off by default) and for DirectLLM's manual `/reflect` command. `defaults.observer` selects the runtime of History Review candidate extraction. `defaults.transcription` optionally selects an audio-capable runtime for Live Mode transcription; Whisper remains the fallback. `defaults.imageOcr` optionally selects the runtime `web_fetch_image` uses to transcribe and screen text in downloaded images; it must be a local runtime with `image: true` (a remote or non-image runtime is never called), and without it image text is neither transcribed nor screened. `defaults.peekFiles` optionally selects the HTTP/direct runtime used to condense file previews; when omitted, `peek_files` uses the current conversation runtime if it is HTTP-capable. `defaults.commitMessage` optionally selects the HTTP/direct runtime used to generate Git commit messages; when omitted, the board chooses a compatible direct binding from the conversation, project, or chat default. `defaults.kanban.fallback` controls task execution when no more specific choice exists, while `defaults.kanban.stages` applies a runtime per stage. A key is either a stage _type_ (`active`, `testing`, `review`), which covers every stage of that type including renamed, custom, and alternative stages, or an exact stage ID (for example `in_progress`), which overrides the type key for that one stage. Lookup order is stage ID, then stage type, then `defaults.kanban.fallback`.

Harness selection is only the execution choice. It does not select the
persistent scope or decide whether a project has a repository. DirectLLM has no
CWD, but its permitted `ripgrep`, `read_file`, and `peek_files` calls execute
read-only in the project's effective CarapaBox sandbox. CLI harnesses run
through `run-agent.sh`, normally with the mounted repository workspace as
their CWD.

`defaults.reflector` selects the runtime used to execute the Board memory
reflector; it does not select how a source transcript is interpreted. The
reflector composes the editable base prompt at `prompts/tool-reflector.md` with
the appropriate editable source profile under `prompts/reflector-profiles/` for a
DirectLLM conversation, CLI conversation, or autonomous Kanban task.

A task `runtimeSelection` is authoritative for its runs. If `runtimeSelectionStage` names one executable base stage (`active`, `testing` or `review`), it is authoritative only for that stage's runs (including its alternatives) and every other stage resolves as if the task had no override; a stored stage id that matches no stage overrides nothing. Without an applicable one, resolution falls through the effective project stage runtime, project Kanban runtime, global stage default, and finally the global Kanban fallback. Harness, provider-facing model, and reasoning are materialized from the same resolved catalog binding. For chat, an explicit conversation selection and project chat override take precedence over the global chat default. This lets pinned projects keep their structured selections while projects with no override follow one centrally managed policy. A manually selected chat harness/model/reasoning is preserved when the composer falls back to the blank new conversation after a dead-conversation send.

Effective scalar values resolve from most specific to least specific: binding, model, connection, harness, then optional `defaults.settings`. Environment objects are merged from least specific to most specific (`defaults.settings` → harness → connection → model → binding), so a binding key wins deterministically while unrelated inherited keys remain present. Custom `env` and `apiKey` values are preserved for compatibility.

Connections are enabled when `disabled` is omitted or `false`. Set
`disabled: true` on a connection to remove every binding that uses it from
the runtime catalog. Models and harnesses with no remaining enabled bindings
are omitted from the UI. Defaults and presets must reference an enabled
harness/model binding; disabling a connection used by one of them makes the
configuration invalid until that selection is changed.

Harnesses may set `icon` to an SVG, PNG, or other browser-supported image path
or URL. The icon is presentation-only and is shown in the runtime picker. The
board bundles `/harness-icons/codex.svg` and
`/harness-icons/anthropic.svg`, plus brand icons for OpenCode, Pi, Cursor,
Hermes, and Antigravity. The special value `@/assets/carapa-bot.png` resolves
to the CarapaBoard image bundled by Vite. Root-relative URLs also work for
user-provided files served by the board (for example,
`/harness-icons/custom.svg`). If `icon` is omitted or the image cannot load,
the UI uses its generic bot icon.

Reasoning choices are normalized UI labels. A model or binding can provide a `map` object to translate them to runtime values; mapping to `null` suppresses the parameter. Direct bindings send the mapped value as `reasoning_effort`. CLI bindings may set `envVar` to expose the mapped value to their launcher (for example, `"envVar": "CODEX_REASONING_EFFORT"`). A binding may instead set `models` to map each choice to the harness model it runs (for harnesses that encode the effort in the model name); its keys must be listed in `options`. Unsupported choices are rejected and never sent. Binding capabilities extend model capabilities and feed the existing image/audio/video checks.

CLI session identity uses `sessionFamily`, falling back to `agentCmd` and then the harness ID. Codex adds its resolved `CODEX_PROFILE` to that identity, using `relay` when the profile is absent. Model, reasoning, and prompt-mode changes inside a compatible family/profile reuse its stored conversation session. A different family or Codex profile uses a separate stored session; switching back resumes the previous compatible session when possible. Cross-profile continuity is rebuilt from Carapa's persisted context instead of passing a provider-local native session ID. Direct runtimes always rebuild context from the persisted conversation transcript and do not synthesize a handoff.

### Discovered models

A harness with a `discover` block gets its models from discovery instead of a
hand-written entry per model:

```jsonc
"claude": {
  "label": "Claude Code",
  "kind": "cli",
  "agentCmd": "claude",
  "discover": {
    "account": "anthropic",       // provider account whose models it uses
    "model": "${id}[1m]",         // binding model; ${id} is the discovered name
    "capabilities": ["image"],
    "reasoning": { "options": ["low", "medium", "high"], "default": "medium" },
    "env": { "CLAUDE_CODE_SUBAGENT_MODEL": "haiku" }, // any other binding setting
  },
},
```

The board keeps `<DATA_DIR>/board_agents.discovered.json` current at startup,
every 30 minutes, when a provider login finishes on the provider-accounts
page, and when a provider account is edited there (label, tier, capacity). It holds the models each connected account offers (from CarapaBox) and
the models each ACP harness reported when a session started (written by the
runner under `data/ipc/*/harness-models/`). An ACP harness that has never
reported its models gets one session in the main group's sandbox after its
account connects; that session stops before any prompt is sent.

Each 60-second provider-accounts poll and Managed accounts page fetch also
checks managed API keys for upcoming or past expiry dates (`expiresAt`, usable
through the end of that UTC day) and provider rejections (`keyCheck: 'rejected'`).
Board admins (`role === 'admin'`) receive push notifications at 14, 7, 3, and 1
whole days remaining (most urgent threshold only, deduplicated per account,
expiry date, and threshold) and once when expired, plus a once-per-UTC-day
reminder while a key remains rejected. Manual expiry dates (`YYYY-MM-DD` or
`null`) can be set or cleared via the optional date field in the key
add/reconnect and account edit forms on the Managed accounts page
(`/admin/provider-accounts`), which also displays expiry and rejection status
badges per key account.

For each `discover` harness the board uses the harness's own list when it has
one, keeping only the names the account serves (Antigravity's retired
`gemini-3.7-*` names map to the `gemini-3.8-*` models the relay serves);
otherwise it uses the account's list. Set `"from": "harness"` on a harness
that accepts only its own model names (Antigravity, Grok, Muse): it then gets
no models until it has reported a list, never the account's raw list. Only the newest model of each family is
added (`claude-opus-5-5`, not `claude-opus-5` or `claude-opus-4-8`), plus any
model that defaults, presets, Auto tiers, or `fallbackModel` name. A model the
account stops offering stays when something names it and is marked
unavailable in the picker; new models are marked discovered.

Antigravity lists one model per effort (`gemini-3.8-flash-low`, `-medium`,
`-high`) and its harness takes the effort as part of the model name. Set
`"effortVariants": ["low", "medium", "high"]` on its `discover` block to merge
those into one model (`gemini-3.8-flash`) with a reasoning picker. The merged
binding's `reasoning.models` maps each choice to the harness model to run, and
only choices the account serves are offered. A tier map names the merged model
(`gemini-3.8-flash`), not its variants.

`board_agents.jsonc` still wins: a model entry with the same id overrides the
generated fields, and its binding settings are merged over the generated
binding (`env` key by key). A failed lookup keeps the previous lists.

When a `fallbackModel` does not support the requested reasoning level, it uses its own reasoning default.

The loader validates references, bindings, defaults, stage IDs, presets, and reasoning values. Hot reload publishes a new catalog only after it validates; a malformed edit logs an actionable error and leaves the last known-good catalog active. The original single-selection v2 `defaults` shape remains accepted and is treated as both the chat and kanban fallback with no stage mappings.

## Auto model

A catalog may declare one pseudo-model with the id `auto` and `"auto": true`. Each of its bindings is a **tier map** instead of runtime settings: it names, for one harness, the concrete catalog model to use for each routing tier (`fast`, `balanced`, `frontier`). Every named model must have an enabled binding for that same harness.

```jsonc
{
  "models": {
    "harness-configured-default": {
      "label": "Harness configured default",
      "bindings": { "claude-code": {}, "hermes-acp": {} },
    },
    "haiku": {
      "label": "Haiku",
      "bindings": { "claude-code": { "model": "haiku" } },
    },
    "sonnet": {
      "label": "Sonnet",
      "bindings": { "claude-code": { "model": "sonnet" } },
    },
    "opus": {
      "label": "Opus",
      "bindings": { "claude-code": { "model": "opus" } },
    },
    "auto": {
      "label": "Auto",
      "auto": true,
      "bindings": {
        "claude-code": {
          "tiers": {
            "fast": "haiku",
            "balanced": "sonnet",
            "frontier": "opus",
          },
        },
      },
    },
  },
}
```

- **Harness configured default** (`harness-configured-default`) means the harness chooses its own model, with no Jev involved. It is independent of Auto, and a harness may offer both options side by side.
- **Auto** means Jev chooses a tier from the harness's tier map. It is offered in the runtime picker (labelled "Auto") only for harnesses that have a tier map, and only when `MODEL_ROUTING_ENGINE=jev`. With the engine `off`, Auto is hidden from the catalog, but a stored `auto` selection still resolves, as the harness's `balanced` tier, so existing conversations and tasks keep working. The same applies whenever no routing decision is available. Set `MODEL_ROUTING_LOG=true` to append each chat routing decision, including the routed message text, to `<data>/ipc/<stack>-<instance>/routing/<conversationId>.jsonl` (off by default).
- A tier can also list **candidates** in order, as `"<harnessId>:<modelId>"` strings, for example `"frontier": ["claude-code:opus", "codex:gpt-pro", "antigravity:argon-4"]`. Candidates may sit on other harnesses. The first enabled candidate serves the tier and the run starts on its harness. A disabled or unknown candidate is skipped with a warning; a tier with no valid candidate drops the binding. A string tier keeps the same-harness rule above.
- A tier map that is missing a tier or references a model without a binding for that harness is dropped with a warning; the rest of the catalog still loads. Auto bindings accept only `tiers`; any other field drops that harness's Auto binding the same way. For a binding whose tiers are all strings, Auto offers only the reasoning choices that all three tier models support, and a selection that asks for another reasoning value is rejected. A binding with candidate lists offers every candidate's choices; a candidate that lacks the requested choice runs on its own default.
- `resolveAutoSelection(selection, tier | null)` in `src/lib/chat-agents.ts` turns an Auto selection into the first enabled candidate's `{ harnessId, modelId, reasoning }`; `null` means `balanced`. `resolveAutoPinnedSelection` restores the harness and model a stored routing recorded. Chat pins persist their `harnessId` (column `routed_harness_id`, migration `0087`); pins written before that column ran on the selection's harness. `isAutoSelection` and `harnessSupportsAuto` are the matching helpers.
- Tier maps also serve objective trigger tiers: `GET /projects/:pid/objectives/:oid/runtime-tiers` resolves each named tier (`fast`, `balanced`, `frontier`) from the tier map for the objective's effective harness. This needs no routing engine: the maps are valid with `MODEL_ROUTING_ENGINE=off`, and no Jev call is made. A harness without a tier map has no objective tiers. Runs without an objective (project chats, task runs) use `GET /projects/:pid/runtime-tiers`, which returns the same shape from the project layer (project Kanban runtime, then `defaults.kanban.fallback`). `?harness=<id>` resolves that harness's Auto tier map instead (`effective` is its balanced tier); the project's reasoning is carried over only when the project itself runs that harness, otherwise it is omitted. An unknown or not installed harness returns 400, a privacy-refused effective runtime 403, an unknown project 404.
- The routing decision is made only at cache-cold points (a new conversation, after compaction, a fresh Kanban session) and is then pinned; it is not re-evaluated on every turn.

### Auto in Kanban

When the effective Kanban selection for a run (task → stage → project → catalog default) is Auto and `MODEL_ROUTING_ENGINE=jev`, the executor applies it as follows (`src/modules/kanban/task/pipeline.ts`, `auto-routing.ts`):

- **Only fresh sessions are routed.** A run that starts a new session (automatic stage entry, a requested fresh session, an agent change, or a Testing/Review run that does not resume a persisted session) calls `routeText(title + description)` once. A run that continues a session, including restart recovery, keeps the concrete model and harness recorded for that stage and never calls the router, so the model is pinned for the life of the session. If that candidate is no longer enabled, a run that resumes its session, or a recovery or transient retry, fails rather than switching, but only when the stage's newest session belongs to that candidate. Any other run, including one requested with a fresh session, routes again among the currently enabled candidates. A record without `sessionAgentKey` cannot prove ownership, so its resumed session fails.
- **The decision is recorded** in `custom_values.routing[stageId]` as `{ tier, rawTier, harnessId, modelId, sessionAgentKey, confidence, sensitive, latencyMs, reason, at }`, plus the `rejection_count` and `testing_failure_count` seen at the time (`rejectionCount`, `testingFailureCount`). Other custom values are left untouched. Records written before `harnessId` existed run on the Auto selection's harness. If the router returns nothing, the run uses `balanced` and the reason is `router-unavailable`. With the engine `off`, Auto resolves to `balanced` without a router call or a record.
- **Stage minimum tier.** A stage may set `minTier` (`fast`, `balanced` or `frontier`) through `set_project_stages` or the project settings API (the stage editor does not show it). The effective tier is the higher of the routed tier and `minTier`, and the reason becomes `stage-min-tier` when `minTier` raised it. The floor also applies with the engine `off`: the stage then records a decision only when `minTier` is above `balanced`, and the router is never called.
- **Escalation after a rejection or testing failure.** If a fresh session in a stage follows an increase in `rejection_count` or `testing_failure_count` since the stored decision, the tier is chosen from the latest review comparison (`review_history`) instead of simply asking the router again:
  - `no_progress` or `persistent_issue`: one tier above the stored tier, capped at `frontier`, with no router call (`escalation-no-progress`).
  - `resolved_issue`: the stored tier, with no router call (`escalation-kept`).
  - `new_issue`, `ambiguous`, a missing comparison, or a testing failure: Jev decides from the task text plus the latest review issues, and the higher of the stored tier and Jev's tier is used, so the tier never goes down (`escalation-router`). If Jev is unavailable the stored tier is kept.
- **Transient-error retries never change the model**; the retry reuses the recorded decision.
- **Transient-error retries are capped.** A task gets at most 5 runs per transient provider error (overloaded, rate limit, capacity, service unavailable), counted in `custom_values.transient_retries`. Retries wait 2, 4, 8 and 16 minutes; the 5th transient error moves the task to the `failed` stage with a "retries exhausted" error. A run that ends without a transient error resets the count. Only the last two lines of the runner error (plus `API Error` lines) are matched, so earlier agent output that mentions a rate limit does not count.
- **An explicit concrete model always wins.** Only a task or stage whose selection is `auto` is routed. `harness-configured-default` and any concrete model are used as selected and the router is never called.

## Jev settings and hosted failover

Every Jev call (Auto routing, memory capsule, knowledge verification, web and public-content screening) goes through `src/lib/jev-client.ts`, configured by `JEV_URL`, `JEV_API_KEY`, `JEV_MODEL`, `JEV_BATCH` and `JEV_TIMEOUT_MS`. When the primary is a local ninfer server that is sometimes stopped, set a hosted fallback:

| Variable                  | Default     | Meaning                                                                                                      |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `JEV_FALLBACK_URL`        | unset       | Hosted Jev, e.g. `http://api-relay:8080/jev`. Unset disables failover entirely.                              |
| `JEV_FALLBACK_API_KEY`    | empty       | Bearer token for the fallback.                                                                               |
| `JEV_FALLBACK_MODEL`      | `JEV_MODEL` | Checkpoint sent to the fallback, e.g. `jev-latest`.                                                          |
| `JEV_FALLBACK_BATCH`      | `false`     | Whether the fallback has a batch endpoint; the hosted API does not, so batches become parallel single calls. |
| `JEV_BREAKER_FAILURES`    | `3`         | Consecutive primary outages after which the primary is skipped.                                              |
| `JEV_BREAKER_COOLDOWN_MS` | `300000`    | How long the fallback is used exclusively before the primary is tried again.                                 |

Behavior:

- A call without an explicit `url` that fails on the primary with a network error, timeout or HTTP 5xx is retried once on the fallback (its own URL, key, model and batch setting). HTTP 4xx, malformed responses, config errors and privacy refusals never fail over. A caller-supplied `signal` is shared by both attempts; otherwise the fallback gets its own `JEV_TIMEOUT_MS`.
- Privacy is unchanged: the fallback passes the same per-call gate. Projects in `strict` or `local_memory` mode refuse a non-local URL, so they never reach the fallback and see the primary error, exactly as without failover. Keep the fallback URL out of `PRIVACY_LOCAL_ENDPOINT_PREFIXES`. Projects with `off` may use it.
- The circuit breaker is per process. After `JEV_BREAKER_FAILURES` consecutive primary outages the primary is skipped for `JEV_BREAKER_COOLDOWN_MS`; the next call afterwards probes the primary again (success resets, failure re-opens). Calls from projects that refuse the fallback bypass the breaker and always try the primary.
- Each failed attempt logs a `warn` (`event: jev_attempt_failed`, `endpoint`, `kind`, `status`, `path`, `projectId`; never request text), and the breaker logs an `info` line when it opens (`jev_breaker_open`) and closes (`jev_breaker_closed`).
- Hosted Jev may score differently from ninfer. `JEV_MIN_SCORE`, the knowledge threshold (0.5) and the web injection threshold (0.8) were tuned on ninfer.

## Where the file lives

- Inside the board container: `<DATA_DIR>/board_agents.jsonc`
- For the host-side workspace used by the bundled agent images: `ai-knowledge-base/data/board_agents.jsonc`

If the file does not exist on first boot, the board writes a minimal valid v2
catalog with a `direct` harness and `default` model. A top-level array is
invalid; the loader accepts only an object with `"version": 2`.

## JSON Schema

A JSON Schema for `board_agents.jsonc` is checked in at [`schemas/board_agents.schema.json`](../schemas/board_agents.schema.json). It gives you autocomplete, hover descriptions, and inline validation in any editor that speaks JSON Schema.

### VS Code / Cursor

Add to your workspace `.vscode/settings.json`:

```jsonc
{
  "json.schemas": [
    {
      "fileMatch": ["**/board_agents.jsonc"],
      "url": "./carapa-board/schemas/board_agents.schema.json",
    },
  ],
}
```

Adjust the `url` if your carapa-board checkout lives somewhere else, or replace it with the published `$id` URL once the repo is public.

### Validating from the CLI

```bash
bunx ajv-cli validate \
  -s carapa-board/schemas/board_agents.schema.json \
  -d ai-knowledge-base/data/board_agents.jsonc \
  --strict=false
```

(Strip comments first — `ajv` doesn't read JSONC. The board's loader handles `// …` and `/* … */` itself, but external validators need pure JSON.)

## Reloading

The board watches `board_agents.jsonc` and invalidates its cache 150 ms after any change. No restart needed.

If a hot reload fails, the board logs the error and retains the last known-good
v2 catalog. If no valid catalog has loaded yet, it uses the minimal built-in v2
catalog.

## See also

- [`CACHE-OPTIMIZATION.md`](CACHE-OPTIMIZATION.md) — how direct bindings benefit from Anthropic prompt caching (system prompt layout, `cache_control` markers, UI hit-rate badge). CLI harnesses don't go through this path; they discover their own context from CWD.
