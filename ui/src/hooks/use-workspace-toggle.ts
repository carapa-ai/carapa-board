import { useEffect, useRef } from 'react';
import { create } from 'zustand';

interface WorkspaceToggle {
  open: boolean;
  toggle: () => void;
}

interface WorkspaceToggleState {
  registration: WorkspaceToggle | null;
}

/**
 * The page that owns a workspace pane publishes its open state here so the
 * shared top navbar can render the one toggle for it.
 */
export const useWorkspaceToggleStore = create<WorkspaceToggleState>(() => ({
  registration: null,
}));

/**
 * Registers the active page's workspace toggle with the header while
 * `enabled`, and removes it on unmount, when disabled, or when the open state
 * changes (re-registered with the new state).
 */
export function useRegisterWorkspaceToggle(
  open: boolean,
  toggle: () => void,
  enabled = true,
) {
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    if (!enabled) return;
    const registration: WorkspaceToggle = {
      open,
      toggle: () => toggleRef.current(),
    };
    useWorkspaceToggleStore.setState({ registration });
    return () => {
      // Only clear our own registration; a newly mounted page may already
      // have replaced it.
      if (useWorkspaceToggleStore.getState().registration === registration) {
        useWorkspaceToggleStore.setState({ registration: null });
      }
    };
  }, [open, enabled]);
}
