import {
  appPublicationInput,
  getAppPublication,
  setAppPublication,
} from '../../sandbox/app-publication.js';
import {
  lifecycleSandboxInstance,
  resolveEffectiveSandbox,
} from '../../sandbox/effective-settings.js';
import {
  cancelIdleRestart,
  getIdleRestartWaitingOn,
  getLastRestartAt,
  getPendingIdleRestart,
  isIdleRestartPending,
  requestIdleRestart,
  type PendingIdleRestart,
} from '../../sandbox/idle-restart.js';
import { readPersistentBrowsers } from '../../sandbox/browser-sessions.js';
import { countSandboxRestartHolds } from '../../sandbox/restart-holds.js';
import { getTmuxClient } from '../../lib/tmux-client.js';
import { getOnDemandSandboxes } from '../../lib/on-demand-sandboxes.js';
import { logger } from '../../logger.js';
import { z } from 'zod';

import type { ToolDefinition } from '../tools/types.js';
import { effectiveMaxParallel, type RegisteredGroup } from '../../types.js';
import type { StageDefinition } from '../kanban/types.js';
import { hasPermission } from '../../mcp/auth.js';
import { STAGE_ID_PATTERN, validateStages } from '../kanban/stages.js';
import { commitProjectStageMigration } from '../kanban/db-kanban.js';
import { inheritParentStages } from './stage-inheritance.js';
import { withReparentMutex } from '../projects/reparent-project.js';
import {
  validateRuntimeSelection,
  getRuntimeCatalog,
} from '../../lib/chat-agents.js';
import { drainProjectQueue } from '../kanban/task/pipeline.js';
import { getAiUserRow } from '../../db.js';
import { updateProjectSettingsWithAdmissionLock } from '../../db.js';
import {
  applyGroupUpdateInMemory,
  serializeSettingsForDb,
} from '../../state-manager.js';
import {
  applyProjectPrompt,
  findCurrentGroup,
  findGroupByFolder,
  getStagesWithAlternativesForGroup,
  projectSetupRevision,
  readLocalPrompts,
  requireRevision,
  revisionFor,
} from './project-prompts.js';

export { projectSetupRevision };

const MAX_PROMPT_CHARS = 100_000;

