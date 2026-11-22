import { knowledgeDocumentUrl } from './knowledge-files';
import { deviceTtsEnabled } from './device-tts';
import type { ProjectRevision } from '@/types';
import { readProjectCache, writeProjectCache } from './project-cache';
import { queryClient } from './query-client';
import { queryKeys } from './query-keys';
import type {
  BrowserSession,
  AvailableGroup,
  ChatDeepLink,
  ChatMessage,
  ChatMessageAttachment,
  Conversation,
  ConversationDiff,
  DefaultBranchSyncStatus,
  ConversationDiffFile,
  Cronjob,
  DatasetTask,
  DuressInstructionsResponse,
  FileFavorite,
  FileFavoriteRef,
  GroupFilesResponse,
  KnowledgeBase,
  KnowledgeChunk,
  KnowledgeVectorStatus,
  RepoFilesResponse,
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskTranscript,
  Task,
  TaskSummary,
  TaskMessage,
  TaskRunLog,
  TaskRunStageDuration,
  TaskDefaultBranchStatus,
  TaskDefaultBranchMerge,
  Project,
  ProjectSettings,
  ProjectsStatusSummary,
  StageMigration,
  StageOccupancy,
  RepositoryDiscoveryReport,
  WhatsAppStatus,
  Objective,
  ObjectiveStatus,
  TranscriptEntry,
  BoardReplayData,
  ConversationPublicShare,
} from '@/types';
import { useAuth } from './auth';
import {
  API_BASE_URL,
  HOME_URL,
  REMOTE_URL,
  remoteRetryUrl,
  trackNativeRequest,
} from './api-config';
import type { AccountPreferences, AccountProfile } from '@/types';
import { signPayload, createSigningPayload, importPrivateKey } from './crypto';
import { CapacitorHttp, Capacitor } from '@capacitor/core';
import { nativeSignPayload } from './push-bridge';
import { vaultGetAuthToken, vaultGetDeviceCreds } from './session-vault';
import { sandboxLifecycleParams } from './sandbox-settings';
import { base64ToBytes, bytesToBase64 } from './base64';

const headers = { 'Content-Type': 'application/json' };

export interface AppPublicationStatus {
  enabled: boolean;
  ready: boolean;
  targetPort?: number;
  hostname?: string;
  url?: string;
  ingressUrl?: string;
}

export async function fetchPublishedApp(
  projectId: string,
): Promise<AppPublicationStatus> {
  const response = await apiFetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/published-app`,
  );
  return handleResponse(response);
}

export async function setPublishedApp(
  projectId: string,
  input: { enabled: boolean; targetPort?: number; hostname?: string },
): Promise<AppPublicationStatus> {
  const response = await apiFetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/published-app`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify(input),
    },
  );
  return handleResponse(response);
}

export async function fetchBrowserSessions(
  projectId: string,
  conversationId?: string | null,
): Promise<BrowserSession[]> {
  const response = await apiFetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/browser/sessions${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''}`,
  );
  if (!response.ok) throw await apiErrorFromResponse(response);
  return (await response.json()).sessions;
}

export async function attachBrowserViewer(
  projectId: string,
  sessionId: string,
): Promise<{ viewerId: string; ticket: string }> {
  const response = await apiFetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/browser/viewers`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId }),
    },
  );
  if (!response.ok) throw await apiErrorFromResponse(response);
  const { viewerId } = await response.json();
  const ticketResponse = await apiFetch(`${API_BASE_URL}/api/ws-ticket`);
  if (!ticketResponse.ok) throw await apiErrorFromResponse(ticketResponse);
  return { viewerId, ticket: (await ticketResponse.json()).ticket };
}

export async function controlBrowserSession(
  projectId: string,
  sessionId: string,
  action: 'start' | 'restart' | 'close',
  url?: string,
): Promise<void> {
  const response = await apiFetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/browser/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, url }),
    },
  );
  if (!response.ok)
    throw await apiErrorFromResponse(response, 'Browser command failed.');
}

export interface ProviderAccountsView {
  accounts: Array<{
    id: string;
    provider: string;
    label: string;
    scope: 'shared' | 'client' | 'project';
    client?: string;
    /** Project integrations: the sandbox instance, its containers and the API calls the token serves. */
    project?: { stack: string; instance: string };
    containers?: string[];
    allow?: ProjectKeyRule[];
    /** Custom integrations: their relay route, base path and token placement. */
    route?: string;
    pathPrefix?: string;
    auth?: ProjectTokenAuth;
    tier?: string;
    capacity?: number;
    workspaceId?: string;
    host?: string;
    state: 'connected' | 'refreshPending' | 'loginRequired';
    expiresAt?: string;
    expirySource?: 'provider' | 'manual';
    keyCheck?: 'valid' | 'rejected';
    keyCheckedAt?: number;
  }>;
  clients: Array<{
    name: string;
    isolation: 'shared' | 'strict';
    patterns: string[];
  }>;
  logins: Array<{
    id: string;
    /** The managed account this login renews or creates (newer Box versions). */
    accountId?: string;
    provider: string;
    label: string;
    state: string;
    expiresAt: number;
    authorizationUrl?: string;
    userCode?: string;
    input: 'code' | 'callback' | 'none';
  }>;
}

export async function fetchProviderAccounts(): Promise<ProviderAccountsView> {
  return handleResponse(
    await apiFetch(`${API_BASE_URL}/api/admin/provider-accounts`),
  );
}
export type ProviderAccountUsage =
  | {
      windows: Array<{
        label: string;
        usedPercent: number;
        resetsAt?: number;
        models?: string[];
      }>;
      plan?: string;
      // Banked limit resets (Claude, Codex) that can be redeemed in the vendor's own app.
      resets?: { available: number; expiresAt?: number };
      fetchedAt: number;
    }
  | { error: string; fetchedAt: number };

// Prepaid credits (US dollars), reported separately from login-based accounts.
export type ProviderCredits = {
  provider: string;
  totalCredits: number;
  totalUsage: number;
  remaining: number;
  fetchedAt: number;
};

// Month-to-date Anthropic API spend for the whole organization (US dollars),
// read by the relay with an admin key. Anthropic reports no remaining balance.
export type ProviderApiSpend = {
  provider: string;
  spent: number;
  periodStart: string;
  models: Record<string, number>;
  fetchedAt: number;
};

// Prices of the OpenRouter models Board offers, in US dollars per million tokens.
export type OpenRouterModelPrice = {
  model: string;
  name: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
};

export async function fetchProviderUsage(): Promise<{
  usage: Record<string, ProviderAccountUsage>;
  credits?: ProviderCredits;
  apiSpend?: ProviderApiSpend;
  // Each admin key's organisation spend, keyed by its Anthropic Admin account.
  apiSpendByAccount?: Record<string, ProviderApiSpend>;
  // Mistral's API and Vibe Code allowances, read from Mistral billing.
  mistralBudget?: ProviderAccountUsage;
  openRouterModels?: OpenRouterModelPrice[];
}> {
  return handleResponse(
    await apiFetch(`${API_BASE_URL}/api/admin/provider-accounts/usage`),
  );
}
export async function startProviderLogin(input: {
  provider: string;
  label: string;
  scope: string;
  client?: string;
  /** Signs this existing account in again instead of adding an account. */
  accountId?: string;
  apiKey?: string;
  workspaceId?: string;
  host?: string;
  expiresAt?: string;
}): Promise<{ id: string; installed?: boolean }> {
  return handleResponse(
    await apiFetch(`${API_BASE_URL}/api/admin/provider-accounts/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    }),
  );
}
export async function completeProviderLogin(
  id: string,
  value: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/provider-accounts/login/${encodeURIComponent(id)}/complete`,
      { method: 'POST', headers, body: JSON.stringify({ value }) },
    ),
  );
}
export interface ProviderAccountPatch {
  label?: string;
  tier?: string | null;
  capacity?: number | null;
  expiresAt?: string | null;
}
export async function updateProviderAccount(
  id: string,
  input: ProviderAccountPatch,
): Promise<unknown> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/provider-accounts/${encodeURIComponent(id)}`,
      { method: 'PATCH', headers, body: JSON.stringify(input) },
    ),
  );
}
/** How the relay sends a custom integration's token. */
export type ProjectTokenAuth =
  | { type: 'bearer' }
  | { type: 'header'; name: string }
  | { type: 'basic'; username: string }
  | { type: 'query'; name: string };
/** One API call a project integration may serve: `*` stands for one path segment. */
export interface ProjectKeyRule {
  method: string;
  path: string;
}
export interface ProjectCodeAccessView {
  sandbox: { stack: string; instance: string };
  accounts: ProviderAccountsView['accounts'];
}
/** A saved change; `accounts` is null when Box accepted it but the list could not be re-read. */
export interface ProjectCodeAccessChange {
  sandbox: ProjectCodeAccessView['sandbox'];
  accounts: ProjectCodeAccessView['accounts'] | null;
}
const projectCodeAccessUrl = (projectId: string, id?: string) =>
  `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/integrations${
    id ? `/${encodeURIComponent(id)}` : ''
  }`;
export async function fetchProjectCodeAccess(
  projectId: string,
): Promise<ProjectCodeAccessView> {
  return handleResponse(await apiFetch(projectCodeAccessUrl(projectId)));
}
/** Saves (or replaces) one of the project's integrations; Board never stores the token. */
export async function saveProjectCodeAccess(
  projectId: string,
  input: { apiKey: string; allow: ProjectKeyRule[] } & (
    | { provider: 'gitlab' | 'github'; host: string }
    | {
        provider: 'custom';
        route: string;
        baseUrl: string;
        auth: ProjectTokenAuth;
      }
  ),
): Promise<ProjectCodeAccessChange> {
  return handleResponse(
    await apiFetch(projectCodeAccessUrl(projectId), {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    }),
  );
}
export async function updateProjectCodeAccess(
  projectId: string,
  id: string,
  allow: ProjectKeyRule[],
): Promise<ProjectCodeAccessChange> {
  return handleResponse(
    await apiFetch(projectCodeAccessUrl(projectId, id), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ allow }),
    }),
  );
}
export async function removeProjectCodeAccess(
  projectId: string,
  id: string,
): Promise<ProjectCodeAccessChange> {
  return handleResponse(
    await apiFetch(projectCodeAccessUrl(projectId, id), {
      method: 'DELETE',
      headers,
    }),
  );
}
export async function removeProviderAccount(id: string): Promise<unknown> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/provider-accounts/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers },
    ),
  );
}
export async function reorderProviderAccounts(
  ids: string[],
): Promise<ProviderAccountsView> {
  return handleResponse(
    await apiFetch(`${API_BASE_URL}/api/admin/provider-accounts/order`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids }),
    }),
  );
}
export async function cancelProviderLogin(
  id: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/provider-accounts/login/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  );
}

export interface McpConnectionsView {
  services: Array<{
    service: string;
    host: string;
    projects: Array<{
      project: string;
      state: 'connected' | 'loginRequired' | 'refreshFailed';
    }>;
  }>;
  logins: Array<{
    id: string;
    service: string;
    project: string;
    state: 'starting' | 'awaitingCallback' | 'failed' | 'connected';
    authorizationUrl?: string;
    expiresAt: number;
    error?: string;
  }>;
}

const MCP_CONNECTIONS_URL = `${API_BASE_URL}/api/admin/mcp-connections`;

export async function fetchMcpConnections(): Promise<McpConnectionsView> {
  return handleResponse(await apiFetch(MCP_CONNECTIONS_URL));
}
export async function startMcpLogin(input: {
  service: string;
  project: string;
}): Promise<{ id: string }> {
  return handleResponse(
    await apiFetch(`${MCP_CONNECTIONS_URL}/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    }),
  );
}
export async function completeMcpLogin(
  id: string,
  value: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      `${MCP_CONNECTIONS_URL}/login/${encodeURIComponent(id)}/complete`,
      { method: 'POST', headers, body: JSON.stringify({ value }) },
    ),
  );
}
export async function cancelMcpLogin(id: string): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(`${MCP_CONNECTIONS_URL}/login/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  );
}
export async function revokeMcpConnection(input: {
  service: string;
  project: string;
}): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(`${MCP_CONNECTIONS_URL}/revoke`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    }),
  );
}

export interface CarapaBoxView {
  id: string;
  label: string;
  kind: 'docker' | 'native';
  tokenPrefix: string;
  isolationLevel: string;
  version: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  online: boolean;
  connectedAt: string | null;
  projects: string[];
}

export async function fetchCarapaBoxes(): Promise<{ boxes: CarapaBoxView[] }> {
  return handleResponse(await apiFetch(`${API_BASE_URL}/api/admin/boxes`));
}
export async function createCarapaBox(input: {
  id: string;
  label: string;
  kind: 'docker' | 'native';
}): Promise<{ box: CarapaBoxView; token: string }> {
  return handleResponse(
    await apiFetch(`${API_BASE_URL}/api/admin/boxes`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    }),
  );
}
export async function rotateCarapaBoxToken(
  id: string,
): Promise<{ token: string }> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/boxes/${encodeURIComponent(id)}/rotate-token`,
      { method: 'POST' },
    ),
  );
}
export async function revokeCarapaBox(id: string): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/boxes/${encodeURIComponent(id)}/revoke`,
      { method: 'POST' },
    ),
  );
}
export async function deleteCarapaBox(id: string): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/boxes/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
      },
    ),
  );
}
export async function assignProjectToBox(
  boxId: string,
  folder: string,
  acknowledgeReducedIsolation = false,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/boxes/${encodeURIComponent(boxId)}/projects/${encodeURIComponent(folder)}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ acknowledgeReducedIsolation }),
      },
    ),
  );
}

type NativeBinaryBody = {
  base64: string;
  byteLength: number;
  contentType: string;
};

// CapacitorHttp returns `arraybuffer` responses to JavaScript as base64. Keep
// that original representation attached out-of-band to the Response so native
// media consumers can render it directly. Android WebView has proved
// unreliable when the same payload is converted through Response -> Blob ->
// blob: URL, while data: image URLs avoid that browser-owned blob boundary.
const nativeBinaryBodies = new WeakMap<Response, NativeBinaryBody>();

export function getNativeBinaryDataUrl(response: Response): {
  base64: string;
  url: string;
  byteLength: number;
  contentType: string;
} | null {
  const body = nativeBinaryBodies.get(response);
  if (!body) return null;
  return {
    base64: body.base64,
    url: `data:${body.contentType};base64,${body.base64}`,
    byteLength: body.byteLength,
    contentType: body.contentType,
  };
}

/**
 * Derive the `source` value for chat messages based on the current platform.
 * Returns 'android' | 'ios' on native, 'web' on the browser.
 */
function getChatSource(): 'web' | 'android' | 'ios' {
  if (Capacitor.isNativePlatform()) {
    const platform = Capacitor.getPlatform();
    if (platform === 'android') return 'android';
    if (platform === 'ios') return 'ios';
  }
  return 'web';
}

// `apiFetch` is NOT user activity. The biometric-lock freshness gate is
// driven by genuine DOM input events (see lib/activity-tracker.ts). Network
// traffic — polling, WS-driven invalidations, reconnect probes, refetch
// intervals — runs whenever the JS thread is alive and would otherwise
// silently keep the gate "fresh" with the user nowhere near the device.

export type ApiFetchOptions = {
  /** Keep an authentication exchange pinned to its requested board origin. */
  allowRemoteRetry?: boolean;
};

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Credentials (bearer token, device signature) may only be sent to the board
 * itself. Persisted message content can carry attacker-chosen absolute URLs.
 */
function isTrustedBoardUrl(url: string): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  const origin = originOf(url);
  if (!origin) return false;
  const trusted = [API_BASE_URL, HOME_URL, REMOTE_URL].map(originOf);
  if (!Capacitor.isNativePlatform() && typeof window !== 'undefined') {
    trusted.push(window.location?.origin ?? null);
  }
  return trusted.includes(origin);
}

export async function apiFetch(
  url: string,
  init?: RequestInit,
  fetchOptions: ApiFetchOptions = {},
): Promise<Response> {
  const sendCredentials = isTrustedBoardUrl(url);
  const token = sendCredentials ? vaultGetAuthToken() : null;
  const headers = new Headers(init?.headers);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // --- Secure Handshake Signing ---
  // Skipped for foreign origins so the device signature is never disclosed.
  // On Android the device private key lives only in EncryptedSharedPreferences
  // and signing happens in native code — the JS layer never holds the raw
  // key. On web/iOS we still use WebCrypto with the localStorage-stored key.
  // The native bridge returns its own deviceId so JS doesn't have to read
  // (and trust) localStorage's copy when signing is delegated.
  if (sendCredentials) {
    try {
      const timestamp = new Date().toISOString();
      const method = (init?.method || 'GET').toUpperCase();
      // GET/HEAD requests never have a body in the signature.
      // For other methods, match the server's `requireFreshSignature`
      // empty-body shortcut: an object with no keys is signed as '' on the
      // server. The literal string '{}' would otherwise mismatch.
      let body =
        method === 'GET' || method === 'HEAD'
          ? ''
          : typeof init?.body === 'string'
            ? init.body
            : '';
      if (body === '{}') body = '';
      const payload = createSigningPayload(method, url, timestamp, body);

      let signature: string | null = null;
      let signingDeviceId: string | null = null;

      const native = await nativeSignPayload(payload);
      if (native) {
        signature = native.signature;
        signingDeviceId = native.deviceId;
      } else {
        // Web / iOS / Android pre-migration fallback. Same WebCrypto path as
        // before. On Android this only runs if native signing is unavailable
        // (bridge not loaded, no credentials mirrored yet). Reads go through
        // the session vault — when the user has biometric unlock configured,
        // the priv key lives in memory only and the vault returns null while
        // locked (which correctly stops signing until unlock).
        const { deviceId: fallbackDeviceId, privKeyB64: privKeyBase64 } =
          vaultGetDeviceCreds();
        if (fallbackDeviceId && privKeyBase64) {
          const privKey = await importPrivateKey(privKeyBase64);
          signature = await signPayload(privKey, payload);
          signingDeviceId = fallbackDeviceId;
        }
      }

      if (signature && signingDeviceId) {
        headers.set('X-Carapa-Device-ID', signingDeviceId);
        headers.set('X-Carapa-Timestamp', timestamp);
        headers.set('X-Carapa-Signature', signature);
      }
    } catch (err) {
      console.error('Failed to sign request:', err);
    }
  }

  // Use Native HTTP for Android/iOS to handle self-signed certs better
  if (Capacitor.isNativePlatform()) {
    let nativeData: any = init?.body;
    let nativeDataType: 'formData' | undefined;
    if (init?.body instanceof FormData) {
      nativeDataType = 'formData';
      nativeData = await Promise.all(
        Array.from(init.body.entries()).map(async ([key, value]) => {
          if (typeof value === 'string')
            return { key, value, type: 'string' as const };
          const bytes = new Uint8Array(await value.arrayBuffer());
          return {
            key,
            value: bytesToBase64(bytes),
            type: 'base64File' as const,
            contentType: value.type || 'application/octet-stream',
            fileName: value.name || 'upload.bin',
          };
        }),
      );
    }
    const requestMethod = (init?.method || 'GET').toUpperCase();
    const isAccountAvatarRead =
      requestMethod === 'GET' &&
      /\/api\/users\/[^/]+\/avatar(?:\?.*)?$/.test(url);
    const isAccountAvatarCandidateRead =
      requestMethod === 'GET' &&
      /\/api\/account\/avatar\/candidate(?:\?.*)?$/.test(url);
    const isAvatarGeneration =
      (url.includes('/api/admin/ai-users/') ||
        url.includes('/api/account/avatar/')) &&
      url.endsWith('/generate');
    const options = {
      url,
      method: requestMethod,
      headers: Object.fromEntries(headers.entries()),
      data: nativeData,
      ...(nativeDataType ? { dataType: nativeDataType } : {}),
      connectTimeout: 30000,
      // Image providers can legitimately need several minutes. Keep the
      // native HTTP bridge alive as long as the avatar-specific backend wait.
      readTimeout: isAvatarGeneration ? 900000 : 120000,
      responseType:
        url.includes('/api/media') ||
        url.includes('/api/attachments') ||
        /\/api\/knowledge\/[^/]+\/files\/(?:[^/]+\/)?(?:thumbnail|content)(?:\?|$)/.test(
          url,
        ) ||
        /\/mail\/attachment(?:\?|$)/.test(url) ||
        url.includes('/api/wa-media') ||
        url.includes('/api/ai-users/') ||
        isAccountAvatarRead ||
        isAccountAvatarCandidateRead ||
        url.includes('/uploads/') ||
        url.includes('/artifacts/') ||
        url.includes('/api/tts/synthesize') ||
        /\/messages\/[^/]+\/speech(?:\?|$)/.test(url) ||
        url.includes('/files/group/content') ||
        url.includes('/files/repo/content') ||
        /\/files\/(?:mount|root)\/\d+\/content/.test(url)
          ? ('arraybuffer' as const)
          : ('text' as const),
    };

    let response;
    try {
      response = await trackNativeRequest(CapacitorHttp.request(options));

      // Retry a failed local transport through the remote endpoint without
      // letting one request mutate the detector-owned global connection mode.
      if (
        response.status <= 0 ||
        response.status === 503 ||
        response.status === 504
      ) {
        const newUrl =
          fetchOptions.allowRemoteRetry === false ? null : remoteRetryUrl(url);
        if (newUrl) {
          console.log(
            `[API] Local retry (Status ${response.status}): Retrying ${options.method} with remote endpoint`,
          );
          return apiFetch(newUrl, init, fetchOptions);
        }
      }
    } catch (err) {
      const newUrl =
        fetchOptions.allowRemoteRetry === false ? null : remoteRetryUrl(url);
      if (newUrl) {
        console.log(
          `[API] Local retry (Error): Retrying ${options.method} with remote endpoint`,
        );
        return apiFetch(newUrl, init, fetchOptions);
      }
      throw err;
    }

    let body: any = response.data;
    let nativeBinaryBody: NativeBinaryBody | null = null;
    if (
      options.responseType === 'arraybuffer' &&
      typeof response.data === 'string'
    ) {
      const bytes = base64ToBytes(response.data);
      body = bytes.buffer;
      const responseHeaders = new Headers(response.headers as any);
      const rawContentType = responseHeaders.get('content-type') || '';
      const contentType = /^[\w.+-]+\/[\w.+-]+(?:\s*;[^\r\n]*)?$/.test(
        rawContentType,
      )
        ? rawContentType
        : 'application/octet-stream';
      nativeBinaryBody = {
        base64: response.data,
        byteLength: bytes.byteLength,
        contentType,
      };
    } else if (
      typeof response.data !== 'string' &&
      !(response.data instanceof ArrayBuffer)
    ) {
      // The native bridge parses `application/json` bodies into objects even
      // when `arraybuffer` was requested (e.g. the text envelope returned by
      // the dual-shape file-content endpoints). Re-serialize so `Response`
      // doesn't stringify it to "[object Object]".
      body = JSON.stringify(response.data);
    }

    const webResponse = new Response(body, {
      status: response.status,
      headers: new Headers(response.headers as any),
    });
    if (nativeBinaryBody) nativeBinaryBodies.set(webResponse, nativeBinaryBody);
    return webResponse;
  }

  return fetch(url, {
    ...init,
    headers,
    credentials: 'include',
  });
}

/** The merge approval a person can decide when the merge risk gate holds a merge. */
export interface HeldMergeApproval {
  proposalId: string;
  headSha: string;
  findings: Array<{ ruleId: string; file: string; reason: string }>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly approval?: HeldMergeApproval,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Builds the ApiError for a non-ok response, tolerating non-JSON bodies.
 * An expired login (401) ends the session; a rejected device signature does not.
 */
async function apiErrorFromResponse(
  res: Response,
  fallbackMessage = `HTTP ${res.status}`,
): Promise<ApiError> {
  if (res.status === 401) {
    // A rejected fresh device signature (admin writes) is not an expired login.
    const body = await res
      .clone()
      .json()
      .catch(() => ({}));
    if (
      typeof body?.error === 'string' &&
      (/signature|device/i.test(body.error) || body.error === 'Stale timestamp')
    ) {
      return new ApiError(body.error, res.status);
    }
    useAuth.getState().expireSession();
    return new ApiError(body?.error || 'Session expired', res.status);
  }
  const body = await res.json().catch(() => ({ error: res.statusText }));
  const message = body?.error || fallbackMessage;
  const detail = typeof body?.detail === 'string' ? body.detail.trim() : '';
  return new ApiError(
    detail && detail !== message ? `${message}\n${detail}` : message,
    res.status,
    body?.approval,
  );
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) throw await apiErrorFromResponse(res);
  return res.json();
}

// --- Config ---

export async function fetchNetworkConfig(): Promise<{
  localHostnames: string[];
}> {
  return handleResponse(
    await fetch('/api/network-config', {
      cache: 'no-store',
      credentials: 'same-origin',
    }),
  );
}

export async function fetchConfig(): Promise<{
  assistantName: string;
  showSandboxPorts: boolean;
  enableNginxProxy: boolean;
  defaultAgentCmd: string;
  buildVersion: string;
  buildTime?: string;
  // True when the server has CARAPA_BOARD_DEPLOY_SERVICE set (admin Build app).
  enableBoardSelfDeploy?: boolean;
  // Module-contributed flags. Each flag is present (typically `true`) only when
  // the corresponding module is enabled on the backend; absent when disabled.
  enableObjectives?: boolean;
  enableWhatsApp?: boolean;
  enableGitNexus?: boolean;
  enableKanban?: boolean;
  enableChat?: boolean;
  enableFsTools?: boolean;
  toolsets?: {
    available: string[];
    defaults: string[];
  };
  // TTS module flags (present when ENABLE_TTS is on)
  ttsEnabled?: boolean;
  ttsVoice?: string;
  ttsLang?: string;
  ttsFormat?: string;
  ttsExpressionsEnabled?: boolean;
  liveVoiceEnabled?: boolean;
  liveVoiceWebsocketUrl?: string;
  liveVoiceModel?: string;
  liveVoiceLanguage?: string;
  liveVoiceProtocol?: string;
  meetingLanguages?: Array<{
    code: string;
    label: string;
    script: 'latin' | 'cyrillic' | 'any';
    prompt?: string;
  }>;
}> {
  return handleResponse(await apiFetch(API_BASE_URL + '/api/config'));
}

export interface RuntimeSelection {
  harnessId: string;
  modelId: string;
  reasoning?: string;
  temperature?: number;
}

export interface DailyProviderCost {
  date: string;
  provider: 'OpenAI' | 'Anthropic' | 'Gemini' | 'Other';
  costUsd: number;
  runCount: number;
  models: string[];
}

export type UncostedRunReason =
  | 'running'
  | 'no_model'
  | 'pricing_file_missing'
  | 'model_not_priced'
  | 'no_usage_telemetry'
  | 'other';

export interface UncostedRunGroup {
  date: string;
  source: 'task' | 'chat' | 'brain' | 'external';
  agentName: string | null;
  model: string | null;
  stage: string | null;
  status: string | null;
  reason: UncostedRunReason;
  count: number;
  examples: Array<{ id: string; groupFolder: string | null }>;
}

export interface RunCostReport {
  days: number;
  timezoneOffset: number;
  projectId: string | null;
  runType: 'chat' | 'task' | 'event' | null;
  includedProjectIds: string[] | null;
  daily: DailyProviderCost[];
  coverage: Array<{
    date: string;
    totalRuns: number;
    costedRuns: number;
    uncostedRuns: number;
  }>;
  /** Absent when the server predates the unpriced-run drill-down. */
  uncosted?: UncostedRunGroup[];
  totalCostUsd: number;
  totalRuns: number;
}

export async function fetchRunCostReport(
  days: number,
  projectId: string | null,
  runType: 'chat' | 'task' | 'event' | null,
): Promise<RunCostReport> {
  const params = new URLSearchParams({
    days: String(days),
    timezoneOffset: String(new Date().getTimezoneOffset()),
  });
  if (projectId) params.set('projectId', projectId);
  if (runType) params.set('runType', runType);
  return handleResponse(
    await apiFetch(`${API_BASE_URL}/api/reports/run-costs?${params}`),
  );
}

export type HistoryMemoryType =
  | 'identity'
  | 'project'
  | 'goal'
  | 'decision'
  | 'preference'
  | 'contact'
  | 'event'
  | 'task';

export interface ExistingMemory {
  id: string;
  group_folder: string;
  objective_id?: string | null;
  content: string;
  memory_type: HistoryMemoryType;
  importance: number;
  source: 'user' | 'agent' | 'observer';
  sourceRef?: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  access_count: number;
  superseded_by?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  marked_for_eval: boolean;
}

export interface ExistingMemoryPage {
  items: ExistingMemory[];
  total: number;
  offset: number;
  limit: number;
}

export async function fetchExistingMemoriesPage(
  projectId: string,
  options: {
    offset?: number;
    limit?: number;
    query?: string;
    memoryType?: string;
  } = {},
): Promise<ExistingMemoryPage> {
  const params = new URLSearchParams({
    paged: '1',
    offset: String(options.offset ?? 0),
    limit: String(options.limit ?? 100),
  });
  if (options.query?.trim()) params.set('q', options.query.trim());
  if (options.memoryType && options.memoryType !== 'all') {
    params.set('type', options.memoryType);
  }
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/groups/${encodeURIComponent(projectId)}/memories?${params}`,
      { cache: 'no-store' },
    ),
  );
}

