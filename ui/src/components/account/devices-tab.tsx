import { IntegrationDetails } from './device-pairing';
import { useEffect, useId, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FieldRow } from '@/components/ui/field-row';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

import { Loader2, Monitor, ShieldAlert, Pencil, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  fetchUserDevices,
  updateDeviceStatus,
  updateDeviceLabel,
  removeDevice,
  type DeviceEntry,
} from '@/lib/api';
import { logout } from '@/lib/auth';
import { deviceDisplayLabel, formatRelativeDate } from '@/lib/device-format';
import { queryKeys } from '@/lib/query-keys';

export function DevicesTab() {
  const queryClient = useQueryClient();
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState<string>('');

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.devices.account,
    queryFn: fetchUserDevices,
    staleTime: 10_000,
  });

  const devices = data?.devices ?? [];
  // Only active, approved devices can sign in; pending ones don't count.
  const activeCount = devices.filter((d) => d.isActive && d.isApproved).length;
  const confirmingLastActive =
    confirmingRemove !== null &&
    activeCount <= 1 &&
    devices.some(
      (d) => d.deviceId === confirmingRemove && d.isActive && d.isApproved,
    );

  // A refetch can turn the device being confirmed into the last active one;
  // the server would refuse its removal, so drop the stale confirmation.
  useEffect(() => {
    if (confirmingLastActive) setConfirmingRemove(null);
  }, [confirmingLastActive]);

  const activateMutation = useMutation({
    mutationFn: (deviceId: string) => updateDeviceStatus(deviceId, true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.devices.account });
      toast.success('Device activated');
    },
    onError: (err: any) => {
      toast.error(err?.message ?? 'Failed to activate device');
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: (deviceId: string) => updateDeviceStatus(deviceId, false),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.devices.account });
      toast.success('Device deactivated');
    },
    onError: (err: any) => {
      toast.error(err?.message ?? 'Failed to deactivate device');
    },
  });

  const labelMutation = useMutation({
    mutationFn: ({
      deviceId,
      label,
    }: {
      deviceId: string;
      label: string | null;
    }) => updateDeviceLabel(deviceId, label),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.devices.account });
      setEditingLabel(null);
      toast.success('Device renamed');
    },
    onError: (err: any) => {
      toast.error(err?.message ?? 'Failed to rename device');
    },
  });

  function startEditLabel(device: DeviceEntry) {
    setEditingLabel(device.deviceId);
    setLabelDraft(device.label ?? '');
  }

  function commitLabel(deviceId: string) {
    const trimmed = labelDraft.trim();
    labelMutation.mutate({ deviceId, label: trimmed === '' ? null : trimmed });
  }

  const removeMutation = useMutation({
    mutationFn: ({
      deviceId,
      confirm,
    }: {
      deviceId: string;
      confirm: boolean;
    }) => removeDevice(deviceId, { confirm }),
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.devices.account });
      setConfirmingRemove(null);
      if (data.signedOut) {
        toast.success('This device was removed. Signing you out…');
        // Server already invalidated the session; clear local auth so the
        // AuthGate routes us back to login.
        await logout();
      } else {
        toast.success('Device removed');
      }
    },
    onError: (err: any) => {
      toast.error(err?.message ?? 'Failed to remove device');
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading devices…
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <CardTitle className="text-base">Devices</CardTitle>
          <p className="text-sm text-destructive">
            Failed to load devices: {(error as any)?.message ?? 'Unknown error'}
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
    );
  }

  if (devices.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 space-y-4">
          <CardTitle className="text-base">Devices</CardTitle>
          <p className="text-sm text-muted-foreground">
            No registered devices. Your current device was registered when you
            logged in.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <CardTitle className="text-base">Devices</CardTitle>

        {devices.map((device) => (
          <DeviceRow
            key={device.deviceId}
            device={device}
            isLastActive={
              device.isActive && device.isApproved && activeCount <= 1
            }
            confirmingRemove={confirmingRemove}
            editingLabel={editingLabel}
            labelDraft={labelDraft}
            setLabelDraft={setLabelDraft}
            labelSaving={labelMutation.isPending}
            onActivate={() => activateMutation.mutate(device.deviceId)}
            onDeactivate={() => deactivateMutation.mutate(device.deviceId)}
            onRemove={() => setConfirmingRemove(device.deviceId)}
            removing={removeMutation.isPending}
            onRemoveConfirm={() =>
              removeMutation.mutate({
                deviceId: device.deviceId,
                confirm: device.isCurrent,
              })
            }
            onRemoveCancel={() => setConfirmingRemove(null)}
            onStartEditLabel={() => startEditLabel(device)}
            onCommitLabel={() => commitLabel(device.deviceId)}
            onCancelEditLabel={() => setEditingLabel(null)}
          />
        ))}

        <p className="text-xs text-muted-foreground pt-2 border-t">
          The device you are signed in from is marked “This device”. Removing it
          will sign you out of this session immediately.
        </p>
      </CardContent>
    </Card>
  );
}

