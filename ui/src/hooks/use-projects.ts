import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import {
  acknowledgeKanbanCompletions,
  fetchProjects,
  fetchMeetingAccess,
  cachedProjects,
  createProject,
  updateProjectSettings,
  inheritProjectStages,
  updateProjectsOrder,
  stopProject,
  deleteProject,
  fetchAvailableGroups,
  linkProjectToWhatsApp,
  unlinkWhatsAppGroup,
  fetchProjectsStatusSummary,
  updateProjectModePref,
} from '@/lib/api';
import type {
  Project,
  ProjectSettings,
  StageMigration,
  TaskSummary,
} from '@/types';
import { toast } from 'sonner';
import { useStore } from '@/store';

export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: fetchProjects,
    staleTime: Infinity,
    initialData: cachedProjects,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
}

/** Read a single project from the shared projects cache without polling. */
export function useProject(project_id: string) {
  return useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: fetchProjects,
    select: (projects) => projects.find((p) => p.id === project_id),
    staleTime: Infinity,
    initialData: cachedProjects,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
}

/**
 * Whether the server currently lets the caller record meetings, from an
 * uncached request. Every project-change notification changes the key, so the
 * answer always comes from a request that started after the latest change
 * (TanStack would otherwise reuse a pending request, or skip invalidating one
 * that already failed). `data` is undefined until that request succeeds.
 */
export function useMeetingAccess(
  projectId: string,
  userId: string | undefined,
  enabled: boolean,
) {
  const changeSeq = useStore((s) => s.projectsChangeSeq);
  return useQuery({
    queryKey: queryKeys.projects.access(projectId, userId, changeSeq),
    queryFn: ({ signal }) => fetchMeetingAccess(projectId, signal),
    enabled,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useProjectsStatusSummary() {
  return useQuery({
    queryKey: queryKeys.projects.statusSummary,
    queryFn: fetchProjectsStatusSummary,
    staleTime: 10_000,
  });
}

export function useAcknowledgeKanbanCompletions(
  projectId: string,
  acknowledge: typeof acknowledgeKanbanCompletions = acknowledgeKanbanCompletions,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (visibleCompletionEventIds: number[]) =>
      acknowledge(projectId, visibleCompletionEventIds),
    retry: 1,
    retryDelay: 0,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.projects.statusSummary,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.attention.all }),
      ]),
  });
}

type KanbanAcknowledgementAttempt = {
  projectId: string;
  state: 'pending' | 'success';
};

export function useAcknowledgeVisibleKanbanCompletions(
  projectId: string,
  enabled: boolean,
  visibleTasks: TaskSummary[] | undefined,
  acknowledge: typeof acknowledgeKanbanCompletions = acknowledgeKanbanCompletions,
): void {
  const { mutate: acknowledgeVisibleCompletions } =
    useAcknowledgeKanbanCompletions(projectId, acknowledge);
  const attemptRef = useRef<KanbanAcknowledgementAttempt | null>(null);

  useEffect(() => {
    if (
      !enabled ||
      visibleTasks === undefined ||
      attemptRef.current?.projectId === projectId
    ) {
      return;
    }
    const visibleCompletions = visibleTasks.filter(
      (task) => task.status === 'completed' && !task.archived,
    );
    if (visibleCompletions.some((task) => task.completionEventId == null)) {
      return;
    }

    const attempt: KanbanAcknowledgementAttempt = {
      projectId,
      state: 'pending',
    };
    attemptRef.current = attempt;
    acknowledgeVisibleCompletions(
      visibleCompletions.map((task) => task.completionEventId!),
      {
        onSuccess: () => {
          if (attemptRef.current === attempt) attempt.state = 'success';
        },
        onError: () => {
          if (attemptRef.current === attempt) attemptRef.current = null;
        },
      },
    );
  }, [acknowledgeVisibleCompletions, enabled, projectId, visibleTasks]);
}

export const PROJECTS_NOT_REORDERED_MESSAGE =
  'Some projects were not reordered: you can only reorder projects you own or edit.';