export async function updateExistingMemory(
  projectId: string,
  memoryId: string,
  updates: {
    content?: string;
    memory_type?: HistoryMemoryType;
    importance?: number;
    tags?: string;
    mark_for_eval?: boolean;
  },
): Promise<ExistingMemory> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/groups/${encodeURIComponent(projectId)}/memories/${encodeURIComponent(memoryId)}`,
      { method: 'PATCH', headers, body: JSON.stringify(updates) },
    ),
  );
}

export async function moveExistingMemory(
  projectId: string,
  memoryId: string,
  targetProjectId: string,
): Promise<ExistingMemory> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/groups/${encodeURIComponent(projectId)}/memories/${encodeURIComponent(memoryId)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ targetProjectId }),
      },
    ),
  );
}

export async function deleteExistingMemory(
  projectId: string,
  memoryId: string,
): Promise<{ ok: true }> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/groups/${encodeURIComponent(projectId)}/memories/${encodeURIComponent(memoryId)}`,
      { method: 'DELETE', headers },
    ),
  );
}

export type MemoryAuditStatus =
  | 'queued'
  | 'running'
  | 'ready'
  | 'applying'
  | 'applied'
  | 'paused'
  | 'failed';
export type MemoryAuditDisposition =
  | 'keep'
  | 'rewrite'
  | 'merge'
  | 'erase'
  | 'create'
  | 'enhance'
  | 'move';
export type MemoryAuditReviewDecision =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'delete_memory'
  | 'delete_both'
  | 'dismissed';

export interface MemoryAuditEvidenceFile {
  id: string;
  repository_root: string;
  path: string;
  file_sha256: string;
  excerpt_sha256: string;
  watched_scope?: string | null;
  watched_scope_sha256?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  excerpt: string;
  verified_at: string;
}

export interface MemoryAuditItem {
  id: string;
  memory_id: string;
  memory_fingerprint: string;
  processing_state:
    | 'pending'
    | 'processing'
    | 'complete'
    | 'certified'
    | 'error';
  disposition?: MemoryAuditDisposition | null;
  confidence?: number | null;
  reason?: string | null;
  proposed_content?: string | null;
  proposed_memory_type?: HistoryMemoryType | null;
  proposed_importance?: number | null;
  proposed_tags?: string[] | null;
  merge_target_id?: string | null;
  target_project_id?: string | null;
  retrieval_value?:
    | 'navigation'
    | 'pattern'
    | 'constraint'
    | 'decision'
    | 'workflow'
    | 'integration'
    | null;
  proposed_valid_from?: string | null;
  proposal_evidence?: MemoryAuditEvidenceFile[];
  review_decision: MemoryAuditReviewDecision;
  revision: number;
  applied_at?: string | null;
  applied_memory_id?: string | null;
  stale?: boolean;
  memory?: ExistingMemory | null;
  certificate?: {
    id: string;
    verdict: string;
    value_justification: string;
    evidence_type: 'code' | 'reasoning' | 'human';
    origin: 'automatic' | 'human';
    expires_at?: string | null;
    files: MemoryAuditEvidenceFile[];
  } | null;
}

export interface MemoryAudit {
  id: string;
  project_id: string;
  runtime_id: string;
  prompt_version: string;
  mode: 'cleanup' | 'index' | 'reorganize';
  status: MemoryAuditStatus;
  total_items: number;
  processed_items: number;
  proposal_items: number;
  retry_count: number;
  error?: string | null;
  created_at: string;
  updated_at: string;
  ready_at?: string | null;
  applied_at?: string | null;
}

export interface MemoryAuditView extends MemoryAudit {
  items: MemoryAuditItem[];
  index_summary?: {
    discovered: number;
    created: number;
    enhanced: number;
    covered: number;
    skipped: number;
    finished_at?: string | null;
    summary?: string | null;
    inspected_areas: string[];
  } | null;
  related_projects: Array<{
    id: string;
    name: string;
    relationship: string;
  }>;
  counts: {
    pending: number;
    approved: number;
    rejected: number;
    applied: number;
    applicable: number;
    skipped: number;
    delete_memory: number;
    delete_both: number;
    dismissed: number;
  };
  apply_enabled: boolean;
}

export interface MemoryAuditActionCounts {
  erased: number;
  merged: number;
  created: number;
  moved: number;
}

export interface MemoryAuditReport {
  project_id: string;
  generated_at: string;
  last_applied_at?: string | null;
  total_audits: number;
  totals: MemoryAuditActionCounts;
  audits: Array<{
    id: string;
    mode: MemoryAudit['mode'];
    status: MemoryAuditStatus;
    created_at: string;
    applied_at?: string | null;
    counts: MemoryAuditActionCounts;
  }>;
}

export async function fetchProjectMemoryAudits(
  projectId: string,
): Promise<{ audits: MemoryAudit[] }> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/memory-review/projects/${encodeURIComponent(projectId)}/audits`,
      { cache: 'no-store' },
    ),
  );
}

export async function fetchProjectMemoryAuditReport(
  projectId: string,
): Promise<MemoryAuditReport> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/memory-review/projects/${encodeURIComponent(projectId)}/audits/report`,
      { cache: 'no-store' },
    ),
  );
}

export async function startProjectMemoryAudit(
  projectId: string,
  mode: 'cleanup' | 'index' | 'reorganize' = 'cleanup',
): Promise<{ audit: MemoryAudit; created: boolean }> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/memory-review/projects/${encodeURIComponent(projectId)}/audits`,
      { method: 'POST', headers, body: JSON.stringify({ mode }) },
    ),
  );
}

export async function fetchProjectMemoryAudit(
  projectId: string,
  auditId: string,
): Promise<MemoryAuditView> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/memory-review/projects/${encodeURIComponent(projectId)}/audits/${encodeURIComponent(auditId)}`,
      { cache: 'no-store' },
    ),
  );
}

export async function resumeProjectMemoryAudit(
  projectId: string,
  auditId: string,
): Promise<MemoryAudit> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/memory-review/projects/${encodeURIComponent(projectId)}/audits/${encodeURIComponent(auditId)}/resume`,
      { method: 'POST', headers, body: '{}' },
    ),
  );
}

export async function reviewProjectMemoryAuditItem(
  projectId: string,
  auditId: string,
  itemId: string,
  payload: {
    revision: number;
    decision: MemoryAuditReviewDecision;
    edits?: {
      reason?: string;
      proposed_content?: string;
      proposed_memory_type?: HistoryMemoryType;
      proposed_importance?: number;
      proposed_tags?: string[];
      merge_target_id?: string;
      target_project_id?: string;
      proposed_valid_from?: string;
    };
  },
): Promise<MemoryAuditView> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/memory-review/projects/${encodeURIComponent(projectId)}/audits/${encodeURIComponent(auditId)}/items/${encodeURIComponent(itemId)}`,
      { method: 'PUT', headers, body: JSON.stringify(payload) },
    ),
  );
}

export async function deleteSkippedProjectMemory(
  projectId: string,
  auditId: string,
  itemId: string,
): Promise<MemoryAuditView> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/memory-review/projects/${encodeURIComponent(projectId)}/audits/${encodeURIComponent(auditId)}/items/${encodeURIComponent(itemId)}/skipped-memory`,
      { method: 'DELETE', headers },
    ),
  );
}

export type BrainConnectionTestResult =
  | {
      result:
        | 'accepted'
        | 'no-container'
        | 'no-token'
        | 'not-found'
        | 'no-endpoint'
        | 'discovery-failed';
    }
  | { result: 'unreachable'; code?: string }
  | { result: 'rejected' | 'error'; status: number };

/** Ask the brain whether it accepts a token (unsaved form values allowed). */
export async function testBrainConnection(
  projectId: string,
  input: { brainContainer?: string; brainAuthToken?: string },
): Promise<BrainConnectionTestResult> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/test-brain-connection`,
      { method: 'POST', headers, body: JSON.stringify(input) },
    ),
  );
}

export async function forceRecheckProjectMemory(
  projectId: string,
  auditId: string,
  memoryId: string,
): Promise<{ ok: true }> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/memory-review/projects/${encodeURIComponent(projectId)}/audits/${encodeURIComponent(auditId)}/items/${encodeURIComponent(memoryId)}/recheck`,
      { method: 'POST', headers, body: '{}' },
    ),
  );
}

export async function applyProjectMemoryAudit(
  projectId: string,
  auditId: string,
): Promise<MemoryAuditView> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/memory-review/projects/${encodeURIComponent(projectId)}/audits/${encodeURIComponent(auditId)}/apply`,
      { method: 'POST', headers, body: '{}' },
    ),
  );
}

