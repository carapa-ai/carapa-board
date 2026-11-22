export type MarkdownFileOpenHandler = (
  path: string,
  fallbackContent?: string,
  source?: 'group' | 'repo',
) => void;

/** True for a non-empty list of plain names: no empty, `.`, `..`, separator or control segments. */
export function hasSafeSegments(segments: string[]): boolean {
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        !!segment &&
        segment !== '.' &&
        segment !== '..' &&
        !/[/\\\u0000-\u001f]/.test(segment),
    )
  );
}

interface ProjectFileLink {
  source: 'group' | 'repo';
  path: string;
}

/**
 * `README.md:10` / `index.ts:42:3`: a bare file name with a line suffix. The
 * dot keeps numeric URL schemes such as `tel:123` out; a `/` before the first
 * colon makes it a normal path, which needs no special handling.
 */
export function isBareFileLineReference(href: string): boolean {
  return /^[^/\\:?#\s]*\.[^/\\:?#\s]*:\d+(?::\d+)?$/.test(href);
}

/** Resolve agent file references before the browser treats them as page URLs. */
export function projectFileFromHref(
  href: string,
  projectFolder?: string,
): ProjectFileLink | null {
  if (!projectFolder || !href || /[\\\u0000-\u001f]/.test(href)) return null;
  let rawPath = href.split(/[?#]/, 1)[0];
  const absoluteUrl = /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(href);
  if (absoluteUrl) {
    if (typeof window === 'undefined') return null;
    try {
      if (new URL(href, window.location.href).origin !== window.location.origin)
        return null;
    } catch {
      return null;
    }
    // Keep raw segments: URL.pathname would normalize away traversal.
    rawPath = rawPath.replace(/^(?:[a-z][a-z\d+.-]*:)?\/\/[^/]*/i, '');
  } else if (
    /^[a-z][a-z\d+.-]*:/i.test(rawPath) &&
    !isBareFileLineReference(rawPath)
  ) {
    return null;
  }

  try {
    let segments = rawPath
      .split('/')
      .map((segment) => decodeURIComponent(segment));
    let source: ProjectFileLink['source'] = 'repo';
    if (segments[0] === '') {
      segments = segments.slice(1);
      if (segments[0] === 'artifacts') {
        if (segments[1] !== projectFolder) return null;
        segments = ['artifacts', ...segments.slice(2)];
        source = 'group';
      } else if (segments[0] === 'workspace') {
        segments = segments.slice(1);
        if (segments[0] === 'group') {
          source = 'group';
          segments.shift();
        } else if (segments[0] === projectFolder) {
          segments.shift();
        }
      } else {
        return null;
      }
    } else {
      if (absoluteUrl) return null;
      while (segments[0] === '.') segments.shift();
      if (segments[0] === 'group') {
        source = 'group';
        segments.shift();
      } else if (segments[0] === 'artifacts') {
        source = 'group';
      }
    }
    if (!hasSafeSegments(segments)) return null;
    // Codex also emits path:line[:column] references; the preview opens the file.
    const path = segments.join('/').replace(/:\d+(?::\d+)?$/, '');
    return path ? { source, path } : null;
  } catch {
    return null;
  }
}

/**
 * Served `/artifacts/<folder>/...` URL for a group artifact reference, so an
 * image written as a filesystem path (`/workspace/group/artifacts/...`) loads
 * instead of falling through to the app's HTML fallback. Null for other files.
 */
export function servedArtifactUrl(
  file: ProjectFileLink,
  projectFolder: string,
): string | null {
  if (file.source !== 'group') return null;
  const segments = file.path.split('/');
  if (segments[0] !== 'artifacts' || segments.length < 2) return null;
  return `/artifacts/${encodeURIComponent(projectFolder)}/${segments
    .slice(1)
    .map(encodeURIComponent)
    .join('/')}`;
}
