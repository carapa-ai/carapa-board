import {
  createFileRoute,
  Navigate,
  useBlocker,
  useLocation,
  useNavigate,
} from '@tanstack/react-router';
import { KanbanBoard } from '@/components/board/kanban-board';
import { Header } from '@/components/layout/header';
import { ProjectDialogs } from '@/components/layout/project-dialogs';
import { NoModesAvailable } from '@/components/layout/no-modes-available';
import { ProjectNotFound } from '@/components/layout/project-not-found';
import {
  useAcknowledgeVisibleKanbanCompletions,
  useProjects,
} from '@/hooks/use-projects';
import { useTasks } from '@/hooks/use-tasks';
import { availableProjectModes, modeRoutePath } from '@/lib/modes';
import { useEffect, useRef } from 'react';
import { useStore } from '@/store';
import { canLeaveActivePreview } from '@/store';
import { useProjectWorkspacePane } from '@/hooks/use-project-workspace-pane';
import { useRegisterWorkspaceToggle } from '@/hooks/use-workspace-toggle';
import { useWorkspacePaneReveal } from '@/hooks/use-workspace-pane-reveal';
import { ProjectWorkspacePane } from '@/components/project-workspace-pane';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useAppConfig } from '@/hooks/use-app-config';

function BoardPage() {
  const { projectId } = Route.useParams();
  const locationSearch = useLocation({
    select: (location) => location.searchStr,
  });
  const taskId = new URLSearchParams(locationSearch).get('taskId');
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const { data: config } = useAppConfig();
  const project = projects?.find((p) => p.id === projectId);
  const detailTaskId = useStore((state) => state.detailTaskId);
  const setDetailTaskId = useStore((state) => state.setDetailTaskId);
  const availableModes =
    projects !== undefined && config !== undefined
      ? availableProjectModes(project, config)
      : undefined;
  const { data: visibleTasks } = useTasks(projectId);
  useAcknowledgeVisibleKanbanCompletions(
    projectId,
    availableModes?.includes('kanban') === true,
    visibleTasks,
  );
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
  useEffect(() => {
    if (taskId) setDetailTaskId(taskId);
  }, [taskId, setDetailTaskId]);
  // Closing the dialog leaves ?taskId= behind, so re-opening the same task
  // (e.g. from the sidebar Now list) would navigate to an unchanged URL and
  // never re-trigger the effect above. Drop the param once the dialog closes.
  const previousDetailTaskId = useRef(detailTaskId);
  useEffect(() => {
    const wasOpen = previousDetailTaskId.current !== null;
    previousDetailTaskId.current = detailTaskId;
    if (!wasOpen || detailTaskId !== null || !taskId) return;
    void navigate({
      to: '/board/$projectId',
      params: { projectId },
      search: ((prev: Record<string, unknown>) => {
        const { taskId: _closed, ...rest } = prev;
        return rest;
      }) as never,
      replace: true,
    });
  }, [detailTaskId, taskId, projectId, navigate]);

  // Redirect off this view when kanban is env-disabled. Wait for both queries
  // to load before deciding so we don't bounce on a stale config snapshot.
  if (projects !== undefined && project === undefined)
    return <ProjectNotFound projectId={projectId} />;
  if (availableModes !== undefined) {
    if (availableModes.length === 0)
      return <NoModesAvailable projectId={projectId} />;
    if (!availableModes.includes('kanban')) {
      return (
        <Navigate
          to={modeRoutePath(availableModes[0])}
          params={{ projectId }}
        />
      );
    }
  }

  return (
    <>
      <Header project_id={projectId} />
      <div
        ref={layoutRef}
        data-ui="kanban-project-layout"
        className="flex-1 flex min-h-0 overflow-hidden relative"
      >
        <div
          data-ui="kanban-content"
          className="flex min-w-0 flex-1 flex-col overflow-hidden"
        >
          <KanbanBoard key={projectId} project_id={projectId} />
        </div>
        {workspaceOpen && (
          <ProjectWorkspacePane
            projectId={projectId}
            conversationId={null}
            taskId={detailTaskId || taskId}
            width={workspaceWidth}
            onResize={startResize}
            onResizeCancel={cancelResize}
            onClose={() => closeWorkspaceAfterLeave(false)}
            onFileOpen={() => setWorkspaceOpen(true)}
            marker="kanban-workspace-pane"
          />
        )}
      </div>
      <ProjectDialogs project_id={projectId} />
    </>
  );
}

export const Route = createFileRoute('/board/$projectId')({
  component: BoardPage,
});
