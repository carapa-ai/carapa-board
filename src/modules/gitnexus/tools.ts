import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { McpServerDeps, hasPermission } from '../../mcp/auth.js';
import { logger } from '../../logger.js';
import { TOOLSET_MODULES } from '../tools/registry.js';
import { sleep } from '../../lib/async.js';
import { getGroupByFolder } from '../../state-manager.js';
import { GITNEXUS_REGISTRY_PATH } from '../../config.js';

/**
 * Cached dynamic tools fetched from GitNexus Hub.
 * This avoids hardcoding copyrighted descriptions in this codebase.
 */
let dynamicGitNexusTools: any[] = [];

/**
 * Initialize GitNexus tools by fetching definitions from the Hub.
 * Called at server boot.
 */
export async function initGitNexusTools() {
  const hubUrl = process.env.GITNEXUS_URL || 'http://gitnexus-hub:4848';
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;
    logger.info(
      { hubUrl, attempt: attempts },
      'Initializing GitNexus tools discovery',
    );
    try {
      const res = await fetch(`${hubUrl}/mcp/tools`);
      if (res.ok) {
        // The hub-wide listing cannot be scoped to the caller's repositories.
        // Exclude it from the toolset.
        dynamicGitNexusTools = ((await res.json()) as any[]).filter(
          (tool) => tool.name !== 'gitnexus_list_repos',
        );
        logger.info(
          { count: dynamicGitNexusTools.length },
          'Fetched dynamic GitNexus tools from hub',
        );

        // Populate registry toolset
        TOOLSET_MODULES.gitnexus = dynamicGitNexusTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: convertGitNexusSchemaToZod(tool.inputSchema),
          requiredPermissions:
            toolPermission(tool.name) === 'gitnexus:write'
              ? ['gitnexus:read', 'gitnexus:write']
              : ['gitnexus:read'],
          handler: async (args, deps, context) => {
            // Map parameter names if necessary (e.g., target -> name for context)
            const mappedArgs = { ...args };
            if (tool.name === 'gitnexus_context' && args.target) {
              mappedArgs.name = args.target;
              delete mappedArgs.target;
            }

            // Map maxDepth back to depth for Hub compatibility if needed
            if (args.maxDepth) {
              mappedArgs.depth = args.maxDepth;
              delete mappedArgs.maxDepth;
            }

            prepareGitNexusArgs(tool.name, mappedArgs, context, deps);

            // Determine hub endpoint
            const endpoint = tool.name
              .replace('gitnexus_', '')
              .replace('_repos', '');

            return await callGitNexus(endpoint, mappedArgs);
          },
        }));

        return;
      }
      const text = await res.text().catch(() => 'No body');
      logger.warn(
        { status: res.status, responseLength: text.length },
        'Hub returned error while fetching tools',
      );
    } catch (err: any) {
      logger.warn(
        { err: err.message, hubUrl },
        'Connection to GitNexus hub failed',
      );
    }

    if (attempts < maxAttempts) {
      await sleep(2000);
    }
  }
  logger.error(
    'Failed to fetch dynamic GitNexus tools after multiple attempts — functionality will be limited',
  );
}

/**
 * Call the GitNexus Hub API.
 */
async function callGitNexus(endpoint: string, args: any) {
  const hubUrl = process.env.GITNEXUS_URL || 'http://gitnexus-hub:4848';
  const hubToken = process.env.GITNEXUS_HUB_TOKEN;

  logger.debug(
    { endpoint, argumentKeys: Object.keys(args ?? {}).slice(0, 40) },
    '[GitNexus] Calling tool',
  );
  const res = await fetch(`${hubUrl}/tool/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(hubToken ? { Authorization: `Bearer ${hubToken}` } : {}),
    },
    body: JSON.stringify(args),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Hub error: ${res.status}`);
  }

  return await res.text();
}

/**
 * Fetch a resource from the GitNexus Hub.
 */
