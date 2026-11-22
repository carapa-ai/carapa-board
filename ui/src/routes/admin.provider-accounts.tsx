import { useEffect, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchProviderAccounts,
  fetchProviderUsage,
  type ProviderAccountUsage,
  type ProviderCredits,
  type ProviderApiSpend,
  type OpenRouterModelPrice,
  startProviderLogin,
  completeProviderLogin,
  cancelProviderLogin,
  updateProviderAccount,
  removeProviderAccount,
  reorderProviderAccounts,
  type ProviderAccountPatch,
  type ProviderAccountsView,
} from '@/lib/api';
import { FieldTrigger, Select, SelectItem } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RuntimeHarnessIcon } from '@/components/chat/runtime-harness-icon';
import { ArrowDown, ArrowUp, Coins } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { toast } from 'sonner';
import { pollUnlessError } from '@/lib/use-query-load-state';
import { queryKeys } from '@/lib/query-keys';
import { confirmAction } from '@/components/confirm-dialog';

const names: Record<string, string> = {
  anthropic: 'Claude',
  codex: 'Codex / ChatGPT',
  antigravity: 'Antigravity / Google',
  meta: 'Meta / Muse Code',
  xai: 'xAI / Grok Build',
  cursor: 'Cursor',
  'mistral-vibe': 'Mistral Vibe (key)',
  'mistral-eu': 'Mistral API (key)',
  openrouter: 'OpenRouter (key)',
  'anthropic-api': 'Anthropic API (key)',
  'anthropic-admin': 'Anthropic Admin (key)',
  openai: 'OpenAI API (key)',
  google: 'Google Gemini API (key)',
  nvidia: 'NVIDIA API (key)',
  jev: 'Typesafe / Jev (key)',
  gitlab: 'GitLab (token)',
  github: 'GitHub (token)',
};
// Providers connected by pasting an API key instead of signing in.
const keyProviders = new Set([
  'mistral-vibe',
  'mistral-eu',
  'openrouter',
  'anthropic-api',
  'anthropic-admin',
  'openai',
  'google',
  'nvidia',
  'jev',
  'gitlab',
  'github',
]);
const keyHelp: Record<string, string> = {
  'mistral-vibe':
    'Mistral console → Code → Vibe CLI. Billed to the plan’s Vibe Code allowance.',
  'mistral-eu': 'Mistral console → API keys. Billed to the API allowance.',
  openrouter: 'openrouter.ai → Keys. Spends prepaid credits.',
  'anthropic-api':
    'Claude Console → API keys. Billed as API usage, not the subscription.',
  'anthropic-admin':
    'Claude Console → Admin keys. Used only to show the API spend; agents never receive it.',
  openai: 'platform.openai.com → API keys. Billed as OpenAI API usage.',
  google: 'Google AI Studio → API keys. Serves the relay’s /google route.',
  nvidia: 'build.nvidia.com → API key (nvapi-…). Serves the /nvidia route.',
  jev: 'Typesafe console → API key. Serves the relay’s /jev route.',
  gitlab:
    'GitLab → Preferences → Access tokens (read_api). Agents use it through the relay’s /gitlab route; CarapaBox also imports the project’s issues with it.',
  github:
    'GitHub → Settings → Developer settings → Personal access tokens (fine-grained: Issues and Contents read-only). Agents use it through the relay’s /github route; CarapaBox also imports the project’s issues with it.',
};
// Code hosting accounts get their own tab, apart from inference providers.
type Section = 'inference' | 'code';
const codeHostProviders = new Set(['gitlab', 'github']);
// Code hosting accounts name their server; GitHub's usual one is filled in.
const hostField: Record<string, { label: string; placeholder: string }> = {
  gitlab: { label: 'GitLab URL', placeholder: 'https://gitlab.example.com' },
  github: { label: 'GitHub URL', placeholder: 'https://github.com' },
};
const sectionOf = (provider: string): Section =>
  codeHostProviders.has(provider) ? 'code' : 'inference';
const firstProvider: Record<Section, string> = {
  inference: 'codex',
  code: 'gitlab',
};
const icons: Record<string, string> = {
  anthropic: '/harness-icons/anthropic.svg',
  codex: '/harness-icons/codex.svg',
  antigravity: '/harness-icons/antigravity.svg',
  meta: '/harness-icons/meta.svg',
  xai: '/harness-icons/grok.svg',
  cursor: '/harness-icons/cursor.svg',
  'mistral-vibe': '/harness-icons/mistral.svg',
  'mistral-eu': '/harness-icons/mistral.svg',
  openrouter: '/harness-icons/openrouter.svg',
  'anthropic-api': '/harness-icons/anthropic.svg',
  'anthropic-admin': '/harness-icons/anthropic.svg',
  openai: '/harness-icons/codex.svg',
  google: '/harness-icons/antigravity.svg',
  nvidia: '/harness-icons/key.svg',
  jev: '/harness-icons/key.svg',
  gitlab: '/harness-icons/key.svg',
  github: '/harness-icons/key.svg',
};
const states: Record<string, string> = {
  connected: 'Connected',
  refreshPending: 'Waiting for relay refresh',
  loginRequired: 'Login required',
  starting: 'Starting login…',
  waiting: 'Waiting for your approval',
  authorizing: 'Completing login…',
  failed: 'Login failed — cancel and retry',
  expired: 'Login expired — cancel and retry',
};
const selectClass = 'w-full min-w-0';
function Label({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor: string;
}) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium">
      {children}
    </label>
  );
}

