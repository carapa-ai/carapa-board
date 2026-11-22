import {
  createFileRoute,
  Navigate,
  useBlocker,
  useNavigate,
} from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Target, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Header } from '@/components/layout/header';
import { NoModesAvailable } from '@/components/layout/no-modes-available';
import { ProjectNotFound } from '@/components/layout/project-not-found';
import { QueryErrorState } from '@/components/layout/query-error-state';
import { ObjectiveCard } from '@/components/ObjectiveCard';
import { Button } from '@/components/ui/button';
import { fetchObjectives, createObjective } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { useProjects } from '@/hooks/use-projects';
import { useProjectWorkspacePane } from '@/hooks/use-project-workspace-pane';
import { useRegisterWorkspaceToggle } from '@/hooks/use-workspace-toggle';
import { useWorkspacePaneReveal } from '@/hooks/use-workspace-pane-reveal';
import { useMediaQuery } from '@/hooks/use-media-query';
import { availableProjectModes, modeRoutePath } from '@/lib/modes';
import { ProjectWorkspacePane } from '@/components/project-workspace-pane';
import { canLeaveActivePreview } from '@/store';
import type { Objective } from '@/types';
import { useAppConfig } from '@/hooks/use-app-config';

function ObjectivesDashboard({
  project_id,
  objectives,
  isLoading,
  error,
  onRetry,
  isRetrying,
}: {
  project_id: string;
  objectives: Objective[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  isRetrying: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: () =>
      createObjective(project_id, { title: 'Untitled Objective' }),
    onSuccess: (obj) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.objectives.all(project_id),
      });
      navigate({
        to: '/objective/$projectId/$objectiveId',
        params: { projectId: project_id, objectiveId: obj.id },
      });
    },
    onError: (err: Error) =>
      toast.error(`Failed to create objective: ${err.message}`),
  });

  // Group by status for visual organization
  const grouped = (objectives ?? []).reduce<Record<string, Objective[]>>(
    (acc, obj) => {
      const key = obj.status;
      if (!acc[key]) acc[key] = [];
      acc[key].push(obj);
      return acc;
    },
    {},
  );

  const statusOrder = [
    'active',
    'draft',
    'paused',
    'achieved',
    'failed',
  ] as const;

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="flex items-center gap-2">
          <Target className="size-5 animate-pulse" />
          Loading objectives...
        </div>
      </div>
    );
  }

  if (error && objectives === undefined) {
    return (
      <QueryErrorState
        title="Could not load objectives"
        error={error}
        onRetry={onRetry}
        isRetrying={isRetrying}
      />
    );
  }

  const isEmpty = !objectives || objectives.length === 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div />
          <Button
            variant="outline"
            size="sm"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            <Plus className="size-4 mr-1" />
            {createMutation.isPending ? 'Creating...' : 'New Objective'}
          </Button>
        </div>
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
            <Target className="size-10 mb-4 opacity-40" />
            <p className="text-sm">No objectives yet</p>
            <p className="text-xs mt-1">
              Create your first objective to get started
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {statusOrder.map((status) => {
              const items = grouped[status];
              if (!items || items.length === 0) return null;
              return (
                <section key={status}>
                  <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                    {status} ({items.length})
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {items
                      .sort((a, b) => a.priority - b.priority)
                      .map((obj) => (
                        <ObjectiveCard
                          key={obj.id}
                          objective={obj}
                          project_id={project_id}
                        />
                      ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ObjectivesPage() {
  const { projectId } = Route.useParams();
  const { data: projects } = useProjects();
  const { data: config } = useAppConfig();
  const project = projects?.find((p) => p.id === projectId);
  const objectivesQuery = useQuery({
    queryKey: queryKeys.objectives.all(projectId),
    queryFn: () => fetchObjectives(projectId),
    enabled: config?.enableObjectives !== false,
  });
  const { data: objectives, isLoading } = objectivesQuery;
  const isMobileViewport = useMediaQuery('(max-width: 639px)');
  useBlocker({
    shouldBlockFn: async () => !(await canLeaveActivePreview(projectId)),
    enableBeforeUnload: false,
  });
  const {
    open: workspaceOpen,
    setOpen: setWorkspaceOpen,
    setOpenAfterLeaveCheck: closeWorkspaceAfterLeave,
    width: workspaceWidth,
    layoutRef,
    startResize,
    cancelResize,
  } = useProjectWorkspacePane(projectId, {
    restoreOpen: !isMobileViewport,
    persistOpen: !isMobileViewport,
  });
  useWorkspacePaneReveal(projectId, setWorkspaceOpen);
  useRegisterWorkspaceToggle(workspaceOpen, () =>
    setWorkspaceOpen((open) => !open),
  );

  if (projects !== undefined && project === undefined)
    return <ProjectNotFound projectId={projectId} />;
  if (projects !== undefined && config !== undefined) {
    const available = availableProjectModes(project, config);
    if (available.length === 0)
      return <NoModesAvailable projectId={projectId} />;
    if (!available.includes('objectives')) {
      return (
        <Navigate to={modeRoutePath(available[0])} params={{ projectId }} />
      );
    }
  }

  return (
    <>
      <Header project_id={projectId} />
      <div
        ref={layoutRef}
        data-ui="objectives-project-layout"
        className="relative flex min-h-0 flex-1 overflow-hidden"
      >
        <ObjectivesDashboard
          project_id={projectId}
          objectives={objectives}
          isLoading={isLoading}
          error={objectivesQuery.error}
          onRetry={() => void objectivesQuery.refetch()}
          isRetrying={objectivesQuery.isFetching}
        />
        {workspaceOpen && (
          <ProjectWorkspacePane
            projectId={projectId}
            conversationId={null}
            width={workspaceWidth}
            onResize={startResize}
            onResizeCancel={cancelResize}
            onClose={() => closeWorkspaceAfterLeave(false)}
            onFileOpen={() => setWorkspaceOpen(true)}
            marker="objectives-workspace-pane"
          />
        )}
      </div>
    </>
  );
}

export const Route = createFileRoute('/objectives/$projectId')({
  component: ObjectivesPage,
});
