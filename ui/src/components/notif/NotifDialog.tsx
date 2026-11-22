import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CircleHelp, Folder, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { JsonForm } from '@/components/notif/JsonForm';
import {
  buildNotificationReplyDraft,
  parseNotificationReplyTarget,
} from '@/components/notif/notification-reply';
import {
  parseSubmitFailure,
  type SubmitFailure,
} from '@/components/notif/notification-submit-errors';
import { MarkdownContent } from '@/components/markdown-content-lazy';
import {
  apiFetch,
  createConversation,
  type AttentionResponse,
} from '@/lib/api';
import { API_BASE_URL } from '@/lib/api-config';
import { queryKeys } from '@/lib/query-keys';
import { formatExactTime, formatRelativeTime } from '@/lib/utils';
import { useStore } from '@/store';
import type { Project } from '@/types';

interface NotifPayload {
  id: string;
  kind: 'text' | 'json_form' | 'html_form';
  summary: string;
  content: string;
  action_url?: string | null;
  created_at?: string | null;
  respond_to_kind?: string | null;
  respond_to_id?: string | null;
}

async function fetchPayload(id: string): Promise<NotifPayload | null> {
  const res = await apiFetch(
    API_BASE_URL + `/api/notifications/payloads/${encodeURIComponent(id)}`,
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return (data?.item as NotifPayload) ?? null;
}

function ackRequest(id: string, formResponse?: object) {
  // Only attach a body when there are values to send, so the shared
  // notification acknowledgement request uses the signed-request convention.
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  };
  if (formResponse !== undefined) {
    init.body = JSON.stringify({ form_response: formResponse });
  }
  return {
    url:
      API_BASE_URL +
      `/api/notifications/payloads/${encodeURIComponent(id)}/ack`,
    init,
  };
}

async function ackPayload(
  id: string,
  formResponse?: object,
): Promise<Response> {
  const { url, init } = ackRequest(id, formResponse);
  return apiFetch(url, init);
}

async function ackFailure(
  res: Response,
  fieldNames: readonly string[],
): Promise<SubmitFailure> {
  const body = await res.json().catch(() => null);
  const error = typeof body?.error === 'string' ? body.error : '';
  const details = typeof body?.details === 'string' ? body.details : '';
  return parseSubmitFailure(
    error || `Submit failed (${res.status})`,
    details,
    fieldNames,
  );
}

async function ackPayloadForOpen(id: string): Promise<void> {
  const { url, init } = ackRequest(id);
  const response = await apiFetch(url, init);
  if (!response.ok) {
    throw new Error('Notification acknowledgement failed');
  }
}

interface NotifDialogProps {
  payloadId: string | null;
  onClose: () => void;
}