const runtimeSelectionSchema = z.object({
  harnessId: z.string().min(1),
  modelId: z.string().min(1),
  reasoning: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const stageSchema = z.object({
  id: z.string().regex(STAGE_ID_PATTERN),
  title: z.string().min(1).max(200),
  type: z.enum(['queue', 'active', 'testing', 'done', 'review']),
  color: z.string().min(1).max(40),
  inactive: z.boolean().optional(),
  record: z.boolean().optional(),
  runOnEntry: z.boolean().optional(),
  persistSession: z.boolean().optional(),
  runtimeSelection: runtimeSelectionSchema.optional(),
  minTier: z.enum(['fast', 'balanced', 'frontier']).optional(),
  workerSandbox: z.string().max(200).optional(),
  mainAiUserId: z.string().min(1).max(200).optional(),
  stallTimeoutMs: z.number().int().positive().optional(),
  stallGraceMs: z.number().int().nonnegative().optional(),
});

function requireTargetPermission(
  permissions: Record<string, string[]> | undefined,
  folder: string,
  permission: 'project_setup:read' | 'project_setup:write' | 'sandbox:restart',
): void {
  if (!hasPermission(permissions, folder, permission)) {
    throw new Error(
      `Unauthorized: missing "${permission}" permission for project "${folder}"`,
    );
  }
}

function targetFolder(requested: unknown, contextFolder: string): string {
  return typeof requested === 'string' && requested.trim()
    ? requested.trim()
    : contextFolder;
}

function effectiveStageOwner(
  group: RegisteredGroup,
  groups: Record<string, RegisteredGroup>,
): RegisteredGroup {
  if (group.settings?.stages?.length || !group.parentId) return group;
  return findGroupByFolder(groups, group.parentId) ?? group;
}

export const getProjectSetupTool: ToolDefinition = {
  name: 'get_project_setup',
  description:
    'Read pipeline setup for the current project or an authorized direct child: effective stages, board-owned prompts, safe runtime choices, and whether a repository is connected. Never returns repository paths, URLs, or credentials.',
  inputSchema: {
    target_project: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Project folder from AGENT_CONTEXT. Required for a child project running in a shared parent sandbox.',
      ),
  },
  requiredPermissions: ['project_setup:read'],
  handler: async ({ target_project }, deps, context) => {
    const target = targetFolder(target_project, context.group_folder);
    requireTargetPermission(context.permissions, target, 'project_setup:read');
    const groups = deps.getRegisteredGroups();
    const { group } = findCurrentGroup(groups, target);
    const stages = getStagesWithAlternativesForGroup(group, groups);
    const stageOwner = effectiveStageOwner(group, groups);
    const [localPrompts, effectiveStagePrompts] = await Promise.all([
      readLocalPrompts(
        group,
        stages.map((stage) => stage.id),
      ),
      readLocalPrompts(
        stageOwner,
        stages.map((stage) => stage.id),
      ),
    ]);
    const repositorySource = group.settings?.repositoryLocation
      ? 'local'
      : group.settings?.repositoryUrl
        ? 'remote'
        : group.settings?.repositoryRelativePath
          ? 'shared'
          : 'none';

    return JSON.stringify(
      {
        projectId: group.folder,
        codeEnabled: group.settings?.codeEnabled ?? !group.is_main,
        repository: {
          connected: repositorySource !== 'none',
          source: repositorySource,
          defaultBranch: group.settings?.defaultBranch || 'develop',
        },
        taskCheckout: {
          mode: group.settings?.taskCheckoutMode ?? 'shared',
          configuredMaxParallel: group.settings?.maxParallelWorktrees ?? 1,
          effectiveMaxParallel: effectiveMaxParallel(group.settings),
        },
        stages,
        stagesInherited: stageOwner.folder !== group.folder,
        prompts: {
          system: localPrompts.system,
          worker: localPrompts.worker,
          stages:
            stageOwner.folder === group.folder
              ? localPrompts.stages
              : effectiveStagePrompts.stages,
          stagePromptsInherited: stageOwner.folder !== group.folder,
        },
        // Project default for task runs; stage runtimeSelection overrides it,
        // and it takes precedence over runtimeCatalog.defaults.kanban.
        kanbanRuntimeSelection: group.settings?.kanbanRuntimeSelection ?? null,
        runtimeCatalog: getRuntimeCatalog(),
        revision: await revisionFor(group, groups),
      },
      null,
      2,
    );
  },
};

export const setProjectTaskCheckoutModeTool: ToolDefinition = {
  name: 'set_project_task_checkout_mode',
  description:
    'Set shared, branch, or worktree task checkout mode for the current project or an authorized direct child after explicit user approval.',
  inputSchema: {
    target_project: z.string().min(1).optional(),
    expected_revision: z.string().min(1),
    mode: z.enum(['shared', 'branch', 'worktree']),
  },
  requiredPermissions: ['project_setup:write'],
  authorizesTargetProject: true,
  handler: async (
    { target_project, expected_revision, mode },
    deps,
    context,
  ) => {
    const target = targetFolder(target_project, context.group_folder);
    requireTargetPermission(context.permissions, target, 'project_setup:write');
    const groups = deps.getRegisteredGroups();
    const { jid, group } = findCurrentGroup(groups, target);
    await requireRevision(expected_revision, group, groups);
    const previousMaxParallel = effectiveMaxParallel(group.settings);
    const nextSettings = { ...(group.settings ?? {}), taskCheckoutMode: mode };
    await updateProjectSettingsWithAdmissionLock(
      group.folder,
      serializeSettingsForDb(nextSettings) ?? '{}',
    );
    nextSettings.appPublication = group.settings?.appPublication;
    group.settings = nextSettings;
    applyGroupUpdateInMemory(jid, { settings: nextSettings });
    // Queue drains are event-driven: switching to worktree mode with
    // maxParallelWorktrees > 1 adds task slots that would otherwise stay idle
    // until a running task finished and woke the queue.
    if (effectiveMaxParallel(nextSettings) > previousMaxParallel) {
      drainProjectQueue(group.folder, group).catch((error) =>
        logger.error(
          { error: String(error), group: group.folder },
          'Failed to drain project queue after checkout mode change',
        ),
      );
    }
    return JSON.stringify({
      ok: true,
      taskCheckout: {
        mode,
        configuredMaxParallel: group.settings?.maxParallelWorktrees ?? 1,
        effectiveMaxParallel: effectiveMaxParallel({
          ...(group.settings ?? {}),
          taskCheckoutMode: mode,
        }),
      },
      revision: await revisionFor(group, groups),
    });
  },
};

export const setProjectStagesTool: ToolDefinition = {
  name: 'set_project_stages',
  description:
    "Replace pipeline stages for the current project or an authorized direct child after user approval. An id of the form <base>.<suffix> (e.g. coding.b, review.o) defines a stage alternative of an active, testing or review base stage; it overrides only run config (runtime, sandbox, persona, recording, stall timeouts) and never appears as a board column. Set runOnEntry explicitly to enable or disable a one-shot hook; configure its prompt separately with set_project_prompt. Pass inherit_from_parent: true instead of stages to remove a child project's own stage list so it inherits its parent's stages again (refused for a project without a parent, and while tasks sit in stages the parent lacks; the child's stage prompt files stay on disk but the parent's prompts apply). Pass the revision returned by get_project_setup to prevent overwriting concurrent changes.",
  inputSchema: {
    target_project: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Project folder returned by get_project_setup. Required for a child project in a shared parent sandbox.',
      ),
    expected_revision: z.string().min(1),
    stages: z
      .array(stageSchema)
      .min(1)
      .max(30)
      .optional()
      .describe('Required unless inherit_from_parent is true.'),
    inherit_from_parent: z
      .literal(true)
      .optional()
      .describe(
        "Mutually exclusive with stages: drop this child project's own stages so it inherits its parent's.",
      ),
  },
  requiredPermissions: ['project_setup:write'],
  authorizesTargetProject: true,
  handler: async (
    { target_project, expected_revision, stages, inherit_from_parent },
    deps,
    context,
  ) => {
    if (inherit_from_parent && stages) {
      throw new Error('Pass either stages or inherit_from_parent, not both');
    }
    const target = targetFolder(target_project, context.group_folder);
    requireTargetPermission(context.permissions, target, 'project_setup:write');
    const groups = deps.getRegisteredGroups();
    const { jid, group } = findCurrentGroup(groups, target);
    await requireRevision(expected_revision, group, groups);

    if (inherit_from_parent) {
      await inheritParentStages(
        group,
        (folder) => findGroupByFolder(groups, folder),
        (settings) => {
          group.settings = settings;
          applyGroupUpdateInMemory(jid, { settings });
        },
      );
      return JSON.stringify({
        ok: true,
        stages: getStagesWithAlternativesForGroup(group, groups),
        stagesInherited: true,
        revision: await revisionFor(group, groups),
      });
    }
    if (!stages) {
      throw new Error('Pass stages, or inherit_from_parent: true');
    }

    const validationError = validateStages(stages as StageDefinition[]);
    if (validationError) throw new Error(`Invalid stages: ${validationError}`);
    for (const stage of stages as StageDefinition[]) {
      const runtimeError = validateRuntimeSelection(stage.runtimeSelection);
      if (runtimeError) {
        throw new Error(
          `Invalid runtime selection for stage "${stage.id}": ${runtimeError}`,
        );
      }
      if (stage.mainAiUserId) {
        if (!['active', 'testing', 'review'].includes(stage.type)) {
          throw new Error(
            `Stage mainAiUserId is only valid for executable stages`,
          );
        }
        const aiUser = await getAiUserRow(stage.mainAiUserId);
        if (!aiUser?.enabled) {
          throw new Error(
            `Stage mainAiUserId must reference an enabled AI user`,
          );
        }
      }
    }

    const settings = { ...(group.settings ?? {}), stages };
    await commitProjectStageMigration(
      group.folder,
      serializeSettingsForDb(settings),
      [],
    );
    group.settings = settings;
    applyGroupUpdateInMemory(jid, { settings });
    return JSON.stringify({
      ok: true,
      stages,
      revision: await revisionFor(group, groups),
    });
  },
};

