/**
 * Mode resolution: which of kanban/chat/objectives a project should render.
 *
 * A mode is "available" only when both:
 *   - the backend has the corresponding global flag enabled (via /api/config), AND
 *   - the project allows it (in `enabledModes`).
 *
 * Use `availableProjectModes()` for picker visibility, `resolveProjectMode()` for
 * "which mode should we navigate this project to right now".
 */

import type { Project } from '@/types';

export type ProjectMode = 'kanban' | 'chat' | 'objectives';

export interface ModeAvailabilityConfig {
  enableKanban?: boolean;
  enableChat?: boolean;
  enableObjectives?: boolean;
}

const MODE_PRIORITY: ProjectMode[] = ['kanban', 'chat', 'objectives'];

export function availableProjectModes(
  project: Pick<Project, 'settings'> | undefined,
  config: ModeAvailabilityConfig | undefined,
): ProjectMode[] {
  const enabled = project?.settings?.enabledModes ?? ['kanban', 'chat'];
  const out: ProjectMode[] = [];
  if (config?.enableKanban && enabled.includes('kanban')) out.push('kanban');
  if (config?.enableChat && enabled.includes('chat')) out.push('chat');
  if (config?.enableObjectives && enabled.includes('objectives'))
    out.push('objectives');
  return out;
}

/** Modes the project has explicitly selected and the server offers. */
function selectedProjectModes(
  project: Pick<Project, 'settings'> | undefined,
  config: ModeAvailabilityConfig | undefined,
): ProjectMode[] {
  const enabled = project?.settings?.enabledModes ?? ['kanban', 'chat'];
  return MODE_PRIORITY.filter(
    (mode) =>
      enabled.includes(mode) &&
      config?.[
        mode === 'kanban'
          ? 'enableKanban'
          : mode === 'chat'
            ? 'enableChat'
            : 'enableObjectives'
      ],
  );
}

/**
 * The only selected mode, when exactly one is left (it must not be unchecked),
 * or `null`.
 */
export function lastAvailableMode(
  project: Pick<Project, 'settings'> | undefined,
  config: ModeAvailabilityConfig | undefined,
): ProjectMode | null {
  const selected = selectedProjectModes(project, config);
  return selected.length === 1 ? selected[0] : null;
}

/**
 * True when the server offers at least one mode but the project has none
 * selected, which hides the project header and its settings entry point.
 */
export function hasNoSelectedMode(
  project: Pick<Project, 'settings'> | undefined,
  config: ModeAvailabilityConfig | undefined,
): boolean {
  const serverOffersMode =
    config?.enableKanban || config?.enableChat || config?.enableObjectives;
  return (
    Boolean(serverOffersMode) &&
    selectedProjectModes(project, config).length === 0
  );
}

/**
 * Returns the mode to navigate this project to right now.
 * - The current user's per-(user, project) `memberMode` wins if set
 * - Otherwise the project-wide default `project.settings.mode`
 * - Otherwise first available in priority order (kanban → chat → objectives)
 * - Returns `null` when no mode is available — caller should render the
 *   "ask admin to enable a mode" empty state instead of routing anywhere.
 */
export function resolveProjectMode(
  project: Pick<Project, 'settings' | 'memberMode'> | undefined,
  config: ModeAvailabilityConfig | undefined,
): ProjectMode | null {
  const available = availableProjectModes(project, config);
  if (available.length === 0) return null;

  const memberMode = project?.memberMode;
  if (memberMode && available.includes(memberMode)) return memberMode;

  const desired = project?.settings?.mode;
  if (desired && available.includes(desired)) return desired;

  for (const m of MODE_PRIORITY) {
    if (available.includes(m)) return m;
  }
  return available[0];
}

export function modeRoutePath(
  mode: ProjectMode,
): '/board/$projectId' | '/chat/$projectId' | '/objectives/$projectId' {
  if (mode === 'chat') return '/chat/$projectId';
  if (mode === 'objectives') return '/objectives/$projectId';
  return '/board/$projectId';
}