export function NotifDialog({ payloadId, onClose }: NotifDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>();
  // Closing is blocked while an action is pending, so the only way a pending
  // action outlives the dialog is an unmount; it must not navigate then.
  const mountedRef = useRef(true);
  const dismissingRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['notif', payloadId],
    queryFn: () =>
      payloadId ? fetchPayload(payloadId) : Promise.resolve(null),
    enabled: !!payloadId,
    staleTime: 60_000,
  });

  // A form payload whose content is not valid JSON must not crash the dialog.
  const formSchema = useMemo(() => {
    if (data?.kind !== 'json_form') return null;
    try {
      return JSON.parse(data.content);
    } catch {
      return null;
    }
  }, [data?.kind, data?.content]);

  async function handleSubmit(values: object) {
    if (!data) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors(undefined);
    try {
      const res = await ackPayload(data.id, values);
      if (res.status === 410) {
        // The server rejected the answer; keep the dialog open to explain why.
        setError('This form has expired');
        return;
      }
      // 409: another device already answered this form — nothing left to do.
      if (res.status === 409) {
        toast.info('Already answered');
      } else if (!res.ok) {
        // Not delivered: keep the dialog open so the typed values aren't lost.
        const failure = await ackFailure(
          res,
          Object.keys(formSchema?.properties ?? {}),
        );
        setError(failure.message);
        setFieldErrors(
          Object.keys(failure.fieldErrors).length
            ? failure.fieldErrors
            : undefined,
        );
        return;
      } else {
        toast.success('Answer sent');
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDismiss() {
    if (!data) return onClose();
    if (submitting || dismissingRef.current) return;
    dismissingRef.current = true;
    setSubmitting(true);
    try {
      const res = await ackPayload(data.id);
      if (!res.ok) toast.error('Could not acknowledge notification');
    } catch {
      /* ignore — closing anyway */
    }
    dismissingRef.current = false;
    setSubmitting(false);
    onClose();
  }

  async function handleOpen() {
    if (!data?.action_url) return;
    setSubmitting(true);
    setError(null);
    try {
      await ackPayloadForOpen(data.id);
      if (!mountedRef.current) return;
      // `to` is a pathname only; a query string left in it is not parsed into
      // search params, so split it and pass the search explicitly.
      const queryStart = data.action_url.indexOf('?');
      await navigate(
        queryStart < 0
          ? { to: data.action_url }
          : {
              to: data.action_url.slice(0, queryStart),
              search: Object.fromEntries(
                new URLSearchParams(data.action_url.slice(queryStart + 1)),
              ),
            },
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Open failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReply() {
    const target = parseNotificationReplyTarget(data?.action_url);
    if (!data || !target) return;
    const { projectId, objectiveId } = target;
    setSubmitting(true);
    setError(null);
    try {
      const conversation = await createConversation(
        projectId,
        objectiveId ? { objective_id: objectiveId } : undefined,
      );
      if (!mountedRef.current) return;
      // Acknowledge only once the reply conversation exists, so a failed
      // creation leaves the notification unacknowledged for a retry. An ack
      // failure must not discard the conversation that was just created.
      try {
        await ackPayloadForOpen(data.id);
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : 'Could not acknowledge notification',
        );
      }
      if (!mountedRef.current) return;
      const store = useStore.getState();
      store.setActiveConvForProject(objectiveId ?? projectId, conversation.id);
      store.saveDraftByKey(
        `${projectId}:${conversation.id}`,
        buildNotificationReplyDraft(data),
      );
      await queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all(projectId),
      });
      if (!mountedRef.current) return;
      await (objectiveId
        ? navigate({
            to: '/objective/$projectId/$objectiveId',
            params: { projectId, objectiveId },
          })
        : navigate({ to: '/chat/$projectId', params: { projectId } }));
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Reply failed';
      toast.error(message);
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  const canReply =
    data?.kind === 'text' && !!parseNotificationReplyTarget(data.action_url);
  const isForm = data?.kind === 'json_form';
  const projectName = useNotificationProject(data ?? null);

  return (
    <Dialog
      open={!!payloadId}
      onOpenChange={(o) => {
        // Escape/overlay/X must not dismiss while an action is pending.
        if (!o && !submitting) onClose();
      }}
    >
      <DialogContent
        className="flex max-w-xl flex-col gap-4 overflow-hidden"
        showCloseButton={false}
        data-ui="notification-dialog"
        data-notification-id={payloadId ?? undefined}
      >
        <div className="flex shrink-0 items-start gap-3">
          <DialogHeader className="min-w-0 flex-1 text-left">
            <DialogTitle className="break-words">
              {isLoading || isError || !data ? 'Notification' : data.summary}
            </DialogTitle>
            {data && !isLoading ? (
              <NotificationMeta
                needsAnswer={isForm}
                projectName={projectName}
                createdAt={data.created_at}
              />
            ) : null}
            <DialogDescription className="sr-only">
              {isLoading
                ? 'Loading notification details'
                : data
                  ? 'Notification details'
                  : 'Notification unavailable'}
            </DialogDescription>
          </DialogHeader>
          <DialogClose
            disabled={submitting}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-80 transition-opacity hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 max-md:size-11"
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>

        {isLoading && (
          <div
            role="status"
            className="flex min-h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 aria-hidden="true" className="animate-spin" />
            Loading notification…
          </div>
        )}

        {!isLoading && (isError || !data) && (
          <>
            <p role="alert" className="text-sm text-muted-foreground">
              Notification not found or expired.
            </p>
            <DialogFooter>
              <Button onClick={onClose} className="max-md:h-11">
                Close
              </Button>
            </DialogFooter>
          </>
        )}

        {!isLoading && data && data.kind === 'text' && (
          <>
            <div
              role="region"
              aria-label="Message"
              tabIndex={0}
              data-ui="notification-body"
              className="markdown-output markdown-output--inline prose prose-base prose-invert -mx-1 min-h-0 max-w-none flex-1 overflow-y-auto overflow-x-hidden break-words rounded-md px-1 text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto"
            >
              <MarkdownContent>{data.content}</MarkdownContent>
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button
                variant={data.action_url ? 'outline' : 'default'}
                onClick={handleDismiss}
                disabled={submitting}
                className="max-md:h-11"
              >
                Dismiss
              </Button>
              {canReply ? (
                <Button
                  variant="outline"
                  onClick={handleReply}
                  disabled={submitting}
                  className="max-md:h-11"
                >
                  Reply
                </Button>
              ) : null}
              {data.action_url ? (
                <Button
                  onClick={handleOpen}
                  disabled={submitting}
                  className="max-md:h-11"
                >
                  Open
                </Button>
              ) : null}
            </DialogFooter>
          </>
        )}

        {!isLoading && data && data.kind === 'json_form' && (
          <>
            {formSchema ? (
              <JsonForm
                schema={formSchema}
                onSubmit={handleSubmit}
                submitting={submitting}
                fieldErrors={fieldErrors}
                error={error}
                dialogTitle={data.summary}
                autoFocusFirstField
                secondaryAction={
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleDismiss}
                    disabled={submitting}
                    className="text-muted-foreground max-md:h-11"
                  >
                    Cancel
                  </Button>
                }
              />
            ) : (
              <p role="alert" className="text-sm text-destructive">
                This form could not be displayed.
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** What it is, which project it belongs to and how old it is. */
function NotificationMeta({
  needsAnswer,
  projectName,
  createdAt,
}: {
  needsAnswer: boolean;
  projectName?: string;
  createdAt?: string | null;
}) {
  return (
    <div
      data-ui="notification-meta"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
    >
      {needsAnswer ? (
        <Badge
          variant="outline"
          className="border-amber-500/60 text-amber-800 dark:text-amber-300"
        >
          <CircleHelp aria-hidden="true" />
          Needs your answer
        </Badge>
      ) : (
        <Badge variant="secondary">Update</Badge>
      )}
      {projectName ? (
        <span className="inline-flex min-w-0 items-center gap-1">
          <Folder aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{projectName}</span>
        </span>
      ) : null}
      {createdAt ? (
        <Tooltip content={formatExactTime(createdAt)} side="bottom">
          <time dateTime={createdAt}>{formatRelativeTime(createdAt)}</time>
        </Tooltip>
      ) : null}
    </div>
  );
}

/**
 * The project a notification is about, when the payload says so: its action
 * link, or the task a form answers. Read from the query cache, which the Now
 * panel and sidebar keep loaded, so the dialog adds no request.
 */
function useNotificationProject(data: NotifPayload | null): string | undefined {
  const queryClient = useQueryClient();
  if (!data) return undefined;
  let projectId = parseNotificationReplyTarget(data.action_url)?.projectId;
  if (!projectId && data.respond_to_kind === 'task' && data.respond_to_id) {
    projectId = queryClient
      .getQueryData<AttentionResponse>(queryKeys.attention.all)
      ?.items.find(
        (item) => item.kind === 'task' && item.id === data.respond_to_id,
      )?.projectId;
  }
  if (!projectId) return undefined;
  const projects = queryClient.getQueryData<Project[]>(queryKeys.projects.all);
  return projects?.find((p) => p.id === projectId)?.name ?? projectId;
}
