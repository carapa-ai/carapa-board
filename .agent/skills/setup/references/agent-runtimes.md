# Agent runtimes: from a harness to a working agent

A Board agent needs four things to line up. Walk the user through them in
order for **each** harness they chose; skipping one gives a harness that never
appears in the picker, or a chat that spins on a 401.

1. **Harness installed** in CarapaBox's shared harness volume.
2. **Provider account connected** in Board → **Provider accounts** (sign-in or
   API key). Credentials stay with CarapaBox's relay; the sandbox only ever sees
   placeholders. Never copy host credentials into the agent home.
3. **The harness's own configuration**, for the harnesses that have one
   (Codex, Pi, OMP, Prime, Hermes, OpenCode).
4. **A catalog entry** in `$DATA_DIR/data/board_agents.jsonc`.

Then **verify** (end of this file).

Status of each recipe:

- **Verified** means it ran end to end (account → relay → model answer).
- **In use** means it runs daily on the maintainers' deployment, but has not
  been re-run on a fresh install.
- **From code** means it was assembled from the Box/Board sources and
  has not been run yet. Confirm it with the verification step and report what
  had to change.

## 1. Install the harness

```bash
. ~/.carapa/install.env
python3 "$STACKS_DIR/carapa-bot/harness.py" status            # what is installed
python3 "$STACKS_DIR/carapa-bot/harness.py" install <name>    # add one
```

Install names:

- `claude`, `codex`, `pi`, `omp`, `opencode`, `prime-agent`, `hermes`
- `grok`, `cursor`, `muse`, `vibe`, `antigravity`, `antigravity-acp`
- `playwright` (browser-skill tooling, not an agent: keep it, give it no catalog entry)

The Alpine image does not support `antigravity-acp`, `cursor`, `grok`, `muse`, `omp` or `vibe`.

`playwright` is pinned by the installer; asking for another version is
refused. New sandboxes pick up a newly installed harness. If Board's
**Provider accounts** login needs the harness (Claude, Codex, Antigravity,
Cursor sign-in), set CarapaBox's `PROVIDER_LOGIN_HARNESS_VOLUME` to the
volume `status` prints (CarapaBox `docs/provider-accounts.md`).

## 2. Connect the provider account

In Board, open the administration menu, then **Provider accounts**. Use **Connect** for a sign-in, or **Save key** for an API key, which CarapaBox checks with the provider before storing.

| Account                                                                                   | Kind    | Relay route              | Gives a model list      |
| ----------------------------------------------------------------------------------------- | ------- | ------------------------ | ----------------------- |
| `anthropic` (Claude)                                                                      | sign-in | `/anthropic`             | yes                     |
| `codex` (ChatGPT)                                                                         | sign-in | `/codex`                 | yes                     |
| `antigravity` (Google)                                                                    | sign-in | `/antigravity`           | yes                     |
| `xai` (Grok)                                                                              | sign-in | `/xai`                   | no (harness reports it) |
| `meta` (Muse)                                                                             | sign-in | `/meta`, `/muse-code`    | no (harness reports it) |
| `cursor`                                                                                  | sign-in | `/cursor`                | no (harness reports it) |
| `anthropic-api`, `openai`, `google`, `openrouter`, `mistral-eu`, `mistral-vibe`, `nvidia` | API key | same name as the account | no                      |

If the screen says _Provider account operation failed_, CarapaBox's
`PROVIDER_ACCOUNTS_DIR` is not set up (CarapaBox `docs/provider-accounts.md`,
one-time operator setup). The quick installer sets it; re-run it for an older
installation. If a sign-in ends in _Login failed_, check that the Squid egress
proxy is running (SKILL.md, _Troubleshooting_).

On a box connected to a hub (`RELAY_MODE=forward` in CarapaBox's
`egress-proxy/.env`), accounts must be connected on the **hub's** Board; an
account connected locally is ignored and calls fail with
`Forwarder not authorized`.

## 3. Catalog rules for every harness

The catalog is `$DATA_DIR/data/board_agents.jsonc`, a version-2 object (see `docs/AGENTS-CONFIG.md`). Board reloads it on save.