export const setProjectPromptTool: ToolDefinition = {
  name: 'set_project_prompt',
  description:
    'Set or remove one system, shared worker, or executable or run-on-entry stage prompt for the current project or an authorized direct child after user approval. For a stage prompt, stage_id may also be a configured stage alternative such as coding.b (file stage-coding.b.md); without its own prompt an alternative uses the base stage prompt. Null or blank content removes the prompt. Pass the latest setup revision.',
  inputSchema: {
    target_project: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Project folder returned by get_project_setup. Required for a child project in a shared parent sandbox.',
      ),
    expected_revision: z.string().min(1),
    prompt_type: z.enum(['system', 'worker', 'stage']),
    stage_id: z.string().regex(STAGE_ID_PATTERN).optional(),
    content: z.string().max(MAX_PROMPT_CHARS).nullable(),
  },
  requiredPermissions: ['project_setup:write'],
  authorizesTargetProject: true,
  handler: async (
    { target_project, expected_revision, prompt_type, stage_id, content },
    deps,
    context,
  ) => {
    const target = targetFolder(target_project, context.group_folder);
    requireTargetPermission(context.permissions, target, 'project_setup:write');
    return withReparentMutex(async () => {
      const groups = deps.getRegisteredGroups();
      const { group } = findCurrentGroup(groups, target);
      await requireRevision(expected_revision, group, groups);

      const { removed, revision } = await applyProjectPrompt(
        groups,
        target,
        prompt_type,
        stage_id,
        content,
      );

      return JSON.stringify({
        ok: true,
        promptType: prompt_type,
        stageId: stage_id ?? null,
        removed,
        revision,
      });
    });
  },
};