export async function approveAndApplyProjectMemoryAudit(
  projectId: string,
  auditId: string,
): Promise<MemoryAuditView> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/memory-review/projects/${encodeURIComponent(projectId)}/audits/${encodeURIComponent(auditId)}/approve-all-and-apply`,
      { method: 'POST', headers, body: '{}' },
    ),
  );
}

export interface HistoryReviewEvidence {
  source_kind: 'conversation' | 'memory_file';
  conversation_id: string;
  message_id: string;
  role: string;
  created_at: string;
  excerpt: string;
  memory_file_path?: string;
}

export type HistoryReviewMemoryOp =
  | {
      op: 'create';
      candidate_ids: string[];
      new_memory_id: string;
      memory_type: HistoryMemoryType;
      content: string;
      valid_from: string;
      importance: number;
      tags: string[];
      precedes_id?: string;
    }
  | {
      op: 'supersede';
      candidate_ids: string[];
      new_memory_id: string;
      supersedes_id: string;
      memory_type: HistoryMemoryType;
      correction_content: string;
      valid_from: string;
      importance: number;
      tags: string[];
      precedes_id?: string;
    }
  | {
      op: 'invalidate';
      candidate_ids: string[];
      memory_id: string;
      effective_at: string;
      reason: string;
    }
  | {
      op: 'forget';
      candidate_ids: string[];
      memory_id: string;
      target: string;
    };

export interface HistoryReviewCandidate {
  id: string;
  planned_memory_id: string;
  memory_type: HistoryMemoryType;
  claim: string;
  change_kind: string;
  effective_at: string;
  confidence: number;
  importance: number;
  tags: string[];
  evidence: HistoryReviewEvidence[];
}

export interface HistoryReviewEdits {
  content?: string;
  memory_type?: string;
  importance?: number;
  tags?: string[];
  valid_from?: string;
  reason?: string;
  effective_at?: string;
}

export interface HistoryReviewTargetMemory {
  id: string;
  content: string;
  memory_type: string;
  valid_from: string;
}

export interface HistoryReviewOperation {
  id: string;
  operation: HistoryReviewMemoryOp;
  candidates: HistoryReviewCandidate[];
  evidence: HistoryReviewEvidence[];
  mandatory: boolean;
  decision: 'pending' | 'approved' | 'rejected';
  mark_for_eval: boolean;
  target_project_id: string;
  edits?: HistoryReviewEdits;
  reviewed_by?: string;
  reviewed_at?: string;
  /** Existing memory acted on by supersede, invalidate or forget. Absent on older payloads; null when not found or no longer current. */
  target_memory?: HistoryReviewTargetMemory | null;
}

export interface HistoryReviewProject {
  batch_id: string;
  batch_status: 'previewing' | 'preview' | 'applying' | 'applied' | 'error';
  project_id: string;
  project_status: 'pending' | 'preview' | 'applied' | 'error';
  created_at: string;
  cutoff_at: string;
  progress: {
    reflection?: {
      completedChunks: number;
      totalChunks: number;
      failedChunks: number;
      activeChunk: number | null;
      updatedAt: string;
    };
    conversations_processed: number;
    conversations_total: number;
    memory_files_processed: number;
    memory_files_total: number;
  };
  counts: {
    operations: number;
    pending: number;
    approved: number;
    eval: number;
    rejected: number;
    mandatory: number;
    skipped_groups: number;
  };
  operations: HistoryReviewOperation[];
  skipped_candidates: Array<{
    candidate_ids: string[];
    reason: string;
    candidates: HistoryReviewCandidate[];
  }>;
  errors: string[];
  ignored_errors: string[];
  partial_finalized_at?: string;
  review_revision: number;
  manifest_fingerprint: string | null;
  review_stale: boolean;
  review_enabled: boolean;
  apply_enabled: boolean;
  applied_at?: string;
}

export interface HistoryReviewBatchSummary {
  id: string;
  created_at: string;
  cutoff_at: string;
  projectId: string | null;
  since: string | null;
  until: string | null;
  reflectorModel: string | null;
  status: 'previewing' | 'preview' | 'applying' | 'applied' | 'error';
  projects: number;
  ready: number;
  applied: number;
  errors: number;
  pending_operations: number;
  reviewed_operations: number;
}

export interface HistoryReviewBatchDetail {
  batch: HistoryReviewBatchSummary;
  projects: HistoryReviewProject[];
}

export async function fetchHistoryReviewBatches(): Promise<{
  batches: HistoryReviewBatchSummary[];
}> {
  return handleResponse(
    await apiFetch(`${API_BASE_URL}/api/history-reflection/batches`),
  );
}

export async function startHistoryReviewGeneration(payload: {
  projectId: string;
  since: string;
  until: string;
  reflectorRuntime?: RuntimeSelection;
}): Promise<{ batchId: string }> {
  return handleResponse(
    await apiFetch(`${API_BASE_URL}/api/history-reflection/batches`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }),
  );
}

export async function fetchHistoryReviewBatch(
  batchId: string,
): Promise<HistoryReviewBatchDetail> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/history-reflection/batches/${encodeURIComponent(batchId)}`,
    ),
  );
}

export async function acceptPartialHistoryReviewBatch(
  batchId: string,
): Promise<HistoryReviewBatchDetail> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/history-reflection/batches/${encodeURIComponent(batchId)}/accept-partial`,
      { method: 'POST', headers, body: '{}' },
    ),
  );
}

export async function updateHistoryReviewOperation(
  batchId: string,
  projectId: string,
  itemId: string,
  payload: {
    revision: number;
    decision: 'pending' | 'approved' | 'rejected';
    mark_for_eval?: boolean;
    target_project_id?: string;
    edits?: HistoryReviewEdits;
  },
): Promise<HistoryReviewProject> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/history-reflection/batches/${encodeURIComponent(batchId)}/projects/${encodeURIComponent(projectId)}/review/${encodeURIComponent(itemId)}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
      },
    ),
  );
}

export async function resetHistoryReviewProject(
  batchId: string,
  projectId: string,
): Promise<HistoryReviewProject> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/history-reflection/batches/${encodeURIComponent(batchId)}/projects/${encodeURIComponent(projectId)}/review`,
      { method: 'DELETE', headers },
    ),
  );
}

export async function applyHistoryReviewProject(
  batchId: string,
  projectId: string,
): Promise<{
  project: HistoryReviewProject;
  applied: {
    alreadyApplied: boolean;
    baselineRebased?: boolean;
    applied: {
      created: number;
      superseded: number;
      invalidated: number;
      forgotten: number;
    };
  };
}> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/history-reflection/batches/${encodeURIComponent(batchId)}/projects/${encodeURIComponent(projectId)}/apply`,
      { method: 'POST', headers },
    ),
  );
}

export interface RuntimeDefaultPolicy {
  chat: RuntimeSelection;
  kanban: {
    fallback: RuntimeSelection;
    stages: Record<string, RuntimeSelection>;
  };
  observer?: RuntimeSelection;
  reflector?: RuntimeSelection;
  transcription?: RuntimeSelection;
  peekFiles?: RuntimeSelection;
  commitMessage?: RuntimeSelection;
  auditMemories?: RuntimeSelection;
  publicSafetyJudge?: RuntimeSelection;
}
export interface RuntimeCatalog {
  version: 2;
  harnesses: Array<{
    id: string;
    label: string;
    kind: 'direct' | 'cli';
    sessionFamily: string;
    icon?: string;
  }>;
  models: Array<{
    id: string;
    label: string;
    capabilities: string[];
    /** Added from model discovery rather than written in board_agents.jsonc. */
    discovered?: true;
    /** The provider account or harness no longer offers this model. */
    unavailable?: true;
    bindings: Array<{
      harnessId: string;
      runtimeId: string;
      /** Harness-native model string recorded on runs, when declared. */
      model?: string;
      /** Model capabilities plus the ones only this harness binding adds. */
      capabilities?: string[];
      reasoning: {
        options: string[];
        default?: string;
        map?: Record<string, string | null>;
      };
    }>;
  }>;
  presets: Array<{ id: string; label: string; selection: RuntimeSelection }>;
  defaults: RuntimeDefaultPolicy;
}
export async function fetchChatAgents(): Promise<
  { id: string; label: string; agentCmd?: string }[]
> {
  return handleResponse(await apiFetch(API_BASE_URL + '/api/chat-agents'));
}
export async function fetchRuntimeCatalog(): Promise<RuntimeCatalog> {
  return handleResponse(await apiFetch(API_BASE_URL + '/api/runtime-catalog'));
}
/** Harness ids the project's sandbox host has installed; null = no restriction. */
export async function fetchProjectHarnesses(
  projectId: string,
): Promise<{ harnessIds: string[] | null }> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/harnesses`,
    ),
  );
}

export interface AiUser {
  id: string;
  name: string;
  identity: string;
  presetId: string;
  prompt: string;
  promptPath: string;
  avatarPath: string | null;
  avatarUrl: string | null;
  avatarCandidateUrl: string | null;
  emotes: Array<{ name: string; url: string }>;
  voiceId: string | null;
  voiceLang: string | null;
  voiceStylePath: string | null;
  turn: 'before' | 'after';
  tools: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  status?: 'active' | 'paused';
}

export type MainAiUserSelection =
  | { mode: 'inherit' }
  | { mode: 'none' }
  | { mode: 'persona'; aiUserId: string };

export interface AiUserTeam {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
}

export async function fetchAiUsers(): Promise<AiUser[]> {
  return handleResponse(await apiFetch(`${API_BASE_URL}/api/admin/ai-users`));
}
export async function fetchAiUserTeams(): Promise<AiUserTeam[]> {
  return handleResponse(
    await apiFetch(`${API_BASE_URL}/api/admin/ai-user-teams`),
  );
}
export async function createAiUserTeam(data: {
  name: string;
  description: string;
  memberIds: string[];
}): Promise<AiUserTeam> {
  return handleResponse(
    await apiFetch(`${API_BASE_URL}/api/admin/ai-user-teams`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    }),
  );
}
export async function updateAiUserTeam(
  id: string,
  data: Partial<Pick<AiUserTeam, 'name' | 'description' | 'memberIds'>>,
): Promise<AiUserTeam> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/ai-user-teams/${encodeURIComponent(id)}`,
      { method: 'PATCH', headers, body: JSON.stringify(data) },
    ),
  );
}
export async function deleteAiUserTeam(id: string): Promise<void> {
  await handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/ai-user-teams/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  );
}
export async function draftAiUserPersona(data: {
  name: string;
  prompt: string;
  guidance?: string;
}): Promise<{
  prompt: string;
  identity: string;
  turn: 'before' | 'after';
  tools: string[];
}> {
  return handleResponse(
    await apiFetch(`${API_BASE_URL}/api/admin/ai-users/draft-persona`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    }),
  );
}
export async function draftAiUserAvatarPrompt(data: {
  persona: string;
  guidance?: string;
}): Promise<{ prompt: string }> {
  return handleResponse(
    await apiFetch(`${API_BASE_URL}/api/admin/ai-users/draft-avatar-prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    }),
  );
}
export async function createAiUser(data: {
  name: string;
  presetId: string;
  prompt: string;
  enabled?: boolean;
  voiceId?: string | null;
  voiceLang?: string | null;
}): Promise<AiUser> {
  return handleResponse(
    await apiFetch(`${API_BASE_URL}/api/admin/ai-users`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    }),
  );
}
export async function updateAiUser(
  id: string,
  data: Partial<
    Pick<
      AiUser,
      'name' | 'presetId' | 'prompt' | 'enabled' | 'voiceId' | 'voiceLang'
    >
  >,
): Promise<AiUser> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/ai-users/${encodeURIComponent(id)}`,
      { method: 'PATCH', headers, body: JSON.stringify(data) },
    ),
  );
}
export async function deleteAiUser(id: string): Promise<void> {
  await handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/ai-users/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  );
}
export async function uploadAiUserAvatar(
  id: string,
  dataUrl: string,
): Promise<AiUser> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/ai-users/${encodeURIComponent(id)}/avatar`,
      { method: 'POST', headers, body: JSON.stringify({ dataUrl }) },
    ),
  );
}
export interface AvatarGenerationState {
  status: 'idle' | 'running' | 'completed' | 'error';
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
export async function fetchAiUserAvatarGeneration(
  id: string,
): Promise<AvatarGenerationState> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/ai-users/${encodeURIComponent(id)}/avatar/generation`,
    ),
  );
}
export type AvatarGenerationMode = 'generate' | 'modify';
export async function generateAiUserAvatar(
  id: string,
  prompt: string,
  mode: AvatarGenerationMode = 'generate',
): Promise<AvatarGenerationState> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/ai-users/${encodeURIComponent(id)}/avatar/generate`,
      { method: 'POST', headers, body: JSON.stringify({ prompt, mode }) },
    ),
  );
}
export async function chooseAiUserAvatar(
  id: string,
  choice: 'current' | 'candidate',
): Promise<AiUser> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/ai-users/${encodeURIComponent(id)}/avatar/candidate`,
      { method: 'POST', headers, body: JSON.stringify({ choice }) },
    ),
  );
}
export async function fetchAiUserEmoteGeneration(
  id: string,
  name: string,
): Promise<AvatarGenerationState> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/ai-users/${encodeURIComponent(id)}/emotes/${encodeURIComponent(name)}/generation`,
    ),
  );
}
export async function generateAiUserEmote(
  id: string,
  name: string,
  prompt?: string,
): Promise<AvatarGenerationState> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/ai-users/${encodeURIComponent(id)}/emotes/generate`,
      { method: 'POST', headers, body: JSON.stringify({ name, prompt }) },
    ),
  );
}
export async function deleteAiUserEmote(
  id: string,
  name: string,
): Promise<void> {
  await handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/ai-users/${encodeURIComponent(id)}/emotes/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),
  );
}
export interface TtsVoiceCatalog {
  available: boolean;
  voices: Array<{ id: string; kind: 'builtin' | 'custom' }>;
  languages: string[];
  defaults: { voiceId: string; language: string };
}
export async function fetchTtsVoiceCatalog(): Promise<TtsVoiceCatalog> {
  return handleResponse(await apiFetch(`${API_BASE_URL}/api/admin/tts/voices`));
}
export async function importAiUserVoiceStyle(
  id: string,
  file: File,
): Promise<AiUser> {
  const body = new FormData();
  body.append('file', file);
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/admin/ai-users/${encodeURIComponent(id)}/voice-style`,
      { method: 'POST', body },
    ),
  );
}
function conversationAiUsersUrl(
  projectId: string,
  conversationId: string,
): string {
  return `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/ai-users`;
}
export async function fetchConversationAiUsers(
  projectId: string,
  conversationId: string,
): Promise<AiUser[]> {
  return handleResponse(
    await apiFetch(conversationAiUsersUrl(projectId, conversationId)),
  );
}
export async function fetchAvailableAiUsers(
  projectId: string,
  conversationId: string,
): Promise<AiUser[]> {
  return handleResponse(
    await apiFetch(
      `${conversationAiUsersUrl(projectId, conversationId)}/available`,
    ),
  );
}
export async function fetchProjectAvailableAiUsers(
  projectId: string,
): Promise<AiUser[]> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/ai-users/available`,
    ),
  );
}
export async function fetchProjectAvailableAiUserTeams(
  projectId: string,
): Promise<AiUserTeam[]> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/ai-user-teams/available`,
    ),
  );
}
export async function fetchMainConversationAiUser(
  projectId: string,
  conversationId: string,
): Promise<AiUser | null> {
  return handleResponse(
    await apiFetch(`${conversationAiUsersUrl(projectId, conversationId)}/main`),
  );
}
export async function fetchMainConversationAiUserSelection(
  projectId: string,
  conversationId: string,
): Promise<{
  selection: MainAiUserSelection;
  effectiveAiUserId: string | null;
}> {
  return handleResponse(
    await apiFetch(
      `${conversationAiUsersUrl(projectId, conversationId)}/main-selection`,
    ),
  );
}
export async function setMainConversationAiUserApi(
  projectId: string,
  conversationId: string,
  selection: MainAiUserSelection,
): Promise<void> {
  await handleResponse(
    await apiFetch(
      `${conversationAiUsersUrl(projectId, conversationId)}/main`,
      { method: 'PATCH', headers, body: JSON.stringify({ selection }) },
    ),
  );
}
export async function inviteConversationAiUserApi(
  projectId: string,
  conversationId: string,
  aiUserId: string,
): Promise<void> {
  await handleResponse(
    await apiFetch(conversationAiUsersUrl(projectId, conversationId), {
      method: 'POST',
      headers,
      body: JSON.stringify({ aiUserId }),
    }),
  );
}
export async function inviteConversationAiUserTeamApi(
  projectId: string,
  conversationId: string,
  teamId: string,
): Promise<{ invitedIds: string[]; skippedIds: string[] }> {
  return handleResponse(
    await apiFetch(
      `${conversationAiUsersUrl(projectId, conversationId)}/teams/${encodeURIComponent(teamId)}`,
      { method: 'POST', headers },
    ),
  );
}
export async function setConversationAiUserStatusApi(
  projectId: string,
  conversationId: string,
  aiUserId: string,
  status: 'active' | 'paused',
): Promise<void> {
  await handleResponse(
    await apiFetch(
      `${conversationAiUsersUrl(projectId, conversationId)}/${encodeURIComponent(aiUserId)}`,
      { method: 'PATCH', headers, body: JSON.stringify({ status }) },
    ),
  );
}
export async function setConversationPersonaLoopApi(
  projectId: string,
  conversationId: string,
  enabled: boolean,
): Promise<void> {
  await handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/persona-loop`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled }),
      },
    ),
  );
}
export async function startConversationPersonaRoundApi(
  projectId: string,
  conversationId: string,
  runtimeSelection?: RuntimeSelection,
): Promise<void> {
  await handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/persona-round`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ runtimeSelection }),
      },
    ),
  );
}
export async function removeConversationAiUserApi(
  projectId: string,
  conversationId: string,
  aiUserId: string,
): Promise<void> {
  await handleResponse(
    await apiFetch(
      `${conversationAiUsersUrl(projectId, conversationId)}/${encodeURIComponent(aiUserId)}`,
      { method: 'DELETE' },
    ),
  );
}

// --- Projects ---

function projectCacheScope(): string {
  const auth = useAuth.getState();
  return JSON.stringify([REMOTE_URL, auth.user?.id ?? 'anonymous']);
}

export function cachedProjects(): Project[] | undefined {
  return readProjectCache(projectCacheScope());
}

export async function fetchProjects({
  signal,
}: { signal?: AbortSignal } = {}): Promise<Project[]> {
  const scope = projectCacheScope();
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (projectCacheScope() !== scope)
      throw new Error('Project account changed');
  };
  const manifest: ProjectRevision[] = await handleResponse(
    await apiFetch(API_BASE_URL + '/api/projects?view=manifest', { signal }),
  );
  assertCurrent();
  const cached = new Map(
    (readProjectCache(scope) ?? []).map((project) => [project.id, project]),
  );
  const allowed = new Set(manifest.map(({ id }) => id));
  // Purge revoked/deleted entries even if downloading another project fails.
  const retained = [...cached.values()].filter(({ id }) => allowed.has(id));
  writeProjectCache(scope, retained);
  queryClient.setQueryData<Project[]>(queryKeys.projects.all, (projects) =>
    projects?.filter(({ id }) => allowed.has(id)),
  );
  const changed = manifest.filter(
    ({ id, revision }) => cached.get(id)?.revision !== revision,
  );
  // Bound URL length when a device has no cache or many projects changed.
  for (let offset = 0; offset < changed.length; offset += 20) {
    const ids = changed.slice(offset, offset + 20).map(({ id }) => id);
    const params = new URLSearchParams({
      view: 'summary',
      ids: JSON.stringify(ids),
    });
    const projects: Project[] = await handleResponse(
      await apiFetch(`${API_BASE_URL}/api/projects?${params}`, { signal }),
    );
    assertCurrent();
    // Access may have changed between the manifest and this request.
    for (const id of ids) cached.delete(id);
    for (const project of projects) cached.set(project.id, project);
  }
  assertCurrent();
  const projects = manifest.flatMap(({ id }) => {
    const project = cached.get(id);
    return project ? [project] : [];
  });
  writeProjectCache(scope, projects);
  return projects;
}

export async function fetchProjectDetails(
  projectId: string,
  signal?: AbortSignal,
): Promise<Project> {
  const params = new URLSearchParams({
    view: 'detail',
    ids: JSON.stringify([projectId]),
  });
  const projects: Project[] = await handleResponse(
    await apiFetch(`${API_BASE_URL}/api/projects?${params}`, { signal }),
  );
  if (!projects[0]) throw new Error('Project is no longer available');
  return projects[0];
}