**It must be valid.** A top-level array (the old v1 format) or any other invalid file is rejected. Board then keeps the previous catalog and logs `Invalid board_agents.jsonc`. Check with:

```bash
docker logs carapa-board 2>&1 | grep -E "board_agents|Discovered models"
```

**Harness definition:**

- `kind` is `"cli"` for every agent harness, ACP ones included. `"direct"` is for HTTP endpoints.
- `agentCmd` must name a CarapaBox adapter: `claude`, `codex`, `pi`, `opencode`, `agy-sdk`, `antigravity-acp`, `cursor-acp`, `grok-acp`, `hermes-acp`, `muse-acp`, `omp-acp`, `prime-agent-acp` or `vibe-acp`. CarapaBox rejects anything else with `unsupported agent harness`.
- **For an `-acp` harness, the harness id must equal its `agentCmd`** (for example `"grok-acp"`). Board stores the models an ACP harness reports under that name; with any other id it never finds them.

**Where models come from:**

- `discover: { "account": "<provider>" }` takes the models from a connected account. Only `anthropic`, `codex` and `antigravity` provide a list.
- Add `"from": "harness"` when the harness only accepts names it reports itself. After its account connects, Board runs one probe session in the main group's sandbox to collect them.
- When neither applies (API-key accounts, Pi, OMP, Prime, Hermes, OpenCode), declare models by hand under `models.<id>.bindings.<harnessId>.model`. Section 4 shows how these harnesses reach a ChatGPT sign-in or an Anthropic API key.

**Hidden harnesses:** a harness with no models is hidden in the picker. Adding entries for accounts that aren't connected yet is harmless.

**`env`** on a harness or binding overrides the sandbox stack's environment.

**Defaults:** `defaults.chat` and `defaults.kanban.fallback` must name a harness and model that exist. Set them to the first harness the user verifies.

**Reasoning:** the selected reasoning effort reaches every adapter as `reasoningEffort`. Use `reasoning.envVar` only if a launcher needs an extra variable. No CarapaBox adapter reads `CODEX_REASONING_EFFORT`.

## 4. Connections: one account, several harnesses

A **connection** is a named relay route in the catalog's top-level `connections` block. A binding or a `discover` block points at it with `"connection": "<name>"`. This is how one provider account serves more than its own harness.

What a connection gives each kind of harness:

- **Direct** (`kind: "direct"`, Board calls the model itself, no sandbox harness): `baseUrl` is the endpoint and `wireApi` the protocol. This is all Direct needs.
- **CLI harnesses**: only the connection's `env` reaches the sandbox. `baseUrl` and `wireApi` are not passed to the harness; they tell Board where the binding goes (local or remote, which account's usage to show). The harness still needs its own provider configuration from the recipes below.

Values merge from least to most specific: harness, connection, model, binding. A binding's `env` key wins.

### ChatGPT subscription for other harnesses: `codex-relay`: verified for Direct and Pi

One **codex** sign-in (section 2) serves Codex itself and every harness that speaks the Codex Responses protocol. The relay adds the ChatGPT token on `/codex`, so the harnesses only carry a placeholder key.

```jsonc
"connections": {
  "codex-relay": { "baseUrl": "http://api-relay:8080/codex", "wireApi": "responses" }
}
```

Add the `direct` harness (`{ "label": "Direct LLM", "kind": "direct" }`) if the catalog has none; without it Direct is missing from the picker. Then bind **every** model the account offers, not just one: Direct takes all of them, and Pi, OMP and Prime take those their `carapa-codex` provider lists (below). The model name differs by harness:

| Harness           | `model` in the binding     | What makes it use `/codex`                                             |
| ----------------- | -------------------------- | ---------------------------------------------------------------------- |
| `codex`           | `gpt-6.2-sol`              | its `config.toml` (Codex recipe); no `connection` needed               |
| `direct`          | `gpt-6.2-sol`              | the connection's `baseUrl` and `wireApi`                               |
| `pi`              | `carapa-codex/gpt-6.2-sol` | the managed `carapa-codex` provider in `pi-models.json`                |
| `omp-acp`         | `carapa-codex/gpt-6.2-sol` | the managed `carapa-codex` provider in `omp-models.json`               |
| `prime-agent-acp` | `carapa-codex/gpt-6.2-sol` | the managed `carapa-codex` provider in `prime-models.json`             |
| `hermes-acp`      | `gpt-6.2-sol`              | `HERMES_INFERENCE_PROVIDER` and `OPENAI_BASE_URL` in the binding `env` |

