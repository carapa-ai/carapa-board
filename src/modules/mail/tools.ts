import path from 'path';
import { z } from 'zod';
import { TOOLSET_MODULES } from '../tools/registry.js';
import { getGroupByFolder, registeredGroups } from '../../state-manager.js';
import { hasPermission } from '../../mcp/auth.js';
import { getProjectAccess, getUserById } from '../knowledge/db-kb.js';
import { downloadMailAttachment, mailRole } from './service.js';
import { logger } from '../../logger.js';
import { listMailTools, callCarapaMailTool } from './client.js';
import { writeArtifactFile } from '../chat/artifacts.js';
import type { RegisteredGroup } from '../../types.js';
import type { ToolDefinition } from '../tools/types.js';

/** carapa-mail's raw download tool — overridden board-side (see makeDownloadAttachmentTool). */
const DOWNLOAD_TOOL_NAME = 'carapamail_download_attachment';
/** carapa-mail's list-accounts tool — overridden board-side (see makeListAccountsTool). */
const LIST_ACCOUNTS_TOOL_NAME = 'carapamail_list_accounts';
/**
 * carapa-mail tools that only read mailbox data. Everything else the board proxies
 * (send, move, delete, mark_read, any future tool) is treated as mutating and fails
 * closed: it needs an editor-level mailRole on a cross-project target.
 */
const READ_ONLY_MAIL_TOOLS = new Set([
  'carapamail_read_email',
  'carapamail_list_emails',
  'carapamail_search',
  'carapamail_list_folders',
  'carapamail_list_accounts',
  DOWNLOAD_TOOL_NAME,
]);

/**
 * Mail tools offered over the board MCP server, to a mail-enabled non-main
 * project's own run tokens. Mail is untrusted input, so this is an explicit
 * allowlist of read tools plus draft saving: every other or future carapa-mail
 * tool (send, move, delete, mark_read, list_accounts, stats, ...) stays
 * direct-LLM only.
 */
const MCP_MAIL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'carapamail_list_folders',
  'carapamail_list_emails',
  'carapamail_read_email',
  'carapamail_search',
  DOWNLOAD_TOOL_NAME,
  'carapamail_save_draft',
]);

/** Upper bound on carapa-mail discovery while an MCP server is being built. */
const MCP_DISCOVERY_TIMEOUT_MS = 5_000;

/** Collaborators the mail tools use; exposed so tests can substitute them. */
export const mailToolDeps = {
  getGroupByFolder,
  listGroups: (): RegisteredGroup[] => Object.values(registeredGroups),
  getUserById,
  getProjectAccess,
  callTool: callCarapaMailTool,
  download: downloadMailAttachment,
  writeArtifact: writeArtifactFile,
};

/**
 * carapa-mail `mail` toolset (direct-LLM only).
 *
 * Mirrors the gitnexus proxy pattern: the tool list + schemas are discovered
 * dynamically from carapa-mail rather than hand-mirrored, so there is zero schema
 * drift. Each handler proxies the call back to carapa-mail with the *calling*
 * project's token.
 *
 * Deviation from gitnexus: gitnexus discovers once at boot against a single global
 * hub with an unauthenticated catalog. carapa-mail's tools/list is itself
 * authenticated and tokens are per-project — but the registered tool list is
 * identical for any valid token. So we discover lazily using one enabled project's
 * token, cache the resulting ToolDefinitions globally, and authenticate per-call.
 */

let mailToolsLoaded = false;

/** Schema for the board-injected `project_id` param that lets the main agent pick
 * which mail-enabled project/account (e.g. "mail-gmail", "mail-yahoo") to act on. */
const projectIdParam = z
  .string()
  .optional()
  .describe(
    'Target mail project/account folder (e.g. "mail-gmail", "mail-yahoo"). ' +
      'Defaults to the current project. The main agent uses this to choose which mail account to act on.',
  );

/**
 * Find a carapa-mail token usable for token-independent tool discovery.
 * Prefers the calling project's own token; for the main agent (whose own project
 * usually has no mail account) falls back to any mail-enabled project's token,
 * since carapa-mail's registered tool list is identical for any valid token.
 */
