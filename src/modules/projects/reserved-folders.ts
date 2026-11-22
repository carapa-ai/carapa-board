/**
 * Folder slugs that collide with literal `/api/projects/<name>` collection
 * routes (attention, status-summary, order). A project using one of them would
 * be shadowed by those routes, so they cannot be assigned to a project.
 */
export const RESERVED_PROJECT_FOLDERS: readonly string[] = [
  'attention',
  'status-summary',
  'order',
];

/**
 * Folder prefix of per-user mains (`main-<username>`). Human principals are
 * bound to that folder name, so project create, folder rename and repository
 * discovery must not hand it out. Not part of `isReservedProjectFolder`: it
 * also flags existing rows at state load, and every real per-user main uses it.
 */
export const PERSONAL_MAIN_PREFIX = 'main-';

export function isReservedMainFolder(folder: string): boolean {
  return folder.toLowerCase().startsWith(PERSONAL_MAIN_PREFIX);
}

export function isReservedProjectFolder(folder: string): boolean {
  return RESERVED_PROJECT_FOLDERS.includes(folder.toLowerCase());
}
