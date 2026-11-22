import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectItem } from '@/components/ui/select';
import { FieldRow } from '@/components/ui/field-row';
import { QueryErrorState } from '@/components/layout/query-error-state';
import { confirmAction } from '@/components/confirm-dialog';
import { useQueryLoadState } from '@/lib/use-query-load-state';
import {
  ApiError,
  fetchProjectCodeAccess,
  removeProjectCodeAccess,
  saveProjectCodeAccess,
  updateProjectCodeAccess,
  type ProjectCodeAccessChange,
  type ProjectCodeAccessView,
  type ProjectKeyRule,
  type ProjectTokenAuth,
} from '@/lib/api';
import { SettingsSection } from './shared';

type Service = 'gitlab' | 'github' | 'custom';
type TokenPlacement = ProjectTokenAuth['type'];
type Integration = ProjectCodeAccessView['accounts'][number];

const PRESET_NAMES: Record<string, string> = {
  gitlab: 'GitLab',
  github: 'GitHub',
};
const SERVER_PLACEHOLDER: Record<string, string> = {
  gitlab: 'https://gitlab.example.com',
  github: 'https://github.com',
};
const ISSUES_TARGET: Record<string, string> = {
  gitlab: 'Project ID, e.g. 99',
  github: 'owner/repository',
};
const PLACEMENT_LABELS: Record<TokenPlacement, string> = {
  bearer: 'Authorization: Bearer',
  header: 'A header of its own',
  basic: 'Basic (user name + token)',
  query: 'Query parameter',
};

/** The relay route an integration answers on. */
const routeOf = (a: Integration) => a.route ?? a.provider;

function placementText(auth: ProjectTokenAuth | undefined): string {
  if (!auth || auth.type === 'bearer') return 'Authorization: Bearer';
  if (auth.type === 'header') return `Header ${auth.name}`;
  if (auth.type === 'basic') return `Basic, user ${auth.username}`;
  return `Query parameter ${auth.name}`;
}

const rulesText = (rules: ProjectKeyRule[] = []) =>
  rules.map((rule) => `${rule.method} ${rule.path}`).join('\n');

/** One `METHOD /path` per line; returns the first unreadable line instead. */
function parseRules(text: string): ProjectKeyRule[] | string {
  const rules: ProjectKeyRule[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([A-Za-z]+)\s+(\/\S*)$/.exec(line);
    if (!match)
      return `Line ${index + 1}: write a method and a path, like POST /api/v4/projects/99/issues`;
    rules.push({ method: match[1].toUpperCase(), path: match[2] });
  }
  return rules.length ? rules : 'Add at least one allowed call';
}

/** The API call that creates issues in one GitLab project or GitHub repository. */
function createIssuesRule(service: string, target: string): string | null {
  const value = target.trim();
  if (service === 'gitlab')
    return /^\d+$/.test(value) ? `POST /api/v4/projects/${value}/issues` : null;
  if (service === 'github')
    return /^[\w.-]+\/[\w.-]+$/.test(value)
      ? `POST /repos/${value}/issues`
      : null;
  return null;
}

function RulesEditor({
  service,
  value,
  onChange,
  idPrefix,
}: {
  service: string;
  value: string;
  onChange: (value: string) => void;
  idPrefix: string;
}) {
  const [target, setTarget] = useState('');
  const preset = service === 'gitlab' || service === 'github';
  const rule = createIssuesRule(service, target);
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor={`${idPrefix}-rules`}>
        Allowed calls
      </label>
      <Textarea
        id={`${idPrefix}-rules`}
        className="font-mono"
        rows={3}
        placeholder={
          service === 'gitlab'
            ? 'POST /api/v4/projects/99/issues'
            : service === 'github'
              ? 'POST /repos/owner/repository/issues'
              : 'POST /contacts'
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {preset && (
        <FieldRow compact className="flex-wrap">
          <Input
            aria-label={ISSUES_TARGET[service]}
            className="w-48"
            placeholder={ISSUES_TARGET[service]}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!rule}
            onClick={() => {
              if (!rule) return;
              onChange(value.trim() ? `${value.trim()}\n${rule}` : rule);
              setTarget('');
            }}
          >
            Add: create issues
          </Button>
        </FieldRow>
      )}
      <p className="text-xs text-muted-foreground">
        One call per line: a method and a path after the base URL.{' '}
        <code>*</code> stands for one path segment.{' '}
        {preset
          ? "Any other call keeps the sandbox's ordinary key."
          : 'Any other call is refused.'}
      </p>
    </div>
  );
}

