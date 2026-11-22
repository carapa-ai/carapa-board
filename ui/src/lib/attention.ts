import type {
  AttentionItem,
  AttentionResponse,
  AttentionState,
  UnreadNotification,
} from '@/lib/api';

/**
 * Optimistically mark a conversation the user just opened as viewed. Its Now
 * row stays until the user dismisses it. A running conversation is untouched:
 * opening it does not end the run.
 */
export function markConversationViewedInAttention(
  old: AttentionResponse | undefined,
  conversationId: string,
): AttentionResponse | undefined {
  if (!old) return old;
  return {
    ...old,
    items: old.items.map((item) =>
      item.kind === 'conversation' &&
      item.id === conversationId &&
      item.state !== 'running'
        ? { ...item, unread: false }
        : item,
    ),
  };
}

/** How long a running task row survives being missing from the server list. */
const RUNNING_TASK_HOLD_MS = 6_000;

/**
 * Between pipeline stages a task's run has ended and the next one has not
 * started yet, so for a moment the task is in no Now state at all. Keep a
 * running task row that vanished from the fetched list for up to
 * RUNNING_TASK_HOLD_MS so the Now section does not flicker. A row the server
 * returns in any state replaces the held copy at once.
 *
 * `heldSince` maps held task ids to when they were first missing; the
 * returned map replaces it.
 */
export function holdVanishedRunningTasks(
  previous: AttentionResponse | undefined,
  next: AttentionResponse,
  heldSince: ReadonlyMap<string, number>,
  now: number,
): { response: AttentionResponse; heldSince: Map<string, number> } {
  const present = new Set(
    next.items.filter((item) => item.kind === 'task').map((item) => item.id),
  );
  const held: AttentionItem[] = [];
  const nextHeldSince = new Map<string, number>();
  for (const item of previous?.items ?? []) {
    if (item.kind !== 'task' || item.state !== 'running') continue;
    if (present.has(item.id)) continue;
    const since = heldSince.get(item.id) ?? now;
    if (now - since >= RUNNING_TASK_HOLD_MS) continue;
    nextHeldSince.set(item.id, since);
    held.push(item);
  }
  return {
    response: held.length ? { ...next, items: [...next.items, ...held] } : next,
    heldSince: nextHeldSince,
  };
}

export type NowGroupId = 'running' | 'needs-you' | 'unread' | 'completed';

export const NOW_GROUP_IDS: readonly NowGroupId[] = [
  'running',
  'needs-you',
  'unread',
  'completed',
];

export const NOW_GROUP_LABELS: Record<NowGroupId, string> = {
  running: 'Running',
  'needs-you': 'Needs you',
  unread: 'Replies',
  completed: 'Completed',
};

export interface NowRowModel {
  key: string;
  kind: 'conversation' | 'task';
  /** Conversation or task id. */
  id: string;
  projectId?: string;
  objectiveId?: string;
  title: string;
  state: AttentionState;
  at: string;
  /** Conversations: false once the latest reply was opened. */
  unread?: boolean;
  /** Unread text notifications about this row; dismissing the row acks them. */
  notificationIds: string[];
  /** Unanswered form about this row: it is answered from the bell, not checked off. */
  formNotificationId?: string;
}

export type NowGroups = Record<NowGroupId, NowRowModel[]>;

export interface AttentionPartition {
  groups: NowGroups;
  /**
   * Notifications that are not about a conversation or task. Objective-linked
   * notifications are always here, whether or not the objective has a row.
   */
  bellNotifications: UnreadNotification[];
}

/** The conversation, task or objective an unread notification links to. */
function notificationTarget(actionUrl: string | null | undefined) {
  if (!actionUrl) return null;
  const [path, query = ''] = actionUrl.split('?');
  const params = new URLSearchParams(query);
  const segments = path.split('/').filter(Boolean);
  const projectId = segments[1];
  if (segments[0] === 'chat' && params.get('conversationId'))
    return {
      kind: 'conversation' as const,
      id: params.get('conversationId')!,
      projectId,
    };
  if (segments[0] === 'board' && params.get('taskId'))
    return { kind: 'task' as const, id: params.get('taskId')!, projectId };
  if (segments[0] === 'objective' && segments[2])
    return { kind: 'objective' as const, id: segments[2], projectId };
  return null;
}

export function groupForState(state: AttentionState): NowGroupId {
  switch (state) {
    case 'running':
      return 'running';
    case 'pending':
    case 'failed':
    case 'question':
      return 'needs-you';
    case 'unread':
      return 'unread';
    case 'completed':
      return 'completed';
  }
}

/**
 * Split the attention items and unread notifications between the Now list and
 * the bell. Conversations and tasks live only in Now: a notification linking
 * to one attaches to its row (or creates the row when the item list has none).
 * Everything else stays in the bell, including every objective-linked
 * notification: it never attaches to a row, so dismissing a row cannot ack it.
 */
export function partitionAttention(
  items: readonly AttentionItem[],
  notifications: readonly UnreadNotification[],
): AttentionPartition {
  const rows: NowRowModel[] = [];
  const rowsByTarget = new Map<string, NowRowModel>();
  for (const item of items) {
    const row: NowRowModel = {
      key: `${item.kind}:${item.id}`,
      kind: item.kind,
      id: item.id,
      projectId: item.projectId,
      objectiveId: item.objectiveId,
      title: item.title,
      state: item.state,
      at: item.at,
      unread: item.unread,
      notificationIds: [],
    };
    rows.push(row);
    rowsByTarget.set(row.key, row);
  }

  const bellNotifications: UnreadNotification[] = [];
  for (const notification of notifications) {
    const target = notificationTarget(notification.action_url);
    if (!target || target.kind === 'objective') {
      bellNotifications.push(notification);
      continue;
    }
    let row = rowsByTarget.get(`${target.kind}:${target.id}`);
    if (!row) {
      row = {
        key: `${target.kind}:${target.id}`,
        kind: target.kind,
        id: target.id,
        projectId: target.projectId,
        title: notification.summary,
        state: notification.kind === 'text' ? 'unread' : 'pending',
        at: notification.created_at,
        notificationIds: [],
      };
      rows.push(row);
      rowsByTarget.set(row.key, row);
    }
    if (notification.kind === 'text') row.notificationIds.push(notification.id);
    else row.formNotificationId ??= notification.id;
  }

  const groups: NowGroups = {
    running: [],
    'needs-you': [],
    unread: [],
    completed: [],
  };
  for (const row of rows) {
    groups[
      row.formNotificationId ? 'needs-you' : groupForState(row.state)
    ].push(row);
  }
  for (const id of NOW_GROUP_IDS) {
    groups[id].sort((a, b) => b.at.localeCompare(a.at));
  }
  return { groups, bellNotifications };
}
