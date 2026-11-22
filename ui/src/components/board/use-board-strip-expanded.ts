import { useCallback, useState } from 'react';

const STORAGE_KEY = 'boardCollapsibleExpandedByProject';

export type BoardCollapsibleKey =
  | 'automations'
  | 'archivedAutomations'
  | 'scheduledTasks'
  | 'objectives';

// Keep secondary strips collapsed until there is enough room for their cards
// on a desktop-sized viewport. They remain user-expandable.
const DESKTOP_MEDIA_QUERY = '(min-width: 1024px)';

export function isDesktopViewport() {
  return (
    typeof window === 'undefined' ||
    window.matchMedia(DESKTOP_MEDIA_QUERY).matches
  );
}

function readStoredMap(): Record<string, Record<string, unknown>> {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    const map = value ? JSON.parse(value) : {};
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

function readExpanded(
  projectId: string,
  key: BoardCollapsibleKey,
  getDefault: () => boolean,
) {
  const stored = readStoredMap()[projectId]?.[key];
  return typeof stored === 'boolean' ? stored : getDefault();
}

function persistExpanded(
  projectId: string,
  key: BoardCollapsibleKey,
  expanded: boolean,
) {
  try {
    const map = readStoredMap();
    const project = map[projectId];
    map[projectId] = {
      ...(project && typeof project === 'object' ? project : {}),
      [key]: expanded,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* best effort */
  }
}

/**
 * Expanded/collapsed state of one board collapsible, remembered per project
 * and per collapsible in this browser's localStorage. `getDefault` applies
 * only until the user has toggled the collapsible for that project.
 */
export function useBoardCollapsibleExpanded(
  projectId: string,
  key: BoardCollapsibleKey,
  getDefault: () => boolean,
) {
  const [state, setState] = useState(() => ({
    projectId,
    expanded: readExpanded(projectId, key, getDefault),
  }));
  let expanded = state.expanded;
  if (state.projectId !== projectId) {
    // The board can be reused across projects without remounting; re-read the
    // target project's saved value instead of leaking the previous one.
    expanded = readExpanded(projectId, key, getDefault);
    setState({ projectId, expanded });
  }

  const setExpanded = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      setState((current) => {
        const value =
          typeof next === 'function' ? next(current.expanded) : next;
        persistExpanded(projectId, key, value);
        return { projectId, expanded: value };
      });
    },
    [projectId, key],
  );

  return [expanded, setExpanded] as const;
}
