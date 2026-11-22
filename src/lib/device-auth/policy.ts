/** Explicit supported HTTP operations. An unmatched route is never authorized. */
import { escapeRegex } from '../../utils.js';

type Rule = { method: string; pattern: RegExp; scopes: string[] };
const rules: Rule[] = [];
function allow(method: string, route: string, ...scopes: string[]) {
  const pattern = route
    .split('/')
    .map((part) =>
      part === '*' ? '.+' : part.startsWith(':') ? '[^/]+' : escapeRegex(part),
    )
    .join('/');
  rules.push({ method, pattern: new RegExp(`^/api${pattern}/?$`), scopes });
}
function reads(scope: string, routes: string[]) {
  for (const r of routes) allow('GET', r, `${scope}:read`);
}
reads('knowledge', [
  '/knowledge',
  '/knowledge/status',
  '/knowledge/shared/:group_folder',
  '/knowledge/:id/files',
  '/knowledge/:id/tags',
  '/knowledge/:id/search',
  '/knowledge/:id/files/content',
  '/knowledge/:id/files/thumbnail',
  '/knowledge/:id/files/:filename/content',
  '/knowledge/:id/files/:filename/thumbnail',
]);
for (const r of [
  '/knowledge',
  '/knowledge/:id/files',
  '/knowledge/:id/index',
  '/knowledge/:id/save-message',
])
  allow('POST', r, 'knowledge:write');
for (const r of [
  '/knowledge/:id',
  '/knowledge/:id/files/metadata',
  '/knowledge/:id/files/:filename/metadata',
])
  allow('PATCH', r, 'knowledge:write');
for (const r of [
  '/knowledge/:id',
  '/knowledge/:id/files',
  '/knowledge/:id/files/:filename',
])
  allow('DELETE', r, 'knowledge:delete');
reads('projects', [
  '/projects',
  '/projects/status-summary',
  '/projects/:pid/stage-occupancy',
]);
// The attention response includes task, conversation and objective content.
allow(
  'GET',
  '/projects/attention',
  'projects:read',
  'tasks:read',
  'conversations:read',
  'objectives:read',
);
allow('POST', '/projects', 'projects:write');
allow('PATCH', '/projects/order', 'projects:write');
allow('PATCH', '/projects/:pid', 'projects:write');
allow('DELETE', '/projects/:pid', 'projects:delete');
reads('tasks', [
  '/projects/:pid/tasks',
  '/projects/:pid/tasks/:id',
  '/projects/:pid/tasks/:id/messages',
  '/projects/:pid/tasks/:id/output',
  '/projects/:pid/tasks/:id/runs',
  '/projects/:pid/tasks/:id/recordings',
  '/projects/:pid/tasks/:id/diff',
  '/projects/:pid/board-replay',
]);
allow('POST', '/projects/:pid/tasks', 'tasks:write');
for (const r of ['/projects/:pid/tasks/:id', '/projects/:pid/tasks/bulk'])
  allow('PATCH', r, 'tasks:write');
allow('DELETE', '/projects/:pid/tasks/:id', 'tasks:delete');
for (const r of [
  '/projects/:pid/tasks/:id/execute',
  '/projects/:pid/tasks/:id/stop',
  '/projects/:pid/tasks/bulk-execute',
  '/projects/:pid/tasks/bulk-stop',
  '/projects/:pid/tasks/bulk-start-over',
  '/projects/:pid/tasks/:id/messages',
  '/projects/:pid/tasks/:id/description/draft',
])
  allow('POST', r, 'tasks:write', 'tasks:execute');
