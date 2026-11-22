import { Select, SelectItem } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TabsContent } from '@/components/ui/tabs';
import { GitBranch, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { pushDefaultBranch } from '@/lib/api';
import type { ProjectSettings } from '@/types';
import {
  SettingsSection,
  TAB_CONTENT_CLASS,
  type AppConfig,
  type FormProps,
} from './shared';
import {
  defaultBranchError,
  repositoryUrlError,
} from './repository-validation';

interface RepositoryTabProps extends FormProps {
  project_id: string | null;
  config: AppConfig | undefined;
  gitNexusRepos: { name: string; path: string }[] | undefined;
  savedProjectSettings: ProjectSettings | undefined;
  pushSettingsChanged: boolean;
  canEditRepository: boolean;
  isPushing: boolean;
  setIsPushing: (isPushing: boolean) => void;
  worktreeFilesText: string;
  setWorktreeFilesText: (text: string) => void;
}

export function RepositoryTab({
  form,
  setForm,
  project_id,
  config,
  gitNexusRepos,
  savedProjectSettings,
  pushSettingsChanged,
  canEditRepository,
  isPushing,
  setIsPushing,
  worktreeFilesText,
  setWorktreeFilesText,
}: RepositoryTabProps) {
  const repositoryUrlProblem = repositoryUrlError(form.repositoryUrl);
  const defaultBranchProblem = defaultBranchError(form.defaultBranch);
  return (
    <TabsContent
      value="repository"
      data-ui="project-settings-tab-repository"
      className={TAB_CONTENT_CLASS}
    >
      <div className="space-y-4">
        <SettingsSection name="source" title="Source">
          {!canEditRepository && (
            <p
              data-ui="project-settings-repository-owner-only"
              className="text-xs text-muted-foreground"
            >
              Only the project owner can change the repository connection.
            </p>
          )}
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="settings-repo">
              Repository URL
            </label>
            <Input
              id="settings-repo"
              placeholder="https://github.com/org/repo"
              value={form.repositoryUrl ?? ''}
              disabled={!canEditRepository}
              aria-invalid={repositoryUrlProblem ? true : undefined}
              aria-describedby={
                repositoryUrlProblem ? 'settings-repo-error' : undefined
              }
              onChange={(e) => {
                const repositoryUrl = e.target.value;
                setForm({
                  ...form,
                  repositoryUrl,
                  ...(!repositoryUrl.trim()
                    ? { issueImportEnabled: false }
                    : {}),
                });
              }}
            />
            {repositoryUrlProblem && (
              <p
                id="settings-repo-error"
                data-ui="project-settings-repository-url-error"
                className="text-xs text-destructive"
              >
                {repositoryUrlProblem}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="settings-repo-location"
            >
              Repository Location
            </label>
            {gitNexusRepos && gitNexusRepos.length > 0 ? (
              <Select
                id="settings-repo-location"
                className="w-full"
                value={form.repositoryLocation ?? ''}
                disabled={!canEditRepository}
                onValueChange={(nextValue) =>
                  setForm({
                    ...form,
                    repositoryLocation: nextValue,
                  })
                }
              >
                <SelectItem value="">— Select Repository —</SelectItem>
                {gitNexusRepos.map((repo) => (
                  <SelectItem key={repo.path} value={repo.path}>
                    {repo.name} ({repo.path})
                  </SelectItem>
                ))}
              </Select>
            ) : (
              <Input
                id="settings-repo-location"
                placeholder="/home/user/projects/my-repo"
                value={form.repositoryLocation ?? ''}
                disabled={!canEditRepository}
                onChange={(e) =>
                  setForm({
                    ...form,
                    repositoryLocation: e.target.value,
                  })
                }
              />
            )}
            <p className="text-xs text-muted-foreground">
              Absolute path to the git repository on the host machine
            </p>
          </div>

          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="settings-default-branch"
            >
              Default Branch
            </label>
            <Input
              id="settings-default-branch"
              placeholder="develop"
              value={form.defaultBranch ?? ''}
              aria-invalid={defaultBranchProblem ? true : undefined}
              aria-describedby={
                defaultBranchProblem
                  ? 'settings-default-branch-error'
                  : undefined
              }
              onChange={(e) =>
                setForm({ ...form, defaultBranch: e.target.value })
              }
            />
            {defaultBranchProblem && (
              <p
                id="settings-default-branch-error"
                data-ui="project-settings-default-branch-error"
                className="text-xs text-destructive"
              >
                {defaultBranchProblem}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Base branch to return to after each task (default: develop)
            </p>
          </div>
        </SettingsSection>

        <SettingsSection name="worktrees-checkout" title="Worktrees & checkout">
          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="settings-task-checkout-mode"
            >
              Task checkout
            </label>
            <Select
              id="settings-task-checkout-mode"
              className="w-full"
              value={form.taskCheckoutMode ?? 'shared'}
              onValueChange={(nextValue) =>
                setForm({
                  ...form,
                  taskCheckoutMode: nextValue as
                    | 'shared'
                    | 'branch'
                    | 'worktree',
                })
              }
            >
              <SelectItem value="shared">Shared checkout</SelectItem>
              <SelectItem value="branch">Dedicated branch</SelectItem>
              <SelectItem value="worktree">Dedicated worktree</SelectItem>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Shared and branch tasks serialize with non-worktree conversations;
              they may wait for the shared checkout.
            </p>
          </div>

          {(form.taskCheckoutMode ?? 'shared') === 'worktree' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label
                  className="text-sm font-medium"
                  htmlFor="settings-parallel"
                >
                  Max Parallel Worktrees
                </label>
                <Input
                  id="settings-parallel"
                  type="number"
                  min={1}
                  max={10}
                  placeholder="1"
                  value={form.maxParallelWorktrees ?? ''}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      maxParallelWorktrees: e.target.value
                        ? parseInt(e.target.value, 10)
                        : null,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  How many tasks can execute in parallel via worktrees (default:
                  1)
                </p>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="settings-worktree-files"
            >
              Files to Symlink into Worktrees
            </label>
            <Input
              id="settings-worktree-files"
              placeholder=".env, config/local.php"
              value={worktreeFilesText}
              onChange={(e) => {
                const text = e.target.value;
                setWorktreeFilesText(text);
                setForm((f) => ({
                  ...f,
                  worktreeFiles: text
                    .split(',')
                    .map((s: string) => s.trim())
                    .filter(Boolean),
                }));
              }}
            />
            <p className="text-xs text-muted-foreground">
              Gitignored files to symlink from the main repo into each task
              worktree (comma-separated)
            </p>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="settings-auto-push"
              checked={form.autoPushAfterMerge ?? false}
              onCheckedChange={(checked) =>
                setForm({ ...form, autoPushAfterMerge: !!checked })
              }
            />
            <label
              htmlFor="settings-auto-push"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Automatic Push After Merge
            </label>
          </div>

          {/* Push to Remote */}
          <div className="flex items-center gap-3 pt-2 border-t">
            <Button
              variant="outline"
              size="sm"
              disabled={
                !savedProjectSettings?.repositoryUrl ||
                pushSettingsChanged ||
                isPushing
              }
              onClick={async () => {
                if (!project_id) return;
                setIsPushing(true);
                try {
                  const result = await pushDefaultBranch(project_id);
                  if (result.ok) {
                    toast.success('Pushed to remote');
                  } else {
                    toast.error(`Push failed: ${result.output}`);
                  }
                } catch (err: any) {
                  toast.error(`Push failed: ${err.message}`);
                } finally {
                  setIsPushing(false);
                }
              }}
            >
              {isPushing ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <GitBranch className="h-4 w-4 mr-1" />
              )}
              Push to Remote
            </Button>
            <span className="text-xs text-muted-foreground">
              {pushSettingsChanged
                ? 'Save repository settings before pushing'
                : `Push ${savedProjectSettings?.defaultBranch?.trim() || 'develop'} to saved repository`}
            </span>
          </div>
        </SettingsSection>

        <SettingsSection
          name="code-intelligence-issues"
          title="Code intelligence & issues"
        >
          <div className="flex items-start space-x-2 pt-1">
            <Checkbox
              id="settings-issue-import-enabled"
              checked={form.issueImportEnabled ?? false}
              disabled={!form.repositoryUrl?.trim()}
              onCheckedChange={(checked) =>
                setForm({
                  ...form,
                  issueImportEnabled: checked === true,
                })
              }
            />
            <div>
              <label
                htmlFor="settings-issue-import-enabled"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Import issues
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                Automatically add unseen open GitLab or GitHub issues to
                Backlog. The repository is derived from the URL above. The token
                is the account for that server that this project's sandbox uses
                (or the shared one) in Provider accounts → Code hosting, in the
                account menu.
              </p>
            </div>
          </div>

          {config?.enableGitNexus && (
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="settings-related-repos"
              >
                Repositories Available to GitNexus
              </label>
              {gitNexusRepos && gitNexusRepos.length > 0 ? (
                <div className="grid grid-cols-1 gap-2 max-h-40 overflow-y-auto p-2 border rounded-md sm:grid-cols-2">
                  {gitNexusRepos.map((repo) => (
                    <div
                      key={repo.path}
                      className="flex items-center space-x-2"
                    >
                      <Checkbox
                        id={`related-${repo.name}`}
                        checked={(form.relatedRepositories ?? []).includes(
                          repo.path,
                        )}
                        onCheckedChange={(checked) => {
                          const current = form.relatedRepositories ?? [];
                          if (checked) {
                            setForm({
                              ...form,
                              relatedRepositories: [...current, repo.path],
                            });
                          } else {
                            setForm({
                              ...form,
                              relatedRepositories: current.filter(
                                (p) => p !== repo.path,
                              ),
                            });
                          }
                        }}
                      />
                      <label
                        htmlFor={`related-${repo.name}`}
                        className="text-xs truncate cursor-pointer"
                        title={repo.path}
                      >
                        {repo.name}
                      </label>
                    </div>
                  ))}
                </div>
              ) : (
                <Input
                  id="settings-related-repos"
                  placeholder="/path/to/your/project"
                  value={(form.relatedRepositories ?? []).join(', ')}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      relatedRepositories: e.target.value
                        .split(',')
                        .map((s: string) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              )}
              <p className="text-xs text-muted-foreground">
                Additional repositories agents may query through GitNexus code
                intelligence. Repositories must already be indexed by GitNexus;
                this setting does not mount or index them.
              </p>
            </div>
          )}
        </SettingsSection>
      </div>
    </TabsContent>
  );
}
