import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import * as api from '@/lib/api';
import type { ScheduledTask } from '@/types';
import { toast } from 'sonner';

export function useScheduledTasks(
  project_id: string,
  options?: { refetchInterval?: number },
) {
  return useQuery({
    queryKey: queryKeys.scheduledTasks.all(project_id),
    queryFn: () => api.fetchScheduledTasks(project_id),
    staleTime: 30_000,
    ...options,
  });
}

export function useUpdateScheduledTask(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      scheduled_task_id,
      data,
    }: {
      scheduled_task_id: string;
      data: Partial<
        Pick<
          ScheduledTask,
          | 'prompt'
          | 'scheduleType'
          | 'scheduleValue'
          | 'contextMode'
          | 'status'
          | 'runtimeSelection'
        >
      > & { currentRunAction?: 'finish' | 'stop' };
    }) => api.updateScheduledTask(project_id, scheduled_task_id, data),
    onSuccess: (result, variables) => {
      qc.setQueryData(
        queryKeys.scheduledTasks.detail(
          project_id,
          variables.scheduled_task_id,
        ),
        result,
      );
      qc.invalidateQueries({
        queryKey: queryKeys.scheduledTasks.detail(
          project_id,
          variables.scheduled_task_id,
        ),
      });
      qc.invalidateQueries({
        queryKey: queryKeys.scheduledTasks.all(project_id),
      });
      qc.invalidateQueries({
        queryKey: queryKeys.scheduledTasks.runs(
          project_id,
          variables.scheduled_task_id,
        ),
      });
    },
    onError: (err) =>
      toast.error(`Failed to update scheduled task: ${err.message}`),
  });
}

export function useScheduledTaskDetail(
  project_id: string,
  scheduled_task_id: string,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.scheduledTasks.detail(project_id, scheduled_task_id),
    queryFn: () => api.fetchScheduledTask(project_id, scheduled_task_id),
    enabled: enabled && !!scheduled_task_id,
  });
}

export function useDeleteScheduledTask(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scheduled_task_id: string) =>
      api.deleteScheduledTask(project_id, scheduled_task_id),
    onSuccess: (_result, scheduled_task_id) => {
      qc.invalidateQueries({
        queryKey: queryKeys.scheduledTasks.all(project_id),
      });
      qc.removeQueries({
        queryKey: queryKeys.scheduledTasks.detail(
          project_id,
          scheduled_task_id,
        ),
      });
      qc.removeQueries({
        queryKey: queryKeys.scheduledTasks.runs(project_id, scheduled_task_id),
      });
      qc.removeQueries({
        queryKey: queryKeys.scheduledTasks.transcripts(
          project_id,
          scheduled_task_id,
        ),
      });
      toast.success('Scheduled task deleted');
    },
    onError: (err) =>
      toast.error(`Failed to delete scheduled task: ${err.message}`),
  });
}

export function useScheduledTaskRuns(
  project_id: string,
  scheduled_task_id: string,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.scheduledTasks.runs(project_id, scheduled_task_id),
    queryFn: () => api.fetchScheduledTaskRuns(project_id, scheduled_task_id),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.some((run) =>
        ['running', 'finalizing'].includes(run.status),
      )
        ? 2_000
        : false,
  });
}

export function useScheduledTaskTranscript(
  project_id: string,
  scheduled_task_id: string,
  runId: string | null,
) {
  return useQuery({
    queryKey: queryKeys.scheduledTasks.transcript(
      project_id,
      scheduled_task_id,
      runId ?? '',
    ),
    queryFn: () =>
      api.fetchScheduledTaskTranscript(project_id, scheduled_task_id, runId!),
    enabled: !!runId,
  });
}
