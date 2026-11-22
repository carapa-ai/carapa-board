import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { fetchWhatsAppStatus, fetchAvailableGroups, registerWhatsAppGroup } from '@/lib/api';
import type { AvailableGroup, WhatsAppStatus } from '@/types';
import { toast } from 'sonner';

export function useWhatsAppStatus() {
  return useQuery<WhatsAppStatus>({
    queryKey: queryKeys.whatsapp.status,
    queryFn: fetchWhatsAppStatus,
    staleTime: 3_000,
    // Poll fast (3s) when not connected so QR/status transitions are responsive
    refetchInterval: (query) =>
      query.state.data?.status === 'connected' ? 30_000 : 3_000,
  });
}

export function useAvailableGroups() {
  return useQuery<AvailableGroup[]>({
    queryKey: queryKeys.groups.available,
    queryFn: fetchAvailableGroups,
    staleTime: 30_000,
  });
}

export function useRegisterWhatsAppGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: registerWhatsAppGroup,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.projects.all });
      qc.invalidateQueries({ queryKey: queryKeys.groups.available });
      toast.success('WhatsApp group connected');
    },
    onError: (err) => toast.error(`Failed: ${err.message}`),
  });
}