```jsonc
"models": {
  "gpt-6.2-sol": {
    "label": "GPT-6.2 Sol",
    "bindings": {
      "codex":  { "model": "gpt-6.2-sol" },
      "direct": { "connection": "codex-relay", "model": "gpt-6.2-sol",
                  "contextSize": 500000, "maxTokens": 128000 },
      "pi":     { "connection": "codex-relay", "model": "carapa-codex/gpt-6.2-sol", "contextSize": 500000 },
      "omp-acp": { "connection": "codex-relay", "model": "carapa-codex/gpt-6.2-sol", "contextSize": 500000 },
      "prime-agent-acp": { "model": "carapa-codex/gpt-6.2-sol", "contextSize": 500000 },
      "hermes-acp": {
        "connection": "codex-relay", "model": "gpt-6.2-sol", "contextSize": 500000,
        "env": {
          "HERMES_INFERENCE_PROVIDER": "carapa-codex",
          "OPENAI_BASE_URL": "http://api-relay:8080/codex"
        }
      }
    }
  }
}
```

- The `carapa-codex` providers list a fixed set of models (`gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `gpt-6-luna`). For another model, add it to the provider in CarapaBox's `stacks/carapa-bot/<pi|omp|prime>-models.json` and rebuild the image.
- Only the `codex` harness discovers models from the account. Every other binding is written by hand: after the account connects, take each model's `id`, `name` (as the `label`) and `contextSize` from `accounts.codex.models` in `$DATA_DIR/data/board_agents.discovered.json`, and write one `models` entry per id, with a `direct` binding for all of them and a `pi` binding for those in Pi's list. The example above shows the shape for one model.
- Usage on all of these counts against the same ChatGPT plan.

### Claude for other harnesses: API key only (`anthropic-api`): in use

**The Claude subscription sign-in (`anthropic` account, `/anthropic` route) is for the Claude Code harness only.** Anthropic does not allow subscription sign-ins in other tools. Every other harness that runs a Claude model must use an **Anthropic API key**, billed to Console credits:

1. In **Provider accounts**, save a key under **Anthropic API (key)**. A key that is not scoped to one workspace also needs its **Workspace ID** (`wrkspc_…`, Claude Console → Workspaces).
2. The relay serves it on `/anthropic-api`. That route always sends the API key and never the subscription token.
3. Add the connection:

```jsonc
"connections": {
  // baseUrl is Anthropic's OpenAI-compatible endpoint, used by Direct.
  "anthropic-api": {
    "baseUrl": "http://api-relay:8080/anthropic-api/v1",
    "env": { "ANTHROPIC_BASE_URL": "http://api-relay:8080/anthropic-api" }
  }
}
```

Harnesses that can use it:

| Harness                          | `model`          | Notes                                                                                      |
| -------------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `direct`                         | `<id>`           | uses the connection's `baseUrl`                                                            |
| `pi`                             | `anthropic/<id>` | Pi's built-in `anthropic` provider; `pi-models.json` already points it at `/anthropic-api` |
| Claude Code, as a second harness | `<id>[1m]`       | same `agentCmd: "claude"`, billed to the key instead of the plan                           |

```jsonc
"harnesses": {
  "pi": {
    "label": "Pi", "kind": "cli", "agentCmd": "pi", "icon": "/harness-icons/pi.svg",
    "discover": {
      "account": "anthropic", "connection": "anthropic-api", "model": "anthropic/${id}",
      "capabilities": ["image"],
      "reasoning": { "options": ["low", "medium", "high"], "default": "medium" }
    }
  },
  "claude-api": {
    "label": "Claude Code (API credits)", "kind": "cli", "agentCmd": "claude",
    "sessionFamily": "claude", "icon": "/harness-icons/anthropic.svg",
    "discover": {
      "account": "anthropic", "connection": "anthropic-api", "model": "${id}[1m]",
      "capabilities": ["image"],
      "reasoning": { "options": ["low", "medium", "high"], "default": "medium" }
    }
  }
}
```

- **The model list still comes from the sign-in.** API-key accounts give no model list, so `discover.account: "anthropic"` fills in only when a Claude sign-in is also connected. The `connection` then sends those models to the API key. With an API key and no sign-in, drop `discover` and declare each model by hand:
  ```jsonc
  "claude-sonnet-5-5": { "label": "Claude Sonnet 5.5",
    "bindings": { "pi": { "connection": "anthropic-api", "model": "anthropic/claude-sonnet-5-5" } } }
  ```
- Do not use a reasoning option of `off` with Pi: the Claude 5.5 models reject disabled thinking.
- OMP, Prime and Hermes have no managed Anthropic provider. Do not point them at `/anthropic`. To run Claude there, add an `/anthropic-api` provider to their models file in CarapaBox (untested).

## 5. Recipes

### Claude Code: verified

- Install: `claude`.
- Account: **anthropic** (Claude subscription sign-in). To bill an API key instead, add the `claude-api` harness from section 4.
- Own config: none. The stack sets `ANTHROPIC_API_KEY` to a placeholder and `ANTHROPIC_BASE_URL` to the relay, and the relay supplies the account's token. The agent home's `.claude/.credentials.json` needs no `claudeAiOauth` entry.

```jsonc
"claude": {
  "label": "Claude Code", "kind": "cli", "agentCmd": "claude",
  "sessionFamily": "claude", "icon": "/harness-icons/anthropic.svg",
  "discover": {
    "account": "anthropic", "model": "${id}[1m]", "capabilities": ["image"],
    "reasoning": { "options": ["low", "medium", "high"], "default": "medium" }
  }
}
```

### Codex: verified

- Install: `codex`.
- Account: **codex** (ChatGPT sign-in).
- Own config: CarapaBox does not create one. Write `$AGENT_HOME_DIR/.codex/config.toml` (an existing one only needs `model_provider` pointing at a provider whose `base_url` is the `/codex` route; `forced_login_method = "api"` is optional and verification passed without it):
  ```toml
  forced_login_method = "api"
  model_provider = "relay"

  [model_providers.relay]
  name = "relay"
  base_url = "http://api-relay:8080/codex"
  wire_api = "responses"
  ```
- Make sure `$AGENT_HOME_DIR/.codex/auth.json` does **not** exist. With it, Codex goes to chatgpt.com directly, bypassing the relay.
- Each run copies `config.toml` (and any `<profile>.config.toml`) into a per-run Codex home. Edits apply on the next run.
- `CODEX_PROFILE` (catalog `env`) selects `$AGENT_HOME_DIR/.codex/<profile>.config.toml`. Its `model_provider` must name a provider defined in `config.toml`.
- Only the ChatGPT route (`/codex`) is documented. An OpenAI API key through `/openai` is untested.
- Codex may warn `Model metadata for <model> not found` for models newer than the installed CLI. It falls back to default metadata and still answers.

```jsonc
"codex": {
  "label": "Codex", "kind": "cli", "agentCmd": "codex",
  "icon": "/harness-icons/codex.svg",
  "discover": { "account": "codex" }
}
```

The account's model list carries the reasoning levels, so no `reasoning` block is needed.

### Antigravity (ACP): from code

- Install: `antigravity-acp`.
- Account: **antigravity** (Google sign-in).
- Own config: none. The route must be set in the catalog: without it the harness uses the stack's `/google` route, which needs a Google **API key** instead.
- Do not add `reasoning`: it would replace the per-effort model map that `effortVariants` builds.

```jsonc
"antigravity-acp": {
  "label": "Antigravity", "kind": "cli", "agentCmd": "antigravity-acp",
  "icon": "/harness-icons/antigravity.svg",
  "env": {
    "ANTIGRAVITY_ACP_AUTH_METHOD": "gemini-api-key",
    "GOOGLE_GEMINI_BASE_URL": "http://api-relay:8080/antigravity"
  },
  "discover": {
    "account": "antigravity", "from": "harness",
    "effortVariants": ["low", "medium", "high"]
  }
}
```

The Python SDK variant (install `antigravity`, `agentCmd: "agy-sdk"`) uses the
same `GOOGLE_GEMINI_BASE_URL` setting. Whether it accepts the account's model
ids is unverified; prefer `antigravity-acp`.

### Pi: verified with `carapa-codex`; other providers in use

- Install: `pi`.
- Account: depends on the **Pi provider** in the model name. Pi picks its relay route from the provider prefix, so Board must send `<provider>/<model>`.
- Own config: Pi's `models.json`. Every container start merges CarapaBox's managed providers into `$AGENT_HOME_DIR/.pi/agent/models.json`. Same-named providers are replaced; other providers are kept.

| Pi provider                 | Route            | Account needed                                 |
| --------------------------- | ---------------- | ---------------------------------------------- |
| `carapa-codex`              | `/codex`         | **codex** sign-in                              |
| `anthropic`                 | `/anthropic-api` | **anthropic-api** key (not the Claude sign-in) |
| `carapa-openrouter`         | `/openrouter/v1` | **openrouter** key                             |
| `carapa-mistral-eu`         | `/mistral-eu`    | **mistral-eu** key                             |
| `llama-proxy`, `freellmapi` | local models     | none                                           |

- **To add a model:** add a provider under a **new name** in `$AGENT_HOME_DIR/.pi/agent/models.json`, which survives the merge. To change a managed provider, edit CarapaBox's `stacks/carapa-bot/pi-models.json` and rebuild the image; edits to managed providers in the agent home are overwritten.
- Declare models by hand with the full `provider/model` name and the matching connection from section 4. Use a model the provider lists in `models.json`; unlisted ids are untested. Claude models over the API key are the exception: they can be discovered (section 4).

```jsonc
"harnesses": {
  "pi": { "label": "Pi", "kind": "cli", "agentCmd": "pi", "icon": "/harness-icons/pi.svg" }
},
"models": {
  "gpt-6.2-sol": { "label": "GPT-6.2 Sol",
    "bindings": { "pi": { "connection": "codex-relay", "model": "carapa-codex/gpt-6.2-sol" } } }
}
```

### OMP: from code

- Install: `omp`.
- Account: by provider, as with Pi. The managed providers are in CarapaBox's `stacks/carapa-bot/omp-models.json`:
  - `carapa-codex` uses a **codex** sign-in;
  - `carapa-openrouter` an **openrouter** key;
  - `carapa-nvidia` an **nvidia** key;
  - the `carapa-llama`, `carapa-ollama`, `carapa-vllm` and `carapa-freellmapi` providers are local.
- Own config: both files are applied at every container start.
  - `~/.omp/agent/models.yml` is merged from `omp-models.json`, replacing same-named providers.
  - `config.yml` is merged from `omp-settings.json`, and **the template wins**: its `enabledModels`, `modelRoles` and `modelProviderOrder` replace your own.
  - To enable a model reliably, edit `stacks/carapa-bot/omp-settings.json` and `omp-models.json` in CarapaBox and rebuild the image.
  - OMP uses `$PI_CODING_AGENT_DIR` instead of `~/.omp/agent` when it is set, the same variable Pi uses.
- The harness id must be `omp-acp`. Declare models by hand as `provider/model`; whether OMP's reported model names match an account list is unknown.

```jsonc
"omp-acp": { "label": "OMP", "kind": "cli", "agentCmd": "omp-acp", "icon": "/harness-icons/omp.svg" }
// models.<id>.bindings["omp-acp"].model = "carapa-codex/gpt-6.2-sol"
```

### Prime Agent: from code

- Install: `prime-agent`.
- Account: **codex** sign-in, for the managed `carapa-codex` provider.
- Own config: `~/.prime/agent/models.json` is merged from CarapaBox's `stacks/carapa-bot/prime-models.json` at container start. Every run also rewrites `carapa-codex`'s connection to the relay and keeps its model list. To add a Codex model, add it to that provider in `prime-models.json` and rebuild the image, or define a provider under a new name in the agent home.
- The harness id must be `prime-agent-acp`. Declare models as `carapa-codex/<model>`. The model and reasoning are fixed when the session starts.

```jsonc
"prime-agent-acp": { "label": "Prime", "kind": "cli", "agentCmd": "prime-agent-acp", "icon": "/harness-icons/prime.svg" }
```

### Grok: from code

- Install: `grok`.
- Account: **xai** (sign-in).
- Own config: none; the adapter points Grok at the relay itself.

```jsonc
"grok-acp": { "label": "Grok", "kind": "cli", "agentCmd": "grok-acp",
  "icon": "/harness-icons/grok.svg",
  "discover": { "account": "xai", "from": "harness" } }
```

### Cursor: from code

- Install: `cursor`.
- Account: **cursor** (sign-in; it lasts about 60 days, then reconnect).
- Own config: none.

```jsonc
"cursor-acp": { "label": "Cursor", "kind": "cli", "agentCmd": "cursor-acp",
  "icon": "/harness-icons/cursor.svg",
  "discover": { "account": "cursor", "from": "harness" } }
```

### Muse: from code

- Install: `muse`.
- Account: **meta** (sign-in).
- Own config: none.

```jsonc
"muse-acp": { "label": "Muse", "kind": "cli", "agentCmd": "muse-acp",
  "icon": "/harness-icons/meta.svg",
  "discover": { "account": "meta", "from": "harness" } }
```

### Vibe: from code

- Install: `vibe`.
- Account: **mistral-vibe** API key.
- Own config: none; the adapter supplies the relay provider and its models.
- `discover` with `from: "harness"` relies on the probe that runs after the key is saved. This is untested; if no models appear, declare them by hand.

```jsonc
"vibe-acp": { "label": "Vibe", "kind": "cli", "agentCmd": "vibe-acp",
  "icon": "/harness-icons/mistral.svg",
  "discover": { "account": "mistral-vibe", "from": "harness" } }
```

### Hermes: from code

- Install: `hermes`.
- Account: **codex** sign-in, when routed through the relay.
- Own config: by default Hermes uses the local `llama-proxy`. Set `HERMES_INFERENCE_PROVIDER=carapa-codex` in the catalog `env` to send it through `/codex`. A model is then required, and a `carapa-codex/` prefix is accepted.
- The harness id must be `hermes-acp`. Declare models by hand.

```jsonc
"hermes-acp": { "label": "Hermes", "kind": "cli", "agentCmd": "hermes-acp",
  "icon": "/harness-icons/hermes.svg",
  "env": { "HERMES_INFERENCE_PROVIDER": "carapa-codex" } }
```

### OpenCode: not wired to the relay

- Install: `opencode`.
- CarapaBox gives OpenCode no relay provider configuration. The operator must write `$AGENT_HOME_DIR/.opencode/opencode.jsonc`, and no relay route has been verified for it.
- Offer OpenCode only for local models (llama-proxy). Tell the user that subscription or API-key use through the relay is not set up yet.

## 6. Verify each harness

1. **Models appear.** Reload Board. The picker should list the harness and its models. If not:
   - check the catalog log line from section 3;
   - check that the account shows as connected;
   - for an `-acp` harness, check that its id equals its `agentCmd`.
2. **A chat answers.** Start a new chat with that harness and send _Reply with OK_, using the provider's **cheapest model** (for ChatGPT `gpt-6-luna`, for Claude Haiku). A check needs no capability, and it spends the user's plan or credits. The same applies to any test call you run yourself in the sandbox. If it spins:
   ```bash
   docker exec <sandbox>-agent-1 sh -c 'ls -td /workspace/ipc/runs/run-* | head -1'
   # in that run directory: <harness>.raw.jsonl / output.jsonl / agent-stderr.log
   ```
   - A repeated `401` / `authentication_failed` means the relay has no credential for that route: wrong account type, or a box in hub mode.
   - `Forwarder not authorized` means the box is in hub mode; see section 2.
3. **Record the result.** Tell the user which harnesses were verified, and which were configured but could not be tested because the account isn't connected.
