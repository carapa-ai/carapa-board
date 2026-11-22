import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import * as api from '@/lib/api';
import type { Cronjob, RuntimeSelection } from '@/types';
import { toast } from 'sonner';
import { patchTaskLists } from './use-task-mutations';

export function useCronjobs(
  project_id: string,
  options?: { archived?: boolean },
) {
  const archived = options?.archived ?? false;
  return useQuery({
    queryKey: queryKeys.cronjobs.list(project_id, archived),
    queryFn: () => api.fetchCronjobs(project_id, archived),
    staleTime: 30_000,
  });
}

export function useCreateCronjob(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      title: string;
      description?: string;
      cron_expression: string;
      queue_mode?: string;
      model?: string;
      agent_name?: string;
      runtimeSelection?: RuntimeSelection | null;
      runtimeSelectionStage?: string | null;
      objective_id?: string | null;
    }) => api.createCronjob(project_id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.cronjobs.all(project_id) });
      toast.success('Cronjob created');
    },
    onError: (err) => toast.error(`Failed to create cronjob: ${err.message}`),
  });
}

export function useUpdateCronjob(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      cronjob_id,
      data,
    }: {
      cronjob_id: string;
      data: Partial<
        Pick<
          Cronjob,
          | 'title'
          | 'description'
          | 'cron_expression'
          | 'queue_mode'
          | 'status'
          | 'archived'
          | 'objective_id'
        >
      > & {
        model?: string | null;
        agent_name?: string | null;
        runtimeSelection?: RuntimeSelection | null;
        runtimeSelectionStage?: string | null;
      };
    }) => api.updateCronjob(project_id, cronjob_id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.cronjobs.all(project_id) });
    },
    onError: (err) => toast.error(`Failed to update cronjob: ${err.message}`),
  });
}

export function useDeleteCronjob(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cronjob_id: string) =>
      api.deleteCronjob(project_id, cronjob_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.cronjobs.all(project_id) });
      toast.success('Cronjob deleted');
    },
    onError: (err) => toast.error(`Failed to delete cronjob: ${err.message}`),
  });
}

export function useRunCronjob(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cronjob_id: string) => api.runCronjob(project_id, cronjob_id),
    onSuccess: ({ task }) => {
      // Add the server-created task directly so the card appears as soon as
      // the run request completes, without waiting for a second list request.
      patchTaskLists(qc, project_id, (old) =>
        old.some((item) => item.id === task.id)
          ? old
          : [...old, { ...task, running: false, queued: false }],
      );
      // Reconcile the optimistic cache with the server's running/queued state.
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
      toast.success('Cronjob started');
    },
    onError: (err) => toast.error(`Failed to run cronjob: ${err.message}`),
  });
}
