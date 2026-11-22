import { Select, SelectItem } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { TabsContent } from '@/components/ui/tabs';
import type { Project } from '@/types';
import { hasNoSelectedMode, lastAvailableMode } from '@/lib/modes';
import { normalizePrivacyMode, type PrivacyMode } from '@/lib/privacy-mode';
import {
  SettingsSection,
  TAB_CONTENT_CLASS,
  type AppConfig,
  type FormProps,
  type ProjectSandbox,
} from './shared';

const PRIVACY_MODE_OPTIONS: {
  value: PrivacyMode;
  label: string;
  description: string;
}[] = [
  {
    value: 'off',
    label: 'Off',
    description:
      'No restriction. Any configured model or endpoint may be used.',
  },
  {
    value: 'local_memory',
    label: 'Local memory pipeline',
    description:
      'Memory, Jev, embeddings and knowledge verification use local endpoints only. Agents and chats may still use cloud models, so this is not a privacy guarantee.',
  },
  {
    value: 'strict',
    label: 'Strict',
    description:
      'Every gated LLM, Jev, embedding, web and image call must be local. Tasks with no local runtime park in Question. A project’s parent and the main project become private too: the effective mode is the strictest of a project and its descendants. The agent’s own network access inside its sandbox is NOT sealed until the carapa-box strict egress profile ships, which is not live yet.',
  },
];

interface GeneralTabProps extends FormProps {
  project: Project | undefined;
  projects: Project[] | undefined;
  project_id: string | null;
  config: AppConfig | undefined;
  projectName: string;
  setProjectName: (name: string) => void;
  group_folder: string;
  setProjectFolder: (folder: string) => void;
  parentId: string | null;
  setParentId: (parentId: string | null) => void;
  inheritedEffectiveSandbox: ProjectSandbox;
  canEditPrivacyMode: boolean;
  privacyModeError: string | null;
  clearPrivacyModeError: () => void;
}

