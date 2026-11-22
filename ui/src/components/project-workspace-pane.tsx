import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ComponentProps,
  CSSProperties,
  PointerEvent,
  ReactNode,
} from 'react';
import { PreviewPane } from '@/components/chat/preview-pane';
import type { BrowserAnnotationSubmission } from '@/components/chat/browser-tab';

type PreviewPaneProps = ComponentProps<typeof PreviewPane>;

interface WorkspacePaneHost {
  id: string;
  element: HTMLElement;
  props: PreviewPaneProps;
}

interface WorkspacePanePersistence {
  register: (host: WorkspacePaneHost) => void;
  update: (host: WorkspacePaneHost) => void;
  unregister: (id: string) => void;
}

const WorkspacePanePersistenceContext =
  createContext<WorkspacePanePersistence | null>(null);

function PersistentWorkspaceSurface({ host }: { host: WorkspacePaneHost }) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    const element = host.element;
    const measure = () => setRect(element.getBoundingClientRect());
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
    };
  }, [host.element]);

  const visible = !!rect && rect.width > 0 && rect.height > 0;
  return (
    <div
      data-ui="persistent-workspace-surface"
      className="flex min-h-0"
      style={{
        position: 'fixed',
        left: rect?.left ?? 0,
        top: rect?.top ?? 0,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        zIndex: 30,
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      <PreviewPane {...host.props} />
    </div>
  );
}

/**
 * Own the right-hand workspace pane above route boundaries. Chat and Kanban
 * routes only render a layout slot, so switching modes within a project moves
 * the same pane instance instead of unmounting and reloading it.
 */
export function WorkspacePanePersistenceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const hosts = useRef(new Map<string, WorkspacePaneHost>());
  const activeHostId = useRef<string | null>(null);
  const unregisterGeneration = useRef(0);
  const [host, setHost] = useState<WorkspacePaneHost | null>(null);

  const register = useCallback((nextHost: WorkspacePaneHost) => {
    unregisterGeneration.current += 1;
    hosts.current.set(nextHost.id, nextHost);
    activeHostId.current = nextHost.id;
    setHost(nextHost);
  }, []);
  const update = useCallback((nextHost: WorkspacePaneHost) => {
    hosts.current.set(nextHost.id, nextHost);
    if (activeHostId.current === nextHost.id) setHost(nextHost);
  }, []);
  const unregister = useCallback((id: string) => {
    hosts.current.delete(id);
    if (activeHostId.current !== id) return;
    const generation = ++unregisterGeneration.current;
    // Route replacement unmounts the old slot before mounting the new one in
    // the same commit. Defer removal so the hand-off never unmounts the pane.
    queueMicrotask(() => {
      if (unregisterGeneration.current !== generation) return;
      const replacement = Array.from(hosts.current.values()).at(-1) ?? null;
      activeHostId.current = replacement?.id ?? null;
      setHost(replacement);
    });
  }, []);
  const persistence = useMemo(
    () => ({ register, update, unregister }),
    [register, unregister, update],
  );

  return (
    <WorkspacePanePersistenceContext.Provider value={persistence}>
      {children}
      {host && <PersistentWorkspaceSurface host={host} />}
    </WorkspacePanePersistenceContext.Provider>
  );
}

function PersistentPreviewPane(props: PreviewPaneProps) {
  const persistence = useContext(WorkspacePanePersistenceContext);
  const id = useId();
  const element = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!persistence || !element.current) return;
    persistence.register({ id, element: element.current, props });
    return () => persistence.unregister(id);
  }, [id, persistence]);
  useLayoutEffect(() => {
    if (!persistence || !element.current) return;
    persistence.update({ id, element: element.current, props });
  }, [id, persistence, props]);

  if (!persistence) return <PreviewPane {...props} />;
  return (
    <div
      ref={element}
      data-ui="workspace-pane-host"
      className="h-full min-h-0 w-full"
    />
  );
}

export function ProjectWorkspacePane({
  projectId,
  conversationId,
  taskId,
  width,
  onResize,
  onResizeCancel,
  onClose,
  onFileOpen,
  onAnnotationSubmitted,
  onProjectSetup,
  marker,
  children,
}: {
  projectId: string;
  conversationId: string | null;
  taskId?: string | null;
  width: number;
  onResize: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeCancel?: () => void;
  onClose: () => void;
  onFileOpen: () => void;
  onAnnotationSubmitted?: (submission: BrowserAnnotationSubmission) => void;
  onProjectSetup?: () => void;
  marker: string;
  children?: ReactNode;
}) {
  useEffect(() => {
    return () => onResizeCancel?.();
  }, [onResizeCancel]);

  return (
    <div
      data-ui={marker}
      className="absolute inset-0 z-30 flex min-h-0 w-full bg-background sm:relative sm:inset-auto sm:z-auto sm:shrink-0 sm:w-[var(--artifacts-panel-width)]"
      style={{ '--artifacts-panel-width': `${width}px` } as CSSProperties}
    >
      <div
        data-ui="workspace-pane-resize"
        onPointerDown={onResize}
        className="absolute left-0 top-0 z-[31] hidden h-full w-1 touch-none cursor-col-resize bg-border transition-colors hover:bg-primary/50 sm:block [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-y-0 [@media(pointer:coarse)]:after:-inset-x-2"
        title="Drag to resize"
      />
      {children ?? (
        <PersistentPreviewPane
          project_id={projectId}
          conversation_id={conversationId}
          taskId={taskId}
          onClose={onClose}
          onFileOpen={onFileOpen}
          onAnnotationSubmitted={onAnnotationSubmitted}
          onProjectSetup={onProjectSetup}
          workspaceViewScope="project"
        />
      )}
    </div>
  );
}
