# vector-store

## Overview

Optional Neo4j-based semantic search layer for the memory system. When enabled, enhances `memorize`, `recall`, and `forget` MCP tools with embedding-based similarity search.

## How it works

- Gated by `ENABLE_VECTOR_STORE=true`
- On init, calls `setVectorStoreHooks()` to inject the hook implementations declared in `hooks.ts` into the core memory code, among them:
  - `embedAndStore(...)` — generates embedding via Ollama and stores in Neo4j
  - `enhanceRecall(...)` — semantic search across groups
  - `eraseMemory(...)` and `invalidateMemory(...)` — remove a memory from Neo4j, or mark it invalid from a point in time
  - `upsertEntity(...)`, `upsertRelation(...)`, `expandEntities(...)` — entity graph
  - `isAvailable()`, `isVectorOnlyRecall()`, `minScore()` — runtime config accessors
- Integration pattern: **hook injection** — core memory code (`src/modules/memory/tools.ts` and the other memory modules) checks if hooks are set and delegates to them

## Recall ranking

`recall` fuses two ranked lists with reciprocal rank fusion (`RECALL_RRF_K`):

- **Keyword leg** (`searchMemories`): SQL prefilter on the query terms, then BM25 (k1 = 1.2, b = 0.75) over content plus tags of the prefiltered rows only. Statistics come from those rows. Rows without a whole-token or `-`/`_`/`.` piece match are dropped.
- **Vector leg** (`orderVectorHitIds`): hits ordered by similarity score.
- Importance and recency are tie-breakers only (keyword: importance, then newer `updated_at`; vector: importance, then recency).
- Exception: point-in-time recall (`asOf`) keeps the blend of similarity, recency and importance for the vector leg.

## Files

| File        | Purpose                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `index.ts`  | `CarapaModule` implementation — registers hooks, connects/disconnects Neo4j                 |
| `config.ts` | Reads Neo4j connection, embedding API, and behavior flags from env/secrets                  |
| `store.ts`  | Neo4j driver management, embedding generation (Ollama API), vector CRUD operations          |
| `hooks.ts`  | Hook registry — `setVectorStoreHooks()` / `getVectorStoreHooks()` used by core memory tools |

## Environment variables

| Variable                     | Default                              | Description                                                        |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| `ENABLE_VECTOR_STORE`        | `false`                              | Set to `true` to enable the module                                 |
| `NEO4J_URI`                  | `bolt://sia-neo4j:7687`              | Neo4j Bolt connection URI                                          |
| `NEO4J_USER`                 | `neo4j`                              | Neo4j username                                                     |
| `NEO4J_PASSWORD`             | _(none)_                             | Neo4j password. Read from `$SECRETS_DIR/neo4j_password` or env var |
| `EMBEDDING_MODEL`            | `embeddinggemma`                     | Ollama model name for generating embeddings                        |
| `EMBEDDING_API_URL`          | `http://llama-proxy:11434/api/embed` | Ollama-compatible embedding API endpoint                           |
| `VECTOR_ONLY_RECALL`         | `false`                              | When `true`, recall uses ONLY vector search                        |
| `VECTOR_MIN_SCORE`           | `0.55`                               | Minimum cosine similarity score for vector results                 |
| `VECTOR_SEARCH_K_MULTIPLIER` | `5`                                  | Neo4j vector query over-fetch before min-score filter              |

## Disabling

Set `ENABLE_VECTOR_STORE=false` or leave it unset.