function IntegrationRow({
  projectId,
  integration,
  onChanged,
}: {
  projectId: string;
  integration: Integration;
  onChanged: (view: ProjectCodeAccessChange) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rulesText(integration.allow));
  const [error, setError] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (allow: ProjectKeyRule[]) =>
      updateProjectCodeAccess(projectId, integration.id, allow),
    onSuccess: (view) => {
      onChanged(view);
      setEditing(false);
    },
    onError: (err) => setError(err.message),
  });
  const remove = useMutation({
    mutationFn: () => removeProjectCodeAccess(projectId, integration.id),
    onSuccess: onChanged,
    onError: (err) => setError(err.message),
  });
  const route = routeOf(integration);
  const preset = PRESET_NAMES[integration.provider];
  const rejected = integration.keyCheck === 'rejected';
  return (
    <div
      data-ui="project-integration"
      data-account-id={integration.id}
      className="space-y-2 rounded-md border border-border px-3 py-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">
            {preset
              ? `${preset} · ${integration.host}`
              : `/${route} → https://${integration.host}${integration.pathPrefix ?? ''}`}
          </p>
          <p
            className={`text-xs ${rejected ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {rejected
              ? 'The server rejected this token: save a new one'
              : integration.state === 'connected'
                ? [
                    'Token saved',
                    !preset && placementText(integration.auth),
                    integration.expiresAt && `expires ${integration.expiresAt}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'Token missing: save it again'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setText(rulesText(integration.allow));
              setError(null);
              setEditing(!editing);
            }}
          >
            Edit calls
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            disabled={remove.isPending}
            onClick={async () => {
              const confirmed = await confirmAction(
                preset
                  ? 'The sandbox goes back to its ordinary key for these calls. The token stays valid on the server until you revoke it there.'
                  : `The sandbox can no longer call /${route}. The token stays valid at the service until you revoke it there.`,
                {
                  title: `Remove the /${route} integration?`,
                  confirmLabel: 'Remove',
                  destructive: true,
                },
              );
              if (confirmed) remove.mutate();
            }}
          >
            {remove.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              'Remove'
            )}
          </Button>
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <RulesEditor
            service={integration.provider}
            value={text}
            onChange={setText}
            idPrefix={`project-integration-${integration.id}`}
          />
          <Button
            size="sm"
            disabled={update.isPending}
            onClick={() => {
              const rules = parseRules(text);
              if (typeof rules === 'string') return setError(rules);
              setError(null);
              update.mutate(rules);
            }}
          >
            {update.isPending && <Loader2 className="size-3.5 animate-spin" />}
            Save calls
          </Button>
        </div>
      ) : (
        <ul className="space-y-0.5 font-mono text-xs">
          {integration.allow?.map((rule) => (
            <li key={`${rule.method} ${rule.path}`} className="break-all">
              {rule.method} {rule.path}
            </li>
          ))}
        </ul>
      )}
      <p className="break-words text-xs text-muted-foreground">
        Containers: {integration.containers?.join(', ')}
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * Tokens this project's sandbox containers may use for other services, limited
 * to the API calls listed. CarapaBox keeps each token; the api-relay adds it.
 */
