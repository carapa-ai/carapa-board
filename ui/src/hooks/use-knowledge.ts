import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  fetchKnowledgeBases,
  fetchKnowledgeVectorStatus,
  fetchSharedKnowledgeBases,
  createKnowledgeBase,
  updateKnowledgeBase,
  indexKnowledgeBase,
  shareKnowledgeBase,
  unshareKnowledgeBase,
  deleteKnowledgeBase,
  fetchKnowledgeShares,
  fetchKnowledgeFiles,
  uploadKnowledgeFile,
  saveMessageToKnowledge,
  deleteKnowledgeFile,
  fetchKnowledgeTags,
  fetchKnowledgeSearch,
  updateKnowledgeFileTags,
} from '@/lib/api';
import { KnowledgeBase, KnowledgeChunk } from '@/types';

export const knowledgeKeys = {
  all: ['knowledge'] as const,
  status: ['knowledge', 'status'] as const,
  details: (id: string) => [...knowledgeKeys.all, id] as const,
  shares: (id: string) => [...knowledgeKeys.all, id, 'shares'] as const,
};

export function useKnowledgeVectorStatus() {
  return useQuery({
    queryKey: knowledgeKeys.status,
    queryFn: fetchKnowledgeVectorStatus,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function useKnowledgeBases() {
  return useQuery<KnowledgeBase[]>({
    queryKey: knowledgeKeys.all,
    queryFn: async () => {
      const data = await fetchKnowledgeBases();
      return [...data].sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}

export function useSharedKnowledgeBases(group_folder: string | undefined) {
  return useQuery<KnowledgeBase[]>({
    queryKey: [...knowledgeKeys.all, 'shared', group_folder],
    queryFn: async () => {
      if (!group_folder) return [];
      const data = await fetchSharedKnowledgeBases(group_folder);
      return [...data].sort((a, b) => a.name.localeCompare(b.name));
    },
    enabled: !!group_folder,
  });
}

export function useCreateKnowledgeBase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; description: string | null }) =>
      createKnowledgeBase(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
    },
  });
}

export function useUpdateKnowledgeBase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: { name?: string; description?: string | null };
    }) => updateKnowledgeBase(id, data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.details(id) });
    },
  });
}

export function useIndexKnowledgeBase() {
  return useMutation({
    mutationFn: (id: string) => indexKnowledgeBase(id),
  });
}

export function useShareKnowledgeBase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, group_folder }: { id: string; group_folder: string }) =>
      shareKnowledgeBase(id, group_folder),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.shares(id) });
    },
  });
}

export function useUnshareKnowledgeBase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, group_folder }: { id: string; group_folder: string }) =>
      unshareKnowledgeBase(id, group_folder),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.shares(id) });
    },
  });
}

export function useDeleteKnowledgeBase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteKnowledgeBase(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
    },
  });
}

export function useKnowledgeShares(id: string | null) {
  return useQuery<string[]>({
    queryKey: id ? knowledgeKeys.shares(id) : ['knowledge', 'null', 'shares'],
    queryFn: () => (id ? fetchKnowledgeShares(id) : Promise.resolve([])),
    enabled: !!id,
  });
}

export function useKnowledgeFiles(id: string | null) {
  return useQuery({
    queryKey: id
      ? [...knowledgeKeys.all, id, 'files']
      : ['knowledge', 'null', 'files'],
    queryFn: () => (id ? fetchKnowledgeFiles(id) : Promise.resolve([])),
    enabled: !!id,
  });
}

export function useUploadKnowledgeFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      name,
      content,
      tags,
    }: {
      id: string;
      name: string;
      content: string;
      tags?: string[];
    }) => uploadKnowledgeFile(id, name, content, tags),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.details(id) });
    },
  });
}

/**
 * Single source of truth for saving a chat message to a knowledge base.
 * Handles the API call, cache invalidation, and success/error toasts so callers
 * only need to trigger it (and optionally close their UI via the onSuccess option).
 */
export function useSaveMessageToKnowledge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      content,
      group_folder,
    }: {
      id: string;
      content: string;
      group_folder: string;
      kbName?: string;
    }) => saveMessageToKnowledge(id, content, group_folder),
    onSuccess: (_, { id, kbName }) => {
      queryClient.invalidateQueries({
        queryKey: [...knowledgeKeys.all, id, 'files'],
      });
      toast.success(kbName ? `Saved to ${kbName}` : 'Saved to Knowledge Base');
    },
    onError: () => {
      toast.error('Failed to save to knowledge base');
    },
  });
}

export function useDeleteKnowledgeFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, filename }: { id: string; filename: string }) =>
      deleteKnowledgeFile(id, filename),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.details(id) });
    },
  });
}

export function useKnowledgeTags(id: string) {
  return useQuery({
    queryKey: [...knowledgeKeys.details(id), 'tags'],
    queryFn: () => fetchKnowledgeTags(id),
  });
}

export function useKnowledgeSearch(
  id: string,
  query: string,
  tags: string[],
  verify: boolean,
) {
  const normalizedQuery = query.trim();
  return useQuery<KnowledgeChunk[]>({
    queryKey: [
      ...knowledgeKeys.details(id),
      'search',
      normalizedQuery,
      tags,
      verify,
    ],
    queryFn: () => fetchKnowledgeSearch(id, normalizedQuery, tags, verify),
    enabled: !!normalizedQuery,
  });
}

export function useUpdateKnowledgeFileTags() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      filename,
      tags,
    }: {
      id: string;
      filename: string;
      tags: string[];
    }) => updateKnowledgeFileTags(id, filename, tags),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.details(id) });
    },
  });
}
