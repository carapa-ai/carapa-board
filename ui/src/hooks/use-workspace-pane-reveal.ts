import { useEffect } from 'react';
import { useStore } from '@/store';

/**
 * Reveal a workspace pane that was hidden when a preview was explicitly
 * activated for this project.
 *
 * `openPreviewTab` records such activations in
 * `pendingPreviewActivationByProject` so `PreviewPane` can jump to Preview
 * when it (re)mounts — but the routes that conditionally mount the pane
 * never reacted to that marker, so an activation arriving while the pane
 * was closed created the tab without ever showing it. The route owning the
 * pane's open state calls this hook so the pane is mounted at all;
 * `PreviewPane` then consumes the marker on mount to land on the activated
 * file.
 */
export function useWorkspacePaneReveal(
  projectId: string,
  setOpen: (open: boolean) => void,
) {
  const pending = useStore(
    (state) => state.pendingPreviewActivationByProject[projectId] === true,
  );
  useEffect(() => {
    if (pending) setOpen(true);
  }, [pending, projectId, setOpen]);
}
