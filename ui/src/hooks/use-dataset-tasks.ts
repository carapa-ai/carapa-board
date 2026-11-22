import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import * as api from '@/lib/api';
import type { DatasetTask, RuntimeSelection } from '@/types';
import { toast } from 'sonner';

export function useDatasetTasks(
  project_id: string,
  options?: { archived?: boolean },
) {
  const archived = options?.archived ?? false;
  return useQuery({
    queryKey: queryKeys.datasetTasks.list(project_id, archived),
    queryFn: () => api.fetchDatasetTasks(project_id, archived),
    staleTime: 30_000,
  });
}

export function useCreateDatasetTask(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      title: string;
      description?: string;
      dataset: Record<string, string | number>[];
      model?: string;
      agent_name?: string;
      runtimeSelection?: RuntimeSelection | null;
      runtimeSelectionStage?: string | null;
      objective_id?: string | null;
    }) => api.createDatasetTask(project_id, data),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.datasetTasks.all(project_id),
      });
      toast.success('Dataset task created');
    },
    onError: (err) =>
      toast.error(`Failed to create dataset task: ${err.message}`),
  });
}

export function useUpdateDatasetTask(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      dataset_task_id,
      data,
    }: {
      dataset_task_id: string;
      data: Partial<
        Pick<
          DatasetTask,
          | 'title'
          | 'description'
          | 'dataset'
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
    }) => api.updateDatasetTask(project_id, dataset_task_id, data),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.datasetTasks.all(project_id),
      });
    },
    onError: (err) =>
      toast.error(`Failed to update dataset task: ${err.message}`),
  });
}

export function useDeleteDatasetTask(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dataset_task_id: string) =>
      api.deleteDatasetTask(project_id, dataset_task_id),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.datasetTasks.all(project_id),
      });
      toast.success('Dataset task deleted');
    },
    onError: (err) =>
      toast.error(`Failed to delete dataset task: ${err.message}`),
  });
}

export function useRunDatasetTask(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dataset_task_id: string) =>
      api.runDatasetTask(project_id, dataset_task_id),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.datasetTasks.all(project_id),
      });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
      toast.success('Dataset task started');
    },
    onError: (err) => toast.error(`Failed to run dataset task: ${err.message}`),
  });
}

export function useRestartDatasetTask(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dataset_task_id: string) =>
      api.restartDatasetTask(project_id, dataset_task_id),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.datasetTasks.all(project_id),
      });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
      toast.success('Dataset task restarted from the beginning');
    },
    onError: (err) =>
      toast.error(`Failed to restart dataset task: ${err.message}`),
  });
}
