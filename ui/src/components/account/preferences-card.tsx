import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  chooseAccountAvatar,
  fetchAccountAvatarGeneration,
  fetchAccountPreferences,
  generateAccountAvatar,
  updateAccountPreferences,
  uploadAccountAvatar,
} from '@/lib/api';
import { Select, SelectItem } from '@/components/ui/select';
import { refreshAuthUser, useAuth } from '@/lib/auth';
import type { AccountPreferences, AccountProfile } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { SecureImage } from '@/components/secure-image';
import { ImagePlus, Loader2, Sparkles, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { useSpeechLanguageOptions } from '@/components/chat/listening-language-picker';

const preferencesKey = ['preferences', 'account'] as const;
const generationKey = ['preferences', 'account', 'avatar-generation'] as const;

export function PreferencesCard() {
  const queryClient = useQueryClient();
  const user = useAuth((state) => state.user);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: preferencesKey,
    queryFn: fetchAccountPreferences,
    staleTime: Infinity,
  });
  const generation = useQuery({
    queryKey: generationKey,
    queryFn: fetchAccountAvatarGeneration,
    refetchInterval: (query) =>
      query.state.data?.status === 'running' ? 2_000 : false,
  });
  const [content, setContent] = useState('');
  const [baseline, setBaseline] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [displayNameBaseline, setDisplayNameBaseline] = useState('');
  const [avatarPrompt, setAvatarPrompt] = useState('');
  const [dictationLanguage, setDictationLanguage] = useState<string | null>(
    null,
  );
  const [languageBaseline, setLanguageBaseline] = useState<string | null>(null);
  const languageOptions = useSpeechLanguageOptions('Operator default');

  // Latest rendered baselines, read by the sync effect below so it does not
  // need the current values as dependencies.
  const baselinesRef = useRef({
    content: baseline,
    displayName: displayNameBaseline,
    language: languageBaseline,
  });
  baselinesRef.current = {
    content: baseline,
    displayName: displayNameBaseline,
    language: languageBaseline,
  };

  // Server data (refetch, avatar merge) only replaces fields the user has not
  // edited: a field still equal to its baseline follows the server, an edited
  // one keeps the user's value. Baselines always track the server.
  useEffect(() => {
    const prev = baselinesRef.current;
    const nextContent = data?.content ?? '';
    const nextDisplayName = data?.displayName ?? '';
    const nextLanguage = data?.dictationLanguage ?? null;
    setContent((cur) => (cur === prev.content ? nextContent : cur));
    setBaseline(nextContent);
    setDisplayName((cur) => (cur === prev.displayName ? nextDisplayName : cur));
    setDisplayNameBaseline(nextDisplayName);
    setDictationLanguage((cur) => (cur === prev.language ? nextLanguage : cur));
    setLanguageBaseline(nextLanguage);
  }, [data]);

  const mergeProfile = async (profile: AccountProfile) => {
    queryClient.setQueryData<AccountPreferences>(preferencesKey, (current) =>
      current ? { ...current, ...profile } : undefined,
    );
    await refreshAuthUser();
  };

  const save = useMutation({
    mutationFn: (next: {
      content?: string | null;
      language?: string | null;
      displayName?: string | null;
    }) =>
      updateAccountPreferences(next.content, next.language, next.displayName),
    onSuccess: async (res) => {
      const next = res.content ?? '';
      setContent(next);
      setBaseline(next);
      const nextDisplayName = res.displayName ?? '';
      setDisplayName(nextDisplayName);
      setDisplayNameBaseline(nextDisplayName);
      const language = res.dictationLanguage ?? null;
      setDictationLanguage(language);
      setLanguageBaseline(language);
      queryClient.setQueryData(preferencesKey, res);
      await refreshAuthUser();
      toast.success('Preferences saved');
    },
    onError: (error: Error) => {
      toast.error(`Failed to save: ${error.message || 'unknown error'}`);
    },
  });
  const upload = useMutation({
    mutationFn: (dataUrl: string) => uploadAccountAvatar(dataUrl),
    onSuccess: async (profile) => {
      await mergeProfile(profile);
      toast.success('Avatar uploaded');
    },
    onError: (error: Error) =>
      toast.error(error.message || 'Avatar upload failed'),
  });
  const generate = useMutation({
    mutationFn: (mode: 'generate' | 'modify') =>
      generateAccountAvatar(avatarPrompt, mode),
    onSuccess: (state) => {
      queryClient.setQueryData(generationKey, state);
      toast.success('Avatar generation started');
    },
    onError: (error: Error) =>
      toast.error(error.message || 'Avatar generation failed'),
  });
  const choose = useMutation({
    mutationFn: (choice: 'current' | 'candidate') =>
      chooseAccountAvatar(choice),
    onSuccess: async (profile, choice) => {
      await mergeProfile(profile);
      toast.success(
        choice === 'candidate' ? 'New avatar selected' : 'Current avatar kept',
      );
    },
    onError: (error: Error) =>
      toast.error(error.message || 'Unable to save avatar choice'),
  });

  useEffect(() => {
    if (generation.data?.status === 'completed') {
      void queryClient.refetchQueries({
        queryKey: preferencesKey,
        type: 'active',
      });
    }
  }, [generation.data?.finishedAt, generation.data?.status, queryClient]);

  const dirty =
    content !== baseline ||
    displayName !== displayNameBaseline ||
    dictationLanguage !== languageBaseline;
  const isGenerating =
    generate.isPending || generation.data?.status === 'running';
  // Without loaded data the form would show blank baselines; saving from it
  // could overwrite the stored preferences.
  const loadFailed = isError && !data;

  return (
    <Card data-ui="account-profile-preferences-card">
      <CardContent className="space-y-6 p-6">
        <div className="space-y-1">
          <CardTitle className="text-base">Account identity</CardTitle>
          <p className="text-sm text-muted-foreground">
            Your display name and avatar identify you in chats. Your username
            remains your login identifier and is used when no display name is
            set.
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : loadFailed ? (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 p-4 text-sm"
            data-ui="account-preferences-load-error"
            role="alert"
          >
            <span className="text-destructive">Could not load preferences</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-ui="account-preferences-retry"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <>
            <section
              className="space-y-4 rounded-md border p-4"
              data-ui="account-profile-editor"
            >
              <div className="flex flex-wrap items-center gap-4">
                <span
                  className="relative size-20 shrink-0 rounded-full bg-muted ring-1 ring-border"
                  data-ui="account-avatar-current-preview"
                >
                  {data?.avatarUrl ? (
                    <SecureImage
                      src={data.avatarUrl}
                      alt={`${displayName || user?.username || 'Account'} avatar`}
                      className="absolute inset-0 size-full rounded-full object-cover"
                    />
                  ) : (
                    <UserRound className="size-full p-4 text-muted-foreground" />
                  )}
                </span>
                <div className="min-w-64 flex-1 space-y-2">
                  <label className="block space-y-1">
                    <span className="text-sm font-medium">Display name</span>
                    <Input
                      data-ui="account-display-name-input"
                      value={displayName}
                      maxLength={120}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder={user?.username || 'Username'}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Login username: {user?.username || 'Unknown'}
                  </p>
                </div>
              </div>

              <label className="block space-y-1">
                <span className="text-sm font-medium">Avatar prompt</span>
                <Textarea
                  data-ui="account-avatar-prompt"
                  value={avatarPrompt}
                  onChange={(event) => setAvatarPrompt(event.target.value)}
                  placeholder={`Describe a square profile portrait for ${displayName || user?.username || 'your account'}. Leave blank for a default prompt.`}
                  rows={3}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  data-ui="account-generate-avatar"
                  disabled={isGenerating}
                  onClick={() => generate.mutate('generate')}
                >
                  {generate.isPending && generate.variables === 'generate' ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <ImagePlus className="mr-2 size-4" />
                  )}
                  Generate new
                </Button>
                {data?.avatarUrl && (
                  <Button
                    type="button"
                    variant="secondary"
                    data-ui="account-modify-avatar"
                    disabled={isGenerating}
                    onClick={() => generate.mutate('modify')}
                  >
                    {generate.isPending && generate.variables === 'modify' ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <Sparkles className="mr-2 size-4" />
                    )}
                    Modify current
                  </Button>
                )}
                <label className="inline-flex h-9 cursor-pointer items-center rounded-md border px-3 text-sm hover:bg-accent">
                  {upload.isPending ? 'Uploading…' : 'Upload avatar'}
                  <input
                    data-ui="account-upload-avatar"
                    className="hidden"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={upload.isPending}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.currentTarget.value = '';
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () =>
                        upload.mutate(String(reader.result));
                      reader.readAsDataURL(file);
                    }}
                  />
                </label>
              </div>

              {generation.data?.status === 'running' && (
                <p
                  className="flex items-center text-xs text-muted-foreground"
                  data-ui="account-avatar-generation-status"
                >
                  <Loader2 className="mr-2 size-3.5 animate-spin" />
                  Generation continues in the background. You can leave this
                  page.
                </p>
              )}
              {generation.data?.status === 'completed' && (
                <p
                  className="text-xs text-muted-foreground"
                  data-ui="account-avatar-generation-status"
                >
                  Avatar generation completed.
                </p>
              )}
              {generation.data?.status === 'error' && (
                <p
                  className="text-xs text-destructive"
                  data-ui="account-avatar-generation-status"
                >
                  {generation.data.error || 'Avatar generation failed'}
                </p>
              )}

              {data?.avatarCandidateUrl && (
                <div
                  className="space-y-3 rounded-md bg-muted/40 p-3"
                  data-ui="account-avatar-comparison"
                >
                  <p className="text-sm font-medium">
                    Choose the avatar to keep
                  </p>
                  <div className="grid max-w-xl grid-cols-2 gap-4">
                    {data.avatarUrl && (
                      <div
                        className="space-y-2"
                        data-ui="account-avatar-current"
                      >
                        <SecureImage
                          src={data.avatarUrl}
                          alt="Current avatar"
                          className="aspect-square w-full rounded-md object-cover"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full"
                          disabled={choose.isPending || isGenerating}
                          onClick={() => choose.mutate('current')}
                        >
                          Keep current
                        </Button>
                      </div>
                    )}
                    <div
                      className="space-y-2"
                      data-ui="account-avatar-candidate"
                    >
                      <SecureImage
                        src={data.avatarCandidateUrl}
                        alt="Generated avatar candidate"
                        className="aspect-square w-full rounded-md object-cover"
                      />
                      <Button
                        type="button"
                        className="w-full"
                        disabled={choose.isPending || isGenerating}
                        onClick={() => choose.mutate('candidate')}
                      >
                        Use new avatar
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </section>

            <section className="space-y-4" data-ui="account-chat-preferences">
              <div className="space-y-1">
                <CardTitle className="text-base">Your Preferences</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Personal notes included in every authenticated chat you start.
                  Per-project preferences override these defaults.
                </p>
              </div>
              <Textarea
                data-ui="account-preferences-input"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={14}
                placeholder="e.g. Match the language I write in and prefer concise replies."
              />
              <label className="block space-y-2">
                <span className="text-sm font-medium">Dictation language</span>
                <Select
                  data-ui="account-dictation-language"
                  className="w-full"
                  value={dictationLanguage ?? ''}
                  onValueChange={(nextValue) =>
                    setDictationLanguage(nextValue || null)
                  }
                >
                  {languageOptions.map((language) => (
                    <SelectItem key={language.code} value={language.code}>
                      {language.label}
                    </SelectItem>
                  ))}
                </Select>
              </label>
            </section>
          </>
        )}

        {!loadFailed && (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              disabled={!dirty || save.isPending}
              onClick={() => {
                setContent(baseline);
                setDisplayName(displayNameBaseline);
                setDictationLanguage(languageBaseline);
              }}
            >
              Reset
            </Button>
            <Button
              data-ui="account-save-profile-preferences"
              disabled={!dirty || save.isPending}
              onClick={() =>
                save.mutate({
                  content:
                    content === baseline
                      ? undefined
                      : content.trim() === ''
                        ? null
                        : content,
                  language:
                    dictationLanguage === languageBaseline
                      ? undefined
                      : dictationLanguage,
                  displayName:
                    displayName === displayNameBaseline
                      ? undefined
                      : displayName.trim() || null,
                })
              }
            >
              {save.isPending && (
                <Loader2 className="mr-2 size-4 animate-spin" />
              )}
              Save
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
