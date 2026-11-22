import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { ShareDialog } from '@/components/share-dialog';
import { useProject } from '@/hooks/use-projects';
import { useStore } from '@/store';

// Lazy: the settings dialog is large and only needed once someone opens it.
// Menus call this on open so the chunk is usually loaded before it is needed.
export const loadProjectSettingsDialog = () =>
  import('./project-settings-dialog');

const ProjectSettingsDialog = lazy(() =>
  loadProjectSettingsDialog().then((m) => ({
    default: m.ProjectSettingsDialog,
  })),
);

/**
 * A failed settings chunk (typically a stale tab after a deploy) must not take
 * the app shell down: close the dialog and tell the user what to do.
 */
class SettingsLoadBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function ProjectShareDialog({ projectId }: { projectId: string }) {
  const setShareProjectId = useStore((s) => s.setShareProjectId);
  const { data: project } = useProject(projectId);
  // Close first, clear the store afterwards: unmounting an open dialog skips
  // Radix's close sequence, which is what returns focus to the menu trigger.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => {
      if (useStore.getState().shareProjectId === projectId) {
        setShareProjectId(null);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [open, projectId, setShareProjectId]);
  return (
    <ShareDialog
      open={open}
      onOpenChange={setOpen}
      target={{ kind: 'project', projectId, label: project?.name }}
    />
  );
}

/**
 * The project Share and Settings dialogs, mounted once for the whole app. They
 * are driven by `shareProjectId` / `settingsProjectId` in the store, so the
 * sidebar rows and the project title can open them for any project, on any page.
 */
export function ProjectDialogsHost() {
  const shareProjectId = useStore((s) => s.shareProjectId);
  const settingsProjectId = useStore((s) => s.settingsProjectId);
  const setSettingsProjectId = useStore((s) => s.setSettingsProjectId);
  return (
    <>
      {shareProjectId && (
        <ProjectShareDialog key={shareProjectId} projectId={shareProjectId} />
      )}
      {settingsProjectId && (
        // Keyed by project so a failure for one project does not block the next.
        <SettingsLoadBoundary
          key={settingsProjectId}
          onError={() => {
            setSettingsProjectId(null);
            toast.error(
              'Could not load project settings. Reload the page and try again.',
            );
          }}
        >
          <Suspense fallback={null}>
            <ProjectSettingsDialog />
          </Suspense>
        </SettingsLoadBoundary>
      )}
    </>
  );
}
