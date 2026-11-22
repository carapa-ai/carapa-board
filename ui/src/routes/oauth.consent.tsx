import { useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Select, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { OAuthTargetsField } from '@/components/oauth/oauth-targets-field';
import {
  ApiError,
  fetchOAuthConsentRequest,
  submitOAuthDecision,
  type OAuthConsentRequest,
  type OAuthDecisionInput,
  type OAuthGrantEntry,
} from '@/lib/api';
import { describeOAuthDays, oauthResourcePath } from '@/lib/oauth-display';

const SELECT_CLASS = 'w-full';

function ConsentShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      id="oauth-consent"
      data-ui="oauth-consent-page"
      className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground"
    >
      <Card className="w-full max-w-md">
        <CardContent className="space-y-5 p-6">{children}</CardContent>
      </Card>
    </div>
  );
}

function ConsentError({ message }: { message: string }) {
  return (
    <ConsentShell>
      <div data-ui="oauth-consent-error" className="space-y-2" role="alert">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-5 shrink-0 text-destructive" />
          <CardTitle className="text-base">
            Sign-in request unavailable
          </CardTitle>
        </div>
        <p className="text-sm text-muted-foreground">{message}</p>
        <p className="text-sm text-muted-foreground">
          Return to the application that sent you here and start the connection
          again.
        </p>
      </div>
    </ConsentShell>
  );
}

function ConsentForm({ request }: { request: OAuthConsentRequest }) {
  const { targets, days: dayChoices } = request.choices;
  const [selection, setSelection] = useState<OAuthGrantEntry[]>(() => {
    // Default to one read-only project; the broader main workspace must be chosen.
    const project = targets.find((t) => t.kind === 'project');
    return project
      ? [{ kind: 'project', folder: project.folder, access: 'read' }]
      : [];
  });
  const [days, setDays] = useState(() => Math.min(...dayChoices));
  const [submitting, setSubmitting] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  if (unavailable) {
    return (
      <ConsentError
        message={error ?? 'This request expired or was already decided.'}
      />
    );
  }

  async function decide(input: OAuthDecisionInput) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const { redirectUrl } = await submitOAuthDecision(request.id, input);
      // Stay locked while the browser leaves for the client's redirect URI.
      window.location.assign(redirectUrl);
    } catch (err) {
      inFlight.current = false;
      setSubmitting(false);
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      if (err instanceof ApiError && err.status === 404) setUnavailable(true);
    }
  }

  return (
    <ConsentShell>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 shrink-0 text-primary" />
          <CardTitle className="text-base">Connect an MCP client</CardTitle>
        </div>
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Client</dt>
            <dd className="break-words font-medium">
              {request.client.name}{' '}
              <span className="text-xs font-normal text-muted-foreground">
                (self-declared name)
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              Returns to (after your decision)
            </dt>
            <dd className="break-all font-medium">{request.redirectHost}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">MCP endpoint</dt>
            <dd className="break-all">
              {oauthResourcePath(request.resource)}
              <span className="block text-xs text-muted-foreground">
                {request.resource}
              </span>
            </dd>
          </div>
        </dl>
      </div>

      <div className="space-y-3">
        <div className="space-y-1 text-sm">
          <span className="text-xs text-muted-foreground">Allow access to</span>
          <OAuthTargetsField
            options={targets}
            value={selection}
            onChange={setSelection}
            disabled={submitting}
          />
        </div>

        <label className="block space-y-1 text-sm">
          <span className="text-xs text-muted-foreground">Duration</span>
          <Select
            className={SELECT_CLASS}
            value={String(days)}
            disabled={submitting}
            onValueChange={(nextValue) => setDays(Number(nextValue))}
          >
            {dayChoices.map((d) => (
              <SelectItem key={d} value={String(d)}>
                {describeOAuthDays(d)}
              </SelectItem>
            ))}
          </Select>
        </label>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          variant="outline"
          disabled={submitting}
          onClick={() => void decide({ decision: 'deny' })}
        >
          Deny
        </Button>
        <Button
          disabled={submitting || selection.length === 0}
          onClick={() =>
            void decide({
              decision: 'approve',
              targets: selection.map(({ kind, folder, access }) => ({
                kind,
                folder,
                access,
              })),
              days,
            })
          }
        >
          {submitting && <Loader2 className="size-4 animate-spin" />}
          Approve
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Approving asks this device to confirm with a fresh signature. You can
        revoke access or change its projects any time under Account → MCP
        clients.
      </p>
    </ConsentShell>
  );
}

export function OAuthConsentPage({ requestId }: { requestId?: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['oauth', 'request', requestId],
    queryFn: () => fetchOAuthConsentRequest(requestId!),
    enabled: !!requestId,
    retry: false,
    staleTime: Infinity,
  });

  if (!requestId) {
    return <ConsentError message="The sign-in link is missing its request." />;
  }
  if (isLoading) {
    return (
      <ConsentShell>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading sign-in request…
        </p>
      </ConsentShell>
    );
  }
  if (error || !data) {
    return (
      <ConsentError
        message={
          error instanceof ApiError && error.status === 404
            ? 'This request expired or does not exist.'
            : ((error as Error | null)?.message ??
              'The request could not be loaded.')
        }
      />
    );
  }
  return <ConsentForm request={data} />;
}

function OAuthConsentRoute() {
  const { request } = Route.useSearch();
  return <OAuthConsentPage requestId={request} />;
}

export const Route = createFileRoute('/oauth/consent')({
  validateSearch: (search: Record<string, unknown>) => ({
    request: typeof search.request === 'string' ? search.request : undefined,
  }),
  component: OAuthConsentRoute,
});
