import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useProjects } from '@/hooks/use-projects';
import { useStore } from '@/store';
import { resolveProjectMode, modeRoutePath } from '@/lib/modes';
import { NoModesAvailable } from '@/components/layout/no-modes-available';
import { QueryErrorState } from '@/components/layout/query-error-state';
import { useAppConfig } from '@/hooks/use-app-config';

function IndexPage() {
  const projectsQuery = useProjects();
  const configQuery = useAppConfig();
  const { data: projects, isLoading } = projectsQuery;
  const { data: config } = configQuery;
  const lastProjectId = useStore((s) => s.lastProjectId);

  if (config === undefined && configQuery.isError) {
    return (
      <QueryErrorState
        title="Could not load configuration"
        error={configQuery.error}
        onRetry={() => void configQuery.refetch()}
        isRetrying={configQuery.isFetching}
      />
    );
  }

  if (projects === undefined && projectsQuery.isError) {
    return (
      <QueryErrorState
        title="Could not load projects"
        error={projectsQuery.error}
        onRetry={() => void projectsQuery.refetch()}
        isRetrying={projectsQuery.isFetching}
      />
    );
  }

  if (isLoading || config === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Loading projects...
      </div>
    );
  }

  if (projects && projects.length > 0) {
    const lastProject = lastProjectId
      ? projects.find((p) => p.id === lastProjectId)
      : null;
    const target = lastProject || projects[0];
    const mode = resolveProjectMode(target, config);

    if (mode === null) {
      return <NoModesAvailable projectId={target.id} />;
    }
    return (
      <Navigate to={modeRoutePath(mode)} params={{ projectId: target.id }} />
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground">
      <div className="text-center">
        <h2 className="text-xl font-semibold">No projects found</h2>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/')({
  component: IndexPage,
});
