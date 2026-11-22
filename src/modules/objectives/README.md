# Objectives Module

## Overview

Optional SMART objectives module with CarapaBrain integration. When enabled, registers objective-related MCP tools and REST endpoints. When disabled, objective endpoints return 404 and tools are not registered.

## How it works

- Gated by `ENABLE_OBJECTIVES=true` (read from `src/config.ts`)
- Contributes:
  - **MCP tools** via `registerTools()`: `create_objective`, `list_objectives`, `get_objective`, `update_objective`, `delete_objective`, `move_objective`, `refresh_dashboard`, `ack_objective_task_event`
  - **Express routes** via `getRouter()`: mounts `src/routes/objectives.ts` (REST CRUD + dashboard serving)
  - **Config flag**: `enableObjectives: true` so the UI shows objectives UI (header button, sidebar, iframe dashboard)
- Integration pattern: **direct contribution** — tools and routes registered via lifecycle hooks, no core hooks or singletons

## Files

| File       | Purpose                                                       |
| ---------- | ------------------------------------------------------------- |
| `index.ts` | `CarapaModule` implementation — registers tools and router    |
| `tools.ts` | MCP tool definitions for objective CRUD + `refresh_dashboard` |

Supporting code for objectives:

- `src/routes/objectives.ts` — REST API routes
- `src/modules/objectives/objective-folder.ts` — folder creation, context writing, state management
- `src/modules/objectives/brain-client.ts` — event publishing to CarapaBrain

## Environment variables

| Variable            | Default | Description                        |
| ------------------- | ------- | ---------------------------------- |
| `ENABLE_OBJECTIVES` | `false` | Set to `true` to enable the module |

Additional brain-related config (not part of this module but used by the objectives system):

- The token for the CarapaBrain REST API is the per-project `brainAuthToken` setting (inherited from the parent project). The board reads no `CARAPA_BRAIN_AUTH_TOKEN`; that variable belongs to the brain container
- Brain container URL is resolved per-project from group settings (`brainContainer`)

## Objective event runtime protocol

`eventRuntimeSelection` is an optional Board-side override used only for
autonomous objective event handling. A null value inherits the project Kanban
runtime. There is no command/model adapter; writes use only the structured
selection.

For objective events, `POST /events` sends the effective launch contract under
`payload`:

```json
{
  "agent_cmd": "codex:gpt-6.1-sol",
  "agent_model": "gpt-6.1-sol",
  "agent_executable": "codex",
  "agent_session_key": "codex@relay",
  "runtime_selection": {
    "harnessId": "codex",
    "modelId": "gpt-6.1-sol",
    "reasoning": "high"
  },
  "reasoning_effort": "xhigh"
}
```

`reasoning_effort` is the provider-facing value after the runtime catalog's
reasoning map; it is `null` when an explicit disabled choice maps to no provider
effort value. The same snake-case fields are nested under `objective` in
`POST /init-objective`. CarapaBrain exclusively owns `state.json`; Board sends
status and runtime changes through `objective_updated` events and stores its
derived accounting in `board-cost-metrics.json`. State-affecting events remain
in `board-brain-state-events.json` until Brain acknowledges them. Keeping a
single state writer prevents either process from renaming a stale full-file
snapshot over the other's update.

### Runtime tiers

Events the brain originates never pass through Board, so it asks for the
objective's runtimes with `GET /projects/:pid/objectives/:oid/runtime-tiers`
(same project access as the other objective routes, including the per-project
agent token):

```json
{
  "effective": {
    "agent_cmd": "codex:gpt-6.1-sol",
    "agent_model": "gpt-6.1-sol",
    "agent_executable": "codex",
    "agent_session_key": "codex@relay",
    "runtime_selection": {
      "harnessId": "codex",
      "modelId": "gpt-6.1-sol",
      "reasoning": "high"
    },
    "reasoning_effort": "xhigh",
    "agent_env": {},
    "fallback_model": null,
    "fallback_reasoning_effort": null
  },
  "tiers": { "fast": {}, "balanced": {}, "frontier": {} },
  "unavailableTiers": [{ "tier": "fast", "reason": "..." }],
  "pricing": {}
}
```

- `effective` carries the event fields above (same helper as event
  attachment, no secret env values) plus the capacity `fallback_*` values;
  `agent_env` is `{}` when empty.
- Each entry of `tiers` has the same shape. The base is the effective
  selection when it is an Auto selection, otherwise the effective harness's
  Auto model with the effective reasoning. Each tier resolves through the
  catalog's tier map, so a candidate on another harness returns that harness's
  own command, model, session key and env. No routing engine or Jev call is
  involved.
- A tier that cannot resolve (unsupported reasoning, refused by privacy mode)
  is omitted from `tiers` and listed in `unavailableTiers` with the error
  message. A harness without a tier map gives `tiers: {}` and one
  `unavailableTiers` entry per tier ("no auto tier map for harness X").
- 404 for an unknown objective or one of another project; 403 when the
  effective runtime is refused by privacy mode; 422 when it does not resolve.

CarapaBrain is a separate consumer. Board tests verify the outgoing runtime
selection, mapped reasoning effort, executable, and session fields with mocks.
Live consumer execution remains unverified in the Board sandbox.

## Disabling

Set `ENABLE_OBJECTIVES=false` or leave it unset. Objective MCP tools won't be registered, REST endpoints won't be mounted, and the UI will hide all objectives surfaces.

For full objectives documentation, see `docs/OBJECTIVES.md`.
