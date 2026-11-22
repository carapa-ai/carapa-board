/**
 * Sandbox Info modal — diagnostic deep-dive opened from the SandboxPanel
 * status text in the sidebar. Adds what the sidebar doesn't show:
 *   - per-service status / image / version comparison
 *   - the project's effective sandbox configuration
 *
 * Reuses the existing `useSandboxStatus` / `useSandboxPs` hooks, so the
 * modal refreshes on sandbox change notifications and reconnect.
 */

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useProjects } from '@/hooks/use-projects';
import {
  useSandboxStatus,
  useSandboxPs,
  useRemoveWorktree,
  useProjectWorktrees,
  useStopSandbox,
} from '@/hooks/use-sandbox';
import {
  CopyableText,
  SandboxServicePorts,
  SandboxWorktreePreview,
} from './sandbox-endpoints';
import {
  Check,
  AlertCircle,
  HelpCircle,
  ExternalLink,
  Loader2,
  Power,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  sandboxCoordinates,
  sandboxLifecycleIsManaged,
} from '@/lib/sandbox-settings';
import { confirmAction } from '@/components/confirm-dialog';

type ContainerVersion = {
  service: string;
  upToDate: boolean | null;
  imageId?: string;
  /** Human-readable docker compose status e.g. "Up 2 minutes", "Exited (0) 3 minutes ago". */
  statusText?: string;
};

/**
 * Pull a short uptime label out of the raw `Status` string.
 * "Up 2 minutes" → "2 minutes". Returns null when the container isn't up.
 */
function extractUptime(statusText: string | undefined): string | null {
  if (!statusText) return null;
  const m = statusText.match(/^Up\s+(.+?)(?:\s+\(.*\))?$/i);
  return m ? m[1].trim() : null;
}

export type AggregatedVersionStatus =
  | 'up-to-date'
  | 'outdated'
  | 'unknown'
  | null;

/**
 * Roll up per-container version flags into a single badge state.
 * Shared between SandboxPanel (sidebar) and the modal so both sites
 * compute identically.
 */
export function computeAggregatedVersionStatus(
  containers: ContainerVersion[] | undefined,
): AggregatedVersionStatus {
  const versionable = containers?.filter((c) => c.upToDate !== null) ?? [];
  if (versionable.length === 0) return null;
  if (versionable.every((c) => c.upToDate)) return 'up-to-date';
  if (versionable.some((c) => !c.upToDate)) return 'outdated';
  return 'unknown';
}

function shortImageId(id: string | undefined): string {
  if (!id) return '';
  return id.startsWith('sha256:') ? id.slice(7, 19) : id.slice(0, 12);
}

