/**
 * brain-client.ts
 * HTTP client for publishing events to the carapa-brain REST API.
 * Ordinary activity publishes are fire-and-forget. Objective state changes
 * use a durable per-objective outbox so they survive Brain and Board restarts.
 *
 * Brain containers run on separate Docker networks. The board reaches them
 * via ingress addresses discovered from sandbox_ps.
 */

import { randomUUID } from 'crypto';
import path from 'path';
import { logger } from '../../logger.js';
import { getGroupDir } from '../../group-dir.js';
import { sleep } from '../../lib/async.js';
import { isRecord } from '../../lib/type-guards.js';
import {
  GroupFsError,
  openGroupDir,
  readdirAt,
  readFileAt,
  removeAt,
  writeFileAt,
} from '../../lib/group-fs.js';
import { getSandboxClient } from '../../lib/mcp-client.js';
import { getGroupByFolder, registeredGroups } from '../../state-manager.js';
import { getObjective } from './db-objectives.js';
import { taskOutcomeEventData } from '../kanban/task/objective-events.js';
import { resolveObjectiveAgentRuntime } from './objective-agent.js';
import {
  assertRuntimeAllowed,
  PrivacyRefusal,
} from '../../lib/privacy-policy.js';
import type { ObjectiveAgentRuntime } from './objective-agent.js';
import type { RegisteredGroup } from '../../types.js';
import type { Objective } from './types.js';

/** Service lifecycle events fanned out to every brain (see system-events.ts). */
export type SystemEventType = 'board_started' | 'box_started';

export interface BrainEvent {
  /**
   * Event discriminator, e.g. "task_completed", "objective_created", or a
   * `SystemEventType`.
   */
  type: string;
  /** Board project ID (group folder) */
  project_id: string;
  /** Kanban task ID, or null if not applicable */
  task_id?: string | null;
  /** Objective ID if the event is linked to an objective, otherwise null */
  objective_id?: string | null;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Event-specific payload */
  data: Record<string, unknown>;
}

function nonSecretRuntimeEnv(
  env?: Record<string, string>,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const safe = Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !/(?:API_?KEY|AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name),
    ),
  );
  return Object.keys(safe).length ? safe : undefined;
}

export function objectiveAgentRuntimeEventData(
  runtime: ObjectiveAgentRuntime,
): Record<string, unknown> {
  const agentEnv = nonSecretRuntimeEnv(runtime.env);
  return {
    agent_cmd: runtime.runtimeId,
    ...(runtime.model ? { agent_model: runtime.model } : {}),
    agent_executable: runtime.agentCmd,
    agent_session_key: runtime.sessionKey,
    ...(runtime.selection ? { runtime_selection: runtime.selection } : {}),
    ...(runtime.reasoningEffort !== undefined
      ? { reasoning_effort: runtime.reasoningEffort }
      : {}),
    ...(agentEnv ? { agent_env: agentEnv } : {}),
  };
}

/** The registered group of a project folder, or undefined. */
export function findProjectGroup(
  projectId: string,
): RegisteredGroup | undefined {
  return (
    getGroupByFolder(projectId) ??
    Object.values(registeredGroups).find(
      (candidate) => candidate.folder === projectId,
    )
  );
}

/**
 * The runtime an objective's brain events run on, after the privacy-mode gate.
 * Structured overrides and inheritance remain distinct in persistence; legacy
 * rows are resolved without rewriting their ambiguous historical command/model
 * values. Shared by event attachment and the runtime-tiers endpoint.
 */
export function resolveAllowedObjectiveRuntime(
  objective: Pick<Objective, 'project_id' | 'eventRuntimeSelection'>,
): ObjectiveAgentRuntime {
  const group = findProjectGroup(objective.project_id);
  const resolved = resolveObjectiveAgentRuntime(
    group,
    objective.eventRuntimeSelection,
  );
  assertRuntimeAllowed({
    projectId: objective.project_id,
    purpose: 'agent',
    runtime: resolved.agent,
  });
  return resolved;
}

/** Attach the objective event runtime to every objective event. */
export async function attachObjectiveAgentRuntime(
  event: BrainEvent,
): Promise<BrainEvent> {
  if (!event.objective_id) return event;

  const objective = await getObjective(event.objective_id);
  if (!objective) return event;

  const resolved = resolveAllowedObjectiveRuntime(objective);
  return {
    ...event,
    data: {
      ...withoutObjectiveRuntimeKeys(event.data),
      ...objectiveAgentRuntimeEventData(resolved),
    },
  };
}

/** Drop every runtime key so a caller-supplied runtime never reaches the brain. */
function withoutObjectiveRuntimeKeys(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const {
    agent_cmd: _agentCmd,
    agent_model: _agentModel,
    agent_executable: _agentExecutable,
    agent_session_key: _agentSessionKey,
    runtime_selection: _runtimeSelection,
    reasoning_effort: _reasoningEffort,
    agent_env: _agentEnv,
    ...rest
  } = data;
  return rest;
}

/** Whether privacy mode refuses an unresolved (assumed remote) runtime. */
async function fallbackRuntimeRefused(event: BrainEvent): Promise<boolean> {
  const projectIds = new Set([event.project_id]);
  if (event.objective_id) {
    const objective = await getObjective(event.objective_id).catch(() => null);
    if (objective) projectIds.add(objective.project_id);
  }
  try {
    for (const projectId of projectIds) {
      assertRuntimeAllowed({ projectId, purpose: 'agent' });
    }
    return false;
  } catch (err) {
    if (err instanceof PrivacyRefusal) return true;
    throw err;
  }
}

/**
 * Attach the objective runtime, or fall back to the brain's default runtime
 * when resolution fails for a non-privacy reason (e.g. a stale objective
 * runtime selection). Returns `null` when privacy mode refuses the runtime:
 * that event must be dropped, never published without a runtime.
 */
