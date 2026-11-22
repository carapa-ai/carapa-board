import { z } from 'zod';
import { ToolDefinition } from './types.js';
import {
  getPushTokensForUser,
  deleteStalePushTokens,
  resolvePushTargetUser,
  getActiveRunById,
  getTask,
  getConversation,
  getObjective,
  hasPendingFormForEntity,
  getCurrentStageEntryEvent,
  getStageEntryEventById,
  recordStageEntryLifecycleNotification,
  type RespondToRef,
} from '../../db.js';
import type {
  StageEntryEvent,
  StageEntryLifecycleNotification,
} from '../kanban/types.js';
import {
  getConversationMembers,
  getProjectMembersDetailed,
  getProjectOwnerUserId,
  getUserByUsername,
  getUsernamesByIds,
} from '../knowledge/db-kb.js';
import {
  sendPing,
  type SendPingLogContext,
  type SendPingResult,
  type SendPingTokenInput,
} from '../push/fcm-sender.js';
import { storePayload, type PayloadKind } from '../push/payload-store.js';
import { MAX_PAYLOAD_TTL_MS } from '../push/payload-constants.js';
import { broadcast } from '../objectives/ws-events.js';
import {
  awaitFormResponse,
  cancelPending,
  type FormResponseResult,
} from '../push/pending-responses.js';
import { PUSH_ENABLED } from '../../config.js';
import { logger } from '../../logger.js';
import { getGroupByFolder } from '../../state-manager.js';
import { getGroupStages } from '../kanban/stages.js';
import {
  getViewingDeviceIds,
  isConversationViewedByUser,
} from '../objectives/ws-events.js';

type ResolveResult =
  | { kind: 'ok'; user_ids: string[]; diagnostic?: string }
  | { kind: 'denied'; note: string };

function isPassiveStageEntry(projectId: string, stageId: string): boolean {
  const group = getGroupByFolder(projectId);
  const stage = getGroupStages(group).find(
    (candidate) => candidate.id === stageId,
  );
  if (!group) return true;
  return (
    !!stage &&
    !stage.inactive &&
    stage.runOnEntry === true &&
    (stage.type === 'queue' || stage.type === 'done')
  );
}

export function resolveNotificationRecipientIds(args: {
  ownerUserId: string | null;
  triggeredByUserId: string | null;
  namedUserId?: string | null;
  authorizedUserIds: ReadonlySet<string>;
  form: boolean;
}): { userIds: string[]; expectedFormRecipient: string | null } {
  function allowed(candidate: string | null | undefined): candidate is string {
    return !!candidate && args.authorizedUserIds.has(candidate);
  }
  const expectedFormRecipient = allowed(args.triggeredByUserId)
    ? args.triggeredByUserId
    : allowed(args.ownerUserId)
      ? args.ownerUserId
      : null;
  return {
    expectedFormRecipient,
    userIds: args.form
      ? expectedFormRecipient
        ? [expectedFormRecipient]
        : []
      : // A named user replaces the natural recipients; they are not added to them.
        (args.namedUserId
          ? [args.namedUserId]
          : [args.ownerUserId, args.triggeredByUserId]
        )
          .filter(allowed)
          .filter((id, index, all) => all.indexOf(id) === index),
  };
}

const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — backstop in case nothing else cancels
const MAX_WAIT_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (matches payload TTL)

async function authorizedProjectUsers(
  group_folder: string,
): Promise<Set<string>> {
  const members = await getProjectMembersDetailed(group_folder);
  return new Set(members.map((member) => member.user_id));
}

async function resolveTargets(
  group_folder: string,
  context: {
    task_id?: string;
    conversation_id?: string;
    triggered_by_user_id?: string | null;
  },
  isForm: boolean,
  username?: string,
): Promise<ResolveResult> {
  const entity = context.task_id
    ? await getTask(context.task_id)
    : context.conversation_id
      ? await getConversation(context.conversation_id)
      : undefined;
  const authorized = await authorizedProjectUsers(group_folder);
  if (
    context.conversation_id &&
    entity &&
    'group_folder' in entity &&
    entity.group_folder === group_folder
  ) {
    for (const member of await getConversationMembers(
      context.conversation_id,
    )) {
      authorized.add(member.user_id);
    }
  }
  // The project owner comes from the database, like the member check above:
  // the in-memory group lacks `user_id` for UI-created projects, which record
  // their creator only as an `owner` member.
  const projectOwnerId =
    (await getProjectOwnerUserId(group_folder)) ??
    getGroupByFolder(group_folder)?.user_id ??
    null;
  const entityOwnerId = entity?.ownerUserId ?? null;
  const entityOwnerLabel = context.task_id
    ? 'task owner'
    : 'conversation owner';
  // The entity's owner wins while it is an authorized member; otherwise the
  // project's own owner stands in. Neither is notified unless authorized below.
  const ownerId =
    entityOwnerId && authorized.has(entityOwnerId)
      ? entityOwnerId
      : (projectOwnerId ?? entityOwnerId);
  // An immutable run may explicitly have no human triggerer. Preserve that
  // null so a later entity trigger cannot steal this run's notification.
  // Undefined means no run context was supplied and may use entity metadata.
  const triggererId =
    context.triggered_by_user_id === null
      ? null
      : (context.triggered_by_user_id ?? entity?.lastTriggeredByUserId ?? null);
  const baseRecipients = resolveNotificationRecipientIds({
    ownerUserId: ownerId,
    triggeredByUserId: triggererId,
    authorizedUserIds: authorized,
    form: isForm,
  });
  const naturalFormRecipient = baseRecipients.expectedFormRecipient;

  if (username) {
    const user = await getUserByUsername(username);
    if (!user) {
      return { kind: 'denied', note: `user "${username}" not found` };
    }
    if (!authorized.has(user.id)) {
      return {
        kind: 'denied',
        note: `user "${username}" is not a member of this project`,
      };
    }
    if (isForm && user.id !== naturalFormRecipient) {
      return {
        kind: 'denied',
        note: `actionable forms must target the current triggerer${triggererId ? '' : ' (or the owner when no authorized triggerer exists)'}`,
      };
    }
    return {
      kind: 'ok',
      user_ids: resolveNotificationRecipientIds({
        ownerUserId: ownerId,
        triggeredByUserId: triggererId,
        namedUserId: user.id,
        authorizedUserIds: authorized,
        form: isForm,
      }).userIds,
    };
  }
  return {
    kind: 'ok',
    user_ids: baseRecipients.userIds,
    ...(baseRecipients.userIds.length === 0
      ? {
          diagnostic: [
            `group_folder=${group_folder}`,
            ...(entityOwnerId
              ? [describeCandidate(entityOwnerLabel, entityOwnerId, authorized)]
              : []),
            describeCandidate('project owner', projectOwnerId, authorized),
            describeCandidate('triggerer', triggererId, authorized),
          ].join('; '),
        }
      : {}),
  };
}

