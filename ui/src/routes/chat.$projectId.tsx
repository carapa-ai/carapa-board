import {
  createFileRoute,
  Navigate,
  useRouterState,
} from '@tanstack/react-router';
import { ChatPage } from '@/components/chat/chat-page';
import { Header } from '@/components/layout/header';
import { ProjectDialogs } from '@/components/layout/project-dialogs';
import { NoModesAvailable } from '@/components/layout/no-modes-available';
import { ProjectNotFound } from '@/components/layout/project-not-found';
import { useProjects } from '@/hooks/use-projects';
import { availableProjectModes, modeRoutePath } from '@/lib/modes';
import { parseFileDeepLink } from '@/lib/file-deep-link';
import { useAppConfig } from '@/hooks/use-app-config';

export function ChatRouteContent({ projectId }: { projectId: string }) {
  const locationHref = useRouterState({
    select: (state) => state.location.href,
  });
  const location = new URL(locationHref, window.location.origin);
  const pathnameProjectId = location.pathname.startsWith('/chat/')
    ? decodeURIComponent(location.pathname.slice('/chat/'.length).split('/')[0])
    : projectId;
  const renderedProjectId = pathnameProjectId || projectId;
  const conversationId = location.searchParams.get('conversationId');
  const fileLink = parseFileDeepLink(location.searchParams.get('file'));
  const { data: projects } = useProjects();
  const { data: config } = useAppConfig();
  const project = projects?.find((p) => p.id === renderedProjectId);

  if (projects !== undefined && project === undefined)
    return <ProjectNotFound projectId={renderedProjectId} />;
  if (projects !== undefined && config !== undefined) {
    const available = availableProjectModes(project, config);
    if (available.length === 0)
      return <NoModesAvailable projectId={renderedProjectId} />;
    if (!available.includes('chat')) {
      return (
        <Navigate
          to={modeRoutePath(available[0])}
          params={{ projectId: renderedProjectId }}
        />
      );
    }
  }

  return (
    <>
      <Header project_id={renderedProjectId} />
      <ChatPage
        key={renderedProjectId}
        project_id={renderedProjectId}
        route_conversation_id={conversationId}
        route_file={fileLink}
      />
      <ProjectDialogs project_id={renderedProjectId} />
    </>
  );
}

function ChatRoute() {
  const { projectId } = Route.useParams();
  return <ChatRouteContent projectId={projectId} />;
}

export const Route = createFileRoute('/chat/$projectId')({
  component: ChatRoute,
});