async function attachRuntimeOrFallback(
  event: BrainEvent,
  logContext: Record<string, unknown>,
): Promise<BrainEvent | null> {
  try {
    return await attachObjectiveAgentRuntime(event);
  } catch (err) {
    if (err instanceof PrivacyRefusal) return null;
    // Resolution may have thrown before the privacy gate ran. The brain's
    // default runtime is unverified, so treat it as remote: a project whose
    // mode requires local execution must not fall back.
    if (await fallbackRuntimeRefused(event)) return null;
    logger.warn(
      {
        err,
        eventType: event.type,
        project_id: event.project_id,
        task_id: event.task_id ?? null,
        objective_id: event.objective_id,
        ...logContext,
        dropReason: 'runtime_attach_failed',
      },
      'Brain event runtime attach failed — publishing without a runtime',
    );
    return { ...event, data: withoutObjectiveRuntimeKeys(event.data) };
  }
}

/**
 * Add outcome data to objective-tagged task_completed / task_failed events.
 * Keys already present on the event win; lookup failures leave it unchanged.
 */
async function attachTaskOutcome(event: BrainEvent): Promise<BrainEvent> {
  if (
    (event.type !== 'task_completed' && event.type !== 'task_failed') ||
    !event.task_id ||
    !event.objective_id
  ) {
    return event;
  }
  try {
    const outcome = await taskOutcomeEventData(event.task_id, event.type);
    return { ...event, data: { ...outcome, ...event.data } };
  } catch (err) {
    logger.warn(
      { err, eventType: event.type, task_id: event.task_id },
      'Failed to attach task outcome to brain event',
    );
    return event;
  }
}

const TEXT_HEAD_CHARS = 2000;
const TEXT_TAIL_CHARS = 2000;

/**
 * Keep the first and last 2000 characters of a long text, with a marker that
 * names how many characters were dropped. Text of 4000 characters or fewer is
 * returned unchanged.
 */
export function truncateEventText(text: string): string {
  const keep = TEXT_HEAD_CHARS + TEXT_TAIL_CHARS;
  if (text.length <= keep) return text;
  const dropped = text.length - keep;
  return `${text.slice(0, TEXT_HEAD_CHARS)}…[truncated ${dropped} chars]…${text.slice(-TEXT_TAIL_CHARS)}`;
}

const CAPPED_TASK_EVENT_TYPES = new Set([
  'task_completed',
  'task_failed',
  'task_question',
]);
const CAPPED_TASK_EVENT_KEYS = [
  'error',
  'failure_reason',
  'postProcessingError',
];

/**
 * Bound the free-text fields of task events. These can carry an entire build
 * or test log, and the Brain inlines the payload into its run prompt. The
 * board's own task.error is not affected.
 */
function capTaskEventText(event: BrainEvent): BrainEvent {
  if (!CAPPED_TASK_EVENT_TYPES.has(event.type)) return event;
  const data = { ...event.data };
  for (const key of CAPPED_TASK_EVENT_KEYS) {
    const value = data[key];
    if (typeof value === 'string') data[key] = truncateEventText(value);
  }
  return { ...event, data };
}

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 5000;

/**
 * What the brain reports in the 2xx `/events` body for a task_failed or
 * task_question event: whether an objective run was `enqueued` for it or the
 * event was `dropped`. A brain that answers without the field, or with an empty
 * or non-JSON body, gives no delivery info.
 */
export interface BrainEventDelivery {
  status: 'enqueued' | 'dropped';
  reason?: string;
}

/** Parse the optional `delivery` field; any other body shape is "no delivery info". */
async function readBrainDelivery(
  response: Response,
): Promise<BrainEventDelivery | undefined> {
  try {
    const body: unknown = await response.json();
    const delivery = isRecord(body) ? body.delivery : undefined;
    if (
      isRecord(delivery) &&
      (delivery.status === 'enqueued' || delivery.status === 'dropped')
    ) {
      return {
        status: delivery.status,
        ...(typeof delivery.reason === 'string'
          ? { reason: delivery.reason }
          : {}),
      };
    }
  } catch {
    // Empty or non-JSON body: no delivery answer.
  }
  return undefined;
}

export async function publishBrainEvent(
  brainUrl: string,
  event: BrainEvent,
  authToken?: string,
): Promise<BrainEventDelivery | undefined> {
  if (!authToken) {
    logger.warn(
      { eventType: event.type, project_id: event.project_id },
      'No brain auth token available — skipping publish',
    );
    return undefined;
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
  };

  // Reshape to brain's expected schema: { type, timestamp?, payload }
  const { type, timestamp, project_id, task_id, objective_id, ...rest } = event;
  const body = {
    type,
    timestamp,
    payload: {
      project_id,
      ...(task_id != null ? { task_id } : {}),
      ...(objective_id != null ? { objective_id } : {}),
      ...rest.data,
    },
  };

  const response = await fetch(`${brainUrl}/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Brain API responded with ${response.status}: ${text}`);
  }
  return event.type === 'task_failed' || event.type === 'task_question'
    ? readBrainDelivery(response)
    : undefined;
}

/**
 * Classify a publish failure so logs distinguish the failure modes, which have
 * different fixes:
 *   - "timeout"   → the brain accepted the connection but didn't respond within
 *                   REQUEST_TIMEOUT_MS (brain overloaded / slow LLM work on the
 *                   /events path). durationMs will be ~REQUEST_TIMEOUT_MS.
 *   - "transport" → connection never established (stale/dead host port). Fails
 *                   fast, so durationMs is small.
 *   - "http"      → brain replied with a non-2xx status.
 */
function describeBrainError(err: unknown): {
  errKind: string;
  errName?: string;
  errCode?: string;
} {
  const errName = (err as { name?: string })?.name;
  const errCode =
    (err as { code?: string })?.code ??
    (err as { cause?: { code?: string } })?.cause?.code;
  let errKind = 'other';
  if (errName === 'TimeoutError') errKind = 'timeout';
  else if (isStalePortError(err)) errKind = 'transport';
  else if (
    err instanceof Error &&
    err.message.startsWith('Brain API responded with')
  )
    errKind = 'http';
  return { errKind, errName, errCode };
}