/** One candidate recipient and why it was kept or rejected, by user id only. */
function describeCandidate(
  label: string,
  userId: string | null,
  authorized: ReadonlySet<string>,
): string {
  if (!userId) return `${label}=none`;
  return `${label}=${userId} (${authorized.has(userId) ? 'authorized' : 'rejected: not an enabled member of the project'})`;
}

const NO_RECIPIENTS_NOTE =
  'no authorized notification recipient could be resolved';

const PUSH_NOTIFICATION_SUMMARY_MAX = 120;

type SkippedReason = 'not_opted_in' | 'not_member' | 'no_device';

type SkippedRecipient = { username: string; reason: SkippedReason };

/**
 * Name the recipients whose push dispatch was skipped, from the reasons the
 * dispatch itself decided. Exposes usernames only, never tokens or device ids.
 */
async function nameSkippedRecipients(
  skips: readonly { userId: string; reason: SkippedReason }[],
): Promise<SkippedRecipient[]> {
  if (skips.length === 0) return [];
  const usernames = await getUsernamesByIds(skips.map((skip) => skip.userId));
  return skips.map(({ userId, reason }) => ({
    username: usernames[userId] ?? userId,
    reason,
  }));
}

const PUSH_DISABLED_NOTE = 'push notifications are disabled on this server';

/**
 * `skipped` (and a `note` when nobody is reachable) for a notify_user result.
 * With push disabled server-wide (FCM unconfigured) no recipient is dispatched
 * even when eligible; that is not a per-recipient reason, so it goes in `note`.
 */
function skippedResultFields(
  skipped: SkippedRecipient[],
  recipientCount: number,
): { skipped?: typeof skipped; note?: string } {
  const undispatched = skipped.length === recipientCount || !PUSH_ENABLED;
  if (skipped.length === 0 && !undispatched) return {};
  const reasons = skipped.map((entry) => `${entry.username} ${entry.reason}`);
  if (!PUSH_ENABLED && skipped.length < recipientCount)
    reasons.push(PUSH_DISABLED_NOTE);
  return {
    ...(skipped.length > 0 && { skipped }),
    ...(undispatched &&
      recipientCount > 0 && {
        note: `no recipient received a push: ${reasons.join(', ')}`,
      }),
  };
}

/**
 * Redirect an agent's built-in `PushNotification` tool to the user's real
 * devices. Claude Code's `PushNotification` targets *desktop* notifications,
 * which never reach a web/Android user — so the run orchestrator intercepts the
 * streamed tool_use and calls this to fan it out through the same FCM pipeline
 * that backs `notify_user` (mirrors notify_user's wait=false branch: store →
 * broadcast → fire-and-forget push). Best-effort: never throws.
 *
 * `tool_use_id` dedupes delivery — the adopt/recovery path re-streams
 * output.jsonl from byte 0, so the same tool_use can be parsed more than once;
 * `storePayload` returns `created:false` for the duplicate and we skip the push.
 */
export async function firePushNotification(
  group_folder: string,
  input: { message?: unknown; status?: unknown },
  tool_use_id?: string,
  context: {
    task_id?: string;
    conversation_id?: string;
    triggered_by_user_id?: string | null;
  } = {},
): Promise<void> {
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message) return;

  try {
    const resolved = await resolveTargets(group_folder, context, false);
    if (resolved.kind !== 'ok' || resolved.user_ids.length === 0) return;

    for (const user_id of resolved.user_ids) {
      const { id, created } = await storePayload({
        user_id,
        kind: 'text',
        summary: message.slice(0, PUSH_NOTIFICATION_SUMMARY_MAX),
        content: message,
        source_tool_use_id: tool_use_id ?? null,
      });
      if (!created) continue; // duplicate (re-streamed tool_use) — already delivered
      broadcast({ type: 'notification_created', payload: { user_id } });
      if (pushDispatchEnabled(id))
        void pushToUsersIfAllowed(group_folder, user_id, id).catch((err) => {
          logger.warn(
            { user_id, payload_id: id, err: String(err) },
            '[PushNotification] background FCM push failed',
          );
        });
    }
  } catch (err) {
    logger.warn(
      { group_folder, tool_use_id, err: String(err) },
      '[PushNotification] redirect failed',
    );
  }
}

/**
 * Deliver a system-generated notification to the project owner only.
 * `source_id` must remain stable across retries so storage can deduplicate
 * delivery before another FCM ping is sent.
 */
export async function notifyProjectOwner(
  group_folder: string,
  input: { summary: string; content: string; source_id: string },
): Promise<boolean> {
  const ownerId =
    (await getProjectOwnerUserId(group_folder)) ??
    getGroupByFolder(group_folder)?.user_id;
  if (!ownerId) {
    logger.warn({ group_folder }, '[push:system] project has no owner');
    return false;
  }

  return notifyUserSystem(ownerId, group_folder, input);
}

