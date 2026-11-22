# GitNexus Integration

CarapaBoard integrates with GitNexus to provide deep code intelligence (graph-based understanding, execution flows, and impact analysis) to AI agents.

## Architecture

The integration works via a **Hub-and-Spoke** architecture:

1. **GitNexus Hub**: A central Docker stack running the `hub-server` and `eval-server`. It manages knowledge graphs for multiple repositories.
2. **CarapaBoard Proxy**: The Board acts as an MCP relay, providing authenticated and path-normalized access to the Hub for agents running in isolated CarapaBox containers.

## Enabling

GitNexus is disabled by default because it needs a separately deployed hub.
With the hub running, add the optional Compose file, which sets
`ENABLE_GITNEXUS=true`, `GITNEXUS_URL` and the read-only registry mount
(`GITNEXUS_DATA_DIR`, default `../gitnexus-hub/.gitnexus`):

```bash
docker compose -f docker-compose.yml -f docker-compose.gitnexus.yml up -d
```

Add `-f docker-compose.override.yml` (or other overrides you use) before it, or
list the files in `COMPOSE_FILE` in `.env` so plain `docker compose` includes it.
In host mode, set `ENABLE_GITNEXUS=true` and `GITNEXUS_URL` in `.env`.

## Configuration

### 1. Hub Deployment

Ensure the GitNexus Hub is running in your Docker environment. It should be accessible via the internal network.

- **Internal URL**: `http://gitnexus-hub:4848`
- **Volume Mounts**: The Hub must have read access to the same source directories as the agents.

### 2. Project Metadata (Authorization)

Agents can access the repository defined in their project's `repositoryLocation` and its configured related repositories. A parent or main agent can also access repositories of projects for which it has GitNexus permission.

- **Related Repositories**: Add framework or dependency repositories to **Related Repositories** in the **Project Settings UI**.
- **Permissions**: Reading requires `gitnexus:read`; clean, analyze and rename also require `gitnexus:write`. Project agents receive both for their own project, and viewer access remains read-only.

### 3. Environment Variables (Board)

- `GITNEXUS_URL`: Internal URL of the Hub (e.g., `http://gitnexus-hub:4848`).
- `GITNEXUS_HUB_TOKEN`: (Optional) Bearer token for Hub authentication.
- `GITNEXUS_REGISTRY_PATH`: Registry file used by the API and MCP resource list; defaults to `DATA_DIR/gitnexus/registry.json` (normally `/app/data/gitnexus/registry.json` in the container). Mount the hub's `.gitnexus` directory at `/app/data/gitnexus` or set this path to its mounted registry.

---

## Toolset (MCP)

When using GitNexus via the **carapa-board MCP server** (e.g., in Claude Code), all tools are prefixed with `mcp__carapa-board__`.

### Intelligence Tools

- **`gitnexus_query({query, repo?})`**: Search for execution flows and logic concepts.
- **`gitnexus_context({target, repo?})`**: 360-degree view of a symbol (callers, callees, definition).
- **`gitnexus_impact({target, depth?, repo?})`**: Analyze the blast radius of a change.
- **`gitnexus_read_resource({uri})`**: Fetch lightweight context (context, clusters, processes) via `gitnexus://` URIs.
- **`gitnexus_detect_changes({repo?})`**: Analyze the impact of current uncommitted git changes.

### Management Tools

- **`gitnexus_analyze({repo?, force?, embeddings?})`**: Re-index a repository.
- **`gitnexus_clean({repo?, all?})`**: Delete the index for a repository.
- **`gitnexus_rename({symbol_name, new_name, dry_run?, repo?})`**: Coordinate a safe multi-file rename.

---

## Security & Isolation

1. **Repository Paths**: The Hub must recognize the repository paths configured in project settings.
2. **Repository Guard**: Tools and resources resolve repository paths or unambiguous short names against repositories configured for projects the caller has permission to access. An omitted tool repository selects the caller's primary repository; unknown or ambiguous repositories are rejected before contacting the Hub. Clean, analyze and rename also require `gitnexus:write`; hub-wide clean is disallowed.
3. **Sandbox Safety**: Agents run in isolated containers and never communicate with the Hub directly; all traffic passes through the Board's permission layer.
