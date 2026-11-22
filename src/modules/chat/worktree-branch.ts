/** Whether `branch` is an acceptable git branch name for a chat worktree. */
export function isSafeWorktreeBranch(branch: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
    !branch.includes('..') &&
    !branch.split('/').some((segment) => !segment || segment === '.')
  );
}
