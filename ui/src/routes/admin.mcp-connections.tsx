import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelMcpLogin,
  completeMcpLogin,
  fetchMcpConnections,
  revokeMcpConnection,
  startMcpLogin,
  type McpConnectionsView,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/layout/page-header';
import { toast } from 'sonner';
import { pollUnlessError } from '@/lib/use-query-load-state';
import { queryKeys } from '@/lib/query-keys';

type Service = McpConnectionsView['services'][number];
type Login = McpConnectionsView['logins'][number];
type Target = { service: string; project: string };

const stateLabels: Record<string, string> = {
  connected: 'Connected',
  loginRequired: 'Login required',
  refreshFailed: 'Refresh failed',
};
const stateVariants = {
  connected: 'default',
  loginRequired: 'outline',
  refreshFailed: 'destructive',
} as const;

const isPending = (login: Login) =>
  login.state === 'starting' || login.state === 'awaitingCallback';

export function McpConnectionsPage() {
  const isAdmin = useAuth((s) => s.user?.role === 'admin');
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState<Target | null>(null);
  const query = useQuery({
    queryKey: queryKeys.admin.mcpConnections,
    queryFn: fetchMcpConnections,
    enabled: isAdmin,
    refetchInterval: pollUnlessError(2000),
    gcTime: 0,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.mcpConnections });
  const start = useMutation({
    mutationFn: (target: Target) => startMcpLogin(target),
    onSuccess: refresh,
    onError: () => toast.error('Unable to start login'),
  });
  const revoke = useMutation({
    mutationFn: (target: Target) => revokeMcpConnection(target),
    onSuccess: () => {
      setRevoking(null);
      toast.success('Connection revoked');
      void refresh();
    },
    onError: () => toast.error('Unable to revoke connection'),
  });
  if (!isAdmin) return <div className="p-6">Admin access required.</div>;

  const logins = query.data?.logins ?? [];
  const visibleLogins = logins.filter((login) => login.state !== 'connected');
  const busy = (target: Target) =>
    start.isPending ||
    logins.some(
      (login) =>
        isPending(login) &&
        login.service === target.service &&
        login.project === target.project,
    );

  return (
    <div
      className="flex min-w-0 flex-1 flex-col overflow-hidden"
      id="mcp-connections"
    >
      <PageHeader
        title="MCP connections"
        subtitle="Remote MCP services signed in through the CarapaBox relay, per project."
      />
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          <p className="text-sm text-muted-foreground">
            You approve sign-in on the service’s website. CarapaBox stores the
            tokens; they are never shown here or exposed to agent sandboxes.
          </p>
          {query.isLoading && <p role="status">Loading MCP connections…</p>}
          {query.error && (
            <Card>
              <CardContent className="space-y-3 p-4">
                <p role="alert" className="text-sm text-destructive">
                  {query.error.message}
                </p>
                <Button variant="outline" onClick={() => query.refetch()}>
                  Retry
                </Button>
              </CardContent>
            </Card>
          )}
          {query.data && !query.data.services.length && (
            <p className="text-sm text-muted-foreground">
              No mcp-oauth services configured in CarapaBox relay-clients.
            </p>
          )}
          {query.data?.services.map((service) => (
            <ServiceCard
              key={service.service}
              service={service}
              busy={busy}
              onConnect={(project) =>
                start.mutate({ service: service.service, project })
              }
              onRevoke={(project) =>
                setRevoking({ service: service.service, project })
              }
            />
          ))}
          {visibleLogins.map((login) => (
            <LoginCard key={login.id} login={login} refresh={refresh} />
          ))}
        </div>
      </div>
      <Dialog
        open={!!revoking}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) setRevoking(null);
        }}
      >
        <DialogContent data-ui="mcp-revoke-dialog">
          <DialogHeader>
            <DialogTitle>Revoke connection?</DialogTitle>
            <DialogDescription>
              Project “{revoking?.project}” will lose access to{' '}
              {revoking?.service}. It must sign in again to reconnect.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={revoke.isPending}
              onClick={() => setRevoking(null)}
            >
              Keep connected
            </Button>
            <Button
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => revoking && revoke.mutate(revoking)}
            >
              {revoke.isPending ? 'Revoking…' : 'Confirm revoke'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ServiceCard({
  service,
  busy,
  onConnect,
  onRevoke,
}: {
  service: Service;
  busy: (target: Target) => boolean;
  onConnect: (project: string) => void;
  onRevoke: (project: string) => void;
}) {
  return (
    <Card data-ui="mcp-service" data-service={service.service}>
      <CardContent className="space-y-3 p-4">
        <div className="min-w-0">
          <CardTitle className="break-words text-base">
            {service.service}
          </CardTitle>
          <p className="break-words text-xs text-muted-foreground">
            {service.host}
          </p>
        </div>
        {!service.projects.length ? (
          <p className="text-sm text-muted-foreground">No projects yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2 font-normal">Project</th>
                <th className="py-1 pr-2 font-normal">State</th>
                <th className="py-1 text-right font-normal">Actions</th>
              </tr>
            </thead>
            <tbody>
              {service.projects.map((row) => (
                <tr
                  key={row.project}
                  data-ui="mcp-connection"
                  data-service={service.service}
                  data-project={row.project}
                  className="border-t"
                >
                  <td className="break-words py-2 pr-2 font-medium">
                    {row.project}
                  </td>
                  <td className="py-2 pr-2">
                    <Badge variant={stateVariants[row.state] ?? 'outline'}>
                      {stateLabels[row.state] ?? row.state}
                    </Badge>
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap justify-end gap-2">
                      {row.state !== 'connected' && (
                        <Button
                          size="sm"
                          disabled={busy({
                            service: service.service,
                            project: row.project,
                          })}
                          onClick={() => onConnect(row.project)}
                        >
                          Connect
                        </Button>
                      )}
                      {row.state !== 'loginRequired' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onRevoke(row.project)}
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function LoginCard({
  login,
  refresh,
}: {
  login: Login;
  refresh: () => Promise<unknown>;
}) {
  const [value, setValue] = useState('');
  const complete = useMutation({
    mutationFn: () => completeMcpLogin(login.id, value.trim()),
    onSuccess: () => {
      setValue('');
      void refresh();
    },
    onError: () => {
      setValue('');
      toast.error('Login response was not accepted. Check the pasted URL.');
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelMcpLogin(login.id),
    onSuccess: refresh,
    onError: () => toast.error('Unable to cancel login'),
  });
  return (
    <Card data-ui="mcp-login" data-login-id={login.id}>
      <CardContent className="space-y-3 p-4">
        <CardTitle className="break-words text-base">
          {login.service} · {login.project}
        </CardTitle>
        <p role="status" className="text-sm text-muted-foreground">
          {login.state === 'starting' && 'Starting login…'}
          {login.state === 'awaitingCallback' && 'Waiting for your approval'}
          {login.state === 'failed' && (
            <>
              Login failed
              {login.error && (
                <>
                  : <code className="font-mono">{login.error}</code>
                </>
              )}
            </>
          )}
        </p>
        {login.state === 'awaitingCallback' && login.authorizationUrl && (
          <>
            <Button asChild variant="outline">
              <a
                href={login.authorizationUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open sign-in
              </a>
            </Button>
            <div className="space-y-2">
              <label
                htmlFor={'mcp-response-' + login.id}
                className="text-sm font-medium"
              >
                Callback URL
              </label>
              <Input
                id={'mcp-response-' + login.id}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                After approving, your browser opens
                http://127.0.0.1:33418/callback?… which won't load — paste that
                full URL here.
              </p>
              <Button
                disabled={!value.trim() || complete.isPending}
                onClick={() => complete.mutate()}
              >
                {complete.isPending ? 'Completing…' : 'Complete login'}
              </Button>
            </div>
          </>
        )}
        <Button
          variant="ghost"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          {login.state === 'failed' ? 'Dismiss' : 'Cancel login'}
        </Button>
      </CardContent>
    </Card>
  );
}

export const Route = createFileRoute('/admin/mcp-connections')({
  component: McpConnectionsPage,
});
