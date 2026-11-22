import { SECURITY_MCP } from './security-fixtures.js';
import { SANDBOX_ADMIN, SANDBOX_MEMBER } from './shared.js';

/**
 * MCP-reach checks of the security smoke: a logged-in human reaches /mcp with
 * the scope of their per-user main (own main + owned/member projects), never
 * the `'*'` wildcard, admins included. Runs over plain HTTP through the real
 * login -> auth middleware -> /mcp stack. Password-only logins carry no device
 * key, so the device-approval gate does not apply to them. The seeder creates
 * `ui-member` (editor on `memberProject` only); user and member mutations over
 * the API need a fresh device signature, which this script has no key for.
 */
type Check = (condition: boolean, message: string) => void;

const MCP_ENDPOINTS = [
  '/mcp/carapa-board',
  '/mcp/carapa-orchestrator',
] as const;

interface McpSession {
  endpoint: string;
  serverName: string;
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ refused: boolean; body: string }>;
}

/** Streamable HTTP answers a POST with either JSON or a single SSE message. */
function parseRpc(text: string): any {
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  return JSON.parse(data.length > 0 ? data[data.length - 1] : text);
}

async function login(
  apiUrl: string,
  user: { username: string; password: string },
): Promise<string> {
  const response = await fetch(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user),
  });
  const body = (await response.json().catch(() => ({}))) as { token?: string };
  if (!response.ok || !body.token) {
    throw new Error(`Login of ${user.username} failed: ${response.status}`);
  }
  return body.token;
}

async function openSession(
  apiUrl: string,
  token: string,
  endpoint: string,
): Promise<McpSession> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const post = (body: unknown) =>
    fetch(`${apiUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'ui-sandbox-security-smoke', version: '1.0.0' },
    },
  });
  const sessionId = init.headers.get('mcp-session-id');
  if (!init.ok || !sessionId) {
    throw new Error(`MCP initialize on ${endpoint} failed: ${init.status}`);
  }
  const serverName = parseRpc(await init.text()).result?.serverInfo?.name;
  headers['mcp-session-id'] = sessionId;
  await (
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  ).text();

  let nextId = 2;
  return {
    endpoint,
    serverName,
    async call(name, args) {
      const response = await post({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      const body = await response.text();
      if (!response.ok) return { refused: true, body };
      const rpc = parseRpc(body);
      return { refused: !!rpc.error || rpc.result?.isError === true, body };
    },
  };
}

export async function runMcpReachChecks(
  apiUrl: string,
  check: Check,
): Promise<void> {
  const memberMain = `main-${SANDBOX_MEMBER.username}`;
  const adminToken = await login(apiUrl, SANDBOX_ADMIN);
  const memberToken = await login(apiUrl, SANDBOX_MEMBER);
  const { privateProject, privateTask, memberProject, memberTask } =
    SECURITY_MCP;

  const expectRefused = async (
    session: McpSession,
    who: string,
    tool: string,
    args: Record<string, unknown>,
    leaked?: string,
  ) => {
    const res = await session.call(tool, args);
    const label = `MCP ${who} ${session.endpoint} ${tool}(${JSON.stringify(args)})`;
    check(res.refused, `${label}: expected a refusal, the call succeeded`);
    if (leaked) {
      check(
        !res.body.includes(leaked),
        `${label}: response leaked "${leaked}"`,
      );
    }
  };

  for (const endpoint of MCP_ENDPOINTS) {
    const admin = await openSession(apiUrl, adminToken, endpoint);
    const member = await openSession(apiUrl, memberToken, endpoint);
    for (const [who, session] of [
      [SANDBOX_ADMIN.username, admin],
      [SANDBOX_MEMBER.username, member],
    ] as const) {
      check(
        !!session.serverName && session.serverName !== 'carapa-orchestrator',
        `MCP ${who} ${endpoint}: serverInfo.name is "${session.serverName}", the '*' orchestrator tier must not be granted`,
      );
    }

    // Another user's main is out of reach even for an admin.
    await expectRefused(admin, SANDBOX_ADMIN.username, 'list_tasks', {
      project_id: memberMain,
    });

    // The member sees nothing of a project they do not belong to.
    await expectRefused(
      member,
      SANDBOX_MEMBER.username,
      'list_tasks',
      { project_id: privateProject },
      privateTask.title,
    );
    await expectRefused(
      member,
      SANDBOX_MEMBER.username,
      'get_task',
      { task_id: privateTask.id },
      privateTask.title,
    );

    if (endpoint === MCP_ENDPOINTS[0]) {
      for (const [project_id, expectedTitle] of [
        [memberMain, undefined],
        [memberProject, memberTask.title],
      ] as const) {
        const res = await member.call('list_tasks', { project_id });
        const label = `MCP ${SANDBOX_MEMBER.username} ${endpoint} list_tasks(${project_id})`;
        check(!res.refused, `${label}: expected success, got ${res.body}`);
        if (expectedTitle) {
          check(
            res.body.includes(expectedTitle),
            `${label}: missing the seeded task "${expectedTitle}"`,
          );
        }
      }
    }
  }
}
