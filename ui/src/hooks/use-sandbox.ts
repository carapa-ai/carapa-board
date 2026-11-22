import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import * as api from '@/lib/api';
import { useStore } from '@/store';
import { toast } from 'sonner';

export function useSandboxStatus(group?: string) {
  return useQuery({
    queryKey: queryKeys.sandbox.status(group),
    queryFn: () => api.fetchSandboxStatus(group),
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
}

/** Share the actual Box publication URL between settings and the sidebar. */
export function usePublishedApp(group?: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.publishedApps.project(group),
    queryFn: () => api.fetchPublishedApp(group!),
    enabled: !!group && enabled,
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useSandboxSsh(stack: string, group?: string) {
  return useQuery({
    queryKey: ['sandbox', 'ssh', stack, group],
    queryFn: () => api.fetchSandboxSsh(stack, group!),
    enabled: !!group,
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useSetSandboxSsh(stack: string, group: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.setSandboxSsh(stack, group, enabled),
    onSuccess: (status, enabled) => {
      qc.setQueryData(['sandbox', 'ssh', stack, group], status);
      toast.success(
        status.pending
          ? 'SSH preference saved for the next sandbox start'
          : enabled
            ? 'Sandbox SSH enabled'
            : 'Sandbox SSH disabled',
      );
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['sandbox'] });
    },
  });
}

export function useSandboxPs() {
  return useQuery({
    queryKey: queryKeys.sandbox.ps,
    queryFn: () => api.fetchSandboxPs(),
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
}

export function useSandboxInstancePs(instance?: string) {
  return useQuery({
    queryKey: queryKeys.sandbox.instancePs(instance ?? ''),
    queryFn: () => api.fetchSandboxPs(instance),
    enabled: !!instance,
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
}

export function useStartSandbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ stack, group }: { stack: string; group?: string }) =>
      api.startSandbox(stack, group),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sandbox'] });
      toast.success('Sandbox starting...');
    },
    onError: (err) => toast.error(`Failed to start sandbox: ${err.message}`),
  });
}

export function useStopSandbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ stack, group }: { stack: string; group?: string }) =>
      api.stopSandbox(stack, group),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sandbox'] });
      toast.success('Sandbox stopped');
    },
    onError: (err) => toast.error(`Failed to stop sandbox: ${err.message}`),
  });
}

export function useProjectWorktrees(group?: string) {
  return useQuery({
    queryKey: ['project-worktrees', group],
    queryFn: () => api.fetchProjectWorktrees(group!),
    enabled: !!group,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useRemoveWorktree() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      stack,
      branch,
      group,
    }: {
      stack: string;
      branch: string;
      group?: string;
    }) => api.removeSandboxWorktree(stack, branch, group),
    onSuccess: (_result, { group }) => {
      qc.invalidateQueries({ queryKey: ['sandbox'] });
      qc.invalidateQueries({ queryKey: ['project-worktrees'] });
      if (group) {
        qc.invalidateQueries({
          queryKey: queryKeys.conversations.all(group),
        });
      }
      toast.success('Worktree removed');
    },
    onError: (err) => toast.error(`Failed to remove worktree: ${err.message}`),
  });
}

/** Pending restart-when-idle state; push events from the socket keep it fresh. */
export function useSandboxPendingRestart(
  stack: string,
  group?: string,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.sandbox.restartPending(group),
    queryFn: () => api.getPendingRestart(stack, group),
    enabled: !!group && enabled,
    refetchInterval: (query) => (query.state.data?.pending ? 5_000 : false),
    retry: false,
  });
}

export function useRestartSandboxWhenIdle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ stack, group }: { stack: string; group: string }) =>
      api.restartSandboxWhenIdle(stack, group),
    onSuccess: (_result, { group }) => {
      toast.info('Sandbox will restart when idle');
      qc.invalidateQueries({
        queryKey: queryKeys.sandbox.restartPending(group),
      });
    },
    onError: (err) =>
      toast.error(`Failed to schedule sandbox restart: ${err.message}`),
  });
}

export function useCancelPendingRestart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ stack, group }: { stack: string; group: string }) =>
      api.cancelPendingRestart(stack, group),
    onSuccess: (_result, { group }) => {
      toast.info('Pending sandbox restart cancelled');
      qc.invalidateQueries({
        queryKey: queryKeys.sandbox.restartPending(group),
      });
    },
    onError: (err) =>
      toast.error(`Failed to cancel pending restart: ${err.message}`),
  });
}

export function useRestartSandbox() {
  return useMutation({
    mutationFn: ({ stack, group }: { stack: string; group?: string }) =>
      api.restartSandbox(stack, group),
    onSuccess: () => {
      toast.info('Sandbox restarting...');
    },
    onError: (err, { group }) => {
      // The restart endpoint acknowledges before doing the work and broadcasts
      // `restarting` over the socket. A proxy can still drop that HTTP response
      // while several stacks are being restarted. Give the socket event a
      // moment to arrive before reporting a transport error: if it did, the
      // server accepted the request and the eventual lifecycle event is the
      // authoritative result.
      setTimeout(() => {
        const accepted = group
          ? useStore.getState().restartingSandboxes[group]
          : false;
        if (accepted) return;
        toast.error(`Failed to restart sandbox: ${err.message}`);
      }, 500);
    },
  });
}