/** HTTP status carried by a publish failure, or undefined for non-HTTP errors. */
function brainHttpStatus(err: unknown): number | undefined {
  const status =
    err instanceof Error
      ? /^Brain API responded with (\d+)/.exec(err.message)?.[1]
      : undefined;
  return status ? Number(status) : undefined;
}

/** Drop reason for an event that exhausted its delivery retries. */
function deliveryFailureReason(err: unknown): string {
  const status = brainHttpStatus(err);
  return status ? `http_${status}` : 'transport_error';
}

/**
 * A 4xx can never succeed on retry (bad request, rejected token, ...) — except
 * 408 (request timeout) and 429 (rate limited), which are transient.
 */
function isPermanentClientError(status: number | undefined): boolean {
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

// ── Brain auth status ───────────────────────────────────────────────────────
// In-memory, since board start. Keyed by the project folder whose token was
// used (the project itself, or its parent when the token was inherited).

export interface BrainAuthStatus {
  ok: boolean;
  /** HTTP status of the rejection (401/403) when `ok` is false. */
  status?: number;
  /** ISO-8601 time of the result. */
  at: string;
}

const brainAuthStatuses = new Map<string, BrainAuthStatus>();

/** Latest brain-auth result for a project, or undefined if none was seen. */
export function getBrainAuthStatus(
  projectFolder: string,
): BrainAuthStatus | undefined {
  return brainAuthStatuses.get(projectFolder);
}

/**
 * Record whether the brain accepted this project's token. The first rejection
 * after a success (or after board start) logs at warn; repeats log at debug so
 * every dropped event does not flood the log. The token is never logged.
 */
export function recordBrainAuthResult(
  projectFolder: string,
  result: BrainAuthStatus,
  context: { brainUrl?: string } = {},
): void {
  const previous = brainAuthStatuses.get(projectFolder);
  if (result.ok) {
    brainAuthStatuses.set(projectFolder, result);
    return;
  }
  const repeated = previous !== undefined && !previous.ok;
  // A continuing rejection keeps its original time so the stored status (and
  // the project-change revision derived from it) is stable between repeats.
  brainAuthStatuses.set(
    projectFolder,
    repeated && previous.status === result.status
      ? previous
      : { ok: false, status: result.status, at: result.at },
  );
  const log = repeated ? logger.debug : logger.warn;
  log.call(
    logger,
    {
      event: 'brain_auth_rejected',
      project: projectFolder,
      status: result.status,
      brainUrl: context.brainUrl,
    },
    'Brain rejected the board auth token',
  );
}

/** Record a brain HTTP response: 401/403 rejects, 2xx confirms, others say nothing. */
function recordBrainAuthResponse(
  projectFolder: string,
  status: number,
  brainUrl: string,
): void {
  if (status === 401 || status === 403) {
    recordBrainAuthResult(
      projectFolder,
      { ok: false, status, at: new Date().toISOString() },
      { brainUrl },
    );
  } else if (status >= 200 && status < 300) {
    recordBrainAuthResult(projectFolder, {
      ok: true,
      at: new Date().toISOString(),
    });
  }
}

/**
 * Project folder whose token `resolveBrainAuthToken(group)` returns: the group
 * itself, or its parent when the token is inherited. `folder` is the group's own.
 */
export function resolveBrainAuthTokenOwner(
  group:
    | { settings?: { brainAuthToken?: string }; parentId?: string }
    | undefined,
  folder: string,
): string | undefined {
  if (group?.settings?.brainAuthToken) return folder;
  if (
    group?.parentId &&
    getGroupByFolder(group.parentId)?.settings?.brainAuthToken
  ) {
    return group.parentId;
  }
  return undefined;
}

type PublishResult =
  | { delivered: true; delivery?: BrainEventDelivery }
  | { delivered: false; reason: string };

async function publishWithRetry(
  brainUrl: string,
  event: BrainEvent,
  authToken: string | undefined,
  attempt = 1,
  brainContainer?: string,
  authStatusKey?: string,
  maxAttempts = MAX_RETRIES,
): Promise<PublishResult> {
  const startedAt = performance.now();
  try {
    const delivery = await publishBrainEvent(brainUrl, event, authToken);
    if (authStatusKey) recordBrainAuthResponse(authStatusKey, 200, brainUrl);
    return { delivered: true, ...(delivery ? { delivery } : {}) };
  } catch (err) {
    const status = brainHttpStatus(err);
    const authRejected = status === 401 || status === 403;
    if (authRejected && authStatusKey) {
      recordBrainAuthResponse(authStatusKey, status, brainUrl);
    }
    // Rich context so a recurrence is diagnosable from logs alone: durationMs
    // (~5000 confirms a real timeout vs a fast transport failure), the target
    // brainUrl (rules out a stale port), the classified error kind, and the
    // objective/conversation for correlation with brain-side logs.
    const ctx = {
      err,
      eventType: event.type,
      project_id: event.project_id,
      objective_id: event.objective_id ?? null,
      conversation_id:
        (event.data?.conversation_id as string | undefined) ?? null,
      brainUrl,
      status,
      attempt,
      durationMs: Math.round(performance.now() - startedAt),
      ...describeBrainError(err),
    };
    if (isPermanentClientError(status)) {
      // Retrying cannot help. A token rejection is already logged (once per
      // streak) by recordBrainAuthResult.
      const reason = deliveryFailureReason(err);
      if (!authRejected) {
        logger.warn(
          {
            ...ctx,
            ...(event.objective_id
              ? { task_id: event.task_id ?? null, dropReason: reason }
              : {}),
          },
          'Brain event publish rejected — not retrying',
        );
      }
      return { delivered: false, reason };
    }
    if (attempt < maxAttempts) {
      logger.warn(ctx, 'Brain event publish failed — retrying');
      let retryUrl = brainUrl;
      if (brainContainer && isStalePortError(err)) {
        await refreshBrainPortCache();
        retryUrl = resolveBrainUrl(brainContainer) ?? brainUrl;
      }
      await sleep(BASE_RETRY_DELAY_MS * attempt);
      return publishWithRetry(
        retryUrl,
        event,
        authToken,
        attempt + 1,
        brainContainer,
        authStatusKey,
        maxAttempts,
      );
    }
    const reason = deliveryFailureReason(err);
    logger.warn(
      {
        ...ctx,
        ...(event.objective_id
          ? { task_id: event.task_id ?? null, dropReason: reason }
          : {}),
      },
      'Brain event publish failed after retries — giving up',
    );
    return { delivered: false, reason };
  }
}

// ── Brain port cache ────────────────────────────────────────────────────────
// Maps container hostname (e.g. "carapa-brain-main-agent-1") → reachable API URL.
// Populated from sandbox_ps at startup and refreshed on sandbox start/restart.
const brainPortCache = new Map<string, string>();
// Maps the same hostnames → the sandbox
// instance that runs them, from the sandbox_ps `instance` field.
const brainInstanceCache = new Map<string, string>();
// Hostnames that the last successful refresh
// listed but could not give a URL, and whether the last refresh failed. They
// only explain a cache miss; they never affect which URLs are cached.
const brainNoEndpoint = new Set<string>();
let brainDiscoveryFailed = false;

export type BrainResolutionStatus =
  | 'resolved'
  | 'not-found'
  | 'no-endpoint'
  | 'discovery-failed';

/** Why `brainContainer` does or does not resolve to a URL after the last refresh. */
export function brainResolutionStatus(
  brainContainer: string,
): BrainResolutionStatus {
  if (brainPortCache.has(brainContainer)) return 'resolved';
  if (brainDiscoveryFailed) return 'discovery-failed';
  return brainNoEndpoint.has(brainContainer) ? 'no-endpoint' : 'not-found';
}

/** Sandbox instance running a brain container, or undefined when unknown. */
export function resolveBrainSandboxInstance(
  brainContainer: string,
): string | undefined {
  return brainInstanceCache.get(brainContainer);
}

interface BrainIngress {
  service: string;
  kind: string;
  host: string;
  port: number;
  /**
   * A runner box (OpenShell) publishes the Brain on a host address Board can dial as
   * advertised; BRAIN_INGRESS_HOST names the local ingress edge, which does not serve it.
   */
  direct?: boolean;
}

async function ingressBrainUrl(
  ingress: BrainIngress[],
  previous?: string,
): Promise<string | undefined> {
  // Trusted containerized clients may need the ingress edge address to preserve
  // their source IP. The advertised LAN host can pass through Docker NAT.
  const ingressHost = process.env.BRAIN_INGRESS_HOST?.trim();
  const urls = [
    ...new Set(
      ingress.map(({ host: publicHost, port, direct }) => {
        const host = (!direct && ingressHost) || publicHost;
        const hostname =
          host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
        return new URL(`http://${hostname}:${port}`).origin;
      }),
    ),
  ];
  if (urls.length === 1) return urls[0];
  if (previous && urls.includes(previous)) return previous;
  // A service can also expose model servers or application APIs. Identify Brain
  // without sending its credentials or objective payloads to those endpoints.
  const matches = await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetch(`${url}/version`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: 'error',
        });
        if (
          response.ok &&
          ((await response.json()) as { service?: string }).service ===
            'carapa-brain'
        )
          return url;
      } catch {
        // Unavailable and non-Brain endpoints are not candidates for delivery.
      }
      return undefined;
    }),
  );
  const brains = matches.filter((url): url is string => !!url);
  return brains.length === 1 ? brains[0] : undefined;
}

