import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Pencil, PlugZap, Plus, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { snapshotToTerminalText } from './terminal-snapshot';
import { normalizeTerminalTitle } from './terminal-title';

import { Button } from '@/components/ui/button';
import { confirmAction } from '@/components/confirm-dialog';
import { apiFetch } from '@/lib/api';
import {
  listProjectShells,
  startProjectShell,
  stopProjectShell,
  type ActiveRun,
  type ShellListEntry,
} from '@/lib/api';
import { API_BASE_URL } from '@/lib/api-config';
import { cn } from '@/lib/utils';

/**
 * Bash tab — live shell attached to a sandbox via tmux + SSE + xterm.js.
 *
 * Used in two places:
 *
 *  - chat explorer (right-side pane): renders a project-scoped strip of
 *    on-demand shells the user has spawned with the `+` button. Shells
 *    are per-project and independent from conversations, tasks, and
 *    agent runs — switching conversations within the same project
 *    keeps the same strip; switching projects swaps to that project's
 *    shells. Each tab maps to its own CarapaBox instance so the Docker
 *    containers don't collide.
 *  - kanban task detail dialog: binds to the on-demand sandbox that the
 *    dialog's "Start a shell" button brings up. Coordinates come from the
 *    parent (the dialog owns the start/stop lifecycle), so the tab just
 *    attaches to whatever it's given.
 *
 * Lifecycle (chat path):
 *  - On mount: rehydrate the project-scoped strip from a single GET
 *    round-trip. If the project has no shells yet, render an empty-
 *    state CTA explaining that shells are independent from
 *    conversations/tasks and offering a `Start a shell` button.
 *  - The strip is keyed by `project_id`, NOT `conversation_id` —
 *    switching conversations in the same project preserves the strip;
 *    switching projects swaps to that project's shells (or the empty
 *    CTA when the project has none).
 *  - When the user clicks `+`, a new shell tab is created; its backend
 *    instance is `${folder}-chat-${cid.slice(-6)}-${tabId}` so multiple
 *    shells per project don't collide on container names.
 *  - Closing a tab tears it down via DELETE /api/projects/:projectId/shells/:tabId.
 *    The shell strip collapses when the last tab closes
 *    so the empty-state CTA reappears.
 *  - Page refresh rehydrates the strip from a single `GET
 *    /api/projects/:projectId/shells` round-trip. The result is merged
 *    into local state on first arrival per project; subsequent refetches
 *    (every ~10s) are ignored so in-flight starts/closes aren't
 *    clobbered.
 *
 * Lifecycle (kanban path, `externallyControlled`):
 *  - Render a single terminal attached to the explicit coords. No shell
 *    strip, no `+` button. The parent owns the start/stop lifecycle and
 *    gets an `onDisconnect` callback to stop the underlying sandbox.
 *
 * Render surface: dark background, full height of the surrounding TabsContent,
 * monospace. Header strip matches the artifacts/changes tabs (right-aligned
 * buttons on top).
 */

/** Shell tab visible in the chat explorer's strip. */
type ShellTabState =
  | { status: 'starting' }
  | {
      status: 'ready';
      stack: string;
      service: string;
      instance: string;
      /** Per-tab tmux session name inside the shared container. The
       *  nested `<BashTab>` uses this as its `taskId` so each tab gets
       *  its own tmux session — scrollback / cursor / keystrokes stay
       *  isolated from sibling tabs sharing the same container. */
      tmuxSession?: string;
    }
  | { status: 'error'; message: string };

interface ChatShellTab {
  /** Client-generated id — sent to the server as the `tabId` body
   *  field so the per-tab tracker record is keyed by
   *  `${projectId}:${tabId}`. Lowercase / short so the resulting
   *  tmux session name stays safe even if the server's sanitizer is
   *  loose. */
  id: string;
  /** Human label shown in the tab strip — `Shell 1`, `Shell 2`, … */
  label: string;
  /** True once the user renamed the tab; it then wins over a program's title. */
  labelCustom?: boolean;
  /** Title the running program set (OSC 0/2); shown until the user renames the tab. */
  title?: string;
  shell: ShellTabState;
}

/** What the tab strip shows: the user's name, else the program's title, else `Shell N`. */
function tabText(tab: ChatShellTab): string {
  return (!tab.labelCustom && tab.title) || tab.label;
}

type Phase =
  | { status: 'idle' }
  | { status: 'no-active-run' }
  | { status: 'loading' }
  | { status: 'ready'; streamId: string; cols: number; rows: number }
  | { status: 'error'; message: string };

export type BashTabProps = {
  project_id: string;
  /** Required for the chat-explorer path (active-run lookup). Unused when
   *  explicit sandbox coordinates are supplied. */
  conversation_id: string | null;
  /** Optional explicit coordinates. When all three are provided we skip the
   *  active-run lookup — used by the task-detail-dialog bash tab. */
  stack?: string;
  service?: string;
  instance?: string;
  /**
   * Per-instance tmux session name. Used as the `taskId` seed when
   * opening the tmux session in the sandbox. The chat on-demand path
   * supplies a per-tab name (`shell-<tabId>`) so multiple tabs sharing
   * one container each get their own session; other callers omit it
   * and let the server derive a name from `conversation_id`.
   */
  tmuxSession?: string;
  /** When true, the parent (task-detail-dialog) owns the on-demand sandbox
   *  lifecycle. The tab won't render a "Start shell" affordance — it only
   *  shows the disconnect button when a stream is attached. */
  externallyControlled?: boolean;
  /** Fires after the tmux session ends naturally or is torn down by the
   *  Disconnect button. Parents use it to remove the shell view and clean up
   *  the on-demand shell record. */
  onDisconnect?: () => void | Promise<void>;
  /**
   * Fires once the xterm Terminal is mounted and the SSE stream is
   * open. The chat multi-shell strip uses this to grab a handle on
   * the inner Terminal so it can `term.focus()` it when the user
   * switches to that tab — without this, the user would have to
   * click inside the terminal after every tab switch because
   * browser focus doesn't auto-move between sibling `display:none`
   * containers. The callback runs synchronously at the moment
   * `phase` flips to `ready`; subsequent re-renders do NOT call it
   * again. The caller is responsible for guarding against stale
   * refs (see `lastTerminalRef` in the chat strip wrapper).
   */
  onReady?: (terminal: Terminal) => void;
  /** Fires when the program in the shell sets the terminal title (OSC 0/2). */
  onTitleChange?: (title: string) => void;
  /** Allow attaching to a running agent's active run. */
  allowActiveRunAttach?: boolean;
};

/** Generate a short, lowercase, identifier-safe id for a new shell tab. */
function newShellTabId(): string {
  const r = Math.random().toString(36).slice(2, 8);
  const t = Date.now().toString(36).slice(-4);
  return `${t}${r}`;
}

