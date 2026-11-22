function webSocketUrlForOrigin(path: string, httpBase: string): string {
  return httpBase
    ? httpBase.replace(/^http/, 'ws') + path
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${path}`;
}

export function applicationWebSocketBaseUrl(httpBase: string): string {
  return webSocketUrlForOrigin('/api/ws', httpBase);
}

export function liveVoiceWebSocketBaseUrl(
  path: string,
  httpBase: string,
): string {
  return webSocketUrlForOrigin(path, httpBase);
}