export function GeneralTab({
  form,
  setForm,
  project,
  projects,
  project_id,
  config,
  projectName,
  setProjectName,
  group_folder,
  setProjectFolder,
  parentId,
  setParentId,
  inheritedEffectiveSandbox,
  canEditPrivacyMode,
  privacyModeError,
  clearPrivacyModeError,
}: GeneralTabProps) {
  const privacyMode = normalizePrivacyMode(form.privacyMode);
  const privacyOption =
    PRIVACY_MODE_OPTIONS.find((option) => option.value === privacyMode) ??
    PRIVACY_MODE_OPTIONS[0];
  const formModes = { settings: form };
  const lastMode = lastAvailableMode(formModes, config);
  const noModeSelected = hasNoSelectedMode(formModes, config);
  const effectivePrivacyMode = project?.settings?.effectivePrivacyMode;
  const inheritedFrom = project?.settings?.privacyModeInheritedFrom;
  return (
    <TabsContent
      value="general"
      data-ui="project-settings-tab-general"
      className={TAB_CONTENT_CLASS}
    >
      <div className="space-y-4">
        <SettingsSection name="identity" title="Identity">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="settings-project-name"
              >
                Project Name
              </label>
              <Input
                id="settings-project-name"
                placeholder="My Project"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="settings-project-folder"
              >
                Folder Slug
              </label>
              <Input
                id="settings-project-folder"
                placeholder="my-project"
                value={group_folder}
                onChange={(e) => setProjectFolder(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Lowercase alphanumeric and hyphens only. Renaming moves the
                project directory.
              </p>
            </div>
          </div>
          <div className="flex items-start space-x-2 pt-1">
            <Checkbox
              id="settings-code-enabled"
              checked={form.codeEnabled ?? !project?.isMain}
              onCheckedChange={(checked) =>
                setForm({ ...form, codeEnabled: checked === true })
              }
            />
            <div>
              <label
                htmlFor="settings-code-enabled"
                className="text-sm font-medium leading-none"
              >
                Code project
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                Turn on when building an app or website. Turn off for chats and
                saved files that do not need a code repository. Off by default
                for your main agent.
              </p>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection name="hierarchy" title="Hierarchy">
          <div className="flex items-start space-x-2 pt-1">
            <Checkbox
              id="settings-is-parent"
              checked={form.isParent ?? false}
              onCheckedChange={(checked) =>
                setForm({
                  ...form,
                  isParent: !!checked,
                  ...(!checked && form.sandboxOwnership === 'shared'
                    ? { sandboxOwnership: 'standalone' as const }
                    : {}),
                })
              }
            />
            <div>
              <label
                htmlFor="settings-is-parent"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Parent Project
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                Coordinator project. Can access memories and tasks from all
                child projects.
              </p>
            </div>
          </div>

          {!form.isParent && (
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="settings-parent-project"
              >
                Parent Project
              </label>
              <Select
                id="settings-parent-project"
                className="w-full"
                value={parentId ?? ''}
                onValueChange={(nextValue) => setParentId(nextValue || null)}
              >
                <SelectItem value="">— None —</SelectItem>
                {parentId &&
                  !(projects ?? []).some((p) => p.id === parentId) && (
                    <SelectItem value={parentId}>
                      {inheritedEffectiveSandbox?.ownerProjectId ?? parentId}{' '}
                      (not visible)
                    </SelectItem>
                  )}
                {(projects ?? [])
                  .filter((p) => p.id !== project_id && p.settings?.isParent)
                  .map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Assign this project as a child of a parent/coordinator project.
              </p>
            </div>
          )}
        </SettingsSection>

        <SettingsSection
          name="privacy"
          title="Privacy"
          description="Restrict which model and network endpoints this project may use."
        >
          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="settings-privacy-mode"
            >
              Privacy mode
            </label>
            {canEditPrivacyMode ? (
              <Select
                id="settings-privacy-mode"
                className="w-full"
                value={privacyMode}
                onValueChange={(nextValue) => {
                  const next = nextValue as PrivacyMode;
                  clearPrivacyModeError();
                  setForm({
                    ...form,
                    privacyMode: next === 'off' ? null : next,
                  });
                }}
              >
                {PRIVACY_MODE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </Select>
            ) : (
              <p
                id="settings-privacy-mode"
                data-ui="project-settings-privacy-mode-readonly"
                className="text-sm"
              >
                {privacyOption.label}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {privacyOption.description}
            </p>
            {!canEditPrivacyMode && (
              <p className="text-xs text-muted-foreground">
                Only a board admin can change the privacy mode.
              </p>
            )}
            {effectivePrivacyMode &&
              effectivePrivacyMode !== privacyMode &&
              inheritedFrom && (
                <p
                  data-ui="project-settings-privacy-mode-effective"
                  className="text-xs text-muted-foreground"
                >
                  Effective mode:{' '}
                  {PRIVACY_MODE_OPTIONS.find(
                    (option) => option.value === effectivePrivacyMode,
                  )?.label ?? effectivePrivacyMode}
                  , inherited from {inheritedFrom}.
                </p>
              )}
            {privacyModeError && (
              <p
                role="alert"
                data-ui="project-settings-privacy-mode-error"
                className="text-xs text-destructive"
              >
                {privacyModeError}
              </p>
            )}
          </div>
        </SettingsSection>

        {/* Modes disabled at the backend (ENABLE_KANBAN/ENABLE_CHAT/ENABLE_OBJECTIVES=false)
                      are hidden here. Their existing value in `form.enabledModes` is left
                      untouched so re-enabling the env flag later restores the user's choice. */}
        {(config?.enableKanban ||
          config?.enableChat ||
          config?.enableObjectives) && (
          <div className="border border-border p-4 rounded-md space-y-2 mt-2 bg-muted/20">
            <label className="text-sm font-semibold text-foreground">
              Enabled Modes
            </label>
            <p className="text-xs text-muted-foreground">
              Select the modes optionally enabled for this project.
            </p>
            {(lastMode || noModeSelected) && (
              <p
                data-ui="project-modes-minimum-hint"
                className="text-xs text-muted-foreground"
              >
                {noModeSelected
                  ? 'Select at least one mode to save.'
                  : 'At least one mode must stay enabled.'}
              </p>
            )}
            <div className="flex flex-wrap gap-4 pt-1">
              {config?.enableChat && (
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="mode-chat"
                    disabled={lastMode === 'chat'}
                    checked={(form.enabledModes ?? ['kanban', 'chat']).includes(
                      'chat',
                    )}
                    onCheckedChange={(checked) => {
                      const current = form.enabledModes ?? ['kanban', 'chat'];
                      const updated = checked
                        ? [...current, 'chat']
                        : current.filter((m) => m !== 'chat');
                      setForm({ ...form, enabledModes: updated });
                    }}
                  />
                  <label
                    htmlFor="mode-chat"
                    className="text-sm font-medium leading-none"
                  >
                    Chat
                  </label>
                </div>
              )}
              {config?.enableKanban && (
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="mode-kanban"
                    disabled={lastMode === 'kanban'}
                    checked={(form.enabledModes ?? ['kanban', 'chat']).includes(
                      'kanban',
                    )}
                    onCheckedChange={(checked) => {
                      const current = form.enabledModes ?? ['kanban', 'chat'];
                      const updated = checked
                        ? [...current, 'kanban']
                        : current.filter((m) => m !== 'kanban');
                      setForm({ ...form, enabledModes: updated });
                    }}
                  />
                  <label
                    htmlFor="mode-kanban"
                    className="text-sm font-medium leading-none"
                  >
                    Kanban
                  </label>
                </div>
              )}
              {config?.enableObjectives && (
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="mode-objectives"
                    disabled={lastMode === 'objectives'}
                    checked={(form.enabledModes ?? ['kanban', 'chat']).includes(
                      'objectives',
                    )}
                    onCheckedChange={(checked) => {
                      const current = form.enabledModes ?? ['kanban', 'chat'];
                      const updated = checked
                        ? [...current, 'objectives']
                        : current.filter((m) => m !== 'objectives');
                      setForm({ ...form, enabledModes: updated });
                    }}
                  />
                  <label
                    htmlFor="mode-objectives"
                    className="text-sm font-medium leading-none"
                  >
                    Objectives
                  </label>
                </div>
              )}
            </div>
            {config?.enableObjectives &&
              (form.enabledModes ?? ['kanban', 'chat']).includes(
                'objectives',
              ) && (
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                  ⚠ Objectives requires a{' '}
                  <code className="font-mono text-[11px] bg-muted px-1 rounded">
                    carapa-brain
                  </code>{' '}
                  agent to be running to function properly.
                </p>
              )}
          </div>
        )}
      </div>
    </TabsContent>
  );
}
