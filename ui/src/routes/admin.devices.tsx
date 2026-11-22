import {
  PairDeviceCard,
  IntegrationDetails,
} from '@/components/account/device-pairing';
import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchAllDevices,
  approveDevice,
  adminRemoveDevice,
  type AdminDeviceEntry,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Loader2,
  Monitor,
  ShieldCheck,
  Trash2,
  AlertCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import {
  deviceDisplayLabel,
  formatRelativeDate,
  shortenDeviceId,
} from '@/lib/device-format';
import { queryKeys } from '@/lib/query-keys';

export function AdminDevicesPage() {
  const queryClient = useQueryClient();
  const isAdmin = useAuth((s) => s.user?.role === 'admin');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.devices.admin,
    queryFn: fetchAllDevices,
    enabled: isAdmin,
    refetchInterval: 15_000,
  });

  const approveMutation = useMutation({
    mutationFn: approveDevice,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.devices.admin });
      toast.success('Device approved');
    },
    onError: (err: any) => {
      toast.error(err?.message ?? 'Failed to approve device');
    },
  });

  const removeMutation = useMutation({
    mutationFn: adminRemoveDevice,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.devices.admin });
      setDeletingId(null);
      toast.success('Device removed');
    },
    onError: (err: any) => {
      toast.error(err?.message ?? 'Failed to remove device');
    },
  });

  const { pending, approved } = useMemo(() => {
    const all = data?.devices ?? [];
    return {
      pending: all.filter((d) => !d.isApproved),
      approved: all.filter((d) => d.isApproved),
    };
  }, [data]);

  if (!isAdmin) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="size-4" />
            Admin access required.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Devices"
        subtitle="Approve or revoke device keys across all users."
      />
      <div className="flex-1 overflow-auto p-6">
        <div className="space-y-6 max-w-4xl mx-auto">
          <PairDeviceCard />
          {isLoading && (
            <Card>
              <CardContent className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading devices…
              </CardContent>
            </Card>
          )}

          {error && (
            <Card>
              <CardContent className="p-6 space-y-3">
                <p className="text-sm text-destructive">
                  Failed to load devices:{' '}
                  {(error as any)?.message ?? 'Unknown error'}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetch()}
                  disabled={isFetching}
                >
                  {isFetching ? 'Retrying…' : 'Retry'}
                </Button>
              </CardContent>
            </Card>
          )}

          {!isLoading && !error && (
            <>
              <Card>
                <CardContent className="p-6 space-y-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">
                      Pending approval ({pending.length})
                    </CardTitle>
                  </div>
                  {pending.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No devices waiting for approval.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {pending.map((device) => (
                        <DeviceAdminRow
                          key={device.deviceId}
                          device={device}
                          deleting={deletingId === device.deviceId}
                          onApprove={() =>
                            approveMutation.mutate(device.deviceId)
                          }
                          onAskRemove={() => setDeletingId(device.deviceId)}
                          onConfirmRemove={() =>
                            removeMutation.mutate(device.deviceId)
                          }
                          onCancelRemove={() => setDeletingId(null)}
                          approveBusy={approveMutation.isPending}
                          removeBusy={removeMutation.isPending}
                        />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-6 space-y-3">
                  <CardTitle className="text-base">
                    Approved devices ({approved.length})
                  </CardTitle>
                  {approved.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No approved devices yet.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {approved.map((device) => (
                        <DeviceAdminRow
                          key={device.deviceId}
                          device={device}
                          deleting={deletingId === device.deviceId}
                          onAskRemove={() => setDeletingId(device.deviceId)}
                          onConfirmRemove={() =>
                            removeMutation.mutate(device.deviceId)
                          }
                          onCancelRemove={() => setDeletingId(null)}
                          removeBusy={removeMutation.isPending}
                        />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DeviceAdminRow({
  device,
  deleting,
  onApprove,
  onAskRemove,
  onConfirmRemove,
  onCancelRemove,
  approveBusy,
  removeBusy,
}: {
  device: AdminDeviceEntry;
  deleting: boolean;
  onApprove?: () => void;
  onAskRemove: () => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
  approveBusy?: boolean;
  removeBusy?: boolean;
}) {
  return (
    <div
      data-ui="admin-device-row"
      data-device-id={device.deviceId}
      className="relative flex flex-col sm:flex-row sm:items-start justify-between gap-3 p-3 rounded-lg border bg-muted/20"
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div
          className={cn(
            'p-1.5 rounded-md shrink-0',
            device.isApproved
              ? 'bg-emerald-100 dark:bg-emerald-900/40'
              : 'bg-amber-100 dark:bg-amber-900/40',
          )}
        >
          <Monitor
            className={cn(
              'size-4',
              device.isApproved
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-amber-600 dark:text-amber-400',
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="text-sm font-medium truncate"
              title={device.deviceId}
            >
              {deviceDisplayLabel(device)}
            </span>
            {!device.isApproved && (
              <Badge className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/50 dark:text-amber-300 dark:border-amber-800">
                Pending
              </Badge>
            )}
            {!device.isActive && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                Inactive
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate">
            <span className="font-medium text-foreground/70">
              {device.username ?? (
                <span className="italic">unassigned ({device.userId})</span>
              )}
            </span>
            <span className="font-mono">
              {' '}
              · {shortenDeviceId(device.deviceId)}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            Last used {formatRelativeDate(device.lastUsedAt)} · Registered{' '}
            {formatRelativeDate(device.createdAt)}
          </p>
          <IntegrationDetails device={device} admin />
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {!device.isApproved && onApprove && (
          <Button
            variant="default"
            size="sm"
            className="h-7 text-xs"
            onClick={onApprove}
            disabled={approveBusy}
          >
            <ShieldCheck className="size-3 mr-1" />
            Approve
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-destructive hover:text-destructive"
          onClick={onAskRemove}
          disabled={removeBusy}
        >
          <Trash2 className="size-3 mr-1" />
          Remove
        </Button>
      </div>

      {deleting && (
        <div className="absolute right-3 top-3 bg-popover border rounded-lg shadow-lg p-3 z-20 w-56">
          <p className="text-xs mb-2">
            Remove this device? The owner will need to re-enroll on next login.
          </p>
          <div className="flex gap-1.5 justify-end">
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={onCancelRemove}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-6 text-xs"
              onClick={onConfirmRemove}
              disabled={removeBusy}
            >
              Remove
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/admin/devices')({
  component: AdminDevicesPage,
});