export function useUpdateProjectsOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orders: Record<string, number>) => updateProjectsOrder(orders),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: queryKeys.projects.all });
      if (data.skipped && data.skipped > 0) {
        toast.info(PROJECTS_NOT_REORDERED_MESSAGE);
      }
    },
    onError: (err) =>
      toast.error(`Failed to update project order: ${err.message}`),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; folder?: string; parentId?: string }) =>
      createProject(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.projects.all });
      toast.success('Project created');
    },
    onError: (err) => toast.error(`Failed to create project: ${err.message}`),
  });
}

export function useUpdateProjectSettings(
  project_id: string,
  { silent = false }: { silent?: boolean } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      settings?: Partial<ProjectSettings>;
      name?: string;
      folder?: string;
      parentId?: string | null;
      stageMigrations?: StageMigration[];
    }) => updateProjectSettings(project_id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.projects.all });
      qc.invalidateQueries({ queryKey: ['project-details', project_id] });
      // Disabled skills change the slash-command list (of this project and of
      // projects sharing its sandbox) and the settings checklist.
      qc.invalidateQueries({ queryKey: ['project-commands'] });
      qc.invalidateQueries({ queryKey: ['project-skills'] });
      if (!silent) toast.success('Settings saved');
    },
    onError: (err) => toast.error(`Failed to save settings: ${err.message}`),
  });
}

export function useInheritProjectStages(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => inheritProjectStages(project_id),
    // Returned so the mutation settles after the refetch, when the dialog
    // adopts the project's new (inheriting) settings.
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.projects.all }),
        qc.invalidateQueries({ queryKey: ['project-details', project_id] }),
        qc.invalidateQueries({
          queryKey: ['project-stage-occupancy', project_id],
        }),
      ]),
  });
}

export function useStopProject(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => stopProject(project_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects.all }),
    onError: (err) => toast.error(`Failed to stop project: ${err.message}`),
  });
}

export function useDeleteProject(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => deleteProject(project_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.projects.all });
      toast.success('Project deleted');
    },
    onError: (err) => toast.error(`Failed to delete project: ${err.message}`),
  });
}

export function usePauseProject(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      updateProjectSettings(project_id, { settings: { status: 'paused' } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects.all }),
    onError: (err) => toast.error(`Failed to pause project: ${err.message}`),
  });
}

export function useStartProject(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      updateProjectSettings(project_id, { settings: { status: 'running' } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects.all }),
    onError: (err) => toast.error(`Failed to start project: ${err.message}`),
  });
}

export function useSetParallelism(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (maxParallelWorktrees: number) =>
      updateProjectSettings(project_id, { settings: { maxParallelWorktrees } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects.all }),
    onError: (err) =>
      toast.error(`Failed to update parallelism: ${err.message}`),
  });
}

export function useUpdateProjectMode(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: 'kanban' | 'chat' | 'objectives' | null) =>
      updateProjectModePref(project_id, mode),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects.all }),
    onError: (err) => {
      const project = qc
        .getQueryData<Project[]>(queryKeys.projects.all)
        ?.find((candidate) => candidate.id === project_id);
      const projectName = project?.name.trim() || project_id;
      toast.error(
        `Failed to change view for project "${projectName}": ${err.message}`,
      );
    },
  });
}

// --- WhatsApp linking ---

export function useAvailableGroups() {
  return useQuery({
    queryKey: queryKeys.groups.available,
    queryFn: fetchAvailableGroups,
  });
}

export function useLinkProjectToWhatsApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      project_id: string;
      whatsappJid: string;
      name: string;
      trigger: string;
    }) =>
      linkProjectToWhatsApp(data.project_id, {
        whatsappJid: data.whatsappJid,
        name: data.name,
        trigger: data.trigger,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.projects.all });
      qc.invalidateQueries({ queryKey: queryKeys.groups.available });
      qc.invalidateQueries({ queryKey: queryKeys.groups.selfChats });
      toast.success('Project linked to WhatsApp group');
    },
    onError: (err) => toast.error(`Failed to link: ${err.message}`),
  });
}

export function useUnlinkWhatsAppGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jid: string) => unlinkWhatsAppGroup(jid),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.projects.all });
      qc.invalidateQueries({ queryKey: queryKeys.groups.available });
      qc.invalidateQueries({ queryKey: queryKeys.groups.selfChats });
      toast.success('WhatsApp group disconnected');
    },
    onError: (err) => toast.error(`Failed to disconnect: ${err.message}`),
  });
}
