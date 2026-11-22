import type { ProjectSettings } from '@/types';

export type PrivacyMode = 'off' | 'local_memory' | 'strict';

export function normalizePrivacyMode(
  mode: ProjectSettings['privacyMode'],
): PrivacyMode {
  return mode ?? 'off';
}

/**
 * The `privacyMode` key to send in a settings PATCH. The server rejects any
 * request carrying the key from a non-admin and requires a fresh signature
 * for downgrades, so it is sent only when an admin actually changed it.
 * `off` is sent as null, which clears the stored value.
 */
export function privacyModePatch(
  draft: ProjectSettings['privacyMode'],
  saved: ProjectSettings['privacyMode'],
  isAdmin: boolean,
): Pick<ProjectSettings, 'privacyMode'> {
  const next = normalizePrivacyMode(draft);
  if (!isAdmin || next === normalizePrivacyMode(saved)) return {};
  return { privacyMode: next === 'off' ? null : next };
}
