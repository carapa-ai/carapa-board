import { useCallback, useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { fetchObjectiveDashboardTicket } from '@/lib/api';
import { API_BASE_URL } from '@/lib/api-config';
import { useStore } from '@/store';

export function ObjectiveDashboard({
  project_id,
  objective_id,
  objective_title,
}: {
  project_id: string;
  objective_id: string;
  objective_title: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const refreshCount = useStore(
    (state) => state.dashboardRefresh[objective_id] || 0,
  );
  // Path tokens last 8h. Refresh well inside that window (on a timer, and on
  // focus/reconnect once stale) so a long-open dashboard keeps authenticating;
  // the new token changes the iframe src, which reloads it once.
  const { data: pathToken } = useQuery({
    queryKey: ['objective-dashboard-ticket', project_id, objective_id],
    queryFn: () => fetchObjectiveDashboardTicket(project_id, objective_id),
    staleTime: 6 * 60 * 60_000,
    refetchInterval: 6 * 60 * 60_000,
    refetchIntervalInBackground: true,
    retry: 1,
  });

  // Set once the current document posts the opt-in message; pushed refreshes
  // are then delivered as a message instead of a hard reload.
  const handlesRefreshRef = useRef(false);

  const reloadDashboard = useCallback(() => {
    handlesRefreshRef.current = false;
    if (iframeRef.current) iframeRef.current.src = iframeRef.current.src;
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.source === iframeRef.current?.contentWindow &&
        event.data?.type === 'carapa-dashboard-handles-refresh'
      ) {
        handlesRefreshRef.current = true;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // The counter is never reset: a count already present when this objective is
  // shown belongs to the initial load, so only later increments refresh.
  const seenRefreshRef = useRef({ objective_id, count: refreshCount });
  useEffect(() => {
    const seen = seenRefreshRef.current;
    const previous = seen.objective_id === objective_id ? seen.count : -1;
    seenRefreshRef.current = { objective_id, count: refreshCount };
    if (refreshCount <= previous || previous === -1) return;
    if (handlesRefreshRef.current && iframeRef.current?.contentWindow) {
      // Opaque frame origin ("null"): no narrower target origin works.
      iframeRef.current.contentWindow.postMessage(
        { type: 'carapa-dashboard-refresh' },
        '*',
      );
    } else {
      reloadDashboard();
    }
  }, [objective_id, refreshCount, reloadDashboard]);

  // The sandboxed iframe has an opaque origin and sends no session cookie, so
  // auth travels as a path token that relative dashboard URLs inherit.
  const dashboardSrc = pathToken
    ? `${Capacitor.isNativePlatform() ? API_BASE_URL : ''}/api/projects/${project_id}/objectives/${objective_id}/dashboard/t/${encodeURIComponent(pathToken)}/index.html`
    : '';

  // A new frame document (token renewal or another objective) must opt in again.
  useEffect(() => {
    handlesRefreshRef.current = false;
  }, [objective_id, dashboardSrc]);

  return (
    <div
      data-ui="objective-dashboard"
      data-objective-id={objective_id}
      className="group/dashboard relative h-full w-full overflow-hidden"
    >
      <button
        type="button"
        onClick={reloadDashboard}
        className="absolute right-2 top-2 z-10 rounded-md border border-border bg-background/80 p-1.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/dashboard:opacity-100"
        title="Refresh dashboard"
        aria-label="Refresh dashboard"
      >
        <RefreshCw className="size-3.5" />
      </button>
      <iframe
        key={objective_id}
        ref={iframeRef}
        src={dashboardSrc}
        className="h-full w-full border-0 bg-background"
        title={`${objective_title} Dashboard`}
        sandbox="allow-scripts allow-forms allow-popups"
      />
    </div>
  );
}