/**
 * Refresh the brain port cache by querying sandbox_ps via CarapaBox MCP.
 * Populates a map of containerHostname → API URL for all running services.
 */
export async function refreshBrainPortCache(): Promise<void> {
  try {
    const client = getSandboxClient();
    const result = await client.sandboxPs();
    if (result.isError) {
      brainDiscoveryFailed = true;
      logger.warn(
        { stdoutLength: result.stdout.length },
        'Failed to refresh brain port cache',
      );
      return;
    }

    // sandbox_ps returns plain text (e.g. "No running compose projects")
    // when no stacks are up — treat as empty list
    const trimmed = result.stdout.trim();
    if (!trimmed.startsWith('[')) {
      brainPortCache.clear();
      brainInstanceCache.clear();
      brainNoEndpoint.clear();
      brainDiscoveryFailed = false;
      logger.debug('No running stacks — brain port cache cleared');
      return;
    }

    const instances = JSON.parse(trimmed) as {
      name: string;
      instance?: string;
      ingress?: BrainIngress[];
      services: {
        service: string;
        hostname: string;
        status: string;
      }[];
    }[];

    const next = new Map<string, string>();
    const nextInstances = new Map<string, string>();
    const nextNoEndpoint = new Set<string>();
    await Promise.all(
      instances.map(async (instance) => {
        await Promise.all(
          instance.services.map(async (svc) => {
            if (!svc.hostname) return;
            if (instance.instance) {
              nextInstances.set(svc.hostname, instance.instance);
            }
            const ingress =
              instance.ingress?.filter(
                (entry) =>
                  entry.service === svc.service && entry.kind === 'http',
              ) ?? [];
            const url = ingress.length
              ? await ingressBrainUrl(ingress, brainPortCache.get(svc.hostname))
              : undefined;
            if (!url) {
              nextNoEndpoint.add(svc.hostname);
              return;
            }
            next.set(svc.hostname, url);
          }),
        );
      }),
    );
    brainPortCache.clear();
    for (const [hostname, url] of next) brainPortCache.set(hostname, url);
    brainInstanceCache.clear();
    for (const [name, inst] of nextInstances)
      brainInstanceCache.set(name, inst);
    brainNoEndpoint.clear();
    for (const name of nextNoEndpoint) brainNoEndpoint.add(name);
    brainDiscoveryFailed = false;
  } catch (err) {
    brainDiscoveryFailed = true;
    logger.warn({ err }, 'Failed to refresh brain port cache');
  }
}

