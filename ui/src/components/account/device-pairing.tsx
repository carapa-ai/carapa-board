import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Select, SelectItem } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import {
  resolveDevicePairing,
  decideDevicePairing,
  updateIntegrationGrant,
  fetchUsers,
  type PairingDetails,
  type DeviceEntry,
} from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

const selectClass = 'w-full min-w-0';
function Duration({
  value,
  onChange,
  keep = false,
}: {
  value: string;
  onChange: (value: string) => void;
  keep?: boolean;
}) {
  return (
    <label className="block space-y-1 text-sm">
      Authorization expires
      <Select
        aria-label="Authorization duration"
        className={selectClass}
        value={value}
        onValueChange={(nextValue) => onChange(nextValue)}
      >
        {keep && <SelectItem value="keep">Keep current expiry</SelectItem>}
        {[1, 7, 30, 90].map((days) => (
          <SelectItem key={days} value={String(days)}>
            {days} {days === 1 ? 'day' : 'days'} from approval
          </SelectItem>
        ))}
        <SelectItem value="never">Never — until revoked</SelectItem>
      </Select>
    </label>
  );
}
function ScopePicker({
  available,
  selected,
  onChange,
}: {
  available: string[];
  selected: string[];
  onChange: (scopes: string[]) => void;
}) {
  const options = available.map((id) => {
    const [domain, action] = id.split(':');
    return {
      id,
      domain,
      action,
      powerful: ['execute', 'send', 'control', 'push', 'delete'].includes(
        action,
      ),
    };
  });
  const groups = [...new Set(options.map((s) => s.domain))];
  return (
    <div
      data-ui="device-scope-picker"
      className="grid min-w-0 gap-3 sm:grid-cols-2"
    >
      {groups.map((domain) => (
        <fieldset key={domain} className="min-w-0 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium capitalize">
            {domain}
          </legend>
          {options
            .filter((s) => s.domain === domain)
            .map((scope) => (
              <label
                key={scope.id}
                className="flex items-start gap-2 py-1 text-sm"
              >
                <Checkbox
                  className="mt-1"
                  checked={selected.includes(scope.id)}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked === true
                        ? [...selected, scope.id]
                        : selected.filter((s) => s !== scope.id),
                    )
                  }
                />
                <span className="min-w-0 break-words capitalize">
                  {scope.action === 'write'
                    ? 'Create and update'
                    : scope.action}
                  {scope.powerful && (
                    <span className="block text-xs font-normal text-muted-foreground">
                      Explicit action permission
                    </span>
                  )}
                </span>
              </label>
            ))}
        </fieldset>
      ))}
    </div>
  );
}
export function PairDeviceCard() {
  const [code, setCode] = useState('');
  const [request, setRequest] = useState<PairingDetails | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [ownerId, setOwnerId] = useState('');
  const [days, setDays] = useState('30');
  const user = useAuth((s) => s.user);
  const queryClient = useQueryClient();
  const { data: users = [] } = useQuery({
    queryKey: ['users', 'pairing'],
    queryFn: fetchUsers,
    enabled: !!request,
  });
  const resolve = useMutation({
    mutationFn: resolveDevicePairing,
    onSuccess: (r) => {
      setRequest(r);
      setScopes(r.requestedScopes);
      setOwnerId(user?.id || '');
      setDays('30');
    },
  });
  const decide = useMutation({
    mutationFn: (decision: 'approved' | 'denied') =>
      decideDevicePairing(request!.id, {
        decision,
        ownerId,
        scopes: decision === 'denied' ? request!.requestedScopes : scopes,
        days: days === 'never' ? null : Number(days),
      }),
    onSuccess: (r) => {
      toast.success(
        r.status === 'approved' ? 'Device paired' : 'Pairing denied',
      );
      setRequest(null);
      setCode('');
      queryClient.invalidateQueries({ queryKey: queryKeys.devices.admin });
      queryClient.invalidateQueries({ queryKey: queryKeys.devices.account });
    },
  });
  return (
    <Card data-ui="device-pairing">
      <CardContent className="space-y-4 p-4 sm:p-6">
        <CardTitle className="text-base">Pair device</CardTitle>
        <p className="text-sm text-muted-foreground">
          Enter the code shown by the script or CLI you are connecting. Only
          approve a request you started. If the client generates a replacement
          code, choose “Use another code” below to enter it.
        </p>
        {!request ? (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              decide.reset();
              resolve.mutate(code);
            }}
          >
            <Input
              aria-label="Pairing code"
              placeholder="ABCD-EFGH"
              className="min-w-0 font-mono uppercase sm:max-w-xs"
              value={code}
              maxLength={20}
              autoComplete="off"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <Button
              disabled={
                resolve.isPending || code.replace(/[\s-]/g, '').length !== 8
              }
            >
              Review device
            </Button>
          </form>
        ) : (
          <div data-ui="pairing-review" className="min-w-0 space-y-4">
            <div>
              <p className="break-words font-medium">{request.label}</p>
              <p className="text-sm text-muted-foreground">
                Reviewing code <span className="font-mono">{code}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                Name supplied by the client · Code expires{' '}
                {new Date(request.expiresAt).toLocaleTimeString()}
              </p>
            </div>
            <label className="block space-y-1 text-sm">
              Device owner
              <Select
                aria-label="Device owner"
                className={selectClass}
                value={ownerId}
                onValueChange={(nextValue) => setOwnerId(nextValue)}
              >
                {user && (
                  <SelectItem value={user.id}>{user.username} (you)</SelectItem>
                )}
                {users
                  .filter((u) => !u.disabled && u.id !== user?.id)
                  .map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.username}
                    </SelectItem>
                  ))}
              </Select>
            </label>
            <p className="text-sm text-muted-foreground">
              Permissions apply only where this account has access. Execution
              can run agents with their configured tools and permissions.
            </p>
            <ScopePicker
              available={request.requestedScopes}
              selected={scopes}
              onChange={setScopes}
            />
            <Duration value={days} onChange={setDays} />
            <details className="text-xs text-muted-foreground">
              <summary>Key fingerprint</summary>
              <p className="break-all pt-2 font-mono">{request.fingerprint}</p>
            </details>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={decide.isPending || !scopes.length || !ownerId}
                onClick={() => decide.mutate('approved')}
              >
                Approve pairing
              </Button>
              <Button
                variant="outline"
                disabled={decide.isPending}
                onClick={() => decide.mutate('denied')}
              >
                Deny
              </Button>
              <Button
                variant="ghost"
                disabled={decide.isPending}
                onClick={() => {
                  setRequest(null);
                  setCode('');
                  resolve.reset();
                  decide.reset();
                }}
              >
                Use another code
              </Button>
            </div>
          </div>
        )}
        {(resolve.error || decide.error) && (
          <p role="alert" className="break-words text-sm text-destructive">
            {(resolve.error || decide.error)?.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
export function IntegrationDetails({
  device,
  admin = false,
}: {
  device: DeviceEntry;
  admin?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [scopes, setScopes] = useState(device.scopes || []);
  const [days, setDays] = useState('keep');
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: () =>
      updateIntegrationGrant(device.deviceId, {
        scopes,
        ...(days === 'keep'
          ? {}
          : { days: days === 'never' ? null : Number(days) }),
      }),
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.devices.admin });
      queryClient.invalidateQueries({ queryKey: queryKeys.devices.account });
      toast.success('Integration access updated');
    },
  });
  if (device.kind !== 'integration') return null;
  return (
    <div
      data-ui="integration-grant"
      data-device-id={device.deviceId}
      className="min-w-0 space-y-2 pt-2"
    >
      <p className="text-xs text-muted-foreground">
        Integration ·{' '}
        {device.expiresAt
          ? `${Date.parse(device.expiresAt) <= Date.now() ? 'Expired' : 'Expires'} ${new Date(device.expiresAt).toLocaleDateString()}`
          : 'Until revoked'}
      </p>
      <p className="break-words text-xs text-muted-foreground">
        {(device.scopes || []).join(', ')}
      </p>
      {admin && !editing && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setScopes(device.scopes);
            setDays('keep');
            setEditing(true);
          }}
        >
          Manage access
        </Button>
      )}
      {admin && editing && (
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-sm text-muted-foreground">
            Reduce permissions or renew authorization. Additional permissions
            require a new pairing.
          </p>
          <ScopePicker
            available={device.scopes}
            selected={scopes}
            onChange={setScopes}
          />
          <Duration keep value={days} onChange={setDays} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={update.isPending || !scopes.length}
              onClick={() => update.mutate()}
            >
              Save access
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          {update.error && (
            <p role="alert" className="text-sm text-destructive">
              {update.error.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