function resolveDiscoveryToken(group_folder: string): string | undefined {
  // Borrowing another project's token here exposes tool schemas only, never mailbox data.
  const own = getGroupByFolder(group_folder)?.settings;
  if (own?.carapaMailEnabled && own.carapaMailToken) return own.carapaMailToken;
  if (!getGroupByFolder(group_folder)?.is_main) return undefined;
  for (const g of Object.values(registeredGroups)) {
    if (g.settings?.carapaMailEnabled && g.settings.carapaMailToken)
      return g.settings.carapaMailToken;
  }
  return undefined;
}

/**
 * Authorize `ctx`'s group to act on `target`'s mailbox.
 * Same-project calls are always allowed. A different target first needs the
 * `mail:read` permission (held only by main assistants); then a per-user main
 * assistant (is_main with a user_id) is held to the same `mailRole` rule as the
 * human HTTP route, so it cannot reach another user's projects. Mutating tools
 * require an editor role. A main without an owner fails closed.
 */
async function authorizeMailTarget(
  ctx: any,
  target: string,
  mutating: boolean,
): Promise<{ target: string } | { error: string }> {
  if (target === ctx.group_folder) return { target };
  const denied = {
    error: `Error: not authorized to access mail for project "${target}"`,
  };
  if (!hasPermission(ctx.permissions, target, 'mail:read')) return denied;

  const caller = mailToolDeps.getGroupByFolder(ctx.group_folder);
  if (!caller?.is_main) return { target };
  if (!caller.user_id) return denied;

  try {
    const user = await mailToolDeps.getUserById(caller.user_id);
    const targetGroup = mailToolDeps.getGroupByFolder(target);
    if (!user || !targetGroup) return denied;
    const role = mailRole(
      user,
      targetGroup,
      await mailToolDeps.getProjectAccess(user.id, target),
    );
    return mutating && role !== 'editor' ? denied : { target };
  } catch {
    return denied; // MailHttpError or lookup failure: fail closed
  }
}

/** Resolve the project a mail call should target and authorize access to it. */
function resolveMailTarget(
  args: any,
  ctx: any,
  toolName: string,
): Promise<{ target: string } | { error: string }> {
  const target =
    (args && typeof args.project_id === 'string' && args.project_id) ||
    ctx.group_folder;
  return authorizeMailTarget(ctx, target, !READ_ONLY_MAIL_TOOLS.has(toolName));
}

/** Coerce a single value to a number, tolerating stringified and quote-wrapped numbers. */
function toNumber(v: any): any {
  if (typeof v !== 'string') return v;
  const stripped = v.trim().replace(/^"(.*)"$/, '$1'); // unwrap models that emit `"123"`
  const n = Number(stripped);
  return stripped !== '' && !Number.isNaN(n) ? n : v;
}

/** Coerce a value to an array, tolerating models that emit a JSON-array string,
 * a comma-separated string, or a single scalar for an array-typed field. */
function toArray(v: any): any {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to comma/scalar handling
    }
  }
  if (t === '') return [];
  return t.includes(',')
    ? t
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [t];
}

/**
 * Coerce args to the types declared in the remote JSON Schema before forwarding.
 * Local models frequently emit numbers as (quote-wrapped) strings and arrays as
 * JSON-encoded strings; carapa-mail validates strictly, so we normalize here.
 */
function coerceArgsToSchema(args: any, schema: any): any {
  if (!args || typeof args !== 'object') return args;
  const props = schema?.properties || {};
  const out: any = { ...args };
  for (const [key, prop] of Object.entries(props as Record<string, any>)) {
    if (!(key in out)) continue;
    if (prop.type === 'number' || prop.type === 'integer') {
      out[key] = toNumber(out[key]);
    } else if (prop.type === 'array') {
      const arr = toArray(out[key]);
      out[key] =
        Array.isArray(arr) &&
        (prop.items?.type === 'number' || prop.items?.type === 'integer')
          ? arr.map(toNumber)
          : arr;
    }
  }
  return out;
}