export const publishAppTool: ToolDefinition = {
  name: 'publish_app',
  description:
    'Publish or revoke this project app for access outside Board when requested by the user. Start the app on 0.0.0.0 at the supplied port first. Board selects the sandbox. Returns ingress readiness and a URL; DNS/TLS and app behavior still need verification.',
  inputSchema: {
    target_project: z.string().min(1).optional(),
    ...appPublicationInput.shape,
  },
  requiredPermissions: ['project_setup:write'],
  authorizesTargetProject: true,
  mcpTimeoutMs: 90_000,
  handler: async ({ target_project, ...input }, deps, context) => {
    const target = targetFolder(target_project, context.group_folder);
    requireTargetPermission(context.permissions, target, 'project_setup:write');
    const groups = deps.getRegisteredGroups();
    const { group } = findCurrentGroup(groups, target);
    const effective = resolveEffectiveSandbox(group, (folder) =>
      findGroupByFolder(groups, folder),
    );
    requireTargetPermission(
      context.permissions,
      effective.ownerProjectId,
      'project_setup:write',
    );
    return JSON.stringify(await setAppPublication(group, input));
  },
};

export const getPublishedAppTool: ToolDefinition = {
  name: 'get_published_app',
  description:
    'Inspect this project app publication and its external URL without exposing a new port. Readiness refers to the ingress route, not application health or external DNS/TLS.',
  inputSchema: { target_project: z.string().min(1).optional() },
  requiredPermissions: ['project_setup:read'],
  handler: async ({ target_project }, deps, context) => {
    const target = targetFolder(target_project, context.group_folder);
    requireTargetPermission(context.permissions, target, 'project_setup:read');
    const { group } = findCurrentGroup(deps.getRegisteredGroups(), target);
    return JSON.stringify(await getAppPublication(group));
  },
};

export const SANDBOX_RESTART_COOLDOWN_MS = 10 * 60_000;

export interface SandboxRestartWillTerminate {
  tmuxSessions?: number;
  browserSessions?: number;
  onDemandSandboxes?: number;
}

