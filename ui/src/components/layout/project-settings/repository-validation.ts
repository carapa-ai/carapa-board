// Copy of the server rules in `src/lib/git-ref-name.ts`; keep the two in sync.
// Empty values are valid (they fall back to the default / no repository).

const DEFAULT_BRANCH_ERROR = 'Not a valid git branch name.';
const REPOSITORY_URL_ERROR =
  'Must not contain whitespace or control characters or start with "-".';

function isValidGitBranchName(name: string): boolean {
  if (!name || name === '@') return false;
  if (/[\s\x00-\x1f\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) {
    return false;
  }
  if (name.startsWith('-') || name.startsWith('/')) return false;
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) {
    return false;
  }
  return name
    .split('/')
    .every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

export function defaultBranchError(value: string | undefined): string | null {
  return !value || isValidGitBranchName(value) ? null : DEFAULT_BRANCH_ERROR;
}

export function repositoryUrlError(value: string | undefined): string | null {
  if (!value) return null;
  return /[\s\x00-\x1f\x7f]/.test(value) || value.startsWith('-')
    ? REPOSITORY_URL_ERROR
    : null;
}