/** Convert a remote JSON Schema (object) into the Zod-shaped inputSchema map. */
function convertJsonSchemaToZod(schema: any): Record<string, z.ZodType<any>> {
  const inputSchema: Record<string, z.ZodType<any>> = {};
  const properties = schema?.properties || {};
  const required: string[] = Array.isArray(schema?.required)
    ? schema.required
    : [];

  for (const [key, prop] of Object.entries(properties as Record<string, any>)) {
    let zType: z.ZodType<any>;
    if (prop.type === 'string') {
      zType = prop.enum
        ? z
            .enum(prop.enum as [string, ...string[]])
            .describe(prop.description || '')
        : z.string().describe(prop.description || '');
    } else if (prop.type === 'number' || prop.type === 'integer') {
      zType = z.number().describe(prop.description || '');
    } else if (prop.type === 'boolean') {
      zType = z.boolean().describe(prop.description || '');
    } else if (prop.type === 'array') {
      const itemType = prop.items?.type;
      const item =
        itemType === 'number' || itemType === 'integer'
          ? z.number()
          : itemType === 'string'
            ? z.string()
            : z.any();
      zType = z.array(item).describe(prop.description || '');
    } else {
      zType = z.any().describe(prop.description || '');
    }

    inputSchema[key] = required.includes(key) ? zType : zType.optional();
  }

  return inputSchema;
}

/**
 * Board-native override of carapa-mail's `carapamail_download_attachment`.
 *
 * carapa-mail returns a tokenized link whose host is carapa-mail itself — reachable
 * by the board but NOT by the human's browser, and it expires in minutes. So instead
 * of handing that link to the user, the board fetches the bytes server-side and
 * re-hosts them as a project artifact under `artifacts/mail/` (served at
 * `/artifacts/<folder>/mail/...`, listed in the Artifacts tab). The reply then carries
 * a stable, browser-openable link.
 */
function makeDownloadAttachmentTool(remoteDef: any) {
  const rawSchema = remoteDef.inputSchema;
  return {
    name: DOWNLOAD_TOOL_NAME,
    description:
      'Download an email attachment and save it to this project so the user can open it. ' +
      'Returns a link to share with the user. Same arguments as reading an email ' +
      '(uid + attachment filename, optional folder/account).',
    inputSchema: {
      ...convertJsonSchemaToZod(rawSchema),
      project_id: projectIdParam,
    },
    requiredPermissions: [],
    mcpExempt: true,
    handler: async (args: any, _deps: any, ctx: any): Promise<string> => {
      const resolved = await resolveMailTarget(args, ctx, DOWNLOAD_TOOL_NAME);
      if ('error' in resolved) return resolved.error;
      const group_folder = resolved.target;
      const { project_id: _ignored, ...mailArgs } = args || {};

      // 1. Ask carapa-mail for the download link (runs its full security gate).
      const raw = await mailToolDeps.callTool(
        group_folder,
        DOWNLOAD_TOOL_NAME,
        coerceArgsToSchema(mailArgs, rawSchema),
        ctx.signal,
      );
      let meta: any;
      try {
        meta = JSON.parse(raw);
      } catch {
        return raw; // error string / gate-block reason — pass through to the model
      }
      if (!meta?.url) return raw;

      // 2. Fetch the bytes server-side (board can reach carapa-mail; the browser cannot).
      let buffer: Buffer;
      try {
        buffer = await mailToolDeps.download(meta.url, ctx.signal);
      } catch (err: any) {
        if (err?.status === 413)
          return `Attachment "${meta.filename}" is too large (limit 25 MB).`;
        return `Retrieved the attachment but could not fetch its bytes from carapa-mail: ${err?.message || err}`;
      }

      // 3. Re-host as a project artifact → browser-reachable /artifacts link.
      const group = mailToolDeps.getGroupByFolder(group_folder);
      if (!group)
        return `Could not save the attachment: project "${group_folder}" was not found.`;
      const safeName = path
        .basename(meta.filename || 'attachment')
        .replace(/[^a-zA-Z0-9._-]/g, '_');
      const storedName = `${Date.now()}-${safeName}`;
      let stored: { relPath: string; url: string };
      try {
        stored = await mailToolDeps.writeArtifact(
          group_folder,
          `mail/${storedName}`,
          buffer,
          { mimetype: meta.content_type, source: 'agent' },
        );
      } catch (err: any) {
        return `Fetched the attachment but failed to save it: ${err?.message || err}`;
      }

      const link = stored.url;
      logger.info(
        {
          group_folder,
          filename: meta.filename,
          bytes: buffer.length,
          relPath: stored.relPath,
        },
        'Saved mail attachment',
      );
      return (
        `Saved "${meta.filename}" (${buffer.length} bytes, ${meta.content_type || 'application/octet-stream'}). ` +
        `Show the user this link so they can open it: [${meta.filename}](${link})`
      );
    },
  };
}

