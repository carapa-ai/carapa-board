import { getServerConfigEpoch } from './api-config';
import { liveVoiceWebSocketBaseUrl } from './websocket-url';
import type { ApiFetchOptions } from './api';

export type LiveVoiceTransport = {
  apiFetch: (
    url: string,
    init?: RequestInit,
    options?: ApiFetchOptions,
  ) => Promise<Response>;
  isAndroid: () => boolean;
  populateVault: (values: { authToken: string }) => void;
};

/** Build an authenticated Live Voice URL against one immutable board origin. */
export async function authenticatedLiveVoiceWebSocketUrl(
  path: string,
  httpBase: string,
  transport: LiveVoiceTransport,
): Promise<string> {
  const base = liveVoiceWebSocketBaseUrl(path, httpBase);
  const ticketUrl = `${httpBase}/api/ws-ticket`;

  const noRemoteRetry: ApiFetchOptions = { allowRemoteRetry: false };
  // A server change wipes the vault; a refresh that started before it must not
  // write the old server's token back.
  const epoch = getServerConfigEpoch();
  let response = await transport.apiFetch(ticketUrl, undefined, noRemoteRetry);
  if (response.status === 401 && transport.isAndroid()) {
    const refreshed = await transport.apiFetch(
      `${httpBase}/api/auth/token`,
      {
        method: 'POST',
      },
      noRemoteRetry,
    );
    if (refreshed.ok) {
      const value = (await refreshed.json()) as { token?: unknown };
      if (typeof value.token === 'string' && value.token) {
        if (getServerConfigEpoch() !== epoch) {
          throw new Error('Server config changed during token refresh');
        }
        transport.populateVault({ authToken: value.token });
        response = await transport.apiFetch(
          ticketUrl,
          undefined,
          noRemoteRetry,
        );
      }
    }
  }
  if (!response.ok) throw new Error('Voice authentication failed');
  const value = (await response.json()) as { ticket?: unknown };
  if (typeof value.ticket !== 'string' || !value.ticket) {
    throw new Error('Voice authentication returned no ticket');
  }
  return `${base}?ticket=${encodeURIComponent(value.ticket)}`;
}
