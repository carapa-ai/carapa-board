import { z } from 'zod';
import { ASSISTANT_NAME } from '../../config.js';
import {
  createConversation,
  createObjectiveConversation,
  getActiveRunById,
  getConversation,
  getProjectAccess,
  getUserById,
  saveChatMessage,
  setConversationRuntimeSelection,
  updateConversation,
  updateConversationPreview,
  upsertConversationMember,
} from '../../db.js';
import { hasPermission } from '../../mcp/auth.js';
import { getGroupByFolder } from '../../state-manager.js';
import { isOwnedByOtherUser } from '../../lib/project-ownership.js';
import {
  isAutoSelection,
  resolveRuntimeSelection,
  validateRuntimeSelection,
} from '../../lib/chat-agents.js';
import {
  assertRuntimeAllowed,
  crossProjectReadAllowed,
} from '../../lib/privacy-policy.js';
import { MAX_LEN } from '../../routes/_helpers.js';
import type { RegisteredGroup } from '../../types.js';
import { presentAccountIdentity } from '../account/profile.js';
import { ConversationWorktreeTransitionInProgressError } from '../chat/db-chats.js';
import { isSafeWorktreeBranch } from '../chat/worktree-branch.js';
import { userMayPostInConversation } from '../knowledge/db-kb.js';
import { chatEventScope } from '../chat/conversation-scope.js';
import type { StartConversationTurnInput } from '../push/form-response-router.js';
import { getObjective } from '../objectives/db-objectives.js';
import { broadcast } from '../objectives/ws-events.js';
import { serialize } from '../../lib/serial-queue.js';
import type { ToolDefinition } from '../tools/types.js';
import {
  AgentAskPendingError,
  failPendingAgentAsk,
  hasPendingAskOnConversation,
  hasPendingInboundAsk,
  insertAgentAsk,
  isAgentAskTarget,
} from './db-agent-asks.js';

const TITLE_FROM_PROMPT_CHARS = 80;
// No look-ahead: MCP clients written in Go (Antigravity CLI) reject RE2-incompatible schema patterns.
const CALLER_NAME_PATTERN = /^[A-Za-z0-9 ._-]*[A-Za-z0-9._-][A-Za-z0-9 ._-]*$/;

const inputSchema = {
  project_id: z.string().min(1).describe('Target project ID (folder).'),
  prompt: z
    .string()
    .min(1)
    .max(MAX_LEN.message)
    .describe('The message for the target project chat agent.'),
  title: z
    .string()
    .max(120)
    .optional()
    .describe(
      'Title of a new conversation. Defaults to the start of the prompt. Ignored with conversation_id.',
    ),
  caller_name: z
    .string()
    .min(1)
    .max(40)
    .regex(CALLER_NAME_PATTERN)
    .optional()
    .describe(`Name shown as the author. Defaults to "${ASSISTANT_NAME}".`),
  objective_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Address the chat agent of this objective of the target project, in the objective's normal chat, instead of the project chat.",
    ),
  conversation_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Continue this existing conversation of the target project instead of starting a new one. Your human owner must be able to post in it. With objective_id, it must be a chat of that objective.',
    ),
  reply_to_objective_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Objective of the calling project that receives the answer. Use it only when the call has no conversation: a chat agent passes reply_to_conversation_id instead.',
    ),
  reply_to_conversation_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Conversation of the calling project that receives the answer. A chat agent passes the conversation_id from its AGENT_CONTEXT. It must be a conversation of the calling project, owned by your human owner, with your turn running. Ignored when the call already carries its conversation.',
    ),
  runtime_selection: z
    .object({
      harnessId: z.string(),
      modelId: z.string(),
      reasoning: z.string().optional(),
    })
    .optional()
    .describe(
      "Harness and model the NEW conversation runs on, for the asked turn and every later turn. Applies only to new conversations, so it is refused with conversation_id. Allowed values are the target project's configured chat runtimes; Auto is refused. Omit it to use the target project's default.",
    ),
  use_worktree: z
    .boolean()
    .optional()
    .describe(
      "Start the new conversation in a chat worktree of the target project's repository (worktree checkout mode only). Not with conversation_id or objective_id.",
    ),
  branch: z
    .string()
    .optional()
    .describe(
      "With use_worktree: bind to this branch's worktree (created if missing). Default: a new chat-<conversation id> branch.",
    ),
};