/**
 * Board-native override of carapa-mail's `carapamail_list_accounts`.
 *
 * carapa-mail tokens are per-project, so a single proxied call only ever returns
 * the calling project's own account(s). The main agent, however, must be able to
 * see *every* mail account across all projects. So for the main agent (when no
 * explicit `project_id` is given) the board fans the call out to every
 * mail-enabled project's token and merges the results, labelling each block with
 * its project folder so the agent knows which `project_id` to use for follow-ups.
 * Non-main callers (and explicit `project_id` targets) fall back to a single
 * authorised proxy call, preserving in-project behaviour.
 */
function makeListAccountsTool(remoteDef: any) {
  const rawSchema = remoteDef.inputSchema;
  return {
    name: LIST_ACCOUNTS_TOOL_NAME,
    description:
      (remoteDef.description || 'List configured mail accounts.') +
      ' For the main agent this returns accounts across all mail-enabled projects, ' +
      'each labelled with its project_id.',
    inputSchema: {
      ...convertJsonSchemaToZod(rawSchema),
      project_id: projectIdParam,
    },
    requiredPermissions: [],
    mcpExempt: true,
    handler: async (args: any, _deps: any, ctx: any): Promise<string> => {
      const { project_id: explicitTarget, ...mailArgs } = args || {};
      const coerced = coerceArgsToSchema(mailArgs, rawSchema);
      const caller = mailToolDeps.getGroupByFolder(ctx.group_folder);

      // Main agent, no explicit target → aggregate across every authorized mail-enabled project.
      if (caller?.is_main && !explicitTarget) {
        const enabled = mailToolDeps
          .listGroups()
          .filter(
            (g) => g.settings?.carapaMailEnabled && g.settings.carapaMailToken,
          );
        const authorized = (
          await Promise.all(
            enabled.map(async (g) =>
              'error' in (await authorizeMailTarget(ctx, g.folder, false))
                ? undefined
                : g,
            ),
          )
        ).filter((g): g is RegisteredGroup => !!g);
        if (!authorized.length)
          return 'No mail-enabled projects are configured.';
        const blocks = await Promise.all(
          authorized.map(async (g) => {
            let out: string;
            try {
              out = await mailToolDeps.callTool(
                g.folder,
                LIST_ACCOUNTS_TOOL_NAME,
                coerced,
                ctx.signal,
              );
            } catch (err: any) {
              out = `Error: ${err?.message || 'carapa-mail call failed'}`;
            }
            return `## Project: ${g.folder}\n${out}`;
          }),
        );
        return blocks.join('\n\n');
      }

      // Otherwise: single authorised proxy call (own project or explicit target).
      const resolved = await resolveMailTarget(
        args,
        ctx,
        LIST_ACCOUNTS_TOOL_NAME,
      );
      if ('error' in resolved) return resolved.error;
      return mailToolDeps.callTool(
        resolved.target,
        LIST_ACCOUNTS_TOOL_NAME,
        coerced,
        ctx.signal,
      );
    },
  };
}