/** Idle-restart operations used by `sandbox_restart_when_idle`; injectable for tests. */
export interface SandboxRestartApi {
  request: typeof requestIdleRestart;
  cancel: typeof cancelIdleRestart;
  getPending: typeof getPendingIdleRestart;
  isPending: typeof isIdleRestartPending;
  getLastRestartAt: typeof getLastRestartAt;
  getWaitingOn: typeof getIdleRestartWaitingOn;
  countHolds: typeof countSandboxRestartHolds;
  willTerminate: (
    stack: string,
    instance: string,
  ) => SandboxRestartWillTerminate;
  now: () => number;
}

/** In-memory registries only; a field is omitted when its registry cannot be read. */
function readWillTerminate(
  stack: string,
  instance: string,
): SandboxRestartWillTerminate {
  const result: SandboxRestartWillTerminate = {};
  try {
    result.tmuxSessions = Object.values(getTmuxClient().listSessions()).filter(
      (record) => record.instance === instance,
    ).length;
  } catch {
    /* omitted */
  }
  try {
    result.browserSessions = readPersistentBrowsers(stack, instance).length;
  } catch {
    /* omitted */
  }
  try {
    result.onDemandSandboxes = Object.values(
      getOnDemandSandboxes().list(),
    ).filter((record) => record.instance === instance).length;
  } catch {
    /* omitted */
  }
  return result;
}

// Wrapped lazily: this module sits inside an import cycle with idle-restart.
const defaultSandboxRestartApi: SandboxRestartApi = {
  request: (input) => requestIdleRestart(input),
  cancel: (instance) => cancelIdleRestart(instance),
  getPending: (instance) => getPendingIdleRestart(instance),
  isPending: (instance) => isIdleRestartPending(instance),
  getLastRestartAt: (instance) => getLastRestartAt(instance),
  getWaitingOn: (entry) => getIdleRestartWaitingOn(entry),
  countHolds: (stack, service, instance) =>
    countSandboxRestartHolds(stack, service, instance),
  willTerminate: readWillTerminate,
  now: Date.now,
};

function describePendingRestart(entry: PendingIdleRestart) {
  return {
    requestedAt: entry.requestedAt,
    reason: entry.reason,
    held: !!entry.heldSince,
    ...(entry.heldSince ? { heldSince: entry.heldSince } : {}),
    requestedBy: {
      groupFolder: entry.requestedBy,
      ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
      ...(entry.runId ? { runId: entry.runId } : {}),
    },
  };
}

