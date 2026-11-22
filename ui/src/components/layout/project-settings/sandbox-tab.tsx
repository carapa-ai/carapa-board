import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TabsContent } from '@/components/ui/tabs';
import { Loader2, RefreshCw } from 'lucide-react';
import type { Project, RepositoryDiscoveryReport } from '@/types';
import { discoveryReportSummary } from '@/lib/repository-discovery';
import { SandboxSshSettings } from '../sandbox-ssh';
import {
  SettingsSection,
  TAB_CONTENT_CLASS,
  type AppConfig,
  type FormProps,
  type ProjectSandbox,
} from './shared';

interface SandboxTabProps extends FormProps {
  project: Project | undefined;
  config: AppConfig | undefined;
  group_folder: string;
  inheritedSandbox: boolean;
  canEditRepository: boolean;
  canEditSandboxBinding: boolean;
  canEditMounts: boolean;
  sandboxOwner: Project | undefined;
  inheritedEffectiveSandbox: ProjectSandbox;
  sandboxDraftChanged: boolean;
  hostWorkspaceLocation: string;
  containerWorkspaceRoot: string;
  workspaceRootsText: string;
  setWorkspaceRootsText: (text: string) => void;
  proxyHostnameAliasesText: string;
  setProxyHostnameAliasesText: (text: string) => void;
  extraMountsText: string;
  setExtraMountsText: (text: string) => void;
  discoveringRepositories: boolean;
  discoveryMaxDepth: number;
  setDiscoveryMaxDepth: (depth: number) => void;
  discoveryExclusions: string;
  setDiscoveryExclusions: (exclusions: string) => void;
  discoveryReport: RepositoryDiscoveryReport | null;
  discoveryAvailability: { enabled: boolean; reason?: string };
  handleRepositoryDiscovery: () => void;
}