/** Build the board's mail toolset from carapa-mail's discovered tool definitions. */
export function buildMailToolset(remote: any[]) {
  // Proxy every tool except the ones the board overrides: the download tool (so the
  // attachment lands in the project's uploads dir, browser-reachable) and list-accounts
  // (so the main agent sees accounts across all mail-enabled projects, not just one token's).
  const proxied = remote
    .filter(
      (t) =>
        t.name !== DOWNLOAD_TOOL_NAME && t.name !== LIST_ACCOUNTS_TOOL_NAME,
    )
    .map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: {
        ...convertJsonSchemaToZod(t.inputSchema),
        project_id: projectIdParam,
      },
      requiredPermissions: [], // enforcement is mail-side, by the per-project token
      mcpExempt: true, // direct-LLM only; never registered into the carapa-board MCP server
      handler: async (args: any, _deps: any, ctx: any) => {
        const resolved = await resolveMailTarget(args, ctx, t.name);
        if ('error' in resolved) return resolved.error;
        const { project_id: _ignored, ...mailArgs } = args || {};
        return mailToolDeps.callTool(
          resolved.target,
          t.name,
          coerceArgsToSchema(mailArgs, t.inputSchema),
          ctx.signal,
        );
      },
    }));

  const downloadDef = remote.find((t) => t.name === DOWNLOAD_TOOL_NAME);
  const listAccountsDef = remote.find(
    (t) => t.name === LIST_ACCOUNTS_TOOL_NAME,
  );
  return [
    ...proxied,
    ...(downloadDef ? [makeDownloadAttachmentTool(downloadDef)] : []),
    ...(listAccountsDef ? [makeListAccountsTool(listAccountsDef)] : []),
  ];
}

/**
 * Lazily discover carapa-mail's tools and populate TOOLSET_MODULES.mail (once).
 * Called from the direct-LLM loop before the sync getOpenAITools() read.
 * No-op (and retried next turn) when discovery is not yet possible.
 */
export async function ensureMailToolsLoaded(
  group_folder: string,
  signal?: AbortSignal,
): Promise<void> {
  if (mailToolsLoaded) return;
  const token = resolveDiscoveryToken(group_folder);
  if (!token) return;

  try {
    const remote = await listMailTools(token, signal);
    if (!remote.length) return;

    TOOLSET_MODULES.mail = buildMailToolset(remote);

    mailToolsLoaded = true;
    logger.info(
      { count: TOOLSET_MODULES.mail.length },
      'Loaded carapa-mail tools',
    );
  } catch (err: any) {
    logger.warn(
      { err: err?.message },
      'carapa-mail tool discovery failed — will retry',
    );
  }
}

/**
 * Whether `scope` may use mail tools over MCP: a run/chat token (not a human or
 * OAuth one) of a non-main project that enabled mail and holds a mail token.
 */
function isMcpMailScope(scope: { group_folder: string; kind?: string }) {
  if (scope.kind === 'oauth' || scope.kind === 'user') return false;
  const group = mailToolDeps.getGroupByFolder(scope.group_folder);
  return (
    !!group &&
    !group.is_main &&
    !!group.settings?.carapaMailEnabled &&
    !!group.settings.carapaMailToken
  );
}

/**
 * Load the mail toolset before an MCP server is built. Never throws and never
 * waits long: discovery is aborted after a short deadline, and
 * `ensureMailToolsLoaded` logs the failure (once). When carapa-mail is
 * unreachable the server simply starts without mail tools and a later server
 * build retries.
 */
export async function ensureMailToolsLoadedForMcp(scope: {
  group_folder: string;
  kind?: string;
}): Promise<void> {
  if (!isMcpMailScope(scope)) return;
  await ensureMailToolsLoaded(
    scope.group_folder,
    AbortSignal.timeout(MCP_DISCOVERY_TIMEOUT_MS),
  );
}

/**
 * The mail tools registered into the MCP server for `scope`: the allowlisted,
 * currently discovered tools, pinned to the token's own project. `project_id` is
 * not part of their schema (so an argument naming any project is rejected as
 * unknown) and the handler forces the token's project regardless.
 */
export function getMcpMailTools(scope: {
  group_folder: string;
  kind?: string;
}): ToolDefinition[] {
  if (!isMcpMailScope(scope)) return [];
  return ((TOOLSET_MODULES.mail ?? []) as ToolDefinition[])
    .filter((tool) => MCP_MAIL_TOOL_NAMES.has(tool.name))
    .map((tool) => {
      const { project_id: _omitted, ...inputSchema } = tool.inputSchema;
      return {
        ...tool,
        mcpExempt: false,
        inputSchema,
        handler: (args, deps, ctx) =>
          tool.handler({ ...args, project_id: scope.group_folder }, deps, ctx),
      };
    });
}
