import { Copy, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { useSandboxSsh, useSetSandboxSsh } from '@/hooks/use-sandbox';
import {
  sandboxCoordinates,
  sandboxLifecycleIsManaged,
} from '@/lib/sandbox-settings';
import type { SandboxSshStatus } from '@/lib/api';
import type { Project } from '@/types';

export function SandboxSshLink({ ssh }: { ssh?: SandboxSshStatus }) {
  if (!ssh?.running || !ssh.host || !ssh.port || !ssh.command) return null;
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1 text-xs md:text-sm text-muted-foreground hover:text-foreground"
      data-ui="sandbox-ssh-link"
      title={
        ssh.ingress
          ? `Copy SSH command: ${ssh.command}. Connect from an allowed device on your network.`
          : `Copy command for the Docker host: ${ssh.command}. Remote access requires the Docker host as an SSH jump host.`
      }
      aria-label={`Copy SSH connection command for ${ssh.host}:${ssh.port}`}
      onClick={() =>
        navigator.clipboard.writeText(ssh.command!).then(
          () =>
            toast.success(
              ssh.ingress
                ? 'SSH command copied. Run it from an allowed device on your network.'
                : 'SSH command copied. Run it on the Docker host, or use that host as an SSH jump host.',
            ),
          () => toast.error('Could not copy the SSH command'),
        )
      }
    >
      <Terminal className="size-3 shrink-0" />
      <span className="truncate">
        SSH {ssh.host}:{ssh.port}
      </span>
      <Copy className="size-2.5 shrink-0" />
    </button>
  );
}

export function SandboxSshSettings({
  project,
  disabled = false,
}: {
  project?: Project;
  disabled?: boolean;
}) {
  const { stack } = sandboxCoordinates(project);
  const status = useSandboxSsh(stack, project?.folder);
  const mutation = useSetSandboxSsh(stack, project?.folder ?? '');
  const enabled =
    status.data?.enabled ?? project?.settings?.sshEnabled ?? false;
  const managed = sandboxLifecycleIsManaged(project);
  return (
    <div className="space-y-2 rounded-md border p-3" id="settings-sandbox-ssh">
      <div className="flex items-center gap-2">
        <Checkbox
          id="settings-sandbox-ssh-enabled"
          checked={enabled}
          disabled={
            disabled ||
            !managed ||
            !status.data?.supported ||
            status.isFetching ||
            mutation.isPending
          }
          onCheckedChange={(value) => mutation.mutate(value === true)}
        />
        <label
          htmlFor="settings-sandbox-ssh-enabled"
          className="text-sm font-medium"
        >
          Enable sandbox SSH
        </label>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {mutation.isPending
          ? 'Applying SSH preference...'
          : status.isPending
            ? 'Checking SSH support...'
            : status.isError
              ? status.error.message
              : !managed
                ? 'Manage SSH from the project that owns this sandbox.'
                : !status.data?.supported
                  ? 'This stack needs managed SSH support before it can be enabled.'
                  : status.data.error
                    ? status.data.error
                    : status.data.running
                      ? 'SSH is running. Disabling it disconnects existing SSH sessions.'
                      : enabled
                        ? 'SSH is enabled, but the listener is stopped. A stopped sandbox applies this preference on its next start.'
                        : 'SSH is disabled.'}
      </p>
      {status.isError && (
        <Button variant="outline" size="sm" onClick={() => status.refetch()}>
          Retry
        </Button>
      )}
      {enabled &&
        status.data?.containerRunning &&
        !status.data.running &&
        managed &&
        !disabled && (
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(true)}
          >
            Retry SSH start
          </Button>
        )}
      <SandboxSshLink ssh={status.data} />
      <p className="text-xs text-muted-foreground">
        Changes apply immediately, independently of Save. Key-only login as
        ubuntu under runsc. Add your public key to
        AGENT_HOME/.ssh/authorized_keys on the host.{' '}
        {status.data?.ingress
          ? 'Connect from an allowed device on your network using the host and port shown above.'
          : 'Connect directly to the sandbox IP from the Docker host, or use the Docker host as an SSH jump host for remote access.'}{' '}
        The sidebar shows the current SSH host and port.
      </p>
      {disabled && (
        <p className="text-xs text-muted-foreground">
          Save sandbox configuration changes before managing SSH.
        </p>
      )}
    </div>
  );
}
