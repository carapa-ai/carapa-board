import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Globe2,
  Link2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectItem } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import {
  searchUsers,
  listProjectMembers,
  addProjectMember,
  removeProjectMember,
  listKbMembers,
  addKbMember,
  removeKbMember,
  listConversationMembers,
  addConversationMember,
  removeConversationMember,
  getConversationPublicShare,
  enableConversationPublicShare,
  regenerateConversationPublicShare,
  revokeConversationPublicShare,
  setConversationPublicVisitorPrompts,
  ApiError,
  type ShareMember,
  type ShareAccessLevel,
  type UserSummary,
} from '@/lib/api';
import type { ConversationPublicShare } from '@/types';
import { API_BASE_URL } from '@/lib/api-config';
import { queryKeys } from '@/lib/query-keys';

type ShareTarget =
  | { kind: 'project'; projectId: string; label?: string }
  | { kind: 'kb'; kbId: string; label?: string }
  | {
      kind: 'conversation';
      projectId: string;
      conversationId: string;
      label?: string;
    };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ShareTarget;
}

async function fetchMembers(target: ShareTarget): Promise<ShareMember[]> {
  if (target.kind === 'project') return listProjectMembers(target.projectId);
  if (target.kind === 'kb') return listKbMembers(target.kbId);
  return listConversationMembers(target.projectId, target.conversationId);
}

async function addMember(
  target: ShareTarget,
  userId: string,
  level: ShareAccessLevel,
): Promise<void> {
  if (target.kind === 'project') {
    await addProjectMember(target.projectId, userId, level);
    return;
  }
  if (target.kind === 'kb') {
    await addKbMember(target.kbId, userId, level);
    return;
  }
  await addConversationMember(
    target.projectId,
    target.conversationId,
    userId,
    level,
  );
}

async function removeMember(
  target: ShareTarget,
  userId: string,
): Promise<void> {
  if (target.kind === 'project') {
    await removeProjectMember(target.projectId, userId);
    return;
  }
  if (target.kind === 'kb') {
    await removeKbMember(target.kbId, userId);
    return;
  }
  await removeConversationMember(
    target.projectId,
    target.conversationId,
    userId,
  );
}

