import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Download,
  Link as LinkIcon,
  Mail,
  Paperclip,
  RefreshCw,
  Send,
  SquarePen,
} from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { Select, SelectItem } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { FieldRow } from '@/components/ui/field-row';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { WorkspaceToolbar, WorkspaceToolbarRow } from './workspace-toolbar';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  mailRequest,
  mailResponse,
  getNativeBinaryDataUrl,
  saveBlobAsFile,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  emptyMailNavigation,
  replyDraft,
  useMailState,
} from '@/lib/mail-state';
import type {
  MailAccount,
  MailDraft,
  MailFolder,
  MailMessageDetail,
  MailPage,
} from '@/types';

const selectClass = 'min-w-0 max-w-full';
const queryOptions = { retry: false, refetchOnWindowFocus: false } as const;
const blankDraft: MailDraft = { to: '', subject: '', body: '' };

// Matches markdown-style [label](url), bracketed [url], and bare urls.
type MailBodySegment =
  | { type: 'text'; text: string }
  | { type: 'link'; url: string; label?: string };
const MAIL_BODY_LINK_RE =
  /\[([^\]\n]+)\]\((https?:[^)\s]+)\)|\[?(https?:\/\/[^\s\[\]<>"']+)(?:\]?!?)/g;

// Drops trailing punctuation and unbalanced closing parentheses from a bare url.
function trimBareUrl(url: string): string {
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    if (/[.,;:!?]/.test(last)) end--;
    else if (last === ')') {
      const head = url.slice(0, end);
      const opens = head.split('(').length - 1;
      const closes = head.split(')').length - 1;
      if (closes > opens) end--;
      else break;
    } else break;
  }
  return url.slice(0, end);
}

export function mailBodySegments(body: string): MailBodySegment[] {
  const segments: MailBodySegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(MAIL_BODY_LINK_RE)) {
    const index = match.index ?? 0;
    if (index > cursor)
      segments.push({ type: 'text', text: body.slice(cursor, index) });
    if (match[1])
      segments.push({ type: 'link', url: match[2], label: match[1] });
    else {
      const url = trimBareUrl(match[3]);
      segments.push({ type: 'link', url });
      // Trimmed trailing characters stay in the following text segment.
      cursor =
        url.length < match[3].length
          ? index + match[0].indexOf(match[3]) + url.length
          : index + match[0].length;
      continue;
    }
    cursor = index + match[0].length;
  }
  if (cursor < body.length)
    segments.push({ type: 'text', text: body.slice(cursor) });
  return segments;
}

export function MailTab({
  projectId,
  active,
  configured,
}: {
  projectId: string;
  active: boolean;
  configured: boolean;
}) {
  const userId = useAuth((s) => s.user?.id) || '';
  const projectKey = JSON.stringify([userId, projectId]);
  const selectedAccount = useMailState((s) => s.accounts[projectKey]);
  const chooseAccount = useMailState((s) => s.chooseAccount);
  const cache = useQueryClient();
  useEffect(() => {
    if (!active)
      void cache.cancelQueries({ queryKey: ['mail', userId, projectId] });
  }, [active, cache, userId, projectId]);
  const accounts = useQuery({
    ...queryOptions,
    queryKey: ['mail', userId, projectId, 'accounts'],
    enabled: active && configured,
    queryFn: ({ signal }) =>
      mailRequest<{ accounts: MailAccount[] }>(
        projectId,
        'accounts',
        {},
        undefined,
        signal,
      ),
  });
  const account =
    accounts.data?.accounts.find((a) => a.id === selectedAccount) ||
    accounts.data?.accounts[0];
  if (!configured)
    return (
      <p data-ui="mail-setup" className="p-4 text-sm text-muted-foreground">
        Add a CarapaMail token in project settings to open this mailbox.
      </p>
    );
  return (
    <section
      data-ui="project-mail"
      data-project-id={projectId}
      className="flex h-full min-w-0 flex-col"
    >
      {accounts.isError ? (
        <div role="alert" className="p-3 text-sm break-words">
          {accounts.error.message}
          <Button variant="ghost" size="sm" onClick={() => accounts.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      {accounts.isPending ? (
        <p role="status" className="p-3 text-sm text-muted-foreground">
          Connecting to mail…
        </p>
      ) : null}
      {accounts.data?.accounts.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">
          No mail accounts are available for this project.
        </p>
      ) : null}
      {account && !accounts.isError && (
        <>
          <Mailbox
            accountRow={
              <WorkspaceToolbarRow>
                <Mail className="size-4 shrink-0 text-muted-foreground" />
                {accounts.data!.accounts.length > 1 ? (
                  <Select
                    compact
                    aria-label="Mail account"
                    className="min-w-0 flex-1"
                    value={account.id}
                    onValueChange={(nextValue) =>
                      chooseAccount(projectKey, nextValue)
                    }
                  >
                    {accounts.data!.accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.email}
                      </SelectItem>
                    ))}
                  </Select>
                ) : (
                  <span className="truncate text-xs" title={account.email}>
                    {account.email}
                  </span>
                )}
              </WorkspaceToolbarRow>
            }
            key={JSON.stringify([projectKey, account.id])}
            projectId={projectId}
            userId={userId}
            account={account}
            active={active}
          />
        </>
      )}
    </section>
  );
}