/** Whether the server currently lets the caller record meetings in a project. */
export async function fetchMeetingAccess(
  projectId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result: { canRecord?: boolean } = await handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/meetings/access`,
      { signal },
    ),
  );
  return result.canRecord === true;
}

export async function createProject(data: {
  name: string;
  folder?: string;
  parentId?: string;
}): Promise<Project> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    }),
  );
}

export async function updateProjectSettings(
  project_id: string,
  payload: {
    settings?: Partial<ProjectSettings>;
    name?: string;
    folder?: string;
    parentId?: string | null;
    stageMigrations?: StageMigration[];
  },
): Promise<Project> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(payload),
    }),
  );
}

/** Drop a child project's own stages so it inherits its parent's; 409 while cards occupy stages the parent lacks. */
export async function inheritProjectStages(project_id: string): Promise<void> {
  await handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(project_id)}/inherit-stages`,
      { method: 'POST', headers },
    ),
  );
}

export async function fetchProjectStageOccupancy(
  project_id: string,
): Promise<StageOccupancy[]> {
  const result = (await handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(project_id)}/stage-occupancy`,
    ),
  )) as { occupancy?: StageOccupancy[] };
  return result.occupancy ?? [];
}

export async function discoverProjectRepositories(
  project_id: string,
  options: { maxDepth: number; exclusions: string[] },
): Promise<RepositoryDiscoveryReport> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/discover-repositories`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(options),
      },
    ),
  );
}

export async function pushDefaultBranch(
  project_id: string,
): Promise<{ ok: boolean; output: string; warning?: string }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/git/push`, {
      method: 'POST',
      headers,
    }),
  );
}

export async function getDefaultBranchSyncStatus(
  project_id: string,
): Promise<DefaultBranchSyncStatus> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/git/sync-status`,
    ),
  );
}

export async function fetchDefaultBranch(
  project_id: string,
): Promise<{ ok: boolean; output: string }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/git/fetch`, {
      method: 'POST',
      headers,
    }),
  );
}

export async function pullDefaultBranch(
  project_id: string,
): Promise<{ ok: boolean; output: string }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/git/pull`, {
      method: 'POST',
      headers,
    }),
  );
}

export async function regenerateProjectPrompt(
  project_id: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/regenerate-prompt`,
      { method: 'POST' },
    ),
  );
}

export async function updateProjectsOrder(
  orders: Record<string, number>,
): Promise<{ ok: boolean; skipped?: number }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/projects/order', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ orders }),
    }),
  );
}

export async function stopProject(
  project_id: string,
): Promise<{ ok: boolean; stopped: number }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/stop`, {
      method: 'POST',
    }),
  );
}

export async function deleteProject(
  project_id: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}`, {
      method: 'DELETE',
    }),
  );
}

export async function fetchProjectsStatusSummary(): Promise<ProjectsStatusSummary> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/projects/status-summary'),
  );
}

export async function acknowledgeKanbanCompletions(
  projectId: string,
  visibleCompletionEventIds: number[],
): Promise<{ acknowledgedEventId: number | null }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/preferences/kanban-acknowledgement`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ visibleCompletionEventIds }),
      },
    ),
  );
}

export type AttentionState =
  | 'running'
  | 'pending'
  | 'failed'
  | 'question'
  | 'unread'
  | 'completed';

/** Mirrors `AttentionItem` in src/types.ts. */
export interface AttentionItem {
  kind: 'conversation' | 'task';
  id: string;
  projectId: string;
  objectiveId?: string;
  title: string;
  state: AttentionState;
  at: string;
  completionEventId?: number;
  /** Conversations: false once the user opened the latest reply. */
  unread?: boolean;
}

export interface AttentionResponse {
  items: AttentionItem[];
  objectives: Array<{ id: string; title: string }>;
  /** Rows of a capped group (Replies, Completed) that were not returned. */
  hiddenCounts?: Partial<Record<'unread' | 'completed', number>>;
  /** Server time the list was built; `asOf` for dismissing a whole group. */
  generatedAt?: string;
}

export async function fetchAttention(): Promise<AttentionResponse> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/projects/attention'),
  );
}

/** Hide Now rows for the current user until they have newer activity. */
export async function dismissAttentionItems(
  items: ReadonlyArray<{ kind: AttentionItem['kind']; id: string }>,
): Promise<{ ok: true }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/projects/attention/dismiss', {
      method: 'POST',
      headers,
      body: JSON.stringify({ items }),
    }),
  );
}

/**
 * Check off a whole Now group for the current user, including rows beyond the
 * returned cap, as of the list's `generatedAt`. `exclude` keeps protected rows.
 */
export async function dismissAttentionGroup(
  group: 'needs-you' | 'unread' | 'completed',
  asOf: string,
  exclude: ReadonlyArray<{ kind: AttentionItem['kind']; id: string }>,
): Promise<{ ok: true; dismissed: number }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/projects/attention/dismiss-all', {
      method: 'POST',
      headers,
      body: JSON.stringify({ group, asOf, exclude }),
    }),
  );
}

// --- WhatsApp Groups ---

export async function fetchAvailableGroups(): Promise<AvailableGroup[]> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/groups', { headers }),
  );
}

export async function registerWhatsAppGroup(data: {
  jid: string;
  name: string;
  folder?: string;
  trigger?: string;
}): Promise<{ jid: string; name: string; folder: string }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/groups', {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    }),
  );
}

export async function linkProjectToWhatsApp(
  project_id: string,
  data: { whatsappJid: string; name: string; trigger: string },
): Promise<Project> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/link-whatsapp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    }),
  );
}

export async function unlinkWhatsAppGroup(
  jid: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/groups/${encodeURIComponent(jid)}`, {
      method: 'DELETE',
    }),
  );
}

// --- Tasks ---

export async function fetchTasks(
  project_id: string,
  filters?: { ownerUserId?: string; triggeredByUserId?: string },
): Promise<TaskSummary[]> {
  const params = new URLSearchParams();
  if (filters?.ownerUserId) params.set('ownerUserId', filters.ownerUserId);
  if (filters?.triggeredByUserId)
    params.set('triggeredByUserId', filters.triggeredByUserId);
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/tasks${params.size ? `?${params}` : ''}`,
    ),
  );
}

export async function fetchBoardReplay(
  project_id: string,
  from: string,
  to: string,
): Promise<BoardReplayData> {
  const params = new URLSearchParams({ from, to });
  const response = await apiFetch(
    API_BASE_URL +
      `/api/projects/${encodeURIComponent(project_id)}/board-replay?${params}`,
  );
  return handleResponse<BoardReplayData>(response);
}

export async function fetchTask(
  project_id: string,
  task_id: string,
): Promise<Task> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/tasks/${task_id}`,
    ),
  );
}

export interface ExternalIssueImport {
  projectId: string;
  provider: 'gitlab' | 'github';
  repository: string;
  issueNumber: number;
  taskId: string;
  issueUrl: string;
  importedAt: string;
}

export interface ExternalIssueSyncResult {
  externalIssue: ExternalIssueImport;
  task: Task;
  comments: TaskMessage[];
}

export async function fetchTaskExternalIssue(
  project_id: string,
  task_id: string,
): Promise<ExternalIssueImport | null> {
  const response = await apiFetch(
    API_BASE_URL +
      `/api/projects/${project_id}/tasks/${task_id}/external-issue`,
  );
  if (response.status === 404) return null;
  return handleResponse(response);
}

export async function syncTaskExternalIssue(
  project_id: string,
  task_id: string,
): Promise<ExternalIssueSyncResult> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/tasks/${task_id}/sync-external-issue`,
      { method: 'POST' },
    ),
  );
}

export async function createTask(
  project_id: string,
  data: {
    title: string;
    description?: string;
    runtimeSelection?: RuntimeSelection | null;
    runtimeSelectionStage?: string | null;
    priority?: number;
    depends_on_ids?: string[];
    skip_stages?: string[] | null;
    custom_values?: Record<string, string | number>;
    author?: string;
    objective_id?: string | null;
    /** Variants to run side by side (two or more); null for an ordinary task. */
    abVariants?: string[] | null;
    /** Stage alternative suffix the card runs on; null for the base stages. */
    stageVariant?: string | null;
  },
): Promise<Task> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    }),
  );
}

export async function fetchPlanArtifactText(
  project_id: string,
  artifactPath: string,
): Promise<string> {
  if (
    !artifactPath.startsWith('artifacts/plans/') ||
    !artifactPath.endsWith('.md')
  ) {
    throw new Error('Invalid plan artifact path');
  }
  const relativePath = artifactPath.slice('artifacts/'.length);
  const encodedPath = relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const response = await apiFetch(
    API_BASE_URL +
      `/artifacts/${encodeURIComponent(project_id)}/${encodedPath}`,
  );
  if (!response.ok)
    throw await apiErrorFromResponse(
      response,
      `Could not load plan (${response.status})`,
    );
  return response.text();
}

export async function updateTask(
  project_id: string,
  task_id: string,
  data: Partial<
    Pick<
      Task,
      | 'title'
      | 'description'
      | 'status'
      | 'priority'
      | 'depends_on_ids'
      | 'skip_stages'
      | 'archived'
      | 'custom_values'
      | 'objective_id'
      | 'abVariants'
      | 'stageVariant'
      | 'coStages'
    >
  > & {
    runtimeSelection?: RuntimeSelection | null;
    runtimeSelectionStage?: string | null;
  },
): Promise<Task> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/tasks/${task_id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(data),
      },
    ),
  );
}

/**
 * Merge one variant's branch and complete the A/B experiment parent. A rejected
 * pick (409 when a winner exists or the merge conflicts) throws an ApiError
 * carrying the server's message.
 */
export async function pickAbWinner(
  project_id: string,
  parent_task_id: string,
  winner_task_id: string,
): Promise<Task> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/tasks/${parent_task_id}/ab/winner`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ taskId: winner_task_id }),
      },
    ),
  );
}

export async function deleteTask(
  project_id: string,
  task_id: string,
): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL + `/api/projects/${project_id}/tasks/${task_id}`,
    {
      method: 'DELETE',
    },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

/** One prior refine turn from an AI description-draft session, oldest first. */
export interface TaskDescriptionDraftHistoryEntry {
  instruction: string;
  draft: string;
}

/**
 * One-shot LLM draft of a rewritten task description. Never writes to the
 * DB — the UI applies the draft through `updateTask`.
 *
 * `history` carries prior refine turns from the same panel session so the
 * backend edits the latest draft.
 */
export async function draftTaskDescription(
  project_id: string,
  task_id: string,
  instruction: string,
  history?: TaskDescriptionDraftHistoryEntry[],
): Promise<{ draft: string }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/tasks/${task_id}/description/draft`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ instruction, history }),
      },
    ),
  );
}

export interface ExecuteTaskResponse {
  message?: string;
  task_id?: string;
  /** Present on reset (Start over) responses. */
  unmet_dependency_ids?: string[];
}

export async function executeTask(
  project_id: string,
  task_id: string,
  prompt?: string,
  reset?: boolean,
  stage?: string,
  freshSession?: boolean,
): Promise<ExecuteTaskResponse> {
  const params = new URLSearchParams();
  if (reset) params.set('reset', 'true');
  if (stage) params.set('stage', stage);
  if (freshSession) params.set('freshSession', 'true');
  const qs = params.toString();
  const url = `/api/projects/${project_id}/tasks/${task_id}/execute${qs ? `?${qs}` : ''}`;
  const res = await apiFetch(API_BASE_URL + url, {
    method: 'POST',
    ...(prompt
      ? {
          headers,
          body: JSON.stringify({ prompt }),
        }
      : {}),
  });
  if (!res.ok) throw await apiErrorFromResponse(res);
  return (await res.json().catch(() => ({}))) as ExecuteTaskResponse;
}

export async function stopTask(
  project_id: string,
  task_id: string,
): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL + `/api/projects/${project_id}/tasks/${task_id}/stop`,
    {
      method: 'POST',
    },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

/**
 * Reset the stall watchdog on a live run, cancelling any pending grace-period
 * kill. Returns true if the run was still extendable; false if it already exited.
 */
export async function extendActiveRun(runId: string): Promise<boolean> {
  const res = await apiFetch(
    API_BASE_URL + `/api/active-runs/${encodeURIComponent(runId)}/extend`,
    {
      method: 'POST',
    },
  );
  if (res.status === 404) return false;
  if (!res.ok) throw await apiErrorFromResponse(res);
  return true;
}

/** Stop one background task the chat's agent is waiting on. */
export async function stopBackgroundTask(
  project_id: string,
  conversation_id: string,
  task_id: string,
): Promise<boolean> {
  const res = await apiFetch(
    API_BASE_URL +
      `/api/projects/${encodeURIComponent(project_id)}/conversations/${encodeURIComponent(conversation_id)}/background-tasks/${encodeURIComponent(task_id)}/stop`,
    { method: 'POST' },
  );
  return res.ok;
}

export async function stopTaskBackgroundTask(
  project_id: string,
  task_id: string,
  background_task_id: string,
): Promise<boolean> {
  const res = await apiFetch(
    API_BASE_URL +
      `/api/projects/${encodeURIComponent(project_id)}/tasks/${encodeURIComponent(task_id)}/background-tasks/${encodeURIComponent(background_task_id)}/stop`,
    { method: 'POST' },
  );
  return res.ok;
}

export async function getActiveRunLocation(runId: string): Promise<{
  runId: string;
  projectId: string;
  taskId: string | null;
  conversationId: string | null;
}> {
  const res = await apiFetch(
    API_BASE_URL + `/api/active-runs/${encodeURIComponent(runId)}/location`,
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
  return res.json();
}

export async function bulkUpdateTasks(
  project_id: string,
  ids: string[],
  data: { status?: string; archived?: boolean },
): Promise<{
  ok: boolean;
  mergeFailures?: Array<{
    task_id: string;
    error: string;
    blockers?: ConversationDiffFile[];
    approval?: HeldMergeApproval;
  }>;
}> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/tasks/bulk`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ ids, ...data }),
    }),
  );
}

export async function bulkExecuteTasks(
  project_id: string,
  ids: string[],
): Promise<{ startedCount: number }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/tasks/bulk-execute`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids }),
      },
    ),
  );
}

export async function bulkStopTasks(
  project_id: string,
  ids: string[],
): Promise<{ stoppedCount: number }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/tasks/bulk-stop`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids }),
      },
    ),
  );
}

export interface BulkStartOverResult {
  ok: boolean;
  reset: string[];
  skipped: Array<{ task_id: string; reason: string }>;
  failed: Array<{ task_id: string; error: string; conversationIds?: string[] }>;
}

export async function bulkStartOverTasks(
  project_id: string,
  ids: string[],
): Promise<BulkStartOverResult> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/tasks/bulk-start-over`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids }),
      },
    ),
  );
}

export async function forkTask(
  project_id: string,
  task_id: string,
  data: { messageId: string; prompt: string },
): Promise<Task> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/tasks/${task_id}/fork`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
      },
    ),
  );
}

/**
 * Move a task from its current project to another project owned by the caller.
 * Reference-only: the on-disk transcript stays in the source project; the
 * target sees an empty chat with a notice.
 */
export async function moveTaskToProject(
  project_id: string,
  task_id: string,
  target_project_id: string,
): Promise<Task> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/tasks/${task_id}/move`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ target_project_id }),
      },
    ),
  );
}

// --- Task messages ---

export interface TaskMessagesPage {
  messages: TaskMessage[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
}
export interface TaskOutputPage {
  content: string;
  entries: TaskOutputEntry[];
  total: number;
  offset: number;
  limit: number;
  runId: string | null;
  hasMore: boolean;
  nextOffset: number;
  nextCursor: number;
}

export interface TaskOutputEntry {
  id: string;
  content: string;
  startOffset: number;
  endOffset: number;
  runId: string | null;
  messageId?: string;
}

export async function fetchTaskOutput(
  project_id: string,
  task_id: string,
  limit = 32768,
  offset = 0,
  runId?: string,
  beforeOffset?: number,
): Promise<TaskOutputPage> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (beforeOffset !== undefined)
    params.set('beforeOffset', String(beforeOffset));
  if (runId) params.set('runId', runId);
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${project_id}/tasks/${task_id}/output?${params}`,
    ),
  );
}

export async function fetchTaskMessages(
  project_id: string,
  task_id: string,
  limit = 20,
  offset = 0,
  boundedContent = false,
): Promise<TaskMessagesPage> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (boundedContent) params.set('boundedContent', '1');
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${project_id}/tasks/${task_id}/messages?${params}`,
    ),
  );
}

export interface TaskMessageDelivery extends TaskMessage {
  /** Present only when the server observed a claimed/running task. */
  delivery?: 'steered' | 'queued';
  run_id?: string | null;
}

export async function sendTaskMessage(
  project_id: string,
  task_id: string,
  content: string,
): Promise<TaskMessageDelivery> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/tasks/${task_id}/messages`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ content, steer: true }),
      },
    ),
  );
}

export async function answerTaskCodexUserInput(
  project_id: string,
  task_id: string,
  requestId: string,
  answers: Record<string, { answers: string[] }>,
  content: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/tasks/${task_id}/messages/codex-answer`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ requestId, answers, content }),
      },
    ),
  );
}

export async function fetchTaskRuns(
  project_id: string,
  task_id: string,
): Promise<{
  runs: TaskRunLog[];
  latest_scored_review_run: TaskRunLog | null;
  total: number;
  stageDurations: TaskRunStageDuration[];
  persistent_comments: {
    stage_id: string;
    content: string;
    updated_at: string;
    run_id: string | null;
  }[];
}> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/tasks/${task_id}/runs`,
    ),
  );
}

export async function updateTaskStageComment(
  project_id: string,
  task_id: string,
  stage_id: string,
  content: string,
): Promise<
  | {
      stageId: string;
      content: string;
      updatedAt: string;
      runId: string | null;
    }
  | {
      ok: true;
      cleared: true;
    }
> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/tasks/${task_id}/stage-comments/${encodeURIComponent(stage_id)}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content }),
      },
    ),
  );
}

export interface TaskRecording {
  filename: string;
  /**
   * Absolute URL for a bare <video src>. It carries a short-lived ticket, so
   * it streams without auth headers (Android) and changes on every fetch.
   */
  url: string;
  size: number;
  mtime: string;
}

export async function fetchTaskRecordings(
  project_id: string,
  task_id: string,
): Promise<TaskRecording[]> {
  const { recordings } = await handleResponse<{ recordings: TaskRecording[] }>(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/tasks/${task_id}/recordings`,
    ),
  );
  // Backend returns app-relative URLs; make them absolute for the player.
  return recordings.map((r) => ({ ...r, url: API_BASE_URL + r.url }));
}

/**
 * `url` with a short-lived media ticket appended, so a bare <video>/<audio
 * src> can stream it without auth headers (Android). Null when the board
 * issues no ticket for this URL (not a ticketed file route, or no user
 * session).
 */
export async function withMediaTicket(url: string): Promise<string | null> {
  try {
    const { ticket } = await handleResponse<{ ticket: string }>(
      await apiFetch(API_BASE_URL + '/api/media-tickets', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url }),
      }),
    );
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}mediaTicket=${encodeURIComponent(ticket)}`;
  } catch (err) {
    console.warn('[media] Could not obtain a media ticket:', err);
    return null;
  }
}

export async function deleteTaskRecordings(
  project_id: string,
  task_id: string,
  filename?: string,
): Promise<{ ok: true; deletedCount: number; freedBytes: number }> {
  const suffix = filename ? `/${encodeURIComponent(filename)}` : '';
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/tasks/${task_id}/recordings${suffix}`,
      { method: 'DELETE' },
    ),
  );
}

// --- Chat ---

export interface TranscriptResponse {
  _source: 'transcript' | 'db';
  entries: TranscriptEntry[];
  total?: number;
  hasMore?: boolean;
  nextOffset?: number;
}