/**
 * Resolve brainContainer setting with parent group fallback.
 * If the group has no brainContainer configured, check its parent group.
 */
export function resolveBrainContainer(group: {
  settings?: { brainContainer?: string };
  parentId?: string;
}): string | undefined {
  if (group.settings?.brainContainer) return group.settings.brainContainer;
  if (group.parentId) {
    const parent = getGroupByFolder(group.parentId);
    if (parent?.settings?.brainContainer) return parent.settings.brainContainer;
  }
  return undefined;
}

/**
 * Resolve the auth token for the carapa-brain API.
 * Uses the per-project brainAuthToken if set, then checks the parent group.
 * Returns undefined if no token is configured — callers should skip publish.
 */
export function resolveBrainAuthToken(group?: {
  settings?: { brainAuthToken?: string };
  parentId?: string;
}): string | undefined {
  if (group?.settings?.brainAuthToken) return group.settings.brainAuthToken;
  if (group?.parentId) {
    const parent = getGroupByFolder(group.parentId);
    if (parent?.settings?.brainAuthToken) return parent.settings.brainAuthToken;
  }
  return undefined;
}

/**
 * Build the brain URL from project settings.
 * Looks up the container's ingress URL.
 * Returns null if container is not configured
 * or not found in the cache.
 */
export function resolveBrainUrl(brainContainer?: string): string | null {
  if (!brainContainer) return null;
  const url = brainPortCache.get(brainContainer);
  if (!url) {
    logger.debug({ brainContainer }, 'Brain container not found in port cache');
    return null;
  }
  return url;
}

/**
 * Transport-level failures that mean the cached host port is dead — typically
 * because the brain container restarted and got a new dynamic port. We retry
 * after a cache refresh in that case (see fetchBrain).
 */
function isStalePortError(err: unknown): boolean {
  const code =
    (err as { code?: string })?.code ??
    (err as { cause?: { code?: string } })?.cause?.code;
  return (
    code === 'ConnectionRefused' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  );
}

/**
 * fetch() against the brain identified by `brainContainer`, with automatic
 * recovery from stale cached host ports. Brain containers run on dynamic
 * Docker host ports, so when one restarts its port changes and the board's
 * cache goes stale until the next refresh trigger — which is what made brain
 * restarts require a manual board/brain dance.
 *
 * Two layers of self-healing:
 *   1. Cache miss → refresh once before giving up, so a brain that came up
 *      after the board is discovered without a board restart.
 *   2. Connection-level failure on a cached URL → refresh, re-resolve, and
 *      retry once with the fresh port.
 *
 * Returns null when the brain can't be resolved (not running / not in cache
 * after refresh). Returns the Response (incl. non-2xx) when reachable — HTTP
 * status handling is the caller's concern. When `authStatusKey` (the project
 * whose token the request carries) is given, a 401/403 or 2xx response updates
 * that project's brain-auth status.
 */
export async function fetchBrain(
  brainContainer: string | undefined,
  pathSuffix: string,
  init?: RequestInit,
  authStatusKey?: string,
): Promise<Response | null> {
  if (!brainContainer) return null;
  const track = (res: Response, brainUrl: string): Response => {
    if (authStatusKey) {
      recordBrainAuthResponse(authStatusKey, res.status, brainUrl);
    }
    return res;
  };
  let url = resolveBrainUrl(brainContainer);
  if (!url) {
    await refreshBrainPortCache();
    url = resolveBrainUrl(brainContainer);
    if (!url) return null;
  }
  try {
    return track(await fetch(`${url}${pathSuffix}`, init), url);
  } catch (err) {
    if (!isStalePortError(err)) throw err;
    logger.info(
      { brainContainer, err: String(err) },
      'Brain fetch failed at transport — refreshing port cache and retrying once',
    );
    await refreshBrainPortCache();
    const refreshed = resolveBrainUrl(brainContainer);
    if (!refreshed || refreshed === url) throw err;
    return track(await fetch(`${refreshed}${pathSuffix}`, init), refreshed);
  }
}

/**
 * Whether the group opts into CarapaBrain for itself: 'objectives' is listed in
 * its `enabledModes` or the project carries its own brain credentials/target.
 * A missing `enabledModes` does not enable events.
 * Unlike resolveBrainAuthToken/resolveBrainContainer, this deliberately does
 * NOT fall back to the parent group, so projects that never enabled
 * brain/objectives for themselves stop generating brain events.
 */
export function isBrainEventsEnabled(group?: {
  settings?: {
    enabledModes?: string[];
    brainContainer?: string;
    brainAuthToken?: string;
  };
}): boolean {
  const settings = group?.settings;
  return !!(
    (Array.isArray(settings?.enabledModes) &&
      settings.enabledModes.includes('objectives')) ||
    settings?.brainContainer ||
    settings?.brainAuthToken
  );
}

interface BrainEventGroup {
  settings?: {
    enabledModes?: string[];
    brainAuthToken?: string;
    brainContainer?: string;
  };
  parentId?: string;
}

/** Project group that owns the objective, or undefined if it can't be found. */
async function findObjectiveOwnerGroup(
  objectiveId: string,
): Promise<(BrainEventGroup & { folder: string }) | undefined> {
  try {
    const objective = await getObjective(objectiveId);
    if (!objective) return undefined;
    return (
      getGroupByFolder(objective.project_id) ??
      Object.values(registeredGroups).find(
        (candidate) => candidate.folder === objective.project_id,
      )
    );
  } catch (err) {
    logger.warn(
      { err, objective_id: objectiveId },
      'Failed to look up objective owner for brain event',
    );
    return undefined;
  }
}

export type PublishEventOutcome = 'delivered' | 'queued' | 'skipped' | 'failed';