export function SandboxInfoDialog({
  open,
  onOpenChange,
  projectId,
  canStop,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId?: string;
  /** Stopping interrupts running work: owners (and admins) only. */
  canStop: boolean;
}) {
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === projectId);
  const group_folder = project?.folder;
  const effectiveSandbox = project?.effectiveSandbox;
  const { stack, instance: effectiveInstance } = sandboxCoordinates(project);
  const lifecycleManaged = sandboxLifecycleIsManaged(project);
  const remoteBoxId =
    effectiveSandbox?.boxId && effectiveSandbox.boxId !== 'local'
      ? effectiveSandbox.boxId
      : undefined;

  const { data: status, isLoading: statusLoading } =
    useSandboxStatus(group_folder);
  const { data: allInstances } = useSandboxPs();

  const statusKey = group_folder || Object.keys(status ?? {})[0];
  const groupStatus = statusKey
    ? (status as Record<string, Record<string, unknown>> | undefined)?.[
        statusKey
      ]
    : undefined;
  // Degraded: some services run while another crash-loops (restarting/dead).
  const isDegraded = groupStatus?.status === 'degraded';
  const isRunning = groupStatus?.status === 'running' || isDegraded;
  const stateText = (groupStatus?.status as string | undefined) ?? 'unknown';

  const containers = (groupStatus as any)?.containers as
    | ContainerVersion[]
    | undefined;
  const versionStatus = computeAggregatedVersionStatus(containers);

  const containerByService = new Map<string, ContainerVersion>();
  for (const c of containers ?? []) containerByService.set(c.service, c);

  const currentInstance = effectiveInstance
    ? (allInstances ?? []).find(
        (i) =>
          i.name === `${stack}-${effectiveInstance}` ||
          i.name === effectiveInstance,
      )
    : undefined;
  const services = currentInstance?.services ?? [];

  // Full list of managed git worktrees (works for every project, with or without
  // nginx previews). Preview ports — when they exist — are overlaid from the ps
  // `worktrees` array, matched by branch (slug is the branch with '/' → '-').
  const { data: projectWorktrees, isLoading: worktreesLoading } =
    useProjectWorktrees(open ? group_folder : undefined);
  const previewPortByKey = new Map<string, number>();
  for (const wt of currentInstance?.worktrees ?? [])
    previewPortByKey.set(wt.slug, wt.port);
  const worktrees = (projectWorktrees ?? []).map((wt) => ({
    branch: wt.branch,
    merged: wt.merged,
    port:
      previewPortByKey.get(wt.branch) ??
      previewPortByKey.get(wt.branch.replace(/\//g, '-')),
  }));

  const removeWorktree = useRemoveWorktree();
  const stopSandbox = useStopSandbox();
  const [stopConfirmationOpen, setStopConfirmationOpen] = useState(false);

  useEffect(() => {
    if (!open) setStopConfirmationOpen(false);
  }, [open]);

  const handleStopSandbox = () => {
    if (
      !group_folder ||
      !canStop ||
      !isRunning ||
      !lifecycleManaged ||
      stopSandbox.isPending
    )
      return;
    setStopConfirmationOpen(true);
  };

  const handleConfirmStopSandbox = () => {
    if (
      !group_folder ||
      !canStop ||
      !isRunning ||
      !lifecycleManaged ||
      stopSandbox.isPending
    )
      return;
    stopSandbox.mutate(
      { stack, group: group_folder },
      { onSuccess: () => setStopConfirmationOpen(false) },
    );
  };

  const handleRemoveWorktree = async (branch: string, merged?: boolean) => {
    // merged === false  → unmerged commits would be lost: hard warning.
    // merged === undefined → status unknown (check failed): cautious warning.
    // merged === true  → safe: plain confirm.
    const resumeNote =
      'Conversations using it will start a fresh session and recreate the worktree when resumed.';
    const [title, message, confirmLabel] =
      merged === false
        ? [
            `Delete "${branch}" anyway?`,
            `⚠️ "${branch}" is NOT merged into the base branch. Removing it will permanently discard its unmerged commits. ${resumeNote} This cannot be undone.`,
            'Delete anyway',
          ]
        : merged === undefined
          ? [
              'Remove this worktree?',
              `Could not verify whether "${branch}" is merged. If it has unmerged commits they will be lost permanently. ${resumeNote}`,
              'Remove',
            ]
          : [
              `Remove worktree "${branch}"?`,
              `It's merged into the base branch, so no commits will be lost, and its preview (if any) is removed too. ${resumeNote}`,
              'Remove',
            ];
    if (
      !(await confirmAction(message, {
        title,
        confirmLabel,
        destructive: merged !== true,
      }))
    )
      return;
    removeWorktree.mutate({ stack, group: group_folder, branch });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                'size-2.5 rounded-full',
                statusLoading
                  ? 'bg-yellow-700 dark:bg-yellow-500 animate-pulse'
                  : isDegraded
                    ? 'bg-amber-600 dark:bg-amber-500 animate-pulse'
                    : isRunning
                      ? 'bg-green-600 dark:bg-green-500'
                      : stateText === 'error'
                        ? 'bg-red-600 dark:bg-red-500'
                        : 'bg-red-600 dark:bg-red-500',
              )}
            />
            <span>Sandbox</span>
            <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
              {currentInstance?.name ??
                (group_folder ? `${stack}-${group_folder}` : '—')}
            </code>
            {versionStatus === 'up-to-date' && (
              <span title="All images up to date" className="ml-1">
                <Check className="size-3.5 text-green-700 dark:text-green-500" />
              </span>
            )}
            {versionStatus === 'outdated' && (
              <span title="Newer images available" className="ml-1">
                <AlertCircle className="size-3.5 text-amber-700 dark:text-amber-500" />
              </span>
            )}
            {versionStatus === 'unknown' && (
              <span title="Image version unknown" className="ml-1">
                <HelpCircle className="size-3.5 text-muted-foreground/60" />
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            Status: <span className="font-medium">{stateText}</span>
            {group_folder && (
              <>
                {' · '}
                Project:{' '}
                <span className="font-medium">
                  {project?.name ?? group_folder}
                </span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {(currentInstance?.urls?.length || currentInstance?.url) && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Sandbox URLs
            </h3>
            <div className="flex flex-col items-start gap-1">
              {(currentInstance.urls?.length
                ? currentInstance.urls
                : currentInstance.url
                  ? [currentInstance.url]
                  : []
              ).map((url, index) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1 text-sm font-mono text-cyan-700 dark:text-cyan-400 hover:underline"
                  title={`Open ${url}`}
                >
                  <span className="shrink-0 text-xs font-sans text-muted-foreground">
                    {index === 0 ? 'Primary' : 'Additional'}:
                  </span>
                  <span className="truncate">{url}</span>
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              ))}
            </div>
          </section>
        )}

        {/* Section: Per-service details */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Services
          </h3>
          {services.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              {isRunning
                ? 'No services reported.'
                : 'Sandbox is not running. Start it to see services.'}
            </p>
          ) : (
            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Service</th>
                    <th className="px-3 py-2 text-left font-medium">
                      Hostname
                    </th>
                    <th className="px-3 py-2 text-left font-medium">IP</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-left font-medium">Uptime</th>
                    <th className="px-3 py-2 text-left font-medium">Image</th>
                    <th className="px-3 py-2 text-left font-medium">Ports</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {services.map((svc) => {
                    const cv = containerByService.get(svc.service);
                    return (
                      <tr key={svc.service} className="align-top">
                        <td className="px-3 py-2 font-mono text-xs">
                          {svc.service}
                        </td>
                        <td className="px-3 py-2 max-w-[180px]">
                          <CopyableText
                            text={svc.hostname}
                            className="text-xs font-mono text-muted-foreground"
                          />
                        </td>
                        <td className="px-3 py-2 max-w-[140px]">
                          {svc.ip ? (
                            <CopyableText
                              text={svc.ip}
                              className="text-xs font-mono text-muted-foreground"
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground/60">
                              —
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={cn(
                              'text-xs font-medium',
                              svc.status === 'running'
                                ? 'text-green-700 dark:text-green-400'
                                : 'text-amber-700 dark:text-amber-400',
                            )}
                          >
                            {svc.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {extractUptime(cv?.statusText) ?? (
                            <span className="text-muted-foreground/60">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {cv?.upToDate === true && (
                            <span
                              title={
                                cv.imageId
                                  ? `Up to date · ${shortImageId(cv.imageId)}`
                                  : 'Up to date'
                              }
                              className="inline-flex items-center gap-1 text-xs text-green-700 dark:text-green-400"
                            >
                              <Check className="size-3" />
                              up-to-date
                            </span>
                          )}
                          {cv?.upToDate === false && (
                            <span
                              title={
                                cv.imageId
                                  ? `Newer image available · running ${shortImageId(cv.imageId)}`
                                  : 'Newer image available'
                              }
                              className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
                            >
                              <AlertCircle className="size-3" />
                              outdated
                            </span>
                          )}
                          {(!cv || cv.upToDate === null) && (
                            <span
                              className="text-xs text-muted-foreground/60"
                              title="Not versionable"
                            >
                              —
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {currentInstance && (
                            <SandboxServicePorts
                              instance={currentInstance}
                              service={svc}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Internal previews stay copyable even when the browser cannot reach the sandbox. */}
        {(worktrees.length > 0 || worktreesLoading) && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Worktrees
            </h3>
            {worktreesLoading && worktrees.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                Loading worktrees…
              </p>
            ) : (
              <div className="border border-border rounded-md divide-y divide-border">
                {worktrees.map((wt) => {
                  const isRemoving =
                    removeWorktree.isPending &&
                    removeWorktree.variables?.branch === wt.branch;
                  return (
                    <div
                      key={wt.branch}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <span
                        className="min-w-0 flex-1 text-xs font-mono truncate"
                        title={wt.branch}
                      >
                        {wt.branch}
                      </span>
                      {wt.merged === false && (
                        <span
                          // Translucent amber fill reads on both themes; only the text tone is theme-swapped.
                          className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400"
                          title="This branch is not merged into the base branch — deleting it discards its commits"
                        >
                          unmerged
                        </span>
                      )}
                      {wt.port == null ? (
                        <span className="text-xs text-muted-foreground/60 shrink-0">
                          no preview
                        </span>
                      ) : (
                        <SandboxWorktreePreview
                          worktree={{ slug: wt.branch, port: wt.port }}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          handleRemoveWorktree(wt.branch, wt.merged)
                        }
                        disabled={removeWorktree.isPending}
                        className="shrink-0 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
                        title={`Remove worktree ${wt.branch}`}
                        aria-label={`Remove worktree ${wt.branch}`}
                      >
                        {isRemoving ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* Section: Project sandbox config */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Project sandbox config
          </h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Host</dt>
            <dd className="text-xs" data-ui="sandbox-host">
              {remoteBoxId ? (
                <>
                  <span className="font-mono">{remoteBoxId}</span>{' '}
                  <span className="text-muted-foreground">
                    (remote CarapaBox)
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  This server (local CarapaBox)
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">Stack</dt>
            <dd className="font-mono text-xs">{stack}</dd>
            <dt className="text-muted-foreground">Instance</dt>
            <dd className="font-mono text-xs">
              {effectiveInstance || (
                <span className="text-muted-foreground/60">—</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Service</dt>
            <dd className="font-mono text-xs">
              {effectiveSandbox?.service || (
                <span className="text-muted-foreground/60">—</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Workspace path</dt>
            <dd className="font-mono text-xs">
              {effectiveSandbox?.workspaceRoot || (
                <span className="text-muted-foreground/60">—</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Owner</dt>
            <dd className="font-mono text-xs">
              {effectiveSandbox?.ownerProjectId || project?.folder || (
                <span className="text-muted-foreground/60">—</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Auto-start</dt>
            <dd className="text-xs">
              {effectiveSandbox?.autoStart !== false ? 'on' : 'off'}
            </dd>
          </dl>
          <p className="text-xs text-muted-foreground italic pt-1">
            Edit these in Project Settings → Sandbox; the host in CarapaBox
            hosts.
          </p>
        </section>

        <DialogFooter className="sm:justify-between">
          {canStop && isRunning && lifecycleManaged ? (
            <Button
              variant="destructive"
              onClick={handleStopSandbox}
              disabled={stopSandbox.isPending}
            >
              {stopSandbox.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Power className="size-4" />
              )}
              {stopSandbox.isPending ? 'Shutting down...' : 'Shut down stack'}
            </Button>
          ) : (
            <span />
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>

      <Dialog
        open={stopConfirmationOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !stopSandbox.isPending) {
            setStopConfirmationOpen(false);
          }
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          data-ui="sandbox-shutdown-confirmation-dialog"
        >
          <DialogHeader>
            <DialogTitle>Shut down stack?</DialogTitle>
            <DialogDescription>
              Shut down stack{' '}
              <code className="font-mono font-medium text-foreground">
                {stack}
              </code>{' '}
              for project{' '}
              <span className="font-medium text-foreground">
                {project?.name ?? group_folder}
              </span>
              ? Any work currently running in this sandbox will be interrupted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setStopConfirmationOpen(false)}
              disabled={stopSandbox.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleConfirmStopSandbox}
              disabled={stopSandbox.isPending}
            >
              {stopSandbox.isPending && (
                <Loader2 className="size-4 animate-spin" />
              )}
              {stopSandbox.isPending ? 'Shutting down...' : 'Shut down stack'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