export function SandboxTab({
  form,
  setForm,
  project,
  config,
  group_folder,
  inheritedSandbox,
  canEditRepository,
  canEditSandboxBinding,
  canEditMounts,
  sandboxOwner,
  inheritedEffectiveSandbox,
  sandboxDraftChanged,
  hostWorkspaceLocation,
  containerWorkspaceRoot,
  workspaceRootsText,
  setWorkspaceRootsText,
  proxyHostnameAliasesText,
  setProxyHostnameAliasesText,
  extraMountsText,
  setExtraMountsText,
  discoveringRepositories,
  discoveryMaxDepth,
  setDiscoveryMaxDepth,
  discoveryExclusions,
  setDiscoveryExclusions,
  discoveryReport,
  discoveryAvailability,
  handleRepositoryDiscovery,
}: SandboxTabProps) {
  return (
    <TabsContent
      value="sandbox"
      data-ui="project-settings-tab-sandbox"
      className={TAB_CONTENT_CLASS}
    >
      <div className="space-y-4">
        {inheritedSandbox && (
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            Sandbox lifecycle and workspace mount settings are inherited from{' '}
            <span className="font-medium">
              {sandboxOwner?.name ?? inheritedEffectiveSandbox?.ownerProjectId}
            </span>
            . Repository-specific settings remain editable.
          </div>
        )}
        <SettingsSection name="sandbox-selection" title="Sandbox selection">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="settings-sandbox">
                Default Sandbox
              </label>
              <Input
                id="settings-sandbox"
                placeholder="carapa-bot"
                value={
                  inheritedSandbox
                    ? (inheritedEffectiveSandbox?.stack ?? '')
                    : (form.defaultSandbox ?? '')
                }
                disabled={inheritedSandbox || !canEditSandboxBinding}
                onChange={(e) =>
                  setForm({ ...form, defaultSandbox: e.target.value })
                }
              />
              <p className="text-xs text-muted-foreground">
                Sandbox stack name (overrides global default)
              </p>
            </div>
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="settings-sandbox-service"
              >
                Sandbox Service
              </label>
              <Input
                id="settings-sandbox-service"
                placeholder="agent"
                value={
                  inheritedSandbox
                    ? (inheritedEffectiveSandbox?.service ?? '')
                    : (form.defaultSandboxService ?? '')
                }
                disabled={inheritedSandbox || !canEditSandboxBinding}
                onChange={(e) =>
                  setForm({
                    ...form,
                    defaultSandboxService: e.target.value,
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                Service inside the stack where agents run (default: agent)
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="settings-sandbox-instance"
            >
              Sandbox Instance
            </label>
            <Input
              id="settings-sandbox-instance"
              placeholder={group_folder || 'project-folder'}
              value={
                inheritedSandbox
                  ? (inheritedEffectiveSandbox?.instance ?? '')
                  : (form.defaultSandboxInstance ?? '')
              }
              disabled={inheritedSandbox || !canEditSandboxBinding}
              onChange={(e) =>
                setForm({
                  ...form,
                  defaultSandboxInstance: e.target.value,
                })
              }
            />
            <p className="text-xs text-muted-foreground">
              {form.sandboxOwnership === 'shared'
                ? 'Managed instance shared by this parent and its children.'
                : 'Optional fixed instance. Standalone fixed instances remain externally managed.'}
            </p>
            {!canEditSandboxBinding && (
              <p className="text-xs text-muted-foreground">
                Only a board admin can change the sandbox stack, service,
                instance and shared ownership.
              </p>
            )}
          </div>

          <div className="flex items-center space-x-2 pt-1">
            <Checkbox
              id="settings-auto-start-stack"
              checked={
                inheritedSandbox
                  ? (inheritedEffectiveSandbox?.autoStart ?? true)
                  : (form.autoStartStack ?? true)
              }
              disabled={inheritedSandbox}
              onCheckedChange={(checked) =>
                setForm({ ...form, autoStartStack: !!checked })
              }
            />
            <div>
              <label
                htmlFor="settings-auto-start-stack"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Auto-start Sandbox Stack
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                Start the sandbox stack when the app launches (disable for
                on-demand-only projects)
              </p>
            </div>
          </div>
        </SettingsSection>

        <SandboxSshSettings
          project={project}
          disabled={inheritedSandbox || sandboxDraftChanged}
        />

        <SettingsSection name="paths-mounts" title="Paths & mounts">
          {((form.isParent && form.sandboxOwnership === 'shared') ||
            inheritedSandbox) && (
            <div className="grid grid-cols-1 gap-4 rounded-md border p-3 sm:grid-cols-2">
              <div className="space-y-2">
                <label
                  className="text-sm font-medium"
                  htmlFor="settings-shared-host-workspace"
                >
                  Host Workspace Location
                </label>
                <Input
                  id="settings-shared-host-workspace"
                  placeholder="/home/user/projects"
                  value={hostWorkspaceLocation}
                  disabled={inheritedSandbox || !canEditRepository}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      sharedWorkspaceHostLocation: e.target.value,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {inheritedSandbox
                    ? 'Inherited host directory containing the shared child repositories.'
                    : 'Host directory containing child repositories.'}
                </p>
              </div>
              <div className="space-y-2">
                <label
                  className="text-sm font-medium"
                  htmlFor="settings-shared-container-root"
                >
                  Container Workspace Root
                </label>
                <Input
                  id="settings-shared-container-root"
                  placeholder="/workspace"
                  value={containerWorkspaceRoot}
                  disabled={inheritedSandbox}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      sharedWorkspaceContainerRoot: e.target.value,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {inheritedSandbox
                    ? 'Inherited container root for the shared workspace mount.'
                    : 'Container path where the host workspace is mounted.'}
                </p>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="settings-workspace-path"
            >
              Workspace Path
            </label>
            <Input
              id="settings-workspace-path"
              placeholder={`/workspace/${group_folder || 'project-folder'}`}
              value={form.workspacePath ?? ''}
              onChange={(e) =>
                setForm({
                  ...form,
                  workspacePath: e.target.value,
                })
              }
            />
            <p className="text-xs text-muted-foreground">
              Primary repo path inside the sandbox container. Absolute paths
              (e.g. <code>/srv/my-repo</code>) are used as-is; a bare slug (e.g.{' '}
              <code>my-repo</code>) is mounted under <code>/workspace/</code>.
              Defaults to the project folder slug.
            </p>
          </div>

          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="settings-workspace-roots"
            >
              Extra Workspace Roots
            </label>
            <Input
              id="settings-workspace-roots"
              placeholder="/workspace/shared"
              value={
                inheritedSandbox
                  ? (inheritedEffectiveSandbox?.workspaceRoots
                      .slice(1)
                      .join(', ') ?? '')
                  : workspaceRootsText
              }
              disabled={inheritedSandbox || !canEditMounts}
              onChange={(e) => {
                const text = e.target.value;
                setWorkspaceRootsText(text);
                setForm((f) => ({
                  ...f,
                  workspaceRoots: text
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                }));
              }}
            />
            <p className="text-xs text-muted-foreground">
              Extra absolute paths the fs tools may read (comma-separated). Must
              match what's bind-mounted into the sandbox; the primary workspace
              root is always allowed implicitly.
              {!canEditMounts && ' Only a board admin can change this.'}
            </p>
          </div>

          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="settings-extra-mounts"
            >
              Extra Read-only Mounts
            </label>
            <Input
              id="settings-extra-mounts"
              placeholder="/home/me/reference-docs"
              value={
                inheritedSandbox
                  ? (sandboxOwner?.settings?.extraMounts?.join(', ') ?? '')
                  : extraMountsText
              }
              disabled={inheritedSandbox || !canEditMounts}
              onChange={(e) => {
                const text = e.target.value;
                setExtraMountsText(text);
                setForm((f) => ({
                  ...f,
                  extraMounts: text
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                }));
              }}
            />
            <p className="text-xs text-muted-foreground">
              Up to two host folders (comma-separated), available read-only
              inside the sandbox at <code>/workspace/&lt;folder name&gt;</code>{' '}
              (a <code>-1</code>/<code>-2</code> suffix is added if the name is
              already used). CarapaBox only allows folders listed in its mount
              allowlist; restart the sandbox to apply changes.
              {!canEditMounts && ' Only a board admin can change this.'}
            </p>
          </div>
        </SettingsSection>

        <SettingsSection name="web-access" title="Web access">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="settings-web-root">
              Web Root Path
            </label>
            <Input
              id="settings-web-root"
              placeholder="public"
              value={
                inheritedSandbox
                  ? (inheritedEffectiveSandbox?.webRootPath ?? 'public')
                  : (form.webRootPath ?? '')
              }
              disabled={inheritedSandbox}
              onChange={(e) =>
                setForm({ ...form, webRootPath: e.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">
              Relative to the sandbox workspace. For a shared PHP workspace, use
              a path such as child-repo/public. Changing it requires restarting
              the sandbox.
            </p>
          </div>

          {config?.enableNginxProxy && (
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="settings-proxy-hostname-aliases"
              >
                Proxy Hostname Aliases
              </label>
              <Input
                id="settings-proxy-hostname-aliases"
                placeholder="project.example.com, demo.example.com"
                value={
                  inheritedSandbox
                    ? (inheritedEffectiveSandbox?.proxyHostnameAliases.join(
                        ', ',
                      ) ?? '')
                    : proxyHostnameAliasesText
                }
                disabled={inheritedSandbox}
                onChange={(e) => {
                  const text = e.target.value;
                  setProxyHostnameAliasesText(text);
                  setForm({
                    ...form,
                    proxyHostnameAliases: text
                      .split(',')
                      .map((hostname) => hostname.trim())
                      .filter(Boolean),
                  });
                }}
              />
              <p className="text-xs text-muted-foreground">
                Optional comma-separated public hostnames accepted by the
                generated nginx route. DNS and Cloudflare Tunnel mappings remain
                manually managed. Changes apply immediately while the sandbox is
                running, or on its next start.
              </p>
            </div>
          )}
        </SettingsSection>

        {form.isParent && (
          <SettingsSection name="child-projects" title="Child projects">
            {form.isParent && (
              <div className="flex items-start space-x-2 rounded-md border p-3">
                <Checkbox
                  id="settings-shared-sandbox-owner"
                  checked={form.sandboxOwnership === 'shared'}
                  disabled={!canEditSandboxBinding}
                  onCheckedChange={(checked) =>
                    setForm({
                      ...form,
                      sandboxOwnership: checked ? 'shared' : 'standalone',
                    })
                  }
                />
                <div>
                  <label
                    htmlFor="settings-shared-sandbox-owner"
                    className="text-sm font-medium"
                  >
                    Own a shared sandbox for child projects
                  </label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Children inherit this stack, instance, service, lifecycle
                    policy, and workspace mount.
                  </p>
                </div>
              </div>
            )}

            {form.isParent && form.sandboxOwnership === 'shared' && (
              <div className="space-y-3 rounded-md border p-3">
                <div>
                  <h3 className="text-sm font-semibold">
                    Child repository discovery
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Scan the configured shared workspace and add repositories
                    that are not registered as children. Discovery never removes
                    or detaches projects and does not follow symlinks.
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]">
                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="settings-discovery-depth"
                    >
                      Max depth
                    </label>
                    <Input
                      id="settings-discovery-depth"
                      type="number"
                      min={1}
                      max={12}
                      value={discoveryMaxDepth}
                      onChange={(event) =>
                        setDiscoveryMaxDepth(
                          Math.max(
                            1,
                            Math.min(12, Number(event.target.value) || 1),
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="settings-discovery-exclusions"
                    >
                      Excluded directory names
                    </label>
                    <Input
                      id="settings-discovery-exclusions"
                      value={discoveryExclusions}
                      onChange={(event) =>
                        setDiscoveryExclusions(event.target.value)
                      }
                    />
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    discoveringRepositories || !discoveryAvailability.enabled
                  }
                  onClick={handleRepositoryDiscovery}
                >
                  {discoveringRepositories ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  Discover now
                </Button>
                {!discoveryAvailability.enabled &&
                  discoveryAvailability.reason && (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      {discoveryAvailability.reason}
                    </p>
                  )}
                {discoveryReport && (
                  <div className="space-y-2 rounded-md bg-muted/50 p-3 text-xs">
                    <p className="font-medium">
                      {discoveryReportSummary(discoveryReport)}
                    </p>
                    {(
                      [
                        'created',
                        'existing',
                        'ignored',
                        'ambiguous',
                        'missing',
                      ] as const
                    ).map(
                      (category) =>
                        discoveryReport[category].length > 0 && (
                          <div key={category}>
                            <p className="font-medium capitalize">{category}</p>
                            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                              {discoveryReport[category].map((entry, index) => (
                                <li key={`${entry.relativePath}-${index}`}>
                                  <span className="text-foreground">
                                    {entry.name || entry.relativePath}
                                  </span>
                                  {entry.projectId
                                    ? ` (${entry.projectId})`
                                    : ''}
                                  {entry.reason ? ` — ${entry.reason}` : ''}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ),
                    )}
                  </div>
                )}
              </div>
            )}
          </SettingsSection>
        )}
      </div>
    </TabsContent>
  );
}