export interface PublishEventResult {
  outcome: PublishEventOutcome;
  /** The brain's answer for task_failed/task_question; absent when the brain answers without it. */
  delivery?: BrainEventDelivery;
}

export interface PublishEventOptions {
  /** One publish attempt, and no durable replay queue: a failure is `failed`. */
  singleAttempt?: boolean;
}

/**
 * Publish an event to the carapa-brain REST API and report what happened:
 * `delivered`, `queued` (durably queued for replay), `skipped` (nothing
 * to send to, so a retry cannot help) or `failed` (neither sent nor queued).
 * Never throws.
 *
 * Credentials and target come from the project group (with parent fallback).
 * Objective-tagged events are routed to the brain of the project that OWNS the
 * objective instead — token and container together, so credentials never reach
 * a different brain — falling back to the task's own group when the owner can't
 * be found or has no token. In that case `brainUrl` (resolved by the caller from
 * the task's group) is ignored for the owner's brain. Every drop of an
 * objective-tagged event is logged at warn level with its reason.
 */
export async function publishEventWithResult(
  brainUrl: string | null,
  event: BrainEvent,
  group?: BrainEventGroup,
  options: PublishEventOptions = {},
): Promise<PublishEventResult> {
  // Credential/target resolution falls back to the parent group, but events
  // are only published when the project itself enabled brain/objectives —
  // otherwise every chat message in a plain sub-project would reach the
  // parent's brain. Objective-tagged events are exempt: the owning objective's
  // brain must hear about its tasks even when the task's project never opted in.
  if (!group) {
    logger.debug(
      { project_id: event.project_id, eventType: event.type },
      'Brain event skipped — project does not have brain/objectives enabled',
    );
    return { outcome: 'skipped' };
  }
  if (!isBrainEventsEnabled(group)) {
    if (!event.objective_id) {
      logger.debug(
        { project_id: event.project_id, eventType: event.type },
        'Brain event skipped — project does not have brain/objectives enabled',
      );
      return { outcome: 'skipped' };
    }
    logger.debug(
      {
        project_id: event.project_id,
        eventType: event.type,
        objective_id: event.objective_id,
      },
      'Brain event delivered despite project opt-out — event is objective-tagged',
    );
  }
  if (!event.objective_id && !resolveBrainAuthToken(group))
    return { outcome: 'skipped' };

  const publish = async (): Promise<PublishEventResult> => {
    let source: BrainEventGroup = group;
    let urlFromCaller = true;
    const owner = event.objective_id
      ? await findObjectiveOwnerGroup(event.objective_id)
      : undefined;
    if (event.objective_id) {
      if (owner && resolveBrainAuthToken(owner)) {
        source = owner;
        urlFromCaller = false;
      }
    }
    const authToken = resolveBrainAuthToken(source);
    const brainContainer = resolveBrainContainer(source);
    const dropContext = {
      eventType: event.type,
      project_id: event.project_id,
      task_id: event.task_id ?? null,
      objective_id: event.objective_id,
      brainContainer,
    };
    if (!authToken) {
      logger.warn(
        { ...dropContext, dropReason: 'no_token' },
        'Brain event publish skipped — no brain auth token is configured',
      );
      return { outcome: 'skipped' };
    }

    const attached = await attachRuntimeOrFallback(event, { brainContainer });
    if (!attached) {
      logger.warn(
        { ...dropContext, dropReason: 'privacy_refusal' },
        'Brain event publish skipped — privacy mode refuses the objective runtime',
      );
      return { outcome: 'skipped' };
    }
    const eventWithRuntime = capTaskEventText(
      await attachTaskOutcome(attached),
    );
    let resolvedUrl = urlFromCaller
      ? brainUrl
      : resolveBrainUrl(brainContainer);
    if (!resolvedUrl && brainContainer) {
      await refreshBrainPortCache();
      resolvedUrl = resolveBrainUrl(brainContainer);
    }
    if (!resolvedUrl) {
      const dropReason = brainContainer
        ? 'url_not_discoverable'
        : 'no_container';
      if (
        dropReason === 'url_not_discoverable' &&
        owner &&
        !options.singleAttempt
      ) {
        return (await queueEventForReplay(owner, eventWithRuntime, dropReason))
          ? { outcome: 'queued' }
          : { outcome: 'failed' };
      }
      logger.warn(
        { ...dropContext, dropReason },
        'Brain event publish skipped — brain container could not be resolved',
      );
      return { outcome: 'skipped' };
    }
    const result = await publishWithRetry(
      resolvedUrl,
      eventWithRuntime,
      authToken,
      1,
      brainContainer,
      resolveBrainAuthTokenOwner(
        source,
        source === group ? event.project_id : owner!.folder,
      ),
      options.singleAttempt ? 1 : MAX_RETRIES,
    );
    if (result.delivered) {
      return {
        outcome: 'delivered',
        ...(result.delivery ? { delivery: result.delivery } : {}),
      };
    }
    if (
      owner &&
      !options.singleAttempt &&
      (result.reason === 'transport_error' ||
        /^http_5\d\d$/.test(result.reason))
    ) {
      return (await queueEventForReplay(owner, eventWithRuntime, result.reason))
        ? { outcome: 'queued' }
        : { outcome: 'failed' };
    }
    return { outcome: 'failed' };
  };

  try {
    return await publish();
  } catch (err) {
    logger.warn(
      { err, eventType: event.type },
      'Unexpected error in brain event publish',
    );
    return { outcome: 'failed' };
  }
}

/** {@link publishEventWithResult} reduced to its outcome. */
export async function publishEventWithOutcome(
  brainUrl: string | null,
  event: BrainEvent,
  group?: BrainEventGroup,
  options: PublishEventOptions = {},
): Promise<PublishEventOutcome> {
  return (await publishEventWithResult(brainUrl, event, group, options))
    .outcome;
}

/** Fire-and-forget form of {@link publishEventWithOutcome}. */
export function publishEvent(
  brainUrl: string | null,
  event: BrainEvent,
  group?: BrainEventGroup,
): void {
  void publishEventWithOutcome(brainUrl, event, group);
}