export function ShareDialog({ open, onOpenChange, target }: Props) {
  const queryClient = useQueryClient();
  const [members, setMembers] = useState<ShareMember[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserSummary[]>([]);
  // null while a search is pending or before the first one completes.
  const [searchStatus, setSearchStatus] = useState<'ok' | 'error' | null>(null);
  const [membersLoadFailed, setMembersLoadFailed] = useState(false);
  // True when a refresh failed after a successful mutation: `members` is the
  // last known list, which may no longer match the server.
  const [membersStale, setMembersStale] = useState(false);
  // A mutation succeeded but the follow-up members reload failed.
  const [warning, setWarning] = useState<string | null>(null);
  const [accessLevel, setAccessLevel] = useState<ShareAccessLevel>('viewer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publicShare, setPublicShare] =
    useState<ConversationPublicShare | null>(null);
  const [publicShareError, setPublicShareError] = useState<{
    forbidden: boolean;
    message: string;
  } | null>(null);

  // Callers pass `target` as a fresh inline object on every render, so the load
  // effects key on its primitive fields instead of its identity.
  const targetKind = target.kind;
  const targetProjectId = 'projectId' in target ? target.projectId : undefined;
  const targetKbId = 'kbId' in target ? target.kbId : undefined;
  const targetConversationId =
    'conversationId' in target ? target.conversationId : undefined;
  // Only the latest members request may update `members`/`busy`.
  const membersSeq = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const title = useMemo(() => {
    if (target.kind === 'project')
      return `Share project${target.label ? ` "${target.label}"` : ''}`;
    if (target.kind === 'kb')
      return `Share knowledge base${target.label ? ` "${target.label}"` : ''}`;
    return `Share conversation${target.label ? ` "${target.label}"` : ''}`;
  }, [target]);

  useEffect(() => {
    if (!open) return;
    const seq = ++membersSeq.current;
    setBusy(true);
    setError(null);
    setWarning(null);
    setMembersStale(false);
    fetchMembers(target)
      .then((m) => {
        if (seq === membersSeq.current) {
          setMembers(m);
          setMembersLoadFailed(false);
        }
      })
      .catch((e: any) => {
        if (seq === membersSeq.current) {
          // Do not keep presenting a previous list as the current one.
          setMembers([]);
          setMembersLoadFailed(true);
          setError(e?.message || 'Failed to load members');
        }
      })
      .finally(() => {
        if (seq === membersSeq.current) setBusy(false);
      });
    return () => {
      membersSeq.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetKind, targetProjectId, targetKbId, targetConversationId]);

  useEffect(() => {
    if (!open || target.kind !== 'conversation') return;
    let cancelled = false;
    setPublicShareError(null);
    getConversationPublicShare(target.projectId, target.conversationId)
      .then((share) => {
        if (!cancelled) {
          setPublicShare(share);
          setPublicShareError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPublicShare(null);
          setPublicShareError({
            forbidden: error instanceof ApiError && error.status === 403,
            message:
              error instanceof Error
                ? error.message
                : 'Failed to load public link',
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetKind, targetProjectId, targetConversationId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSearchStatus(null);
    const handle = setTimeout(() => {
      searchUsers(query, 10)
        .then((r) => {
          if (cancelled) return;
          setResults(r);
          setSearchStatus('ok');
        })
        .catch(() => {
          if (cancelled) return;
          setResults([]);
          setSearchStatus('error');
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query]);

  const memberIds = useMemo(
    () => new Set(members.map((m) => m.user_id)),
    [members],
  );

  // Reload after a successful mutation; on failure keep the last known list but
  // mark it stale so the user is not shown an empty dialog for a saved change.
  async function reloadMembers(seq: number) {
    try {
      const next = await fetchMembers(target);
      if (seq !== membersSeq.current) return;
      setMembers(next);
      setMembersLoadFailed(false);
      setMembersStale(false);
    } catch (e) {
      if (seq === membersSeq.current) {
        setMembersLoadFailed(true);
        setMembersStale(true);
      }
      throw e;
    }
  }

  // A failed mutation leaves the list untouched and shows an error. A failed
  // reload after a successful mutation shows a warning with a Retry instead.
  async function mutateThenReload(
    mutate: () => Promise<void>,
    failureMessage: string,
    refreshWarning: string,
    onMutated?: () => void,
  ) {
    const seq = ++membersSeq.current;
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      try {
        await mutate();
      } catch (e: any) {
        setError(e?.message || failureMessage);
        return;
      }
      onMutated?.();
      try {
        await reloadMembers(seq);
      } catch {
        if (seq === membersSeq.current) setWarning(refreshWarning);
      }
    } finally {
      if (seq === membersSeq.current) setBusy(false);
    }
  }

  async function handleRetryReload() {
    const seq = ++membersSeq.current;
    setBusy(true);
    try {
      await reloadMembers(seq);
      if (seq === membersSeq.current) setWarning(null);
    } catch {
      // The warning stays so the user can retry again.
    } finally {
      if (seq === membersSeq.current) setBusy(false);
    }
  }

  function handleAdd(user: UserSummary) {
    return mutateThenReload(
      () => addMember(target, user.id, accessLevel),
      'Failed to share',
      `Added ${user.username}, but the member list could not be refreshed.`,
      () => setQuery(''),
    );
  }

  // The add endpoints (project, KB, conversation) upsert on an existing member,
  // so re-adding with a new level changes the role without revoking access.
  async function handleChangeLevel(
    member: ShareMember,
    level: ShareAccessLevel,
  ) {
    if (level === member.access_level) return;
    // `members` is unchanged on API failure, so the select reverts to the old level.
    await mutateThenReload(
      () => addMember(target, member.user_id, level),
      'Failed to change access level',
      'Access level changed, but the member list could not be refreshed.',
    );
  }

  function handleRemove(user_id: string) {
    return mutateThenReload(
      () => removeMember(target, user_id),
      'Failed to remove',
      'Removed, but the member list could not be refreshed.',
    );
  }

  const absolutePublicUrl = publicShare?.url
    ? new URL(
        publicShare.url,
        API_BASE_URL || window.location.origin,
      ).toString()
    : null;

  async function updatePublicShare(action: 'enable' | 'regenerate' | 'revoke') {
    if (target.kind !== 'conversation') return;
    setBusy(true);
    setError(null);
    try {
      if (action === 'revoke') {
        await revokeConversationPublicShare(
          target.projectId,
          target.conversationId,
        );
        setPublicShare({
          active: false,
          url: null,
          createdAt: null,
          updatedAt: null,
          allowVisitorPrompts: false,
          visitorPromptingAvailable: false,
          visitorPromptingUnavailableReason: 'Create a public link first.',
        });
      } else {
        const next =
          action === 'enable'
            ? await enableConversationPublicShare(
                target.projectId,
                target.conversationId,
              )
            : await regenerateConversationPublicShare(
                target.projectId,
                target.conversationId,
              );
        setPublicShare(next);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all(target.projectId),
      });
      await queryClient.invalidateQueries({
        queryKey: ['objectiveConversations', target.projectId],
      });
    } catch (e: any) {
      setError(e?.message || 'Failed to update public link');
    } finally {
      setBusy(false);
    }
  }

  async function updateVisitorPrompting(enabled: boolean) {
    if (target.kind !== 'conversation') return;
    setBusy(true);
    setError(null);
    try {
      setPublicShare(
        await setConversationPublicVisitorPrompts(
          target.projectId,
          target.conversationId,
          enabled,
        ),
      );
    } catch (e: any) {
      setError(e?.message || 'Failed to update visitor prompting');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] max-w-md overflow-hidden"
        // Focus the search field here rather than with `autoFocus`: that would
        // run during commit, before the dialog records the element to return
        // focus to when it closes.
        onOpenAutoFocus={(event) => {
          if (target.kind === 'conversation') return;
          event.preventDefault();
          searchRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {target.kind === 'conversation'
              ? 'Create a public view-only link or share with an authenticated user.'
              : 'Pick a user, choose access level, then click Add.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[68vh] flex-col gap-3 overflow-y-auto pr-1">
          <div className="flex gap-2">
            <SearchInput
              wrapperClassName="flex-1"
              placeholder="Find a user by username"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Find a user by username"
              ref={searchRef}
            />
            <Select
              aria-label="Access level"
              value={accessLevel}
              onValueChange={(nextValue) =>
                setAccessLevel(nextValue as ShareAccessLevel)
              }
            >
              <SelectItem value="viewer">Viewer</SelectItem>
              <SelectItem value="editor">Editor</SelectItem>
            </Select>
          </div>

          {searchStatus === 'error' && (
            <div
              role="alert"
              className="text-sm text-red-600 dark:text-red-500"
            >
              Search failed
            </div>
          )}
          {searchStatus === 'ok' && results.length === 0 && (
            <div className="text-sm text-muted-foreground">No users found</div>
          )}
          {results.length > 0 && (
            <div className="max-h-40 overflow-auto rounded border divide-y">
              {results.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center justify-between px-3 py-2 text-sm"
                >
                  <span>{u.username}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || memberIds.has(u.id)}
                    onClick={() => handleAdd(u)}
                  >
                    {memberIds.has(u.id) ? 'Already shared' : 'Add'}
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div>
            <div className="text-sm font-medium mb-2">People with access</div>
            {membersStale && members.length > 0 && (
              <div
                data-ui="share-members-stale"
                className="mb-2 text-xs text-muted-foreground"
              >
                List may be out of date
              </div>
            )}
            <div className="rounded border divide-y">
              {members.length === 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  {membersLoadFailed
                    ? 'Could not load members.'
                    : 'No one yet — add a user above.'}
                </div>
              )}
              {members.map((m) => (
                <div
                  key={m.user_id}
                  className="flex items-center justify-between px-3 py-2 text-sm"
                >
                  <div className="flex flex-col">
                    <span>{m.username}</span>
                    {m.access_level === 'owner' ? (
                      <span className="text-xs text-muted-foreground capitalize">
                        {m.access_level}
                      </span>
                    ) : (
                      <Select
                        className="w-full"
                        compact
                        data-ui="share-member-access-level"
                        data-user-id={m.user_id}
                        aria-label={`Access level for ${m.username}`}
                        value={m.access_level}
                        disabled={busy}
                        onValueChange={(nextValue) =>
                          void handleChangeLevel(
                            m,
                            nextValue as ShareAccessLevel,
                          )
                        }
                      >
                        <SelectItem value="viewer">Viewer</SelectItem>
                        <SelectItem value="editor">Editor</SelectItem>
                      </Select>
                    )}
                  </div>
                  {m.access_level !== 'owner' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => handleRemove(m.user_id)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {target.kind === 'conversation' && !publicShareError && (
            <div
              data-ui="conversation-public-share"
              data-conversation-id={target.conversationId}
              className="order-first space-y-2 border-b pb-3"
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <Globe2 className="size-4" />
                Public conversation link
              </div>
              <p className="text-xs text-muted-foreground">
                Anyone with this link can watch this conversation and future
                messages until you revoke it. You can optionally let visitors
                prompt tool-free personas after safety review. Project files,
                tools, and telemetry stay private.
              </p>
              {publicShare?.active && absolutePublicUrl ? (
                <>
                  <div className="flex gap-2">
                    <Input
                      value={absolutePublicUrl}
                      readOnly
                      aria-label="Public conversation URL"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      title="Copy public link"
                      onClick={() =>
                        navigator.clipboard.writeText(absolutePublicUrl)
                      }
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                  <div
                    data-ui="conversation-public-visitor-prompts"
                    className="rounded-lg border bg-muted/30 p-3"
                  >
                    <label className="flex cursor-pointer items-start gap-3">
                      <Checkbox
                        className="mt-0.5"
                        checked={publicShare.allowVisitorPrompts}
                        disabled={
                          busy || !publicShare.visitorPromptingAvailable
                        }
                        onCheckedChange={(checked) =>
                          void updateVisitorPrompting(checked === true)
                        }
                      />
                      <span className="space-y-1">
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          <ShieldCheck className="size-3.5" /> Allow visitors to
                          prompt personas
                        </span>
                        <span className="block text-xs leading-relaxed text-muted-foreground">
                          Prompts are safety-reviewed, strictly limited, and
                          sent only to direct-LLM personas with no tools.
                          Persona replies are reviewed and scrubbed before
                          publication.
                        </span>
                      </span>
                    </label>
                    {!publicShare.visitorPromptingAvailable && (
                      <p
                        data-ui="conversation-public-visitor-prompts-unavailable"
                        className="mt-2 text-xs text-amber-700 dark:text-amber-400"
                      >
                        {publicShare.visitorPromptingUnavailableReason ||
                          'Visitor prompting is unavailable.'}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => updatePublicShare('regenerate')}
                    >
                      <RefreshCw className="size-3.5" /> Regenerate
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => updatePublicShare('revoke')}
                    >
                      <Trash2 className="size-3.5" /> Revoke
                    </Button>
                  </div>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => updatePublicShare('enable')}
                >
                  <Link2 className="size-3.5" /> Create public link
                </Button>
              )}
            </div>
          )}

          {target.kind === 'conversation' && publicShareError && (
            <div
              data-ui="conversation-public-share-unavailable"
              data-conversation-id={target.conversationId}
              className={`order-first rounded-md border border-dashed px-3 py-2 text-xs ${
                publicShareError.forbidden
                  ? 'text-muted-foreground'
                  : 'text-red-600 dark:text-red-500'
              }`}
            >
              {publicShareError.forbidden
                ? 'Only the conversation owner or a project owner can create a public link.'
                : `Public link unavailable: ${publicShareError.message}`}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="text-sm text-red-600 dark:text-red-500"
            >
              {error}
            </div>
          )}
          {warning && (
            <div
              role="alert"
              data-ui="share-members-refresh-warning"
              className="flex items-center justify-between gap-2 text-sm text-amber-700 dark:text-amber-400"
            >
              <span>{warning}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void handleRetryReload()}
              >
                Retry
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