export interface PersonaTurnInspection {
  messageId: string;
  aiUserId: string;
  phase: 'before' | 'after';
  presetId: string;
  decision: string | null;
  status: 'queued' | 'running' | 'completed' | 'skipped' | 'failed';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  systemPrompt: string;
  prompt: string;
  history?: Array<{ role: string; content: string }>;
  transcript: string;
  systemPromptInjected?: boolean;
  handoff: Record<string, unknown>;
}

export async function fetchPersonaTurnInspection(
  projectId: string,
  conversationId: string,
  messageId: string,
): Promise<PersonaTurnInspection> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/persona-turns/${encodeURIComponent(messageId)}/inspection`,
      { cache: 'no-store' },
    ),
  );
}

export async function fetchChatTranscript(
  project_id: string,
  conversation_id: string,
  limit = 20,
  offset = 0,
): Promise<TranscriptResponse> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/conversations/${conversation_id}/transcript?limit=${limit}&offset=${offset}`,
      { cache: 'no-store' },
    ),
  );
}

export async function reconcileQueuedChatMessages(
  project_id: string,
  conversation_id: string,
): Promise<{
  active: boolean;
  pending: string[];
  consumed: string[];
  released: string[];
  withdrawn?: string[];
  queueOwners: Record<string, 'persona' | 'direct'>;
}> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(project_id)}/conversations/${encodeURIComponent(conversation_id)}/queued-messages/reconcile`,
      { method: 'POST', headers },
    ),
  );
}

export async function withdrawQueuedChatMessage(
  project_id: string,
  conversation_id: string,
  message_id: string,
): Promise<{ withdrawn: boolean; released: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(project_id)}/conversations/${encodeURIComponent(conversation_id)}/queued-messages/${encodeURIComponent(message_id)}`,
      { method: 'DELETE', headers },
    ),
  );
}

export async function sendChatMessage(
  project_id: string,
  content: string,
  conversation_id?: string,
  attachments?: ChatMessageAttachment[],
  agent_cmd?: string,
  chat_mode?: string | null,
  liveMode?: boolean,
  runtimeSelection?: RuntimeSelection,
  delivery?: 'steer' | 'queue',
  deepLinks?: ChatDeepLink[],
  memoryContext?: { level: MemoryContextLevel },
  liveModeSessionId?: string,
  liveModeKind?: 'personas' | 'work',
  clientSubmissionId?: string,
  clientSubmissionIds?: string[],
  /** Objective chats only: the objective a new conversation belongs to. */
  objective_id?: string,
  openFileContext?: import('@/types').OpenFileContext,
): Promise<{
  userMessage?: ChatMessage;
  assistantMessage?: ChatMessage;
  conversation_id: string;
  delivery?: 'pending' | 'steered' | 'queued' | 'followup';
  /** server means a durable Direct follow-up run owns the stable user message. */
  queueOwner?: 'browser' | 'persona' | 'direct' | 'server';
  queuedMessageId?: string;
  runId?: string;
  steeringBoundary?: {
    streamKey: string;
    contentOffset: number;
    targetMessageId?: string;
  };
  memoryCapsule?: string;
  /** The message was processed as non-live: its Live Mode run is off or owned by another session. */
  liveModeRejected?: boolean;
}> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content,
        conversation_id: conversation_id,
        attachments,
        agent_cmd,
        chat_mode,
        liveMode,
        liveModeSessionId,
        liveModeKind,
        runtimeSelection,
        delivery,
        deepLinks,
        memoryContext,
        source: getChatSource(),
        clientSubmissionId,
        clientSubmissionIds,
        openFileContext,
        objective_id,
      }),
    }),
  );
}

export async function stopChatAgent(
  project_id: string,
  conversation_id?: string,
): Promise<{ ok: boolean; stopped: boolean }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/messages/stop`, {
      method: 'POST',
      headers,
      body: conversation_id
        ? JSON.stringify({ conversation_id: conversation_id })
        : undefined,
    }),
  );
}

export interface PersonaLiveQueueSnapshot {
  protocolVersion: 2;
  conversationId: string;
  runId: string;
  epoch: number;
  mode: 'personas' | 'work';
  revision: number;
  status: 'active' | 'paused' | 'stopping' | 'off';
  serverNow: string;
  leaderSessionId: string | null;
  hiddenMessageIds: string[];
  /** Identity-only metadata for hidden speakers; response text is omitted. */
  hiddenItems: Array<{
    messageId: string;
    participantId: string;
    state: 'generating' | 'synthesizing' | 'ready';
    senderName: string;
    createdAt: string;
    emote: string | null;
    telemetry: Record<string, unknown> | null;
  }>;
  cancelledMessageIds: string[];
  completedMessageIds: string[];
  /** Canonical data for completed messages whose playback snapshots were missed. */
  completedItems: Array<{
    messageId: string;
    participantId: string;
    text: string;
    content: string;
    senderName: string;
    createdAt: string;
    emote: string | null;
    telemetry: Record<string, unknown> | null;
  }>;
  current: null | {
    id: string;
    sequence: number;
    participantId: string;
    messageId: string;
    state:
      | 'generating'
      | 'synthesizing'
      | 'ready'
      | 'released'
      | 'playing'
      | 'completed'
      | 'failed'
      | 'cancelled';
    durationMs: number | null;
    releasedAt: string | null;
    startedAt: string | null;
    endsAt: string | null;
    error: string | null;
    text: string;
    content: string;
    senderName: string;
    createdAt: string;
    emote: string | null;
    telemetry: Record<string, unknown> | null;
  };
}

export async function setPersonaLiveMode(
  projectId: string,
  conversationId: string,
  enabled: boolean,
  liveModeSessionId: string,
  liveModeKind: 'personas' | 'work' = 'personas',
): Promise<{
  ok: boolean;
  enabled: boolean;
  liveModeKind: 'personas' | 'work';
  liveModeSessionId: string | null;
  resumePlaybacks: Array<{ messageId: string; text: string }>;
  snapshot: PersonaLiveQueueSnapshot | null;
}> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/persona-live-mode`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          enabled,
          liveModeSessionId,
          liveModeKind,
          platform: Capacitor.isNativePlatform()
            ? Capacitor.getPlatform()
            : 'web',
          // The server skips Supertonic while this device speaks replies.
          deviceSpeech: await deviceTtsEnabled(),
        }),
      },
    ),
  );
}

export async function getPersonaLiveMode(
  projectId: string,
  conversationId: string,
  liveModeSessionId: string,
): Promise<{
  enabled: boolean;
  ownedBySession: boolean;
  liveModeKind: 'personas' | 'work' | null;
  liveModeSessionId: string | null;
  resumePlaybacks: Array<{ messageId: string; text: string }>;
  snapshot: PersonaLiveQueueSnapshot | null;
}> {
  const query = new URLSearchParams({
    liveModeSessionId,
    platform: Capacitor.isNativePlatform() ? Capacitor.getPlatform() : 'web',
  });
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/persona-live-mode?${query}`,
    ),
  );
}

export async function leavePersonaLiveMode(
  projectId: string,
  conversationId: string,
): Promise<void> {
  await handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/persona-live-mode/watcher`,
      { method: 'DELETE', headers },
    ),
  );
}

export async function startPersonaLiveQueueItem(
  projectId: string,
  conversationId: string,
  itemId: string,
  runId: string,
  liveModeSessionId: string,
): Promise<void> {
  await handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/persona-live-mode/items/${encodeURIComponent(itemId)}/started`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ runId, liveModeSessionId }),
      },
    ),
  );
}

export async function heartbeatPersonaLiveMode(
  projectId: string,
  conversationId: string,
  liveModeSessionId: string,
): Promise<void> {
  await handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/persona-live-mode/heartbeat`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          liveModeSessionId,
          platform: Capacitor.isNativePlatform()
            ? Capacitor.getPlatform()
            : 'web',
          deviceSpeech: await deviceTtsEnabled(),
        }),
      },
    ),
  );
}

export async function answerCodexUserInput(
  project_id: string,
  conversation_id: string,
  requestId: string,
  answers: Record<string, { answers: string[] }>,
  content: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/messages/codex-answer`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ conversation_id, requestId, answers, content }),
      },
    ),
  );
}

export async function uploadAttachment(
  project_id: string,
  file: File,
  conversation_id?: string,
): Promise<{
  containerPath: string;
  browserUrl: string;
  originalName: string;
  absolutePath: string;
}> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix (e.g. "data:application/pdf;base64,")
      resolve(result.split(',')[1] ?? result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/upload`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filename: file.name,
        data,
        conversation_id,
        mimetype: file.type,
      }),
    }),
  );
}

// --- Group artifacts (deletion; listing goes through the Files explorer) & diff ---

export async function deleteArtifact(
  project_id: string,
  relPath: string,
): Promise<{ ok: boolean }> {
  const encodedPath = relPath
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/artifacts/${encodedPath}`,
      { method: 'DELETE', headers },
    ),
  );
}

async function postGroupFileOp<T>(
  project_id: string,
  op: 'rename' | 'move' | 'delete',
  body: Record<string, string>,
): Promise<T> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/files/group/${op}`,
      { method: 'POST', headers, body: JSON.stringify(body) },
    ),
  );
}

/** Group-relative `path`; owners, editors and admins only (403 otherwise). */
export const renameGroupPath = (
  project_id: string,
  path: string,
  newName: string,
) =>
  postGroupFileOp<{ ok: boolean; path: string }>(project_id, 'rename', {
    path,
    newName,
  });

/** Both group-relative; `destination` is the target folder ('' = group root). */
export const moveGroupPath = (
  project_id: string,
  path: string,
  destination: string,
) =>
  postGroupFileOp<{ ok: boolean; path: string }>(project_id, 'move', {
    path,
    destination,
  });

export const deleteGroupPath = (project_id: string, path: string) =>
  postGroupFileOp<{ ok: boolean }>(project_id, 'delete', { path });

/** The caller's favorite files in the project, newest first. */
export async function fetchFileFavorites(
  project_id: string,
): Promise<FileFavorite[]> {
  const { favorites } = await handleResponse<{ favorites: FileFavorite[] }>(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/files/favorites`,
      { cache: 'no-store' },
    ),
  );
  return favorites;
}

async function sendFileFavorite(
  project_id: string,
  method: 'PUT' | 'DELETE',
  favorite: FileFavoriteRef,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/files/favorites`,
      { method, headers, body: JSON.stringify(favorite) },
    ),
  );
}

/** Idempotent; group files only (not folders). */
export const addFileFavorite = (
  project_id: string,
  favorite: FileFavoriteRef,
) => sendFileFavorite(project_id, 'PUT', favorite);

/** Idempotent. */
export const removeFileFavorite = (
  project_id: string,
  favorite: FileFavoriteRef,
) => sendFileFavorite(project_id, 'DELETE', favorite);

export async function getConversationDiff(
  project_id: string,
  conversation_id?: string | null,
): Promise<ConversationDiff> {
  const path = conversation_id
    ? `/api/projects/${project_id}/conversations/${conversation_id}/diff`
    : `/api/projects/${project_id}/diff`;
  return handleResponse(
    await apiFetch(API_BASE_URL + path, { cache: 'no-store' }),
  );
}

export async function updateConversationGitIndex(
  project_id: string,
  conversation_id: string | null | undefined,
  path: string | undefined,
  action: 'stage' | 'unstage' | 'stageAll',
  previousPath?: string,
): Promise<{ ok: boolean }> {
  const endpoint = conversation_id
    ? `/api/projects/${project_id}/conversations/${conversation_id}/git/index`
    : `/api/projects/${project_id}/git/index`;
  return handleResponse(
    await apiFetch(API_BASE_URL + endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path, action, previousPath }),
    }),
  );
}

export async function suggestConversationCommitMessage(
  project_id: string,
  conversation_id?: string | null,
  stagedOnly = false,
): Promise<{ message: string }> {
  const path = conversation_id
    ? `/api/projects/${project_id}/conversations/${conversation_id}/commit-message`
    : `/api/projects/${project_id}/commit-message`;
  return handleResponse(
    await apiFetch(
      API_BASE_URL + path + (stagedOnly ? '?stagedOnly=true' : ''),
      { cache: 'no-store' },
    ),
  );
}

export async function commitConversationChanges(
  project_id: string,
  conversation_id: string | null | undefined,
  message: string,
  stagedOnly = false,
): Promise<{ ok: boolean; output?: string }> {
  const path = conversation_id
    ? `/api/projects/${project_id}/conversations/${conversation_id}/commit`
    : `/api/projects/${project_id}/commit`;
  return handleResponse(
    await apiFetch(API_BASE_URL + path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, stagedOnly }),
    }),
  );
}

export async function mergeConversationWorktree(
  project_id: string,
  conversation_id: string,
  removeWorktree: boolean,
  message?: string,
): Promise<{
  ok: boolean;
  branch: string;
  base: string;
  worktreeRemoved: boolean;
  output?: string;
}> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/conversations/${conversation_id}/worktree/merge`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ removeWorktree, message }),
      },
    ),
  );
}

export async function updateConversationWorktreeFromDefault(
  project_id: string,
  conversation_id: string,
): Promise<{
  ok: boolean;
  branch: string;
  base: string;
  updated: boolean;
  output?: string;
}> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/conversations/${conversation_id}/worktree/update-from-default`,
      { method: 'POST', headers },
    ),
  );
}

export async function discardConversationWorktree(
  project_id: string,
  conversation_id: string,
): Promise<{ ok: boolean; branch: string; output?: string }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/conversations/${conversation_id}/worktree`,
      { method: 'DELETE', headers },
    ),
  );
}

export async function listGroupFiles(
  project_id: string,
  options: {
    path?: string;
    cursor?: string;
    limit?: number;
    search?: string;
    sort?: 'name' | 'modified';
    order?: 'asc' | 'desc';
  } = {},
): Promise<GroupFilesResponse> {
  const params = new URLSearchParams();
  if (options.sort) params.set('sort', options.sort);
  if (options.order) params.set('order', options.order);
  if (options.path) params.set('path', options.path);
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.search) params.set('search', options.search);
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/files/group?${params}`,
    ),
  );
}

export async function listRepoFiles(
  project_id: string,
  conversation_id?: string | null,
  options: {
    path?: string;
    cursor?: string;
    limit?: number;
    search?: string;
  } = {},
): Promise<RepoFilesResponse> {
  const path = conversation_id
    ? `/api/projects/${project_id}/conversations/${conversation_id}/files/repo`
    : `/api/projects/${project_id}/files/repo`;
  const params = new URLSearchParams();
  if (options.path) params.set('path', options.path);
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.search) params.set('search', options.search);
  return handleResponse(await apiFetch(API_BASE_URL + `${path}?${params}`));
}

export async function listMountFiles(
  project_id: string,
  slot: number,
  options: { path?: string; cursor?: string; search?: string } = {},
): Promise<RepoFilesResponse> {
  const params = new URLSearchParams();
  if (options.path) params.set('path', options.path);
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.search) params.set('search', options.search);
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/files/mount/${slot}?${params}`,
    ),
  );
}

export function mountFileContentUrl(
  project_id: string,
  slot: number,
  relPath: string,
): string {
  return (
    API_BASE_URL +
    `/api/projects/${project_id}/files/mount/${slot}/content?path=${encodeURIComponent(relPath)}`
  );
}

export async function readMountFileContent(
  project_id: string,
  slot: number,
  relPath: string,
  chunk?: { offset: number; length: number },
): Promise<RepoFileContentResponse | Response> {
  const params = chunk ? `&offset=${chunk.offset}&length=${chunk.length}` : '';
  const res = await apiFetch(
    mountFileContentUrl(project_id, slot, relPath) + params,
  );
  return parseFileContentResponse<RepoFileContentResponse>(res);
}

export async function listRootFiles(
  project_id: string,
  index: number,
  options: { path?: string; cursor?: string; search?: string } = {},
): Promise<RepoFilesResponse> {
  const params = new URLSearchParams();
  if (options.path) params.set('path', options.path);
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.search) params.set('search', options.search);
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/files/root/${index}?${params}`,
    ),
  );
}

export function rootFileContentUrl(
  project_id: string,
  index: number,
  relPath: string,
): string {
  return (
    API_BASE_URL +
    `/api/projects/${project_id}/files/root/${index}/content?path=${encodeURIComponent(relPath)}`
  );
}

export async function readRootFileContent(
  project_id: string,
  index: number,
  relPath: string,
  chunk?: { offset: number; length: number },
): Promise<RepoFileContentResponse | Response> {
  const params = chunk ? `&offset=${chunk.offset}&length=${chunk.length}` : '';
  const res = await apiFetch(
    rootFileContentUrl(project_id, index, relPath) + params,
  );
  return parseFileContentResponse<RepoFileContentResponse>(res);
}

/**
 * Text-mimetype variant of the group-file response — the JSON wrapper the
 * backend emits for text files so the JSON path in api.ts can decode them
 * via `handleResponse`. Binary files bypass this and stream raw bytes.
 *
 * When the request carries `?offset=&length=` (preview-pane chunked reads),
 * the envelope also includes `total` / `offset` / `length` describing the
 * window the server actually returned. Plain full-file calls omit those
 * fields.
 */
export interface GroupFileContentResponse {
  /** Group-folder-relative path that was read. */
  path: string;
  /** Detected mimetype (e.g. `text/plain`, `application/json`). */
  mimetype: string;
  /** UTF-8 decoded file body (full file or the requested window). */
  content: string;
  /** Always `'utf-8'` for the JSON variant. */
  encoding: 'utf-8';
  /** Total file size in bytes; only set on chunked reads. */
  total?: number;
  /** Byte offset the window starts at; only set on chunked reads. */
  offset?: number;
  /** Length of the returned window in bytes; only set on chunked reads. */
  length?: number;
}

/**
 * Text-mimetype variant of the repo-file response. Same shape as the group
 * counterpart; binary files are sent as raw bytes with `Content-Type` set
 * and won't deserialize through this shape.
 */
export interface RepoFileContentResponse {
  /** Repo-relative path that was read. */
  path: string;
  /** Detected mimetype (e.g. `text/plain`, `application/json`). */
  mimetype: string;
  /** UTF-8 decoded file body (full file or the requested window). */
  content: string;
  /** Always `'utf-8'` for the JSON variant. */
  encoding: 'utf-8';
  /** Total file size in bytes; only set on chunked reads. */
  total?: number;
  /** Byte offset the window starts at; only set on chunked reads. */
  offset?: number;
  /** Length of the returned window in bytes; only set on chunked reads. */
  length?: number;
}

/**
 * Read a single file from the group folder (`groups/<folder>/<path>`).
 *
 * Backend behavior:
 *   - Text-like mimetypes → JSON `{ path, mimetype, content, encoding }`,
 *     decoded here as `GroupFileContentResponse`.
 *   - Binary mimetypes (images, pdf, audio, video, octet-stream) → raw
 *     bytes with the matching `Content-Type` header; returned as the raw
 *     `Response` so callers can `.blob()` / pipe to `useSecureMedia`.
 *
 * `chunk` requests just a `[offset, offset+length)` byte window — used by
 * the preview pane's scroll-to-load behaviour for large text/log files.
 * Binary mimetypes always return the full body regardless of `chunk`
 * (the server returns 416 on chunked binary requests).
 *
 * Inspect `Content-Type` on the response to decide which branch you got,
 * or just hand the response to `useSecureMedia` for preview surfaces.
 */
export async function readGroupFileContent(
  project_id: string,
  relPath: string,
  chunk?: { offset: number; length: number },
): Promise<GroupFileContentResponse | Response> {
  const params = new URLSearchParams({ path: relPath });
  if (chunk) {
    params.set('offset', String(chunk.offset));
    params.set('length', String(chunk.length));
  }
  const res = await apiFetch(
    API_BASE_URL +
      `/api/projects/${project_id}/files/group/content?${params.toString()}`,
  );
  return parseFileContentResponse<GroupFileContentResponse>(res);
}

