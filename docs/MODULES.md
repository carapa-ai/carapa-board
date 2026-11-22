# CarapaBoard Module System

## Architecture Overview

Optional capabilities are packaged as modules. The module system is a thin registration + lifecycle layer — not a plugin framework. Modules are registered explicitly at boot, never discovered dynamically.

```
src/modules/
├── loader.ts          # Registry + aggregate lifecycle helpers
├── types.ts           # CarapaModule interface contract
├── tools/             # Tool registry + dispatch infrastructure (NOT a module)
├── messaging/         # Provider-registry abstraction (NOT a module)
├── whisper/           # Audio transcription (OpenAI / Groq)
├── vector-store/      # Neo4j semantic memory search
├── whatsapp/          # WhatsApp messaging via carapa-wa-link (plugs into messaging/)
├── objectives/        # SMART goals + CarapaBrain integration
├── knowledge/         # Shared Knowledge Bases & RAG
├── web/               # Web fetch / search agent tools (default-on)
├── fs/                # Sandbox-bound filesystem agent tools (default-on)
├── gitnexus/          # GitNexus Hub code-intelligence tools
├── memory/            # memorize / recall / forget tools and reflector (sibling — used by kanban git-ops too)
├── transcripts/       # Task transcript storage (sibling — used by kanban + whatsapp)
├── kanban/            # Kanban board: task cards, stages, executor
│   └── execution/     # ActiveRun type
└── chat/              # Chat conversations and chat-context features
    └── scheduling/    # Scheduled-task loop (chat-context cron)
```

---

## The `CarapaModule` Interface

Defined in `src/modules/types.ts`. Only `name` and `isEnabled()` are required — everything else is optional.

| Field                         | Required | Purpose                                                                                                      |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `name`                        | Yes      | Unique identifier (e.g. `'whisper'`)                                                                         |
| `isEnabled()`                 | Yes      | Feature-flag gate — returns `boolean`. When `false`, the module is excluded from all lifecycle operations    |
| `init()`                      | No       | Async startup — connect to services, register providers. Fault-tolerant: if it throws, the module is skipped |
| `shutdown()`                  | No       | Clean teardown on `SIGTERM`/`SIGINT`                                                                         |
| `registerTools(server, deps)` | No       | Add MCP tools to the agent server (`McpServer` + `McpServerDeps`)                                            |
| `getRouter()`                 | No       | Return an Express `Router` with module-specific HTTP routes                                                  |
| `getConfigFlags()`            | No       | Key-value pairs merged into the `GET /api/config` response                                                   |

---

## Lifecycle

Six phases, in order. All implemented in `src/modules/loader.ts`; phases 1, 2 and 6 are invoked from `src/index.ts`; tool registration (phase 3) from `src/mcp/mcp-server.ts`.

### 1. Registration

`registerModule()` adds the module object to the in-memory registry. Order matters — modules init in registration order. Most built-ins register at import time; WhatsApp is imported and registered during startup only when `ENABLE_WHATSAPP` is enabled, before `initModules()`.

```typescript
// src/index.ts
registerModule(whisperModule);
registerModule(vectorStoreModule);
registerModule(objectivesModule);
registerModule(webModule);
registerModule(knowledgeModule);
registerModule(gitnexusModule);
registerModule(kanbanModule);
registerModule(chatModule);
registerModule(fsModule);

// During main(), before initModules():
if (ENABLE_WHATSAPP) {
  const modulePath = './modules/whatsapp/index.js';
  registerModule((await import(modulePath)).default);
}
```

**Not dynamic.** New modules must be added explicitly here.

### 2. Init

```typescript
await initModules(); // src/index.ts, at boot
```

Calls `mod.init()` on every enabled module in order. **Fault-tolerant:** if `init()` throws, a warning is logged and the app continues without that module. A failed init does not crash the process.

### 3. Tool Registration

```typescript
registerModuleTools(server, deps, scope); // called in src/mcp/mcp-server.ts
```

