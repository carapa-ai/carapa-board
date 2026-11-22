import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Check,
  Crown,
  Pause,
  Play,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import {
  fetchAvailableAiUsers,
  fetchConversationAiUsers,
  fetchMainConversationAiUser,
  fetchMainConversationAiUserSelection,
  fetchProjectAvailableAiUserTeams,
  inviteConversationAiUserApi,
  inviteConversationAiUserTeamApi,
  removeConversationAiUserApi,
  setMainConversationAiUserApi,
  setConversationAiUserStatusApi,
  type AiUser,
  type AiUserTeam,
  type MainAiUserSelection,
} from '@/lib/api';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { eligibleAiUserTeamMemberIds } from '@/lib/ai-user-teams';
import { SecureImage } from '@/components/secure-image';
import { queryKeys } from '@/lib/query-keys';
import {
  effectiveDraftInvitedIds,
  seedDraftInvites,
} from '@/lib/draft-ai-user-invites';

export interface DraftAiUserSelection {
  mainSelection: MainAiUserSelection;
  invitedAiUserIds: string[];
  /** True once the composer participant list intentionally overrides project defaults. */
  invitedAiUserIdsProvided?: boolean;
}

export function personaControlLabel(
  action: 'Pause' | 'Resume' | 'Remove',
  name: string,
): string {
  return `${action} ${name}`;
}

