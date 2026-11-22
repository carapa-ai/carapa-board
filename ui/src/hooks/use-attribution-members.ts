import { useQuery } from '@tanstack/react-query';
import { listProjectMembersForAttribution } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useProjects } from '@/hooks/use-projects';

/**
 * Project members for attribution filters. The server lists them only to admins
 * and the project owner, so other users never send the request (a 403 would
 * show up as a console error) and get an empty list.
 */
export function useAttributionMembers(projectId: string) {
  const { user } = useAuth();
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === projectId);
  const canList = user?.role === 'admin' || project?.accessLevel === 'owner';
  const { data: members = [] } = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => listProjectMembersForAttribution(projectId),
    enabled: canList,
  });
  return { members, canList };
}