export interface AgentAskCallContext {
  group_folder: string;
  task_id?: string;
  conversation_id?: string;
  run_id?: string;
  permissions?: Record<string, string[]>;
  kind?: string;
}

export interface AgentAskAuthorization {
  caller: RegisteredGroup;
  target: RegisteredGroup;
  ownerUserId: string;
  ownerName: string;
  /** The calling conversation, when it belongs to the calling project. */
  callerConversationId: string | null;
  /** The reply objective, when it belongs to the calling project. */
  callerObjectiveId: string | null;
}

export interface AgentAskAuthorizeOptions {
  replyToObjectiveId?: string;
  /** Caller-named reply conversation, used when the token carries none. */
  replyToConversationId?: string;
  /** Whether a turn runs on the conversation; a missing check refuses. */
  isConversationBusy?: (
    groupFolder: string,
    conversationId: string,
  ) => Promise<boolean>;
}

/**
 * Every caller and loop guard for an agent-to-agent ask, in order. Throws a
 * refusal message and has no side effects.
 */
export async function authorizeAgentAsk(
  context: AgentAskCallContext,
  targetFolder: string,
  options: AgentAskAuthorizeOptions = {},
): Promise<AgentAskAuthorization> {
  // 1. Token kind
  if (context.task_id) {
    throw new Error('ask_project_agent is not available to task runs');
  }
  if (context.kind === 'oauth') {
    throw new Error('ask_project_agent is not available to OAuth grants');
  }

  // 2. Caller restriction, from the registered groups only
  const caller = getGroupByFolder(context.group_folder);
  const target = getGroupByFolder(targetFolder);
  const callerIsUserMain = !!caller?.is_main && !!caller.user_id;
  const callerIsParentOfTarget =
    caller?.settings?.isParent === true &&
    !!target &&
    target.parentId === caller.folder;
  if (!caller || (!callerIsUserMain && !callerIsParentOfTarget)) {
    throw new Error(
      'Unauthorized: only a per-user main project, or a parent project asking its direct child, may ask another project',
    );
  }

  // 3. Reach and state
  if (!target) throw new Error(`Project "${targetFolder}" not found`);
  if (target.folder === caller.folder) {
    throw new Error('A project cannot ask itself');
  }
  if (!hasPermission(context.permissions, target.folder, 'chat:write')) {
    throw new Error(
      `Unauthorized: missing "chat:write" permission for project "${target.folder}"`,
    );
  }
  if (!(target.settings?.enabledModes ?? ['kanban', 'chat']).includes('chat')) {
    throw new Error(`Chat is disabled in project "${target.folder}"`);
  }
  const targetStatus = target.settings?.status ?? 'running';
  if (targetStatus === 'paused' || targetStatus === 'stopped') {
    throw new Error(`Project "${target.folder}" is ${targetStatus}`);
  }

  // The prompt leaves the caller's project: a strict caller may only send to a strict target.
  if (!crossProjectReadAllowed(caller.folder, target.folder, 'agent')) {
    throw new Error(
      `Privacy mode of project "${caller.folder}" does not allow sending content to project "${target.folder}"`,
    );
  }

  // 4. Human owner
  const run = context.run_id ? await getActiveRunById(context.run_id) : null;
  const callerConversation = context.conversation_id
    ? await getConversation(context.conversation_id)
    : undefined;
  const ownerUserId =
    run?.triggeredByUserId ??
    callerConversation?.ownerUserId ??
    caller.user_id ??
    null;
  if (!ownerUserId) {
    throw new Error('No human owner could be determined for this ask');
  }
  const owner = await getUserById(ownerUserId);
  if (!owner || owner.disabled) {
    throw new Error('The human owner of this ask is not an active user');
  }
  // Admins skip the check only for an ownerless target; a project owned by
  // another user needs explicit access like any user.
  if (
    owner.role !== 'admin' ||
    isOwnedByOtherUser(ownerUserId, target.folder)
  ) {
    const access = await getProjectAccess(ownerUserId, target.folder);
    if (
      access?.kind !== 'explicit' ||
      (access.level !== 'owner' && access.level !== 'editor')
    ) {
      throw new Error(
        `The human owner of this ask has no editor access to project "${target.folder}"`,
      );
    }
  }

  // 5. Reply destination
  let callerConversationId =
    callerConversation?.group_folder === caller.folder
      ? callerConversation.id
      : null;
  // A relay token carries no conversation, so the calling chat names itself.
  // The id comes from the caller: it must be a running chat of the calling
  // project and of the ask owner.
  if (!callerConversationId && options.replyToConversationId) {
    const named = await getConversation(options.replyToConversationId);
    const label = `reply_to_conversation_id "${options.replyToConversationId}"`;
    if (!named) throw new Error(`${label}: conversation not found`);
    if (named.group_folder !== caller.folder) {
      throw new Error(
        `${label}: not a conversation of the calling project "${caller.folder}"`,
      );
    }
    if (!named.ownerUserId || named.ownerUserId !== ownerUserId) {
      throw new Error(`${label}: not owned by the human owner of this ask`);
    }
    if (!(await options.isConversationBusy?.(caller.folder, named.id))) {
      throw new Error(`${label}: the conversation has no turn in progress`);
    }
    callerConversationId = named.id;
  }
  const objective = options.replyToObjectiveId
    ? await getObjective(options.replyToObjectiveId)
    : undefined;
  // Only an objective of the calling project is stored as a destination.
  const callerObjectiveId =
    objective?.project_id === caller.folder ? objective.id : null;
  if (!callerConversationId) {
    if (!callerObjectiveId) {
      throw new Error(
        'No reply destination: call from a conversation of the calling project, pass reply_to_conversation_id of a running one, or pass reply_to_objective_id of one of its objectives',
      );
    }
  }

  // 6. Hop limit 1
  for (const conversationId of new Set([
    context.conversation_id,
    run?.conversation_id,
    callerConversationId,
  ])) {
    if (conversationId && (await isAgentAskTarget(conversationId))) {
      throw new Error(
        'An agent that was asked by another agent cannot ask further projects',
      );
    }
  }

  // 7. Context-less loop guard
  if (
    !context.conversation_id &&
    !context.run_id &&
    (await hasPendingInboundAsk(caller.folder))
  ) {
    throw new Error(
      'This project has a pending ask from another project; it cannot ask further projects until that is settled',
    );
  }

  return {
    caller,
    target,
    ownerUserId,
    ownerName: (await presentAccountIdentity(owner)).name,
    callerConversationId,
    callerObjectiveId,
  };
}