export function createSandboxRestartWhenIdleTool(
  api: SandboxRestartApi = defaultSandboxRestartApi,
): ToolDefinition {
  return {
    name: 'sandbox_restart_when_idle',
    description:
      "Schedule (action=request), cancel (action=cancel) or inspect (action=status) a restart of this project's sandbox, or of an authorized child project's sandbox via target_project. The restart happens only once no task, chat or brain run is active on that sandbox, no restart hold is set inside it (`restart-hold run NAME CMD...` keeps the sandbox from being restarted automatically until CMD exits; see `restart-hold` without arguments; status reports active holds as waitingOn.holds; while a hold blocks a pending restart, task runs and brain runs continue) and, unless it is a plain CarapaBot sandbox, no deploy build is running; until then new task runs are held (chat messages are not blocked but delay the restart). The restart still ends tmux shells, browser sessions and preview/dev servers, which are not restored. Not available to task runs. A 10-minute cooldown applies after any restart of the sandbox. `reason` (3-300 chars) is required for request. A sandbox shared by several projects can only be restarted by its owner project, the main project or the owner's parent.",
    inputSchema: {
      action: z.enum(['request', 'cancel', 'status']),
      target_project: z.string().min(1).optional(),
      reason: z.string().min(3).max(300).optional(),
    },
    requiredPermissions: ['sandbox:restart'],
    authorizesTargetProject: true,
    handler: async ({ action, target_project, reason }, deps, context) => {
      if (context.task_id) {
        throw new Error(
          'sandbox_restart_when_idle is not available to task runs',
        );
      }
      const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
      if (
        action === 'request' &&
        (trimmedReason.length < 3 || trimmedReason.length > 300)
      ) {
        throw new Error('reason (3-300 characters) is required for request');
      }
      const target = targetFolder(target_project, context.group_folder);
      requireTargetPermission(context.permissions, target, 'sandbox:restart');
      const groups = deps.getRegisteredGroups();
      const { group } = findCurrentGroup(groups, target);
      const effective = resolveEffectiveSandbox(group, (folder) =>
        findGroupByFolder(groups, folder),
      );
      requireTargetPermission(
        context.permissions,
        effective.ownerProjectId,
        'sandbox:restart',
      );
      if (effective.fixedInstance) {
        throw new Error('This sandbox instance is externally managed');
      }
      if (effective.owner.settings?.sandboxOwnership === 'shared') {
        const caller = findGroupByFolder(groups, context.group_folder);
        if (
          context.group_folder !== effective.ownerProjectId &&
          !caller?.is_main &&
          effective.owner.parentId !== context.group_folder
        ) {
          throw new Error(
            `Unauthorized: sandbox is shared and owned by project "${effective.ownerProjectId}"`,
          );
        }
      }
      const { stack, service } = effective;
      const instance = lifecycleSandboxInstance(effective);

      if (action === 'cancel') {
        const cancelled = await api.cancel(instance);
        if (cancelled) {
          logger.info(
            { instance, requestedBy: context.group_folder },
            'Pending sandbox restart cancelled via MCP',
          );
        }
        return JSON.stringify({ cancelled });
      }

      const existing = api.getPending(instance);
      if (action === 'request') {
        if (existing) {
          return JSON.stringify({
            ok: true,
            alreadyPending: true,
            ...describePendingRestart(existing),
          });
        }
        if (api.isPending(instance)) {
          throw new Error('A restart of this sandbox is already in progress');
        }
        const remaining = cooldownRemainingMs(api, instance);
        if (remaining > 0) {
          throw new Error(
            `Sandbox was restarted recently; try again in ${Math.ceil(remaining / 1000)}s (cooldown ${SANDBOX_RESTART_COOLDOWN_MS / 60_000} min)`,
          );
        }
        const entry = await api.request({
          stack,
          instance,
          service,
          requestedBy: context.group_folder,
          target: effective,
          source: 'mcp',
          reason: trimmedReason,
          conversationId: context.conversation_id,
          runId: context.run_id,
        });
        logger.info(
          {
            stack,
            instance,
            reason: entry.reason,
            requestedBy: entry.requestedBy,
            conversationId: entry.conversationId,
            runId: entry.runId,
            source: entry.source,
          },
          'Sandbox restart-when-idle requested via MCP',
        );
        return JSON.stringify({
          ok: true,
          alreadyPending: false,
          ...describePendingRestart(entry),
        });
      }

      const lastRestartAt = api.getLastRestartAt(instance);
      const cooldownRemaining = cooldownRemainingMs(api, instance);
      // Holds are read live either way, so an agent can confirm the board sees
      // a hold it set; omitted when the sandbox cannot report them.
      const holds = existing
        ? undefined
        : await api.countHolds(stack, service, instance);
      return JSON.stringify({
        pending: !!existing,
        ...(existing ? describePendingRestart(existing) : {}),
        waitingOn: existing
          ? await api.getWaitingOn(existing)
          : {
              taskRuns: 0,
              chatRuns: 0,
              brainRuns: 0,
              builds: 0,
              ...(holds === null || holds === undefined ? {} : { holds }),
            },
        ...(lastRestartAt ? { lastRestartAt } : {}),
        ...(cooldownRemaining > 0
          ? { cooldownRemainingMs: cooldownRemaining }
          : {}),
        willTerminate: api.willTerminate(stack, instance),
      });
    },
  };
}

function cooldownRemainingMs(api: SandboxRestartApi, instance: string): number {
  const last = api.getLastRestartAt(instance);
  if (!last) return 0;
  return Math.max(
    0,
    Date.parse(last) + SANDBOX_RESTART_COOLDOWN_MS - api.now(),
  );
}

export const sandboxRestartWhenIdleTool = createSandboxRestartWhenIdleTool();