async function fetchGitNexusResource(
  repoName: string,
  type: string,
  extra?: string,
) {
  const hubUrl = process.env.GITNEXUS_URL || 'http://gitnexus-hub:4848';
  const hubToken = process.env.GITNEXUS_HUB_TOKEN;
  const url = `${hubUrl}/resource/repo/${encodeURIComponent(repoName)}/${type}${extra ? '/' + encodeURIComponent(extra) : ''}`;

  logger.debug(
    { resource: `${repoName}/${type}` },
    '[GitNexus] Fetching resource',
  );
  const res = await fetch(url, {
    headers: {
      ...(hubToken ? { Authorization: `Bearer ${hubToken}` } : {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Hub error: ${res.status}`);
  }

  return await res.text();
}

type GitNexusContext = {
  group_folder: string;
  permissions?: Record<string, string[]>;
};

function toolPermission(name: string): string {
  return ['gitnexus_clean', 'gitnexus_analyze', 'gitnexus_rename'].includes(
    name,
  )
    ? 'gitnexus:write'
    : 'gitnexus:read';
}

/** Resolve only configured repositories on projects the caller may access. */
function resolveRepoPath(
  repoName: unknown,
  context: GitNexusContext | undefined,
  deps: McpServerDeps,
  permission = 'gitnexus:read',
): string {
  if (!context) throw new Error('Unauthorized: missing project context');
  const own = getGroupByFolder(context.group_folder);
  // Omission means the current project's primary repository, never a hub default.
  const requested =
    repoName === undefined ? own?.settings?.repositoryLocation : repoName;
  if (typeof requested !== 'string' || !requested) {
    throw new Error('Unauthorized: no repository specified or configured');
  }
  const folders = new Set([
    context.group_folder,
    ...Object.values(deps.getRegisteredGroups()).map((g) => g.folder),
  ]);
  const matches = new Set<string>();
  for (const folder of folders) {
    if (
      !hasPermission(context.permissions, folder, 'gitnexus:read') ||
      !hasPermission(context.permissions, folder, permission)
    )
      continue;
    const group = getGroupByFolder(folder);
    const repos = [
      group?.settings?.repositoryLocation,
      ...(group?.settings?.relatedRepositories ?? []),
    ];
    for (const repo of repos) {
      if (repo && (repo === requested || repo.endsWith('/' + requested)))
        matches.add(repo);
    }
  }
  if (matches.size !== 1) {
    throw new Error(
      'Unauthorized: repository is not permitted or is ambiguous',
    );
  }
  return [...matches][0];
}

function prepareGitNexusArgs(
  name: string,
  args: any,
  context: GitNexusContext | undefined,
  deps: McpServerDeps,
): void {
  // Hub-wide operations cannot be confined by supplying a repo.
  if (name === 'gitnexus_clean' && args.all)
    throw new Error('Unauthorized: hub-wide clean is not permitted');
  if (name === 'gitnexus_read_resource') {
    if (typeof args.uri !== 'string')
      throw new Error('Invalid GitNexus resource URI');
    const match =
      /^gitnexus:\/\/repo\/([^/]+)\/(context|clusters|processes|process\/[^/]+)$/.exec(
        args.uri,
      );
    if (!match) throw new Error('Invalid GitNexus resource URI');
    const repo = resolveRepoPath(decodeURIComponent(match[1]), context, deps);
    args.uri = `gitnexus://repo/${encodeURIComponent(repo)}/${match[2]}`;
    return;
  }
  args.repo = resolveRepoPath(args.repo, context, deps, toolPermission(name));
}

/**
 * Register standard GitNexus resources.
 */
export function registerGitNexusResources(
  server: McpServer,
  deps: McpServerDeps,
  context?: { group_folder: string; permissions?: Record<string, string[]> },
) {
  const group_folder = context?.group_folder || 'unknown';

  const isAuthorized = () => {
    if (!context) return false;
    return hasPermission(
      context.permissions,
      context.group_folder,
      'gitnexus:read',
    );
  };

  const createRepoListCallback = (type: string, label: string) => async () => {
    try {
      const registryPath = GITNEXUS_REGISTRY_PATH;
      if (!existsSync(registryPath)) return { resources: [] };
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      return {
        resources: registry
          .filter((r: any) => {
            try {
              resolveRepoPath(r.name, context, deps);
              return true;
            } catch {
              return false;
            }
          })
          .map((r: any) => ({
            uri: `gitnexus://repo/${r.name}/${type}`,
            name: `${label} for ${r.name}`,
            mimeType: 'application/json',
          })),
      };
    } catch (err) {
      return { resources: [] };
    }
  };

  server.registerResource(
    `gitnexus-${group_folder}-context`,
    new ResourceTemplate(`gitnexus://repo/{repoName}/context`, {
      list: createRepoListCallback('context', 'Repository Context'),
    }),
    { description: 'GitNexus Repository Context' },
    async (uri, { repoName }: any) => {
      if (!isAuthorized()) throw new Error(`Unauthorized`);
      const resolvedRepo = resolveRepoPath(repoName, context, deps);
      const content = await fetchGitNexusResource(resolvedRepo, 'context');
      return { contents: [{ uri: uri.href, text: content }] };
    },
  );

  server.registerResource(
    `gitnexus-${group_folder}-clusters`,
    new ResourceTemplate(`gitnexus://repo/{repoName}/clusters`, {
      list: createRepoListCallback('clusters', 'Symbol Clusters'),
    }),
    { description: 'GitNexus Symbol Clusters' },
    async (uri, { repoName }: any) => {
      if (!isAuthorized()) throw new Error(`Unauthorized`);
      const resolvedRepo = resolveRepoPath(repoName, context, deps);
      const content = await fetchGitNexusResource(resolvedRepo, 'clusters');
      return { contents: [{ uri: uri.href, text: content }] };
    },
  );

  server.registerResource(
    `gitnexus-${group_folder}-processes`,
    new ResourceTemplate(`gitnexus://repo/{repoName}/processes`, {
      list: createRepoListCallback('processes', 'Execution Flows'),
    }),
    { description: 'GitNexus Execution Flows' },
    async (uri, { repoName }: any) => {
      if (!isAuthorized()) throw new Error(`Unauthorized`);
      const resolvedRepo = resolveRepoPath(repoName, context, deps);
      const content = await fetchGitNexusResource(resolvedRepo, 'processes');
      return { contents: [{ uri: uri.href, text: content }] };
    },
  );

  server.registerResource(
    `gitnexus-${group_folder}-process`,
    new ResourceTemplate(`gitnexus://repo/{repoName}/process/{processId}`, {
      list: undefined,
    }),
    { description: 'GitNexus Process Detail' },
    async (uri, { repoName, processId }: any) => {
      if (!isAuthorized()) throw new Error(`Unauthorized`);
      const resolvedRepo = resolveRepoPath(repoName, context, deps);
      const content = await fetchGitNexusResource(
        resolvedRepo,
        'process',
        processId,
      );
      return { contents: [{ uri: uri.href, text: content }] };
    },
  );
}

/**
 * Converts dynamic JSON Schema from GitNexus hub to a Zod-like input schema.
 */
function convertGitNexusSchemaToZod(
  schema: any,
): Record<string, z.ZodType<any>> {
  const inputSchema: Record<string, z.ZodType<any>> = {};
  const properties = schema?.properties || schema || {};

  for (const [key, prop] of Object.entries(properties as Record<string, any>)) {
    if (key === 'type' || key === 'required' || key === 'properties') continue;

    let zType: z.ZodType<any>;
    if (prop.type === 'string') {
      if (prop.enum)
        zType = z
          .enum(prop.enum as [string, ...string[]])
          .describe(prop.description || '');
      else zType = z.string().describe(prop.description || '');
    } else if (prop.type === 'number') {
      zType = z.number().describe(prop.description || '');
    } else if (prop.type === 'boolean') {
      zType = z.boolean().describe(prop.description || '');
    } else {
      zType = z.any().describe(prop.description || '');
    }

    // Most dynamic tools have optional parameters except for the primary identifiers
    inputSchema[key] = zType.optional();
  }

  return inputSchema;
}
