import { useMemo, useSyncExternalStore } from 'react';
import { HOME_URL, REMOTE_URL, subscribeServerConfig } from '@/lib/api-config';

/** Current Home / Remote URLs; re-renders when the server config changes. */
export function useServerUrls() {
  const key = useSyncExternalStore(
    subscribeServerConfig,
    () => `${HOME_URL}|${REMOTE_URL}`,
  );
  return useMemo(() => {
    const [homeUrl, remoteUrl] = key.split('|');
    return { homeUrl, remoteUrl, singleServer: homeUrl === remoteUrl };
  }, [key]);
}
