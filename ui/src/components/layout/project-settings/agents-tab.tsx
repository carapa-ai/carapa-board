import { FieldTrigger, Select, SelectItem } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RuntimePicker } from '@/components/chat/runtime-picker';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { fetchProjectCommands } from '@/lib/api';
import type {
  fetchProjectAvailableAiUsers,
  fetchProjectAvailableAiUserTeams,
  RuntimeCatalog,
} from '@/lib/api';
import {
  SettingsSection,
  TAB_CONTENT_CLASS,
  type AppConfig,
  type FormProps,
} from './shared';
import { pruneUnavailablePersonas } from './available-personas';
import { parseTaskCostLimit, TASK_COST_LIMIT_ERROR } from './task-cost-limit';

const TOOLSET_LABELS: Record<string, string> = {
  core: 'Core',
  fs: 'Filesystem',
  transcripts: 'Transcripts',
  kanban: 'Kanban',
  scheduling: 'Scheduling',
  memory: 'Memory',
  knowledge: 'Knowledge',
  advanced: 'Advanced project tools',
  push: 'Push messaging',
  images: 'Image generation',
  web: 'Web',
  gitnexus: 'GitNexus',
};

interface AgentsTabProps extends FormProps {
  project_id: string | null;
  config: AppConfig | undefined;
  runtimeCatalog: RuntimeCatalog | undefined;
  runtimeCatalogError?: boolean;
  runtimeCatalogRetrying?: boolean;
  onRetryRuntimeCatalog?: () => void;
  availableAiUsers: Awaited<ReturnType<typeof fetchProjectAvailableAiUsers>>;
  availableAiUserTeams: Awaited<
    ReturnType<typeof fetchProjectAvailableAiUserTeams>
  >;
  taskCostLimitText: string;
  setTaskCostLimitText: (text: string) => void;
  /** Name of the project whose sandbox (and skill list) this project shares. */
  skillsOwnerName?: string;
}

