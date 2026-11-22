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
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Play, RotateCcw, Square } from 'lucide-react';
import {
  attachBrowserViewer,
  fetchBrowserSessions,
  controlBrowserSession,
} from '@/lib/api';
import { Select, SelectItem } from '@/components/ui/select';
import { API_BASE_URL } from '@/lib/api-config';
import { withAppUrlScheme } from '@/lib/browser-app-url';
import type { BrowserSession } from '@/types';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { FieldRow } from '@/components/ui/field-row';
import { useMediaQuery } from '@/hooks/use-media-query';
import { ToolbarIconButton, WorkspaceToolbar } from './workspace-toolbar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type ViewerState =
  | 'connecting'
  | 'waiting'
  | 'connected'
  | 'disconnected'
  | 'ended';

/** Status dot of the connection line; the text beside it carries the meaning. */
const STATE_DOT: Record<ViewerState, string> = {
  connected: 'var(--status-completed)',
  connecting: 'var(--status-in-progress)',
  waiting: 'var(--status-backlog)',
  disconnected: 'var(--status-failed)',
  ended: 'var(--status-failed)',
};

export interface BrowserAnnotationSubmission {
  frames: Array<{
    data: string;
    title?: string;
    url?: string;
  }>;
  feedback: string;
}

interface BrowserTabProps {
  projectId: string;
  conversationId: string | null;
  taskId?: string | null;
  active: boolean;
  onAnnotationSubmitted?: (submission: BrowserAnnotationSubmission) => void;
}

interface BrowserTabHost {
  id: string;
  element: HTMLDivElement;
  props: BrowserTabProps;
}

interface BrowserTabPersistence {
  register: (host: BrowserTabHost) => void;
  update: (host: BrowserTabHost) => void;
  unregister: (id: string) => void;
}

const BrowserTabPersistenceContext =
  createContext<BrowserTabPersistence | null>(null);