export function ProjectIntegrationsSection({
  projectId,
}: {
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['project-integrations', projectId];
  const query = useQuery({
    queryKey,
    queryFn: () => fetchProjectCodeAccess(projectId),
  });
  const load = useQueryLoadState([query]);
  const [service, setService] = useState<Service>('gitlab');
  const [host, setHost] = useState('');
  const [route, setRoute] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [placement, setPlacement] = useState<TokenPlacement>('bearer');
  const [placementName, setPlacementName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [rules, setRules] = useState('');
  const [error, setError] = useState<string | null>(null);
  const onChanged = (view: ProjectCodeAccessChange) =>
    view.accounts
      ? queryClient.setQueryData(queryKey, view)
      : queryClient.invalidateQueries({ queryKey });
  const save = useMutation({
    mutationFn: (input: Parameters<typeof saveProjectCodeAccess>[1]) =>
      saveProjectCodeAccess(projectId, input),
    onSuccess: (view) => {
      onChanged(view);
      setApiKey('');
      setRules('');
      setError(null);
    },
    onError: (err) => setError(err.message),
  });
  const custom = service === 'custom';
  const routeName = custom ? route.trim() : service;
  const existing = query.data?.accounts.find((a) => routeOf(a) === routeName);

  const submit = () => {
    const allow = parseRules(rules);
    if (typeof allow === 'string') return setError(allow);
    setError(null);
    const apiKeyValue = apiKey.trim();
    if (!custom) {
      // An empty server keeps the one this project's integration already uses.
      save.mutate({
        provider: service,
        host: host.trim() || (existing ? `https://${existing.host}` : ''),
        apiKey: apiKeyValue,
        allow,
      });
      return;
    }
    const name = placementName.trim();
    const auth: ProjectTokenAuth =
      placement === 'bearer'
        ? { type: 'bearer' }
        : placement === 'basic'
          ? { type: 'basic', username: name }
          : placement === 'header'
            ? { type: 'header', name: name.toLowerCase() }
            : { type: 'query', name };
    save.mutate({
      provider: 'custom',
      route: route.trim(),
      baseUrl: baseUrl.trim(),
      auth,
      apiKey: apiKeyValue,
      allow,
    });
  };

  // Only the owner of the project that owns the sandbox may see this section.
  if (query.error instanceof ApiError && query.error.status === 403)
    return null;

  return (
    <SettingsSection
      name="project-integrations"
      title="Service integrations"
      description={
        <>
          Tokens this project's sandbox containers may use for other services,
          only for the API calls you list (for example, creating issues from the
          application). CarapaBox keeps each token and the api-relay adds it to
          those calls; it never enters the sandbox. The application calls{' '}
          <code>http://api-relay:8080/&lt;name&gt;/…</code>, for example{' '}
          <code>/gitlab</code>.
        </>
      }
    >
      {load.phase === 'loading' ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : load.phase === 'error' ? (
        <QueryErrorState
          compact
          title="Integrations unavailable"
          error={load.error}
          onRetry={load.retry}
          isRetrying={load.isRetrying}
        />
      ) : (
        <div className="space-y-4" data-ui="project-integrations">
          <p className="text-xs text-muted-foreground">
            Sandbox instance: {query.data?.sandbox.stack}/
            {query.data?.sandbox.instance}
          </p>
          {query.data?.accounts.map((integration) => (
            <IntegrationRow
              key={integration.id}
              projectId={projectId}
              integration={integration}
              onChanged={onChanged}
            />
          ))}
          <div
            className="space-y-3 rounded-md border border-border px-3 py-3"
            data-ui="project-integration-form"
          >
            <p className="text-sm font-medium">
              {existing
                ? `Replace the /${routeName} token`
                : 'Add an integration'}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <label
                  className="text-sm font-medium"
                  htmlFor="project-integration-service"
                >
                  Service
                </label>
                <Select
                  id="project-integration-service"
                  className="w-full"
                  value={service}
                  onValueChange={(value) => setService(value as Service)}
                >
                  <SelectItem value="gitlab">GitLab</SelectItem>
                  <SelectItem value="github">GitHub</SelectItem>
                  <SelectItem value="custom">Other service</SelectItem>
                </Select>
              </div>
              {custom ? (
                <div className="space-y-2">
                  <label
                    className="text-sm font-medium"
                    htmlFor="project-integration-route"
                  >
                    Name
                  </label>
                  <Input
                    id="project-integration-route"
                    placeholder="crm"
                    value={route}
                    onChange={(e) => setRoute(e.target.value.toLowerCase())}
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <label
                    className="text-sm font-medium"
                    htmlFor="project-integration-host"
                  >
                    Server
                  </label>
                  <Input
                    id="project-integration-host"
                    placeholder={
                      existing
                        ? `https://${existing.host}`
                        : SERVER_PLACEHOLDER[service]
                    }
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                  />
                </div>
              )}
            </div>
            {custom && (
              <>
                <div className="space-y-2">
                  <label
                    className="text-sm font-medium"
                    htmlFor="project-integration-base-url"
                  >
                    Base URL
                  </label>
                  <Input
                    id="project-integration-base-url"
                    placeholder="https://api.example.com/v1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    The application calls{' '}
                    <code>
                      http://api-relay:8080/{route.trim() || 'name'}/…
                    </code>{' '}
                    and the relay sends it to this address. HTTPS only.
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="project-integration-placement"
                    >
                      Token sent as
                    </label>
                    <Select
                      id="project-integration-placement"
                      className="w-full"
                      value={placement}
                      onValueChange={(value) =>
                        setPlacement(value as TokenPlacement)
                      }
                    >
                      {(Object.keys(PLACEMENT_LABELS) as TokenPlacement[]).map(
                        (key) => (
                          <SelectItem key={key} value={key}>
                            {PLACEMENT_LABELS[key]}
                          </SelectItem>
                        ),
                      )}
                    </Select>
                  </div>
                  {placement !== 'bearer' && (
                    <div className="space-y-2">
                      <label
                        className="text-sm font-medium"
                        htmlFor="project-integration-placement-name"
                      >
                        {placement === 'header'
                          ? 'Header name'
                          : placement === 'basic'
                            ? 'User name'
                            : 'Parameter name'}
                      </label>
                      <Input
                        id="project-integration-placement-name"
                        placeholder={
                          placement === 'header'
                            ? 'x-api-key'
                            : placement === 'basic'
                              ? 'api'
                              : 'api_key'
                        }
                        value={placementName}
                        onChange={(e) => setPlacementName(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="project-integration-token"
              >
                Access token
              </label>
              <Input
                id="project-integration-token"
                type="password"
                autoComplete="off"
                placeholder={
                  service === 'gitlab'
                    ? 'Project access token (Reporter, api scope)'
                    : service === 'github'
                      ? 'Fine-grained token for this repository (Issues: write)'
                      : 'The service API token'
                }
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <RulesEditor
              service={service}
              value={rules}
              onChange={setRules}
              idPrefix="project-integration-new"
            />
            <Button
              size="sm"
              disabled={save.isPending || !apiKey.trim()}
              onClick={submit}
            >
              {save.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Save integration
            </Button>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