export function AgentsTab({
  form,
  setForm,
  project_id,
  config,
  runtimeCatalog,
  runtimeCatalogError,
  runtimeCatalogRetrying,
  onRetryRuntimeCatalog,
  availableAiUsers,
  availableAiUserTeams,
  taskCostLimitText,
  setTaskCostLimitText,
  skillsOwnerName,
}: AgentsTabProps) {
  // The picker renders nothing without a catalog, so show the load state in
  // its place. A retry after a failure resets the query to pending (error
  // false, fetching true), so loading is keyed on fetching, not on the error.
  const runtimeCatalogLoadState =
    runtimeCatalog ? null : runtimeCatalogRetrying ? (
      <p
        className="flex items-center gap-2 text-sm text-muted-foreground"
        data-ui="project-settings-runtime-catalog-loading"
      >
        <Loader2 className="size-4 animate-spin" />
        Loading runtimes…
      </p>
    ) : runtimeCatalogError ? (
      <div
        className="flex items-center gap-3"
        data-ui="project-settings-runtime-catalog-error"
      >
        <p role="alert" className="text-sm text-destructive">
          Couldn't load runtimes.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetryRuntimeCatalog}
        >
          Retry
        </Button>
      </div>
    ) : null;
  const taskCostLimitInvalid = !parseTaskCostLimit(taskCostLimitText).ok;
  // Every skill the project could see (platform + project-owned), including
  // ones it already disabled, so each can be switched back on.
  const { data: projectCommands } = useQuery({
    queryKey: ['project-skills', project_id],
    queryFn: () => fetchProjectCommands(project_id!, false, true),
    enabled: !!project_id && !skillsOwnerName,
  });
  const installedSkills = (projectCommands ?? [])
    .filter((command) => command.type === 'skill')
    .map((command) => command.name);
  const disabledSkills = form.disabledSkills ?? [];
  // Disabled names that are not installed are kept so a skill that comes back
  // later stays disabled.
  const missingSkills = disabledSkills.filter(
    (name) => !installedSkills.includes(name),
  );
  const skillNames = [...installedSkills, ...missingSkills].sort();
  // Stored ids of disabled or deleted personas/teams are not selectable, so
  // they must neither show as selected nor be counted.
  const shown = pruneUnavailablePersonas(form, {
    availableAiUsers,
    availableAiUserTeams,
  });
  const invitedPersonaCount = (shown.defaultInvitedAiUserIds ?? []).length;
  const invitedTeamCount = (shown.defaultInvitedAiUserTeamIds ?? []).length;
  return (
    <TabsContent
      value="agents"
      data-ui="project-settings-tab-agents"
      className={TAB_CONTENT_CLASS}
    >
      <div className="space-y-4">
        <SettingsSection
          name="chat-agent-personas"
          title="Chat agent & personas"
        >
          <div className="space-y-2">
            <label className="text-sm font-medium">Chat Agent</label>
            {runtimeCatalogLoadState}
            <RuntimePicker
              projectId={project_id ?? undefined}
              catalog={runtimeCatalog}
              value={form.chatRuntimeSelection}
              allowClear
              reasoningEmptyLabel="Default reasoning"
              onChange={(value) =>
                setForm({
                  ...form,
                  chatRuntimeSelection: value,
                  // Send null (rather than undefined, which JSON drops) so
                  // the API clears the persisted project runtime override.
                })
              }
            />
            <p className="text-xs text-muted-foreground">
              Harness, model, and reasoning used by default in this project's
              chats. Choosing Default runtime resets this project to the board
              chat default.
            </p>
          </div>

          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="settings-default-persona"
            >
              Default persona
            </label>
            <Select
              id="settings-default-persona"
              data-ui="project-default-persona"
              className="w-full"
              value={shown.defaultMainAiUserId ?? ''}
              onValueChange={(nextValue) =>
                setForm({
                  ...form,
                  defaultMainAiUserId: nextValue || null,
                })
              }
            >
              <SelectItem value="">None</SelectItem>
              {availableAiUsers.map((aiUser) => (
                <SelectItem key={aiUser.id} value={aiUser.id}>
                  {aiUser.name} · {aiUser.identity}
                </SelectItem>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              Used by conversations set to Project default. Individual
              conversations can override it or select No persona.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Default invited personas
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <FieldTrigger
                  className="w-full"
                  data-ui="project-default-invited-personas-trigger"
                >
                  <span className="truncate">
                    {invitedPersonaCount > 0
                      ? `${invitedPersonaCount} selected`
                      : 'No invited personas'}
                  </span>
                </FieldTrigger>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-[var(--radix-dropdown-menu-trigger-width)] min-w-64 overflow-y-auto"
                data-ui="project-default-invited-personas"
              >
                {availableAiUsers.map((aiUser) => {
                  const selected = (
                    form.defaultInvitedAiUserIds ?? []
                  ).includes(aiUser.id);
                  return (
                    <DropdownMenuCheckboxItem
                      key={aiUser.id}
                      checked={selected}
                      onCheckedChange={(checked) => {
                        const current = form.defaultInvitedAiUserIds ?? [];
                        setForm({
                          ...form,
                          defaultInvitedAiUserIds: checked
                            ? [...current, aiUser.id]
                            : current.filter((id) => id !== aiUser.id),
                        });
                      }}
                      onSelect={(event) => event.preventDefault()}
                      data-ui="project-default-invited-persona"
                      data-ai-user-id={aiUser.id}
                    >
                      <span className="truncate">
                        {aiUser.name} · {aiUser.identity}
                      </span>
                    </DropdownMenuCheckboxItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            <p className="text-xs text-muted-foreground">
              Invited to new conversations by default. A conversation's explicit
              invite list replaces these defaults.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Default invited teams</label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <FieldTrigger
                  className="w-full"
                  data-ui="project-default-invited-teams-trigger"
                >
                  <span className="truncate">
                    {invitedTeamCount > 0
                      ? `${invitedTeamCount} selected`
                      : 'No invited teams'}
                  </span>
                </FieldTrigger>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-[var(--radix-dropdown-menu-trigger-width)] min-w-64 overflow-y-auto"
                data-ui="project-default-invited-teams"
              >
                {availableAiUserTeams.map((team) => {
                  const selected = (
                    form.defaultInvitedAiUserTeamIds ?? []
                  ).includes(team.id);
                  return (
                    <DropdownMenuCheckboxItem
                      key={team.id}
                      checked={selected}
                      onCheckedChange={(checked) => {
                        const current = form.defaultInvitedAiUserTeamIds ?? [];
                        setForm({
                          ...form,
                          defaultInvitedAiUserTeamIds: checked
                            ? [...current, team.id]
                            : current.filter((id) => id !== team.id),
                        });
                      }}
                      onSelect={(event) => event.preventDefault()}
                      data-ui="project-default-invited-team"
                      data-ai-user-team-id={team.id}
                    >
                      <span className="truncate">{team.name}</span>
                    </DropdownMenuCheckboxItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            <p className="text-xs text-muted-foreground">
              Each team's enabled members are expanded when the conversation is
              created.
            </p>
          </div>
        </SettingsSection>

        <SettingsSection name="tasks-runtime" title="Tasks & runtime">
          {config?.toolsets && (
            <div className="border border-border p-4 rounded-md space-y-3 bg-muted/20">
              <div>
                <label className="text-sm font-semibold text-foreground">
                  Agent Toolsets
                </label>
                <p className="text-xs text-muted-foreground mt-1">
                  Uncheck toolsets agents in this project must not use. Default
                  toolsets are active immediately; on-demand toolsets can be
                  loaded by the agent when needed.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {config.toolsets.available.map((toolset) => {
                  const isDefault = config.toolsets!.defaults.includes(toolset);
                  const isDisabled = (form.disabledToolsets ?? []).includes(
                    toolset,
                  );
                  const isRequired = toolset === 'core';
                  return (
                    <div key={toolset} className="flex items-center space-x-2">
                      <Checkbox
                        id={`toolset-${toolset}`}
                        checked={isRequired || !isDisabled}
                        disabled={isRequired}
                        onCheckedChange={(checked) => {
                          const current = form.disabledToolsets ?? [];
                          const updated = checked
                            ? current.filter((name) => name !== toolset)
                            : [...new Set([...current, toolset])];
                          setForm({
                            ...form,
                            disabledToolsets: updated,
                          });
                        }}
                      />
                      <label
                        htmlFor={`toolset-${toolset}`}
                        className="text-sm leading-none"
                      >
                        {TOOLSET_LABELS[toolset] ?? toolset}
                        <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {isRequired
                            ? 'Required'
                            : isDefault
                              ? 'Default'
                              : 'On demand'}
                        </span>
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {skillsOwnerName && (
            <p
              className="text-xs text-muted-foreground"
              data-ui="project-settings-skills-inherited"
            >
              Agent skills are managed by {skillsOwnerName}, whose sandbox this
              project shares.
            </p>
          )}
          {!skillsOwnerName && skillNames.length > 0 && (
            <div
              className="border border-border p-4 rounded-md space-y-3 bg-muted/20"
              data-ui="project-settings-skills"
            >
              <div>
                <label className="text-sm font-semibold text-foreground">
                  Agent Skills
                </label>
                <p className="text-xs text-muted-foreground mt-1">
                  Uncheck skills agents in this project must not load. Running
                  agent sessions keep their skills until they restart.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {skillNames.map((skill) => {
                  const isDisabled = disabledSkills.includes(skill);
                  return (
                    <div
                      key={skill}
                      className="flex items-center space-x-2 min-w-0"
                      data-ui="project-settings-skill"
                      data-skill-name={skill}
                    >
                      <Checkbox
                        id={`skill-${skill}`}
                        checked={!isDisabled}
                        onCheckedChange={(checked) =>
                          setForm({
                            ...form,
                            disabledSkills: checked
                              ? disabledSkills.filter((name) => name !== skill)
                              : [...new Set([...disabledSkills, skill])],
                          })
                        }
                      />
                      <label
                        htmlFor={`skill-${skill}`}
                        className="text-sm leading-none truncate"
                      >
                        {skill}
                        {!installedSkills.includes(skill) && (
                          <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            Not installed
                          </span>
                        )}
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex items-start space-x-2 pt-1">
            <Checkbox
              id="settings-allow-agent-task-creation"
              checked={form.allowAgentTaskCreation ?? true}
              onCheckedChange={(checked) =>
                setForm({ ...form, allowAgentTaskCreation: !!checked })
              }
            />
            <div>
              <label
                htmlFor="settings-allow-agent-task-creation"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Allow agent task creation
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                When disabled, only manually created tasks are allowed — agents
                cannot create tasks here.
              </p>
            </div>
          </div>

          <div className="space-y-2" data-ui="project-default-task-runtime">
            <label className="text-sm font-medium">Default task runtime</label>
            {runtimeCatalogLoadState}
            <RuntimePicker
              projectId={project_id ?? undefined}
              catalog={runtimeCatalog}
              value={form.kanbanRuntimeSelection}
              reasoningEmptyLabel="Default reasoning"
              onChange={(value) =>
                setForm({ ...form, kanbanRuntimeSelection: value })
              }
            />
            <p className="text-xs text-muted-foreground">
              Harness, model, and reasoning used by default for tasks in this
              project.
            </p>
          </div>

          <div className="space-y-2" data-ui="project-task-cost-limit">
            <label
              className="text-sm font-medium"
              htmlFor="settings-task-cost-limit"
            >
              Per-task cost limit (USD)
            </label>
            <Input
              id="settings-task-cost-limit"
              type="text"
              inputMode="decimal"
              placeholder="No limit"
              value={taskCostLimitText}
              aria-invalid={taskCostLimitInvalid || undefined}
              aria-describedby={
                taskCostLimitInvalid
                  ? 'settings-task-cost-limit-error'
                  : undefined
              }
              onChange={(e) => {
                setTaskCostLimitText(e.target.value);
                const parsed = parseTaskCostLimit(e.target.value);
                // An invalid value blocks Save (see the dialog), so the form
                // keeps its last valid limit. Send null (rather than
                // undefined, which JSON drops) so the API clears the limit.
                if (parsed.ok) {
                  setForm({ ...form, kanbanTaskCostLimitUsd: parsed.value });
                }
              }}
            />
            {taskCostLimitInvalid && (
              <p
                id="settings-task-cost-limit-error"
                data-ui="project-task-cost-limit-error"
                className="text-xs text-destructive"
              >
                {TASK_COST_LIMIT_ERROR}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Once a card's runs cost this much, automatic runs stop and the
              card moves to Backlog. Runs you start yourself still work. A
              cost_limit_usd value on a card overrides this.
            </p>
          </div>
        </SettingsSection>
      </div>
    </TabsContent>
  );
}