function DeviceRow({
  device,
  isLastActive,
  confirmingRemove,
  editingLabel,
  labelDraft,
  setLabelDraft,
  labelSaving,
  onActivate,
  onDeactivate,
  onRemove,
  removing,
  onRemoveConfirm,
  onRemoveCancel,
  onStartEditLabel,
  onCommitLabel,
  onCancelEditLabel,
}: {
  device: DeviceEntry;
  isLastActive: boolean;
  confirmingRemove: string | null;
  editingLabel: string | null;
  labelDraft: string;
  setLabelDraft: (v: string) => void;
  labelSaving: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  onRemove: () => void;
  removing: boolean;
  onRemoveConfirm: () => void;
  onRemoveCancel: () => void;
  onStartEditLabel: () => void;
  onCommitLabel: () => void;
  onCancelEditLabel: () => void;
}) {
  const isCurrent = device.isCurrent;
  const isEditing = editingLabel === device.deviceId;
  const removeMessageId = useId();
  const hintId = useId();
  const hint = isLastActive
    ? 'Add another device to remove this one'
    : isCurrent && device.isActive
      ? 'Cannot deactivate the device you are signed in from'
      : null;
  return (
    <div
      className={cn(
        'relative flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border',
        device.isActive
          ? 'border-border bg-muted/30'
          : 'border-border/60 bg-muted/10',
        isCurrent && 'ring-1 ring-cyan-600/60 dark:ring-cyan-500/40',
      )}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1 basis-56">
        <div
          className={cn(
            'p-1.5 rounded-md shrink-0',
            device.isActive
              ? 'bg-emerald-100 dark:bg-emerald-900/40'
              : 'bg-amber-100 dark:bg-amber-900/40',
          )}
        >
          <Monitor
            className={cn(
              'size-4',
              device.isActive
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-amber-600 dark:text-amber-400',
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {isEditing ? (
              <FieldRow compact className="gap-1">
                <Input
                  autoFocus
                  value={labelDraft}
                  onChange={(e) => setLabelDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onCommitLabel();
                    else if (e.key === 'Escape') onCancelEditLabel();
                  }}
                  maxLength={64}
                  placeholder={deviceDisplayLabel(device)}
                  aria-label={`Name for ${deviceDisplayLabel(device)}`}
                  compact
                  className="w-44"
                  disabled={labelSaving}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onCommitLabel}
                  disabled={labelSaving}
                  title="Save name"
                  aria-label="Save name"
                >
                  <Check className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onCancelEditLabel}
                  disabled={labelSaving}
                  title="Cancel"
                  aria-label="Cancel rename"
                >
                  <X className="size-3.5" />
                </Button>
              </FieldRow>
            ) : (
              <>
                <span
                  className={cn(
                    'text-sm truncate font-medium',
                    device.label ? '' : 'font-mono',
                  )}
                  title={device.deviceId}
                >
                  {deviceDisplayLabel(device)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground"
                  onClick={onStartEditLabel}
                  title="Rename device"
                  aria-label={`Rename ${deviceDisplayLabel(device)}`}
                >
                  <Pencil className="size-3" />
                </Button>
              </>
            )}
            <Badge
              variant={device.isActive ? 'default' : 'secondary'}
              className={cn(
                'text-[10px] px-1.5 py-0',
                device.isActive &&
                  'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/50 dark:text-emerald-300 dark:border-emerald-800',
              )}
            >
              {device.isActive ? 'Active' : 'Inactive'}
            </Badge>
            {!device.isApproved && (
              <Badge className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/50 dark:text-amber-300 dark:border-amber-800">
                Pending approval
              </Badge>
            )}
            {isCurrent && (
              <Badge className="text-[10px] px-1.5 py-0 bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-900/50 dark:text-cyan-300 dark:border-cyan-800">
                This device
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Last used {formatRelativeDate(device.lastUsedAt)}
          </p>
          <IntegrationDetails device={device} />
        </div>
      </div>

      <div className="flex flex-col items-end gap-0.5 shrink-0 ml-auto">
        <div className="flex items-center gap-1">
          {device.isActive ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={onDeactivate}
                disabled={isCurrent}
                aria-describedby={
                  isCurrent && !isLastActive ? hintId : undefined
                }
                title={
                  isCurrent
                    ? 'Cannot deactivate the device you are signed in from'
                    : undefined
                }
              >
                Deactivate
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-destructive hover:text-destructive"
                onClick={onRemove}
                disabled={isLastActive}
                aria-describedby={isLastActive ? hintId : undefined}
                title={
                  isCurrent && !isLastActive
                    ? 'Removing this device will sign you out'
                    : undefined
                }
              >
                Remove
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={onActivate}
              >
                Activate
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-destructive hover:text-destructive"
                onClick={onRemove}
              >
                Remove
              </Button>
            </>
          )}
        </div>
        {hint && (
          <p
            id={hintId}
            data-ui="device-action-hint"
            className="text-[11px] text-muted-foreground"
          >
            {hint}
          </p>
        )}
      </div>

      {confirmingRemove === device.deviceId && (
        <div
          role="alertdialog"
          aria-labelledby={removeMessageId}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onRemoveCancel();
          }}
          className={cn(
            'absolute right-3 top-3 bg-popover border rounded-lg shadow-lg p-3 z-20',
            isCurrent ? 'w-64' : 'w-56',
          )}
        >
          <p
            id={removeMessageId}
            className="text-xs mb-2 flex items-start gap-1.5"
          >
            <ShieldAlert className="size-3 text-destructive shrink-0 mt-0.5" />
            <span>
              {isCurrent
                ? 'Remove this device? You will be signed out of this session immediately and need to log in again to use it.'
                : 'Remove this device?'}
            </span>
          </p>
          <div className="flex gap-1.5 justify-end">
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={onRemoveCancel}
              autoFocus
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-6 text-xs"
              onClick={onRemoveConfirm}
              disabled={removing}
            >
              {isCurrent ? 'Remove & sign out' : 'Remove'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