/** Persist a deduplicated system notification for one user and optionally push it. */
export async function notifyUserSystem(
  user_id: string,
  group_folder: string,
  input: {
    summary: string;
    content: string;
    source_id: string;
    action_url?: string | null;
    excluded_device_ids?: ReadonlySet<string>;
    suppress_push?: boolean;
  },
): Promise<boolean> {
  try {
    const { id, created } = await storePayload({
      user_id,
      kind: 'text',
      summary: input.summary.slice(0, PUSH_NOTIFICATION_SUMMARY_MAX),
      content: input.content,
      action_url: input.action_url ?? null,
      source_tool_use_id: input.source_id,
    });
    if (!created) return false;
    broadcast({ type: 'notification_created', payload: { user_id } });
    if (!input.suppress_push && pushDispatchEnabled(id))
      void pushToUsersIfAllowed(
        group_folder,
        user_id,
        id,
        {},
        input.excluded_device_ids,
      ).catch((err) => {
        logger.warn(
          { user_id, payload_id: id, err: String(err) },
          '[push:system-user] background FCM push failed',
        );
      });
    return true;
  } catch (err) {
    logger.warn(
      { group_folder, user_id, source_id: input.source_id, err: String(err) },
      '[push:system-user] notification failed',
    );
    return false;
  }
}

const TASK_NEEDS_ATTENTION_TEXT = 'Task needs your attention';

export async function notifyEntityLifecycle(
  args: {
    group_folder: string;
    task_id?: string;
    conversation_id?: string;
    run_id: string;
    /** Only the ask's own turn may settle it. */
    agent_ask_id?: string;
    agent_ask_answer?: string;
    event: 'completed' | 'failed' | 'needs_input';
    title: string;
    recipient_user_ids?: readonly string[];
    /** Defer a task arrival notification until its automatic stage hook settles. */
    defer_stage_entry?: boolean;
    /** Exact receipt used to validate a deferred stage notification. */
    stage_entry_event_id?: string;
    /** Additional runs whose pending forms suppress a needs-input fallback. */
    pending_form_run_ids?: readonly string[];
  },
  deps: { notifyUser?: typeof notifyUserSystem } = {},
): Promise<void> {
  const notifyUser = deps.notifyUser ?? notifyUserSystem;
  if (args.conversation_id && !args.task_id && args.agent_ask_id) {
    // Deliver the answer of an asked conversation. Never blocks or changes the push below.
    const { group_folder, conversation_id, event } = args;
    void import('../agent-asks/delivery.js')
      .then((m) =>
        m.settleAgentAsksAfterTurn({
          group_folder,
          conversation_id,
          event,
          ask_id: args.agent_ask_id,
          answer: args.agent_ask_answer ?? '',
        }),
      )
      .catch((err) =>
        logger.warn(
          { conversation_id, err: String(err) },
          '[agent-asks] settlement after turn failed',
        ),
      );
  }
  try {
    let loadedTask: Awaited<ReturnType<typeof getTask>> | undefined;
    let stageEntryEvent: StageEntryEvent | undefined;
    let validateStageEntryOwnership = false;
    if (args.task_id && args.stage_entry_event_id) {
      stageEntryEvent = await getStageEntryEventById(args.stage_entry_event_id);
      if (
        !stageEntryEvent ||
        stageEntryEvent.taskId !== args.task_id ||
        stageEntryEvent.projectId !== args.group_folder
      ) {
        return;
      }
      if (args.defer_stage_entry) {
        if (isPassiveStageEntry(args.group_folder, stageEntryEvent.stageId)) {
          validateStageEntryOwnership = true;
        } else {
          // The caller already generated this lifecycle notification for a
          // non-passive stage. Its existing immediate behavior is preserved;
          // only passive stage arrivals use the durable deferral barrier.
          stageEntryEvent = undefined;
        }
      } else {
        validateStageEntryOwnership = true;
      }
    } else if (args.task_id && args.defer_stage_entry) {
      const task = (loadedTask = await getTask(args.task_id));
      if (task && isPassiveStageEntry(args.group_folder, task.status)) {
        stageEntryEvent = await getCurrentStageEntryEvent(
          task.id,
          task.project_id,
          task.status,
        );
      }
    }

    if (args.task_id && args.defer_stage_entry && stageEntryEvent) {
      if (
        stageEntryEvent.state === 'pending' ||
        stageEntryEvent.state === 'claimed' ||
        stageEntryEvent.state === 'running' ||
        stageEntryEvent.state === 'succeeded'
      ) {
        // A lifecycle callback can arrive after the hook has completed but
        // before the transition owner records its arrival. Keep that late
        // callback behind the same durable receipt, including the hook run's
        // pending-form suppression when it is dispatched below.
        const recorded = await recordStageEntryLifecycleNotification(
          stageEntryEvent.id,
          toStageEntryLifecycleNotification(args),
        );
        if (recorded?.state === 'succeeded' && recorded.lifecycleNotification) {
          await notifyStageEntryLifecycle(
            recorded,
            { id: args.task_id, project_id: args.group_folder },
            deps,
          );
        }
      }
      return;
    }

    if (
      args.task_id &&
      args.stage_entry_event_id &&
      validateStageEntryOwnership
    ) {
      const task = (loadedTask = await getTask(args.task_id));
      const currentStageEntryEvent = stageEntryEvent
        ? await getCurrentStageEntryEvent(
            task?.id ?? args.task_id,
            args.group_folder,
            stageEntryEvent.stageId,
          )
        : undefined;
      if (
        !task ||
        task.project_id !== args.group_folder ||
        task.status !== stageEntryEvent?.stageId ||
        stageEntryEvent?.state !== 'succeeded' ||
        currentStageEntryEvent?.id !== stageEntryEvent.id
      ) {
        return;
      }
    }
    const run = await getActiveRunById(args.run_id);
    const resolved = await resolveTargets(
      args.group_folder,
      {
        task_id: args.task_id,
        conversation_id: args.conversation_id,
        triggered_by_user_id: run ? run.triggeredByUserId : undefined,
      },
      false,
    );
    if (resolved.kind !== 'ok') return;
    const explicitRecipientIds = args.recipient_user_ids
      ? new Set(args.recipient_user_ids)
      : null;
    const recipientIds = explicitRecipientIds
      ? resolved.user_ids.filter((userId) => explicitRecipientIds.has(userId))
      : resolved.user_ids;
    const actionUrl = args.task_id
      ? `/board/${encodeURIComponent(args.group_folder)}?taskId=${encodeURIComponent(args.task_id)}`
      : `/chat/${encodeURIComponent(args.group_folder)}?conversationId=${encodeURIComponent(args.conversation_id!)}`;
    // Objective-driven completions are reported to CarapaBrain; keep the
    // in-app notification but skip the phone push.
    let suppressObjectiveCompletionPush = false;
    if (args.task_id && args.event === 'completed') {
      const task =
        loadedTask === undefined ? await getTask(args.task_id) : loadedTask;
      suppressObjectiveCompletionPush =
        typeof task?.objective_id === 'string' && task.objective_id !== '';
    }
    // Task questions never expose task details in the visible push text.
    const visibleText =
      args.task_id && args.event === 'needs_input'
        ? TASK_NEEDS_ATTENTION_TEXT
        : args.title;
    await Promise.all(
      recipientIds.map(async (userId) => {
        if (
          args.conversation_id &&
          isConversationViewedByUser(userId, args.conversation_id)
        ) {
          return;
        }
        if (
          args.event === 'needs_input' &&
          (
            await Promise.all(
              [args.run_id, ...(args.pending_form_run_ids ?? [])]
                .filter(
                  (runId, index, runIds) => runIds.indexOf(runId) === index,
                )
                .map((runId) =>
                  hasPendingFormForEntity(
                    args.task_id ? 'task' : 'chat',
                    args.task_id ?? args.conversation_id!,
                    { userId, runId },
                  ),
                ),
            )
          ).some(Boolean)
        ) {
          return;
        }
        await notifyUser(userId, args.group_folder, {
          summary: visibleText,
          content: visibleText,
          action_url: actionUrl,
          source_id: args.stage_entry_event_id
            ? `stage-entry:${args.stage_entry_event_id}:${args.event}:${userId}`
            : `${args.task_id ? 'task' : 'conversation'}:${args.task_id ?? args.conversation_id}:${args.run_id}:${args.event}:${userId}`,
          excluded_device_ids: args.conversation_id
            ? getViewingDeviceIds(userId, args.conversation_id)
            : undefined,
          suppress_push:
            suppressObjectiveCompletionPush ||
            (args.conversation_id
              ? isConversationViewedByUser(userId, args.conversation_id)
              : false),
        });
      }),
    );
  } catch (err) {
    logger.warn(
      {
        group_folder: args.group_folder,
        task_id: args.task_id,
        conversation_id: args.conversation_id,
        event: args.event,
        err: String(err),
      },
      '[push:lifecycle] notification resolution failed',
    );
  }
}

