import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useStore } from '@/store';
import {
  useProjects,
  useUpdateProjectSettings,
  useInheritProjectStages,
  useDeleteProject,
  useUnlinkWhatsAppGroup,
} from '@/hooks/use-projects';
import {
  getEffectiveProjectStages,
  getProjectStages,
  hasDuplicateStageIds,
  hasInvalidStageIds,
} from '@/lib/stages';
import { X } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  fetchProjectDetails,
  fetchRuntimeCatalog,
  fetchGitNexusRepos,
  fetchProjectPreferences,
  updateProjectPreferences,
  fetchProjectPushPref,
  updateProjectPushPref,
  discoverProjectRepositories,
  fetchProjectAvailableAiUsers,
  fetchProjectAvailableAiUserTeams,
  fetchProjectStageOccupancy,
  ApiError,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { privacyModePatch } from '@/lib/privacy-mode';
import {
  canEditRepositoryConnection,
  settingsForProjectUpdate,
  sandboxInheritanceForEdit,
  sandboxWorkspaceLocationValues,
} from '@/lib/sandbox-settings';
import type {
  Project,
  ProjectSettings,
  StageDefinition,
  StageMigration,
  StageOccupancy,
  RepositoryDiscoveryReport,
} from '@/types';
import {
  DEFAULT_DISCOVERY_EXCLUSIONS,
  discoveryReportSummary,
  repositoryDiscoveryAvailability,
} from '@/lib/repository-discovery';
import { projectTreeOptions } from '@/components/layout/project-picker';
import { GeneralTab } from './project-settings/general-tab';
import { pruneUnavailablePersonas } from './project-settings/available-personas';
import { AgentsTab } from './project-settings/agents-tab';
import { MemoryTab } from './project-settings/memory-tab';
import { PromptsTab } from './project-settings/prompts-tab';
import { chatModeIdError } from './project-settings/chat-mode-validation';
import { parseTaskCostLimit } from './project-settings/task-cost-limit';
import {
  defaultBranchError,
  repositoryUrlError,
} from './project-settings/repository-validation';
import { BoardTab } from './project-settings/board-tab';
import { RepositoryTab } from './project-settings/repository-tab';
import { SandboxTab } from './project-settings/sandbox-tab';
import { DeployTab } from './project-settings/deploy-tab';
import { IntegrationsTab } from './project-settings/integrations-tab';
import { PreferencesTab } from './project-settings/preferences-tab';
import { DangerTab } from './project-settings/danger-tab';
import {
  hasNoSelectedMode,
  modeRoutePath,
  resolveProjectMode,
} from '@/lib/modes';
import { confirmAction } from '@/components/confirm-dialog';
import { useAppConfig } from '@/hooks/use-app-config';

type ProjectDraftBaseline = {
  id: string;
  name: string;
  folder: string;
  parentId: string | null;
  settings: ProjectSettings;
  workspaceRootsText: string;
  worktreeFilesText: string;
  taskCostLimitText: string;
  proxyHostnameAliasesText: string;
  extraMountsText: string;
};

function projectDraftBaseline(project: Project): ProjectDraftBaseline {
  const settings = project.settings ?? {};
  return {
    id: project.id,
    name: project.name ?? '',
    folder: project.folder ?? '',
    parentId: project.parentId ?? null,
    settings,
    workspaceRootsText: (settings.workspaceRoots ?? []).join(', '),
    worktreeFilesText: (settings.worktreeFiles ?? []).join(', '),
    taskCostLimitText: settings.kanbanTaskCostLimitUsd?.toString() ?? '',
    proxyHostnameAliasesText: (settings.proxyHostnameAliases ?? []).join(', '),
    extraMountsText: (settings.extraMounts ?? []).join(', '),
  };
}

// JSON text with object keys sorted, so property insertion order never matters.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || canonicalJson(a) === canonicalJson(b);
}

// No stage list and an empty one both mean "inherit the parent's stages".
function withoutEmptyStages(settings: ProjectSettings): ProjectSettings {
  const { stages, ...rest } = settings;
  return stages?.length ? settings : rest;
}

