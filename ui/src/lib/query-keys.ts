export const queryKeys = {
  config: ['config'] as const,
  serverWebBuild: ['admin', 'server-web-build'] as const,
  devices: {
    account: ['devices', 'account'] as const,
    admin: ['admin', 'devices'] as const,
  },
  admin: {
    users: ['admin', 'users'] as const,
    aiUsers: ['admin', 'ai-users'] as const,
    aiUserTeams: ['admin', 'ai-user-teams'] as const,
    ttsVoices: ['admin', 'tts-voices'] as const,
    boxes: ['admin', 'boxes'] as const,
    providerAccounts: ['admin', 'provider-accounts'] as const,
    providerUsage: ['admin', 'provider-usage'] as const,
    mcpConnections: ['admin', 'mcp-connections'] as const,
  },
  memoryAudits: {
    root: ['memory-audits'] as const,
    all: (project_id: string) => ['memory-audits', project_id] as const,
    report: (project_id: string) =>
      ['memory-audits', project_id, 'report'] as const,
    detail: (project_id: string, audit_id: string) =>
      ['memory-audits', project_id, audit_id] as const,
  },
  chatAgents: ['chatAgents'] as const,
  runtimeCatalog: ['runtimeCatalog'] as const,
  projectHarnesses: (projectId: string) =>
    ['projectHarnesses', projectId] as const,
  projects: {
    all: ['projects'] as const,
    statusSummary: ['projects', 'status-summary'] as const,
    // Under `all`, so a project-change event refetches it with the list.
    access: (projectId: string, userId?: string, changeSeq = 0) =>
      ['projects', 'access', projectId, userId, changeSeq] as const,
  },
  publishedApps: {
    all: ['published-app'] as const,
    project: (folder?: string) => ['published-app', folder] as const,
  },
  tasks: {
    all: (project_id: string) => ['tasks', project_id] as const,
    list: (
      project_id: string,
      filters?: { ownerUserId?: string; triggeredByUserId?: string },
    ) =>
      [
        'tasks',
        project_id,
        filters?.ownerUserId ?? '',
        filters?.triggeredByUserId ?? '',
      ] as const,
    detail: (project_id: string, task_id: string) =>
      ['tasks', project_id, task_id] as const,
  },
  messages: {
    all: (project_id: string, task_id: string) =>
      ['messages', project_id, task_id] as const,
  },
  runs: {
    all: (project_id: string, task_id: string) =>
      ['runs', project_id, task_id] as const,
  },
  recordings: {
    all: (project_id: string, task_id: string) =>
      ['recordings', project_id, task_id] as const,
  },
  taskDiff: {
    all: (project_id: string, task_id: string) =>
      ['taskDiff', project_id, task_id] as const,
  },
  taskDefaultBranch: {
    all: (projectId: string, taskId: string) =>
      ['taskDefaultBranch', projectId, taskId] as const,
  },
  fullTask: {
    /** Legacy no-messages fallback: full task record used by the task detail
     *  dialog. Reconciled and invalidated on task_updated so it can't stay
     *  permanently stale after an external task update. */
    all: (project_id: string, task_id: string) =>
      ['fullTask', project_id, task_id] as const,
  },
  externalIssue: {
    all: (project_id: string, task_id: string) =>
      ['externalIssue', project_id, task_id] as const,
  },
  taskActiveRun: {
    all: (task_id: string) => ['taskActiveRun', task_id] as const,
  },
  chatTranscript: {
    all: (project_id: string, conversation_id: string) =>
      ['chatTranscript', project_id, conversation_id] as const,
  },
  conversations: {
    all: (project_id: string) => ['conversations', project_id] as const,
  },
  memories: {
    existing: (project_id: string, query: string, memoryType: string) =>
      ['memories', 'existing', project_id, query, memoryType] as const,
  },
  personaLiveMode: {
    all: ['persona-live-mode'] as const,
    status: (project_id: string, conversation_id: string) =>
      ['persona-live-mode', project_id, conversation_id] as const,
  },
  liveMode: {
    /** Live-activity metadata only, polled while Live Mode runs. */
    registry: (project_id: string) => ['liveModeRegistry', project_id] as const,
    /** InfiniteData<Conversation[]> (one page), like the other entries under
     *  `conversations.all`, so those invalidations refresh it and readers of
     *  that prefix accept it. */
    conversations: (project_id: string) =>
      ['conversations', project_id, 'liveMode'] as const,
  },
  artifacts: {
    all: (project_id: string) => ['artifacts', project_id] as const,
    explorer: (project_id: string) =>
      ['fileExplorer', `${project_id}:artifacts`] as const,
    search: (project_id: string) =>
      ['fileExplorerSearch', `${project_id}:artifacts`] as const,
  },
  conversationDiff: {
    all: (project_id: string, conversation_id: string) =>
      ['conversationDiff', project_id, conversation_id] as const,
    shared: (project_id: string) =>
      ['conversationDiff', project_id, 'shared'] as const,
  },
  defaultBranchSync: {
    all: (project_id: string) => ['defaultBranchSync', project_id] as const,
  },
  fileFavorites: {
    all: (project_id: string) => ['fileFavorites', project_id] as const,
  },
  groupFiles: {
    all: (project_id: string) => ['groupFiles', project_id] as const,
  },
  /** Folder listings of the Move… destination picker. */
  groupMoveTargets: {
    all: (project_id: string) => ['groupMoveTargets', project_id] as const,
    folder: (project_id: string, path: string) =>
      ['groupMoveTargets', project_id, path] as const,
  },
  repoFiles: {
    all: (project_id: string, conversation_id: string) =>
      ['repoFiles', project_id, conversation_id] as const,
    /** Shared across non-worktree conversations: they all list the same main
     *  repo checkout, so the listing is cached once per project and reused
     *  instead of re-fetched on every conversation switch. Worktree
     *  conversations use `all(pid, cid)` because each worktree is a distinct
     *  checkout. */
    shared: (project_id: string) =>
      ['repoFiles', project_id, 'shared'] as const,
  },
  cronjobs: {
    all: (project_id: string) => ['cronjobs', project_id] as const,
    list: (project_id: string, archived: boolean) =>
      ['cronjobs', project_id, archived] as const,
  },
  datasetTasks: {
    all: (project_id: string) => ['datasetTasks', project_id] as const,
    list: (project_id: string, archived: boolean) =>
      ['datasetTasks', project_id, archived] as const,
  },
  scheduledTasks: {
    all: (project_id: string) => ['scheduledTasks', project_id] as const,
    detail: (project_id: string, id: string) =>
      ['scheduledTasks', project_id, id] as const,
    runs: (project_id: string, id: string) =>
      ['scheduledTaskRuns', project_id, id] as const,
    transcripts: (project_id: string, id: string) =>
      ['scheduledTaskTranscript', project_id, id] as const,
    transcript: (project_id: string, id: string, runId: string) =>
      [...queryKeys.scheduledTasks.transcripts(project_id, id), runId] as const,
  },
  sandbox: {
    status: (group?: string) =>
      group
        ? (['sandbox', 'status', group] as const)
        : (['sandbox', 'status'] as const),
    restartPending: (group?: string) =>
      group
        ? (['sandbox', 'restart-pending', group] as const)
        : (['sandbox', 'restart-pending'] as const),
    ps: ['sandbox', 'ps'] as const,
    instancePs: (instance: string) => ['sandbox', 'ps', instance] as const,
  },
  whatsapp: {
    status: ['whatsapp', 'status'] as const,
  },
  groups: {
    available: ['groups', 'available'] as const,
    selfChats: ['groups', 'self-chats'] as const,
  },
  objectives: {
    all: (project_id: string) => ['objectives', project_id] as const,
    referenced: (project_id: string) =>
      ['objectives', project_id, 'referenced'] as const,
    detail: (project_id: string, objective_id: string) =>
      ['objectives', project_id, objective_id] as const,
  },
  objectiveMessages: {
    all: (
      project_id: string,
      objective_id: string,
      conversation_id?: string,
    ) =>
      conversation_id
        ? ['objectiveMessages', project_id, objective_id, conversation_id]
        : (['objectiveMessages', project_id, objective_id] as const),
  },
  objectiveConversations: {
    all: (project_id: string, objective_id: string) =>
      ['objectiveConversations', project_id, objective_id] as const,
  },
  gitNexusRepos: ['gitNexusRepos'] as const,
  unreadNotifications: ['unreadNotifications'] as const,
  attention: {
    all: ['attention'] as const,
  },
  historyReview: {
    batches: ['historyReview', 'batches'] as const,
    batch: (batchId: string) => ['historyReview', 'batch', batchId] as const,
  },
};