function toStageEntryLifecycleNotification(
  args: Parameters<typeof notifyEntityLifecycle>[0],
): StageEntryLifecycleNotification {
  return {
    event: args.event,
    title: args.title,
    runId: args.run_id,
    ...(args.recipient_user_ids
      ? { recipientUserIds: [...args.recipient_user_ids] }
      : {}),
  };
}

/** Deliver the arrival notification recorded on a successful stage entry. */
export async function notifyStageEntryLifecycle(
  event: StageEntryEvent,
  task: { id: string; project_id: string },
  deps: { notifyUser?: typeof notifyUserSystem } = {},
): Promise<void> {
  const notification = event.lifecycleNotification;
  if (
    event.state !== 'succeeded' ||
    !notification ||
    !isPassiveStageEntry(task.project_id, event.stageId)
  )
    return;
  await notifyEntityLifecycle(
    {
      group_folder: task.project_id,
      task_id: task.id,
      run_id: notification.runId,
      event: notification.event,
      title: notification.title,
      recipient_user_ids: notification.recipientUserIds,
      stage_entry_event_id: event.id,
      pending_form_run_ids: event.runId ? [event.runId] : undefined,
    },
    deps,
  );
}

export interface PushDispatchDependencies {
  resolveEligibility: typeof resolvePushTargetUser;
  loadTokens: (userId: string) => Promise<SendPingTokenInput[]>;
  sendPing: (
    tokens: SendPingTokenInput[],
    ref?: string,
    kind?: 'ping',
    logContext?: SendPingLogContext,
  ) => Promise<SendPingResult>;
  deleteStaleTokens: (deviceIds: string[]) => Promise<void>;
}

const defaultPushDispatchDependencies: PushDispatchDependencies = {
  resolveEligibility: resolvePushTargetUser,
  loadTokens: getPushTokensForUser,
  sendPing,
  deleteStaleTokens: deleteStalePushTokens,
};

/** What `pushToUsersIfAllowed` decided before any FCM roundtrip. */
type PushDispatchPlan =
  | { skip: SkippedReason }
  | { tokens: SendPingTokenInput[] };

/**
 * The eligibility and device decision for one recipient. It is the only place
 * that decides whether a push is dispatched, so callers report `skip` from it
 * instead of re-reading the same state.
 */