interface PendingObjectiveStateEvent {
  id: string;
  brainUrl: string | null;
  event: BrainEvent;
}

interface ObjectiveStateEventOutbox {
  version: 1;
  events: PendingObjectiveStateEvent[];
}

const OBJECTIVE_STATE_EVENT_OUTBOX = 'board-brain-state-events.json';
const objectiveStateOutboxLocks = new Map<string, Promise<void>>();
const objectiveStateFlushes = new Map<string, Promise<void>>();

export function objectiveStateEventOutboxPath(
  projectId: string,
  objectiveId: string,
): string {
  return path.join(
    getGroupDir(projectId),
    'objectives',
    objectiveId,
    OBJECTIVE_STATE_EVENT_OUTBOX,
  );
}

/**
 * A durable outbox: `key` (the leaf's path) only identifies it for locking and
 * logs; all I/O goes through the pinned `objectives/<objectiveId>` directory.
 */
interface OutboxRef {
  folder: string;
  objectiveId: string;
  key: string;
}

function objectiveStateOutboxRef(
  folder: string,
  objectiveId: string,
): OutboxRef {
  return {
    folder,
    objectiveId,
    key: objectiveStateEventOutboxPath(folder, objectiveId),
  };
}

async function withObjectiveStateOutboxLock<T>(
  outbox: OutboxRef,
  operation: () => Promise<T>,
): Promise<T> {
  const previous =
    objectiveStateOutboxLocks.get(outbox.key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  objectiveStateOutboxLocks.set(outbox.key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (objectiveStateOutboxLocks.get(outbox.key) === current) {
      objectiveStateOutboxLocks.delete(outbox.key);
    }
  }
}

const OUTBOX_MAX_BYTES = 8 * 1024 * 1024;
const MAX_REPLAYED_TASK_EVENTS = 500;

function isReplayedTaskEvent(pending: PendingObjectiveStateEvent): boolean {
  return pending.event.type.startsWith('task_');
}

async function readObjectiveStateOutbox(
  outbox: OutboxRef,
): Promise<ObjectiveStateEventOutbox> {
  const dir = await openGroupDir(
    outbox.folder,
    `objectives/${outbox.objectiveId}`,
  );
  if (!dir) return { version: 1, events: [] };
  try {
    const read = await readFileAt(dir, OBJECTIVE_STATE_EVENT_OUTBOX, {
      maxBytes: OUTBOX_MAX_BYTES,
    });
    if (!read) return { version: 1, events: [] };
    const parsed = JSON.parse(
      read.data.toString('utf-8'),
    ) as Partial<ObjectiveStateEventOutbox>;
    if (parsed.version !== 1 || !Array.isArray(parsed.events)) {
      throw new Error(`Invalid objective state event outbox: ${outbox.key}`);
    }
    return { version: 1, events: parsed.events };
  } finally {
    await dir.close();
  }
}

async function writeObjectiveStateOutbox(
  ref: OutboxRef,
  outbox: ObjectiveStateEventOutbox,
): Promise<void> {
  const empty = outbox.events.length === 0;
  const dir = await openGroupDir(ref.folder, `objectives/${ref.objectiveId}`, {
    create: !empty,
  });
  if (!dir) return;
  try {
    if (empty) {
      await removeAt(dir, OBJECTIVE_STATE_EVENT_OUTBOX);
    } else {
      const serialized = JSON.stringify(outbox, null, 2);
      if (Buffer.byteLength(serialized) > OUTBOX_MAX_BYTES) {
        throw new Error('Objective event outbox exceeds size limit');
      }
      await writeFileAt(dir, OBJECTIVE_STATE_EVENT_OUTBOX, serialized);
    }
  } finally {
    await dir.close();
  }
}

async function deliverObjectiveStateEvent(
  pending: PendingObjectiveStateEvent,
  ownerFolder: string,
  group?: {
    settings?: { brainAuthToken?: string; brainContainer?: string };
    parentId?: string;
  },
): Promise<'delivered' | 'retry' | 'dead'> {
  const authToken = resolveBrainAuthToken(group);
  if (!authToken) {
    logger.warn(
      {
        eventType: pending.event.type,
        project_id: pending.event.project_id,
        objective_id: pending.event.objective_id,
      },
      'Brain state event retained — no auth token is configured',
    );
    return 'retry';
  }

  const brainContainer = group ? resolveBrainContainer(group) : undefined;
  let brainUrl: string | null = null;
  if (brainContainer) {
    await refreshBrainPortCache();
    brainUrl = resolveBrainUrl(brainContainer);
  }
  brainUrl ??= pending.brainUrl;
  if (!brainUrl) {
    logger.warn(
      {
        eventType: pending.event.type,
        project_id: pending.event.project_id,
        objective_id: pending.event.objective_id,
        brainContainer,
      },
      'Brain state event retained — brain container could not be resolved',
    );
    return 'retry';
  }

  const eventWithRuntime = await attachRuntimeOrFallback(pending.event, {
    brainContainer,
  });
  if (!eventWithRuntime) {
    // Handled: a refused event is dropped, not retried forever.
    logger.warn(
      {
        eventType: pending.event.type,
        project_id: pending.event.project_id,
        objective_id: pending.event.objective_id,
        brainContainer,
        dropReason: 'privacy_refusal',
      },
      'Brain state event dropped — privacy mode refuses the objective runtime',
    );
    return 'dead';
  }
  const result = await publishWithRetry(
    brainUrl,
    eventWithRuntime,
    authToken,
    1,
    brainContainer,
    resolveBrainAuthTokenOwner(group, ownerFolder),
  );
  if (result.delivered) return 'delivered';
  const status = /^http_(\d+)$/.exec(result.reason)?.[1];
  const code = status ? Number(status) : undefined;
  return isPermanentClientError(code) && code !== 401 && code !== 403
    ? 'dead'
    : 'retry';
}

async function flushObjectiveStateOutbox(
  outboxRef: OutboxRef,
  group?: {
    settings?: { brainAuthToken?: string; brainContainer?: string };
    parentId?: string;
  },
): Promise<void> {
  while (true) {
    const pending = await withObjectiveStateOutboxLock(
      outboxRef,
      async () => (await readObjectiveStateOutbox(outboxRef)).events[0],
    );
    if (!pending) return;
    if (
      (await deliverObjectiveStateEvent(pending, outboxRef.folder, group)) ===
      'retry'
    )
      return;

    await withObjectiveStateOutboxLock(outboxRef, async () => {
      const outbox = await readObjectiveStateOutbox(outboxRef);
      outbox.events = outbox.events.filter((event) => event.id !== pending.id);
      await writeObjectiveStateOutbox(outboxRef, outbox);
    });
  }
}

function scheduleObjectiveStateOutboxFlush(
  outboxRef: OutboxRef,
  group?: {
    settings?: { brainAuthToken?: string; brainContainer?: string };
    parentId?: string;
  },
): Promise<void> {
  const existing = objectiveStateFlushes.get(outboxRef.key);
  if (existing) return existing;
  const flush = flushObjectiveStateOutbox(outboxRef, group).finally(() => {
    if (objectiveStateFlushes.get(outboxRef.key) === flush) {
      objectiveStateFlushes.delete(outboxRef.key);
    }
  });
  objectiveStateFlushes.set(outboxRef.key, flush);
  return flush;
}

async function enqueueObjectiveStateEvent(
  folder: string,
  brainUrl: string | null,
  event: BrainEvent,
): Promise<OutboxRef> {
  const outboxRef = objectiveStateOutboxRef(folder, event.objective_id!);
  await withObjectiveStateOutboxLock(outboxRef, async () => {
    const outbox = await readObjectiveStateOutbox(outboxRef);
    const entry = { id: randomUUID(), brainUrl, event };
    outbox.events.push(entry);
    let dropped = 0;
    let taskCount = outbox.events.filter(isReplayedTaskEvent).length;
    while (
      taskCount > MAX_REPLAYED_TASK_EVENTS ||
      Buffer.byteLength(JSON.stringify(outbox, null, 2)) > OUTBOX_MAX_BYTES
    ) {
      const oldest = outbox.events.findIndex(isReplayedTaskEvent);
      if (oldest < 0 || outbox.events[oldest] === entry) {
        throw new Error('Objective event outbox exceeds size limit');
      }
      outbox.events.splice(oldest, 1);
      taskCount--;
      dropped++;
    }
    await writeObjectiveStateOutbox(outboxRef, outbox);
    if (dropped) {
      logger.warn(
        { objective_id: event.objective_id, dropped },
        'Oldest task events dropped from Brain outbox',
      );
    }
  });
  return outboxRef;
}

/**
 * Park an objective-tagged event whose delivery failed for a retryable reason
 * in the owner's durable outbox. The event keeps its outcome data and original
 * timestamp so a replay matches the brain's dedupe key. Reconciliation (boot,
 * service watcher) replays it; no flush is scheduled here because delivery
 * just failed.
 */
async function queueEventForReplay(
  owner: { folder: string },
  event: BrainEvent,
  dropReason: string,
): Promise<boolean> {
  try {
    await enqueueObjectiveStateEvent(owner.folder, null, event);
  } catch (err) {
    logger.warn(
      {
        err,
        eventType: event.type,
        project_id: event.project_id,
        task_id: event.task_id ?? null,
        objective_id: event.objective_id,
        dropReason,
      },
      'Brain event could not be queued for replay — dropped',
    );
    return false;
  }
  logger.warn(
    {
      dropReason,
      task_id: event.task_id ?? null,
      objective_id: event.objective_id,
    },
    'Brain event queued for replay',
  );
  return true;
}

/**
 * Durably enqueue an objective state change before returning to the route.
 * Delivery is attempted immediately, while the outbox remains available for
 * boot and service-watcher reconciliation until Brain acknowledges it.
 */
export async function publishObjectiveStateEvent(
  brainUrl: string | null,
  event: BrainEvent,
  group?: {
    settings?: { brainAuthToken?: string; brainContainer?: string };
    parentId?: string;
  },
): Promise<void> {
  if (!event.objective_id) {
    throw new Error('Durable objective state events require an objective_id');
  }
  let outboxRef: OutboxRef;
  try {
    outboxRef = await enqueueObjectiveStateEvent(
      event.project_id,
      brainUrl,
      event,
    );
  } catch (err) {
    logger.warn(
      { err, project_id: event.project_id, objective_id: event.objective_id },
      'Objective state event could not be queued — dropped',
    );
    return;
  }
  void scheduleObjectiveStateOutboxFlush(outboxRef, group).catch((err) => {
    logger.warn(
      { err, project_id: event.project_id, objective_id: event.objective_id },
      'Objective state event flush failed — durable event retained',
    );
  });
}

/** Retry every durable objective state event currently present on disk. */
export async function reconcilePendingObjectiveStateEvents(
  projectId?: string,
): Promise<void> {
  const groups = Object.values(registeredGroups).filter(
    (group) => !projectId || group.folder === projectId,
  );
  for (const group of groups) {
    let entries;
    try {
      const objectives = await openGroupDir(group.folder, 'objectives');
      if (!objectives) continue;
      try {
        entries = await readdirAt(objectives, undefined, {
          withFileTypes: true,
        });
      } finally {
        await objectives.close();
      }
    } catch (err) {
      if (!(err instanceof GroupFsError)) throw err;
      logger.warn(
        { err, folder: group.folder },
        'Refusing to scan objectives for pending state events',
      );
      continue;
    }
    await Promise.all(
      (entries ?? [])
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          scheduleObjectiveStateOutboxFlush(
            objectiveStateOutboxRef(group.folder, entry.name),
            group,
          ),
        ),
    );
  }
}