export class EditableFileConflictError extends Error {
  constructor(
    public currentRevision: string,
    public currentSize: number,
  ) {
    super('File changed since it was loaded');
  }
}

export async function loadEditableFile(
  projectId: string,
  source: import('@/types').EditableFileSource,
  path: string,
): Promise<import('@/types').EditableFileResponse> {
  const params = new URLSearchParams({ source, path });
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/files/editable-content?${params}`,
      { cache: 'no-store' },
    ),
  );
}

export async function saveEditableFile(
  projectId: string,
  input: {
    source: import('@/types').EditableFileSource;
    path: string;
    content: string;
    expectedRevision: string;
  },
): Promise<import('@/types').EditableFileSaveResponse> {
  const response = await apiFetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/files/editable-content`,
    { method: 'PUT', headers, cache: 'no-store', body: JSON.stringify(input) },
  );
  if (response.status === 409) {
    const body = await response.json();
    throw new EditableFileConflictError(body.currentRevision, body.currentSize);
  }
  return handleResponse(response);
}

/**
 * Read a single file from the project repo (tracked + untracked).
 *
 * Same dual-shape contract as `readGroupFileContent`: text-like mimetypes
 * decode to `RepoFileContentResponse`; binary mimetypes come back as the
 * raw `Response`. The path is repo-relative; the backend runs
 * `git show HEAD:<path>` for tracked files and `cat <path>` for untracked
 * (after confirming the file is actually present via `git ls-files --others`).
 *
 * `chunk` requests just a `[offset, offset+length)` byte window — used by
 * the preview pane's scroll-to-load behaviour for large text/log files.
 */
export async function readRepoFileContent(
  project_id: string,
  conversation_id: string | null | undefined,
  relPath: string,
  chunk?: { offset: number; length: number },
): Promise<RepoFileContentResponse | Response> {
  const params = new URLSearchParams({ path: relPath });
  if (chunk) {
    params.set('offset', String(chunk.offset));
    params.set('length', String(chunk.length));
  }
  const path = conversation_id
    ? `/api/projects/${project_id}/conversations/${conversation_id}/files/repo/content`
    : `/api/projects/${project_id}/files/repo/content`;
  const res = await apiFetch(API_BASE_URL + `${path}?${params.toString()}`);
  return parseFileContentResponse<RepoFileContentResponse>(res);
}

/**
 * Shape shared by the text-mimetype response variants. Used to keep the
 * generic `parseFileContentResponse` from being too loose — callers that
 * want a specific payload type (group vs. repo) still need to cast at the
 * call site.
 */
interface FileContentJsonEnvelope {
  path: string;
  mimetype: string;
  content: string;
  encoding: 'utf-8';
  /** Present when the server read a byte window; `total` is the file size. */
  offset?: number;
  length?: number;
  total?: number;
}

/**
 * Shared decoder for the dual-shape file-content endpoints. The backend
 * uses `Content-Type` to distinguish text (JSON wrapper) from binary (raw
 * bytes), so we do the same on the client: `application/json` → typed
 * response, anything else → the raw `Response` for the caller to handle
 * (e.g. `.blob()` for image previews).
 *
 * Errors use the same session handling and ApiError as other endpoints.
 *
 * Exported because the preview pane builds its own URLs (see
 * `preview-pane.tsx → resolveTabFetchUrl`) and only needs the response
 * decoder, not the high-level `readGroupFileContent` wrappers.
 */
export async function parseFileContentResponse<
  T extends FileContentJsonEnvelope = FileContentJsonEnvelope,
>(res: Response): Promise<T | Response> {
  if (!res.ok) throw await apiErrorFromResponse(res);
  const contentType = res.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/json')) {
    return res.json() as Promise<T>;
  }
  return res;
}

/**
 * Saves a file-content endpoint's file to disk. Text files arrive in a JSON
 * envelope, so the decoded content is saved, not the envelope; binary files are
 * saved as the raw bytes.
 */
export function saveBlobAsFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const DOWNLOAD_CHUNK_BYTES = 1024 * 1024;

export async function downloadFileContent(
  url: string,
  name: string,
): Promise<void> {
  const parsed = await parseFileContentResponse(await apiFetch(url));
  if (parsed instanceof Response) {
    saveBlobAsFile(await parsed.blob(), name);
    return;
  }
  // The server caps how much text one response carries; a larger file arrives
  // as its first window, so page through the rest before saving. Windows end
  // on UTF-8 boundaries, so the parts concatenate to the original text.
  const parts = [parsed.content];
  let next = (parsed.offset ?? 0) + (parsed.length ?? 0);
  while (typeof parsed.total === 'number' && next < parsed.total) {
    const separator = url.includes('?') ? '&' : '?';
    const chunk = await parseFileContentResponse(
      await apiFetch(
        `${url}${separator}offset=${next}&length=${DOWNLOAD_CHUNK_BYTES}`,
      ),
    );
    if (chunk instanceof Response || !chunk.length)
      throw new Error('Download interrupted');
    parts.push(chunk.content);
    next = (chunk.offset ?? next) + chunk.length;
  }
  saveBlobAsFile(new Blob(parts, { type: parsed.mimetype }), name);
}

export async function getTaskDefaultBranch(
  projectId: string,
  taskId: string,
): Promise<TaskDefaultBranchStatus> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${projectId}/tasks/${taskId}/default-branch`,
      { cache: 'no-store' },
    ),
  );
}

export async function mergeTaskDefaultBranch(
  projectId: string,
  taskId: string,
  expected: { sourceCommit: string; taskHead: string },
): Promise<TaskDefaultBranchMerge> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${projectId}/tasks/${taskId}/default-branch/merge`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(expected),
      },
    ),
  );
}

export async function getTaskDiff(
  project_id: string,
  task_id: string,
): Promise<ConversationDiff> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/tasks/${task_id}/diff`,
      {
        cache: 'no-store',
      },
    ),
  );
}

// --- Conversations ---

export async function fetchConversations(
  project_id: string,
  limit = 10,
  offset = 0,
  signal?: AbortSignal,
  filters?: {
    ownerUserId?: string;
    triggeredByUserId?: string;
    /** Lists this objective's chats instead of the project's. */
    objective_id?: string;
  },
): Promise<Conversation[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (filters?.ownerUserId) params.set('ownerUserId', filters.ownerUserId);
  if (filters?.triggeredByUserId)
    params.set('triggeredByUserId', filters.triggeredByUserId);
  if (filters?.objective_id) params.set('objective_id', filters.objective_id);
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/conversations?${params}`,
      { signal },
    ),
  );
}

export async function fetchConversation(
  project_id: string,
  conversation_id: string,
): Promise<Conversation> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(project_id)}/conversations/${encodeURIComponent(conversation_id)}`,
      { cache: 'no-store' },
    ),
  );
}

export async function importCodexThread(
  projectId: string,
  threadLink: string,
): Promise<{ conversation: Conversation; imported: boolean }> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/conversations/imports/codex`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ threadLink }),
      },
    ),
  );
}

export interface LiveActivity {
  folder: string;
  conversation_id: string;
  title: string | null;
  preview: string | null;
  state: string;
  status: string | null;
  speechVoice?: string;
  speechLang?: string;
  updated_at: string;
  completion_summary?: string | null;
}

export async function fetchLiveActivity(
  project_id: string,
): Promise<{ activities: LiveActivity[] }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/live-activity`, {
      cache: 'no-store',
    }),
  );
}

export async function createConversation(
  project_id: string,
  opts?: {
    use_worktree?: boolean;
    branch?: string | null;
    promptCache1h?: boolean;
    mainAiUserSelection?: MainAiUserSelection;
    invitedAiUserIds?: string[];
    continuousPersonaLoop?: boolean;
    liveMode?: boolean;
    liveModeSessionId?: string;
    liveModeKind?: 'personas' | 'work';
    taskContextId?: string;
    /** Creates an objective chat (no worktree) instead of a project chat. */
    objective_id?: string;
  },
): Promise<Conversation> {
  const body: {
    use_worktree?: boolean;
    branch?: string;
    promptCache1h?: boolean;
    mainAiUserSelection?: MainAiUserSelection;
    invitedAiUserIds?: string[];
    continuousPersonaLoop?: boolean;
    liveMode?: boolean;
    liveModeSessionId?: string;
    liveModeKind?: 'personas' | 'work';
    platform?: 'web' | 'android' | 'ios';
    taskContextId?: string;
    objective_id?: string;
  } = {};
  if (opts?.use_worktree) {
    body.use_worktree = true;
    if (opts.branch) body.branch = opts.branch;
  }
  if (opts?.promptCache1h) body.promptCache1h = true;
  if (opts?.mainAiUserSelection !== undefined)
    body.mainAiUserSelection = opts.mainAiUserSelection;
  if (opts?.invitedAiUserIds !== undefined)
    body.invitedAiUserIds = opts.invitedAiUserIds;
  if (opts?.continuousPersonaLoop !== undefined)
    body.continuousPersonaLoop = opts.continuousPersonaLoop;
  if (opts?.liveMode) {
    body.liveMode = true;
    body.liveModeSessionId = opts.liveModeSessionId;
    body.liveModeKind = opts.liveModeKind;
    body.platform = Capacitor.isNativePlatform()
      ? Capacitor.getPlatform() === 'ios'
        ? 'ios'
        : 'android'
      : 'web';
  }
  if (opts?.taskContextId) body.taskContextId = opts.taskContextId;
  if (opts?.objective_id) body.objective_id = opts.objective_id;
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/conversations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

export async function fetchProjectWorktrees(
  project_id: string,
): Promise<{ branch: string; path: string; merged?: boolean }[]> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/worktrees`),
  );
}

export async function markConversationRead(
  project_id: string,
  conversation_id: string,
): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL +
      `/api/projects/${project_id}/conversations/${conversation_id}/read`,
    { method: 'POST', headers },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

export async function resolvePendingConversation(
  project_id: string,
  conversation_id: string,
): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL +
      `/api/projects/${project_id}/conversations/${conversation_id}/resolve-pending`,
    { method: 'POST', headers },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

export type ProposalStatus =
  | 'pending'
  | 'applying'
  | 'applied'
  | 'denied'
  | 'failed'
  | 'stale';

export interface ProposalActionPreview {
  actionType:
    | 'write_item'
    | 'delete_item'
    | 'mark_local'
    | 'none'
    | 'merge_task'
    | 'set_prompt';
  /** Absolute path the action touches (rule file or skill folder). */
  targetPath: string;
  exists: boolean;
  replacesSymlink: boolean;
  symlinkTarget: string | null;
  /** The current entry links to a file the Board may not read. */
  contentHidden: boolean;
  files: Array<{
    path: string;
    change: 'added' | 'modified' | 'removed' | 'unchanged' | 'unknown';
    /** Lines prefixed "+", "-" or " "; "…" marks skipped unchanged lines. */
    diff: string;
  }>;
  problem: string | null;
  /** Platform/template layers: the repository commit Approve will make. */
  promotion?: {
    repository: string;
    branch: string;
    paths: string[];
    previousContentAvailable: boolean;
  };
}

export interface MergeApproval {
  taskId: string;
  /** Null once the task no longer exists. */
  taskTitle: string | null;
  headSha: string;
  findings: Array<{ ruleId: string; file: string; reason: string }>;
  /** Findings beyond those listed. */
  omitted: number;
}

export interface Proposal {
  id: string;
  projectId: string;
  objectiveId: string | null;
  conversationId: string;
  title: string;
  rationale: string;
  kind: 'skill' | 'rule' | 'prompt' | 'merge';
  name: string;
  targetLayer: string;
  status: ProposalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  result: string | null;
  createdAt: string;
  approve: ProposalActionPreview;
  /** Null when Deny only closes the proposal. */
  deny: ProposalActionPreview | null;
  targetChanged: boolean;
  supported: boolean;
  /** Set for kind `merge`. */
  merge?: MergeApproval;
  /** Set for kind `prompt`. */
  prompt?: {
    targetProject: string;
    promptType: 'system' | 'worker' | 'stage';
    stageId: string | null;
  };
}

export async function getProposal(
  project_id: string,
  proposal_id: string,
): Promise<Proposal> {
  const res = await apiFetch(
    API_BASE_URL +
      `/api/projects/${encodeURIComponent(project_id)}/proposals/${encodeURIComponent(proposal_id)}`,
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
  return (await res.json()).proposal;
}

export async function decideProposal(
  project_id: string,
  proposal_id: string,
  decision: 'approve' | 'deny',
): Promise<Proposal> {
  const res = await apiFetch(
    API_BASE_URL +
      `/api/projects/${encodeURIComponent(project_id)}/proposals/${encodeURIComponent(proposal_id)}/${decision}`,
    { method: 'POST', headers, body: JSON.stringify({}) },
  );
  if (!res.ok) {
    // A lost race still carries the authoritative, already-decided proposal.
    if (res.status === 409) {
      const body = await res
        .clone()
        .json()
        .catch(() => ({}));
      if (body?.proposal) return body.proposal;
    }
    throw await apiErrorFromResponse(res);
  }
  const body = await res.json().catch(() => ({ error: res.statusText }));
  return body.proposal;
}

export async function markAllConversationsRead(
  project_id: string,
  objective_id?: string,
): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL + `/api/projects/${project_id}/conversations/mark-all-read`,
    {
      method: 'POST',
      headers,
      body: objective_id ? JSON.stringify({ objective_id }) : undefined,
    },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

export async function deleteConversation(
  project_id: string,
  conversation_id: string,
): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL +
      `/api/projects/${project_id}/conversations/${conversation_id}`,
    { method: 'DELETE', headers },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

export async function updateConversation(
  project_id: string,
  conversation_id: string,
  fields: { title?: string | null; pinned?: boolean; promptCache1h?: boolean },
): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL +
      `/api/projects/${project_id}/conversations/${conversation_id}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify(fields),
    },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

export async function generateConversationTitle(
  project_id: string,
  conversation_id: string,
): Promise<{ title: string }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/conversations/${conversation_id}/generate-title`,
      { method: 'POST', headers },
    ),
  );
}

export async function forkConversation(
  project_id: string,
  conversation_id: string,
  messageId?: string,
  includeAssistantTurn?: boolean,
): Promise<{ id: string; conversation: Conversation }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/conversations/${conversation_id}/fork`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ messageId, includeAssistantTurn }),
      },
    ),
  );
}

/** Download the conversation as a zip of static HTML (read access required). */
export async function exportConversationHtml(
  project_id: string,
  conversation_id: string,
): Promise<{ blob: Blob; filename: string }> {
  const res = await apiFetch(
    API_BASE_URL +
      `/api/projects/${encodeURIComponent(project_id)}/conversations/${encodeURIComponent(conversation_id)}/export`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="?([^";]+)"?/i.exec(disposition)?.[1]?.trim();
  return {
    blob: await res.blob(),
    filename: name?.split(/[\\/]/).pop() || 'conversation.zip',
  };
}

export async function handoffConversation(
  project_id: string,
  conversation_id: string,
  destinationProjectId: string,
  runtimeSelection?: RuntimeSelection | null,
): Promise<{
  conversation: Conversation;
  destinationProjectId: string;
  sourceConversationId: string;
  handoffCreated: boolean;
}> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/conversations/${conversation_id}/handoff`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ destinationProjectId, runtimeSelection }),
      },
    ),
  );
}

// --- Cronjobs ---

export async function fetchCronjobs(
  project_id: string,
  archived?: boolean,
): Promise<Cronjob[]> {
  const url =
    archived !== undefined
      ? `/api/projects/${project_id}/cronjobs?archived=${archived}`
      : `/api/projects/${project_id}/cronjobs`;
  return handleResponse(await apiFetch(API_BASE_URL + url));
}

export async function createCronjob(
  project_id: string,
  data: {
    title: string;
    description?: string;
    cron_expression: string;
    queue_mode?: string;
    model?: string;
    agent_name?: string;
    runtimeSelection?: RuntimeSelection | null;
    runtimeSelectionStage?: string | null;
    objective_id?: string | null;
  },
): Promise<Cronjob> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/cronjobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    }),
  );
}

export async function updateCronjob(
  project_id: string,
  cronjob_id: string,
  data: Partial<
    Pick<
      Cronjob,
      | 'title'
      | 'description'
      | 'cron_expression'
      | 'queue_mode'
      | 'status'
      | 'archived'
      | 'objective_id'
    >
  > & {
    model?: string | null;
    agent_name?: string | null;
    runtimeSelection?: RuntimeSelection | null;
    runtimeSelectionStage?: string | null;
  },
): Promise<Cronjob> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/cronjobs/${cronjob_id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(data),
      },
    ),
  );
}

export async function runCronjob(
  project_id: string,
  cronjob_id: string,
): Promise<{ ok: boolean; task_id: string; task: Task }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/cronjobs/${cronjob_id}/run`,
      {
        method: 'POST',
      },
    ),
  );
}

export async function deleteCronjob(
  project_id: string,
  cronjob_id: string,
): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL + `/api/projects/${project_id}/cronjobs/${cronjob_id}`,
    {
      method: 'DELETE',
    },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

// --- Dataset Tasks ---

export async function fetchDatasetTasks(
  project_id: string,
  archived?: boolean,
): Promise<DatasetTask[]> {
  const url =
    archived !== undefined
      ? `/api/projects/${project_id}/dataset-tasks?archived=${archived}`
      : `/api/projects/${project_id}/dataset-tasks`;
  return handleResponse(await apiFetch(API_BASE_URL + url));
}

export async function createDatasetTask(
  project_id: string,
  data: {
    title: string;
    description?: string;
    dataset: Record<string, string | number>[];
    model?: string;
    agent_name?: string;
    runtimeSelection?: RuntimeSelection | null;
    runtimeSelectionStage?: string | null;
    objective_id?: string | null;
  },
): Promise<DatasetTask> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/dataset-tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    }),
  );
}

export async function updateDatasetTask(
  project_id: string,
  dataset_task_id: string,
  data: Partial<
    Pick<
      DatasetTask,
      | 'title'
      | 'description'
      | 'dataset'
      | 'status'
      | 'archived'
      | 'objective_id'
    >
  > & {
    model?: string | null;
    agent_name?: string | null;
    runtimeSelection?: RuntimeSelection | null;
    runtimeSelectionStage?: string | null;
  },
): Promise<DatasetTask> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/dataset-tasks/${dataset_task_id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(data),
      },
    ),
  );
}

export async function deleteDatasetTask(
  project_id: string,
  dataset_task_id: string,
): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL +
      `/api/projects/${project_id}/dataset-tasks/${dataset_task_id}`,
    {
      method: 'DELETE',
    },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

export async function runDatasetTask(
  project_id: string,
  dataset_task_id: string,
): Promise<{ ok: boolean; task_id?: string }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/dataset-tasks/${dataset_task_id}/run`,
      {
        method: 'POST',
      },
    ),
  );
}

export async function restartDatasetTask(
  project_id: string,
  dataset_task_id: string,
): Promise<{ ok: boolean; task_id?: string }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/dataset-tasks/${dataset_task_id}/restart`,
      {
        method: 'POST',
      },
    ),
  );
}

// --- Scheduled Tasks ---

export async function fetchScheduledTasks(
  project_id: string,
): Promise<ScheduledTask[]> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/scheduled-tasks`,
    ),
  );
}

