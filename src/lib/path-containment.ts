import path from 'node:path';

/**
 * Lexical path containment. Pure: no filesystem access, so symlinks are not
 * resolved. Callers that must defend against links pair this with realpath or
 * `src/lib/group-fs.ts`.
 */

/**
 * True when `candidate` lies inside `root`. Both paths are normalized with
 * `path.resolve`; a non-absolute root or candidate returns false (fail
 * closed). `allowRoot` (default true) decides whether `candidate === root`
 * counts as inside.
 */
export function isPathInside(
  root: string,
  candidate: string,
  opts?: { allowRoot?: boolean },
): boolean {
  if (!path.isAbsolute(root) || !path.isAbsolute(candidate)) return false;
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === '') return opts?.allowRoot ?? true;
  return rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel);
}

/**
 * `path.resolve(root, rel)` when the result is inside `root`, else throws
 * `Error('Path escapes base directory')`. A relative `root` is resolved
 * against the working directory first.
 */
export function resolveInside(
  root: string,
  rel: string,
  opts?: { allowRoot?: boolean },
): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, rel);
  if (!isPathInside(base, resolved, opts)) {
    throw new Error('Path escapes base directory');
  }
  return resolved;
}