async function planPushDispatch(
  group_folder: string,
  user_id: string,
  ref: string,
  deps: PushDispatchDependencies,
  excludedDeviceIds: ReadonlySet<string>,
): Promise<PushDispatchPlan> {
  const base = { ref, group_folder, user_id };
  const eligibility = await deps.resolveEligibility(group_folder, user_id);
  if (!eligibility.allowed) {
    logger.info(
      {
        ...base,
        outcome: 'ineligible',
        reason: eligibility.reason,
        token_count: 0,
        delivered_count: 0,
        stale_count: 0,
      },
      '[push] dispatch',
    );
    return { skip: eligibility.reason };
  }

  const tokens = (await deps.loadTokens(user_id)).filter(
    (token) => !excludedDeviceIds.has(token.device_id),
  );
  if (tokens.length === 0) {
    logger.info(
      {
        ...base,
        outcome: 'no_tokens',
        token_count: 0,
        delivered_count: 0,
        stale_count: 0,
      },
      '[push] dispatch',
    );
    return { skip: 'no_device' };
  }
  return { tokens };
}

/** Send a planned push; a skipped plan sends nothing. */
async function sendPlannedPush(
  group_folder: string,
  user_id: string,
  ref: string,
  plan: PushDispatchPlan,
  deps: PushDispatchDependencies,
): Promise<{ delivered_count: number; stale_count: number }> {
  if ('skip' in plan) return { delivered_count: 0, stale_count: 0 };
  const { tokens } = plan;
  const result = await deps.sendPing(tokens, ref, 'ping', {
    user_id,
    group_folder,
  });
  if (result.stale.length > 0) {
    await deps.deleteStaleTokens(result.stale);
    logger.info(
      { user_id, stale_count: result.stale.length },
      '[push] cleaned up stale tokens',
    );
  }
  logger.info(
    {
      ref,
      group_folder,
      user_id,
      outcome: 'sent',
      token_count: tokens.length,
      delivered_count: result.delivered.length,
      stale_count: result.stale.length,
    },
    '[push] dispatch',
  );
  return {
    delivered_count: result.delivered.length,
    stale_count: result.stale.length,
  };
}

export async function pushToUsersIfAllowed(
  group_folder: string,
  user_id: string,
  ref: string,
  dependencies: Partial<PushDispatchDependencies> = {},
  excludedDeviceIds: ReadonlySet<string> = new Set(),
): Promise<{ delivered_count: number; stale_count: number }> {
  const deps = { ...defaultPushDispatchDependencies, ...dependencies };
  const plan = await planPushDispatch(
    group_folder,
    user_id,
    ref,
    deps,
    excludedDeviceIds,
  );
  return sendPlannedPush(group_folder, user_id, ref, plan, deps);
}

/** Whether to dispatch push for a payload; logs the skip when PUSH_ENABLED is off. */
function pushDispatchEnabled(payload_id: string): boolean {
  if (!PUSH_ENABLED)
    logger.info(
      { ref: payload_id, outcome: 'push_disabled' },
      '[push] dispatch skipped',
    );
  return PUSH_ENABLED;
}

// IDs are optional in the schema — when omitted, they're auto-filled from the
// calling agent's execution context (the task/chat the agent is running in).
// This lets agents fire form notifications without needing to know their own
// conversation_id or task_id.
const respondToSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('chat'),
    conversation_id: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal('task'), task_id: z.string().min(1).optional() }),
  z.object({
    kind: z.literal('objective'),
    objective_id: z.string().min(1),
    conversation_id: z.string().min(1).optional(),
  }),
]);

function normalizeRespondTo(
  raw: z.infer<typeof respondToSchema> | undefined,
  context: { task_id?: string; conversation_id?: string },
): RespondToRef | null {
  // No respond_to at all — pick the natural default for the calling agent.
  // Task context wins over chat context when both are set (task agents can
  // also have a conversation_id but their messages belong on the task card).
  if (!raw) {
    if (context.task_id) {
      return { kind: 'task', id: context.task_id };
    }
    if (context.conversation_id) {
      return { kind: 'chat', id: context.conversation_id };
    }
    return null;
  }

  if (raw.kind === 'task') {
    const id = raw.task_id || context.task_id;
    if (!id) {
      throw new Error(
        "respond_to.kind='task' needs a task_id, and the calling agent isn't running inside one — pass task_id explicitly",
      );
    }
    return { kind: 'task', id };
  }
  if (raw.kind === 'chat') {
    const id = raw.conversation_id || context.conversation_id;
    if (!id) {
      throw new Error(
        "respond_to.kind='chat' needs a conversation_id, and the calling agent isn't running inside a chat — pass conversation_id explicitly",
      );
    }
    return { kind: 'chat', id };
  }
  // objective
  const conv = raw.conversation_id || context.conversation_id;
  if (!conv) {
    throw new Error(
      "respond_to.kind='objective' needs a conversation_id (the agent's current objective conversation) — pass it explicitly",
    );
  }
  return {
    kind: 'objective',
    id: conv,
    objective_id: raw.objective_id,
  };
}

async function validateRespondToProject(
  respondTo: RespondToRef,
  groupFolder: string,
): Promise<void> {
  if (respondTo.kind === 'task') {
    const task = await getTask(respondTo.id);
    if (!task || task.project_id !== groupFolder) {
      throw new Error('respond_to task must belong to the current project');
    }
    return;
  }

  const conversation = await getConversation(respondTo.id);
  if (!conversation || conversation.group_folder !== groupFolder) {
    throw new Error(
      'respond_to conversation must belong to the current project',
    );
  }
  if (respondTo.kind === 'objective') {
    if (!respondTo.objective_id) {
      throw new Error('respond_to objective_id is required');
    }
    const objective = await getObjective(respondTo.objective_id);
    if (!objective || objective.project_id !== groupFolder) {
      throw new Error(
        'respond_to objective must belong to the current project',
      );
    }
    if (conversation.objective_id !== objective.id) {
      throw new Error(
        'respond_to conversation must belong to the specified objective',
      );
    }
  }
}

/**
 * Internal app path that opens where the calling agent is running: its
 * objective, task board card, or chat conversation. Null when no context.
 */
