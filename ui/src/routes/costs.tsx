import { useMemo, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChartNoAxesCombined, Loader2 } from 'lucide-react';
import { Select, SelectItem } from '@/components/ui/select';
import { fetchRunCostReport, type UncostedRunReason } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useProjects } from '@/hooks/use-projects';
import { ProjectPicker } from '@/components/layout/project-picker';

const PROVIDERS = ['OpenAI', 'Anthropic', 'Gemini', 'Other'] as const;

const UNCOSTED_REASON_LABELS: Record<UncostedRunReason, string> = {
  running: 'Still running',
  no_model: 'No model recorded',
  pricing_file_missing: 'Pricing file missing or not USD',
  model_not_priced: 'Model not in pricing file',
  no_usage_telemetry: 'No token usage recorded (run stalled/errored)',
  other: 'Other (tokens recorded but no cost)',
};

function usd(value: number): string {
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function CostReportPage() {
  const isAdmin = useAuth((state) => state.user?.role === 'admin');
  const [days, setDays] = useState(30);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [runType, setRunType] = useState<'chat' | 'task' | 'event' | null>(
    null,
  );
  const { data: projects = [] } = useProjects();
  const { data, isLoading, error } = useQuery({
    queryKey: ['reports', 'run-costs', days, projectId, runType],
    queryFn: () => fetchRunCostReport(days, projectId, runType),
    enabled: isAdmin,
  });

  const rows = useMemo(() => {
    const dates = data?.coverage.map((row) => row.date) ?? [];
    return dates.map((date) => {
      const entries = data?.daily.filter((row) => row.date === date) ?? [];
      const coverage = data?.coverage.find((row) => row.date === date);
      return {
        date,
        entries,
        total: entries.reduce((sum, row) => sum + row.costUsd, 0),
        runs: coverage?.totalRuns ?? 0,
        costedRuns: coverage?.costedRuns ?? 0,
        uncostedRuns: coverage?.uncostedRuns ?? 0,
      };
    });
  }, [data]);

  const uncosted = data?.uncosted ?? [];

  if (!isAdmin) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="API Cost Report" />
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          Administrator access is required.
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="API Cost Report" />
      <div className="flex-1 overflow-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-semibold">
                <ChartNoAxesCombined className="size-6 text-primary" />
                Daily run costs
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                API-equivalent cost of all recorded runs, grouped in your local
                timezone.
              </p>
            </div>
            <div className="flex flex-wrap items-end justify-end gap-2">
              <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                <span>Project</span>
                <ProjectPicker
                  projects={projects}
                  value={projectId ?? ''}
                  onValueChange={(value) => setProjectId(value || null)}
                  emptyOption={{ label: 'All projects', value: '' }}
                  className="min-w-56"
                  aria-label="Filter by project"
                />
              </div>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Type
                <Select
                  className="min-w-40"
                  value={runType ?? ''}
                  onValueChange={(nextValue) => {
                    const value = nextValue;
                    setRunType(
                      value === 'chat' || value === 'task' || value === 'event'
                        ? value
                        : null,
                    );
                  }}
                >
                  <SelectItem value="">All types</SelectItem>
                  <SelectItem value="chat">Chat</SelectItem>
                  <SelectItem value="task">Task</SelectItem>
                  <SelectItem value="event">Event processing</SelectItem>
                </Select>
              </label>
              <div className="flex gap-1">
                {[7, 30, 90, 365].map((option) => (
                  <Button
                    key={option}
                    variant={days === option ? 'default' : 'outline'}
                    onClick={() => setDays(option)}
                  >
                    {option === 365 ? '1 year' : `${option} days`}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          {isLoading ? (
            <div className="flex h-48 items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <Card>
              <CardContent className="p-6 text-destructive">
                {error instanceof Error
                  ? error.message
                  : 'Failed to load cost report'}
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Card>
                  <CardContent className="p-5">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      API-equivalent cost
                    </div>
                    <div className="mt-1 text-3xl font-semibold text-emerald-700 dark:text-emerald-400">
                      {usd(data?.totalCostUsd ?? 0)}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-5">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Costed runs
                    </div>
                    <div className="mt-1 text-3xl font-semibold">
                      {(data?.totalRuns ?? 0).toLocaleString()}
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Card className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3">Day</th>
                        {PROVIDERS.map((provider) => (
                          <th key={provider} className="px-4 py-3 text-right">
                            {provider}
                          </th>
                        ))}
                        <th className="px-4 py-3 text-right">Total</th>
                        <th className="px-4 py-3 text-right">Runs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.date} className="border-b last:border-0">
                          <td className="whitespace-nowrap px-4 py-3 font-medium">
                            {new Date(
                              `${row.date}T12:00:00`,
                            ).toLocaleDateString(undefined, {
                              weekday: 'short',
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                            })}
                          </td>
                          {PROVIDERS.map((provider) => {
                            const entry = row.entries.find(
                              (item) => item.provider === provider,
                            );
                            return (
                              <td
                                key={provider}
                                className="px-4 py-3 text-right tabular-nums"
                                title={entry?.models.join(', ')}
                              >
                                {entry ? usd(entry.costUsd) : '—'}
                                {entry && (
                                  <div className="text-[11px] text-muted-foreground">
                                    {entry.runCount} run
                                    {entry.runCount === 1 ? '' : 's'}
                                  </div>
                                )}
                              </td>
                            );
                          })}
                          <td className="px-4 py-3 text-right font-semibold tabular-nums">
                            {usd(row.total)}
                          </td>
                          <td
                            className="px-4 py-3 text-right tabular-nums"
                            title={
                              row.uncostedRuns > 0
                                ? `${row.costedRuns} priced, ${row.uncostedRuns} without cost telemetry`
                                : `${row.costedRuns} priced`
                            }
                          >
                            {row.runs}
                            {row.uncostedRuns > 0 && (
                              <div className="text-[11px] text-amber-700 dark:text-amber-400">
                                {row.uncostedRuns} unpriced
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                      {rows.length === 0 && (
                        <tr>
                          <td
                            colSpan={7}
                            className="px-4 py-12 text-center text-muted-foreground"
                          >
                            No costed runs in this period.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
              {uncosted.length > 0 && (
                <Card className="overflow-hidden" data-ui="costs-unpriced-runs">
                  <div className="border-b px-4 py-3 text-sm font-medium">
                    Unpriced runs
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] text-sm">
                      <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-4 py-3">Day</th>
                          <th className="px-4 py-3 text-right">Runs</th>
                          <th className="px-4 py-3">Source</th>
                          <th className="px-4 py-3">Agent / model</th>
                          <th className="px-4 py-3">Stage</th>
                          <th className="px-4 py-3">Status</th>
                          <th className="px-4 py-3">Reason</th>
                          <th className="px-4 py-3">Examples</th>
                        </tr>
                      </thead>
                      <tbody>
                        {uncosted.map((group, index) => (
                          <tr
                            key={`${group.date}-${index}`}
                            className="border-b align-top last:border-0"
                            data-ui="costs-unpriced-run-group"
                          >
                            <td className="whitespace-nowrap px-4 py-3">
                              {group.date}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {group.count}
                            </td>
                            <td className="px-4 py-3 capitalize">
                              {group.source}
                            </td>
                            <td className="px-4 py-3">
                              {group.agentName ?? '—'}
                              <div className="text-[11px] text-muted-foreground">
                                {group.model ?? 'no model'}
                              </div>
                            </td>
                            <td className="px-4 py-3">{group.stage ?? '—'}</td>
                            <td className="px-4 py-3">{group.status ?? '—'}</td>
                            <td className="px-4 py-3 text-amber-700 dark:text-amber-400">
                              {UNCOSTED_REASON_LABELS[group.reason] ??
                                group.reason}
                            </td>
                            <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
                              {group.examples.map((example) => (
                                <div key={example.id} className="break-all">
                                  {group.source === 'task' &&
                                  example.groupFolder ? (
                                    <Link
                                      to="/board/$projectId"
                                      params={{
                                        projectId: example.groupFolder,
                                      }}
                                      search={{ taskId: example.id }}
                                      className="underline hover:text-foreground"
                                    >
                                      {example.id}
                                    </Link>
                                  ) : (
                                    example.id
                                  )}
                                </div>
                              ))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
              <p className="text-xs text-muted-foreground">
                Cost totals include only runs with recorded pricing. Empty days
                are shown; unpriced runs are flagged separately and listed above
                with the reason they could not be priced (largest 50 groups).
                Selecting a parent includes all descendants. Models whose name
                contains "gemini" are attributed to Gemini.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/costs')({
  component: CostReportPage,
});
