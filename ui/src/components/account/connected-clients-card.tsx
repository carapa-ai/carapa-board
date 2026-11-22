import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, PlugZap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { EditGrantDialog } from '@/components/account/edit-grant-dialog';
import { fetchOAuthGrants, revokeOAuthGrant, type OAuthGrant } from '@/lib/api';
import {
  describeOAuthAccess,
  describeOAuthTarget,
  oauthResourcePath,
} from '@/lib/oauth-display';

const GRANTS_KEY = ['oauth', 'grants'] as const;

/** One line: "3 projects, 1 read & write: A, B, C" (full list in the tooltip). */
function describeGrantTargets(targets: OAuthGrant['targets']): string {
  const writable = targets.filter((target) => target.access === 'write').length;
  const access =
    writable === 0
      ? 'read-only'
      : writable === targets.length
        ? 'read & write'
        : `${writable} read & write`;
  const names = targets
    .map((target) => describeOAuthTarget(target, target.name))
    .join(', ');
  const count = `${targets.length} project${targets.length === 1 ? '' : 's'}`;
  return `${count}, ${access}: ${names}`;
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'Never';
}

export function ConnectedClientsCard() {
  const queryClient = useQueryClient();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<OAuthGrant | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: GRANTS_KEY,
    queryFn: fetchOAuthGrants,
    staleTime: 10_000,
  });

  const revokeMutation = useMutation({
    mutationFn: (grantId: string) => revokeOAuthGrant(grantId),
    onSuccess: (_result, grantId) => {
      queryClient.setQueryData<OAuthGrant[]>(GRANTS_KEY, (current) =>
        current?.filter((grant) => grant.id !== grantId),
      );
      setConfirmingId(null);
      toast.success('Access revoked');
    },
    onError: (err: any) => {
      toast.error(err?.message ?? 'Failed to revoke access');
    },
  });

  const grants = data ?? [];

  return (
    <Card data-ui="connected-mcp-clients">
      <CardContent className="p-6 space-y-4">
        <CardTitle className="text-base">Connected MCP clients</CardTitle>

        {isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading connected clients…
          </p>
        ) : error ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive">
              Failed to load connected clients:{' '}
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
          </div>
        ) : grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No remote MCP clients are connected. Clients you approve through the
            sign-in page appear here.
          </p>
        ) : (
          grants.map((grant) => (
            <div
              key={grant.id}
              data-ui="connected-mcp-client"
              data-grant-id={grant.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3"
            >
              <div className="min-w-0 flex-1 basis-56 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <PlugZap className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">
                    {grant.clientName}
                  </span>
                </div>
                <p
                  data-ui="connected-mcp-client-targets"
                  className="truncate text-xs text-muted-foreground"
                  title={grant.targets
                    .map(
                      (target) =>
                        `${describeOAuthTarget(target, target.name)} (${describeOAuthAccess(target.access)})`,
                    )
                    .join('\n')}
                >
                  {describeGrantTargets(grant.targets)}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {oauthResourcePath(grant.resource)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Created {formatDate(grant.createdAt)} · Last used{' '}
                  {formatDate(grant.lastUsedAt)} · Expires{' '}
                  {formatDate(grant.expiresAt)}
                </p>
              </div>

              {confirmingId === grant.id ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={revokeMutation.isPending}
                    onClick={() => revokeMutation.mutate(grant.id)}
                  >
                    {revokeMutation.isPending ? 'Revoking…' : 'Confirm revoke'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={revokeMutation.isPending}
                    onClick={() => setConfirmingId(null)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing(grant)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmingId(grant.id)}
                  >
                    Revoke
                  </Button>
                </div>
              )}
            </div>
          ))
        )}

        <p className="border-t pt-2 text-xs text-muted-foreground">
          Revoking signs the client out immediately; it must ask for access
          again to reconnect.
        </p>
      </CardContent>
      <EditGrantDialog
        grant={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void queryClient.invalidateQueries({ queryKey: GRANTS_KEY });
        }}
      />
    </Card>
  );
}