async function resolveNotifyUserActionUrl(
  group_folder: string,
  context: { task_id?: string; conversation_id?: string },
  respond_to: RespondToRef | null | undefined,
): Promise<string | null> {
  const objectiveUrl = (projectId: string, objectiveId: string) =>
    `/objective/${encodeURIComponent(projectId)}/${encodeURIComponent(objectiveId)}`;
  if (respond_to?.kind === 'objective' && respond_to.objective_id) {
    return objectiveUrl(group_folder, respond_to.objective_id);
  }
  if (context.task_id) {
    return `/board/${encodeURIComponent(group_folder)}?taskId=${encodeURIComponent(context.task_id)}`;
  }
  if (context.conversation_id) {
    const conversation = await getConversation(context.conversation_id);
    if (conversation?.objective_id) {
      return objectiveUrl(conversation.group_folder, conversation.objective_id);
    }
    return `/chat/${encodeURIComponent(group_folder)}?conversationId=${encodeURIComponent(context.conversation_id)}`;
  }
  return null;
}

const NOTIFY_ACTION_PATH_ROOTS = new Set(['objective', 'board', 'chat']);

/**
 * Validates a caller-supplied in-app path for the notification Open button.
 * Only same-origin paths inside the caller's own project are accepted.
 */
function validateNotifyUserActionPath(
  actionPath: string,
  group_folder: string,
): string {
  const invalid = (reason: string) =>
    new Error(
      `Invalid action_path: ${reason}. Expected /objective/${group_folder}/<objective_id>[?query], ` +
        `/board/${group_folder}[?query] or /chat/${group_folder}[?query].`,
    );
  if (!actionPath.startsWith('/') || actionPath.startsWith('//')) {
    throw invalid('must start with a single "/"');
  }
  if (actionPath.includes('\\') || actionPath.includes('#')) {
    throw invalid('must not contain a backslash or "#"');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(actionPath)) {
    throw invalid('must not contain whitespace or control characters');
  }
  const queryStart = actionPath.indexOf('?');
  const pathname =
    queryStart < 0 ? actionPath : actionPath.slice(0, queryStart);
  const segments = pathname.split('/').slice(1);
  const decoded = segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw invalid('contains malformed percent-encoding');
    }
  });
  if (decoded.some((segment) => segment === '..' || segment === '.')) {
    throw invalid('must not contain "." or ".." segments');
  }
  if (
    !NOTIFY_ACTION_PATH_ROOTS.has(decoded[0] ?? '') ||
    decoded[1] !== group_folder
  ) {
    throw invalid('must point inside the current project');
  }
  return actionPath;
}