export interface AskProjectAgentDeps {
  startTurn: (
    input: StartConversationTurnInput,
  ) => Promise<'started' | 'queued'>;
  now: () => number;
  /** Whether a turn runs on, or holds the execution lease of, the conversation. */
  isConversationBusy: (
    groupFolder: string,
    conversationId: string,
  ) => Promise<boolean>;
}

// Loaded lazily: the router sits in an import cycle with the tool registry.
const defaultDeps: AskProjectAgentDeps = {
  startTurn: async (input) =>
    (
      await import('../push/form-response-router.js')
    ).startConversationTurnForMessage(input),
  now: Date.now,
  isConversationBusy: async (groupFolder, conversationId) =>
    (await import('../push/form-response-router.js')).isConversationBusy(
      groupFolder,
      conversationId,
    ),
};

export function createAskProjectAgentTool(
  deps: AskProjectAgentDeps = defaultDeps,
): ToolDefinition {
  return {
    name: 'ask_project_agent',
    description:
      "Prompt the chat agent of another project in a NEW conversation of that project (or, with objective_id, the agent of one of its objectives in a new chat of that objective), or in an existing one when conversation_id is given (your human owner must be able to post there; conversations with a turn in progress are refused), and return at once, without waiting for an answer. The conversation is visible to your human owner in the target project's chat list, who can open it and post in it. The prompt is shown as written by you, never as the human. Allowed for a per-user main project (any project its user may post in) and for a parent project (its direct children). Not available to task runs. A chat agent must pass reply_to_conversation_id with the conversation_id from its AGENT_CONTEXT so the answer returns to its chat; reply_to_objective_id is only for calls that have no conversation. An agent that was itself asked cannot ask further. Optional runtime_selection picks the harness and model of a NEW conversation, and use_worktree starts it in a chat worktree of the target repository.",
    inputSchema,
    requiredPermissions: ['chat:write'],
    authorizesTargetProject: true,
    handler: async (args, _deps, context) => {
      const input = z.object(inputSchema).parse(args);
      const prompt = input.prompt.trim();
      if (!prompt) throw new Error('prompt must not be empty');
      const callerName = input.caller_name?.trim() || ASSISTANT_NAME;
      // A continued conversation is one section per target, so two callers
      // cannot both pass the pending check and write before one loses the
      // insert.
      const admit = async () => {
        const {
          caller,
          target,
          ownerUserId,
          ownerName,
          callerConversationId,
          callerObjectiveId,
        } = await authorizeAgentAsk(context, input.project_id, {
          replyToObjectiveId: input.reply_to_objective_id,
          replyToConversationId: input.reply_to_conversation_id,
          isConversationBusy: deps.isConversationBusy,
        });

        // Refused before anything is written, so a refused runtime
        // leaves no conversation behind.
        const runtimeSelection = input.runtime_selection;
        if (runtimeSelection) {
          if (input.conversation_id) {
            throw new Error(
              'runtime_selection applies only to new conversations',
            );
          }
          const invalid = validateRuntimeSelection(runtimeSelection);
          if (invalid) throw new Error(invalid);
          if (isAutoSelection(runtimeSelection)) {
            throw new Error(
              'runtime_selection must name a concrete model; omit it to use the project default',
            );
          }
          assertRuntimeAllowed({
            projectId: target.folder,
            purpose: 'chat',
            runtime: resolveRuntimeSelection(runtimeSelection),
          });
        }

        // Refused before anything is written, like runtime_selection.
        const branch = input.branch?.trim() || null;
        if (input.use_worktree) {
          if (input.conversation_id) {
            throw new Error('use_worktree applies only to new conversations');
          }
          if (input.objective_id) {
            throw new Error('Objective chats never run in a worktree');
          }
          if (
            !target.settings?.repositoryLocation ||
            target.settings.taskCheckoutMode !== 'worktree'
          ) {
            throw new Error(
              `Project "${target.folder}" has no repository in worktree checkout mode`,
            );
          }
          if (branch && !isSafeWorktreeBranch(branch)) {
            throw new Error('Invalid branch name');
          }
        } else if (input.branch !== undefined) {
          throw new Error('branch requires use_worktree: true');
        }

        const objective = input.objective_id
          ? await getObjective(input.objective_id)
          : undefined;
        if (input.objective_id && objective?.project_id !== target.folder) {
          throw new Error(
            `Objective "${input.objective_id}" not found in project "${target.folder}"`,
          );
        }
        const objectiveId = objective?.id ?? null;

        let conversation;
        if (input.conversation_id) {
          // Same rule as the UI: the human owner must be able to post there.
          conversation = await getConversation(input.conversation_id);
          if (
            !conversation ||
            conversation.group_folder !== target.folder ||
            (conversation.objective_id ?? null) !== objectiveId
          ) {
            throw new Error(
              `Conversation "${input.conversation_id}" is not a ${
                objectiveId
                  ? `chat of objective "${objectiveId}"`
                  : 'project conversation'
              } of "${target.folder}"`,
            );
          }
          if (
            !(await userMayPostInConversation(ownerUserId, conversation.id))
          ) {
            throw new Error(
              `The human owner of this ask has no write access to conversation "${conversation.id}"`,
            );
          }
          if (await hasPendingAskOnConversation(conversation.id)) {
            throw new Error(
              'The target conversation already has a pending ask',
            );
          }
          // The ask must start its own turn: that turn's end is what
          // settles the ask. A busy conversation is refused, never queued.
          if (await deps.isConversationBusy(target.folder, conversation.id)) {
            throw new Error(
              `Conversation "${conversation.id}" has a turn in progress; ask again when it has finished`,
            );
          }
        } else {
          const created = { ownerUserId, triggerSource: 'agent' } as const;
          try {
            conversation = objectiveId
              ? await createObjectiveConversation(
                  target.folder,
                  objectiveId,
                  created,
                )
              : await createConversation(target.folder, {
                  ...created,
                  use_worktree: input.use_worktree,
                  branch_name: branch,
                });
          } catch (err) {
            if (err instanceof ConversationWorktreeTransitionInProgressError) {
              throw new Error(
                `Worktree "${err.branch}" of project "${err.groupFolder}" is being removed; retry after it finishes`,
              );
            }
            throw err;
          }
          if (runtimeSelection) {
            await setConversationRuntimeSelection(
              conversation.id,
              runtimeSelection,
            );
          }
          await upsertConversationMember(ownerUserId, conversation.id, 'owner');
          const title =
            input.title?.trim() || prompt.slice(0, TITLE_FROM_PROMPT_CHARS);
          await updateConversation(conversation.id, target.folder, {
            title,
          });
          await updateConversationPreview(conversation.id, title);
        }

        const now = new Date(deps.now()).toISOString();
        const userMessage = await saveChatMessage({
          group_folder: target.folder,
          role: 'user',
          content: prompt,
          // Composed by the board, and never a human senderUserId: that would
          // make the transcript show the owner's profile name as the author.
          sender_name: `${callerName} (${caller.name}) for ${ownerName}`,
          senderUserId: null,
          source: 'agent',
          created_at: now,
          conversation_id: conversation.id,
          ...(objectiveId ? { objective_id: objectiveId } : {}),
        });
        await updateConversation(conversation.id, target.folder, {
          lastTriggeredByUserId: ownerUserId,
          lastTriggerSource: 'agent',
          lastTriggeredAt: now,
        });
        broadcast({
          type: 'chat_message',
          payload: {
            ...chatEventScope(target.folder, objectiveId),
            message: userMessage,
          },
        });
        broadcast({
          type: 'conversations_changed',
          payload: chatEventScope(target.folder, objectiveId),
        });

        let ask;
        try {
          ask = await insertAgentAsk({
            callerProjectId: caller.folder,
            callerConversationId,
            callerObjectiveId,
            callerRunId: context.run_id ?? null,
            callerName,
            ownerUserId,
            targetProjectId: target.folder,
            targetConversationId: conversation.id,
            askMessageId: userMessage.id,
            status: 'pending',
            createdAt: now,
          });
        } catch (err) {
          if (err instanceof AgentAskPendingError) {
            throw new Error(
              'The target conversation already has a pending ask',
            );
          }
          throw err;
        }

        return {
          caller,
          target,
          ownerUserId,
          ownerName,
          conversation,
          objectiveId,
          userMessage,
          ask,
        };
      };
      const admitted = input.conversation_id
        ? await serialize(`agent-ask-target:${input.conversation_id}`, admit)
        : await admit();
      const {
        caller,
        target,
        ownerUserId,
        ownerName,
        conversation,
        objectiveId,
        userMessage,
        ask,
      } = admitted;

      const header =
        `[Message from agent "${callerName}" of project "${caller.folder}", acting for ${ownerName}. ` +
        `It was not written by ${ownerName}; ${ownerName} can read and post in this conversation. ` +
        'Your final reply is sent back to the sending agent.]';
      try {
        const result = await deps.startTurn({
          group_folder: target.folder,
          conversation_id: conversation.id,
          prompt: `${header}\n\n${prompt}`,
          userMessage,
          leaseOwnerId: `ask:${ask.id}`,
          refuseIfBusy: true,
          agentAskId: ask.id,
          attribution: {
            senderUserId: null,
            triggeredByUserId: ownerUserId,
            triggerSource: 'agent',
          },
          // The caller's answer turn pushes once; an objective caller keeps this push.
          ...(ask.callerConversationId
            ? { lifecycleRecipientUserIds: [] }
            : {}),
        });
        if (result === 'queued') {
          throw new Error(
            `Conversation "${conversation.id}" has a turn in progress; ask again when it has finished`,
          );
        }
      } catch (err) {
        // Settle the ask so it does not hold the caps or the context-less guard.
        const reason = err instanceof Error ? err.message : String(err);
        await failPendingAgentAsk(ask.id, reason);
        throw new Error(
          `The message was saved but its turn could not be started: ${reason}`,
        );
      }

      return {
        ask_id: ask.id,
        project_id: target.folder,
        conversation_id: conversation.id,
        status: ask.status,
        url: objectiveId
          ? `/objective/${target.folder}/${objectiveId}`
          : `/chat/${target.folder}?conversationId=${conversation.id}`,
      };
    },
  };
}

export const askProjectAgentTool = createAskProjectAgentTool();
