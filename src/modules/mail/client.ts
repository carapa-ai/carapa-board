import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CARAPA_MAIL_MCP_URL } from '../../config.js';
import { getGroupByFolder } from '../../state-manager.js';
import { logger } from '../../logger.js';

/**
 * Thin MCP client for carapa-mail.
 *
 * carapa-mail's MCP is a stateless HTTP server authenticated with a per-project
 * Bearer token (the project's `carapaMailToken`). The board holds that token in
 * plaintext (decrypted in memory), so it connects directly — no api-relay hop.
 *
 * Connect-per-call: carapa-mail creates a fresh server per request, so there is
 * nothing to keep warm and no token cache to invalidate.
 */

// Generous ceiling: carapa-mail's read_email runs a server-side AI security
// filter (an LLM call) on first read, which can take tens of seconds on a slow
// model. The user can still cancel mid-call via the abort signal; this timeout
// only guards against a truly stuck connection.
const CALL_TIMEOUT_MS = 120_000;

/**
 * Base the board reaches carapa-mail at (CARAPA_MAIL_MCP_URL minus the `/mcp` suffix).
 * Declared to carapa-mail via `x-carapamail-public-base` so attachment download links
 * it mints point back through the same path the board used — i.e. links the board can
 * fetch server-side (the human's browser can't reach carapa-mail directly).
 */
export const CARAPA_MAIL_BASE_URL = CARAPA_MAIL_MCP_URL.replace(
  /\/mcp\/?$/,
  '',
);

/** Connect to carapa-mail with the given token, run `fn`, and always close. */
async function withMailClient<T>(
  token: string,
  fn: (c: Client) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const client = new Client(
    { name: 'carapa-board-mail-client', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(CARAPA_MAIL_MCP_URL),
    {
      requestInit: {
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'x-carapamail-public-base': CARAPA_MAIL_BASE_URL,
        },
      },
    },
  );
  // The SDK transport overrides `requestInit.signal` with its own internal
  // controller, so `signal` alone cannot interrupt initialization or the
  // `notifications/initialized` POST. Closing the client on abort aborts every
  // in-flight request of the transport and rejects pending ones.
  const closeClient = () => void client.close().catch(() => {});
  signal?.addEventListener('abort', closeClient, { once: true });
  try {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    await client.connect(transport, signal ? { signal } : undefined);
    return await fn(client);
  } finally {
    signal?.removeEventListener('abort', closeClient);
    await client.close().catch(() => {});
  }
}

/** Structured UI/service path. Agent callers retain the string interface below. */
export async function callCarapaMailJson<T>(
  projectId: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const settings = getGroupByFolder(projectId)?.settings;
  if (!settings?.carapaMailEnabled || !settings.carapaMailToken)
    throw new Error('Mail is not configured for this project');
  const boundedSignal = AbortSignal.any([
    AbortSignal.timeout(CALL_TIMEOUT_MS),
    ...(signal ? [signal] : []),
  ]);
  const result = await withMailClient(
    settings.carapaMailToken,
    (client) =>
      client.callTool({ name, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
        signal: boundedSignal,
      }),
    boundedSignal,
  );
  return parseMailResult<T>(result);
}

export function parseMailResult<T>(result: unknown): T {
  const value = result as {
    isError?: boolean;
    content?: { type: string; text?: string }[];
  };
  const text =
    value.content
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n') ?? '';
  if (value.isError) throw new Error(text || 'CarapaMail request failed');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('CarapaMail returned an invalid response');
  }
}

/** Discover carapa-mail's tool list (token-independent schemas). */
export async function listMailTools(
  token: string,
  signal?: AbortSignal,
): Promise<any[]> {
  const res = await withMailClient(
    token,
    (c) => c.listTools(undefined, signal ? { signal } : undefined),
    signal,
  );
  return res.tools ?? [];
}

/**
 * Proxy a single carapa-mail tool call using the calling project's token.
 * Never throws — returns an error string so the chat loop keeps going.
 */
export async function callCarapaMailTool(
  group_folder: string,
  name: string,
  args: any,
  signal?: AbortSignal,
): Promise<string> {
  const s = getGroupByFolder(group_folder)?.settings;
  if (!s?.carapaMailEnabled || !s.carapaMailToken) {
    return 'Error: carapa-mail is not enabled for this project';
  }
  const boundedSignal = AbortSignal.any([
    AbortSignal.timeout(CALL_TIMEOUT_MS),
    ...(signal ? [signal] : []),
  ]);
  try {
    const result: any = await withMailClient(
      s.carapaMailToken,
      (c) =>
        c.callTool({ name, arguments: args }, undefined, {
          timeout: CALL_TIMEOUT_MS,
          signal: boundedSignal,
        }),
      boundedSignal,
    );
    const text = Array.isArray(result?.content)
      ? result.content
          .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('\n')
      : '';
    return text || JSON.stringify(result);
  } catch (err: any) {
    logger.warn({ err: err?.message, name }, 'carapa-mail tool call failed');
    if (signal?.aborted) return 'Error: carapa-mail request aborted';
    if (boundedSignal.aborted) return 'Error: carapa-mail request timed out';
    return `Error: ${err?.message || 'carapa-mail call failed'}`;
  }
}
