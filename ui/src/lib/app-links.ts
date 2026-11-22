/**
 * Client-side navigation for links that point at the app's own routes.
 *
 * Agents post board links in chat (for example
 * `/objective/<project>/<id>?report=<file>`). A plain `<a href>` click on
 * those reloads the whole SPA: the board state is lost and everything is
 * fetched again. This module decides whether an href is an in-app route and
 * performs the navigation through the router instead.
 *
 * Anything that is not recognised keeps the default `<a>` behaviour, so the
 * helper always fails safe.
 */

/**
 * Paths served by the backend (API, uploaded files, artifacts, MCP, OAuth
 * discovery, built assets, public shares). Those must never be handled by
 * the client-side router — they are plain HTTP endpoints.
 */
const SERVER_PATH_PREFIXES = [
  '/api',
  '/artifacts',
  '/uploads',
  '/mcp',
  '/oauth',
  '/assets',
  '/share',
];

/**
 * Top-level prefixes of the app routes in `ui/src/routes/`.
 *
 * The client router is the real source of truth, but it can only be asked
 * about a path after it has been loaded, so the cheap prefix check runs
 * first and `navigateToAppPath` then confirms the match with the router
 * before navigating.
 *
 * Note: `/oauth` and `/share` also have SPA routes, but the backend handles
 * those paths first (OAuth discovery/consent endpoints and the public share
 * landing page), so they are excluded on purpose.
 */
const APP_ROUTE_PREFIXES = [
  '/account',
  '/admin',
  '/board',
  '/chat',
  '/costs',
  '/knowledge',
  '/memory-review',
  '/objective',
  '/objectives',
  '/tts-test',
  '/users',
];

/** Match a path against a top-level prefix (`/chat` matches `/chat/x`). */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** True for paths the backend serves directly (API, files, MCP, assets). */
function isServerHandledPath(pathname: string): boolean {
  return SERVER_PATH_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

/** True for paths that belong to one of the app's own routes. */
function isAppRoutePath(pathname: string): boolean {
  // The index route is the app root (`ui/src/routes/index.tsx`). It is not a
  // prefix of anything else, so it is checked on its own.
  if (pathname === '/') return true;
  return APP_ROUTE_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

/**
 * Reduce an href to the in-app path it points at, or `null` when it is not
 * an in-app route.
 *
 * An href is an in-app route when it points at the same origin and at one of
 * the app's own routes (and not at a server-handled path). Absolute URLs are
 * reduced to `path + search + hash`; root-relative paths are kept as they
 * are.
 *
 * @param href the link target as written in the markdown
 * @param origin the origin to compare against; defaults to the current one
 */
export function appLinkPath(href: string, origin?: string): string | null {
  const raw = (href ?? '').trim();
  if (!raw) return null;
  // Protocol-relative URLs ("//host/path") are never treated as in-app.
  if (raw.startsWith('//')) return null;
  const base =
    origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  if (!base) return null;

  const absolute = /^[a-z][a-z\d+.-]*:/i.test(raw);
  // Only root-relative paths and absolute URLs are in-app links; a relative
  // path resolves against the current page and keeps the default behaviour.
  if (!absolute && !raw.startsWith('/')) return null;

  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  // Covers other origins and non-http schemes (`mailto:`, `tel:`, `data:`).
  if (url.origin !== base) return null;
  if (isServerHandledPath(url.pathname)) return null;
  if (!isAppRoutePath(url.pathname)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The report an in-app link points at, but only when the link targets the
 * given route.
 *
 * `routePath` is the route the link has to point at (for example
 * `/objective/carapa/obj-1`). Links to other routes, and links without a
 * `report` parameter, return `undefined`.
 *
 * @param path the in-app path the link points at
 * @param routePath the route the link has to target
 */
export function reportFromAppLink(
  path: string,
  routePath: string,
): string | undefined {
  const withoutHash = path.split('#', 1)[0];
  const [pathname, query = ''] = withoutHash.split('?', 2);
  if (pathname !== routePath) return undefined;
  const report = new URLSearchParams(query).get('report');
  return report ? report : undefined;
}

/**
 * True for a plain left click: no modifier keys, not already handled and not
 * a download link. Anything else keeps the browser default (new tab, save…).
 */
export function isPlainLeftClick(
  event: Pick<
    MouseEvent,
    | 'button'
    | 'defaultPrevented'
    | 'metaKey'
    | 'ctrlKey'
    | 'shiftKey'
    | 'altKey'
  >,
  download?: string,
): boolean {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !download
  );
}

/**
 * Navigate to an in-app path without a full page reload.
 *
 * The router is imported lazily: a static import would pull the whole route
 * tree into every consumer of this module and create an import cycle with
 * the routes that render markdown. The router confirms that it recognises
 * the path; if it does not (for example a route prefix without its
 * parameters), the browser default is used instead.
 *
 * `ignoreBlocker` skips the router's navigation blocker. It is only safe
 * when the caller already asked the active preview whether it may be left:
 * the blocker runs exactly that check, so asking twice would show the
 * leave prompt twice.
 */
export async function navigateToAppPath(
  path: string,
  options?: { ignoreBlocker?: boolean },
): Promise<void> {
  const { router } = await import('@/lib/router');
  const pathname = path.split(/[?#]/, 1)[0];
  try {
    // The router is the source of truth: it knows the route and its params.
    if (router.getMatchedRoutes(pathname).foundRoute) {
      router.history.push(path, undefined, {
        ignoreBlocker: options?.ignoreBlocker === true,
      });
      return;
    }
  } catch {
    // Fall through to the browser default below.
  }
  // Unknown path (e.g. a route prefix without its parameters) — keep the
  // default link behaviour.
  window.location.assign(path);
}