reads('objectives', [
  '/projects/:pid/objectives',
  '/projects/:pid/objectives/:id',
  '/projects/:pid/objectives/:id/events',
  '/projects/:pid/objectives/:id/runs',
  '/projects/:pid/objectives/:id/runs/:runId/live',
  '/projects/:pid/objectives/:id/reports',
  '/projects/:pid/objectives/:id/reports/:filename',
  '/projects/:pid/objectives/:id/files',
  '/projects/:pid/objectives/:id/files/:folder/:filename',
]);
allow(
  'POST',
  '/projects/:pid/objectives',
  'objectives:write',
  'objectives:execute',
);
allow('PUT', '/projects/:pid/objectives/:id', 'objectives:write');
allow('DELETE', '/projects/:pid/objectives/:id', 'objectives:delete');
reads('conversations', [
  '/projects/:pid/conversations',
  '/projects/:pid/conversations/:id',
  '/projects/:pid/conversations/:id/transcript',
  '/projects/:pid/messages',
]);
allow(
  'POST',
  '/projects/:pid/conversations',
  'conversations:write',
  'conversations:execute',
);
allow('PATCH', '/projects/:pid/conversations/:id', 'conversations:write');
allow('DELETE', '/projects/:pid/conversations/:id', 'conversations:delete');
for (const r of ['/projects/:pid/messages', '/projects/:pid/messages/stop'])
  allow('POST', r, 'conversations:write', 'conversations:execute');
reads('files', [
  '/projects/:pid/files/group',
  '/projects/:pid/files/group/content',
  '/projects/:pid/files/editable-content',
  '/projects/:pid/files/repo',
  '/projects/:pid/files/repo/content',
  '/projects/:pid/files/mount/:slot',
  '/projects/:pid/files/mount/:slot/content',
  '/projects/:pid/files/root/:index',
  '/projects/:pid/files/root/:index/content',
  '/projects/:pid/conversations/:id/files/repo',
  '/projects/:pid/conversations/:id/files/repo/content',
]);
allow('PUT', '/projects/:pid/files/editable-content', 'files:write');
allow('POST', '/projects/:pid/upload', 'files:write');
allow('DELETE', '/projects/:pid/artifacts/*', 'files:delete');
reads('memories', ['/groups/:id/memories']);
allow('POST', '/groups/:id/memories', 'memories:write');
allow('PATCH', '/groups/:id/memories/:mid', 'memories:write');
allow('DELETE', '/groups/:id/memories/:mid', 'memories:delete');
for (const resource of ['cronjobs', 'scheduled-tasks']) {
  reads('schedules', [
    `/projects/:pid/${resource}`,
    ...(resource === 'scheduled-tasks'
      ? [
          `/projects/:pid/${resource}/:id`,
          `/projects/:pid/${resource}/:id/runs`,
        ]
      : []),
  ]);
  if (resource === 'cronjobs')
    allow(
      'POST',
      `/projects/:pid/${resource}`,
      'schedules:write',
      'schedules:execute',
    );
  allow(
    'PATCH',
    `/projects/:pid/${resource}/:id`,
    'schedules:write',
    'schedules:execute',
  );
  allow('DELETE', `/projects/:pid/${resource}/:id`, 'schedules:delete');
  if (resource === 'cronjobs')
    allow('POST', `/projects/:pid/${resource}/:id/run`, 'schedules:execute');
}
reads('datasets', ['/projects/:pid/dataset-tasks']);
allow(
  'POST',
  '/projects/:pid/dataset-tasks',
  'datasets:write',
  'datasets:execute',
);
allow(
  'PATCH',
  '/projects/:pid/dataset-tasks/:id',
  'datasets:write',
  'datasets:execute',
);
allow('DELETE', '/projects/:pid/dataset-tasks/:id', 'datasets:delete');
for (const action of ['run', 'restart'])
  allow(
    'POST',
    `/projects/:pid/dataset-tasks/:id/${action}`,
    'datasets:execute',
  );
allow(
  'POST',
  '/projects/:pid/meetings/record',
  'meetings:write',
  'meetings:execute',
);
for (const action of ['chunk', 'stop'])
  allow(
    'POST',
    `/projects/:pid/meetings/record/:id/${action}`,
    'meetings:write',
    'meetings:execute',
  );
allow('DELETE', '/projects/:pid/meetings/record/:id', 'meetings:delete');
reads('mail', [
  '/projects/:pid/mail/accounts',
  '/projects/:pid/mail/folders',
  '/projects/:pid/mail/messages',
  '/projects/:pid/mail/messages/:uid',
  '/projects/:pid/mail/attachment',
]);
for (const action of ['read-state', 'move'])
  allow('POST', `/projects/:pid/mail/${action}`, 'mail:organize');
allow('POST', '/projects/:pid/mail/send', 'mail:send');
reads('reports', ['/reports/run-costs']);
reads('notifications', [
  '/notifications/unread',
  '/notifications/payloads/:id',
]);
for (const r of [
  '/notifications/unread/ack',
  '/notifications/payloads/:id/ack',
])
  allow('POST', r, 'notifications:acknowledge');