function BrowserTabContent({
  projectId,
  conversationId,
  taskId,
  active,
  onAnnotationSubmitted,
}: BrowserTabProps) {
  const {
    data: sessions = [],
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: ['browser-sessions', projectId, conversationId],
    queryFn: () => fetchBrowserSessions(projectId, conversationId),
    enabled: active,
    refetchInterval: active ? 3000 : false,
    placeholderData: (previous) => previous,
  });
  const [sessionId, setSessionId] = useState<string>('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    'restart' | 'close' | null
  >(null);
  const confirmationTrigger = useRef<HTMLButtonElement>(null);
  const [detached, setDetached] = useState(false);
  const [state, setState] = useState<ViewerState>('waiting');
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<{
    viewerId: string;
    src: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [touchMode, setTouchMode] = useState<'scroll' | 'drag'>('scroll');
  // Touch gestures only exist where a touch screen does.
  const coarsePointer = useMediaQuery('(any-pointer: coarse)');
  const iframe = useRef<HTMLIFrameElement>(null);
  const syncTouchMode = useCallback(() => {
    if (!connection) return;
    iframe.current?.contentWindow?.postMessage(
      {
        type: 'carapa-browser-touch-mode',
        viewerId: connection.viewerId,
        mode: touchMode,
      },
      new URL(connection.src).origin,
    );
  }, [connection, touchMode]);
  useEffect(syncTouchMode, [syncTouchMode]);
  const browserContext = useRef({ projectId, conversationId, taskId });
  useEffect(() => {
    const previous = browserContext.current;
    browserContext.current = { projectId, conversationId, taskId };
    if (
      previous.projectId === projectId &&
      previous.conversationId === conversationId &&
      previous.taskId === taskId
    )
      return;
    const selectedScope = sessions.find(
      (session) => session.sessionId === sessionId,
    )?.scope;
    // The default-branch viewer belongs to the project rather than a chat or
    // task. Keep that exact iframe connection while route context changes.
    if (previous.projectId === projectId && selectedScope === 'default') return;
    setSessionId('');
    setDetached(false);
    setUrl('');
    setConnection(null);
    setError('');
    setState('waiting');
  }, [conversationId, projectId, sessionId, sessions, taskId]);
  useEffect(() => {
    if (!active || sessionId || !sessions.length) return;
    const preferred = sessions.find((session) =>
      taskId
        ? session.taskId === taskId
        : conversationId && session.conversationId === conversationId,
    );
    setSessionId(
      (
        preferred ||
        sessions.find((session) => session.scope === 'default') ||
        sessions[0]
      ).sessionId,
    );
  }, [active, sessions, sessionId, conversationId, taskId]);
  const exists = sessions.some((session) => session.sessionId === sessionId);
  useEffect(() => {
    setPendingAction(null);
  }, [active, projectId, conversationId, taskId, sessionId, exists]);
  useEffect(() => {
    if (!active || !sessionId || !exists || detached) {
      setConnection(null);
      if (sessionId && !exists) setState('ended');
      return;
    }
    let disposed = false;
    setState('connecting');
    setError('');
    setConnection(null);
    void attachBrowserViewer(projectId, sessionId)
      .then(({ viewerId, ticket }) => {
        if (disposed) return;
        const url = new URL(
          `${API_BASE_URL}/browser-viewer/index.html?ws=carapa`,
          window.location.origin,
        );
        url.hash = new URLSearchParams({
          viewerId,
          ticket,
          parentOrigin: window.location.origin,
        }).toString();
        setConnection({ viewerId, src: url.toString() });
      })
      .catch((error) => {
        if (!disposed) {
          setError(String(error.message || error));
          setState('disconnected');
        }
      });
    return () => {
      disposed = true;
    };
  }, [active, projectId, sessionId, exists, attempt, detached]);
  // Install the receiver in the iframe's commit, before the viewer can send its
  // first status. A passive effect can miss it and leave the pane connecting.
  useLayoutEffect(() => {
    if (!connection) return;
    const origin = new URL(connection.src).origin;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== iframe.current?.contentWindow ||
        event.origin !== origin ||
        event.data?.viewerId !== connection.viewerId
      )
        return;
      if (event.data.type === 'carapa-browser-annotation') {
        if (
          !Array.isArray(event.data.frames) ||
          !event.data.frames.every(
            (frame: unknown) =>
              !!frame &&
              typeof frame === 'object' &&
              typeof (frame as { data?: unknown }).data === 'string',
          )
        )
          return;
        onAnnotationSubmitted?.({
          frames: event.data.frames.map(
            (frame: { data: string; title?: string; url?: string }) => ({
              data: frame.data,
              title: typeof frame.title === 'string' ? frame.title : undefined,
              url: typeof frame.url === 'string' ? frame.url : undefined,
            }),
          ),
          feedback:
            typeof event.data.feedback === 'string' ? event.data.feedback : '',
        });
        return;
      }
      if (event.data.type !== 'carapa-browser-status') return;
      const next = event.data.state as ViewerState;
      if (!['waiting', 'connected', 'disconnected', 'ended'].includes(next))
        return;
      setState((previous) => (previous === 'ended' ? previous : next));
      if (typeof event.data.error === 'string') setError(event.data.error);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [connection, onAnnotationSubmitted]);
  const selected = sessions.find((session) => session.sessionId === sessionId);
  const sessionLabel = (session: BrowserSession) =>
    `${
      session.scope === 'default'
        ? 'Default branch'
        : session.taskId
          ? `Task ${session.taskId}`
          : session.conversationId === conversationId
            ? 'This conversation'
            : `Conversation ${session.conversationId}`
    } · ${
      session.scope === 'run'
        ? session.agentName || 'Agent'
        : session.worktree
          ? 'Worktree'
          : 'Main workspace'
    }`;
  // The trigger truncates in a narrow pane; the title carries the full label.
  const selectedLabel = selected ? sessionLabel(selected) : undefined;
  const persistent = selected && selected.scope !== 'run';
  // The viewer reports `waiting` while the browser has no open session: Restart
  // and Close have nothing to act on (Start opens one) but keep their place.
  const noBrowser = state === 'waiting';
  const context = useRef({ projectId, sessionId });
  context.current = { projectId, sessionId };
  const control = async (action: 'start' | 'restart' | 'close') => {
    const target = context.current;
    setBusy(true);
    setError('');
    try {
      await controlBrowserSession(
        target.projectId,
        target.sessionId,
        action,
        action === 'close' ? undefined : withAppUrlScheme(url) || undefined,
      );
      if (
        context.current.projectId !== target.projectId ||
        context.current.sessionId !== target.sessionId
      )
        return;
      setDetached(action === 'close');
      if (action === 'close') setState('waiting');
      else setAttempt((value) => value + 1);
      void refetch();
    } catch (error) {
      if (
        context.current.projectId === target.projectId &&
        context.current.sessionId === target.sessionId
      )
        setError(
          error instanceof Error ? error.message : 'Browser command failed',
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      data-ui="browser-tab"
      data-session-id={sessionId || undefined}
      className="flex h-full min-h-0 flex-col overflow-y-auto"
    >
      <WorkspaceToolbar
        data-ui="browser-connection-controls"
        className="@container flex-row flex-wrap items-center pr-2"
      >
        <Select
          compact
          aria-label="Browser session"
          title={selectedLabel}
          className="order-1 min-w-0 flex-1"
          value={sessionId}
          onValueChange={(nextValue) => {
            setSessionId(nextValue);
            setDetached(false);
            setUrl('');
          }}
        >
          {!sessionId && (
            <SelectItem value="">Select a browser session</SelectItem>
          )}
          {sessionId && !exists && (
            <SelectItem value={sessionId}>Session unavailable</SelectItem>
          )}
          {sessions.map((session) => (
            <SelectItem key={session.sessionId} value={session.sessionId}>
              {sessionLabel(session)}
            </SelectItem>
          ))}
        </Select>
        {/* Icon actions never move: Reconnect is always the right-most. */}
        <div
          data-ui="browser-actions"
          className="order-3 flex shrink-0 items-center gap-1.5"
        >
          {persistent && (
            <>
              <ToolbarIconButton
                size="icon-sm"
                label="Restart browser"
                tooltip={
                  noBrowser
                    ? 'Restart browser (no browser is running)'
                    : 'Restart browser (interrupts the agent and clears cookies and tabs)'
                }
                disabled={busy || noBrowser}
                onClick={(event) => {
                  confirmationTrigger.current = event.currentTarget;
                  setPendingAction('restart');
                }}
              >
                <RotateCcw className="size-3.5" />
              </ToolbarIconButton>
              <ToolbarIconButton
                size="icon-sm"
                label="Close browser"
                tooltip={
                  noBrowser
                    ? 'Close browser (no browser is running)'
                    : 'Close browser (ends the shared browser session for you and the agent)'
                }
                disabled={busy || noBrowser}
                onClick={(event) => {
                  confirmationTrigger.current = event.currentTarget;
                  setPendingAction('close');
                }}
              >
                <Square className="size-3.5" />
              </ToolbarIconButton>
            </>
          )}
          <ToolbarIconButton
            size="icon-sm"
            label="Reconnect browser"
            tooltip="Reconnect browser (refreshes your view without interrupting the agent)"
            onClick={() => {
              setDetached(false);
              void refetch();
              setAttempt((value) => value + 1);
            }}
          >
            <RefreshCw className="size-3.5" />
          </ToolbarIconButton>
        </div>
        <div
          data-ui="browser-status"
          className="order-5 flex min-w-0 basis-full items-center gap-2 text-xs text-muted-foreground"
        >
          <p
            className="min-w-0 flex-1 truncate"
            title={selected?.worktree ?? undefined}
          >
            <span
              aria-hidden
              className="mr-1.5 inline-block size-1.5 rounded-full align-middle"
              style={{ backgroundColor: STATE_DOT[state] }}
            />
            <span data-ui="browser-connection-state">{state}</span>
            {' · '}
            <span>
              {selected?.scope === 'default'
                ? 'Project browser'
                : 'Shared with agent'}
            </span>
            {selected?.scope === 'conversation' && !selected.runId && (
              <>
                {' · '}
                <span>Agent idle</span>
              </>
            )}
            {selected?.worktree && (
              <span data-ui="browser-worktree">
                {' · '}
                {selected.worktree}
              </span>
            )}
          </p>
          {connection && coarsePointer && (
            <Select
              compact
              aria-label="Browser touch mode"
              title={
                touchMode === 'drag'
                  ? 'Drag to interact · Pinch to zoom in the app'
                  : 'Swipe to scroll · Pinch to magnify the viewer'
              }
              className="w-24 shrink-0"
              value={touchMode}
              onValueChange={(nextValue) =>
                setTouchMode(nextValue === 'drag' ? 'drag' : 'scroll')
              }
            >
              <SelectItem value="scroll">Scroll</SelectItem>
              <SelectItem value="drag">Drag</SelectItem>
            </Select>
          )}
        </div>
        {error && state === 'connected' && (
          <p
            role="alert"
            className="order-5 basis-full text-xs text-destructive"
          >
            {error}
          </p>
        )}
        {persistent && state !== 'connected' && (
          <FieldRow
            as="form"
            compact
            className="order-6 basis-full @xl:order-2 @xl:basis-0 @xl:flex-[2]"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void control('start');
            }}
          >
            <Input
              aria-label="App URL"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={
                selected.worktree
                  ? 'Auto: worktree preview URL (scheme optional)'
                  : 'Auto: project app URL (scheme optional)'
              }
              compact
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="outline" size="sm" disabled={busy}>
              <Play className="size-3" />
              {busy ? 'Starting…' : 'Start browser'}
            </Button>
          </FieldRow>
        )}
      </WorkspaceToolbar>
      <div data-ui="browser-viewport" className="relative h-full shrink-0">
        {connection && (
          <iframe
            ref={iframe}
            key={connection.viewerId}
            src={connection.src}
            onLoad={syncTouchMode}
            title="Agent browser"
            data-ui="browser-viewer"
            sandbox="allow-scripts allow-same-origin allow-downloads"
            allow="autoplay"
            referrerPolicy="no-referrer"
            className="block h-full w-full border-0"
          />
        )}
        {state !== 'connected' && (
          <div
            data-ui="browser-empty-state"
            className="absolute inset-0 flex items-center justify-center bg-background/95 p-6 text-center text-sm text-muted-foreground"
          >
            {error ||
              (queryError instanceof Error ? queryError.message : null) ||
              (state === 'connecting'
                ? 'Connecting to the agent browser…'
                : state === 'ended'
                  ? 'This browser session is no longer available.'
                  : state === 'disconnected'
                    ? 'Browser disconnected. Use Reconnect to rejoin the session.'
                    : sessions.length
                      ? persistent
                        ? 'Start a browser here, or let the agent open one. Its address bar lets you navigate the app.'
                        : 'Waiting for the agent to open a browser…'
                      : 'No browser sessions available.')}
          </div>
        )}
      </div>
      <Dialog
        open={active && exists && pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
      >
        <DialogContent
          data-ui="browser-action-confirmation-dialog"
          className="sm:max-w-md"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            confirmationTrigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {pendingAction === 'restart'
                ? 'Restart browser?'
                : 'Close browser?'}
            </DialogTitle>
            <DialogDescription>
              {pendingAction === 'restart'
                ? 'This will interrupt the agent’s browser work and clear the shared browser’s cookies and open tabs.'
                : 'This will end the shared browser session for you and the agent, interrupting any browser work in progress.'}{' '}
              If the preview is blank or stuck, cancel and use Reconnect browser
              to refresh your view without interrupting the agent.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAction(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!pendingAction || busy) return;
                const action = pendingAction;
                setPendingAction(null);
                void control(action);
              }}
            >
              {pendingAction === 'restart'
                ? 'Restart browser'
                : 'Close browser'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PersistentBrowserSurface({ host }: { host: BrowserTabHost }) {
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
  }, [host.element, host.props.active]);

  const visible =
    host.props.active && !!rect && rect.width > 0 && rect.height > 0;
  return (
    <div
      data-ui="persistent-browser-surface"
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
      <BrowserTabContent {...host.props} active={visible} />
    </div>
  );
}

/**
 * Own the browser viewer above route boundaries. Right-pane BrowserTab
 * instances only provide a layout slot, so chat and mode navigation can move
 * the same iframe without reconnecting or flashing an empty viewer.
 */
export function BrowserTabPersistenceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const hosts = useRef(new Map<string, BrowserTabHost>());
  const activeHostId = useRef<string | null>(null);
  const unregisterGeneration = useRef(0);
  const [host, setHost] = useState<BrowserTabHost | null>(null);

  const register = useCallback((nextHost: BrowserTabHost) => {
    unregisterGeneration.current += 1;
    hosts.current.set(nextHost.id, nextHost);
    activeHostId.current = nextHost.id;
    setHost(nextHost);
  }, []);
  const update = useCallback((nextHost: BrowserTabHost) => {
    hosts.current.set(nextHost.id, nextHost);
    if (activeHostId.current === nextHost.id) setHost(nextHost);
  }, []);
  const unregister = useCallback((id: string) => {
    hosts.current.delete(id);
    if (activeHostId.current !== id) return;
    const generation = ++unregisterGeneration.current;
    // Route replacement unmounts the old slot before mounting the new one in
    // the same commit. Defer removal so that hand-off never hides or unmounts
    // the persistent iframe between those two layout effects.
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
    <BrowserTabPersistenceContext.Provider value={persistence}>
      {children}
      {host && <PersistentBrowserSurface host={host} />}
    </BrowserTabPersistenceContext.Provider>
  );
}

export function BrowserTab(props: BrowserTabProps) {
  const persistence = useContext(BrowserTabPersistenceContext);
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

  if (!persistence) return <BrowserTabContent {...props} />;
  return (
    <div
      ref={element}
      data-ui="browser-tab-host"
      className="h-full min-h-0 w-full"
    />
  );
}