export function ProviderAccountsPage() {
  const isAdmin = useAuth((s) => s.user?.role === 'admin');
  const nowMs = useUtcDayTimestamp(isAdmin);
  const queryClient = useQueryClient();
  const [section, setSection] = useState<Section>('inference');
  const [provider, setProvider] = useState(firstProvider.inference);
  const [label, setLabel] = useState('');
  const [client, setClient] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [host, setHost] = useState('');
  const usesKey = keyProviders.has(provider);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The login box renders above the accounts list, often off screen: the
  // login the admin just started or resumed is scrolled into view.
  const [focusLoginId, setFocusLoginId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: queryKeys.admin.providerAccounts,
    queryFn: fetchProviderAccounts,
    enabled: isAdmin,
    refetchInterval: pollUnlessError(3000),
    gcTime: 0,
  });
  // Balances read with a managed key appear on that account's row instead.
  const sharedOpenRouter = query.data?.accounts.some(
    (a) => a.provider === 'openrouter' && a.scope === 'shared',
  );
  // Without a shared admin key, the spend comes from the legacy Compose secret.
  const sharedAdminAccount = query.data?.accounts.some(
    (a) => a.provider === 'anthropic-admin' && a.scope === 'shared',
  );
  // An Anthropic API key and the admin key that reads its spend act as a pair:
  // the admin key is shown inside the API account with the same scope and client
  // instead of as an account of its own.
  const adminFor = (api: ProviderAccountsView['accounts'][number]) =>
    query.data?.accounts.find(
      (a) =>
        a.provider === 'anthropic-admin' &&
        a.scope === api.scope &&
        (a.client ?? '') === (api.client ?? ''),
    );
  const pairedAdminIds = new Set(
    (query.data?.accounts ?? [])
      .filter((a) => a.provider === 'anthropic-api')
      .map((a) => adminFor(a)?.id),
  );
  const visibleAccounts = (query.data?.accounts ?? []).filter(
    (a) => !pairedAdminIds.has(a.id),
  );
  // Project integrations (any service) are listed with the code hosting tokens.
  const sectionAccounts = visibleAccounts.filter(
    (a) => (a.scope === 'project' ? 'code' : sectionOf(a.provider)) === section,
  );
  const switchSection = (next: Section) => {
    setSection(next);
    if (sectionOf(provider) !== next) setProvider(firstProvider[next]);
  };
  // Box needs every account id: a hidden admin key follows its API key.
  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderProviderAccounts(ids),
    onMutate: () =>
      queryClient.cancelQueries({
        queryKey: queryKeys.admin.providerAccounts,
      }),
    onSuccess: (view) =>
      queryClient.setQueryData(queryKeys.admin.providerAccounts, view),
    onError: (error: Error) => {
      toast.error(error.message);
      void refresh();
    },
  });
  // Index and offset are positions in the open tab; the two accounts trade
  // places in the full order, so accounts of the other tab keep theirs.
  const moveAccount = (index: number, offset: -1 | 1) => {
    const order = [...visibleAccounts];
    const from = order.indexOf(sectionAccounts[index]);
    const to = order.indexOf(sectionAccounts[index + offset]);
    [order[from], order[to]] = [order[to], order[from]];
    const ids = new Set<string>();
    for (const account of order) {
      ids.add(account.id);
      if (account.provider === 'anthropic-api') {
        const admin = adminFor(account);
        if (admin) ids.add(admin.id);
      }
    }
    for (const account of query.data?.accounts ?? []) ids.add(account.id);
    reorder.mutate([...ids]);
  };
  const usageQuery = useQuery({
    queryKey: queryKeys.admin.providerUsage,
    queryFn: fetchProviderUsage,
    enabled: isAdmin && !!query.data,
    refetchInterval: 60_000,
    gcTime: 0,
  });
  // Each admin key reports its own spend; older Box versions report only the shared one.
  const spendFor = (admin: ProviderAccountsView['accounts'][number]) =>
    usageQuery.data?.apiSpendByAccount?.[admin.id] ??
    (admin.scope === 'shared' ? usageQuery.data?.apiSpend : undefined);
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.admin.providerAccounts,
    });
  const start = useMutation({
    mutationFn: startProviderLogin,
    onSuccess: (result) => {
      if (result.installed) {
        setApiKey('');
        setExpiresAt('');
        toast.success('Key checked and saved');
      } else setFocusLoginId(result.id);
      return refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  // A key cannot be renewed in place: reconnecting fills the form for a new one.
  const reconnectWithKey = (
    account: ProviderAccountsView['accounts'][number],
  ) => {
    setProvider(account.provider);
    setLabel(account.label);
    setClient(account.client ?? '');
    setApiKey('');
    setExpiresAt('');
    setWorkspaceId(account.workspaceId ?? '');
    setHost(account.host ? `https://${account.host}` : '');
    document.getElementById('provider-api-key')?.focus();
  };
  const showLogin = (id: string) => {
    setFocusLoginId(id);
    document
      .querySelector(`[data-login-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const accountActions = (
    account: ProviderAccountsView['accounts'][number],
  ) => {
    // Box allows one open login per account; resume it instead of starting another.
    const pendingLogin = query.data?.logins.find(
      (login) => login.accountId === account.id,
    );
    // A project key is saved, edited and removed from its project's settings.
    if (account.scope === 'project')
      return (
        <span
          data-ui="provider-account-project-managed"
          className="text-xs text-muted-foreground"
        >
          Managed in Project settings → Integrations
        </span>
      );
    return (
      <>
        <Button
          size="sm"
          variant="outline"
          disabled={start.isPending}
          onClick={() =>
            setEditingId(editingId === account.id ? null : account.id)
          }
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant={account.state === 'loginRequired' ? 'default' : 'outline'}
          disabled={start.isPending}
          onClick={() =>
            keyProviders.has(account.provider)
              ? reconnectWithKey(account)
              : pendingLogin
                ? showLogin(pendingLogin.id)
                : start.mutate({
                    provider: account.provider,
                    label: account.label,
                    scope: account.scope as 'shared' | 'client',
                    accountId: account.id,
                    ...(account.client ? { client: account.client } : {}),
                  })
          }
        >
          {pendingLogin ? 'Continue login' : 'Reconnect'}
        </Button>
      </>
    );
  };
  const usageKey = (
    api: ProviderAccountsView['accounts'][number],
    admin?: ProviderAccountsView['accounts'][number],
  ) =>
    admin && (
      <div
        data-ui="provider-usage-key"
        data-account-id={admin.id}
        className="w-full space-y-2 rounded-md border p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 break-words text-xs text-muted-foreground">
            Usage key · {admin.label} · read-only admin key for API spend
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <KeyStatusBadge account={admin} nowMs={nowMs} />
            <span className="text-xs text-muted-foreground">
              {admin.state === 'loginRequired'
                ? 'Key required'
                : states[admin.state]}
            </span>
            {accountActions(admin)}
          </div>
        </div>
        {editingId === admin.id && (
          <AccountEditForm
            account={admin}
            refresh={refresh}
            onDone={() => setEditingId(null)}
          />
        )}
        {spendFor(admin) && <ApiSpendRow inline spend={spendFor(admin)!} />}
      </div>
    );
  if (!isAdmin) return <div className="p-6">Admin access required.</div>;
  return (
    <div
      className="flex min-w-0 flex-1 flex-col overflow-hidden"
      id="provider-accounts"
    >
      <PageHeader
        title="Provider accounts"
        subtitle="Sign in once. Credentials stay outside agent sandboxes."
      />
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          <p className="text-sm text-muted-foreground">
            You approve sign-in on the provider’s website, or paste an API key
            that CarapaBox checks with the provider. CarapaBox stores the
            credentials and the relay refreshes them independently of Board.
            Existing working credentials remain active until a new login
            succeeds.
          </p>
          {query.isLoading && <p role="status">Loading provider accounts…</p>}
          {query.error && (
            <Card>
              <CardContent className="space-y-3 p-4">
                <p role="alert" className="text-sm text-destructive">
                  {query.error.message}
                </p>
                <Button variant="outline" onClick={() => query.refetch()}>
                  Retry
                </Button>
              </CardContent>
            </Card>
          )}
          {query.data && (
            <Tabs
              id="provider-account-sections"
              value={section}
              onValueChange={(value) => switchSection(value as Section)}
            >
              <TabsList>
                <TabsTrigger
                  value="inference"
                  data-ui="provider-account-section"
                  data-section="inference"
                >
                  Inference providers
                </TabsTrigger>
                <TabsTrigger
                  value="code"
                  data-ui="provider-account-section"
                  data-section="code"
                >
                  Code hosting
                </TabsTrigger>
              </TabsList>
              <TabsContent value={section} className="mt-4 space-y-4">
                <Card data-ui="provider-account-connect">
                  <CardContent className="space-y-4 p-4">
                    <CardTitle className="text-base">
                      Connect an account
                    </CardTitle>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="provider-name">Provider</Label>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <FieldTrigger
                              id="provider-name"
                              className={selectClass}
                            >
                              <RuntimeHarnessIcon
                                icon={icons[provider]}
                                className="size-4 shrink-0"
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {names[provider]}
                              </span>
                            </FieldTrigger>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="start"
                            className="w-(--radix-dropdown-menu-trigger-width)"
                          >
                            {Object.entries(names)
                              .filter(([key]) => sectionOf(key) === section)
                              .map(([key, name]) => (
                                <DropdownMenuItem
                                  key={key}
                                  data-ui="provider-option"
                                  data-provider={key}
                                  onSelect={() => {
                                    setProvider(key);
                                    if (key === 'github' && !host.trim())
                                      setHost('https://github.com');
                                  }}
                                >
                                  <RuntimeHarnessIcon
                                    icon={icons[key]}
                                    className="size-4 shrink-0"
                                  />
                                  {name}
                                </DropdownMenuItem>
                              ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="provider-label">Account label</Label>
                        <Input
                          id="provider-label"
                          value={label}
                          maxLength={80}
                          placeholder="My subscription"
                          onChange={(e) => setLabel(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="provider-scope">Use for</Label>
                      <Select
                        id="provider-scope"
                        className={selectClass}
                        value={client}
                        onValueChange={(nextValue) => setClient(nextValue)}
                      >
                        <SelectItem value="">Shared default</SelectItem>
                        {query.data.clients.map((c) => (
                          <SelectItem key={c.name} value={c.name}>
                            {c.name} —{' '}
                            {c.isolation === 'strict'
                              ? 'strict isolation'
                              : 'client-specific credentials'}
                          </SelectItem>
                        ))}
                      </Select>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {usesKey
                        ? 'Saving a key replaces this provider’s key for the selected scope.'
                        : 'Connecting adds an account; use Reconnect on an account to sign it in again. Several accounts of one provider for the same scope share the work: a conversation stays on one account, new conversations use the account whose usage resets soonest, and a conversation moves to another account only when its own reaches 100%.'}{' '}
                      Explicit client routes take precedence over shared
                      defaults. Full isolation also requires a strict relay
                      client and separate sandbox mounts.
                    </p>
                    {usesKey && (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor="provider-api-key">
                            {section === 'code' ? 'Access token' : 'API key'}
                          </Label>
                          <Input
                            id="provider-api-key"
                            type="password"
                            autoComplete="off"
                            value={apiKey}
                            maxLength={4096}
                            onChange={(e) => setApiKey(e.target.value)}
                          />
                          <p className="text-xs text-muted-foreground">
                            {keyHelp[provider]}
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="provider-expires-at">
                            Key expires on (optional)
                          </Label>
                          <Input
                            id="provider-expires-at"
                            type="date"
                            value={expiresAt}
                            onChange={(e) => setExpiresAt(e.target.value)}
                          />
                        </div>
                      </>
                    )}
                    {codeHostProviders.has(provider) && (
                      <div className="space-y-2">
                        <Label htmlFor="provider-host">
                          {hostField[provider].label}
                        </Label>
                        <Input
                          id="provider-host"
                          value={host}
                          maxLength={260}
                          placeholder={hostField[provider].placeholder}
                          onChange={(e) => setHost(e.target.value)}
                        />
                      </div>
                    )}
                    {provider === 'anthropic-api' && (
                      <div className="space-y-2">
                        <Label htmlFor="provider-workspace">
                          Workspace ID (if the key is not scoped to one)
                        </Label>
                        <Input
                          id="provider-workspace"
                          value={workspaceId}
                          maxLength={71}
                          placeholder="wrkspc_…"
                          onChange={(e) => setWorkspaceId(e.target.value)}
                        />
                      </div>
                    )}
                    {provider === 'antigravity' && (
                      <p className="text-xs text-muted-foreground">
                        Antigravity agents must use the relay’s /antigravity
                        endpoint with a dummy API key. Google sign-in may
                        redirect to an unavailable localhost page; paste that
                        final URL below to complete login.
                      </p>
                    )}
                    <Button
                      disabled={
                        !label.trim() ||
                        (usesKey && !apiKey.trim()) ||
                        (codeHostProviders.has(provider) && !host.trim()) ||
                        start.isPending
                      }
                      onClick={() => {
                        start.mutate({
                          provider,
                          label,
                          scope: client ? 'client' : 'shared',
                          ...(client ? { client } : {}),
                          ...(usesKey ? { apiKey: apiKey.trim() } : {}),
                          ...(usesKey && expiresAt ? { expiresAt } : {}),
                          ...(codeHostProviders.has(provider)
                            ? { host: host.trim() }
                            : {}),
                          ...(provider === 'anthropic-api' && workspaceId.trim()
                            ? { workspaceId: workspaceId.trim() }
                            : {}),
                        });
                      }}
                    >
                      {start.isPending
                        ? usesKey
                          ? 'Checking key…'
                          : 'Starting…'
                        : usesKey
                          ? 'Save key'
                          : 'Connect'}
                    </Button>
                  </CardContent>
                </Card>
                {query.data.logins
                  .filter((login) => sectionOf(login.provider) === section)
                  .map((login) => (
                    <LoginCard
                      key={login.id}
                      login={login}
                      refresh={refresh}
                      focused={login.id === focusLoginId}
                    />
                  ))}
                <Card>
                  <CardContent className="space-y-4 p-4">
                    <CardTitle className="text-base">
                      Managed accounts
                    </CardTitle>
                    {!sectionAccounts.length && (
                      <p className="text-sm text-muted-foreground">
                        No managed accounts yet. Existing manually configured
                        relay credentials are unchanged.
                      </p>
                    )}
                    {sectionAccounts.map((account, index) => (
                      <div
                        key={account.id}
                        data-ui="provider-account"
                        data-account-id={account.id}
                        className="flex flex-wrap items-center justify-between gap-2 border-t pt-3"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <RuntimeHarnessIcon
                            icon={icons[account.provider]}
                            className="size-6 shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <p className="min-w-0 break-words text-sm font-medium">
                                {account.label}
                                {(account.tier ||
                                  account.capacity !== undefined) && (
                                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                                    {[
                                      account.tier,
                                      account.capacity !== undefined &&
                                        `capacity ${account.capacity}`,
                                    ]
                                      .filter(Boolean)
                                      .join(' · ')}
                                  </span>
                                )}
                              </p>
                              <KeyStatusBadge account={account} nowMs={nowMs} />
                            </div>
                            <p className="break-words text-xs text-muted-foreground">
                              {names[account.provider] ?? 'Service integration'}{' '}
                              ·{' '}
                              {account.scope === 'shared'
                                ? 'Shared default'
                                : account.scope === 'project'
                                  ? `Project ${account.project?.stack}/${account.project?.instance}${account.route ? ` · /${account.route}` : ''}`
                                  : account.client}
                            </p>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                          <div className="flex items-center">
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              data-ui="provider-account-move-up"
                              aria-label={`Move ${account.label} up`}
                              disabled={index === 0 || reorder.isPending}
                              onClick={() => moveAccount(index, -1)}
                            >
                              <ArrowUp />
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              data-ui="provider-account-move-down"
                              aria-label={`Move ${account.label} down`}
                              disabled={
                                index === sectionAccounts.length - 1 ||
                                reorder.isPending
                              }
                              onClick={() => moveAccount(index, 1)}
                            >
                              <ArrowDown />
                            </Button>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {keyProviders.has(account.provider) &&
                            account.state === 'loginRequired'
                              ? 'Key required'
                              : states[account.state]}
                          </span>
                          {accountActions(account)}
                        </div>
                        {editingId === account.id && (
                          <AccountEditForm
                            account={account}
                            refresh={refresh}
                            onDone={() => setEditingId(null)}
                          />
                        )}
                        <UsageBars
                          usage={usageQuery.data?.usage[account.id]}
                          loading={usageQuery.isLoading}
                          capacity={account.capacity}
                          windowFilter={mistralWindowFilter(account.provider)}
                        />
                        {account.provider === 'openrouter' &&
                          account.scope === 'shared' &&
                          usageQuery.data?.credits && (
                            <CreditsRow
                              inline
                              credits={usageQuery.data.credits}
                              models={usageQuery.data.openRouterModels}
                            />
                          )}
                        {account.provider === 'anthropic-admin' &&
                          spendFor(account) && (
                            <ApiSpendRow inline spend={spendFor(account)!} />
                          )}
                        {account.provider === 'anthropic-api' &&
                          usageKey(account, adminFor(account))}
                      </div>
                    ))}
                    {section === 'inference' &&
                      usageQuery.data?.credits &&
                      !sharedOpenRouter && (
                        <CreditsRow
                          credits={usageQuery.data.credits}
                          models={usageQuery.data.openRouterModels}
                        />
                      )}
                    {section === 'inference' &&
                      usageQuery.data?.apiSpend &&
                      !sharedAdminAccount && (
                        <ApiSpendRow spend={usageQuery.data.apiSpend} />
                      )}
                    {section === 'inference' &&
                      usageQuery.data?.mistralBudget && (
                        <MistralBudgetRow
                          budget={usageQuery.data.mistralBudget}
                        />
                      )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </div>
  );
}

function resetsIn(at?: number) {
  if (!at) return '';
  const minutes = Math.max(0, Math.round((at - Date.now()) / 60_000));
  if (minutes < 60) return `resets in ${minutes}m`;
  if (minutes < 2880)
    return `resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `resets in ${Math.round(minutes / 1440)}d`;
}

// A Mistral account bills one allowance only: the Vibe key the Vibe Code
// window, the API key the API window. Billing reports both for either key.
function mistralWindowFilter(provider: string) {
  if (provider === 'mistral-vibe')
    return (label: string) => /vibe/i.test(label);
  if (provider === 'mistral-eu') return (label: string) => !/vibe/i.test(label);
  return undefined;
}

function remainingOf(capacity: number, usedPercent: number) {
  return Math.round((capacity * (100 - usedPercent)) / 100);
}

const MS_PER_DAY = 86_400_000;

function useUtcDayTimestamp(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const syncNow = () => {
      const next = Date.now();
      setNowMs((prev) =>
        Math.floor(prev / MS_PER_DAY) === Math.floor(next / MS_PER_DAY)
          ? prev
          : next,
      );
      return next;
    };
    const schedule = (now: number) => {
      clearTimeout(timer);
      const nextMidnight = (Math.floor(now / MS_PER_DAY) + 1) * MS_PER_DAY;
      const delay = Math.max(100, nextMidnight - now + 50);
      timer = setTimeout(() => {
        schedule(syncNow());
      }, delay);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') schedule(syncNow());
    };
    schedule(syncNow());
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);
  return nowMs;
}

function parseUtcDate(
  value: string | undefined,
): { year: number; month: number; day: number; dateStr: string } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day, dateStr: value };
}

function KeyStatusBadge({
  account,
  nowMs,
}: {
  account: ProviderAccountsView['accounts'][number];
  nowMs: number;
}) {
  if (!keyProviders.has(account.provider)) return null;
  const parsed = parseUtcDate(account.expiresAt);
  const rejected = account.keyCheck === 'rejected';
  if (!rejected && !parsed) return null;

  const endOfDayMs = parsed
    ? Date.UTC(parsed.year, parsed.month - 1, parsed.day + 1)
    : 0;
  const remainingMs = parsed ? endOfDayMs - nowMs : 0;
  const isExpired = parsed !== null && remainingMs <= 0;
  const daysLeft =
    parsed && !isExpired ? Math.floor(remainingMs / MS_PER_DAY) : 0;

  let text: string;
  let tone: 'neutral' | 'warning' | 'destructive';
  let status: 'rejected' | 'expired' | 'expiring' | 'valid';
  if (rejected) {
    text = 'Key rejected';
    tone = 'destructive';
    status = 'rejected';
  } else if (isExpired) {
    text = 'Expired';
    tone = 'destructive';
    status = 'expired';
  } else if (daysLeft === 0) {
    text = 'Expires today';
    tone = 'destructive';
    status = 'expiring';
  } else {
    text = daysLeft === 1 ? 'Expires in 1 day' : `Expires in ${daysLeft} days`;
    tone =
      daysLeft <= 3 ? 'destructive' : daysLeft <= 14 ? 'warning' : 'neutral';
    status = daysLeft <= 14 ? 'expiring' : 'valid';
  }

  const tooltipParts: string[] = [];
  if (rejected) tooltipParts.push('Key rejected');
  if (parsed) {
    const sourceText =
      account.expirySource === 'provider'
        ? 'reported by the provider'
        : account.expirySource === 'manual'
          ? 'set manually'
          : null;
    const prefix = isExpired ? 'Expired' : 'Expires';
    tooltipParts.push(
      sourceText
        ? `${prefix} ${parsed.dateStr} UTC (${sourceText})`
        : `${prefix} ${parsed.dateStr} UTC`,
    );
  }
  if (
    typeof account.keyCheckedAt === 'number' &&
    Number.isFinite(account.keyCheckedAt)
  ) {
    tooltipParts.push(
      `Last checked ${new Date(account.keyCheckedAt).toLocaleString()}`,
    );
  }
  const tooltip = tooltipParts.join(' · ');

  const variant =
    tone === 'destructive'
      ? 'destructive'
      : tone === 'warning'
        ? 'outline'
        : 'secondary';
  const className =
    tone === 'warning'
      ? 'border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300'
      : undefined;

  return (
    <Tooltip content={tooltip} redundant={false}>
      <Badge
        variant={variant}
        data-ui="provider-account-key-status"
        data-account-id={account.id}
        data-status={status}
        data-tone={tone}
        className={className}
      >
        {text}
      </Badge>
    </Tooltip>
  );
}

function AccountEditForm({
  account,
  refresh,
  onDone,
}: {
  account: ProviderAccountsView['accounts'][number];
  refresh: () => Promise<unknown>;
  onDone: () => void;
}) {
  // Tier and capacity compare inference accounts; code hosting has neither.
  const estimates = sectionOf(account.provider) === 'inference';
  const isKey = keyProviders.has(account.provider);
  const providerReportedExpiry = account.expirySource === 'provider';
  const initialExpiresAt =
    account.expirySource === 'manual' ? (account.expiresAt ?? '') : '';
  const [label, setLabel] = useState(account.label);
  const [tier, setTier] = useState(account.tier ?? '');
  const [capacity, setCapacity] = useState(
    account.capacity === undefined ? '' : String(account.capacity),
  );
  const [expiresAt, setExpiresAt] = useState(initialExpiresAt);
  const update = useMutation({
    mutationFn: (input: ProviderAccountPatch) =>
      updateProviderAccount(account.id, input),
    onSuccess: () => {
      void refresh();
      onDone();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: () => removeProviderAccount(account.id),
    onSuccess: () => {
      toast.success('Account removed');
      void refresh();
      onDone();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const trimmedLabel = label.trim();
  const trimmedTier = tier.trim();
  const capacityValue = capacity.trim() === '' ? null : Number(capacity);
  const valid =
    trimmedLabel.length >= 1 &&
    trimmedLabel.length <= 80 &&
    trimmedTier.length <= 40 &&
    (capacityValue === null ||
      (Number.isInteger(capacityValue) &&
        capacityValue >= 1 &&
        capacityValue <= 1000));
  const save = () => {
    // Send only the fields the admin changed; an empty tier, capacity, or expiry clears it.
    const input: ProviderAccountPatch = {};
    if (trimmedLabel !== account.label) input.label = trimmedLabel;
    if (trimmedTier !== (account.tier ?? ''))
      input.tier = trimmedTier === '' ? null : trimmedTier;
    if (capacityValue !== (account.capacity ?? null))
      input.capacity = capacityValue;
    if (isKey && !providerReportedExpiry && expiresAt !== initialExpiresAt)
      input.expiresAt = expiresAt === '' ? null : expiresAt;
    if (!Object.keys(input).length) return onDone();
    update.mutate(input);
  };
  return (
    <form
      data-ui="provider-account-edit"
      data-account-id={account.id}
      className="w-full space-y-3 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !update.isPending) save();
      }}
    >
      <div
        className={cn(
          'grid gap-3',
          estimates ? 'sm:grid-cols-3' : isKey && 'sm:grid-cols-2',
        )}
      >
        <div className="space-y-2">
          <Label htmlFor={'account-label-' + account.id}>Label</Label>
          <Input
            id={'account-label-' + account.id}
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        {estimates && (
          <>
            <div className="space-y-2">
              <Label htmlFor={'account-tier-' + account.id}>Tier</Label>
              <Input
                id={'account-tier-' + account.id}
                value={tier}
                maxLength={40}
                placeholder="e.g. Max 20x"
                onChange={(e) => setTier(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={'account-capacity-' + account.id}>Capacity</Label>
              <Input
                id={'account-capacity-' + account.id}
                type="number"
                min={1}
                max={1000}
                step={1}
                value={capacity}
                placeholder="Unknown"
                onChange={(e) => setCapacity(e.target.value)}
              />
            </div>
          </>
        )}
        {isKey && (
          <div className="space-y-2">
            <Label htmlFor={'account-expires-at-' + account.id}>
              Key expires on (optional)
            </Label>
            <Input
              id={'account-expires-at-' + account.id}
              type="date"
              disabled={providerReportedExpiry}
              aria-describedby={
                providerReportedExpiry
                  ? 'account-expires-hint-' + account.id
                  : undefined
              }
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            {providerReportedExpiry && (
              <p
                id={'account-expires-hint-' + account.id}
                className="text-xs text-muted-foreground"
              >
                Reported by the provider
              </p>
            )}
          </div>
        )}
      </div>
      {estimates && (
        <p className="text-xs text-muted-foreground">
          Capacity is a relative estimate, not a quota: Claude Max 20x ≈ 1000,
          Claude Pro ≈ 100, free tier ≈ 1. Clear a field to remove its value.
        </p>
      )}
      {update.error && (
        <p
          role="alert"
          className="whitespace-pre-line text-sm text-destructive"
        >
          {update.error.message}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="destructive"
          className="mr-auto"
          data-ui="provider-account-remove"
          disabled={remove.isPending || update.isPending}
          onClick={async () => {
            const confirmed = await confirmAction(
              'Its saved sign-in or key is deleted from this installation. Agents stop using it; another account of the same provider takes over if there is one. The account itself is not closed at the provider.',
              {
                title: `Remove account “${account.label}”?`,
                confirmLabel: 'Remove account',
                destructive: true,
              },
            );
            if (confirmed) remove.mutate();
          }}
        >
          {remove.isPending ? 'Removing…' : 'Remove account'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

const dollars = (amount: number) => `$${amount.toFixed(2)}`;
// Cheap models cost cents or less per million tokens, so keep enough digits to tell them apart.
const tokenPrice = (amount: number) =>
  `$${amount < 0.1 ? amount.toPrecision(2) : amount.toFixed(2)}`;

// OpenRouter is prepaid credits, not a sign-in: there is no reset, so the bar
// shows how much of the purchased balance is spent.
function CreditsRow({
  credits,
  models,
  inline,
}: {
  credits: ProviderCredits;
  models?: OpenRouterModelPrice[];
  /** Shown inside the OpenRouter account's own row, which already names it. */
  inline?: boolean;
}) {
  const usedPercent =
    credits.totalCredits > 0
      ? Math.min(
          100,
          Math.max(0, (credits.totalUsage / credits.totalCredits) * 100),
        )
      : 100;
  return (
    <div
      data-ui="provider-credits"
      data-provider={credits.provider}
      className={
        'flex flex-wrap items-center justify-between gap-2' +
        (inline ? ' w-full' : ' border-t pt-3')
      }
    >
      {inline ? (
        <span className="text-xs text-muted-foreground">Prepaid credits</span>
      ) : (
        <div className="flex min-w-0 items-center gap-3">
          <Coins aria-hidden="true" className="size-6 shrink-0" />
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">OpenRouter</p>
            <p className="break-words text-xs text-muted-foreground">
              Prepaid credits · key from the relay’s secret file
            </p>
          </div>
        </div>
      )}
      <span className="text-sm font-medium">
        {dollars(credits.remaining)} left
      </span>
      <div className="w-full space-y-1">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {dollars(credits.totalUsage)} used of{' '}
            {dollars(credits.totalCredits)}
          </span>
          <span>no reset</span>
        </div>
        <div
          role="progressbar"
          aria-label="OpenRouter credits used"
          aria-valuenow={Math.round(usedPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1.5 overflow-hidden rounded bg-muted"
        >
          <div
            className={
              'h-full ' +
              (usedPercent >= 90
                ? 'bg-destructive'
                : usedPercent >= 70
                  ? 'bg-yellow-600 dark:bg-yellow-500'
                  : 'bg-primary')
            }
            style={{ width: `${usedPercent}%` }}
          />
        </div>
      </div>
      {!!models?.length && (
        <details data-ui="provider-model-prices" className="w-full text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Model prices ({models.length}) · per million tokens
          </summary>
          <ul className="mt-2 space-y-1">
            {models.map((m) => (
              <li
                key={m.model}
                data-model={m.model}
                className="flex flex-wrap justify-between gap-x-3"
              >
                <span className="min-w-0 break-words">{m.name}</span>
                <span className="text-muted-foreground">
                  {m.inputPerMillion === 0 && m.outputPerMillion === 0
                    ? 'free'
                    : `${tokenPrice(m.inputPerMillion)} in · ${tokenPrice(m.outputPerMillion)} out`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// Anthropic API credits: the cost report gives spend only, never the balance.
function ApiSpendRow({
  spend,
  inline,
}: {
  spend: ProviderApiSpend;
  /** Shown inside the Anthropic Admin account's row: its key reads the spend. */
  inline?: boolean;
}) {
  const models = Object.entries(spend.models).sort(([, a], [, b]) => b - a);
  const since = new Date(spend.periodStart).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return (
    <div
      data-ui="provider-api-spend"
      data-provider={spend.provider}
      className={
        'flex flex-wrap items-center justify-between gap-2' +
        (inline ? ' w-full' : ' border-t pt-3')
      }
    >
      {inline ? (
        <span className="text-xs text-muted-foreground">
          Anthropic API spend
        </span>
      ) : (
        <div className="flex min-w-0 items-center gap-3">
          <Coins aria-hidden="true" className="size-6 shrink-0" />
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">Anthropic API</p>
            <p className="break-words text-xs text-muted-foreground">
              API credits · admin key from the relay’s secret file
            </p>
          </div>
        </div>
      )}
      <span className="text-sm font-medium">
        {dollars(spend.spent)} spent this month
      </span>
      <p className="w-full text-xs text-muted-foreground">
        Since {since} (UTC), whole organization · remaining balance is shown
        only in the Anthropic Console
      </p>
      {!!models.length && (
        <details data-ui="provider-api-spend-models" className="w-full text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            By model ({models.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {models.map(([model, amount]) => (
              <li
                key={model}
                data-model={model}
                className="flex flex-wrap justify-between gap-x-3"
              >
                <span className="min-w-0 break-words">{model}</span>
                <span className="text-muted-foreground">{dollars(amount)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// Mistral's API and Vibe Code allowances, read by Box from Mistral billing.
function MistralBudgetRow({ budget }: { budget: ProviderAccountUsage }) {
  return (
    <div
      data-ui="provider-mistral-budget"
      className="flex flex-wrap items-center justify-between gap-2 border-t pt-3"
    >
      <div className="flex min-w-0 items-center gap-3">
        <RuntimeHarnessIcon
          icon="/harness-icons/mistral.svg"
          className="size-6 shrink-0"
        />
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">Mistral plan</p>
          <p className="break-words text-xs text-muted-foreground">
            Monthly included usage · read from Mistral billing
          </p>
        </div>
      </div>
      <UsageBars usage={budget} loading={false} />
    </div>
  );
}

function UsageBars({
  usage,
  loading,
  capacity,
  windowFilter,
}: {
  usage?: ProviderAccountUsage;
  loading: boolean;
  capacity?: number;
  windowFilter?: (label: string) => boolean;
}) {
  if (!usage)
    return loading ? (
      <p className="w-full text-xs text-muted-foreground">Loading usage…</p>
    ) : null;
  if ('error' in usage)
    return (
      <p className="w-full text-xs text-muted-foreground">
        Usage unavailable: {usage.error}
      </p>
    );
  return (
    <div className="w-full space-y-2" data-ui="provider-usage">
      {usage.resets && (
        <p
          className="text-xs text-muted-foreground"
          data-ui="provider-usage-resets"
        >
          {usage.resets.available} limit{' '}
          {usage.resets.available === 1 ? 'reset' : 'resets'} available
          {usage.resets.expiresAt
            ? ` · ${usage.resets.available === 1 ? 'expires' : 'first expires'} ${new Date(usage.resets.expiresAt).toLocaleDateString()}`
            : ''}
        </p>
      )}
      {(windowFilter
        ? usage.windows.filter((w) => windowFilter(w.label))
        : usage.windows
      ).map((w) => (
        <div key={w.label} className="space-y-1" title={w.models?.join(', ')}>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>
              {w.label} · {Math.round(w.usedPercent)}% used
              {capacity !== undefined && (
                <>
                  {' '}
                  · ≈ {remainingOf(capacity, w.usedPercent)} of {capacity} left
                </>
              )}
            </span>
            <span>{resetsIn(w.resetsAt)}</span>
          </div>
          <div
            role="progressbar"
            aria-label={`${w.label} usage`}
            aria-valuenow={Math.round(w.usedPercent)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 overflow-hidden rounded bg-muted"
          >
            <div
              className={
                'h-full ' +
                (w.usedPercent >= 90
                  ? 'bg-destructive'
                  : w.usedPercent >= 70
                    ? 'bg-yellow-600 dark:bg-yellow-500'
                    : 'bg-primary')
              }
              style={{ width: `${w.usedPercent}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function LoginCard({
  login,
  refresh,
  focused,
}: {
  login: ProviderAccountsView['logins'][number];
  refresh: () => Promise<unknown>;
  focused: boolean;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused)
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focused]);
  const expires = new Date(login.expiresAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const complete = useMutation({
    mutationFn: () => completeProviderLogin(login.id, value.trim()),
    onSuccess: () => {
      setValue('');
      void refresh();
    },
    onError: () => {
      setValue('');
      toast.error(
        'Login response was not accepted. Check the code or callback URL.',
      );
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelProviderLogin(login.id),
    onSuccess: refresh,
    onError: () => toast.error('Unable to cancel login'),
  });
  return (
    <Card
      ref={ref}
      data-ui="provider-login"
      data-login-id={login.id}
      className={focused ? 'border-primary' : undefined}
    >
      <CardContent className="space-y-3 p-4">
        <CardTitle className="break-words text-base">
          Sign in to {names[login.provider] || login.provider}: {login.label}
        </CardTitle>
        <p role="status" className="text-sm text-muted-foreground">
          {states[login.state] || login.state}
        </p>
        {login.state === 'waiting' && (
          <>
            <ol
              data-ui="provider-login-steps"
              className="list-decimal space-y-1 pl-5 text-sm"
            >
              {login.authorizationUrl && (
                <li>
                  Click <strong>Open provider sign-in</strong>. The sign-in page
                  opens in a new tab.
                </li>
              )}
              <li>Sign in there and approve access.</li>
              {login.userCode && (
                <li>When the page asks for a code, enter the code below.</li>
              )}
              {login.input === 'code' && (
                <li>
                  The page then shows an authorization code. Copy it, paste it
                  into the field below, and click{' '}
                  <strong>Complete login</strong>.
                </li>
              )}
              {login.input === 'callback' && (
                <li>
                  The last page does not load and its address starts with{' '}
                  <code className="font-mono">http://localhost</code>. Copy the
                  whole address from the address bar, paste it into the field
                  below, and click <strong>Complete login</strong>.
                </li>
              )}
              {login.input === 'none' && (
                <li>This box updates by itself once you have approved.</li>
              )}
            </ol>
            <p className="text-xs text-muted-foreground">
              This login expires at {expires}.
            </p>
            {login.authorizationUrl && (
              <Button asChild variant="outline">
                <a
                  href={login.authorizationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open provider sign-in
                </a>
              </Button>
            )}
            {login.userCode && (
              <p className="text-sm">
                Verification code:{' '}
                <code className="font-mono">{login.userCode}</code>
              </p>
            )}
            {login.input !== 'none' && (
              <div className="space-y-2">
                <Label htmlFor={'response-' + login.id}>
                  {login.input === 'callback'
                    ? 'Final localhost callback URL'
                    : 'Authorization code from provider'}
                </Label>
                <Input
                  id={'response-' + login.id}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
                <Button
                  disabled={!value.trim() || complete.isPending}
                  onClick={() => complete.mutate()}
                >
                  Complete login
                </Button>
              </div>
            )}
          </>
        )}
        <Button
          variant="ghost"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          Cancel login
        </Button>
      </CardContent>
    </Card>
  );
}

export const Route = createFileRoute('/admin/provider-accounts')({
  component: ProviderAccountsPage,
});