/** A normal shell redraws its prompt on SIGWINCH; TUIs need that redraw. */
function endsWithShellPrompt(screen: string): boolean {
  const lastLine = screen.trimEnd().split('\n').at(-1) ?? '';
  // Covers common bash/zsh prompts such as `user@host:path$`, `root#`, and
  // `%`, while deliberately not treating a TUI's `>` menu marker as a shell.
  return /(?:^|\s)(?:[\w.-]+@)?[\w./~:-]*[$#%]\s*$/.test(lastLine);
}

export function BashTab({
  project_id: _project_id,
  conversation_id,
  stack: stackProp,
  service: serviceProp,
  instance: instanceProp,
  tmuxSession: tmuxSessionProp,
  externallyControlled,
  onDisconnect,
  onReady,
  onTitleChange,
}: BashTabProps) {
  const hasExplicitCoords = !!stackProp && !!serviceProp && !!instanceProp;

  // Sandbox coordinates come exclusively from the parent (the on-demand
  // shell strip passes stack/service/instance for each tab). The chat
  // path's outer BashTab has no explicit coords and no active-run
  // lookup — it only manages the shell strip. Active agent runs are
  // NOT attachable: the agent runs headless and has no tmux pane.
  const resolvedRun: ActiveRun | null = useMemo(() => {
    if (hasExplicitCoords) {
      return {
        stack: stackProp!,
        service: serviceProp!,
        instance: instanceProp!,
        status: 'running',
      };
    }
    return null;
  }, [hasExplicitCoords, stackProp, serviceProp, instanceProp]);

  // Stable id used to look up the live phase from async callbacks.
  const runKey = resolvedRun
    ? `${resolvedRun.stack}/${resolvedRun.service}/${resolvedRun.instance}`
    : null;

  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  // Mirror the phase for the unmount cleanup hook so we can read the
  // current value without re-binding the effect.
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  // Cached stream id used by the disconnect handler even after the terminal
  // has been torn down (the Phase already advanced to 'idle' by then).
  const lastStreamIdRef = useRef<string | null>(null);

  // The nested BashTab (externallyControlled with explicit coords)
  // always attaches — the parent (shell strip) only renders it after
  // the on-demand sandbox is ready.
  const shouldAttach = externallyControlled || hasExplicitCoords;

  // Project-scoped on-demand shell state. The chat path owns its own
  // tab list — one entry per shell the user has spawned — and uses
  // that to render a strip at the top of the panel. Each entry owns
  // its own start/stop lifecycle and its own inner <BashTab> (rendered
  // in externallyControlled mode below).
  //
  // The list is rehydrated from the server on first mount (and on
  // project switches) so a refresh / cross-conversation switch
  // surfaces the same shells. Conversation switches within the same
  // project keep the local state — `useQuery` is keyed by `project_id`,
  // so the data is cached and no refetch happens.
  const [shellTabs, setShellTabs] = useState<ChatShellTab[]>([]);
  const [activeShellTabId, setActiveShellTabId] = useState<string | null>(null);
  // Tab id currently being renamed (inline input visible). Only one tab
  // at a time — the active one. null = no rename in progress.
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Server-backed enumeration of the project's on-demand shells. The
  // queryKey is project-scoped on purpose: a conversation switch in
  // the same project must NOT trigger a refetch (the strip stays put).
  const shellListQuery = useQuery<ShellListEntry[]>({
    queryKey: ['bashTab', 'shells', _project_id],
    queryFn: () => listProjectShells(_project_id),
    enabled: !!_project_id && !hasExplicitCoords && !externallyControlled,
    // Tracker changes arrive over the application WebSocket. Reconnect/focus
    // reconciles anything missed while this device was disconnected.
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });

  // Project id whose server shells we have already merged into the
  // local list. Reset on project change so the next project re-seeds
  // from its own server list.
  const mergedProjectIdRef = useRef<string | null>(null);

  // Wipe local shell state when the project changes so the rehydration
  // starts clean — switching projects must show that project's shells
  // (or the empty CTA when the project has none). Conversation switches
  // within the same project do NOT trigger this effect.
  useEffect(() => {
    setShellTabs([]);
    setActiveShellTabId(null);
    mergedProjectIdRef.current = null;
  }, [_project_id]);

  // Map<tabId, Terminal> — populated by each nested BashTab's
  // `onReady` callback once its xterm instance + SSE channel are
  // live. We use this to `term.focus()` the active tab's terminal
  // whenever the user clicks a different tab, so the user can
  // start typing without an extra click in the terminal area.
  // Switching tabs does NOT remount the underlying BashTab (we
  // render them all and toggle visibility), so each tab's
  // Terminal stays alive across switches — its `focus()` just
  // needs the user-triggered nudge the active-tab effect (below
  // `activeTab` is declared) provides. Browser focus does NOT
  // auto-move between sibling `display:none → flex` containers.
  const termHandlesRef = useRef<Map<string, Terminal>>(new Map());

  // Drop terminal handles for tabs that no longer exist (e.g.
  // the user closed a tab) so the map doesn't grow unbounded.
  useEffect(() => {
    const liveIds = new Set(shellTabs.map((t) => t.id));
    const handles = termHandlesRef.current;
    let mutated = false;
    for (const id of handles.keys()) {
      if (!liveIds.has(id)) {
        handles.delete(id);
        mutated = true;
      }
    }
    // No need to re-render on mutation — the handles ref is
    // only read by the auto-focus effect below, which fires
    // on activeTab.id changes anyway.
    if (mutated) {
      /* ref-only mutation; nothing to do */
    }
  }, [shellTabs]);

  // Reconcile successful server snapshots into the local tab strip. Ready
  // tabs absent from a later snapshot were closed server-side (notably when
  // their sandbox restarted), while starting/error tabs remain local so an
  // in-flight POST or retry UI is not clobbered.
  useEffect(() => {
    const data = shellListQuery.data;
    if (!data) return;
    const firstMerge = mergedProjectIdRef.current !== _project_id;
    mergedProjectIdRef.current = _project_id;
    setShellTabs((prev) => {
      // Several tabs share one sandbox instance. Match their stable tab IDs,
      // including a local tab whose POST is still awaiting its response.
      const localByTab = new Map(prev.map((tab) => [tab.id, tab]));
      const result: ChatShellTab[] = [];
      for (const s of data) {
        const existing = localByTab.get(s.shellTabId);
        if (existing) {
          result.push(existing);
          localByTab.delete(s.shellTabId);
        } else {
          const tabId = s.shellTabId || `rehydrated-${s.instance}`;
          // Restore the user's custom label from localStorage if one
          // was saved; otherwise fall back to the default numbering.
          let label = `Shell ${result.length + 1}`;
          let labelCustom = false;
          try {
            const saved = localStorage.getItem(
              `shell-label:${_project_id}:${tabId}`,
            );
            if (saved) {
              label = saved;
              labelCustom = true;
            }
          } catch {
            /* best-effort */
          }
          result.push({
            id: tabId,
            label,
            ...(labelCustom ? { labelCustom } : {}),
            shell: {
              status: 'ready',
              stack: s.stack,
              service: s.service,
              instance: s.instance,
              // Rehydrated tabs get the per-tab tmux session from the
              // server's tracker record so the nested BashTab attaches
              // to the SAME tmux session the user was working in (not
              // a fresh one that sees only empty scrollback).
              ...(s.tmuxSession ? { tmuxSession: s.tmuxSession } : {}),
            },
          });
        }
      }
      // During initial hydration only, preserve ready local entries created
      // before the first GET completed. On later snapshots, absence means closed.
      if (firstMerge) {
        for (const local of localByTab.values()) {
          if (local.shell.status !== 'ready') continue;
          result.push({ ...local, label: `Shell ${result.length + 1}` });
        }
      }
      for (const local of localByTab.values()) {
        if (local.shell.status !== 'ready') {
          result.push({ ...local, label: `Shell ${result.length + 1}` });
        }
      }
      return result;
    });
  }, [shellListQuery.data, _project_id]);

  // Refs for the xterm host div and the Terminal instance. We hold them in
  // refs because xterm.js is imperative — the lifecycle (open, write, fit,
  // dispose) has to run against the same DOM node across renders.
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const disposeOnDataRef = useRef<{ dispose: () => void } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  // Fires `onReady` exactly once per Terminal mount so the chat
  // multi-shell strip can grab the live Terminal handle and focus
  // it when the user activates this tab. Without this guard a
  // re-render that touches `phase` would re-fire onReady and stomp
  // the parent's ref to a different Terminal (the parent relies
  // on a stable handle per tab).
  const onReadyFiredRef = useRef(false);
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  // (Re)open the tmux stream whenever the resolved run changes. The cleanup
  // function closes the EventSource and disposes the Terminal — a fresh one
  // is opened on the next pass.
  useEffect(() => {
    if (!resolvedRun || !resolvedRun.instance) {
      setPhase({ status: 'no-active-run' });
      return;
    }
    // Attach only after an explicit user action. Chat active-run sessions use
    // the local Connect button; explicit-coordinate sessions are only rendered
    // by parents after their own user action.
    if (!shouldAttach) {
      setPhase({ status: 'idle' });
      return;
    }
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const url = `${API_BASE_URL}/api/sandboxes/${encodeURIComponent(resolvedRun.stack)}/${encodeURIComponent(resolvedRun.service)}/${encodeURIComponent(resolvedRun.instance)}/tmux/sessions`;
    const traceId = `${resolvedRun.stack}/${resolvedRun.service}/${resolvedRun.instance}/${tmuxSessionProp ?? conversation_id ?? 'unknown'}`;

    setPhase({ status: 'loading' });
    // eslint-disable-next-line no-console
    console.log('[bash-tab] attach start', { traceId, url, shouldAttach });

    // Host element + pushResize are hoisted so the async IIFE below can
    // call pushResize() on subsequent browser resizes. The INITIAL sizing
    // is handled in-mount by fitting xterm BEFORE the open POST (see
    // the IIFE) — that way carapa-box creates the tmux session at
    // xterm's measured cols/rows and we don't have to issue a post-open
    // resize that would re-wrap the captured scrollback.
    const hostEl = hostRef.current;
    const pushResize = () => {
      const streamId = lastStreamIdRef.current;
      const term = termRef.current;
      if (!streamId || !term || !term.cols || !term.rows) return;
      if (!hostEl || hostEl.clientWidth === 0 || hostEl.clientHeight === 0)
        return;
      void apiFetch(`${url}/${encodeURIComponent(streamId)}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: term.cols, rows: term.rows }),
      }).catch(() => undefined);
    };

    // Wait for the host element to have a non-zero size. The host lives
    // inside a Radix TabsContent with `forceMount` +
    // `data-[state=inactive]:hidden`, so on the frame the panel
    // transitions to visible the host can still report 0×0. Calling
    // `fit.fit()` against a 0-sized host locks the tmux pane to a
    // near-1×1 size and re-wraps scrollback at the wrong width. The
    // ResizeObserver fires AFTER the browser has laid the host out, so
    // its first non-zero callback gives us the real dimensions.
    //
    // `layoutWaitObserverRef` is captured so the cleanup hook can
    // disconnect the observer if the user unmounts before the host is
    // laid out — otherwise the observer would leak until the host
    // eventually got a non-zero size.
    const layoutWaitObserverRef: { current: ResizeObserver | null } = {
      current: null,
    };
    const waitForLayout = (): Promise<void> => {
      if (!hostEl) return Promise.resolve();
      if (hostEl.clientWidth > 0 && hostEl.clientHeight > 0) {
        return Promise.resolve();
      }
      if (typeof ResizeObserver === 'undefined') {
        // No ResizeObserver (test/jsdom paths). Best-effort: proceed —
        // the server-side validation still catches nonsense sizes.
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        let raf = 0;
        const finish = () => {
          ro.disconnect();
          if (raf) cancelAnimationFrame(raf);
          layoutWaitObserverRef.current = null;
          resolve();
        };
        // ResizeObserver: primary path. Fires when the host's box
        // changes (incl. the 0×0 → non-zero transition when the panel
        // becomes visible). However, ResizeObserver does NOT fire for
        // `display:none` elements (no layout to observe), so we pair it
        // with a `requestAnimationFrame` polling fallback that gives up
        // after a short budget if no size ever arrives. The fallback
        // resolves either when the host has size, or after 8 frames
        // (~133ms at 60Hz) — long enough for the browser to lay the
        // host out, short enough that the user never sees a hang.
        const ro = new ResizeObserver(() => {
          if (
            cancelled ||
            (hostEl.clientWidth > 0 && hostEl.clientHeight > 0)
          ) {
            finish();
          }
        });
        const poll = () => {
          if (cancelled) {
            finish();
            return;
          }
          if (hostEl.clientWidth > 0 && hostEl.clientHeight > 0) {
            finish();
            return;
          }
          if (++raf > 8) {
            // Give up after 8 frames: even if the host stays at 0×0
            // (e.g. inside a hidden panel), we must not hang the
            // attach. xterm will fall back to the server default of
            // 200×50, which is no worse than before.
            // eslint-disable-next-line no-console
            console.warn(
              '[bash-tab] waitForLayout: gave up polling (host still 0×0)',
              { traceId },
            );
            finish();
            return;
          }
          raf = window.requestAnimationFrame(poll);
        };
        layoutWaitObserverRef.current = ro;
        ro.observe(hostEl);
        raf = window.requestAnimationFrame(poll);
      });
    };

    // The mount path:
    //  1. Wait for the host to have a non-zero size.
    //  2. Mount xterm and fit it — `term.cols` / `term.rows` are now real.
    //  3. POST open with those dims so carapa-box creates the tmux
    //     session at xterm's width from the first paint. The init
    //     `scrollback` is then captured at that width, so no
    //     post-open resize is needed (the previous `queueMicrotask`
    //     that re-fit+resized here caused the cursor to land at the
    //     end of the wrapped/repositioned bytes).
    //  4. Wire SSE; the scrollback arrives pre-sized for the render
    //     width.
    (async () => {
      try {
        // eslint-disable-next-line no-console
        console.log('[bash-tab] before waitForLayout', { traceId });
        await waitForLayout();
        // eslint-disable-next-line no-console
        console.log('[bash-tab] after waitForLayout', {
          traceId,
          hostW: hostRef.current?.clientWidth,
          hostH: hostRef.current?.clientHeight,
          cancelled,
        });
        if (cancelled) return;

        if (!hostRef.current) {
          // Effect cleanup already ran or the host was never attached.
          // eslint-disable-next-line no-console
          console.warn('[bash-tab] hostRef is null after waitForLayout', {
            traceId,
          });
          return;
        }

        // Mount the xterm Terminal against the host div (one-time per pass).
        // No `convertEol`: live output is the pane's raw byte stream and TUIs
        // rely on a bare `\n` not returning the carriage (see
        // terminal-snapshot.ts). Only the capture-pane snapshot is converted.
        const term = new Terminal({
          cursorBlink: true,
          fontFamily:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          fontSize: 12,
          scrollback: 5000,
          theme: {
            // Deliberate exception: the terminal stays dark in both themes
            // (a shell surface), so these raw hex values are not re-themed.
            background: '#000000',
            foreground: '#e5e7eb',
            cursor: '#e5e7eb',
            selectionBackground: '#264f78',
          },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(hostRef.current);
        // xterm.js does NOT auto-focus the terminal after `open()` — the
        // host div is plain (no tabIndex) and the renderer creates its own
        // internal layers, but keyboard events only fire `term.onData`
        // when the terminal has focus. Without an explicit focus call,
        // the user sees the prompt render and the cursor blink but
        // nothing happens when they type. The host div is given an
        // `onMouseDown` so any click on the terminal area re-focuses
        // (see below); here we focus once on mount so the user can
        // start typing immediately without having to click first.
        try {
          term.focus();
        } catch {
          /* focus can throw if the host is detached — best-effort */
        }
        // fit() can throw on first mount in some edge cases (zero width
        // sneaking through, unmounted DOM node). Treat as best-effort:
        // if it fails we fall back to the server default of 200×50, which
        // is no worse than before.
        try {
          fit.fit();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[bash-tab] fit.fit() threw', { traceId, err });
          /* best-effort */
        }
        // Re-focus after `fit.fit()` — `fit()` rebuilds the canvas and
        // may steal focus to the host. Doing focus AFTER fit means the
        // user can type right away on mount.
        try {
          term.focus();
        } catch {
          /* best-effort */
        }
        // Re-fit on the next animation frame. `waitForLayout` may have
        // given up while the host was still 0×0 (the parent flex column
        // often hasn't settled on the first frame), so the first
        // `fit.fit()` may have used xterm's 80×24 default. By the time
        // the next frame paints, the parent has finished laying out and
        // the host has its real dimensions — re-fitting here resizes the
        // canvas to match. We also push the new dims to carapa-box via
        // the resize endpoint so tmux knows the new size and the next
        // capture-pane is at the correct width.
        requestAnimationFrame(() => {
          if (cancelled) return;
          if (!hostEl) return;
          if (hostEl.clientWidth > 0 && hostEl.clientHeight > 0) {
            try {
              fit.fit();
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn('[bash-tab] rAF fit.fit() threw', { traceId, err });
            }
            try {
              term.focus();
            } catch {
              /* best-effort */
            }
            // eslint-disable-next-line no-console
            console.log('[bash-tab] rAF re-fit resolved', {
              traceId,
              cols: term.cols,
              rows: term.rows,
              hostW: hostEl.clientWidth,
              hostH: hostEl.clientHeight,
            });
            // Push the new dims to carapa-box. lastStreamIdRef is set
            // just below — read it via the local variable scope instead.
            const streamId = lastStreamIdRef.current;
            if (streamId && term.cols && term.rows) {
              void apiFetch(`${url}/${encodeURIComponent(streamId)}/resize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cols: term.cols, rows: term.rows }),
              }).catch(() => undefined);
            }
          }
        });
        // eslint-disable-next-line no-console
        console.log('[bash-tab] xterm mounted', {
          traceId,
          cols: term.cols,
          rows: term.rows,
        });

        // taskId seed: for the chat path we use the conversation_id,
        // which is a stable, unique per-conversation string. The server
        // stores per-stream scrollback in `store/tmux/<taskId>.log`
        // keyed on this value, so the chat and task buffer files never
        // collide. The chat on-demand multi-tab path threads an
        // explicit per-tab session name (`shell-<tabId>`) so each tab
        // sharing the same container gets its own tmux session; when
        // present it wins over the conversation_id seed.
        const taskId = tmuxSessionProp
          ? // The session name is scoped by the sandbox container, but replay
            // logs live board-wide. Qualify the buffer identity by project so
            // equally-named tabs in different projects never share scrollback.
            `project-${_project_id}-${tmuxSessionProp}`
          : externallyControlled
            ? `${resolvedRun.stack}-${resolvedRun.service}-${resolvedRun.instance}`
            : (conversation_id ??
              `${resolvedRun.stack}-${resolvedRun.service}-${resolvedRun.instance}`);

        // eslint-disable-next-line no-console
        console.log('[bash-tab] open POST start', {
          traceId,
          taskId,
          cols: term.cols,
          rows: term.rows,
        });
        const openRes = await apiFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId,
            ...(tmuxSessionProp ? { sessionId: tmuxSessionProp } : {}),
            cols: term.cols,
            rows: term.rows,
          }),
        });
        // eslint-disable-next-line no-console
        console.log('[bash-tab] open POST returned', {
          traceId,
          status: openRes.status,
          ok: openRes.ok,
        });
        if (!openRes.ok) {
          const text = await openRes.text().catch(() => '');
          // eslint-disable-next-line no-console
          console.error('[bash-tab] open POST non-ok', {
            traceId,
            status: openRes.status,
            body: text,
          });
          throw new Error(
            `open tmux session failed: HTTP ${openRes.status}${text ? ` ${text}` : ''}`,
          );
        }
        const opened = (await openRes.json()) as {
          streamId: string;
          cols: number;
          rows: number;
          sessionName: string;
        };
        // eslint-disable-next-line no-console
        console.log('[bash-tab] open POST JSON parsed', {
          traceId,
          streamId: opened.streamId,
          sessionName: opened.sessionName,
          cols: opened.cols,
          rows: opened.rows,
        });
        if (cancelled) {
          // React already unmounted us before the open POST landed.
          // The board route (`DELETE /api/projects/:projectId/shells/:tabId`
          // with the matching tabId) is the single source of truth
          // for "kill this tab's tmux session" — we don't issue a
          // duplicate DELETE from the cleanup hook because that
          // would race with the route's kill and (worse) fire on
          // every effect re-bind, not just genuine unmounts. The
          // server's per-tab tmux session is naturally reaped by
          // the box's tmux session TTL if no one calls the route.
          return;
        }
        lastStreamIdRef.current = opened.streamId;

        // Pipe keystrokes back to the tmux session as base64 — the
        // server-side wrapper decodes them before forwarding to
        // `tmux send-keys`. Base64 keeps escape sequences intact.
        const disposeOnData = term.onData((data) => {
          const encoded = btoa(unescape(encodeURIComponent(data)));
          void apiFetch(`${url}/${encodeURIComponent(opened.streamId)}/input`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: encoded }),
          }).catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[bash-tab] onData: /input POST failed', {
              traceId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        });
        termRef.current = term;
        fitRef.current = fit;
        // Stash the dispose so the cleanup hook can detach the listener.
        disposeOnDataRef.current = disposeOnData;
        // Programs name their tab with OSC 0/2; `term.dispose()` drops this listener.
        term.onTitleChange((title) =>
          onTitleChangeRef.current?.(normalizeTerminalTitle(title)),
        );

        // Open the SSE stream and route events into the terminal. Named
        // `replay` event is the buffered scrollback dump; default `data`
        // events are live chunks. The scrollback arrives already at
        // xterm's render width — no post-open fit/resize needed.
        const sseUrl = `${url}/${encodeURIComponent(opened.streamId)}/output`;
        // eslint-disable-next-line no-console
        console.log('[bash-tab] EventSource opening', { traceId, sseUrl });
        const es = new EventSource(sseUrl, { withCredentials: true } as any);
        let sseReplaySeen = false;
        let sseDataSeen = false;
        let tuiRepaintRequested = false;
        let sessionExitHandled = false;
        es.addEventListener('replay', (evt: MessageEvent) => {
          const isReconnectReplay = sseReplaySeen;
          if (!sseReplaySeen) {
            sseReplaySeen = true;
            // eslint-disable-next-line no-console
            console.log('[bash-tab] SSE replay event received', {
              traceId,
              bytes: typeof evt.data === 'string' ? evt.data.length : 0,
            });
          }
          try {
            const payload = JSON.parse(evt.data) as { chunk: string };
            if (payload?.chunk) {
              // EventSource reconnects automatically after a transient SSE
              // failure. The server then sends another *full* tmux snapshot.
              // Appending it is harmless for a line-oriented shell but breaks
              // TUIs: their cursor-control deltas are applied over two screen
              // images until the application next repaints. Queue a terminal
              // reset before every reconnect snapshot so it replaces the
              // screen atomically with respect to prior xterm writes.
              const snapshot = snapshotToTerminalText(payload.chunk);
              term.write(
                isReconnectReplay
                  ? `\x1bc\x1b[2J\x1b[H${snapshot}`
                  : snapshot,
              );
            }
            if (
              !tuiRepaintRequested &&
              tmuxSessionProp &&
              !isReconnectReplay &&
              !endsWithShellPrompt(payload?.chunk ?? '')
            ) {
              tuiRepaintRequested = true;
              // capture-pane gives us visible text but not the terminal's
              // cursor/alternate-buffer state. Nudge the pane through a
              // one-row resize cycle after the initial snapshot so TUIs
              // receive SIGWINCH and redraw their real screen immediately.
              // A normal shell merely observes a harmless resize.
              const cols = Math.max(1, term.cols || opened.cols);
              const rows = Math.max(1, term.rows || opened.rows);
              const resizeUrl = `${url}/${encodeURIComponent(opened.streamId)}/resize`;
              void apiFetch(resizeUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cols, rows: rows + 1 }),
              })
                .then(() =>
                  apiFetch(resizeUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cols, rows }),
                  }),
                )
                .catch(() => undefined);
            }
          } catch {
            /* malformed event — ignore */
          }
        });
        es.addEventListener('data', (evt: MessageEvent) => {
          if (!sseDataSeen) {
            sseDataSeen = true;
            // eslint-disable-next-line no-console
            console.log('[bash-tab] SSE first data event', {
              traceId,
              bytes: typeof evt.data === 'string' ? evt.data.length : 0,
            });
          }
          try {
            const payload = JSON.parse(evt.data) as { chunk: string };
            if (payload?.chunk) term.write(payload.chunk);
          } catch {
            /* malformed event — ignore */
          }
        });
        es.addEventListener('exit', (event) => {
          if (cancelled || sessionExitHandled) return;
          sessionExitHandled = true;
          es.close();
          eventSourceRef.current = null;
          lastStreamIdRef.current = null;
          let transportEnded = false;
          try {
            transportEnded =
              JSON.parse((event as MessageEvent).data).reason ===
              'transport-ended';
          } catch {
            // Older servers send shell exit without a usable payload.
          }
          if (transportEnded) {
            setPhase({ status: 'loading' });
            reconnectTimer = setTimeout(
              () => setReconnectAttempt((n) => n + 1),
              1000,
            );
            return;
          }
          setPhase({ status: 'no-active-run' });
          const callback = onDisconnectRef.current;
          if (callback) {
            void Promise.resolve(callback()).catch(() => undefined);
          }
        });
        es.onerror = () => {
          // eslint-disable-next-line no-console
          console.warn('[bash-tab] EventSource error', {
            traceId,
            readyState: es.readyState,
          });
          // The server-side route auto-closes on transport errors; from
          // here we just stop forwarding events. The next mount reopens.
        };
        eventSourceRef.current = es;

        setPhase({
          status: 'ready',
          streamId: opened.streamId,
          cols: opened.cols,
          rows: opened.rows,
        });
        // eslint-disable-next-line no-console
        console.log('[bash-tab] phase=ready', {
          traceId,
          streamId: opened.streamId,
        });
        // Hand the Terminal to the parent (chat multi-shell strip)
        // so it can focus us when this tab becomes active. Fires
        // exactly once per mount — see onReadyFiredRef's doc.
        if (onReady && !onReadyFiredRef.current) {
          onReadyFiredRef.current = true;
          try {
            onReady(term);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[bash-tab] onReady callback threw', { traceId, err });
          }
        }
      } catch (err) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[bash-tab] IIFE caught error', {
          traceId,
          err:
            err instanceof Error
              ? { message: err.message, stack: err.stack }
              : String(err),
        });
        setPhase({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    // ResizeObserver: refit on host-size changes so cols/rows stay in
    // sync after the initial mount. The initial mount sizes xterm
    // BEFORE the open POST (see the IIFE above) and forwards the
    // measured cols/rows to carapa-box, so the observer's first
    // synchronous callback can no longer find a missing termRef — the
    // term is already up. Subsequent browser-window resizes are
    // handled here.
    let ro: ResizeObserver | null = null;
    if (hostEl && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        const fit = fitRef.current;
        const term = termRef.current;
        if (!fit || !term) return;
        // Skip the initial 0×0 measurement. The host can briefly report
        // a zero size right after `term.open()` even with `forceMount`,
        // and fitting then would lock the tmux pane to a tiny size.
        if (hostEl.clientWidth === 0 || hostEl.clientHeight === 0) return;
        try {
          fit.fit();
        } catch {
          /* best-effort */
        }
        pushResize();
      });
      ro.observe(hostEl);
    }

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      // Disconnect the layout-wait observer if it's still pending. Without
      // this it would keep observing until the host gets a non-zero size,
      // at which point its callback would find `cancelled === true` and
      // disconnect on its own — disconnecting here is just a faster /
      // cleaner release.
      layoutWaitObserverRef.current?.disconnect();
      layoutWaitObserverRef.current = null;
      ro?.disconnect();
      // Tear down the SSE channel first so no late `data` events try to
      // write into a disposed Terminal. Closing the request only
      // unsubscribes — the tmux session itself stays alive so the user
      // can reopen this tab and see the same state. Killing the tmux
      // session is the board route's job (`DELETE
      // /api/projects/:projectId/shells/:tabId` with the matching tabId fires
      // `tmux-tool.sh kill <tmuxSession>` against the box), not this
      // cleanup hook — doing it here too would race with the route's
      // kill and (worse) fire spuriously on every effect re-bind
      // (runKey / shouldAttach change), which is exactly what tab
      // switches do. The board route is the single source of truth
      // for "this tab is closed, kill its tmux session".
      const es = eventSourceRef.current;
      if (es) {
        es.close();
        eventSourceRef.current = null;
      }
      const term = termRef.current;
      if (term) {
        disposeOnDataRef.current?.dispose();
        disposeOnDataRef.current = null;
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      }
      lastStreamIdRef.current = null;
      // Allow onReady to fire again on the next mount (post-disconnect
      // reconnect, or runKey change that triggers a full re-attach).
      // The ref guards against re-fires during the same mount's
      // re-renders; resetting here lets the parent's ref-track get
      // updated to the new Terminal once a fresh one comes up.
      onReadyFiredRef.current = false;
    };
    // runKey is the identity of the resolved sandbox; we intentionally
    // rebind on instance changes (e.g. chat swaps to a fresh run).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, shouldAttach, reconnectAttempt]);

  // ─── Multi-shell tab strip (chat-explorer path only) ─────────────────────
  // Each entry in `shellTabs` maps to its own CarapaBox instance, started
  // with a unique `tabId` so two shells in the same conversation don't
  // collide. The active tab is rendered as a nested <BashTab> in
  // externallyControlled mode so it owns its own terminal/SSE/tmux.

  const handleStartShell = useCallback(
    async (tabId: string) => {
      setShellTabs((prev) =>
        prev.map((t) =>
          t.id === tabId ? { ...t, shell: { status: 'starting' } } : t,
        ),
      );
      try {
        const shell = await startProjectShell(_project_id, tabId);
        setShellTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  shell: {
                    status: 'ready',
                    stack: shell.stack,
                    service: shell.service,
                    instance: shell.instance,
                    // Server returns the per-tab tmux session name (it
                    // derives it from `tabId`). Each tab's session is
                    // unique inside the shared container so scrollback
                    // / cursor / keystrokes stay isolated.
                    ...(shell.tmuxSession
                      ? { tmuxSession: shell.tmuxSession }
                      : {}),
                  },
                }
              : t,
          ),
        );
      } catch (err) {
        // Surface the error inline on the tab (rather than locking the
        // whole panel) so the user can retry, switch tabs, or close this
        // tab without the empty-state CTA reappearing.
        setShellTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  shell: {
                    status: 'error',
                    message: err instanceof Error ? err.message : String(err),
                  },
                }
              : t,
          ),
        );
      }
    },
    [_project_id],
  );

  const handleCloseShell = useCallback(
    async (tabId: string) => {
      // Pick the next active tab BEFORE we mutate state so we can
      // call `setActiveShellTabId` as a normal side effect, not from
      // inside the `setShellTabs` updater. In React 19 calling a
      // state setter from inside another setter's updater throws
      // "Cannot update a component while rendering a different
      // component" — which silently kills the await below and leaves
      // the backend with a still-alive sandbox the UI claims is gone.
      // Computing the target from the current `activeShellTabId`
      // outside the updater is safe because we only read it here;
      // the actual list mutation still happens via the updater.
      if (activeShellTabId === tabId) {
        const closedIdx = shellTabs.findIndex((t) => t.id === tabId);
        const nextSibling =
          shellTabs[closedIdx - 1]?.id ?? shellTabs[closedIdx + 1]?.id ?? null;
        setActiveShellTabId(nextSibling);
      }
      // Mark the tab as gone locally so the X button is unresponsive
      // to double-clicks; the server might be slow to acknowledge.
      setShellTabs((prev) => prev.filter((t) => t.id !== tabId));
      try {
        await stopProjectShell(_project_id, tabId);
      } catch (err) {
        // The on-demand index is cleared by the server even when the
        // stop call itself errors, so the local remove is correct either
        // way. Log for the operator; don't bring the tab back.
        // eslint-disable-next-line no-console
        console.error('Failed to stop project shell:', err);
      }
    },
    [_project_id, activeShellTabId, shellTabs],
  );

  // Closing a live shell kills its tmux session and any running process, so
  // ask first; errored or still-starting tabs have nothing to lose.
  const handleRequestCloseShell = useCallback(
    async (tab: ChatShellTab) => {
      if (tab.shell.status === 'ready') {
        const confirmed = await confirmAction(
          `Close ${tabText(tab)}? This ends the shell and any running process.`,
          { title: 'Close shell', confirmLabel: 'Close', destructive: true },
        );
        if (!confirmed) return;
      }
      await handleCloseShell(tab.id);
    },
    [handleCloseShell],
  );

  const handleStartRename = useCallback(
    (tabId: string, currentLabel: string) => {
      setRenamingTabId(tabId);
      setRenameValue(currentLabel);
    },
    [],
  );

  const handleCommitRename = useCallback(() => {
    const tabId = renamingTabId;
    const value = renameValue.trim();
    if (tabId && value) {
      setShellTabs((prev) =>
        prev.map((t) =>
          t.id === tabId ? { ...t, label: value, labelCustom: true } : t,
        ),
      );
      // Persist to localStorage so the label survives browser refresh.
      // Keyed by projectId:tabId so labels don't leak across projects.
      try {
        localStorage.setItem(`shell-label:${_project_id}:${tabId}`, value);
      } catch {
        /* best-effort */
      }
    }
    setRenamingTabId(null);
    setRenameValue('');
  }, [renamingTabId, renameValue, _project_id]);

  const handleAddShell = useCallback(() => {
    const id = newShellTabId();
    setShellTabs((prev) => [
      ...prev,
      {
        id,
        label: `Shell ${prev.length + 1}`,
        shell: { status: 'starting' },
      },
    ]);
    setActiveShellTabId(id);
    // Fire and forget — handleStartShell updates the tab's `shell` field
    // when the POST resolves (or rejects).
    void handleStartShell(id);
  }, [handleStartShell]);

  // Active tab resolution. If no tab is active but the strip is
  // non-empty, surface the first one so the user always sees a body.
  const activeTab =
    shellTabs.find((t) => t.id === activeShellTabId) ?? shellTabs[0] ?? null;

  // Auto-focus the terminal that just became active. Runs on
  // every activeTab change, including the initial render once a
  // tab is selected. Uses a microtask so the wrapper's
  // `display:none → flex` class change has a chance to commit
  // and xterm's textarea is reachable in the DOM. The terminal
  // handle is populated by the nested BashTab's `onReady`
  // callback (see `termHandlesRef` near the project-change
  // effect), so the first activation may find an empty slot if
  // the inner BashTab hasn't finished mounting yet — the focus
  // retry is handled by a follow-up effect on `shellTabs` change
  // below.
  useEffect(() => {
    if (!activeTab) return;
    const term = termHandlesRef.current.get(activeTab.id);
    if (!term) return;
    // Defer one microtask so the `isActive` className change in
    // the wrapper commits first — `term.focus()` on an element
    // that just went from `display:none` to `flex` works, but
    // running it before the layout pass can land focus on the
    // body instead of xterm's hidden textarea.
    queueMicrotask(() => {
      try {
        term.focus();
      } catch {
        /* best-effort — term might be mid-dispose */
      }
    });
  }, [activeTab?.id]);

  // On the FIRST mount of a freshly-added shell tab, the
  // onReady callback fires AFTER the activeTab effect above
  // runs (the IIFE inside the inner BashTab's useEffect is
  // async). When the user clicks `+ New shell`, that tab is
  // auto-selected and we need to focus its terminal once the
  // handle lands in the map. We re-run the focus attempt
  // whenever the active tab's terminal handle transitions from
  // undefined to defined.
  const prevHandleForActiveRef = useRef<Terminal | null>(null);
  useEffect(() => {
    if (!activeTab) {
      prevHandleForActiveRef.current = null;
      return;
    }
    const term = termHandlesRef.current.get(activeTab.id);
    if (term && term !== prevHandleForActiveRef.current) {
      queueMicrotask(() => {
        try {
          term.focus();
        } catch {
          /* best-effort */
        }
      });
    }
    prevHandleForActiveRef.current = term ?? null;
  }, [activeTab?.id, shellTabs]);

  // When the conversation path renders the multi-shell strip, the
  // existing single-shell "active run" flow is still available — it
  // shows its own terminal in the body if `resolvedRun` is set, but the
  // user can still spawn parallel on-demand shells from the strip.
  // We render the on-demand strip + the active-run terminal in the
  // same panel so the user can switch between them.
  const renderShellStrip = () => (
    <div
      role="tablist"
      aria-label="Conversation shells"
      className="flex items-stretch overflow-x-auto border-b border-border bg-muted/30"
    >
      {shellTabs.map((t) => {
        const active = t.id === activeTab?.id;
        const indicator =
          t.shell.status === 'starting'
            ? '…'
            : t.shell.status === 'error'
              ? '!'
              : '';
        return (
          <div
            key={t.id}
            data-ui="project-shell-tab"
            data-shell-tab-id={t.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => setActiveShellTabId(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActiveShellTabId(t.id);
              }
            }}
            className={[
              'group flex items-center gap-1.5 px-2 py-1.5 text-xs border-r border-border shrink-0 cursor-pointer outline-none focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-background text-foreground'
                : 'bg-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground',
              // Widen the tab while renaming so the input has room;
              // otherwise the default cap is 200px.
              renamingTabId === t.id ? 'max-w-[300px]' : 'max-w-[200px]',
            ].join(' ')}
            title={`${tabText(t)}${indicator ? ` (${indicator})` : ''}`}
          >
            {renamingTabId === t.id ? (
              <>
                <input
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={handleCommitRename}
                  onKeyDown={(e) => {
                    // Stop propagation so the tab div's onKeyDown
                    // doesn't intercept keystrokes (space, enter)
                    // and block character input.
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleCommitRename();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setRenamingTabId(null);
                      setRenameValue('');
                    }
                  }}
                  // Focus + select-all only ONCE on mount. Using a ref
                  // callback that runs on every render would re-select
                  // the text after each keystroke, making it impossible
                  // to type more than one character.
                  ref={(el) => {
                    if (el && !el.dataset.focused) {
                      el.dataset.focused = '1';
                      el.focus();
                      el.select();
                    }
                  }}
                  className="w-full min-w-[120px] bg-background text-foreground text-xs px-1 py-0 rounded outline-none ring-1 ring-ring"
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCommitRename();
                  }}
                  aria-label="Save name"
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </>
            ) : (
              <>
                <span className="truncate flex-1 pl-1">{tabText(t)}</span>
                <span
                  aria-hidden
                  className={cn(
                    'text-[10px] uppercase tracking-wide',
                    t.shell.status === 'starting' && 'text-muted-foreground',
                    t.shell.status === 'error' &&
                      'text-red-600 dark:text-red-500',
                  )}
                >
                  {indicator}
                </span>
                {active && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStartRename(t.id, tabText(t));
                    }}
                    aria-label={`Rename ${tabText(t)}`}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Pencil className="size-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleRequestCloseShell(t);
                  }}
                  aria-label={`Close ${tabText(t)}`}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </>
            )}
          </div>
        );
      })}
      {/* `+` tab: spawns a new on-demand shell. Always visible when a
            conversation is selected so the user can add a sibling
            shell without first opening an existing one. */}
      <button
        type="button"
        onClick={handleAddShell}
        aria-label="Add a new shell"
        className="flex items-center gap-1 px-2 py-1.5 text-xs border-r border-border shrink-0 text-muted-foreground hover:bg-background/60 hover:text-foreground"
        title="Open a new shell"
      >
        <Plus className="size-3.5" />
        <span>New shell</span>
      </button>
    </div>
  );

  // The chat path always shows the strip — even with zero open tabs, because
  // the `+` button needs to be reachable before or between conversations.
  // The kanban / externally-controlled path skips the strip entirely.
  const stripElement = !externallyControlled ? renderShellStrip() : null;

  // Body content depends on whether the chat path is using the
  // multi-shell strip or the kanban dialog path.
  const chatPathWithShell = !externallyControlled;

  return (
    <div className="flex flex-col min-h-0 h-full">
      {stripElement}

      {/* Active on-demand shell tab: render the nested BashTab in
          externallyControlled mode. The inner instance owns its own
          terminal, SSE channel, and tmux session lifecycle; the outer
          wrapper only owns the on-demand sandbox lifecycle (started via
          startProjectShell, torn down via stopProjectShell on
          Close).

          IMPORTANT: render one nested <BashTab> per ready + connected
          shell tab, NOT just the active one. Sibling shells share the
          same CarapaBox container (same stack/service/instance) and
          only differ in `tmuxSession`; React reuses a component
          instance when its position in the tree doesn't change, so
          rendering just the active tab and switching `tmuxSession`
          on the same instance would leave the inner BashTab still
          attached to the FIRST tmux session it opened — every tab
          click would silently show the same shell. Keying each
          nested BashTab by `tab.id` and rendering them all keeps
          one React instance per shell, each with its own Terminal
          + EventSource + tmux attach. Inactive tabs are hidden via
          `display: none` so only the active one is laid out. */}

      {!externallyControlled &&
        chatPathWithShell &&
        shellTabs
          .filter((t) => t.shell.status === 'ready')
          .map((t) => {
            const isActive = t.id === activeTab?.id;
            // Re-narrow the discriminated union so TS knows t.shell
            // has the ready-variant fields (stack/service/instance/
            // tmuxSession). Without this the .shell.* accesses below
            // fail with `Property 'stack' does not exist on type
            // 'ShellTabState'`.
            const ready = t.shell as Extract<
              ShellTabState,
              { status: 'ready' }
            >;
            return (
              <div
                key={t.id}
                data-ui="project-shell-terminal"
                data-shell-tab-id={t.id}
                // `display: none` (not `hidden`) so the inactive tab's
                // host doesn't claim any flex space and so xterm's
                // ResizeObserver (which doesn't fire on `display:none`
                // elements) doesn't push spurious fit/resize events
                // for the hidden tab. When the user switches to this
                // tab, the wrapper flips to `flex` and xterm's observer
                // fires normally for the now-visible host.
                className={isActive ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}
              >
                <BashTab
                  project_id={_project_id}
                  conversation_id={null}
                  stack={ready.stack}
                  service={ready.service}
                  instance={ready.instance}
                  {...(ready.tmuxSession
                    ? { tmuxSession: ready.tmuxSession }
                    : {})}
                  externallyControlled
                  onDisconnect={() => handleCloseShell(t.id)}
                  // Store this tab's Terminal handle in the outer
                  // map so the auto-focus effect (which watches
                  // activeTab?.id) can focus it on tab switch.
                  // The ref-only mutation avoids re-renders.
                  onReady={(term) => {
                    termHandlesRef.current.set(t.id, term);
                  }}
                  onTitleChange={(title) =>
                    setShellTabs((prev) =>
                      prev.some((x) => x.id === t.id && (x.title ?? '') !== title)
                        ? prev.map((x) =>
                            x.id === t.id ? { ...x, title: title || undefined } : x,
                          )
                        : prev,
                    )
                  }
                />
              </div>
            );
          })}

      {/* Per-tab starting / error surfaces — render above the inner
          BashTab so the strip + body stay aligned. Errors get a Dismiss
          button so a transient failure doesn't lock the tab in place;
          the user can also click the tab's X to remove it entirely. */}
      {!externallyControlled &&
        chatPathWithShell &&
        activeTab &&
        activeTab.shell.status !== 'ready' && (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground py-6 px-4 text-center">
            <PlugZap className="size-4" />
            {activeTab.shell.status === 'starting' && (
              <>
                <p>Starting {activeTab.label.toLowerCase()}…</p>
                <p className="text-[11px] text-muted-foreground/80 max-w-[28ch]">
                  The sandbox spins up; the terminal attaches as soon as tmux is
                  ready.
                </p>
              </>
            )}
            {activeTab.shell.status === 'error' && (
              <div className="flex flex-col items-center gap-2 max-w-[40ch]">
                <span className="text-xs text-red-600 dark:text-red-500 break-words">
                  {activeTab.shell.message}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleStartShell(activeTab.id)}
                  >
                    Retry
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleCloseShell(activeTab.id)}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

      {/* Empty-state CTA: shown on the chat path when the user has no
          on-demand shells yet. Shells are per-project (not per-
          conversation, task, or agent run) — the user spawns them on
          demand via the `+ New shell` button in the strip above, and
          they keep running across conversation switches within the
          same project. We deliberately do NOT render a second "Start
          a shell" button here — the strip's `+` button is the single
          affordance for spawning the first shell, and a duplicate
          would be ambiguous. */}
      {!externallyControlled && chatPathWithShell && shellTabs.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground py-8 px-4 text-center">
          <PlugZap className="size-4" />
          <p>No shells open for this project yet.</p>
          <p className="text-[11px] text-muted-foreground/80 max-w-[32ch]">
            Shells are independent from conversations and tasks — you can open
            as many as you like and they stay running until you close them. Use{' '}
            <span className="font-medium">+ New shell</span> above to start one.
          </p>
        </div>
      )}

      {/* When the chat path is NOT in use (kanban dialog path), keep the
          existing single-shell rendering so the on-demand shell started
          by the dialog's button keeps working. */}
      {!chatPathWithShell && (
        <div
          ref={hostRef}
          // See the chat-path host above — clicking in the terminal
          // refocuses xterm so keystrokes go to the tmux session.
          onMouseDown={() => {
            const t = termRef.current;
            if (t) {
              try {
                t.focus();
              } catch {
                /* best-effort */
              }
            }
          }}
          className={cn(
            // bg-black stays in both themes: the xterm host is deliberately
            // dark (see the terminal theme above).
            'flex-1 min-h-0 bg-black rounded-b overflow-hidden',
            // Hide only when there's no pending work. KEEP visible
            // during `loading` so `waitForLayout`'s ResizeObserver can
            // measure the host (see the chat-path host for the full
            // reasoning).
            phase.status === 'idle' ||
              phase.status === 'no-active-run' ||
              phase.status === 'error'
              ? 'hidden'
              : '',
          )}
        />
      )}

      {/* Empty/loading/error surfaces for the kanban / legacy path.
          Shells are per-project and created on demand, so there's no
          "start a task first" gating — the user always has the option
          to open a shell regardless of conversation, task, or agent
          run state. */}
      {!chatPathWithShell && phase.status === 'no-active-run' && (
        <div className="flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground py-8 px-4 text-center">
          <PlugZap className="size-4" />
          <p>No shell open for this project yet.</p>
          <p className="text-[11px] text-muted-foreground/80 max-w-[32ch]">
            Shells are independent from conversations and tasks — you can open
            as many as you like and they stay running until you close them.
          </p>
        </div>
      )}
      {!chatPathWithShell && phase.status === 'loading' && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
          <Loader2 className="size-3.5 animate-spin" />
          Attaching tmux session…
        </div>
      )}
      {!chatPathWithShell && phase.status === 'error' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 text-destructive text-xs px-3 py-2 mx-1 mb-2">
          {phase.message}
        </div>
      )}
    </div>
  );
}