function Mailbox({
  projectId,
  userId,
  account,
  active,
  accountRow,
}: {
  projectId: string;
  userId: string;
  account: MailAccount;
  active: boolean;
  /** The account line, rendered as the first row of the mailbox toolbar. */
  accountRow: ReactNode;
}) {
  const stateKey = JSON.stringify([userId, projectId, account.id]);
  const nav = useMailState(
    (s) => s.navigation[stateKey] || emptyMailNavigation,
  );
  const update = useMailState((s) => s.update);
  const patch = (value: Partial<typeof nav>) => update(stateKey, value);
  const cache = useQueryClient();
  const scope = ['mail', userId, projectId, account.id];
  const [replacement, setReplacement] = useState<{
    draft: MailDraft | null;
  } | null>(null);
  const [moveMode, setMoveMode] = useState<'move' | 'trash' | null>(null);
  const [destination, setDestination] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(45);
  const clampHeight = (value: number) => Math.min(75, Math.max(25, value));
  const params = { account: account.id, folder: nav.folder };
  const folders = useQuery({
    ...queryOptions,
    queryKey: [...scope, 'folders'],
    enabled: active && account.capabilities.read,
    queryFn: ({ signal }) =>
      mailRequest<MailFolder[]>(
        projectId,
        'folders',
        { account: account.id },
        undefined,
        signal,
      ),
  });
  const messages = useQuery({
    ...queryOptions,
    queryKey: [...scope, 'messages', nav.folder, nav.query, nav.page],
    enabled: active && account.capabilities.read && !nav.composing,
    queryFn: ({ signal }) =>
      mailRequest<MailPage>(
        projectId,
        'messages',
        {
          ...params,
          page: nav.page,
          ...(nav.query ? { query: nav.query } : {}),
        },
        undefined,
        signal,
      ),
  });
  // The query key includes folder, query and page, so data always belongs to
  // the current view; a same-key background refetch keeps it rendered.
  const visiblePage = messages.data;
  const sortedMessages = [...(visiblePage?.items || [])].sort(
    (a, b) =>
      (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || b.uid - a.uid,
  );
  const detail = useQuery({
    ...queryOptions,
    queryKey: [...scope, 'detail', nav.folder, nav.uid],
    enabled:
      active && account.capabilities.read && nav.uid !== null && !nav.composing,
    queryFn: ({ signal }) =>
      mailRequest<MailMessageDetail>(
        projectId,
        `messages/${nav.uid}`,
        params,
        undefined,
        signal,
      ),
  });
  const refresh = () => cache.invalidateQueries({ queryKey: scope });
  // Drafts live only in memory: warn before a reload or tab close drops one.
  const draftHasContent = [
    nav.draft?.to,
    nav.draft?.subject,
    nav.draft?.body,
  ].some((value) => value?.trim());
  useEffect(() => {
    if (!draftHasContent) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draftHasContent]);
  useEffect(() => {
    if (!active) void cache.cancelQueries({ queryKey: scope });
  }, [active, cache, stateKey]);
  useEffect(() => {
    if (messages.data && nav.page > messages.data.totalPages)
      patch({ page: Math.max(1, messages.data.totalPages) });
  }, [messages.data, nav.page]);
  async function mutate(
    operation: string,
    body: unknown,
    onSuccess?: () => void,
  ) {
    // This guard survives a route remount while a submission is in flight.
    if (useMailState.getState().navigation[stateKey]?.pending) return;
    patch({ pending: true, error: '' });
    try {
      await mailRequest(projectId, operation, {}, body);
      if (!useMailState.getState().navigation[stateKey]) return;
      onSuccess?.();
      void refresh();
    } catch (error) {
      if (!useMailState.getState().navigation[stateKey]) return;
      patch({
        error: `${error instanceof Error ? error.message : 'Mail request failed'}${operation === 'send' ? ' Your draft is retained. If the connection was interrupted, check delivery before sending again.' : ''}`,
      });
    } finally {
      if (useMailState.getState().navigation[stateKey])
        patch({ pending: false });
    }
  }
  const readAttempt = useRef<string | null>(null);
  useEffect(() => {
    const key = nav.uid === null ? null : `${nav.folder}:${nav.uid}`;
    if (
      key !== readAttempt.current &&
      active &&
      detail.data &&
      detail.isSuccess &&
      !detail.isFetching &&
      !nav.composing &&
      account.capabilities.organize &&
      !nav.pending
    ) {
      readAttempt.current = key;
      if (!detail.data.seen)
        void mutate('read-state', {
          ...params,
          uids: [detail.data.uid],
          seen: true,
        });
    }
    if (key === null) readAttempt.current = null;
  }, [
    active,
    detail.data,
    detail.isSuccess,
    detail.isFetching,
    nav.uid,
    nav.folder,
    nav.composing,
    nav.pending,
    account.capabilities.organize,
  ]);
  const startDraft = (draft: MailDraft) => {
    if (nav.draft) setReplacement({ draft });
    else patch({ draft, composing: true, error: '' });
  };
  const selected = nav.uid === null ? nav.selected : [nav.uid];
  const trash = folders.data?.find((folder) => folder.specialUse === '\\Trash');
  const inTrash = trash?.path === nav.folder;
  const canAct =
    account.capabilities.organize && selected.length > 0 && !nav.pending;
  function moveTo(folder: string) {
    void mutate(
      'move',
      { ...params, uids: selected, destination: folder },
      () => {
        patch({ uid: null, selected: [] });
        setMoveMode(null);
      },
    );
  }
  async function download(name: string, type: string) {
    setDownloading(name);
    patch({ error: '' });
    try {
      const response = await mailResponse(projectId, 'attachment', {
        ...params,
        uid: nav.uid!,
        filename: name,
      });
      if (Capacitor.isNativePlatform()) {
        const [{ Filesystem, Directory }, { FileOpener }] = await Promise.all([
          import('@capacitor/filesystem'),
          import('@capacitor-community/file-opener'),
        ]);
        const native = getNativeBinaryDataUrl(response);
        const blob = native ? null : await response.blob();
        const base64 =
          native?.base64 ||
          (await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = reject;
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.readAsDataURL(blob!);
          }));
        const file = await Filesystem.writeFile({
          path: `mail-${Date.now()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
          data: base64,
          directory: Directory.Cache,
        });
        await FileOpener.open({ filePath: file.uri, contentType: type });
      } else {
        saveBlobAsFile(await response.blob(), name);
      }
    } catch (error) {
      patch({
        error:
          error instanceof Error ? error.message : 'Attachment download failed',
      });
    } finally {
      setDownloading(null);
    }
  }
  const error =
    nav.error || (folders.error || messages.error || detail.error)?.message;
  return (
    <div
      data-ui="mailbox"
      data-account-id={account.id}
      className="flex min-h-0 min-w-0 flex-1 flex-col text-sm"
    >
      <WorkspaceToolbar data-ui="mail-toolbar" className="pr-2">
        {accountRow}
        <FieldRow compact>
          {(nav.uid !== null || nav.composing) && (
            <Button
              aria-label="Back to messages"
              size="icon-sm"
              variant="ghost"
              onClick={() => patch({ uid: null, composing: false, error: '' })}
            >
              <ArrowLeft />
            </Button>
          )}
          {account.capabilities.read && (
            <Select
              compact
              aria-label="Mail folder"
              className="min-w-0 flex-1"
              value={nav.folder}
              onValueChange={(nextValue) =>
                patch({
                  folder: nextValue,
                  page: 1,
                  uid: null,
                  selected: [],
                  query: '',
                  search: '',
                  composing: false,
                  error: '',
                })
              }
            >
              {!folders.data?.some((f) => f.path === nav.folder) && (
                <SelectItem value={nav.folder}>{nav.folder}</SelectItem>
              )}
              {folders.data?.map((f) => (
                <SelectItem key={f.path} value={f.path}>
                  {f.name}
                  {f.unseen ? ` (${f.unseen})` : ''}
                </SelectItem>
              ))}
            </Select>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh mail"
            title="Refresh mail"
            disabled={nav.pending}
            onClick={() => {
              patch({ error: '' });
              void refresh();
            }}
          >
            <RefreshCw
              className={
                folders.isFetching || messages.isFetching || detail.isFetching
                  ? 'animate-spin'
                  : ''
              }
            />
          </Button>
          {account.capabilities.send && (
            <Button
              size="sm"
              variant="outline"
              disabled={nav.pending}
              onClick={() => startDraft({ ...blankDraft })}
            >
              <SquarePen />
              Compose
            </Button>
          )}
        </FieldRow>
        {!(nav.composing && nav.draft) && (
          <>
            {account.capabilities.read && (
              <FieldRow
                as="form"
                compact
                onSubmit={(e) => {
                  e.preventDefault();
                  patch({
                    query: nav.search.trim(),
                    uid: null,
                    page: 1,
                    selected: [],
                    error: '',
                  });
                }}
              >
                <SearchInput
                  compact
                  aria-label="Search mail"
                  placeholder="Search this folder"
                  value={nav.search}
                  onChange={(e) => patch({ search: e.target.value })}
                  wrapperClassName="flex-1"
                />
                <Button size="sm" type="submit" variant="outline">
                  Search
                </Button>
              </FieldRow>
            )}
            {account.capabilities.organize && (
              <WorkspaceToolbarRow data-ui="mail-actions" className="gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canAct}
                  onClick={() =>
                    void mutate('read-state', {
                      ...params,
                      uids: selected,
                      seen: true,
                    })
                  }
                >
                  Mark read
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canAct}
                  onClick={() =>
                    void mutate('read-state', {
                      ...params,
                      uids: selected,
                      seen: false,
                    })
                  }
                >
                  Mark unread
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canAct}
                  onClick={() => {
                    setMoveMode('move');
                    setDestination('');
                  }}
                >
                  Move
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canAct || inTrash}
                  onClick={() => {
                    if (trash) moveTo(trash.path);
                    else {
                      setMoveMode('trash');
                      setDestination('');
                    }
                  }}
                >
                  Move to Trash
                </Button>
              </WorkspaceToolbarRow>
            )}
          </>
        )}
      </WorkspaceToolbar>
      {nav.draft && !nav.composing && (
        <Button
          className="mb-2 justify-start"
          size="sm"
          variant="secondary"
          onClick={() => patch({ composing: true })}
        >
          Resume draft
        </Button>
      )}
      {error && (nav.uid === null || nav.composing) && (
        <div
          role="alert"
          data-ui="mail-error"
          className="mr-2 mb-2 rounded border border-border/50 p-2 break-words text-destructive"
        >
          {error}
        </div>
      )}
      {nav.pending && (
        <p role="status" className="pb-2 text-muted-foreground">
          Updating mail…
        </p>
      )}
      {nav.composing && nav.draft ? (
        <form
          data-ui="mail-composer"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pr-2 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (account.capabilities.send)
              void mutate('send', { account: account.id, ...nav.draft }, () =>
                patch({ draft: null, composing: false, uid: null }),
              );
          }}
        >
          <label className="space-y-1">
            To
            <Input
              aria-label="To"
              type="email"
              required
              value={nav.draft.to}
              disabled={nav.pending}
              onChange={(e) =>
                patch({ draft: { ...nav.draft!, to: e.target.value } })
              }
            />
          </label>
          <label className="space-y-1">
            Subject
            <Input
              aria-label="Subject"
              value={nav.draft.subject}
              disabled={nav.pending}
              onChange={(e) =>
                patch({ draft: { ...nav.draft!, subject: e.target.value } })
              }
            />
          </label>
          <label className="flex min-h-40 flex-1 flex-col gap-1">
            Message
            <Textarea
              aria-label="Message"
              className="min-h-40 flex-1 resize-none"
              value={nav.draft.body}
              disabled={nav.pending}
              onChange={(e) =>
                patch({ draft: { ...nav.draft!, body: e.target.value } })
              }
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              type="submit"
              disabled={nav.pending || !account.capabilities.send}
            >
              <Send />
              Send
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={nav.pending}
              onClick={() => setReplacement({ draft: null })}
            >
              Discard draft
            </Button>
          </div>
        </form>
      ) : (
        <>
          {!account.capabilities.read ? (
            <p className="p-3 text-muted-foreground">
              Receiving is disabled for this account.
            </p>
          ) : (
            <div
              ref={splitRef}
              data-ui="mail-split-view"
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
            >
              <div
                data-ui="mail-list-pane"
                className="flex min-h-0 flex-col"
                style={{
                  flex: nav.uid === null ? '1 1 0%' : `0 0 ${listHeight}%`,
                }}
              >
                <div
                  data-ui="mail-message-list"
                  className="min-h-0 flex-1 overflow-auto pr-2"
                >
                  {messages.isFetching && !visiblePage && (
                    <p role="status" className="py-3 text-muted-foreground">
                      Loading messages…
                    </p>
                  )}
                  {visiblePage?.items.length === 0 && (
                    <p className="py-4 text-muted-foreground">
                      {nav.query
                        ? 'No matching messages.'
                        : 'This folder is empty.'}
                    </p>
                  )}
                  {!!visiblePage?.items.length &&
                    account.capabilities.organize && (
                      <label className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                        <Checkbox
                          aria-label="Select all messages on this page"
                          checked={visiblePage.items.every((m) =>
                            nav.selected.includes(m.uid),
                          )}
                          onCheckedChange={(checked) =>
                            patch({
                              uid: null,
                              selected:
                                checked === true
                                  ? visiblePage!.items.map((m) => m.uid)
                                  : [],
                            })
                          }
                        />
                        Select page
                        {nav.selected.length
                          ? ` · ${nav.selected.length} selected`
                          : ''}
                      </label>
                    )}
                  {sortedMessages.map((m) => (
                    <div
                      data-ui="mail-message-row"
                      data-message-id={m.uid}
                      key={m.uid}
                      aria-selected={nav.uid === m.uid}
                      className={`flex items-center gap-2 rounded-md px-2 py-2 transition-colors hover:bg-accent/50 ${nav.uid === m.uid ? 'bg-accent' : ''}`}
                    >
                      {account.capabilities.organize && (
                        <Checkbox
                          aria-label={`Select ${m.subject || 'message'}`}
                          checked={nav.selected.includes(m.uid)}
                          onCheckedChange={(checked) =>
                            patch({
                              uid: null,
                              selected:
                                checked === true
                                  ? [...nav.selected, m.uid]
                                  : nav.selected.filter((uid) => uid !== m.uid),
                            })
                          }
                        />
                      )}
                      <button
                        aria-pressed={nav.uid === m.uid}
                        className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-left md:grid-cols-[minmax(100px,1fr)_minmax(0,3fr)_auto_auto]"
                        onClick={() =>
                          patch({ uid: m.uid, selected: [], error: '' })
                        }
                      >
                        <span
                          className={`truncate ${!m.seen ? 'font-semibold' : 'text-muted-foreground'}`}
                        >
                          {m.from || '(Unknown sender)'}
                        </span>
                        <span
                          className={`col-span-2 row-start-2 truncate md:col-span-1 md:row-start-auto ${!m.seen ? 'font-medium' : ''}`}
                        >
                          {!m.seen && (
                            <span
                              aria-label="Unread"
                              className="mr-1 text-primary"
                            >
                              ●
                            </span>
                          )}
                          {m.subject || '(No subject)'}
                        </span>
                        <span className="hidden w-8 items-center gap-1 text-xs text-muted-foreground md:flex">
                          {m.attachmentCount > 0 && (
                            <>
                              <Paperclip className="size-3 shrink-0" />
                              <span>{m.attachmentCount}</span>
                            </>
                          )}
                        </span>
                        <span className="col-start-2 row-start-1 shrink-0 text-xs text-muted-foreground md:col-start-auto md:row-start-auto">
                          {m.date ? new Date(m.date).toLocaleDateString() : ''}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
                {visiblePage && (
                  <div className="flex items-center justify-between gap-2 border-t border-border/50 py-2 pr-2 text-xs text-muted-foreground">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={nav.page <= 1}
                      onClick={() =>
                        patch({ page: nav.page - 1, selected: [], uid: null })
                      }
                    >
                      Previous
                    </Button>
                    <span>
                      {nav.page} / {visiblePage.totalPages} ·{' '}
                      {visiblePage.total}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!visiblePage.hasMore}
                      onClick={() =>
                        patch({ page: nav.page + 1, selected: [], uid: null })
                      }
                    >
                      Next
                    </Button>
                  </div>
                )}
              </div>
              {nav.uid !== null && (
                <>
                  <div
                    data-ui="mail-reader-divider"
                    role="separator"
                    aria-label="Resize message list and reader"
                    aria-orientation="horizontal"
                    aria-valuemin={25}
                    aria-valuemax={75}
                    aria-valuenow={Math.round(listHeight)}
                    tabIndex={0}
                    className="group flex h-3 shrink-0 touch-none cursor-row-resize items-center justify-center outline-none focus-visible:bg-accent hover:bg-accent/50"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.currentTarget.focus();
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={(e) => {
                      if (!e.currentTarget.hasPointerCapture(e.pointerId))
                        return;
                      const bounds = splitRef.current?.getBoundingClientRect();
                      if (bounds?.height)
                        setListHeight(
                          clampHeight(
                            ((e.clientY - bounds.top) / bounds.height) * 100,
                          ),
                        );
                    }}
                    onPointerUp={(e) => {
                      if (e.currentTarget.hasPointerCapture(e.pointerId))
                        e.currentTarget.releasePointerCapture(e.pointerId);
                    }}
                    onKeyDown={(e) => {
                      if (
                        !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)
                      )
                        return;
                      e.preventDefault();
                      setListHeight((value) =>
                        e.key === 'Home'
                          ? 25
                          : e.key === 'End'
                            ? 75
                            : clampHeight(
                                value + (e.key === 'ArrowUp' ? -5 : 5),
                              ),
                      );
                    }}
                  >
                    <span className="h-1 w-10 rounded-full bg-border group-hover:bg-muted-foreground/50" />
                  </div>
                  <div
                    data-ui="mail-message-detail"
                    data-message-id={nav.uid}
                    className="min-h-0 flex-1 overflow-auto py-3 pr-2"
                  >
                    {detail.isFetching && (
                      <p role="status" className="text-muted-foreground">
                        Loading message and checking mail filters…
                      </p>
                    )}
                    {error && !nav.composing && (
                      <div
                        role="alert"
                        data-ui="mail-error"
                        className="mb-3 rounded border border-border/50 p-2 break-words text-destructive"
                      >
                        {error}
                      </div>
                    )}
                    {detail.data && !detail.isError && (
                      <>
                        <h3 className="mb-3 break-words text-base font-medium">
                          {detail.data.subject || '(No subject)'}
                        </h3>
                        <dl className="space-y-1 break-words text-xs text-muted-foreground">
                          <div>
                            <dt className="inline">From: </dt>
                            <dd className="inline">{detail.data.from}</dd>
                          </div>
                          <div>
                            <dt className="inline">To: </dt>
                            <dd className="inline">{detail.data.to}</dd>
                          </div>
                          {detail.data.cc && (
                            <div>
                              <dt className="inline">Cc: </dt>
                              <dd className="inline">{detail.data.cc}</dd>
                            </div>
                          )}
                          <div>
                            <dt className="inline">Date: </dt>
                            <dd className="inline">
                              {detail.data.date
                                ? new Date(detail.data.date).toLocaleString()
                                : 'Unknown'}
                            </dd>
                          </div>
                        </dl>
                        {account.capabilities.send && (
                          <Button
                            className="my-3"
                            size="sm"
                            variant="outline"
                            disabled={nav.pending}
                            onClick={() => startDraft(replyDraft(detail.data))}
                          >
                            Reply
                          </Button>
                        )}
                        <div
                          data-ui="mail-message-body"
                          className="my-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                        >
                          {detail.data.bodyText
                            ? mailBodySegments(detail.data.bodyText).map(
                                (segment, i) =>
                                  segment.type === 'text' ? (
                                    <Fragment key={i}>{segment.text}</Fragment>
                                  ) : (
                                    <a
                                      key={i}
                                      data-ui={
                                        segment.label
                                          ? 'mail-body-link'
                                          : 'mail-body-link-icon'
                                      }
                                      href={segment.url}
                                      target="_blank"
                                      rel="noreferrer noopener"
                                      title={segment.url}
                                      aria-label={
                                        segment.label ??
                                        `Open link: ${segment.url}`
                                      }
                                      className="mx-0.5 inline-flex items-center gap-1 rounded bg-primary/10 px-1 py-0.5 align-baseline no-underline hover:bg-primary/20"
                                    >
                                      {segment.label ? (
                                        <span className="text-xs text-primary">
                                          {segment.label}
                                        </span>
                                      ) : (
                                        <LinkIcon className="size-3.5 text-primary" />
                                      )}
                                    </a>
                                  ),
                              )
                            : '(No message body)'}
                        </div>
                        {detail.data.attachments.map((a, i) => (
                          <Button
                            data-ui="mail-attachment"
                            key={`${a.name}:${i}`}
                            className="mb-1 h-auto max-w-full justify-start py-2"
                            size="sm"
                            variant="outline"
                            disabled={downloading !== null}
                            onClick={() => void download(a.name, a.type)}
                          >
                            <Download />
                            <span className="min-w-0 whitespace-normal break-all">
                              {a.name} · {Math.ceil(a.size / 1024)} KB
                            </span>
                          </Button>
                        ))}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
      <Dialog
        open={replacement !== null}
        onOpenChange={(open) => {
          if (!open) setReplacement(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsent draft?</DialogTitle>
            <DialogDescription>
              Your current draft will be removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplacement(null)}>
              Keep draft
            </Button>
            <Button
              variant="destructive"
              disabled={nav.pending}
              onClick={() => {
                patch({
                  draft: replacement?.draft ?? null,
                  composing: !!replacement?.draft,
                });
                setReplacement(null);
              }}
            >
              Discard draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={moveMode !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMoveMode(null);
            patch({ error: '' });
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {moveMode === 'trash' ? 'Choose Trash folder' : 'Move messages'}
            </DialogTitle>
            <DialogDescription>
              {moveMode === 'trash'
                ? 'This account does not identify its Trash folder. Choose where to move the selected messages.'
                : `Choose a destination for ${selected.length} message(s).`}
            </DialogDescription>
          </DialogHeader>
          <Select
            aria-label="Destination folder"
            className={selectClass}
            value={destination}
            onValueChange={(nextValue) => setDestination(nextValue)}
          >
            <SelectItem value="">Choose folder</SelectItem>
            {folders.data
              ?.filter((f) => f.path !== nav.folder)
              .map((f) => (
                <SelectItem key={f.path} value={f.path}>
                  {f.name}
                </SelectItem>
              ))}
          </Select>
          {moveMode !== null && error && (
            <p
              role="alert"
              data-ui="mail-move-error"
              className="text-sm text-destructive break-words"
            >
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setMoveMode(null);
                patch({ error: '' });
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!destination || nav.pending}
              onClick={() => moveTo(destination)}
            >
              Move messages
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