export async function fetchScheduledTask(
  project_id: string,
  scheduled_task_id: string,
): Promise<ScheduledTask> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${project_id}/scheduled-tasks/${scheduled_task_id}`,
    ),
  );
}

export async function updateScheduledTask(
  project_id: string,
  scheduled_task_id: string,
  data: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'scheduleType'
      | 'scheduleValue'
      | 'contextMode'
      | 'status'
      | 'runtimeSelection'
    >
  > & { currentRunAction?: 'finish' | 'stop' },
): Promise<ScheduledTask> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/scheduled-tasks/${scheduled_task_id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(data),
      },
    ),
  );
}

export async function deleteScheduledTask(
  project_id: string,
  scheduled_task_id: string,
): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL +
      `/api/projects/${project_id}/scheduled-tasks/${scheduled_task_id}`,
    {
      method: 'DELETE',
    },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

export async function fetchScheduledTaskRuns(
  project_id: string,
  scheduled_task_id: string,
): Promise<ScheduledTaskRun[]> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${project_id}/scheduled-tasks/${scheduled_task_id}/runs`,
    ),
  );
}

export async function fetchScheduledTaskTranscript(
  project_id: string,
  scheduled_task_id: string,
  runId: string,
): Promise<ScheduledTaskTranscript> {
  return handleResponse(
    await apiFetch(
      `${API_BASE_URL}/api/projects/${project_id}/scheduled-tasks/${scheduled_task_id}/runs/${runId}/transcript`,
    ),
  );
}

// --- WhatsApp ---

export async function fetchWhatsAppStatus(): Promise<WhatsAppStatus> {
  return handleResponse(await apiFetch(API_BASE_URL + '/api/whatsapp/status'));
}

export async function logoutWhatsApp(): Promise<void> {
  await handleResponse(
    await apiFetch(API_BASE_URL + '/api/whatsapp/logout', { method: 'POST' }),
  );
}

// --- Sandbox ---

export async function fetchSandboxStatus(
  group?: string,
): Promise<Record<string, unknown>> {
  const params = group ? `?group=${encodeURIComponent(group)}` : '';
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/sandbox/status${params}`),
  );
}

export interface SandboxInstance {
  /** Reserved proxy endpoints; HTTP access is limited to approved clients. */
  ingress?: {
    service: string;
    targetPort: number;
    kind: 'http' | 'ssh';
    host: string;
    port: number;
  }[];
  ssh?: SandboxSshStatus;
  name: string;
  /** Instance id within its stack (the key sandbox_status restart events use). */
  instance?: string;
  /** Host-accessible reverse-proxy URL, when CarapaBox nginx integration is enabled. */
  url?: string;
  /** Primary and stack-configured additional reverse-proxy URLs. */
  urls?: string[];
  services: {
    service: string;
    hostname: string;
    status: string;
    ports?: string[];
    ip?: string;
  }[];
  worktrees?: { slug: string; port: number }[];
}

export interface SandboxSshStatus {
  supported: boolean;
  containerRunning: boolean;
  running: boolean;
  enabled?: boolean;
  pending?: boolean;
  service?: string;
  host?: string;
  port?: number;
  user?: string;
  command?: string;
  /** Connection uses the LAN ingress host and reserved port. */
  ingress?: boolean;
  /** Sandbox address for diagnostics; use host and port to connect. */
  internalHost?: string;
  error?: string;
}

export async function fetchSandboxSsh(
  stack: string,
  group: string,
): Promise<SandboxSshStatus> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/sandbox/${encodeURIComponent(stack)}/ssh?group=${encodeURIComponent(group)}`,
    ),
  );
}

export async function setSandboxSsh(
  stack: string,
  group: string,
  enabled: boolean,
): Promise<SandboxSshStatus> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/sandbox/${encodeURIComponent(stack)}/ssh`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ group, enabled }),
      },
    ),
  );
}

export async function fetchSandboxPs(
  instance?: string,
): Promise<SandboxInstance[]> {
  const params = instance ? `?instance=${encodeURIComponent(instance)}` : '';
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/sandbox/ps${params}`),
  );
}

export async function startSandbox(
  stack: string,
  group?: string,
): Promise<void> {
  const params = sandboxLifecycleParams(group);
  const res = await apiFetch(
    API_BASE_URL + `/api/sandbox/${stack}/start${params}`,
    { method: 'POST' },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

export async function stopSandbox(
  stack: string,
  group?: string,
): Promise<void> {
  const params = sandboxLifecycleParams(group);
  const res = await apiFetch(
    API_BASE_URL + `/api/sandbox/${stack}/stop${params}`,
    { method: 'POST' },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

export async function restartSandbox(
  stack: string,
  group?: string,
): Promise<void> {
  const params = sandboxLifecycleParams(group);
  const res = await apiFetch(
    API_BASE_URL + `/api/sandbox/${stack}/restart${params}`,
    { method: 'POST' },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

export type PendingSandboxRestart =
  | { pending: false }
  | {
      pending: true;
      requestedAt: string;
      waitingOn: {
        taskRuns: number;
        chatRuns: number;
        launches?: number;
        brainRuns: number;
        builds?: number;
        holds?: number;
      };
    };

async function sandboxRestartRequest(
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
) {
  const res = await apiFetch(API_BASE_URL + path, { method });
  if (!res.ok) throw await apiErrorFromResponse(res);
  return res.json();
}

/** Ask the board to restart the sandbox once nothing is running in it. */
export async function restartSandboxWhenIdle(
  stack: string,
  group?: string,
): Promise<void> {
  const params = sandboxLifecycleParams(group);
  const query = params ? `${params}&when=idle` : '?when=idle';
  await sandboxRestartRequest(`/api/sandbox/${stack}/restart${query}`, 'POST');
}

export async function cancelPendingRestart(
  stack: string,
  group?: string,
): Promise<{ ok: boolean; cancelled: boolean }> {
  const params = sandboxLifecycleParams(group);
  return sandboxRestartRequest(
    `/api/sandbox/${stack}/restart-pending${params}`,
    'DELETE',
  );
}

export async function getPendingRestart(
  stack: string,
  group?: string,
): Promise<PendingSandboxRestart> {
  const params = sandboxLifecycleParams(group);
  return sandboxRestartRequest(
    `/api/sandbox/${stack}/restart-pending${params}`,
    'GET',
  );
}

/**
 * Coordinates of an on-demand shell sandbox returned by `startProjectShell`.
 * The bash tab forwards `tmuxSession` to the
 * nested BashTab so the tab attaches to a unique tmux session inside the
 * project's shared container.
 */
export interface TaskShell {
  stack: string;
  service: string;
  instance: string;
  projectId?: string;
  reused?: boolean;
  /**
   * Per-tab tmux session name. Returned by `startProjectShell` when
   * the caller supplied a `tabId`; the bash tab forwards it to the nested
   * BashTab so the tab attaches to a unique tmux session inside the
   * project's shared container. Omitted for legacy single-shell
   * conversation calls.
   */
  tmuxSession?: string;
}

/**
 * Start an on-demand sandbox for a project. Shells are not attached to a
 * conversation, so they remain available when the user opens a new chat.
 *
 * `tabId` is an optional per-shell discriminator so a single conversation
 * can have multiple live shells, each one its own tab. The server folds
 * it into the CarapaBox instance name so the Docker containers don't
 * collide; callers that only ever need one shell per conversation can
 * safely omit it.
 *
 * IMPORTANT: use `API_BASE_URL` (same-origin, so the SameSite=Lax auth
 * cookie travels with the request) — NOT `VITE_API_URL`, which can point
 * at a different host on mobile. See the regression in
 * task-1781864573651-p0hf2o for the historical reason.
 */
export async function startProjectShell(
  projectId: string,
  tabId?: string,
): Promise<TaskShell> {
  const res = await apiFetch(
    API_BASE_URL + `/api/projects/${encodeURIComponent(projectId)}/shells`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(tabId ? { tabId } : {}),
    },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
  return (await res.json()) as TaskShell;
}

/**
 * Close one shell tab in a project. Idempotent — succeeds with
 * `stopped:false` when no matching record exists.
 */
export async function stopProjectShell(
  projectId: string,
  tabId: string,
): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL +
      `/api/projects/${encodeURIComponent(projectId)}/shells/${encodeURIComponent(tabId)}`,
    {
      method: 'DELETE',
    },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

/**
 * Public projection of an on-demand chat shell. Mirrors
 * `OnDemandSandboxRecord` from the backend (see
 * `src/lib/on-demand-sandboxes.ts`).
 *
 * `conversationId` is preserved on the record for telemetry, but the
 * server keys shells by the effective sandbox owner, so the same shells are
 * returned across conversations and to child projects inheriting a parent's
 * shared sandbox.
 */
export interface ShellListEntry {
  taskId?: string;
  conversationId?: string;
  /** Every list entry is an actual, rehydratable shell tab. */
  shellTabId: string;
  projectId: string;
  stack: string;
  service: string;
  instance: string;
  tmuxSession?: string;
  createdAt: number;
}

/**
 * Enumerate the on-demand chat shells alive for a project. The bash tab uses
 * this to rehydrate its tab strip without a conversation lookup.
 *
 * Throws on 404 (no such conversation) or 403 (no project access).
 * Returns `[]` when the project has no shells.
 */
export async function listProjectShells(
  projectId: string,
): Promise<ShellListEntry[]> {
  const { shells } = await handleResponse<{ shells: ShellListEntry[] }>(
    await apiFetch(
      API_BASE_URL + `/api/projects/${encodeURIComponent(projectId)}/shells`,
    ),
  );
  return shells;
}

export async function removeSandboxWorktree(
  stack: string,
  branch: string,
  group?: string,
): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL + `/api/sandbox/${stack}/worktree/remove`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ group, branch }),
    },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

export async function fetchGitNexusRepos(): Promise<
  { name: string; path: string }[]
> {
  return handleResponse(await apiFetch(API_BASE_URL + '/api/gitnexus/repos'));
}

/** Restart once no background job is in flight; `force` restarts immediately. */
export async function restartBoard(options?: {
  force?: boolean;
}): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL + '/api/restart' + (options?.force ? '?force=1' : ''),
    { method: 'POST' },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

/** Abort a pending restart and let background work resume. */
export async function cancelPendingBoardRestart(): Promise<void> {
  const res = await apiFetch(API_BASE_URL + '/api/restart', {
    method: 'DELETE',
  });
  if (!res.ok) throw await apiErrorFromResponse(res);
}

export type ServerWebBuildStatus = 'idle' | 'building' | 'ready' | 'failed';

export interface ServerWebBuildState {
  status: ServerWebBuildStatus;
  error?: string;
  /** Tail of the failed build output (only when status is 'failed'). */
  output?: string;
  backgroundPaused: boolean;
  restartPending: boolean;
  /** In-flight background jobs by label. */
  waitingOn: Record<string, number>;
}

export async function fetchServerWebBuildStatus(): Promise<ServerWebBuildState> {
  const res = await apiFetch(API_BASE_URL + '/api/admin/rebuild-board/status');
  if (!res.ok) throw await apiErrorFromResponse(res);
  return res.json();
}

export interface BackgroundBuildAccepted {
  ok: true;
  service?: string;
}

export async function rebuildBoard(): Promise<BackgroundBuildAccepted> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/admin/rebuild-board', {
      method: 'POST',
    }),
  );
}

// --- Slash Commands ---

export interface SlashCommand {
  name: string;
  description: string;
  type: 'skill' | 'command';
}

export async function fetchProjectCommands(
  project_id: string,
  reload?: boolean,
  includeDisabled?: boolean,
): Promise<SlashCommand[]> {
  const params = new URLSearchParams();
  if (reload) params.set('reload', '1');
  if (includeDisabled) params.set('includeDisabled', '1');
  const query = params.toString();
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/commands${query ? `?${query}` : ''}`,
    ),
  );
}

// --- Objectives ---

export async function fetchObjectives(
  project_id: string,
): Promise<Objective[]> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/objectives`),
  );
}

/** Objectives referenced by a project's cards, including a parent project's. */
export async function fetchReferencedObjectives(
  project_id: string,
): Promise<Array<{ id: string; title: string; status: ObjectiveStatus }>> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/objective-statuses`,
    ),
  );
}

export async function fetchObjective(
  project_id: string,
  objective_id: string,
): Promise<Objective> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/objectives/${objective_id}`,
    ),
  );
}

export async function fetchObjectiveDashboardTicket(
  project_id: string,
  objective_id: string,
): Promise<string> {
  const data = await handleResponse<{ pathToken: string }>(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/objectives/${objective_id}/dashboard-ticket`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      },
    ),
  );
  return data.pathToken;
}

export async function createObjective(
  project_id: string,
  data: {
    title: string;
    description?: string;
    status?: ObjectiveStatus;
    priority?: number;
    deadline?: string | null;
    progress?: number;
    metadata?: Record<string, unknown> | null;
    eventRuntimeSelection?: RuntimeSelection | null;
  },
): Promise<Objective> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/projects/${project_id}/objectives`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    }),
  );
}

export async function updateObjective(
  project_id: string,
  objective_id: string,
  data: Partial<{
    title: string;
    description: string;
    status: ObjectiveStatus;
    priority: number;
    deadline: string | null;
    progress: number;
    metadata: Record<string, unknown> | null;
    eventRuntimeSelection: RuntimeSelection | null;
    cost_limit_usd: number | null;
  }>,
): Promise<Objective> {
  const updated = await handleResponse<Objective>(
    await apiFetch(
      API_BASE_URL + `/api/projects/${project_id}/objectives/${objective_id}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify(data),
      },
    ),
  );
  if (data.status !== undefined && updated.status !== data.status) {
    if (
      data.status === 'active' &&
      updated.status === 'paused' &&
      updated.cost_limit_usd != null
    ) {
      throw new ApiError(
        "The objective's cost limit has been reached. Raise or remove the cost limit to resume it.",
        409,
      );
    }
    throw new ApiError(
      `The objective remained ${updated.status}; it was not changed to ${data.status}.`,
      409,
    );
  }
  return updated;
}

export async function deleteObjective(
  project_id: string,
  objective_id: string,
): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL + `/api/projects/${project_id}/objectives/${objective_id}`,
    { method: 'DELETE', headers },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

export type MemoryContextLevel = 'off' | 'minimal' | 'standard' | 'deep';

// --- Objective Explorer ---

export interface ObjectiveEvent {
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
  skipped?: boolean;
  skipReason?: string;
  runStatus: ObjectiveEventRunStatus;
  linkedRunId?: string;
  runRationale?: string;
  delivery?: ObjectiveEventDelivery;
}

export type ObjectiveEventRunStatus =
  | 'run'
  | 'skipped'
  | 'pending'
  | 'failed'
  | 'delivered'
  | 'unmatched'
  | 'unknown'
  | 'queued';

export interface ObjectiveEventDelivery {
  status: 'enqueued' | 'unmatched' | 'failed';
  targetObjectiveIds: string[];
}

export interface ObjectiveEventGroup {
  /** Server-assigned, unique per group and stable across refetches. */
  id: string;
  timestamp: string;
  events: ObjectiveEvent[];
  runStatus: ObjectiveEventRunStatus;
  linkedRunId?: string;
  runRationale?: string;
  delivery?: ObjectiveEventDelivery;
}

export interface ObjectiveRun {
  runId: string;
  timestamp: string | null;
  triggerType: string | null;
  duration_ms: number | null;
  costUsd: number | null;
  numTurns: number | null;
  numSteps: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model: string | null;
  exitCode: number | null;
  rationale: string | null;
  hasTranscript: boolean;
  hasReflection: boolean;
  llmSteps: ObjectiveLLMStep[];
  /** In progress: no run-stats yet; transcript comes from the live endpoint. */
  running?: boolean;
}

export interface ObjectiveLLMStep {
  stepId: string;
  parentRunId: string;
  kind: 'curator' | 'reflection';
  attempt: number;
  timestamp: string;
  durationMs: number;
  model: string;
  baseUrl: string;
  wireApi: 'chat_completions' | 'responses';
  reasoningEffort: string | null;
  status: 'completed' | 'failed';
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  output: string | null;
  error: string | null;
}

export async function fetchObjectiveEvents(
  pid: string,
  oid: string,
  params?: { limit?: number; offset?: number; type?: string; search?: string },
): Promise<{ groups: ObjectiveEventGroup[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.type) qs.set('type', params.type);
  if (params?.search) qs.set('search', params.search);
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${pid}/objectives/${oid}/events?${qs}`,
    ),
  );
}

export async function fetchObjectiveEventTypes(
  pid: string,
  oid: string,
): Promise<{ types: string[] }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${pid}/objectives/${oid}/events?typesOnly=true`,
    ),
  );
}

export async function fetchObjectiveRuns(
  pid: string,
  oid: string,
  params?: { limit?: number; offset?: number },
): Promise<{ runs: ObjectiveRun[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${pid}/objectives/${oid}/runs?${qs}`,
    ),
  );
}

export async function fetchFileContent(
  pid: string,
  oid: string,
  folder: string,
  filename: string,
): Promise<{ folder: string; filename: string; content: string }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${pid}/objectives/${oid}/files/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`,
    ),
  );
}

export async function fetchSessionTranscript(id: string): Promise<{
  id: string;
  source: string;
  prompt: string | null;
  entries: Array<{ role: string; content: string; created_at?: string }>;
}> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/session-transcripts/${encodeURIComponent(id)}`,
    ),
  );
}

export async function fetchLiveObjectiveRunTranscript(
  project_id: string,
  objective_id: string,
  runId: string,
): Promise<Awaited<ReturnType<typeof fetchSessionTranscript>>> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${project_id}/objectives/${objective_id}/runs/${encodeURIComponent(runId)}/live`,
    ),
  );
}

// --- Knowledge ---

export async function fetchKnowledgeVectorStatus(): Promise<KnowledgeVectorStatus> {
  return handleResponse(await apiFetch(API_BASE_URL + '/api/knowledge/status'));
}

export async function fetchKnowledgeBases(): Promise<KnowledgeBase[]> {
  return handleResponse(await apiFetch(API_BASE_URL + '/api/knowledge'));
}

export async function fetchSharedKnowledgeBases(
  group_folder: string,
): Promise<KnowledgeBase[]> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/knowledge/shared/${group_folder}`),
  );
}

export async function createKnowledgeBase(data: {
  name: string;
  description: string | null;
}): Promise<KnowledgeBase> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/knowledge', {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    }),
  );
}

export async function updateKnowledgeBase(
  id: string,
  data: { name?: string; description?: string | null },
): Promise<KnowledgeBase> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/knowledge/${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(data),
    }),
  );
}

export async function indexKnowledgeBase(
  id: string,
): Promise<{ status: string }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/knowledge/${id}/index`, {
      method: 'POST',
    }),
  );
}

export async function shareKnowledgeBase(
  id: string,
  group_folder: string,
): Promise<{ success: boolean }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/knowledge/${id}/share`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ group_folder }),
    }),
  );
}

export async function unshareKnowledgeBase(
  id: string,
  group_folder: string,
): Promise<{ success: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/knowledge/${id}/share/${group_folder}`,
      { method: 'DELETE' },
    ),
  );
}

export async function deleteKnowledgeBase(
  id: string,
): Promise<{ success: boolean }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/knowledge/${id}`, { method: 'DELETE' }),
  );
}

export async function fetchKnowledgeShares(id: string): Promise<string[]> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/knowledge/${id}/shares`),
  );
}

export interface KnowledgeFile {
  name: string;
  size: number;
  mtime: number;
  addedAt: string;
  publishedAt: string | null;
  title: string | null;
  description: string | null;
  sourceUrl: string | null;
  tags: string[];
  thumbnail?: { name: string; mtime: number };
}

export function knowledgeFileContentUrl(
  kbId: string,
  filename: string,
): string {
  return API_BASE_URL + knowledgeDocumentUrl(kbId, filename, 'content');
}

export function knowledgeThumbnailUrl(
  kbId: string,
  file: KnowledgeFile,
): string {
  return `${API_BASE_URL}${knowledgeDocumentUrl(kbId, file.name, 'thumbnail')}&v=${file.thumbnail?.mtime ?? 0}`;
}

export interface KnowledgeTag {
  name: string;
  count: number;
}

export async function fetchKnowledgeTags(id: string): Promise<KnowledgeTag[]> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/knowledge/${id}/tags`),
  );
}

