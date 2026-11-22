import { useEffect, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  ChevronDown,
  ImagePlus,
  Loader2,
  Pencil,
  Plus,
  Save,
  Smartphone,
  Sparkles,
  Trash2,
  Users,
  Volume2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Select, SelectItem } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { useAuth } from '@/lib/auth';
import {
  createAiUser,
  chooseAiUserAvatar,
  createAiUserTeam,
  deleteAiUserEmote,
  deleteAiUser,
  deleteAiUserTeam,
  draftAiUserAvatarPrompt,
  draftAiUserPersona,
  fetchAiUserAvatarGeneration,
  fetchAiUserEmoteGeneration,
  fetchAiUsers,
  fetchAiUserTeams,
  fetchRuntimeCatalog,
  fetchTtsVoiceCatalog,
  fetchConfig,
  generateAiUserAvatar,
  generateAiUserEmote,
  importAiUserVoiceStyle,
  updateAiUser,
  updateAiUserTeam,
  uploadAiUserAvatar,
  type AiUser,
  type AvatarGenerationMode,
} from '@/lib/api';
import { useTts } from '@/lib/use-tts';
import { deviceTtsAvailable } from '@/lib/device-tts';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/layout/page-header';
import { SecureImage } from '@/components/secure-image';
import { confirmAction } from '@/components/confirm-dialog';
import { queryKeys } from '@/lib/query-keys';

const NEW_PROMPT = `---
identity: "New AI user"
turn: after
tools: []
---

You are a thoughtful participant in a multi-user conversation.
`;

const SUPERTONIC_EXPRESSION_PREVIEWS = [
  ['Laugh', 'laugh'],
  ['Breath', 'breath'],
  ['Surprise', 'surprise'],
  ['Sigh', 'sigh'],
  ['Scream', 'scream'],
  ['Throat clear', 'throatclear'],
  ['Sad', 'sad'],
  ['Angry', 'angry'],
  ['Cough', 'cough'],
  ['Yawn', 'yawn'],
] as const;

function applyPersonaFrontmatter(
  prompt: string,
  turn: 'before' | 'after',
  tools: string[],
): string {
  const turnLine = `turn: ${turn}`;
  const toolsBlock =
    tools.length > 0
      ? `tools:\n${tools.map((tool) => `  - ${tool}`).join('\n')}`
      : 'tools: []';
  let next = /^turn:.*$/m.test(prompt)
    ? prompt.replace(/^turn:.*$/m, turnLine)
    : prompt.replace(/^---\s*$/m, `---\n${turnLine}`);
  if (/^tools:/m.test(next))
    next = next.replace(/^tools:.*(?:\n(?:\s+-.*))*$/m, toolsBlock);
  else next = next.replace(/^---\s*$/m, `---\n${toolsBlock}`);
  return next;
}

interface ActiveEmoteGeneration {
  aiUserId: string;
  name: string;
}

function emoteGenerationQueryKey(job: ActiveEmoteGeneration | null) {
  return [
    'admin',
    'ai-users',
    job?.aiUserId,
    'emote-generation',
    job?.name.trim().toLowerCase(),
  ] as const;
}

