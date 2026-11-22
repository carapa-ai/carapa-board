import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { setPublishedApp } from '@/lib/api';
import { usePublishedApp } from '@/hooks/use-sandbox';
import { queryKeys } from '@/lib/query-keys';
import type { Project } from '@/types';

export function AppPublishingSettings({
  project,
  disabled = false,
}: {
  project?: Project;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [port, setPort] = useState('3000');
  const [hostname, setHostname] = useState('');
  const key = queryKeys.publishedApps.project(project?.folder);
  const status = usePublishedApp(project?.folder);
  useEffect(() => {
    setPort(
      String(
        status.data?.targetPort ??
          project?.settings?.appPublication?.targetPort ??
          3000,
      ),
    );
    setHostname(
      status.data?.hostname ??
        project?.settings?.appPublication?.hostname ??
        '',
    );
  }, [
    project?.folder,
    status.data?.targetPort,
    status.data?.hostname,
    project?.settings?.appPublication?.targetPort,
    project?.settings?.appPublication?.hostname,
  ]);
  const mutation = useMutation({
    mutationFn: (enabled: boolean) =>
      setPublishedApp(
        project!.folder,
        enabled
          ? {
              enabled,
              targetPort: Number(port),
              ...(hostname.trim() ? { hostname: hostname.trim() } : {}),
            }
          : { enabled },
      ),
    onSuccess: (result) => {
      queryClient.setQueryData(key, result);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const busy = disabled || !project || mutation.isPending;
  const current = status.data;
  return (
    <section
      id="settings-app-publishing"
      className="space-y-3 rounded-md border p-3"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">External app access</h3>
        <p className="text-xs text-muted-foreground">
          Open this app in another browser through CarapaBox. Start the app on
          the port below before publishing.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
        <div className="space-y-1">
          <label htmlFor="settings-app-port" className="text-sm">
            App port
          </label>
          <Input
            id="settings-app-port"
            type="number"
            min={1024}
            max={65535}
            value={port}
            onChange={(event) => setPort(event.target.value)}
            disabled={busy}
          />
        </div>
        <div className="space-y-1 min-w-0">
          <label htmlFor="settings-app-hostname" className="text-sm">
            Hostname (optional)
          </label>
          <Input
            id="settings-app-hostname"
            placeholder="Automatic when configured"
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            disabled={busy}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={
            busy ||
            !Number.isInteger(Number(port)) ||
            Number(port) < 1024 ||
            Number(port) > 65535 ||
            Number(port) === 2222
          }
          onClick={() => mutation.mutate(true)}
        >
          {mutation.isPending
            ? 'Applying…'
            : current?.enabled
              ? 'Update publication'
              : 'Publish app'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={
            busy ||
            !(
              current?.enabled ||
              project?.settings?.appPublication?.enabled ||
              mutation.isError
            )
          }
          onClick={() => mutation.mutate(false)}
        >
          Disable access
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={mutation.isPending || status.isFetching}
          onClick={() => {
            mutation.reset();
            void status.refetch();
          }}
        >
          Refresh
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {mutation.error?.message ||
          status.error?.message ||
          (status.isPending
            ? 'Checking publication…'
            : current?.enabled
              ? current.ready
                ? 'Ingress route is ready. Open the app to verify it.'
                : 'Publication is configured; the route is not ready.'
              : 'External access is disabled.')}
      </p>
      {current?.enabled && current.url && (
        <a
          href={current.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-start gap-1 text-sm underline break-all"
          data-ui="published-app-link"
        >
          <ExternalLink className="size-4 shrink-0 mt-0.5" />
          {current.url}
        </a>
      )}
      <p className="text-xs text-muted-foreground">
        Changes apply immediately, independently of Save. Access follows the
        configured network restrictions. Custom hostnames need DNS and
        certificate coverage. Publishing does not start or keep the app running.
      </p>
      {disabled && (
        <p className="text-xs text-muted-foreground">
          Save sandbox changes before publishing.
        </p>
      )}
    </section>
  );
}