export const notifyUserTool: ToolDefinition = {
  name: 'notify_user',
  // Forms may intentionally wait for a user response for up to seven days.
  // The handler has its own deadline and listens to the caller's abort signal.
  mcpTimeoutMs: null,
  description:
    "Send a typed notification payload to the user's mobile app. The push " +
    'itself carries no content — only an opaque ref. The app fetches the ' +
    'real payload over the signed-request channel and renders it. ' +
    'Use kind="text" for a simple body, or "json_form" for a structured form ' +
    'whose content is a JSON Schema (subset). ' +
    'For form kinds, the call BLOCKS by default until the user submits and ' +
    'returns the values as the tool result. Set wait=false to fire-and-forget — ' +
    'the response will land in your current conversation/task as a user-message ' +
    'when the user submits. You do NOT need to know your own conversation_id or ' +
    'task_id; respond_to is auto-filled from the calling context if omitted. ' +
    "Recipients are the entity's owner (else the project owner) and the human " +
    'who triggered the run, if enabled members of the current project; forms ' +
    'go to one of them. When none resolves, the result `note` says why. ' +
    'Non-waiting calls return `status: "queued"`; `push_warning` is added ' +
    'when a recipient has no registered push device (the payload is then ' +
    'visible in the app only). `skipped` lists `{ username, reason }` for ' +
    'each recipient who got no push (`not_opted_in`, `not_member` or ' +
    '`no_device`); the in-app payload is still stored for them.',
  inputSchema: {
    summary: z
      .string()
      .min(1)
      .max(120)
      .describe(
        'Short OS-banner text shown in the local notification (≤120 chars).',
      ),
    kind: z
      .enum(['text', 'json_form'])
      .describe(
        'Payload kind. text = plain body. json_form = structured form (content is a JSON Schema).',
      ),
    content: z
      .string()
      .min(1)
      .describe(
        'For text: plain text body. ' +
          'For json_form: a JSON Schema document. Required: `{"type":"object","properties":{...}}`. ' +
          'Optional top-level: `title`, `description`, `required` (array of property names). ' +
          'Each property describes one form field. Supported keys per property: ' +
          '`type` ("string"|"number"|"integer"|"boolean"), ' +
          '`title` (label), `description` (helper text), `default`, ' +
          '`enum` (renders as select), `format` ("email"|"uri"|"tel"|"date"|"multiline"), ' +
          '`minLength`, `maxLength`, `pattern`, `minimum`, `maximum`. ' +
          'Example: {"type":"object","title":"Quick poll","properties":{"answer":{"type":"string","title":"Pick one","enum":["yes","no"]}},"required":["answer"]}. ' +
          "The schema is validated server-side at store time, and again against the user's response at submit time — invalid responses are rejected with 400.",
      ),
    wait: z
      .boolean()
      .optional()
      .describe(
        'Form kinds only. When true (default for forms), the tool call blocks until ' +
          'the user submits and resolves with { status: "submitted", values }. ' +
          'On timeout: { status: "expired" }. Requires a single recipient — pass ' +
          'username or ensure exactly one project member has opted in.',
      ),
    wait_timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'How long to block when wait=true (default 15 min, max 7 days).',
      ),
    respond_to: respondToSchema
      .optional()
      .describe(
        'Where the form response should be logged as a markdown user-message. ' +
          'Independent of `wait` (you can have both: agent gets the values AND a ' +
          'message lands in the conversation). When omitted, defaults to the calling ' +
          "agent's context (the task or chat it's running in) — you do NOT need to " +
          'pass your own task_id or conversation_id, the server fills them in.',
      ),
    ttl_ms: z
      .number()
      .int()
      .positive()
      .max(MAX_PAYLOAD_TTL_MS, 'ttl_ms must not exceed 30 days')
      .optional()
      .describe(
        'Time-to-live in milliseconds (default: 7 days, maximum: 30 days). Expired payloads are purged after a grace period of at least 24 hours.',
      ),
    username: z
      .string()
      .optional()
      .describe(
        'Optional: notify only this user, by username (text notifications). It is exclusive: the owner and the triggering user are NOT notified unless one of them is this user. The target must be a member of this project AND have opted in to push notifications for it (main-group members are opted in by default); otherwise they get the in-app payload only and are listed in the result `skipped`. If omitted, the entity owner (else the project owner) and the triggering user are notified.',
      ),
    action_path: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Optional in-app path for the Open button, e.g. /objective/<project>/<objective_id>?report=<file>. Must be a path inside the caller's project; overrides the automatic link.",
      ),
  },
  requiredPermissions: ['chat:write'],
  handler: async (args, _deps, context) => {
    const { group_folder } = context;
    const explicitActionUrl =
      args.action_path === undefined
        ? null
        : validateNotifyUserActionPath(args.action_path, group_folder);
    // DirectLLM populates task_id and conversation_id directly on context.
    // Board-managed MCP agent runs carry a run-scoped token, so run_id recovers
    // where the agent is working. A run-less token (brain, sandbox scripts)
    // must NOT borrow an arbitrary running row of the group: that would route
    // recipients, respond_to and the Open target to an unrelated member's run.
    let { task_id, conversation_id } = context;
    const contextActiveRun = context.run_id
      ? await getActiveRunById(context.run_id)
      : undefined;
    let resolved_from_active_run = false;
    if (!task_id && !conversation_id && group_folder) {
      if (contextActiveRun) {
        task_id = contextActiveRun.task_id ?? undefined;
        conversation_id = contextActiveRun.conversation_id ?? undefined;
        resolved_from_active_run = !!(task_id || conversation_id);
      } else if (!context.run_id) {
        logger.debug(
          { group_folder },
          '[notify_user] run-less caller; not resolving context from an active run',
        );
      }
    }

    const isForm = args.kind === 'json_form';
    // Some LLMs emit booleans as strings/numbers in JSON tool args. Coerce
    // the common forms so wait=false isn't silently treated as wait=true.
    const waitFalse = isExplicitlyFalse(args.wait);
    const waitTrue = isExplicitlyTrue(args.wait);
    const waitRequested = isForm && !waitFalse; // default true for forms

    logger.info(
      {
        tool: 'notify_user',
        kind: args.kind,
        is_form: isForm,
        wait_raw: args.wait,
        wait_raw_type: typeof args.wait,
        wait_false: waitFalse,
        wait_true: waitTrue,
        wait_requested: waitRequested,
        has_respond_to: !!args.respond_to,
        respond_to_kind: args.respond_to?.kind,
        username: args.username,
        group_folder,
        task_id,
        conversation_id,
        context_resolved_from_active_run: resolved_from_active_run,
      },
      '[notify_user] invoked',
    );

    if (waitTrue && !isForm) {
      throw new Error('wait=true is only valid for kind=json_form');
    }

    const respond_to = normalizeRespondTo(args.respond_to, {
      task_id,
      conversation_id,
    });
    if (args.respond_to && respond_to) {
      await validateRespondToProject(respond_to, group_folder);
    }

    if (isForm && !waitRequested && !respond_to) {
      throw new Error(
        'form notifications must either wait for the response (wait=true) or specify respond_to so the answer has somewhere to land',
      );
    }

    const resolved = await resolveTargets(
      group_folder,
      {
        task_id,
        conversation_id,
        triggered_by_user_id: contextActiveRun?.triggeredByUserId,
      },
      isForm,
      args.username,
    );
    if (resolved.kind === 'denied') {
      return {
        payload_ids: [],
        delivered_count: 0,
        stale_count: 0,
        note: resolved.note,
      };
    }
    if (resolved.user_ids.length === 0) {
      const note = resolved.diagnostic
        ? `${NO_RECIPIENTS_NOTE}: ${resolved.diagnostic}`
        : NO_RECIPIENTS_NOTE;
      logger.warn(
        { group_folder, task_id, conversation_id, kind: args.kind },
        `[notify_user] ${note}`,
      );
      return {
        payload_ids: [],
        delivered_count: 0,
        stale_count: 0,
        note,
      };
    }
    if (waitRequested && resolved.user_ids.length !== 1) {
      throw new Error(
        `wait=true requires exactly one recipient; resolved ${resolved.user_ids.length}. ` +
          'Pass `username` to target a specific person.',
      );
    }

    const payloadIds: string[] = [];
    const action_url =
      explicitActionUrl ??
      (await resolveNotifyUserActionUrl(
        group_folder,
        { task_id, conversation_id },
        respond_to,
      ));

    // Always store payloads synchronously — agents need the IDs back. FCM
    // delivery is async-by-design (Google holds the message and wakes the
    // device), so when the agent isn't going to wait for the user response,
    // there's no benefit to also waiting on the FCM HTTP roundtrip. Run it in
    // the background so the agent isn't blocked on Google's latency.
    for (const user_id of resolved.user_ids) {
      const { id } = await storePayload({
        user_id,
        kind: args.kind as PayloadKind,
        summary: args.summary,
        content: args.content,
        respond_to,
        ttl_ms: args.ttl_ms,
        action_url,
        source_tool_use_id:
          isForm && contextActiveRun
            ? `notify-form-run:${contextActiveRun.id}:${crypto.randomUUID()}`
            : null,
      });
      payloadIds.push(id);
    }

    // Register the form waiter before the payload is exposed over WebSocket or
    // FCM. A foreground client can submit immediately after either signal.
    const payload_id = waitRequested ? payloadIds[0] : undefined;
    const timeoutMs = waitRequested
      ? clampTimeout(args.wait_timeout_ms)
      : undefined;
    const abortSignal = context.signal;
    let responsePromise: Promise<FormResponseResult> | undefined;
    let abortHandler: (() => void) | undefined;
    if (payload_id && timeoutMs !== undefined) {
      responsePromise = awaitFormResponse(payload_id, timeoutMs);
      if (abortSignal) {
        abortHandler = () => cancelPending(payload_id, 'aborted');
        abortSignal.addEventListener('abort', abortHandler, { once: true });
        if (abortSignal.aborted) abortHandler();
      }
    }

    for (const user_id of resolved.user_ids) {
      // Intentionally do NOT include summary/kind/content here. The WS
      // connection stays open while the app is locked or backgrounded — the
      // event is delivered to all of the user's devices regardless of lock
      // state. Summaries (often agent prompts to the user) shouldn't leak
      // past the biometric lock. The client just invalidates its unread
      // query; the actual content is fetched only when the bell renders,
      // which is gated by AuthGate.
      broadcast({
        type: 'notification_created',
        payload: { user_id },
      });
    }

    if (!waitRequested) {
      logger.info(
        { payload_ids: payloadIds, recipients: resolved.user_ids.length },
        '[notify_user] returning immediately (wait=false / non-form) — FCM push is fire-and-forget',
      );
      // Eligibility and device lookups are cheap DB reads that decide the
      // dispatch, so the result reports exactly those decisions; only the FCM
      // roundtrip itself stays fire-and-forget (errors are swallowed by
      // sendPing's per-token try/catch and logged).
      const decisions = await Promise.all(
        resolved.user_ids.map(async (user_id, i) => {
          const payload_id = payloadIds[i];
          try {
            const plan = await planPushDispatch(
              group_folder,
              user_id,
              payload_id,
              defaultPushDispatchDependencies,
              new Set(),
            );
            if ('skip' in plan) return { userId: user_id, reason: plan.skip };
            if (!pushDispatchEnabled(payload_id)) return null;
            void sendPlannedPush(
              group_folder,
              user_id,
              payload_id,
              plan,
              defaultPushDispatchDependencies,
            ).catch((err) => {
              logger.warn(
                { user_id, payload_id, err: String(err) },
                '[notify_user] background FCM push failed',
              );
            });
            return null;
          } catch (err) {
            logger.warn(
              { user_id, payload_id, err: String(err) },
              '[notify_user] background FCM push failed',
            );
            return null;
          }
        }),
      );
      const skips = decisions.filter((d) => d !== null);
      const noDeviceUsernames = (
        await nameSkippedRecipients(
          skips.filter((s) => s.reason === 'no_device'),
        )
      ).map((entry) => entry.username);
      return {
        payload_ids: payloadIds,
        status: 'queued' as const,
        ...(noDeviceUsernames.length > 0 && {
          push_warning: `no push device registered for user ${noDeviceUsernames.join(', ')}; payload is available in the app only`,
        }),
        ...skippedResultFields(
          await nameSkippedRecipients(skips),
          resolved.user_ids.length,
        ),
      };
    }

    // wait=true: we need to know FCM actually accepted the ping before
    // blocking, otherwise we'd just hit the wait timeout for nothing.
    let totalDelivered = 0;
    let totalStale = 0;
    let skippedFields: ReturnType<typeof skippedResultFields> = {};
    try {
      const skips: { userId: string; reason: SkippedReason }[] = [];
      for (let i = 0; i < resolved.user_ids.length; i++) {
        const user_id = resolved.user_ids[i];
        const payload_id = payloadIds[i];
        const plan = await planPushDispatch(
          group_folder,
          user_id,
          payload_id,
          defaultPushDispatchDependencies,
          new Set(),
        );
        if ('skip' in plan) skips.push({ userId: user_id, reason: plan.skip });
        if (!pushDispatchEnabled(payload_id)) continue;
        const result = await sendPlannedPush(
          group_folder,
          user_id,
          payload_id,
          plan,
          defaultPushDispatchDependencies,
        );
        totalDelivered += result.delivered_count;
        totalStale += result.stale_count;
      }
      skippedFields = skippedResultFields(
        await nameSkippedRecipients(skips),
        resolved.user_ids.length,
      );
    } catch (err) {
      cancelPending(payload_id!, 'cancelled');
      if (abortSignal && abortHandler) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
      throw err;
    }

    logger.info(
      { payload_id, timeout_ms: timeoutMs, has_abort_signal: !!abortSignal },
      '[notify_user] blocking on form response',
    );
    let result: FormResponseResult;
    try {
      result = await responsePromise!;
    } finally {
      if (abortSignal && abortHandler) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
    }
    logger.info(
      { payload_id, status: result.status },
      '[notify_user] form response resolved',
    );

    return {
      payload_id,
      delivered_count: totalDelivered,
      stale_count: totalStale,
      ...skippedFields,
      ...result,
    };
  },
};

function clampTimeout(requested: number | undefined): number {
  if (!requested || requested <= 0) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(requested, MAX_WAIT_TIMEOUT_MS);
}

function isExplicitlyFalse(v: unknown): boolean {
  if (v === false) return true;
  if (v === 0) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'false' || s === '0' || s === 'no' || s === 'off';
  }
  return false;
}

function isExplicitlyTrue(v: unknown): boolean {
  if (v === true) return true;
  if (v === 1) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'on';
  }
  return false;
}
