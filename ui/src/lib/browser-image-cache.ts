export const decodedBrowserImages = new Set<string>();
export const lastBrowserImageByIdentity = new Map<string, string>();
const browserImageVersionByIdentity = new Map<string, string>();

function imageVersion(url: string): string | null {
  try {
    return new URL(url, typeof window === 'undefined' ? 'http://localhost' : window.location.origin).searchParams.get('v');
  } catch {
    return null;
  }
}

function compareVersions(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber))
    return leftNumber - rightNumber;
  const leftDate = Date.parse(left);
  const rightDate = Date.parse(right);
  if (Number.isFinite(leftDate) && Number.isFinite(rightDate))
    return leftDate - rightDate;
  return left.localeCompare(right);
}

export function cacheBrowserImage(identity: string, url: string): void {
  const version = imageVersion(url);
  const current = browserImageVersionByIdentity.get(identity);
  if (!current || !version || compareVersions(version, current) >= 0) {
    lastBrowserImageByIdentity.set(identity, url);
    if (version) browserImageVersionByIdentity.set(identity, version);
  }
}

export function aiUserImageKey(url: string): string | null {
  try {
    const match = new URL(
      url,
      typeof window === 'undefined'
        ? 'http://localhost'
        : window.location.origin,
    ).pathname.match(/^\/api\/ai-users\/([^/]+)\/(avatar|emotes\/([^/]+))$/);
    if (!match?.[1]) return null;
    const userId = decodeURIComponent(match[1]);
    return match[2] === 'avatar'
      ? `${userId}:avatar`
      : `${userId}:emote:${decodeURIComponent(match[3])}`;
  } catch {
    return null;
  }
}