export function AdminAiUsersPage() {
  const isAdmin = useAuth((state) => state.user?.role === 'admin');
  const queryClient = useQueryClient();
  const usersQuery = useQuery({
    queryKey: queryKeys.admin.aiUsers,
    queryFn: fetchAiUsers,
    enabled: isAdmin,
  });
  const teamsQuery = useQuery({
    queryKey: queryKeys.admin.aiUserTeams,
    queryFn: fetchAiUserTeams,
    enabled: isAdmin,
  });
  const { data: users = [], isLoading } = usersQuery;
  const { data: teams = [], isLoading: teamsLoading } = teamsQuery;
  const loadErrors = [
    { key: 'users', query: usersQuery },
    { key: 'teams', query: teamsQuery },
  ].filter(({ query }) => query.isError);
  const { data: catalog } = useQuery({
    queryKey: queryKeys.runtimeCatalog,
    queryFn: fetchRuntimeCatalog,
    enabled: isAdmin,
  });
  const { data: config } = useQuery({
    queryKey: queryKeys.config,
    queryFn: fetchConfig,
    enabled: isAdmin,
  });
  const { data: voiceCatalog } = useQuery({
    queryKey: queryKeys.admin.ttsVoices,
    queryFn: fetchTtsVoiceCatalog,
    enabled: isAdmin && config?.ttsEnabled === true,
  });
  const tts = useTts();
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | 'new' | null>(
    null,
  );
  const selected = users.find((item) => item.id === selectedId);
  const selectedTeam = teams.find((item) => item.id === selectedTeamId);
  const [teamName, setTeamName] = useState('');
  const [teamDescription, setTeamDescription] = useState('');
  const [teamMemberIds, setTeamMemberIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState('');
  const [prompt, setPrompt] = useState(NEW_PROMPT);
  const [enabled, setEnabled] = useState(true);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [voiceLang, setVoiceLang] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState('Hello. This is my voice.');
  const [turn, setTurn] = useState<'before' | 'after'>('after');
  const [tools, setTools] = useState<string[]>([]);
  const [draftingInstructions, setDraftingInstructions] = useState('');
  const [avatarPrompt, setAvatarPrompt] = useState('');
  const [emoteName, setEmoteName] = useState('');
  const [emotePrompt, setEmotePrompt] = useState('');
  const [activeEmoteGeneration, setActiveEmoteGeneration] =
    useState<ActiveEmoteGeneration | null>(null);
  const generationKey = [
    'admin',
    'ai-users',
    selected?.id,
    'avatar-generation',
  ] as const;
  const avatarGeneration = useQuery({
    queryKey: generationKey,
    queryFn: () => fetchAiUserAvatarGeneration(selected!.id),
    enabled: !!selected,
    refetchInterval: (query) =>
      query.state.data?.status === 'running' ? 2000 : false,
  });
  const emoteGenerationKey = emoteGenerationQueryKey(activeEmoteGeneration);
  const emoteGeneration = useQuery({
    queryKey: emoteGenerationKey,
    queryFn: () =>
      fetchAiUserEmoteGeneration(
        activeEmoteGeneration!.aiUserId,
        activeEmoteGeneration!.name,
      ),
    enabled: activeEmoteGeneration !== null,
    refetchInterval: (query) =>
      query.state.data?.status === 'running' ? 2000 : false,
  });

  useEffect(() => {
    setActiveEmoteGeneration(null);
  }, [selectedId]);

  // Ids whose saved row the editor form was last loaded from. A refetch of the
  // same row must not overwrite unsaved edits.
  const loadedTeamId = useRef<string | null>(null);
  const loadedUserId = useRef<string | null>(null);

  useEffect(() => {
    if (selectedTeam) {
      if (loadedTeamId.current === selectedTeam.id) return;
      loadedTeamId.current = selectedTeam.id;
      setTeamName(selectedTeam.name);
      setTeamDescription(selectedTeam.description);
      setTeamMemberIds(selectedTeam.memberIds);
      return;
    }
    loadedTeamId.current = selectedTeamId === 'new' ? 'new' : null;
    if (selectedTeamId === 'new') {
      setTeamName('');
      setTeamDescription('');
      setTeamMemberIds([]);
    }
  }, [selectedTeam, selectedTeamId]);

  useEffect(() => {
    if (selected) {
      if (loadedUserId.current === selected.id) return;
      loadedUserId.current = selected.id;
      setName(selected.name);
      setPresetId(selected.presetId);
      setPrompt(selected.prompt);
      setEnabled(selected.enabled);
      setTurn(selected.turn);
      setTools(selected.tools);
      setVoiceId(selected.voiceId);
      setVoiceLang(selected.voiceLang);
    } else if (selectedId === 'new') {
      loadedUserId.current = 'new';
      setName('');
      setPresetId(catalog?.presets[0]?.id ?? '');
      setPrompt(NEW_PROMPT);
      setEnabled(true);
      setTurn('after');
      setTools([]);
      setVoiceId(voiceCatalog?.defaults.voiceId ?? null);
      setVoiceLang(voiceCatalog?.defaults.language ?? null);
    } else {
      loadedUserId.current = null;
    }
    setDraftingInstructions('');
    setAvatarPrompt('');
    setEmoteName('');
    setEmotePrompt('');
  }, [
    selected,
    selectedId,
    catalog,
    voiceCatalog?.defaults.voiceId,
    voiceCatalog?.defaults.language,
  ]);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.aiUsers });
  const refreshTeams = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.aiUserTeams });
  const saveTeam = useMutation({
    mutationFn: () =>
      selectedTeam
        ? updateAiUserTeam(selectedTeam.id, {
            name: teamName,
            description: teamDescription,
            memberIds: teamMemberIds,
          })
        : createAiUserTeam({
            name: teamName,
            description: teamDescription,
            memberIds: teamMemberIds,
          }),
    onSuccess: (team) => {
      void refreshTeams();
      setSelectedTeamId(team.id);
      toast.success('AI team saved');
    },
    onError: (error: any) =>
      toast.error(error.message || 'Unable to save AI team'),
  });
  const removeTeam = useMutation({
    mutationFn: (id: string) => deleteAiUserTeam(id),
    onSuccess: () => {
      void refreshTeams();
      setSelectedTeamId(null);
      toast.success('AI team deleted');
    },
    onError: (error: any) =>
      toast.error(error.message || 'Unable to delete AI team'),
  });
  const save = useMutation({
    mutationFn: () =>
      selected
        ? updateAiUser(selected.id, {
            name,
            presetId,
            prompt: applyPersonaFrontmatter(prompt, turn, tools),
            enabled,
            voiceId,
            voiceLang,
          })
        : createAiUser({
            name,
            presetId,
            prompt: applyPersonaFrontmatter(prompt, turn, tools),
            enabled,
            voiceId,
            voiceLang,
          }),
    onSuccess: (item) => {
      refresh();
      setSelectedId(item.id);
      toast.success('AI user saved');
    },
    onError: (error: any) =>
      toast.error(error.message || 'Unable to save AI user'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteAiUser(id),
    onSuccess: () => {
      refresh();
      void refreshTeams();
      setSelectedId(null);
      toast.success('AI user deleted');
    },
    onError: (error: any) =>
      toast.error(error.message || 'Unable to delete AI user'),
  });
  const draftPersona = useMutation({
    mutationFn: () =>
      draftAiUserPersona({
        name,
        prompt: applyPersonaFrontmatter(prompt, turn, tools),
        guidance: draftingInstructions,
      }),
    onSuccess: (draft) => {
      setPrompt(draft.prompt);
      setTurn(draft.turn);
      setTools(draft.tools);
      toast.success(
        'Persona draft added to the editor. Review it before saving.',
      );
    },
    onError: (error: any) =>
      toast.error(error.message || 'Persona drafting failed'),
  });
  const draftAvatarPrompt = useMutation({
    mutationFn: () =>
      draftAiUserAvatarPrompt({
        persona: applyPersonaFrontmatter(prompt, turn, tools),
        guidance: avatarPrompt,
      }),
    onSuccess: (draft) => {
      setAvatarPrompt(draft.prompt);
      toast.success('Avatar prompt drafted. Review it before generating.');
    },
    onError: (error: any) =>
      toast.error(error.message || 'Avatar prompt drafting failed'),
  });
  const generate = useMutation({
    mutationFn: ({
      id,
      prompt: imagePrompt,
      mode,
    }: {
      id: string;
      prompt: string;
      mode: AvatarGenerationMode;
    }) => generateAiUserAvatar(id, imagePrompt, mode),
    onSuccess: (state) => {
      queryClient.setQueryData(generationKey, state);
      toast.success(
        state.status === 'running'
          ? 'Avatar generation started'
          : 'Avatar generation is already active',
      );
    },
    onError: (error: any) =>
      toast.error(error.message || 'Avatar generation failed'),
  });
  const isGeneratingAvatar =
    generate.isPending || avatarGeneration.data?.status === 'running';
  const chooseAvatar = useMutation({
    mutationFn: (choice: 'current' | 'candidate') =>
      chooseAiUserAvatar(selected!.id, choice),
    onSuccess: (item, choice) => {
      queryClient.setQueryData<AiUser[]>(
        queryKeys.admin.aiUsers,
        (current = []) =>
          current.map((user) => (user.id === item.id ? item : user)),
      );
      toast.success(
        choice === 'candidate'
          ? 'New avatar selected; the previous image was archived'
          : 'Current avatar kept',
      );
    },
    onError: (error: any) =>
      toast.error(error.message || 'Unable to save avatar choice'),
  });
  const generateEmote = useMutation({
    mutationFn: (job: ActiveEmoteGeneration & { prompt: string }) =>
      generateAiUserEmote(job.aiUserId, job.name, job.prompt),
    onMutate: (job) => {
      const previous = activeEmoteGeneration;
      setActiveEmoteGeneration({ aiUserId: job.aiUserId, name: job.name });
      return { previous };
    },
    onSuccess: (state, job) => {
      queryClient.setQueryData(emoteGenerationQueryKey(job), state);
      toast.success(
        state.status === 'running'
          ? 'Emote generation started'
          : 'This emote is already being generated',
      );
    },
    onError: (error: any, _job, context) => {
      setActiveEmoteGeneration(context?.previous ?? null);
      toast.error(error.message || 'Emote generation failed');
    },
  });
  const removeEmote = useMutation({
    mutationFn: (name: string) => deleteAiUserEmote(selected!.id, name),
    onSuccess: () => {
      void refresh();
      toast.success('Emote deleted');
    },
    onError: (error: any) =>
      toast.error(error.message || 'Unable to delete emote'),
  });
  const isGeneratingEmote =
    generateEmote.isPending || emoteGeneration.data?.status === 'running';
  const importVoice = useMutation({
    mutationFn: (file: File) => importAiUserVoiceStyle(selected!.id, file),
    onSuccess: (item) => {
      setVoiceId(item.voiceId);
      void refresh();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.admin.ttsVoices,
      });
      toast.success('Custom voice imported');
    },
    onError: (error: any) =>
      toast.error(error.message || 'Voice import failed'),
  });

  useEffect(() => {
    if (avatarGeneration.data?.status === 'completed') void refresh();
  }, [avatarGeneration.data?.finishedAt]);
  useEffect(() => {
    if (emoteGeneration.data?.status !== 'completed' || !activeEmoteGeneration)
      return;
    let cancelled = false;
    const completedJob = activeEmoteGeneration;
    void queryClient
      .refetchQueries({ queryKey: queryKeys.admin.aiUsers, type: 'active' })
      .then(() => {
        if (cancelled) return;
        setActiveEmoteGeneration((current) =>
          current?.aiUserId === completedJob.aiUserId &&
          current.name === completedJob.name
            ? null
            : current,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeEmoteGeneration,
    emoteGeneration.data?.finishedAt,
    emoteGeneration.data?.status,
    queryClient,
  ]);

  const assignedIds = new Set(teams.flatMap((team) => team.memberIds));
  const ungroupedUsers = users.filter((user) => !assignedIds.has(user.id));
  const personaListItem = (item: AiUser) => (
    <button
      key={item.id}
      data-ui="ai-user-list-item"
      data-ai-user-id={item.id}
      onClick={() => {
        setSelectedTeamId(null);
        setSelectedId(item.id);
      }}
      className={`flex w-full items-center gap-3 rounded-lg border p-2 text-left ${selectedId === item.id ? 'border-primary bg-accent' : 'hover:bg-accent/50'}`}
    >
      {item.avatarUrl ? (
        <SecureImage
          src={item.avatarUrl}
          alt=""
          className="size-9 rounded-full object-cover"
        />
      ) : (
        <Bot className="size-9 rounded-full bg-muted p-2" />
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">
          {item.name}
        </span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {item.identity}
        </span>
      </span>
    </button>
  );

  if (!isAdmin)
    return <div className="p-6">Administrator access is required.</div>;
  return (
    <div
      className="flex flex-1 flex-col overflow-hidden"
      data-ui="admin-ai-users-page"
    >
      <PageHeader
        title="AI Users"
        subtitle="Manage virtual conversation participants, identities, runtimes, and avatars."
      />
      <div className="grid flex-1 overflow-hidden md:grid-cols-[20rem_1fr]">
        <aside className="overflow-auto border-r p-4">
          <div className="mb-4 grid grid-cols-2 gap-2">
            <Button
              className="gap-1 px-2"
              onClick={() => {
                setSelectedTeamId(null);
                setSelectedId('new');
              }}
            >
              <Plus className="size-4" />
              AI user
            </Button>
            <Button
              variant="outline"
              className="gap-1 px-2"
              onClick={() => {
                setSelectedId(null);
                setSelectedTeamId('new');
              }}
            >
              <Plus className="size-4" />
              Team
            </Button>
          </div>
          {(isLoading || teamsLoading) && (
            <Loader2 className="mx-auto size-5 animate-spin" />
          )}
          {loadErrors.length > 0 && (
            <div
              className="mb-4 space-y-3 rounded-lg border p-3"
              data-ui="ai-users-load-error"
            >
              {loadErrors.map(({ key, query }) => (
                <p key={key} role="alert" className="text-sm text-destructive">
                  {query.error?.message}
                </p>
              ))}
              <Button
                variant="outline"
                onClick={() =>
                  loadErrors.forEach(({ query }) => query.refetch())
                }
              >
                Retry
              </Button>
            </div>
          )}
          <div className="space-y-3" data-ui="ai-user-team-accordions">
            {teams.map((team) => {
              const members = team.memberIds
                .map((id) => users.find((user) => user.id === id))
                .filter((user): user is AiUser => !!user);
              return (
                <details
                  key={team.id}
                  open
                  data-ui="ai-user-team-accordion"
                  data-team-id={team.id}
                  className="rounded-lg border"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-medium">
                    <ChevronDown className="size-4" />
                    <Users className="size-4" />
                    <span className="min-w-0 flex-1 truncate">{team.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {members.length}
                    </span>
                  </summary>
                  <div className="space-y-2 border-t p-2">
                    <button
                      className="flex w-full items-start gap-2 rounded px-1 py-1 text-left text-xs text-muted-foreground hover:bg-accent"
                      onClick={() => {
                        setSelectedId(null);
                        setSelectedTeamId(team.id);
                      }}
                    >
                      <Pencil className="mt-0.5 size-3.5 shrink-0" />
                      <span className="line-clamp-2 flex-1">
                        {team.description || 'Edit team'}
                      </span>
                    </button>
                    {members.map(personaListItem)}
                    {members.length === 0 && !usersQuery.isError && (
                      <p className="px-2 py-1 text-xs text-muted-foreground">
                        No members
                      </p>
                    )}
                  </div>
                </details>
              );
            })}
            {ungroupedUsers.length > 0 && (
              <details
                open
                data-ui="ai-user-team-accordion"
                data-team-id="ungrouped"
                className="rounded-lg border"
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-medium">
                  <ChevronDown className="size-4" />
                  <Bot className="size-4" />
                  <span className="flex-1">Ungrouped</span>
                  <span className="text-xs text-muted-foreground">
                    {ungroupedUsers.length}
                  </span>
                </summary>
                <div className="space-y-2 border-t p-2">
                  {ungroupedUsers.map(personaListItem)}
                </div>
              </details>
            )}
          </div>
        </aside>
        <main className="overflow-auto p-6">
          {selectedTeamId ? (
            <Card
              className="mx-auto max-w-3xl"
              data-ui="ai-user-team-editor"
              data-team-id={selectedTeam?.id ?? 'new'}
            >
              <CardContent className="space-y-5 p-6">
                <div>
                  <h2 className="text-lg font-semibold">
                    {selectedTeam ? 'Edit AI team' : 'New AI team'}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Teams organize reusable sets of personas for bulk
                    conversation invitations.
                  </p>
                </div>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Team name</span>
                  <Input
                    value={teamName}
                    onChange={(event) => setTeamName(event.target.value)}
                    maxLength={120}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Description</span>
                  <Textarea
                    className="min-h-24"
                    value={teamDescription}
                    onChange={(event) => setTeamDescription(event.target.value)}
                    maxLength={2000}
                  />
                </label>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Members</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {users.map((user) => (
                      <label
                        key={user.id}
                        className="flex items-center gap-3 rounded-md border p-2 text-sm"
                      >
                        <Checkbox
                          checked={teamMemberIds.includes(user.id)}
                          onCheckedChange={(checked) =>
                            setTeamMemberIds((current) =>
                              checked === true
                                ? [...current, user.id]
                                : current.filter((id) => id !== user.id),
                            )
                          }
                        />
                        {user.avatarUrl ? (
                          <SecureImage
                            src={user.avatarUrl}
                            alt=""
                            className="size-8 rounded-full object-cover"
                          />
                        ) : (
                          <Bot className="size-8 rounded-full bg-muted p-1.5" />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">
                            {user.name}
                          </span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {user.identity}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {users.length === 0 && !usersQuery.isError && (
                    <p className="text-xs text-muted-foreground">
                      Create an AI user before adding team members.
                    </p>
                  )}
                </fieldset>
                <div className="flex justify-between">
                  {selectedTeam ? (
                    <Button
                      variant="destructive"
                      disabled={removeTeam.isPending}
                      onClick={async () => {
                        const confirmed = await confirmAction(
                          'Personas will not be deleted.',
                          {
                            title: `Delete team “${selectedTeam.name}”?`,
                            confirmLabel: 'Delete team',
                            destructive: true,
                          },
                        );
                        if (confirmed) removeTeam.mutate(selectedTeam.id);
                      }}
                    >
                      <Trash2 className="mr-2 size-4" />
                      Delete team
                    </Button>
                  ) : (
                    <span />
                  )}
                  <Button
                    disabled={saveTeam.isPending || !teamName.trim()}
                    onClick={() => saveTeam.mutate()}
                  >
                    {saveTeam.isPending ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 size-4" />
                    )}
                    Save team
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : !selectedId ? (
            loadErrors.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Select an AI user or team, or create one.
              </p>
            )
          ) : (
            <Card className="mx-auto max-w-4xl" data-ui="ai-user-editor">
              <CardContent className="space-y-5 p-6">
                <div className="flex items-center gap-4">
                  {selected?.avatarUrl ? (
                    <SecureImage
                      src={selected.avatarUrl}
                      alt={selected.identity}
                      className="size-20 rounded-full object-cover"
                    />
                  ) : (
                    <Bot className="size-20 rounded-full bg-muted p-4" />
                  )}
                  <div className="flex flex-wrap gap-2">
                    {selected && (
                      <Button
                        variant="outline"
                        data-ui="ai-user-generate-avatar"
                        aria-busy={
                          generate.isPending &&
                          generate.variables?.mode === 'generate'
                        }
                        disabled={isGeneratingAvatar || !avatarPrompt.trim()}
                        onClick={() =>
                          generate.mutate({
                            id: selected.id,
                            prompt: avatarPrompt,
                            mode: 'generate',
                          })
                        }
                      >
                        {generate.isPending &&
                        generate.variables?.mode === 'generate' ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <ImagePlus className="mr-2 size-4" />
                        )}
                        Generate new avatar
                      </Button>
                    )}
                    {selected?.avatarUrl && (
                      <Button
                        variant="secondary"
                        data-ui="ai-user-modify-avatar"
                        aria-busy={
                          generate.isPending &&
                          generate.variables?.mode === 'modify'
                        }
                        disabled={isGeneratingAvatar || !avatarPrompt.trim()}
                        onClick={() =>
                          generate.mutate({
                            id: selected.id,
                            prompt: avatarPrompt,
                            mode: 'modify',
                          })
                        }
                      >
                        {generate.isPending &&
                        generate.variables?.mode === 'modify' ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <Sparkles className="mr-2 size-4" />
                        )}
                        Modify current avatar
                      </Button>
                    )}
                    {selected && (
                      <label className="inline-flex h-9 cursor-pointer items-center rounded-md border px-3 text-sm hover:bg-accent">
                        Upload avatar
                        <input
                          className="hidden"
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = () =>
                              uploadAiUserAvatar(
                                selected.id,
                                String(reader.result),
                              )
                                .then(() => {
                                  refresh();
                                  toast.success('Avatar uploaded');
                                })
                                .catch((error) => toast.error(error.message));
                            reader.readAsDataURL(file);
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>
                <div
                  className="space-y-2 rounded-md border p-4"
                  data-ui="ai-user-avatar-drafting"
                >
                  <label className="block space-y-1">
                    <span className="text-sm font-medium">Avatar prompt</span>
                    <Textarea
                      className="min-h-24"
                      value={avatarPrompt}
                      onChange={(event) => setAvatarPrompt(event.target.value)}
                      placeholder="Describe the portrait, style, composition, lighting, and background."
                    />
                  </label>
                  {selected?.avatarUrl && (
                    <p className="text-xs text-muted-foreground">
                      “Modify current avatar” uses the saved image as its
                      reference and treats this prompt as edit instructions. The
                      saved avatar is replaced only after the edit succeeds.
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={draftAvatarPrompt.isPending || !prompt.trim()}
                      onClick={() => draftAvatarPrompt.mutate()}
                    >
                      {draftAvatarPrompt.isPending ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <Sparkles className="mr-2 size-4" />
                      )}
                      Draft avatar prompt with AI
                    </Button>
                    {!selected && (
                      <span className="text-xs text-muted-foreground">
                        Save this AI user first; avatar generation needs a saved
                        identity.
                      </span>
                    )}
                  </div>
                  {selected && avatarGeneration.data?.status === 'running' && (
                    <p
                      className="flex items-center text-xs text-muted-foreground"
                      data-ui="ai-user-avatar-generation-status"
                    >
                      <Loader2 className="mr-2 size-3.5 animate-spin" />
                      Generation continues in the background. You can safely
                      leave this page.
                    </p>
                  )}
                  {selected &&
                    avatarGeneration.data?.status === 'completed' && (
                      <p
                        className="text-xs text-muted-foreground"
                        data-ui="ai-user-avatar-generation-status"
                      >
                        Avatar generation completed.
                      </p>
                    )}
                  {selected && avatarGeneration.data?.status === 'error' && (
                    <p
                      className="text-xs text-destructive"
                      data-ui="ai-user-avatar-generation-status"
                    >
                      {avatarGeneration.data.error ||
                        'Avatar generation failed'}
                    </p>
                  )}
                  {selected?.avatarCandidateUrl && (
                    <div
                      className="space-y-3 rounded-md bg-muted/40 p-3"
                      data-ui="ai-user-avatar-comparison"
                    >
                      <p className="text-sm font-medium">
                        Choose the base avatar to keep
                      </p>
                      <div className="grid max-w-xl grid-cols-2 gap-4">
                        {selected.avatarUrl && (
                          <div
                            className="space-y-2"
                            data-ui="ai-user-avatar-current"
                          >
                            <SecureImage
                              src={selected.avatarUrl}
                              alt="Current avatar"
                              className="aspect-square w-full rounded-md object-cover"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              className="w-full"
                              disabled={
                                chooseAvatar.isPending || isGeneratingAvatar
                              }
                              onClick={() => chooseAvatar.mutate('current')}
                            >
                              {chooseAvatar.isPending &&
                              chooseAvatar.variables === 'current' ? (
                                <Loader2 className="mr-2 size-4 animate-spin" />
                              ) : null}
                              Keep current
                            </Button>
                          </div>
                        )}
                        <div
                          className="space-y-2"
                          data-ui="ai-user-avatar-candidate"
                        >
                          <SecureImage
                            src={selected.avatarCandidateUrl}
                            alt="Generated avatar candidate"
                            className="aspect-square w-full rounded-md object-cover"
                          />
                          <Button
                            type="button"
                            className="w-full"
                            disabled={
                              chooseAvatar.isPending || isGeneratingAvatar
                            }
                            onClick={() => chooseAvatar.mutate('candidate')}
                          >
                            {chooseAvatar.isPending &&
                            chooseAvatar.variables === 'candidate' ? (
                              <Loader2 className="mr-2 size-4 animate-spin" />
                            ) : null}
                            Use new avatar
                          </Button>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Choosing the new image archives the current avatar under
                        a timestamped filename instead of deleting it.
                      </p>
                    </div>
                  )}
                </div>
                <section
                  className="space-y-3 rounded-md border p-4"
                  data-ui="ai-user-emotes-editor"
                >
                  <div>
                    <h2 className="text-sm font-medium">Emotes</h2>
                    <p className="text-xs text-muted-foreground">
                      Derive expression and pose variants from this persona’s
                      base avatar. Names become normalized filenames such as{' '}
                      <code>very-happy.png</code>.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block space-y-1">
                      <span className="text-sm font-medium">Emote name</span>
                      <Input
                        value={emoteName}
                        onChange={(event) => setEmoteName(event.target.value)}
                        placeholder="happy"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-sm font-medium">
                        Expression or pose direction
                      </span>
                      <Input
                        value={emotePrompt}
                        onChange={(event) => setEmotePrompt(event.target.value)}
                        placeholder="Optional: delighted, waving with both hands"
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      data-ui="ai-user-generate-emote"
                      aria-busy={isGeneratingEmote}
                      disabled={
                        !selected?.avatarUrl ||
                        !emoteName.trim() ||
                        isGeneratingEmote
                      }
                      onClick={() =>
                        generateEmote.mutate({
                          aiUserId: selected!.id,
                          name: emoteName.trim(),
                          prompt: emotePrompt,
                        })
                      }
                    >
                      {isGeneratingEmote ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <ImagePlus className="mr-2 size-4" />
                      )}
                      {isGeneratingEmote
                        ? 'Generating emote…'
                        : 'Generate emote'}
                    </Button>
                    {!selected && (
                      <span className="text-xs text-muted-foreground">
                        Save this AI user first.
                      </span>
                    )}
                    {selected && !selected.avatarUrl && (
                      <span className="text-xs text-muted-foreground">
                        Generate or upload a base avatar first.
                      </span>
                    )}
                  </div>
                  {emoteGeneration.data?.status === 'running' && (
                    <p
                      className="text-xs text-muted-foreground"
                      data-ui="ai-user-emote-generation-status"
                    >
                      Generation continues in the background. You can safely
                      leave this page.
                    </p>
                  )}
                  {emoteGeneration.data?.status === 'completed' && (
                    <p
                      className="text-xs text-muted-foreground"
                      data-ui="ai-user-emote-generation-status"
                    >
                      Emote generation completed.
                    </p>
                  )}
                  {emoteGeneration.data?.status === 'error' && (
                    <p
                      className="text-xs text-destructive"
                      data-ui="ai-user-emote-generation-status"
                    >
                      {emoteGeneration.data.error || 'Emote generation failed'}
                    </p>
                  )}
                  {selected && (selected.emotes?.length ?? 0) > 0 && (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                      {selected.emotes.map((emote) => (
                        <div
                          key={emote.name}
                          className="overflow-hidden rounded-md border"
                          data-ui="ai-user-emote-item"
                          data-emote-name={emote.name}
                        >
                          <SecureImage
                            src={emote.url}
                            alt={`${selected.identity}: ${emote.name}`}
                            className="aspect-square w-full object-cover"
                          />
                          <div className="flex items-center justify-between gap-2 p-2">
                            <span className="truncate text-xs font-medium">
                              {emote.name}
                            </span>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              aria-label={`Delete ${emote.name} emote`}
                              disabled={removeEmote.isPending}
                              onClick={() => removeEmote.mutate(emote.name)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
                <section
                  className="space-y-3 rounded-md border p-4"
                  data-ui="ai-user-voice-editor"
                >
                  <div>
                    <h2 className="text-sm font-medium">Voice</h2>
                    <p className="text-xs text-muted-foreground">
                      Choose a Supertonic voice or import a JSON exported by
                      Voice Builder.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block space-y-1">
                      <span className="text-sm font-medium">Voice style</span>
                      <Select
                        className="w-full"
                        value={voiceId || ''}
                        disabled={!voiceCatalog?.available}
                        onValueChange={(nextValue) =>
                          setVoiceId(nextValue || null)
                        }
                      >
                        <SelectItem value="">Global default</SelectItem>
                        {voiceCatalog?.voices.map((voice) => (
                          <SelectItem key={voice.id} value={voice.id}>
                            {voice.id} · {voice.kind}
                          </SelectItem>
                        ))}
                      </Select>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-sm font-medium">Language</span>
                      <Select
                        className="w-full"
                        value={voiceLang || ''}
                        onValueChange={(nextValue) =>
                          setVoiceLang(nextValue || null)
                        }
                      >
                        <SelectItem value="">Global default</SelectItem>
                        {voiceCatalog?.languages.map((language) => (
                          <SelectItem key={language} value={language}>
                            {language}
                          </SelectItem>
                        ))}
                      </Select>
                    </label>
                  </div>
                  {!voiceCatalog?.available && config?.ttsEnabled && (
                    <p className="text-xs text-destructive">
                      Supertonic is unavailable; existing voice settings are
                      preserved.
                    </p>
                  )}
                  {selected && (
                    <label className="inline-flex h-9 cursor-pointer items-center rounded-md border px-3 text-sm hover:bg-accent">
                      {importVoice.isPending
                        ? 'Importing…'
                        : 'Import Voice Builder JSON'}
                      <input
                        className="hidden"
                        type="file"
                        accept="application/json,.json"
                        disabled={importVoice.isPending}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) importVoice.mutate(file);
                          event.currentTarget.value = '';
                        }}
                      />
                    </label>
                  )}
                  {!selected && (
                    <p className="text-xs text-muted-foreground">
                      Save this AI user before importing a custom voice.
                    </p>
                  )}
                  <label className="block space-y-1">
                    <span className="text-sm font-medium">Preview text</span>
                    <Input
                      value={previewText}
                      onChange={(event) => setPreviewText(event.target.value)}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Expression tags are experimental. Supertonic reports the
                    best results in English, Japanese, and Korean; other
                    languages may pronounce a tag literally.
                  </p>
                  <div
                    className="flex flex-wrap gap-2"
                    data-ui="ai-user-voice-previews"
                  >
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!config?.ttsEnabled || !previewText.trim()}
                      onClick={() =>
                        void tts.toggle('voice-preview-neutral', previewText, {
                          voice: voiceId || undefined,
                          lang: voiceLang || undefined,
                          engine: 'server',
                        })
                      }
                    >
                      <Volume2 className="mr-1 size-3" />
                      Neutral
                    </Button>
                    {SUPERTONIC_EXPRESSION_PREVIEWS.map(
                      ([label, expression]) => {
                        const text = `<${expression}> ${previewText}`;
                        return (
                          <Button
                            key={expression}
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={
                              !config?.ttsEnabled || !previewText.trim()
                            }
                            onClick={() =>
                              void tts.toggle(
                                `voice-preview-${expression}`,
                                text,
                                {
                                  voice: voiceId || undefined,
                                  lang: voiceLang || undefined,
                                  engine: 'server',
                                },
                              )
                            }
                          >
                            <Volume2 className="mr-1 size-3" />
                            {label}
                          </Button>
                        );
                      },
                    )}
                    {deviceTtsAvailable() && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-ui="ai-user-voice-preview-device"
                        disabled={!previewText.trim()}
                        onClick={() =>
                          void tts.toggle('voice-preview-device', previewText, {
                            lang: voiceLang || undefined,
                            engine: 'device',
                            onError: (message) =>
                              toast.error(
                                `Android voice unavailable: ${message}`,
                                { id: 'voice-preview-device' },
                              ),
                          })
                        }
                      >
                        <Smartphone className="mr-1 size-3" />
                        Android voice
                      </Button>
                    )}
                  </div>
                  {deviceTtsAvailable() && (
                    <p className="text-xs text-muted-foreground">
                      Android voice previews this device's own text-to-speech in
                      the persona's language, as replies sound with on-device
                      text-to-speech turned on. Choose the engine and voice in
                      Account → Devices → This device.
                    </p>
                  )}
                </section>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">AI persona name</span>
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Runtime preset</span>
                  <Select
                    className="w-full"
                    value={presetId}
                    onValueChange={(nextValue) => setPresetId(nextValue)}
                  >
                    <SelectItem value="">Select preset</SelectItem>
                    {catalog?.presets.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </Select>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={enabled}
                    onCheckedChange={(checked) => setEnabled(checked === true)}
                  />
                  Enabled
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">
                    Talking-stick position
                  </span>
                  <Select
                    className="w-full"
                    value={turn}
                    onValueChange={(nextValue) =>
                      setTurn(nextValue as 'before' | 'after')
                    }
                  >
                    <SelectItem value="before">Before main agent</SelectItem>
                    <SelectItem value="after">After main agent</SelectItem>
                  </Select>
                </label>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">
                    Allowed toolsets
                  </legend>
                  <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                    {config?.toolsets?.available
                      .filter((toolset) => toolset !== 'core')
                      .map((toolset) => (
                        <label
                          key={toolset}
                          className="flex items-center gap-2 rounded-md border p-2 text-sm"
                        >
                          <Checkbox
                            checked={tools.includes(toolset)}
                            onCheckedChange={(checked) =>
                              setTools((current) =>
                                checked === true
                                  ? [...new Set([...current, toolset])]
                                  : current.filter((item) => item !== toolset),
                              )
                            }
                          />
                          {toolset}
                        </label>
                      ))}
                  </div>
                </fieldset>
                <div
                  className="space-y-2 rounded-md border p-4"
                  data-ui="ai-user-persona-drafting"
                >
                  <label className="block space-y-1">
                    <span className="text-sm font-medium">
                      AI drafting instructions
                    </span>
                    <Textarea
                      className="min-h-20"
                      value={draftingInstructions}
                      onChange={(event) =>
                        setDraftingInstructions(event.target.value)
                      }
                      placeholder="Optional: describe the role, expertise, perspective, tone, boundaries, or behavior you want."
                    />
                  </label>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={draftPersona.isPending}
                    onClick={() => draftPersona.mutate()}
                  >
                    {draftPersona.isPending ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <Sparkles className="mr-2 size-4" />
                    )}
                    Improve persona with AI
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    The default chat model only fills the editor. Review the
                    result and click Save yourself.
                  </p>
                </div>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Prompt Markdown</span>
                  <Textarea
                    data-ui="ai-user-prompt-editor"
                    className="min-h-96 font-mono"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Frontmatter requires <code>identity</code>; <code>turn</code>{' '}
                  accepts before/after; <code>tools</code> contains toolset
                  names.
                </p>
                <div className="flex justify-between">
                  {selected ? (
                    <Button
                      variant="destructive"
                      disabled={remove.isPending}
                      onClick={async () => {
                        const confirmed = await confirmAction(
                          'The persona prompt, avatar and emotes are deleted with it. This cannot be undone.',
                          {
                            title: `Delete AI user “${selected.name}”?`,
                            confirmLabel: 'Delete AI user',
                            destructive: true,
                          },
                        );
                        if (confirmed) remove.mutate(selected.id);
                      }}
                    >
                      <Trash2 className="mr-2 size-4" />
                      Delete
                    </Button>
                  ) : (
                    <span />
                  )}
                  <Button
                    disabled={save.isPending || !name.trim() || !presetId}
                    onClick={() => save.mutate()}
                  >
                    {save.isPending ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 size-4" />
                    )}
                    Save
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </main>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/admin/ai-users')({
  component: AdminAiUsersPage,
});