export function AiUsersMenu({
  projectId,
  conversationId,
  draftAvailable = [],
  draftSelection,
  defaultMainAiUserId = null,
  defaultInvitedAiUserIds,
  projectSettingsLoaded = false,
  continuousLoopEnabled = false,
  conversationRunning = false,
  roundPending = false,
  onContinuousLoopChange,
  onStartRound,
  onDraftSelectionChange,
}: {
  projectId: string;
  conversationId: string | null;
  draftAvailable?: AiUser[];
  draftSelection?: DraftAiUserSelection;
  defaultMainAiUserId?: string | null;
  defaultInvitedAiUserIds?: string[];
  /** False while project settings are still loading, i.e. unloaded defaults are not "no defaults". */
  projectSettingsLoaded?: boolean;
  continuousLoopEnabled?: boolean;
  conversationRunning?: boolean;
  roundPending?: boolean;
  onContinuousLoopChange?: (enabled: boolean) => void;
  onStartRound?: () => void;
  onDraftSelectionChange?: (selection: DraftAiUserSelection) => void;
}) {
  const queryClient = useQueryClient();
  const key = ['conversation-ai-users', projectId, conversationId];
  const { data: persistedInvited = [] } = useQuery({
    queryKey: key,
    queryFn: () => fetchConversationAiUsers(projectId, conversationId!),
    enabled: !!conversationId,
  });
  const { data: persistedAvailable = [] } = useQuery({
    queryKey: [...key, 'available'],
    queryFn: () => fetchAvailableAiUsers(projectId, conversationId!),
    enabled: !!conversationId,
  });
  const { data: persistedMainAiUser = null } = useQuery({
    queryKey: [...key, 'main'],
    queryFn: () => fetchMainConversationAiUser(projectId, conversationId!),
    enabled: !!conversationId,
  });
  const { data: persistedMainSelection } = useQuery({
    queryKey: [...key, 'main-selection'],
    queryFn: () =>
      fetchMainConversationAiUserSelection(projectId, conversationId!),
    enabled: !!conversationId,
  });
  const { data: availableTeams = [] } = useQuery({
    queryKey: ['available-ai-user-teams', projectId],
    queryFn: () => fetchProjectAvailableAiUserTeams(projectId),
  });
  const available = conversationId ? persistedAvailable : draftAvailable;
  const mainAiUser = conversationId
    ? persistedMainAiUser
    : (available.find(
        (item) =>
          item.id ===
          (draftSelection?.mainSelection.mode === 'persona'
            ? draftSelection.mainSelection.aiUserId
            : draftSelection?.mainSelection.mode === 'inherit'
              ? defaultMainAiUserId
              : null),
      ) ?? null);
  const mainSelection = conversationId
    ? (persistedMainSelection?.selection ?? { mode: 'inherit' as const })
    : (draftSelection?.mainSelection ?? { mode: 'inherit' as const });
  const draft: DraftAiUserSelection = draftSelection ?? {
    mainSelection,
    invitedAiUserIds: [],
    invitedAiUserIdsProvided: false,
  };
  // Seeding an explicit draft list before the project defaults are known would
  // permanently drop them, so draft invite changes wait for the settings.
  const draftInvitesLocked =
    !conversationId &&
    !draftSelection?.invitedAiUserIdsProvided &&
    !projectSettingsLoaded;
  const availableIds = available.map((item) => item.id);
  const draftInvitedIds = new Set(
    effectiveDraftInvitedIds(
      draft,
      defaultInvitedAiUserIds,
      availableIds,
      mainAiUser?.id,
    ),
  );
  const invited = conversationId
    ? persistedInvited
    : available
        .filter((item) => draftInvitedIds.has(item.id))
        .map((item) => ({ ...item, status: 'active' as const }));
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all(projectId),
      }),
      queryClient.invalidateQueries({
        queryKey: ['objectiveConversations', projectId],
      }),
    ]);
  };
  const invite = useMutation({
    mutationFn: async (id: string) => {
      if (conversationId)
        return inviteConversationAiUserApi(projectId, conversationId, id);
      if (draftInvitesLocked) return;
      onDraftSelectionChange?.(
        seedDraftInvites(
          { ...draft, mainSelection },
          defaultInvitedAiUserIds,
          availableIds,
          mainAiUser?.id,
          { add: [id] },
        ),
      );
    },
    onSuccess: refresh,
  });
  const inviteTeam = useMutation({
    mutationFn: async (team: AiUserTeam) => {
      if (conversationId)
        return inviteConversationAiUserTeamApi(
          projectId,
          conversationId,
          team.id,
        );
      if (draftInvitesLocked) return;
      onDraftSelectionChange?.(
        seedDraftInvites(
          { ...draft, mainSelection },
          defaultInvitedAiUserIds,
          availableIds,
          mainAiUser?.id,
          {
            add: eligibleAiUserTeamMemberIds(
              team,
              available,
              draftInvitedIds,
              mainAiUser?.id,
            ),
          },
        ),
      );
    },
    onSuccess: refresh,
  });
  const status = useMutation({
    mutationFn: ({ id, next }: { id: string; next: 'active' | 'paused' }) =>
      setConversationAiUserStatusApi(projectId, conversationId!, id, next),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (conversationId)
        return removeConversationAiUserApi(projectId, conversationId, id);
      if (draftInvitesLocked) return;
      onDraftSelectionChange?.(
        seedDraftInvites(
          { ...draft, mainSelection },
          defaultInvitedAiUserIds,
          availableIds,
          mainAiUser?.id,
          { remove: [id] },
        ),
      );
    },
    onSuccess: refresh,
  });
  const setMain = useMutation({
    mutationFn: async (selection: MainAiUserSelection) => {
      if (conversationId)
        return setMainConversationAiUserApi(
          projectId,
          conversationId,
          selection,
        );
      const id = selection.mode === 'persona' ? selection.aiUserId : null;
      onDraftSelectionChange?.({
        mainSelection: selection,
        invitedAiUserIds: (draftSelection?.invitedAiUserIds ?? []).filter(
          (item) => item !== id,
        ),
        invitedAiUserIdsProvided: draftSelection?.invitedAiUserIdsProvided,
      });
    },
    onSuccess: refresh,
  });
  const invitedIds = new Set(invited.map((item) => item.id));

  return (
    <>
      {invited.length > 0 && (
        <>
          <DropdownMenuCheckboxItem
            data-ui="persona-continuous-loop-toggle"
            checked={continuousLoopEnabled}
            onCheckedChange={(checked) =>
              onContinuousLoopChange?.(checked === true)
            }
            onSelect={(event) => event.preventDefault()}
          >
            Continue automatically
          </DropdownMenuCheckboxItem>
          {conversationId &&
            (!continuousLoopEnabled || !conversationRunning) && (
              <DropdownMenuItem
                data-ui="persona-start-round"
                disabled={conversationRunning || roundPending}
                onSelect={() => onStartRound?.()}
              >
                <Play className="mr-2 size-4" />
                {roundPending ? 'Starting…' : 'Start next round'}
              </DropdownMenuItem>
            )}
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-ui="main-ai-user-menu">
          <Crown className="mr-2 size-4" />
          Main participant
        </DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent
            data-mobile-sheet
            collisionPadding={8}
            className="max-h-[min(60vh,24rem)] w-[min(18rem,calc(100vw-2rem))] overflow-y-auto"
          >
            <DropdownMenuItem
              data-ui="main-ai-user-inherit"
              onSelect={() => setMain.mutate({ mode: 'inherit' })}
            >
              <Bot className="mr-2 size-7 rounded-full bg-muted p-1.5" />
              <span className="flex-1">Project default</span>
              {mainSelection.mode === 'inherit' && <Check className="size-4" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-ui="main-ai-user-none"
              onSelect={() => setMain.mutate({ mode: 'none' })}
            >
              <Bot className="mr-2 size-7 rounded-full bg-muted p-1.5" />
              <span className="flex-1">No persona</span>
              {mainSelection.mode === 'none' && <Check className="size-4" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {available.map((item) => (
              <DropdownMenuItem
                key={item.id}
                data-ui="main-ai-user-option"
                data-ai-user-id={item.id}
                onSelect={() =>
                  setMain.mutate({ mode: 'persona', aiUserId: item.id })
                }
              >
                {item.avatarUrl ? (
                  <SecureImage
                    src={item.avatarUrl}
                    alt=""
                    className="mr-2 size-7 rounded-full object-cover"
                  />
                ) : (
                  <Bot className="mr-2 size-7 rounded-full bg-muted p-1.5" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    {item.name}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {item.identity}
                  </span>
                </span>
                {mainSelection.mode === 'persona' &&
                  mainSelection.aiUserId === item.id && (
                    <Check className="size-4" />
                  )}
              </DropdownMenuItem>
            ))}
            {available.length === 0 && (
              <DropdownMenuItem disabled>
                No AI users configured
              </DropdownMenuItem>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-ui="invite-ai-users-menu">
          <UserPlus className="mr-2 size-4" />
          Invite
        </DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent
            data-mobile-sheet
            collisionPadding={8}
            className="max-h-[min(60vh,24rem)] w-[min(18rem,calc(100vw-2rem))] overflow-y-auto"
          >
            {!conversationId && !draftSelection?.invitedAiUserIdsProvided && (
              <>
                <DropdownMenuItem
                  data-ui="draft-invitations-override-empty"
                  onSelect={() =>
                    onDraftSelectionChange?.({
                      mainSelection,
                      invitedAiUserIds: [],
                      invitedAiUserIdsProvided: true,
                    })
                  }
                >
                  <X className="mr-2 size-4" />
                  Use no project invite defaults
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {availableTeams.map((team) => {
              const eligibleCount = eligibleAiUserTeamMemberIds(
                team,
                available,
                invitedIds,
                mainAiUser?.id,
              ).length;
              return (
                <DropdownMenuItem
                  key={team.id}
                  data-ui="invite-ai-user-team"
                  data-team-id={team.id}
                  disabled={
                    eligibleCount === 0 ||
                    inviteTeam.isPending ||
                    draftInvitesLocked
                  }
                  onSelect={() => inviteTeam.mutate(team)}
                >
                  <Users className="mr-2 size-7 rounded-full bg-muted p-1.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{team.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {eligibleCount > 0
                        ? `${eligibleCount} available`
                        : 'All members already invited'}
                      {team.description ? ` · ${team.description}` : ''}
                    </span>
                  </span>
                  {eligibleCount === 0 && <Check className="size-4" />}
                </DropdownMenuItem>
              );
            })}
            {availableTeams.length > 0 && <DropdownMenuSeparator />}
            {invited.map((item) => (
              <div
                key={item.id}
                data-ui="invited-ai-user"
                data-ai-user-id={item.id}
                className="flex items-center gap-2 px-2 py-1.5"
              >
                {item.avatarUrl ? (
                  <SecureImage
                    src={item.avatarUrl}
                    alt=""
                    className="size-7 rounded-full object-cover"
                  />
                ) : (
                  <Bot className="size-7 rounded-full bg-muted p-1.5" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">
                    {item.name}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {item.identity}
                  </div>
                </div>
                {conversationId && (
                  <DropdownMenuItem
                    data-ui="invited-ai-user-toggle-status"
                    aria-label={personaControlLabel(
                      item.status === 'active' ? 'Pause' : 'Resume',
                      item.name,
                    )}
                    title={item.status === 'active' ? 'Pause' : 'Resume'}
                    className="size-auto shrink-0 gap-0 rounded p-1"
                    onSelect={(event) => {
                      event.preventDefault();
                      status.mutate({
                        id: item.id,
                        next: item.status === 'active' ? 'paused' : 'active',
                      });
                    }}
                  >
                    {item.status === 'active' ? (
                      <Pause className="size-3.5" />
                    ) : (
                      <Play className="size-3.5" />
                    )}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  data-ui="invited-ai-user-remove"
                  aria-label={personaControlLabel('Remove', item.name)}
                  title="Remove"
                  disabled={draftInvitesLocked}
                  className="size-auto shrink-0 gap-0 rounded p-1"
                  onSelect={(event) => {
                    event.preventDefault();
                    remove.mutate(item.id);
                  }}
                >
                  <X className="size-3.5" />
                </DropdownMenuItem>
              </div>
            ))}
            {invited.length > 0 && <DropdownMenuSeparator />}
            {available
              .filter(
                (item) =>
                  !invitedIds.has(item.id) && item.id !== mainAiUser?.id,
              )
              .map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  disabled={draftInvitesLocked}
                  onSelect={() => invite.mutate(item.id)}
                >
                  {item.avatarUrl ? (
                    <SecureImage
                      src={item.avatarUrl}
                      alt=""
                      className="mr-2 size-7 rounded-full object-cover"
                    />
                  ) : (
                    <Bot className="mr-2 size-7 rounded-full bg-muted p-1.5" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">
                      {item.name}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {item.identity}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            {available.length === 0 && (
              <DropdownMenuItem disabled>
                No AI users configured
              </DropdownMenuItem>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
    </>
  );
}