export function ProjectSettingsDialog() {
  const project_id = useStore((s) => s.settingsProjectId);
  const setProjectId = useStore((s) => s.setSettingsProjectId);
  const queryClient = useQueryClient();
  const { data: projects } = useProjects();
  const { data: config } = useAppConfig();
  const {
    data: runtimeCatalog,
    isError: runtimeCatalogError,
    isFetching: runtimeCatalogFetching,
    refetch: refetchRuntimeCatalog,
  } = useQuery({
    queryKey: ['runtimeCatalog'],
    queryFn: fetchRuntimeCatalog,
    staleTime: Infinity,
  });
  const availableAiUsersKey = ['project-ai-users', project_id, 'available'];
  const availableAiUserTeamsKey = [
    'project-ai-user-teams',
    project_id,
    'available',
  ];
  const { data: availableAiUsers = [] } = useQuery({
    queryKey: availableAiUsersKey,
    queryFn: () => fetchProjectAvailableAiUsers(project_id ?? ''),
    enabled: !!project_id,
    // Personas can be disabled or deleted elsewhere; reopening must refetch.
    staleTime: 0,
  });
  const { data: availableAiUserTeams = [] } = useQuery({
    queryKey: availableAiUserTeamsKey,
    queryFn: () => fetchProjectAvailableAiUserTeams(project_id ?? ''),
    enabled: !!project_id,
    staleTime: 0,
  });
  const { data: gitNexusRepos } = useQuery({
    queryKey: queryKeys.gitNexusRepos,
    queryFn: fetchGitNexusRepos,
    // Wait for /api/config; only fire when GitNexus is enabled. When disabled,
    // gitNexusRepos stays undefined and both Repository tab fields fall back
    // to the existing free-text inputs.
    enabled: !!config && config.enableGitNexus,
  });
  const navigate = useNavigate();

  const summary = projects?.find((p) => p.id === project_id);
  const { data: project, isError: detailsError } = useQuery({
    queryKey: ['project-details', project_id, summary?.revision],
    queryFn: ({ signal }) => fetchProjectDetails(project_id!, signal),
    enabled: !!project_id && !!summary,
    staleTime: Infinity,
    // Keep the loaded project across revision changes (so Save stays enabled)
    // but never show another project's details while a different one loads.
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === project_id
        ? keepPreviousData(previousData)
        : undefined,
  });
  const savedProjectSettings = project?.settings;
  const savedProjectIsParent = savedProjectSettings?.isParent === true;
  const savedProjectUsesRepositoryPrompt = Boolean(
    savedProjectSettings?.repositoryUrl ||
    savedProjectSettings?.repositoryLocation,
  );
  const memorySourceOptions = useMemo(
    () =>
      projectTreeOptions(projects ?? []).filter(
        (candidate) => candidate.id !== project_id,
      ),
    [project_id, projects],
  );
  const mutation = useUpdateProjectSettings(project_id ?? '', {
    silent: true,
  });
  const inheritMutation = useInheritProjectStages(project_id ?? '');
  const deleteMutation = useDeleteProject(project_id ?? '');
  const unlinkMutation = useUnlinkWhatsAppGroup();

  const [form, setForm] = useState<ProjectSettings>({});
  const [stageMigrations, setStageMigrations] = useState<StageMigration[]>([]);
  const [stageSuffixInvalid, setStageSuffixInvalid] = useState(false);
  const modeIdError = chatModeIdError(form.chatModes);
  const [openRemovalStageId, setOpenRemovalStageId] = useState<
    string | undefined
  >();
  const [conflictProspectiveStages, setConflictProspectiveStages] = useState<
    StageDefinition[] | null
  >(null);
  const [conflictDraftInherited, setConflictDraftInherited] = useState(false);
  const {
    data: stageOccupancy,
    isPending: stageOccupancyPending,
    isError: stageOccupancyError,
    refetch: refetchStageOccupancy,
  } = useQuery<StageOccupancy[]>({
    queryKey: ['project-stage-occupancy', project_id],
    queryFn: () => fetchProjectStageOccupancy(project_id ?? ''),
    enabled: !!project_id,
    staleTime: 5_000,
  });
  const [projectName, setProjectName] = useState('');
  const [group_folder, setProjectFolder] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const draftParentProject = projects?.find((p) => p.id === parentId);
  const draftParentStages = draftParentProject
    ? getEffectiveProjectStages(draftParentProject)
    : getProjectStages();
  const savedEffectiveStages = getEffectiveProjectStages(project);
  const draftInheritsStages = !form.stages?.length;
  const stageIdDuplicate = hasDuplicateStageIds(form.stages ?? []);
  const stageIdInvalid = hasInvalidStageIds(form.stages ?? []);
  const draftParentChanged = parentId !== (project?.parentId ?? null);
  const draftEffectiveStages = draftInheritsStages
    ? draftParentStages
    : (form.stages ?? savedEffectiveStages);
  const {
    inherited: inheritedSandbox,
    owner: sandboxOwner,
    effectiveSandbox: inheritedEffectiveSandbox,
  } = sandboxInheritanceForEdit(project, parentId, projects);
  const { hostWorkspaceLocation, containerWorkspaceRoot } =
    sandboxWorkspaceLocationValues(
      form,
      inheritedEffectiveSandbox,
      inheritedSandbox,
    );
  const noModeSelected = hasNoSelectedMode({ settings: form }, config);
  const kanbanEnabled = (form.enabledModes ?? ['kanban', 'chat']).includes(
    'kanban',
  );
  // Sandbox selection edits that must be saved before publishing or SSH
  // settings (which act on the saved sandbox) can be changed.
  const sandboxDraftChanged =
    draftParentChanged ||
    (form.defaultSandbox ?? '') !== (project?.settings?.defaultSandbox ?? '') ||
    (form.defaultSandboxService ?? '') !==
      (project?.settings?.defaultSandboxService ?? '') ||
    (form.defaultSandboxInstance ?? '') !==
      (project?.settings?.defaultSandboxInstance ?? '') ||
    form.sandboxOwnership !== project?.settings?.sandboxOwnership;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const pushSettingsChanged = (
    [
      'repositoryUrl',
      'repositoryLocation',
      'repositoryRelativePath',
      'defaultBranch',
    ] as const
  ).some((key) => (form[key] ?? '') !== (savedProjectSettings?.[key] ?? ''));
  const [discoveringRepositories, setDiscoveringRepositories] = useState(false);
  const [discoveryMaxDepth, setDiscoveryMaxDepth] = useState(4);
  const [discoveryExclusions, setDiscoveryExclusions] = useState(
    DEFAULT_DISCOVERY_EXCLUSIONS.join(', '),
  );
  const [discoveryReport, setDiscoveryReport] =
    useState<RepositoryDiscoveryReport | null>(null);
  const discoveryAvailability = repositoryDiscoveryAvailability(
    form,
    project?.settings,
  );
  // Raw text buffer for the comma-separated workspaceRoots input. Kept separate
  // from `form.workspaceRoots` so partial typing (a trailing comma, a single
  // space) doesn't get filtered away mid-keystroke.
  const [workspaceRootsText, setWorkspaceRootsText] = useState('');
  // Same raw-text-buffer treatment for the comma-separated worktreeFiles input,
  // so a trailing comma/space isn't filtered away mid-keystroke.
  const [worktreeFilesText, setWorktreeFilesText] = useState('');
  const [taskCostLimitText, setTaskCostLimitText] = useState('');
  const taskCostLimitInvalid = !parseTaskCostLimit(taskCostLimitText).ok;
  const authUser = useAuth((s) => s.user);
  const canEditRepository = canEditRepositoryConnection(project, authUser);
  // A non-owner cannot send the repository URL, so its value must not block Save.
  const repositoryInvalid = Boolean(
    (canEditRepository && repositoryUrlError(form.repositoryUrl)) ||
    defaultBranchError(form.defaultBranch),
  );
  const [proxyHostnameAliasesText, setProxyHostnameAliasesText] = useState('');
  // Raw text buffer for the comma-separated extraMounts input (same reason as above).
  const [extraMountsText, setExtraMountsText] = useState('');
  // Per-(user, project) preferences are stored in project_members.preferences,
  // outside the ProjectSettings blob, so they have their own local state and
  // their own fetch/save round-trip.
  const [memberPrefs, setMemberPrefs] = useState<string>('');
  const [memberPrefsBaseline, setMemberPrefsBaseline] = useState<string>('');
  const { data: memberPrefsData } = useQuery({
    queryKey: ['preferences', 'project', project_id],
    queryFn: () => fetchProjectPreferences(project_id ?? ''),
    enabled: !!project_id,
    staleTime: Infinity,
  });

  // Per-(user, project) push opt-in. Tri-state: true / false / null (use default).
  const [pushPref, setPushPref] = useState<boolean | null>(null);
  const [pushPrefBaseline, setPushPrefBaseline] = useState<boolean | null>(
    null,
  );
  const [pushEffective, setPushEffective] = useState<boolean>(false);
  const { data: pushPrefData } = useQuery({
    queryKey: ['preferences', 'project-push', project_id],
    queryFn: () => fetchProjectPushPref(project_id ?? ''),
    enabled: !!project_id,
    staleTime: Infinity,
  });

  const isAdmin = authUser?.role === 'admin';
  const [privacyModeError, setPrivacyModeError] = useState<string | null>(null);
  // Admins and the project owner may delete the project.
  const canManageProject = !!(
    project &&
    authUser &&
    (authUser.role === 'admin' ||
      (project.userId && project.userId === authUser.id))
  );

  // Last server values applied to the draft. When a new revision of the same
  // project arrives, fields still equal to this baseline adopt the server value
  // and edited fields keep the user's draft (Save sends the whole form, so a
  // blanket reset would lose edits and a blanket skip would overwrite
  // concurrent server-side changes).
  const draftBaselineRef = useRef<ProjectDraftBaseline | null>(null);

  // Current project id, readable from async handlers that outlive a project switch.
  const projectIdRef = useRef(project_id);
  projectIdRef.current = project_id;

  // The host keys this component by project, so closing or switching projects
  // unmounts it. An async Save that outlives that must not touch the global
  // dialog state, which may by now belong to a different dialog.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  // Shared by the Save button and the Enter-key shortcut.
  const canSave =
    !!project &&
    !mutation.isPending &&
    !checkingAvailability &&
    !stageSuffixInvalid &&
    !stageIdDuplicate &&
    !stageIdInvalid &&
    !modeIdError &&
    !taskCostLimitInvalid &&
    !repositoryInvalid &&
    !noModeSelected;

  // Per-project transient state that must never carry over to another project
  // (or a reopened dialog): discovery inputs.
  const resetProjectScopedState = () => {
    setDiscoveryMaxDepth(4);
    setDiscoveryExclusions(DEFAULT_DISCOVERY_EXCLUSIONS.join(', '));
    setDiscoveringRepositories(false);
    setDiscoveryReport(null);
  };

  // Sync form state when project changes
  useEffect(() => {
    const previous = draftBaselineRef.current;
    if (!project) {
      draftBaselineRef.current = null;
      setProjectName('');
      setProjectFolder('');
      setParentId(null);
      setForm({});
      setStageMigrations([]);
      setOpenRemovalStageId(undefined);
      setConflictProspectiveStages(null);
      setConflictDraftInherited(false);
      setWorkspaceRootsText('');
      setWorktreeFilesText('');
      setTaskCostLimitText('');
      setProxyHostnameAliasesText('');
      setConfirmDelete(false);
      resetProjectScopedState();
      return;
    }
    const next = projectDraftBaseline(project);
    draftBaselineRef.current = next;
    setPrivacyModeError(null);
    if (!previous || previous.id !== next.id) {
      setProjectName(next.name);
      setProjectFolder(next.folder);
      setParentId(next.parentId);
      setForm({ ...next.settings });
      setStageMigrations([]);
      setOpenRemovalStageId(undefined);
      setConflictProspectiveStages(null);
      setConflictDraftInherited(false);
      setWorkspaceRootsText(next.workspaceRootsText);
      setWorktreeFilesText(next.worktreeFilesText);
      setTaskCostLimitText(next.taskCostLimitText);
      setProxyHostnameAliasesText(next.proxyHostnameAliasesText);
      setExtraMountsText(next.extraMountsText);
      setConfirmDelete(false);
      resetProjectScopedState();
      return;
    }
    const keepIfEdited = <T,>(current: T, base: T, server: T) =>
      sameValue(current, base) ? server : current;
    setProjectName((current) =>
      keepIfEdited(current, previous.name, next.name),
    );
    setProjectFolder((current) =>
      keepIfEdited(current, previous.folder, next.folder),
    );
    setParentId((current) =>
      keepIfEdited(current, previous.parentId, next.parentId),
    );
    setForm((current) => {
      const merged: ProjectSettings = { ...current };
      const keys = new Set([
        ...Object.keys(current),
        ...Object.keys(previous.settings),
        ...Object.keys(next.settings),
      ]) as Set<keyof ProjectSettings>;
      for (const key of keys) {
        if (!sameValue(current[key], previous.settings[key])) continue;
        if (key in next.settings) {
          (merged as Record<string, unknown>)[key] = next.settings[key];
        } else {
          delete merged[key];
        }
      }
      return merged;
    });
    setWorkspaceRootsText((current) =>
      keepIfEdited(
        current,
        previous.workspaceRootsText,
        next.workspaceRootsText,
      ),
    );
    setWorktreeFilesText((current) =>
      keepIfEdited(current, previous.worktreeFilesText, next.worktreeFilesText),
    );
    setTaskCostLimitText((current) =>
      keepIfEdited(current, previous.taskCostLimitText, next.taskCostLimitText),
    );
    setProxyHostnameAliasesText((current) =>
      keepIfEdited(
        current,
        previous.proxyHostnameAliasesText,
        next.proxyHostnameAliasesText,
      ),
    );
    setExtraMountsText((current) =>
      keepIfEdited(current, previous.extraMountsText, next.extraMountsText),
    );
    // Stage migrations and the removal flow only make sense for the stages the
    // user is editing; drop them only when the stages are untouched.
    if (sameValue(form.stages, previous.settings.stages)) {
      setStageMigrations([]);
      setOpenRemovalStageId(undefined);
      setConflictProspectiveStages(null);
      setConflictDraftInherited(false);
      setDiscoveryReport(null);
    }
  }, [project]);

  const handleRepositoryDiscovery = async () => {
    if (!project_id) return;
    if (!discoveryAvailability.enabled) {
      toast.error(
        discoveryAvailability.reason ||
          'Save workspace settings before discovery',
      );
      return;
    }
    const requestedProjectId = project_id;
    setDiscoveringRepositories(true);
    try {
      const report = await discoverProjectRepositories(project_id, {
        maxDepth: discoveryMaxDepth,
        exclusions: discoveryExclusions
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      });
      if (projectIdRef.current !== requestedProjectId) return;
      setDiscoveryReport(report);
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      if (projectIdRef.current !== requestedProjectId) return;
      toast.success(discoveryReportSummary(report));
    } catch (error) {
      if (projectIdRef.current !== requestedProjectId) return;
      toast.error(
        error instanceof Error ? error.message : 'Repository discovery failed',
      );
    } finally {
      if (projectIdRef.current === requestedProjectId) {
        setDiscoveringRepositories(false);
      }
    }
  };

  // Sync member-prefs state when the fetch resolves or the project changes.
  useEffect(() => {
    const next = memberPrefsData?.content ?? '';
    setMemberPrefs(next);
    setMemberPrefsBaseline(next);
  }, [memberPrefsData, project_id]);

  // Sync push-pref state when the fetch resolves or the project changes.
  useEffect(() => {
    const next = pushPrefData?.enabled ?? null;
    setPushPref(next);
    setPushPrefBaseline(next);
    setPushEffective(pushPrefData?.effective ?? false);
  }, [pushPrefData, project_id]);

  const handleDelete = async () => {
    const lastProjectId = useStore.getState().lastProjectId;
    if (lastProjectId === project_id) {
      useStore.getState().setLastProjectId(null);
    }
    await deleteMutation.mutateAsync();
    setProjectId(null);
    navigate({ to: '/' });
  };

  // Unsaved edits: any draft field that differs from the values loaded when the
  // dialog opened (or last adopted from the server), plus pending stage
  // migrations and the per-user preference drafts.
  const baseline = draftBaselineRef.current;
  const hasUnsavedChanges =
    !!baseline &&
    baseline.id === project_id &&
    (!sameValue(
      withoutEmptyStages(form),
      withoutEmptyStages(baseline.settings),
    ) ||
      projectName !== baseline.name ||
      group_folder !== baseline.folder ||
      parentId !== baseline.parentId ||
      workspaceRootsText !== baseline.workspaceRootsText ||
      worktreeFilesText !== baseline.worktreeFilesText ||
      taskCostLimitText !== baseline.taskCostLimitText ||
      proxyHostnameAliasesText !== baseline.proxyHostnameAliasesText ||
      extraMountsText !== baseline.extraMountsText ||
      stageMigrations.length > 0 ||
      // Typed-but-uncommitted stage suffixes live only inside StageAlternatives.
      stageSuffixInvalid ||
      memberPrefs !== memberPrefsBaseline ||
      pushPref !== pushPrefBaseline);

  const handleCancel = () => {
    setStageMigrations([]);
    setConflictProspectiveStages(null);
    setConflictDraftInherited(false);
    resetProjectScopedState();
    setProjectId(null);
  };

  // Overlay click, Escape and the Close/Cancel controls all dismiss through here.
  const requestClose = async () => {
    if (
      hasUnsavedChanges &&
      !(await confirmAction('Your unsaved changes will be lost.', {
        title: 'Discard unsaved changes?',
        confirmLabel: 'Discard',
        destructive: true,
      }))
    ) {
      return;
    }
    handleCancel();
  };

  // Saves at once: the server refuses (409) while a card sits in a stage the
  // parent lacks, and the board tab shows that message inline.
  const handleInheritFromParent = async () => {
    await inheritMutation.mutateAsync();
    setStageMigrations([]);
    setOpenRemovalStageId(undefined);
    setConflictProspectiveStages(null);
    setConflictDraftInherited(false);
    setForm(({ stages: _stages, ...rest }) => rest);
    toast.success('This project now inherits its parent stages');
  };

  const handleSave = async () => {
    if (!project || !project_id) return;
    // Fetch the current lists (not the possibly pending or stale query data)
    // so stored ids of disabled or deleted personas/teams are always pruned.
    const startedProjectId = project_id;
    // Survives unmount: the store holds the project whose dialog is open now.
    const ownsDialog = () =>
      mountedRef.current &&
      useStore.getState().settingsProjectId === startedProjectId;
    let available;
    setCheckingAvailability(true);
    try {
      const [users, teams] = await Promise.all([
        queryClient.fetchQuery({
          queryKey: availableAiUsersKey,
          queryFn: () => fetchProjectAvailableAiUsers(project_id ?? ''),
          staleTime: 0,
        }),
        queryClient.fetchQuery({
          queryKey: availableAiUserTeamsKey,
          queryFn: () => fetchProjectAvailableAiUserTeams(project_id ?? ''),
          staleTime: 0,
        }),
      ]);
      available = { availableAiUsers: users, availableAiUserTeams: teams };
    } catch {
      if (ownsDialog()) {
        toast.error('Could not load available personas. Try saving again.');
      }
      return;
    } finally {
      setCheckingAvailability(false);
    }
    // The dialog was dismissed or moved to another project while waiting; the
    // captured form belongs to the old session and must not be sent.
    if (!ownsDialog()) return;
    const currentSettings = settingsForProjectUpdate(
      pruneUnavailablePersonas(form, available),
      inheritedSandbox,
      canEditRepository,
      isAdmin,
    );
    delete currentSettings.privacyMode;
    const privacyPatch = privacyModePatch(
      form.privacyMode,
      project.settings?.privacyMode,
      isAdmin,
    );
    setPrivacyModeError(null);
    let result;
    try {
      result = await mutation.mutateAsync({
        settings: {
          ...currentSettings,
          ...privacyPatch,
          disabledToolsets: (form.disabledToolsets ?? []).filter(
            (name) => name !== 'core' && name !== 'mail',
          ),
        },
        name: projectName,
        folder: group_folder,
        parentId: parentId ?? null,
        stageMigrations,
      });
    } catch (error) {
      if (
        'privacyMode' in privacyPatch &&
        error instanceof ApiError &&
        (error.status === 403 || error.status === 428)
      ) {
        setPrivacyModeError(error.message);
      }
      if (String(error).toLowerCase().includes('occupied')) {
        const refreshed = await refetchStageOccupancy();
        const missingOccupied = savedEffectiveStages.filter(
          (stage) =>
            !draftEffectiveStages.some((draft) => draft.id === stage.id) &&
            (refreshed.data ?? []).some(
              (item) => item.stageId === stage.id && item.total > 0,
            ),
        );
        if (missingOccupied.length > 0) {
          setConflictProspectiveStages(draftEffectiveStages);
          setConflictDraftInherited(draftInheritsStages);
          setForm({
            ...form,
            stages: [
              ...draftEffectiveStages,
              ...missingOccupied.filter(
                (stage) =>
                  !draftEffectiveStages.some((draft) => draft.id === stage.id),
              ),
            ],
          });
          setOpenRemovalStageId(missingOccupied[0].id);
        }
        toast.error(
          'Cards moved stages while editing. Review the stage removal and try Save again.',
        );
      }
      return;
    }
    // A folder rename changes the project id: everything after the PATCH must
    // address the project by its new id (the old one no longer resolves).
    const savedProjectId = result.id || startedProjectId;
    const projectRenamed = savedProjectId !== startedProjectId;
    await queryClient.invalidateQueries({
      queryKey: ['conversation-ai-users', savedProjectId],
    });
    // Persist member preferences only if the textarea actually changed —
    // avoids touching a row the user never interacted with.
    let prefsSaveFailed = false;
    if (memberPrefs !== memberPrefsBaseline) {
      try {
        const saved = await updateProjectPreferences(
          savedProjectId,
          memberPrefs.trim() === '' ? null : memberPrefs,
        );
        // Refresh cache so the next time the dialog opens, the textarea reflects
        // what was just saved (otherwise staleTime: Infinity keeps the old value).
        queryClient.setQueryData(
          ['preferences', 'project', savedProjectId],
          saved,
        );
        if (ownsDialog()) setMemberPrefsBaseline(saved.content ?? '');
      } catch (err: any) {
        prefsSaveFailed = true;
        toast.error(
          `Failed to save preferences: ${err?.message ?? 'unknown error'}`,
        );
      }
    }
    if (pushPref !== pushPrefBaseline) {
      try {
        const saved = await updateProjectPushPref(savedProjectId, pushPref);
        queryClient.setQueryData(
          ['preferences', 'project-push', savedProjectId],
          saved,
        );
        if (ownsDialog()) {
          setPushPrefBaseline(saved.enabled);
          setPushEffective(saved.effective);
        }
      } catch (err: any) {
        prefsSaveFailed = true;
        toast.error(
          `Failed to save push preference: ${err?.message ?? 'unknown error'}`,
        );
      }
    }
    if (!prefsSaveFailed) toast.success('Settings saved');
    // The dialog was dismissed or moved to another project while saving: the
    // save itself is done, but the open dialog is not ours to close or reset.
    if (!ownsDialog()) return;
    // Keep the dialog open when a preference save failed so the draft survives,
    // except after a folder rename: the old id no longer resolves, so the draft
    // cannot be kept and the dialog would be stuck loading.
    // Applied stage migrations are cleared regardless, so a retry does not resend them.
    setStageMigrations([]);
    setConflictProspectiveStages(null);
    if (!prefsSaveFailed || projectRenamed) {
      setProjectId(null);
    }
    // Navigate to the new project URL if the folder slug changed
    if (projectRenamed) {
      const mode =
        resolveProjectMode(
          { settings: result.settings, memberMode: summary?.memberMode },
          config,
        ) ??
        result.settings?.mode ??
        'kanban';
      navigate({
        to: modeRoutePath(mode),
        params: { projectId: savedProjectId },
      });
    }
  };

  return (
    <Dialog
      open={!!project_id}
      onOpenChange={(open) => !open && requestClose()}
    >
      <DialogContent
        showCloseButton={false}
        data-ui="project-settings-dialog"
        className="w-[calc(100%-2rem)] min-w-0 p-0 overflow-hidden sm:max-w-3xl"
      >
        <DialogClose
          data-ui="project-settings-close"
          className="absolute right-3 top-3 z-20 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
        >
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
        <div
          className="flex w-full min-w-0 flex-col max-h-[85vh]"
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              e.target instanceof HTMLInputElement &&
              !e.defaultPrevented
            ) {
              e.preventDefault();
              if (canSave) handleSave();
            }
          }}
        >
          <div className="px-6 pt-6 pb-4 border-b border-border">
            <DialogHeader>
              <DialogTitle>Project Settings</DialogTitle>
              <DialogDescription className="sr-only">
                Configure this project's general settings, prompts, repository,
                sandbox, stages, and access.
              </DialogDescription>
            </DialogHeader>
          </div>

          {!project && (
            <p
              data-ui="project-settings-loading"
              className="p-6 text-sm text-muted-foreground"
              role="status"
            >
              {detailsError
                ? 'Unable to load project settings. Close and reopen to retry.'
                : 'Loading project settings…'}
            </p>
          )}
          <Tabs
            defaultValue="general"
            className={
              project ? 'flex w-full min-w-0 flex-1 flex-col min-h-0' : 'hidden'
            }
          >
            <div
              data-ui="project-settings-tab-navigation"
              className="min-w-0 overflow-x-auto px-6 pt-3 touch-pan-x sm:overflow-visible"
            >
              <TabsList className="w-max min-w-full justify-start gap-0.5 h-auto flex-nowrap sm:w-full sm:flex-wrap">
                <TabsTrigger value="general">General</TabsTrigger>
                <TabsTrigger value="agents">Agents</TabsTrigger>
                <TabsTrigger value="memory">Memory</TabsTrigger>
                <TabsTrigger value="prompts">Prompts</TabsTrigger>
                <TabsTrigger value="board">Board</TabsTrigger>
                <TabsTrigger value="repository">Repository</TabsTrigger>
                <TabsTrigger value="sandbox">Sandbox</TabsTrigger>
                <TabsTrigger value="deploy">
                  Deploy &amp; publishing
                </TabsTrigger>
                <TabsTrigger value="integrations">Integrations</TabsTrigger>
                <TabsTrigger value="preferences">My preferences</TabsTrigger>
                <TabsTrigger
                  value="danger"
                  className="data-[state=active]:text-destructive ml-auto"
                >
                  Danger
                </TabsTrigger>
              </TabsList>
            </div>

            <ScrollArea
              data-ui="project-settings-content"
              className="w-full min-w-0 flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!w-full"
            >
              <GeneralTab
                form={form}
                setForm={setForm}
                project={project}
                projects={projects}
                project_id={project_id}
                config={config}
                projectName={projectName}
                setProjectName={setProjectName}
                group_folder={group_folder}
                setProjectFolder={setProjectFolder}
                parentId={parentId}
                setParentId={setParentId}
                inheritedEffectiveSandbox={inheritedEffectiveSandbox}
                canEditPrivacyMode={isAdmin}
                privacyModeError={privacyModeError}
                clearPrivacyModeError={() => setPrivacyModeError(null)}
              />
              <AgentsTab
                form={form}
                setForm={setForm}
                project_id={project_id}
                config={config}
                runtimeCatalog={runtimeCatalog}
                runtimeCatalogError={runtimeCatalogError}
                runtimeCatalogRetrying={runtimeCatalogFetching}
                onRetryRuntimeCatalog={() => void refetchRuntimeCatalog()}
                availableAiUsers={availableAiUsers}
                availableAiUserTeams={availableAiUserTeams}
                taskCostLimitText={taskCostLimitText}
                setTaskCostLimitText={setTaskCostLimitText}
                skillsOwnerName={
                  inheritedSandbox
                    ? (sandboxOwner?.name ?? sandboxOwner?.id)
                    : undefined
                }
              />
              <MemoryTab
                form={form}
                setForm={setForm}
                project={project}
                memorySourceOptions={memorySourceOptions}
              />
              <PromptsTab
                form={form}
                setForm={setForm}
                project_id={project_id}
                savedProjectIsParent={savedProjectIsParent}
                savedProjectUsesRepositoryPrompt={
                  savedProjectUsesRepositoryPrompt
                }
                regenerating={regenerating}
                setRegenerating={setRegenerating}
              />
              <BoardTab
                form={form}
                setForm={setForm}
                project={project}
                kanbanEnabled={kanbanEnabled}
                parentId={parentId}
                draftInheritsStages={draftInheritsStages}
                draftParentChanged={draftParentChanged}
                draftParentStages={draftParentStages}
                draftEffectiveStages={draftEffectiveStages}
                savedEffectiveStages={savedEffectiveStages}
                stageOccupancy={stageOccupancy}
                stageOccupancyPending={stageOccupancyPending}
                stageOccupancyError={stageOccupancyError}
                refetchStageOccupancy={refetchStageOccupancy}
                openRemovalStageId={openRemovalStageId}
                setOpenRemovalStageId={setOpenRemovalStageId}
                conflictProspectiveStages={conflictProspectiveStages}
                setConflictProspectiveStages={setConflictProspectiveStages}
                conflictDraftInherited={conflictDraftInherited}
                setConflictDraftInherited={setConflictDraftInherited}
                stageMigrations={stageMigrations}
                setStageMigrations={setStageMigrations}
                runtimeCatalog={runtimeCatalog}
                availableAiUsers={availableAiUsers}
                onStageSuffixInvalidChange={setStageSuffixInvalid}
                onInheritFromParent={handleInheritFromParent}
              />
              <RepositoryTab
                form={form}
                setForm={setForm}
                project_id={project_id}
                config={config}
                gitNexusRepos={gitNexusRepos}
                savedProjectSettings={savedProjectSettings}
                pushSettingsChanged={pushSettingsChanged}
                canEditRepository={canEditRepository}
                isPushing={isPushing}
                setIsPushing={setIsPushing}
                worktreeFilesText={worktreeFilesText}
                setWorktreeFilesText={setWorktreeFilesText}
              />
              <SandboxTab
                form={form}
                setForm={setForm}
                project={project}
                config={config}
                group_folder={group_folder}
                inheritedSandbox={inheritedSandbox}
                canEditRepository={canEditRepository}
                canEditSandboxBinding={isAdmin}
                canEditMounts={isAdmin}
                sandboxOwner={sandboxOwner}
                inheritedEffectiveSandbox={inheritedEffectiveSandbox}
                sandboxDraftChanged={sandboxDraftChanged}
                hostWorkspaceLocation={hostWorkspaceLocation}
                containerWorkspaceRoot={containerWorkspaceRoot}
                workspaceRootsText={workspaceRootsText}
                setWorkspaceRootsText={setWorkspaceRootsText}
                proxyHostnameAliasesText={proxyHostnameAliasesText}
                setProxyHostnameAliasesText={setProxyHostnameAliasesText}
                extraMountsText={extraMountsText}
                setExtraMountsText={setExtraMountsText}
                discoveringRepositories={discoveringRepositories}
                discoveryMaxDepth={discoveryMaxDepth}
                setDiscoveryMaxDepth={setDiscoveryMaxDepth}
                discoveryExclusions={discoveryExclusions}
                setDiscoveryExclusions={setDiscoveryExclusions}
                discoveryReport={discoveryReport}
                discoveryAvailability={discoveryAvailability}
                handleRepositoryDiscovery={handleRepositoryDiscovery}
              />
              <DeployTab
                form={form}
                setForm={setForm}
                project={project}
                sandboxDraftChanged={sandboxDraftChanged}
                canEditDeployService={isAdmin}
              />
              <IntegrationsTab
                form={form}
                setForm={setForm}
                project={project}
                project_id={project_id}
                config={config}
                unlinkMutation={unlinkMutation}
              />
              <PreferencesTab
                form={form}
                setForm={setForm}
                memberPrefs={memberPrefs}
                setMemberPrefs={setMemberPrefs}
                pushPref={pushPref}
                setPushPref={setPushPref}
                pushEffective={pushEffective}
              />
              <DangerTab
                projectName={projectName}
                confirmDelete={confirmDelete}
                setConfirmDelete={setConfirmDelete}
                deleteMutation={deleteMutation}
                handleDelete={handleDelete}
                canDelete={!authUser || canManageProject}
              />
            </ScrollArea>
          </Tabs>

          <DialogFooter
            data-ui="project-settings-footer"
            className="gap-2 px-6 py-4 border-t border-border"
          >
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={requestClose}>
                Cancel
              </Button>
              {(stageSuffixInvalid ||
                stageIdDuplicate ||
                stageIdInvalid ||
                modeIdError ||
                taskCostLimitInvalid ||
                repositoryInvalid ||
                noModeSelected) && (
                <p
                  id="project-settings-save-blocked"
                  data-ui="project-settings-save-blocked"
                  className="text-xs text-destructive"
                >
                  {stageSuffixInvalid
                    ? 'Finish or revert the stage alternative suffix edit to save.'
                    : stageIdDuplicate
                      ? 'Give every stage a unique ID to save.'
                      : stageIdInvalid
                        ? 'Give every stage a valid ID (lowercase letters, digits, underscores; start with a letter) to save.'
                        : modeIdError
                          ? `${modeIdError} Fix the chat modes to save.`
                          : taskCostLimitInvalid
                            ? 'Fix the per-task cost limit to save.'
                            : repositoryInvalid
                              ? 'Fix the repository URL or default branch to save.'
                              : 'Select at least one mode to save.'}
                </p>
              )}
              <Button
                onClick={handleSave}
                disabled={!canSave}
                aria-describedby={
                  stageSuffixInvalid ||
                  stageIdDuplicate ||
                  stageIdInvalid ||
                  modeIdError ||
                  taskCostLimitInvalid ||
                  repositoryInvalid ||
                  noModeSelected
                    ? 'project-settings-save-blocked'
                    : undefined
                }
              >
                {mutation.isPending || checkingAvailability
                  ? 'Saving...'
                  : 'Save'}
              </Button>
            </div>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