export async function fetchKnowledgeSearch(
  id: string,
  query: string,
  tags: string[] = [],
  verify = true,
): Promise<KnowledgeChunk[]> {
  const params = new URLSearchParams({
    query,
    limit: '10',
    verify: String(verify),
  });
  for (const tag of tags) params.append('tags', tag);
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/knowledge/${encodeURIComponent(id)}/search?${params.toString()}`,
    ),
  );
}

export async function updateKnowledgeFileTags(
  id: string,
  filename: string,
  tags: string[],
): Promise<{ tags: string[] }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/knowledge/${id}/files/metadata`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ filename, tags }),
    }),
  );
}

export async function fetchKnowledgeFiles(
  id: string,
): Promise<KnowledgeFile[]> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/knowledge/${id}/files`),
  );
}

export async function uploadKnowledgeFile(
  id: string,
  name: string,
  contentBase64: string,
  tags?: string[],
): Promise<{ success: boolean; path: string }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/knowledge/${id}/files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, content: contentBase64, tags }),
    }),
  );
}

export async function saveMessageToKnowledge(
  id: string,
  content: string,
  group_folder: string,
): Promise<{ success: boolean; path: string }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/knowledge/${id}/save-message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content, group_folder }),
    }),
  );
}

export async function deleteKnowledgeFile(
  id: string,
  filename: string,
): Promise<{ success: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/knowledge/${id}/files?${new URLSearchParams({ filename })}`,
      { method: 'DELETE' },
    ),
  );
}

// --- Users & Admin ---

export async function fetchUsers(): Promise<any[]> {
  return handleResponse(await apiFetch(API_BASE_URL + '/api/users'));
}

export async function createUserAccount(data: {
  username: string;
  password?: string;
  role?: string;
}): Promise<any> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/users', {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    }),
  );
}

export async function updateUserAccount(
  id: string,
  data: { role?: 'admin' | 'user'; password?: string; disabled?: boolean },
): Promise<any> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(data),
    }),
  );
}

export async function deleteUserAccount(id: string): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  );
}

// --- Sharing ---

export interface UserSummary {
  id: string;
  username: string;
}

export type ShareAccessLevel = 'owner' | 'editor' | 'viewer';

export interface ShareMember {
  user_id: string;
  username: string;
  access_level: ShareAccessLevel;
}

export async function searchUsers(
  q: string,
  limit = 10,
): Promise<UserSummary[]> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('limit', String(limit));
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/users/search?${params}`),
  );
}

export async function listProjectMembers(
  projectId: string,
): Promise<ShareMember[]> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${encodeURIComponent(projectId)}/members`,
    ),
  );
}

/**
 * Members for attribution filters. Only admins and the project owner may list
 * members; for everyone else the 403 means "no list", not an error.
 */
export async function listProjectMembersForAttribution(
  projectId: string,
): Promise<ShareMember[]> {
  try {
    return await listProjectMembers(projectId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return [];
    throw error;
  }
}

export async function addProjectMember(
  projectId: string,
  userId: string,
  accessLevel: ShareAccessLevel,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${encodeURIComponent(projectId)}/members`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ user_id: userId, access_level: accessLevel }),
      },
    ),
  );
}

export async function removeProjectMember(
  projectId: string,
  userId: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    ),
  );
}

export async function listKbMembers(kbId: string): Promise<ShareMember[]> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/knowledge-bases/${encodeURIComponent(kbId)}/members`,
    ),
  );
}

export async function addKbMember(
  kbId: string,
  userId: string,
  accessLevel: ShareAccessLevel,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/knowledge-bases/${encodeURIComponent(kbId)}/members`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ user_id: userId, access_level: accessLevel }),
      },
    ),
  );
}

export async function removeKbMember(
  kbId: string,
  userId: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/knowledge-bases/${encodeURIComponent(kbId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    ),
  );
}

export async function listConversationMembers(
  projectId: string,
  conversationId: string,
): Promise<ShareMember[]> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/members`,
    ),
  );
}

export async function addConversationMember(
  projectId: string,
  conversationId: string,
  userId: string,
  accessLevel: ShareAccessLevel,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/members`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ user_id: userId, access_level: accessLevel }),
      },
    ),
  );
}

export async function removeConversationMember(
  projectId: string,
  conversationId: string,
  userId: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    ),
  );
}

export async function getConversationPublicShare(
  projectId: string,
  conversationId: string,
): Promise<ConversationPublicShare> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/public-share`,
    ),
  );
}

export async function enableConversationPublicShare(
  projectId: string,
  conversationId: string,
): Promise<ConversationPublicShare> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/public-share`,
      { method: 'PUT', headers },
    ),
  );
}

export async function regenerateConversationPublicShare(
  projectId: string,
  conversationId: string,
): Promise<ConversationPublicShare> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/public-share/regenerate`,
      { method: 'POST', headers },
    ),
  );
}

export async function revokeConversationPublicShare(
  projectId: string,
  conversationId: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/public-share`,
      { method: 'DELETE' },
    ),
  );
}

export async function setConversationPublicVisitorPrompts(
  projectId: string,
  conversationId: string,
  enabled: boolean,
): Promise<ConversationPublicShare> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/public-share/visitor-prompts`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled }),
      },
    ),
  );
}

// --- Preferences (cascade: user-level + per-(user, project)) ---

export async function fetchAccountPreferences(): Promise<AccountPreferences> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/account/preferences'),
  );
}

export async function updateAccountPreferences(
  content: string | null | undefined,
  dictationLanguage?: string | null,
  displayName?: string | null,
): Promise<AccountPreferences> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/account/preferences', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        content,
        ...(dictationLanguage !== undefined ? { dictationLanguage } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
      }),
    }),
  );
}

export async function uploadAccountAvatar(
  dataUrl: string,
): Promise<AccountProfile> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/account/avatar', {
      method: 'POST',
      headers,
      body: JSON.stringify({ dataUrl }),
    }),
  );
}

export async function fetchAccountAvatarGeneration(): Promise<AvatarGenerationState> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/account/avatar/generation'),
  );
}

export async function generateAccountAvatar(
  prompt: string,
  mode: AvatarGenerationMode = 'generate',
): Promise<AvatarGenerationState> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/account/avatar/generate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt, mode }),
    }),
  );
}

export async function chooseAccountAvatar(
  choice: 'current' | 'candidate',
): Promise<AccountProfile> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/account/avatar/candidate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ choice }),
    }),
  );
}

export async function fetchProjectPreferences(
  projectId: string,
): Promise<{ content: string | null }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/preferences`,
    ),
  );
}

export async function updateProjectPreferences(
  projectId: string,
  content: string | null,
): Promise<{ content: string | null }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/preferences`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content }),
      },
    ),
  );
}

export async function fetchProjectPushPref(
  projectId: string,
): Promise<{ enabled: boolean | null; effective: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/preferences/push`,
    ),
  );
}

export async function updateProjectPushPref(
  projectId: string,
  enabled: boolean | null,
): Promise<{ enabled: boolean | null; effective: boolean }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/preferences/push`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ enabled }),
      },
    ),
  );
}

export async function updateProjectModePref(
  projectId: string,
  mode: 'kanban' | 'chat' | 'objectives' | null,
): Promise<{ mode: 'kanban' | 'chat' | 'objectives' | null }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${encodeURIComponent(projectId)}/preferences/mode`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ mode }),
      },
    ),
  );
}

// --- Unread notifications ---

export interface UnreadNotification {
  id: string;
  kind: 'text' | 'json_form' | 'html_form';
  summary: string;
  action_url?: string | null;
  created_at: string;
}

export async function fetchUnreadNotifications(): Promise<{
  items: UnreadNotification[];
  count: number;
}> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/notifications/unread'),
  );
}

export interface AcknowledgedNotification {
  id: string;
  kind: UnreadNotification['kind'];
}

/** Ack all unread notifications, or only those in `ids` when given. */
export async function acknowledgeUnreadNotifications(
  ids?: readonly string[],
): Promise<{
  ok: true;
  payloads: AcknowledgedNotification[];
}> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/notifications/unread/ack', {
      method: 'POST',
      headers,
      ...(ids ? { body: JSON.stringify({ ids }) } : {}),
    }),
  );
}

// --- Security ---

/**
 * Fire-and-forget duress alert. The server writes a marked chat message
 * to the user's main agent group; the agent decides what to do based on
 * its own per-user instructions. We swallow errors and return: the call
 * site is in a security-critical path where ANY observable failure mode
 * (delay, error UI, retry behaviour) could tip off a coercer that the
 * "PIN" they just observed was a duress code.
 */
export async function sendDuressSignal(hint?: string): Promise<void> {
  try {
    await apiFetch(API_BASE_URL + '/api/security/duress', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        hint: hint ?? null,
      }),
    });
  } catch {
    /* deliberately swallow — duress must look like a real network blip */
  }
}

/**
 * Read the per-user duress instructions the main agent follows when a duress
 * signal fires. Stored server-side only. Re-auth (app PIN / biometric) must
 * be performed by the caller before invoking this.
 */
export async function getDuressInstructions(): Promise<DuressInstructionsResponse> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/security/duress-instructions'),
  );
}

/**
 * Save (or clear, when empty) the per-user duress instructions. Re-auth (app
 * PIN / biometric) must be performed by the caller before invoking this.
 */
export async function setDuressInstructions(
  instructions: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/security/duress-instructions', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ instructions }),
    }),
  );
}

// --- Devices ---

export interface DeviceEntry {
  kind: 'interactive' | 'integration';
  scopes: string[];
  expiresAt: string | null;
  deviceId: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string;
  isActive: boolean;
  isApproved: boolean;
  isCurrent: boolean;
}

export async function fetchUserDevices(): Promise<{
  devices: DeviceEntry[];
  currentDeviceId: string | null;
}> {
  return handleResponse(await apiFetch(API_BASE_URL + '/api/account/devices'));
}

export async function fetchAndroidPairingInfo(): Promise<{
  otaPublicKey: string | null;
}> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/android/pairing-info'),
  );
}

/** The certificate the board sees at an https address (null when unreachable). */
export async function fetchPresentedCertificate(url: string): Promise<{
  certSha256: string | null;
  trusted: boolean;
}> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        '/api/android/presented-cert?url=' +
        encodeURIComponent(url),
    ),
  );
}

export async function updateDeviceStatus(
  deviceId: string,
  isActive: boolean,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/account/devices/${deviceId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ isActive }),
    }),
  );
}

export async function updateDeviceLabel(
  deviceId: string,
  label: string | null,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/account/devices/${deviceId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ label }),
    }),
  );
}

export async function removeDevice(
  deviceId: string,
  opts?: { confirm?: boolean },
): Promise<{ ok: boolean; signedOut?: boolean }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/account/devices/${deviceId}`, {
      method: 'DELETE',
      headers,
      body: opts?.confirm ? JSON.stringify({ confirm: true }) : undefined,
    }),
  );
}

// --- MCP OAuth (remote MCP client consent + connected clients) ---

export type OAuthAccess = 'read' | 'write';

export interface OAuthGrantTarget {
  kind: 'main' | 'project';
  folder: string;
}

/** One project a grant covers, with its own access level. */
export interface OAuthGrantEntry extends OAuthGrantTarget {
  access: OAuthAccess;
}

/** A project the user may put in a grant. */
export interface OAuthConsentTarget extends OAuthGrantTarget {
  name: string;
  /** Parent project folder, for rendering the project tree. */
  parentId?: string;
  isParent: boolean;
  order?: number;
  /** False when the user only has viewer access (write is not offered). */
  canWrite: boolean;
}

export interface OAuthConsentRequest {
  id: string;
  client: { id: string; name: string };
  redirectHost: string;
  resource: string;
  expiresAt: string;
  choices: {
    targets: OAuthConsentTarget[];
    access: OAuthAccess[];
    days: number[];
  };
}

export interface OAuthDecisionInput {
  decision: 'approve' | 'deny';
  targets?: Array<{
    kind: 'main' | 'project';
    folder?: string;
    access: OAuthAccess;
  }>;
  days?: number;
}

export interface OAuthGrant {
  id: string;
  clientId: string;
  clientName: string;
  resource: string;
  targets: Array<OAuthGrantEntry & { name: string }>;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export interface OAuthGrantChoices {
  targets: OAuthConsentTarget[];
  days: number[];
}

export interface OAuthGrantUpdateInput {
  targets: Array<{
    kind: 'main' | 'project';
    folder?: string;
    access: OAuthAccess;
  }>;
  /** New expiry in days from now; omitted keeps the current expiry. */
  days?: number;
}

export async function fetchOAuthConsentRequest(
  requestId: string,
): Promise<OAuthConsentRequest> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/oauth/requests/${encodeURIComponent(requestId)}`,
    ),
  );
}

/**
 * Approving or editing a grant requires a fresh device signature; `apiFetch`
 * signs every request with the current timestamp. `handleResponse` keeps a
 * rejected signature (401) from signing the user out.
 */
async function signedOAuthRequest<T>(
  url: string,
  init: RequestInit,
): Promise<T> {
  return handleResponse(await apiFetch(url, init));
}

export async function submitOAuthDecision(
  requestId: string,
  input: OAuthDecisionInput,
): Promise<{ redirectUrl: string }> {
  return signedOAuthRequest(
    API_BASE_URL +
      `/api/oauth/requests/${encodeURIComponent(requestId)}/decision`,
    { method: 'POST', headers, body: JSON.stringify(input) },
  );
}

export async function fetchOAuthGrantChoices(): Promise<OAuthGrantChoices> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/oauth/grant-choices'),
  );
}

export async function updateOAuthGrant(
  grantId: string,
  input: OAuthGrantUpdateInput,
): Promise<{ ok: true; expiresAt: string }> {
  return signedOAuthRequest(
    API_BASE_URL + `/api/oauth/grants/${encodeURIComponent(grantId)}`,
    { method: 'PATCH', headers, body: JSON.stringify(input) },
  );
}

export async function fetchOAuthGrants(): Promise<OAuthGrant[]> {
  return handleResponse(await apiFetch(API_BASE_URL + '/api/oauth/grants'));
}

export async function revokeOAuthGrant(grantId: string): Promise<{ ok: true }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/oauth/grants/${encodeURIComponent(grantId)}`,
      { method: 'DELETE' },
    ),
  );
}

// --- Admin device management (cross-user) ---

export interface AdminDeviceEntry extends DeviceEntry {
  userId: string;
  username: string | null;
}

export async function fetchAllDevices(): Promise<{
  devices: AdminDeviceEntry[];
}> {
  return handleResponse(await apiFetch(API_BASE_URL + '/api/admin/devices'));
}

export async function approveDevice(
  deviceId: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/admin/devices/${deviceId}/approve`, {
      method: 'POST',
      headers,
    }),
  );
}

export async function adminRemoveDevice(
  deviceId: string,
): Promise<{ ok: boolean }> {
  return handleResponse(
    await apiFetch(API_BASE_URL + `/api/admin/devices/${deviceId}`, {
      method: 'DELETE',
      headers,
    }),
  );
}

// --- Meeting Recordings ---

export async function startMeetingRecording(
  projectId: string,
  conversationId: string,
  opts?: { language?: string },
): Promise<{ recording_id: string }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/projects/${projectId}/meetings/record`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          conversation_id: conversationId,
          language: opts?.language,
        }),
      },
    ),
  );
}

function audioExtFromMime(mime: string): string {
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('mpeg')) return 'mp3';
  return 'webm';
}

export async function sendRecordingChunk(
  recordingId: string,
  projectId: string,
  audioBlob: Blob,
  mimeType?: string,
): Promise<{ ok: boolean }> {
  const effectiveMime = mimeType || audioBlob.type || 'audio/webm';
  const ext = audioExtFromMime(effectiveMime);
  const formData = new FormData();
  formData.append('audio', audioBlob, `chunk.${ext}`);
  formData.append('mime_type', effectiveMime);
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${projectId}/meetings/record/${recordingId}/chunk`,
      {
        method: 'POST',
        headers: {}, // no Content-Type — browser sets multipart boundary
        body: formData,
      },
    ),
  );
}

export async function stopMeetingRecording(
  recordingId: string,
  projectId: string,
  opts?: {
    prior_transcript?: string;
  },
): Promise<{
  transcript: string;
  /** The saved recording of this segment. */
  audio_url?: string;
  audio_rel_path?: string;
  artifact_url?: string;
  artifact_rel_path?: string;
  artifact_filename?: string;
  /** Set when the transcript text exists but its file could not be saved. */
  artifact_error?: string;
}> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/projects/${projectId}/meetings/record/${recordingId}/stop`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(opts ?? {}),
      },
    ),
  );
}

export async function cancelMeetingRecording(
  recordingId: string,
  projectId: string,
): Promise<void> {
  const res = await apiFetch(
    API_BASE_URL + `/api/projects/${projectId}/meetings/record/${recordingId}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

/**
 * Public projection of an ActiveRun row. Used by the bash tab to attach to
 * a live sandbox when explicit coordinates are supplied by the parent.
 */
export interface ActiveRun {
  stack: string;
  service: string;
  instance: string | null;
  status: 'running' | 'completed' | 'error' | 'timeout' | 'stalled';
}

// Mail mutations deliberately opt out of native transport retries: an interrupted
// response does not establish whether SMTP delivery or an IMAP mutation happened.
export async function mailRequest<T>(
  projectId: string,
  operation: string,
  params: Record<string, string | number> = {},
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await mailResponse(
    projectId,
    operation,
    params,
    body,
    signal,
  );
  return response.json();
}
export async function mailResponse(
  projectId: string,
  operation: string,
  params: Record<string, string | number> = {},
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  ).toString();
  // An empty trailing '?' is signed literally on desktop, but removed by
  // server URL normalization, so omit it when there are no parameters.
  const response = await apiFetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/mail/${operation}${query ? `?${query}` : ''}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { allowRemoteRetry: false },
  );
  if (!response.ok)
    throw await apiErrorFromResponse(response, 'Mail request failed');
  return response;
}

// Paired integration enrollment is reviewed from an approved admin device.
export type PairingDetails = {
  id: string;
  label: string;
  requestedScopes: string[];
  expiresAt: string;
  fingerprint: string;
};
export async function resolveDevicePairing(
  code: string,
): Promise<PairingDetails> {
  return handleResponse(
    await apiFetch(API_BASE_URL + '/api/admin/device-pairing/resolve', {
      method: 'POST',
      headers,
      body: JSON.stringify({ code }),
    }),
  );
}
export async function decideDevicePairing(
  id: string,
  data: {
    decision: 'approved' | 'denied';
    ownerId: string;
    scopes: string[];
    days: number | null;
  },
): Promise<{ status: string }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL +
        `/api/admin/device-pairing/${encodeURIComponent(id)}/decision`,
      { method: 'POST', headers, body: JSON.stringify(data) },
    ),
  );
}
export async function updateIntegrationGrant(
  id: string,
  data: { scopes: string[]; days?: number | null },
): Promise<{ status: string }> {
  return handleResponse(
    await apiFetch(
      API_BASE_URL + `/api/admin/devices/${encodeURIComponent(id)}/grant`,
      { method: 'POST', headers, body: JSON.stringify(data) },
    ),
  );
}