Called when creating MCP server instances — both stdio and SSE transports. Each enabled module that implements `registerTools()` adds its tools to the given `McpServer`.

### 4. Route Mounting

```typescript
const routers = getModuleRouters(); // called in src/http-service.ts
```

Returns an array of Express routers from enabled modules that implement `getRouter()`. `http-service.ts` mounts them onto the Express app.

### 5. Config Flags

```typescript
const flags = getModuleConfigFlags(); // merged into GET /api/config
```

Each enabled module's `getConfigFlags()` result is shallow-merged into the config response. The UI uses these to conditionally show module-specific features (e.g. hide WhatsApp UI when `enableWhatsApp` is absent).

### 6. Shutdown

```typescript
await shutdownModules(); // src/index.ts, on SIGTERM/SIGINT
```

Calls `mod.shutdown()` on every enabled module. Errors are logged and swallowed — shutdown continues regardless.

---

## File Convention Per Module

```
src/modules/<name>/
├── index.ts     # CarapaModule implementation, default export
├── config.ts    # Reads env vars and feature flags
├── README.md    # Module-specific documentation
└── *.ts         # Domain files (store.ts, hooks.ts, transcriber.ts, tools.ts, etc.)
```

`index.ts` is the only required file beyond `config.ts`. Domain logic lives in sibling files and is imported by `index.ts`.

---

## Integration Patterns

Core code is never modified to import module internals directly. Instead, modules hook into core at well-defined extension points. Four patterns are used:

| Pattern                 | Used by                         | How it works                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Singleton getter**    | whisper                         | Module sets a private `transcriber` variable on `init()`. Core calls `getTranscriber()` — returns `null` when disabled, a function when enabled. Core checks for `null` before calling.                                                                                                                                                 |
| **Hook injection**      | vector-store                    | Module calls `setVectorStoreHooks(hooks)` on `init()` to inject callbacks into the core `memorize`/`recall`/`forget` tools. Pass `null` on shutdown to clear.                                                                                                                                                                           |
| **Provider registry**   | whatsapp                        | Module calls `setMessagingProvider(provider)` on `init()` to register into the messaging dispatch layer. Core routes outbound messages through whatever provider is registered.                                                                                                                                                         |
| **Direct contribution** | objectives                      | Module registers MCP tools via `registerTools()` and Express routes via `getRouter()` — no injection needed; the lifecycle hooks are the extension point.                                                                                                                                                                               |
| **Toolset registry**    | kanban, chat, fs, web, gitnexus | Module's tools are registered into `TOOLSET_MODULES.<name>` in `src/modules/tools/registry.ts` (chat's tools are in the `scheduling` toolset). Per-group active toolsets gate which tools an agent sees. The CarapaModule wrapper contributes the `enableX` config flag and (where applicable) gates bootstrap calls in `src/index.ts`. |

**Key principle:** core should depend on shared interfaces, with module availability checked at runtime. WhatsApp's entrypoint is resolved only when enabled: its source directory can be omitted from a disabled installation. Shared message types and bridge/task delivery live under `messaging/`; external delivery uses the registered provider. With no provider, status is disconnected, chat discovery is empty, and external sends are logged and skipped. WhatsApp adds `register_group` to `project_setup` only when loaded; the tool is visible and callable only by main orchestration agents. Saved persona prompts still accept the retired `advanced` name without granting any tools.

---

## What is _not_ a Module

Two directories under `src/modules/` are infrastructure, not optional capabilities:

- **`src/modules/messaging/`** — provider-registry abstraction for external messaging connections. Exposes `setMessagingProvider(provider)` / `getMessagingProvider()` and the `MessagingProvider` interface. The whatsapp module plugs into it on `init()`; future providers (telegram, etc.) plug in the same way.
- **`src/modules/tools/`** — central tool registry (`TOOLSET_MODULES`), authorization (`hasPermission`), MCP registration dispatch (`registerToolsToMcp`), and shared types/utils. All other modules' agent tools flow through this layer; wrapping it as a `CarapaModule` would create a bootstrap cycle. MCP registration (`registerToolsToMcp` and the objectives tools) rejects arguments a tool does not declare with an `isError` result naming the accepted keys (`unknown-args.ts`); the DirectLLM path (`dispatchToolCall`) only logs them and still runs the tool.

