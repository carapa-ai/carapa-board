import {
  calculateModelCostUsd,
  getModelPricingConfig,
} from './model-pricing.js';

export type RunCostProvider = 'OpenAI' | 'Anthropic' | 'Gemini' | 'Other';

export interface CostedRun {
  startedAt: string;
  stage?: string | null;
  taskCompletedAt?: string | null;
  taskStartedAt?: string | null;
  taskCreatedAt?: string | null;
  agentName: string | null;
  model: string | null;
  modelName: string | null;
  costUsd: number;
}

export interface DailyProviderCost {
  date: string;
  provider: RunCostProvider;
  costUsd: number;
  runCount: number;
  models: string[];
}

export function effectiveRunTimestamp(run: CostedRun): number {
  const effectiveStartedAt =
    run.stage === 'legacy'
      ? run.taskCompletedAt ||
        run.taskStartedAt ||
        run.taskCreatedAt ||
        run.startedAt
      : run.startedAt;
  return new Date(effectiveStartedAt).getTime();
}

export function classifyRunProvider(
  agentName: string | null,
  model: string | null,
  modelName: string | null,
): RunCostProvider {
  const agent = (agentName ?? '').toLowerCase();
  const modelText = `${model ?? ''} ${modelName ?? ''}`.toLowerCase();

  // Model identity takes precedence over harness.
  if (/\bgemini(?:[/:._-]|$)/i.test(modelText)) {
    return 'Gemini';
  }
  if (
    agent.includes('codex') ||
    agent.startsWith('llm:openai') ||
    /\b(gpt|o1|o3|o4)(?:[/:._-]|$)/i.test(modelText)
  ) {
    return 'OpenAI';
  }
  if (
    agent.includes('claude') ||
    agent.startsWith('llm:anthropic') ||
    /\bclaude(?:[/:._-]|$)/i.test(modelText)
  ) {
    return 'Anthropic';
  }
  return 'Other';
}

export function aggregateDailyProviderCosts(
  runs: CostedRun[],
  timezoneOffsetMinutes: number,
): DailyProviderCost[] {
  const offsetMs = timezoneOffsetMinutes * 60_000;
  const buckets = new Map<
    string,
    DailyProviderCost & { modelSet: Set<string> }
  >();

  for (const run of runs) {
    if (!Number.isFinite(run.costUsd)) continue;
    // Early cost backfills synthesized active_runs rows from transcripts. A
    // restored transcript's mtime could incorrectly stamp those rows with the
    // migration day. Task lifecycle timestamps are the best durable historical
    // date for existing synthetic rows.
    const timestamp = effectiveRunTimestamp(run);
    if (!Number.isFinite(timestamp)) continue;
    const date = new Date(timestamp - offsetMs).toISOString().slice(0, 10);
    const provider = classifyRunProvider(
      run.agentName,
      run.model,
      run.modelName,
    );
    const key = `${date}\0${provider}`;
    const bucket = buckets.get(key) ?? {
      date,
      provider,
      costUsd: 0,
      runCount: 0,
      models: [],
      modelSet: new Set<string>(),
    };
    bucket.costUsd += run.costUsd;
    bucket.runCount += 1;
    const reportedModel = run.modelName || run.model;
    if (reportedModel) bucket.modelSet.add(reportedModel);
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .map(({ modelSet, ...bucket }) => ({
      ...bucket,
      models: [...modelSet].sort(),
    }))
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) || a.provider.localeCompare(b.provider),
    );
}

type UncostedRunReason =
  | 'running'
  | 'no_model'
  | 'pricing_file_missing'
  | 'model_not_priced'
  | 'no_usage_telemetry'
  | 'other';

type UncostedRunSource = 'task' | 'chat' | 'brain' | 'external';

/** A report row that may lack a cost; extra fields exist only for drill-down. */
export interface UncostedCandidateRow extends Omit<CostedRun, 'costUsd'> {
  costUsd: number | string | null;
  /** Set for rows that do not come from board task/chat runs. */
  source?: 'brain' | 'external';
  id?: string | null;
  groupFolder?: string | null;
  taskId?: string | null;
  conversationId?: string | null;
  status?: string | null;
  tokInput?: number | null;
  tokOutput?: number | null;
}

export interface UncostedRunGroup {
  date: string;
  source: UncostedRunSource;
  agentName: string | null;
  model: string | null;
  stage: string | null;
  status: string | null;
  reason: UncostedRunReason;
  count: number;
  /** Task ids for `task` groups; conversation or run ids otherwise. */
  examples: Array<{ id: string; groupFolder: string | null }>;
}

const MAX_UNCOSTED_EXAMPLES = 3;

export function summarizeUncostedRuns(
  rows: UncostedCandidateRow[],
  options: { firstDate: string; timezoneOffset: number; limit?: number },
): UncostedRunGroup[] {
  const limit = options.limit ?? 50;
  const pricing = getModelPricingConfig();
  const pricingUsable = pricing != null && pricing.currency === 'USD';
  const modelPriced = new Map<string, boolean>();
  const isModelPriced = (model: string) => {
    let priced = modelPriced.get(model);
    if (priced === undefined) {
      priced = calculateModelCostUsd(model, {}) != null;
      modelPriced.set(model, priced);
    }
    return priced;
  };
  const groups = new Map<string, UncostedRunGroup>();

  for (const row of rows) {
    if (row.costUsd != null) continue;
    const timestamp = effectiveRunTimestamp({ ...row, costUsd: 0 });
    if (!Number.isFinite(timestamp)) continue;
    const date = new Date(timestamp - options.timezoneOffset * 60_000)
      .toISOString()
      .slice(0, 10);
    if (date < options.firstDate) continue;

    const model = row.modelName || row.model || null;
    const hasTelemetry = row.tokInput != null || row.tokOutput != null;
    let reason: UncostedRunReason;
    if (row.status === 'running') reason = 'running';
    else if (!model) reason = 'no_model';
    else if (!pricingUsable) reason = 'pricing_file_missing';
    else if (!isModelPriced(model)) reason = 'model_not_priced';
    else if (!hasTelemetry) reason = 'no_usage_telemetry';
    else reason = 'other';

    const source: UncostedRunSource =
      row.source ?? (row.taskId ? 'task' : 'chat');
    const agentName = row.agentName ?? null;
    const stage = row.stage ?? null;
    const status = row.status ?? null;
    const key = [date, source, agentName, model, stage, status, reason].join(
      '\0',
    );
    const group = groups.get(key) ?? {
      date,
      source,
      agentName,
      model,
      stage,
      status,
      reason,
      count: 0,
      examples: [],
    };
    group.count += 1;
    const exampleId =
      source === 'task' ? row.taskId : (row.conversationId ?? row.id);
    if (
      exampleId &&
      group.examples.length < MAX_UNCOSTED_EXAMPLES &&
      !group.examples.some((example) => example.id === exampleId)
    ) {
      group.examples.push({
        id: exampleId,
        groupFolder: row.groupFolder ?? null,
      });
    }
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort((a, b) => b.date.localeCompare(a.date) || b.count - a.count)
    .slice(0, limit);
}
