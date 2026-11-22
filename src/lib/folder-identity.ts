/**
 * Identity of a project folder over time. A folder name can be retired (a
 * personal main is archived) and later handed to a different project, so a
 * grant that was issued for the old holder must not follow the name.
 *
 * Permission maps are copied into long-running agent runs. `trackGrants`
 * records, per folder in a freshly built map, the generation it was issued
 * under; `liveGrants` drops the folders retired since, at the moment of use.
 */
const generations = new Map<string, number>();
const issued = new WeakMap<object, Map<string, number>>();

export function getFolderGeneration(folder: string): number {
  return generations.get(folder) ?? 0;
}

/** Declare that `folder` now names a different project than before. */
export function retireFolderIdentity(folder: string): void {
  generations.set(folder, getFolderGeneration(folder) + 1);
}

/** Remember the current generation of every folder in `permissions`. */
export function trackGrants<T extends Record<string, string[]>>(
  permissions: T,
): T {
  issued.set(
    permissions,
    new Map(Object.keys(permissions).map((f) => [f, getFolderGeneration(f)])),
  );
  return permissions;
}

/**
 * `permissions` without the folders retired since it was issued. Returns the
 * same object when nothing changed, and untracked maps unchanged.
 */
export function liveGrants(
  permissions: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  const at = permissions && issued.get(permissions);
  if (!permissions || !at) return permissions;
  const stale = [...at].filter(([f, g]) => getFolderGeneration(f) !== g);
  if (stale.length === 0) return permissions;
  const live = { ...permissions };
  for (const [folder] of stale) delete live[folder];
  return live;
}

/** A job that read a folder under an earlier identity tried to use it again. */
class FolderRetiredError extends Error {
  constructor() {
    super(
      'The project was retired while this job was running; result discarded',
    );
    this.name = 'FolderRetiredError';
  }
}

/**
 * Throw unless `folder` still names the project it did when `captured` was
 * read. Capture BEFORE reading the folder's content, assert right before
 * writing; never re-read the generation after the slow step in between.
 */
export function assertFolderIdentity(folder: string, captured: number): void {
  if (getFolderGeneration(folder) !== captured) throw new FolderRetiredError();
}