Both are imported as shared libraries by other modules.

---

## Writing a New Module

1. **Create the directory:** `src/modules/<name>/` with `index.ts`, `config.ts`, `README.md`

2. **Implement `CarapaModule` in `index.ts`:**

   ```typescript
   import type { CarapaModule } from '../types.js';
   import { ENABLE_MY_MODULE } from './config.js';

   const myModule: CarapaModule = {
     name: 'my-module',
     isEnabled() {
       return ENABLE_MY_MODULE;
     },
     async init() {
       /* connect to service */
     },
     async shutdown() {
       /* disconnect */
     },
   };

   export default myModule;
   ```

3. **Gate with `isEnabled()`** — read the feature flag from `config.ts`:

   ```typescript
   // config.ts
   export const ENABLE_MY_MODULE = process.env.ENABLE_MY_MODULE === 'true';
   ```

4. **Register in `src/index.ts`:**

   ```typescript
   import myModule from './modules/my-module/index.js';
   registerModule(myModule);
   ```

5. **Hook into core** using one of the four integration patterns above. Do not add `import` statements for your module inside core files — use runtime checks on the getter/hook instead.

6. **Document env vars** in `.env.example` with a comment explaining the module they enable.

---

## Module Summary

| Module         | Gate                                                                       | Adds                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whisper`      | `WHISPER_API_KEY` or explicit `WHISPER_API_URL` set                        | Audio transcription for voice messages (OpenAI/Groq)                                                                                                             |
| `live-voice`   | always-on                                                                  | Browser-VAD utterances through the shared Whisper-compatible client; text-only fallback when unconfigured                                                        |
| `vector-store` | `ENABLE_VECTOR_STORE=true`                                                 | Neo4j semantic search for `memorize`/`recall`/`forget`                                                                                                           |
| `whatsapp`     | `ENABLE_WHATSAPP=true`                                                     | WhatsApp messaging via carapa-wa-link                                                                                                                            |
| `objectives`   | `ENABLE_OBJECTIVES=true`                                                   | SMART goals, CarapaBrain integration, objective MCP tools                                                                                                        |
| `web`          | always-on                                                                  | Web fetch / search agent tools                                                                                                                                   |
| `knowledge`    | always-on (tools are in the default toolsets unless `ENABLE_MEMORY=false`) | Shared Knowledge Bases & Two-Stage RAG                                                                                                                           |
| `gitnexus`     | `ENABLE_GITNEXUS=true` (default off)                                       | GitNexus Hub code-intelligence tools (impact analysis, rename, query)                                                                                            |
| `kanban`       | `ENABLE_KANBAN!=false` (default on)                                        | Kanban board: task cards, stages, executor pipeline, dataset tasks. Gates `setGroupResolver` / `drainProjectQueue` / `resumeActiveDatasetTasks` bootstrap calls. |
| `chat`         | `ENABLE_CHAT!=false` (default on)                                          | Chat conversations and the scheduled-task loop (under `chat/scheduling/`). Gates `startSchedulerLoop` bootstrap call.                                            |
| `fs`           | `ENABLE_FS_TOOLS!=false` (default on)                                      | Sandbox-bound filesystem agent tools (`read_file`, `ripgrep`, `peek_files`, ...)                                                                                 |

Module-specific documentation:

- [`whisper`](../src/modules/whisper/README.md)
- [`vector-store`](../src/modules/vector-store/README.md)
- [`whatsapp`](../src/modules/whatsapp/README.md)
- [`objectives`](../src/modules/objectives/README.md)
- [`knowledge`](../src/modules/knowledge/README.md)

See also: [`docs/OBJECTIVES.md`](OBJECTIVES.md), [`docs/KNOWLEDGE_BASES.md`](KNOWLEDGE_BASES.md)
for the full CarapaBrain integration design.