reads('sandboxes', ['/sandbox/status', '/sandbox/ps', '/sandbox/versions']);
for (const action of ['start', 'stop', 'restart'])
  allow('POST', `/sandbox/:stack/${action}`, 'sandboxes:control');
allow('POST', '/projects/:pid/git/push', 'git:push');

/**
 * An objective chat is a normal conversation carrying an `objective_id`, so the
 * conversation routes alone cannot tell it apart from a project chat. A device
 * key must additionally hold the objective scopes for every action on one.
 */
export function objectiveChatScopes(method: string): string[] {
  if (method === 'GET' || method === 'HEAD') return ['objectives:read'];
  if (method === 'DELETE') return ['objectives:write'];
  return ['objectives:write', 'objectives:execute'];
}

/** Non-empty string `objective_id` of a request body or query string. */
function namesObjective(...sources: unknown[]): boolean {
  return sources.some((source) => {
    const value =
      source && typeof source === 'object'
        ? (source as Record<string, unknown>).objective_id
        : undefined;
    return typeof value === 'string' && value.trim() !== '';
  });
}

const CHAT_ROUTE =
  /^\/api\/projects\/([^/]+)\/(conversations|messages|upload|meetings\/record)(?:\/([^/]+))?(?:\/.*)?$/;

/**
 * Every conversation an allowed chat request may refer to. `POST /messages`
 * accepts `conversation_id` or `conversationId` in the body or query and takes
 * the first non-empty string, so all spellings and locations are collected and
 * each must resolve. An entry is `null` when it cannot be a conversation id
 * (malformed or not a string); callers reject it instead of skipping it.
 */
export function chatConversationReference(
  pathname: string,
  body: unknown,
  query: unknown,
): { projectId: string; conversationIds: (string | null)[] } | null {
  const match = CHAT_ROUTE.exec(pathname);
  if (!match) return null;
  const decode = (value: string): string | null => {
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  };
  const projectId = decode(match[1]);
  // A malformed project segment names no project: reject, never skip the lookup.
  if (projectId === null) return { projectId: '', conversationIds: [null] };
  const [, , kind, pathId] = match;
  let conversationIds: (string | null)[];
  if (kind === 'conversations') {
    conversationIds = pathId ? [decode(pathId)] : [];
  } else {
    const bag = (value: unknown) =>
      value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {};
    conversationIds = [bag(body), bag(query)]
      .flatMap((source) => [source.conversation_id, source.conversationId])
      .filter(
        (value) =>
          value !== undefined &&
          value !== null &&
          !(typeof value === 'string' && value.trim() === ''),
      )
      .map((value) => (typeof value === 'string' ? value.trim() : null));
  }
  return conversationIds.length ? { projectId, conversationIds } : null;
}

export function requiredDeviceScopes(
  method: string,
  pathname: string,
  body: unknown,
  query?: unknown,
): string[] | null {
  const rule = rules.find(
    (r) =>
      r.method === (method === 'HEAD' ? 'GET' : method) &&
      r.pattern.test(pathname),
  );
  if (!rule) return null;
  const scopes = [...rule.scopes];
  const data =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  // Project configuration can change sharing, credentials and runtime capabilities.
  // Scoped clients may edit presentation only; configuration remains interactive.
  if (rule.scopes.includes('projects:write')) {
    const fields =
      method === 'POST'
        ? ['name', 'folder', 'description']
        : /^\/api\/projects\/order\/?$/.test(pathname)
          ? ['orders']
          : ['name', 'description'];
    if (Object.keys(data).some((key) => !fields.includes(key))) return null;
  }
  if (
    rule.scopes.includes('tasks:write') &&
    (method === 'POST' ||
      ['status', 'execute_in_stage', 'archived'].some((k) => k in data))
  )
    scopes.push('tasks:execute');
  if (rule.scopes.includes('objectives:write') && 'status' in data)
    scopes.push('objectives:execute');
  if (CHAT_ROUTE.test(pathname) && namesObjective(body, query))
    scopes.push(...objectiveChatScopes(method));
  return [...new Set(scopes)];
}
