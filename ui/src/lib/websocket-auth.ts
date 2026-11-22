import { getServerConfigEpoch } from './api-config';
import { applicationWebSocketBaseUrl } from './websocket-url';

export interface WebSocketAuthTransport {
  apiFetch: (
    url: string,
    init?: RequestInit,
    options?: { allowRemoteRetry?: boolean },
  ) => Promise<Response>;
  isAndroid: () => boolean;
  populateVault: (secrets: { authToken: string }) => void;
}

/** Build an authenticated application socket URL while keeping the ticket and
 * socket pinned to the same API origin for the lifetime of one attempt. */
export async function authenticatedApplicationWebSocketUrl(
  httpBase: string,
  transport: WebSocketAuthTransport,
): Promise<string> {
  const baseWsUrl = applicationWebSocketBaseUrl(httpBase);
  const noRemoteRetry = { allowRemoteRetry: false };
  // A server change wipes the vault; a refresh that started before it must not
  // write the old server's token back.
  const epoch = getServerConfigEpoch();

  try {
    let response = await transport.apiFetch(
      httpBase + '/api/ws-ticket',
      undefined,
      noRemoteRetry,
    );
    if (response.status === 401 && transport.isAndroid()) {
      const refresh = await transport.apiFetch(
        httpBase + '/api/auth/token',
        { method: 'POST' },
        noRemoteRetry,
      );
      if (refresh.ok) {
        const data = (await refresh.json()) as { token?: unknown };
        if (typeof data.token !== 'string' || !data.token) {
          throw new Error('Token refresh returned no token');
        }
        if (getServerConfigEpoch() !== epoch) {
          throw new Error('Server config changed during token refresh');
        }
        transport.populateVault({ authToken: data.token });
        response = await transport.apiFetch(
          httpBase + '/api/ws-ticket',
          undefined,
          noRemoteRetry,
        );
      }
    }

    if (!response.ok) throw new Error('Failed to get WS ticket');
    const { ticket } = (await response.json()) as { ticket: string };
    return `${baseWsUrl}?ticket=${ticket}`;
  } catch (error) {
    console.debug(
      '[WS] Could not get auth ticket, falling back to cookie auth:',
      error,
    );
    return baseWsUrl;
  }
}
