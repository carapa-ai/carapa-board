/**
 * Pure `git check-ref-format --branch` equivalent for a branch short name
 * (what Default Branch stores; callers add the `refs/heads/` prefix).
 *
 * The UI keeps a copy of this rule in
 * `ui/src/components/layout/project-settings/repository-validation.ts`; keep
 * the two in sync.
 */
export function isValidGitBranchName(name: string): boolean {
  if (!name || name === '@') return false;
  // Whitespace, control chars (incl. DEL), and ~ ^ : ? * [ \
  if (/[\s\x00-\x1f\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) {
    return false;
  }
  if (name.startsWith('-') || name.startsWith('/')) return false;
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) {
    return false;
  }
  // No path component may start with "." or end with ".lock".
  return name
    .split('/')
    .every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * Repository URL may be SSH, HTTPS, a local path or empty, so only reject what
 * can never be a valid remote argument: whitespace/control characters and a
 * leading "-" (would be parsed as a git option).
 */
export function isSafeRepositoryUrl(value: string): boolean {
  return !/[\s\x00-\x1f\x7f]/.test(value) && !value.startsWith('-');
}
