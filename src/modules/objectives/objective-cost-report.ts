/**
 * Board-computed, windowed per-objective cost report
 * (`<objectiveDir>/board-cost-report.json`). Derived from data the board
 * already owns: Brain `run-stats.jsonl`, objective chat transcripts and the
 * `active_runs` of tasks linked to the objective. No pricing logic lives here;
 * transcript entries are priced by `model-pricing.ts`.
 */
import { randomUUID } from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { and, eq, isNotNull } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { activeRuns, tasks } from '../../db/schema.js';
import { calculateTelemetryCostUsd } from '../../lib/model-pricing.js';

type CostGroup = 'trigger' | 'chat' | 'kanban';
type CostWindowKey = '1d' | '7d' | '30d' | 'all';

export interface ChatCostItem {
  /** `created_at ?? timestamp` of the priced transcript entry. */
  at?: string | null;
  usd: number;
  /**
   * Conversation the entry belongs to. Chat totals are summed per conversation,
   * then across conversations, the same grouping as the cost metrics total.
   */
  conversationId?: string;
}

export interface KanbanCostRow {
  taskId: string;
  projectId: string;
  usd: number;
  /** `completed_at ?? started_at` of the run. */
  at?: string | null;
}

export interface ObjectiveCostReportInput {
  /** Parsed `run-stats.jsonl` lines. */
  runStats: Record<string, unknown>[];
  chatItems: ChatCostItem[];
  historicalChatUsd: number;
  kanbanRows: KanbanCostRow[];
}

interface CategoryTotals {
  usd: number;
  runs: number;
}

interface CostWindowReport {
  totalUsd: number;
  runs: number;
  byGroup: Record<CostGroup, number>;
  byCategory: Record<string, CategoryTotals>;
  brainCacheHitRatio: number | null;
}

interface CostBucket {
  bucket: string;
  usd: number;
  trigger: number;
  chat: number;
  kanban: number;
}

export interface ObjectiveCostReport {
  generatedAt: string;
  pricing: string;
  windows: Record<CostWindowKey, CostWindowReport>;
  daily: CostBucket[];
  hourly: CostBucket[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_SPANS_MS: Record<Exclude<CostWindowKey, 'all'>, number> = {
  '1d': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};
const WINDOW_KEYS: CostWindowKey[] = ['1d', '7d', '30d', 'all'];
const DAILY_BUCKETS = 14;
const HOURLY_BUCKETS = 24;

interface CostItem {
  /** Epoch ms; null when the item has no parseable timestamp. */
  ms: number | null;
  usd: number;
  group: CostGroup;
  category: string;
  /** Distinct-run key within the category; each item counts once when absent. */
  runKey?: string;
  /** Chat only: conversation whose subtotal this item is summed into. */
  conversationId?: string;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Priced entries of a formatted transcript, each keeping its timestamp. */
export function pricedChatItems(
  entries: Array<{
    telemetry?: Record<string, unknown>;
    created_at?: string;
    timestamp?: string;
  }>,
  conversationId?: string,
): ChatCostItem[] {
  const items: ChatCostItem[] = [];
  for (const entry of entries) {
    if (!entry.telemetry) continue;
    const usd = calculateTelemetryCostUsd(entry.telemetry);
    if (usd == null) continue;
    items.push({
      at: entry.created_at ?? entry.timestamp,
      usd,
      conversationId,
    });
  }
  return items;
}

function buildItems(input: ObjectiveCostReportInput): CostItem[] {
  const items: CostItem[] = [];
  for (const line of input.runStats) {
    const trigger =
      typeof line.triggerType === 'string' && line.triggerType
        ? line.triggerType
        : 'unknown';
    items.push({
      ms: parseMs(line.timestamp),
      usd: finiteNumber(line.costUsd),
      group: 'trigger',
      category: `trigger:${trigger}`,
    });
  }
  for (const item of input.chatItems) {
    items.push({
      ms: parseMs(item.at),
      usd: item.usd,
      group: 'chat',
      category: 'chat',
      conversationId: item.conversationId,
    });
  }
  for (const row of input.kanbanRows) {
    items.push({
      ms: parseMs(row.at),
      usd: row.usd,
      group: 'kanban',
      category: `kanban:${row.projectId}`,
      runKey: row.taskId,
    });
  }
  return items;
}

function buildWindow(
  items: CostItem[],
  input: ObjectiveCostReportInput,
  key: CostWindowKey,
  now: number,
): CostWindowReport {
  const since = key === 'all' ? null : now - WINDOW_SPANS_MS[key];
  const inWindow = (ms: number | null): boolean =>
    since == null || (ms != null && ms >= since);

  const byGroup: Record<CostGroup, number> = {
    trigger: 0,
    chat: 0,
    kanban: 0,
  };
  // Chat is summed per conversation, then across conversations, to match the
  // metrics total's floating-point grouping exactly.
  const chatByConversation = new Map<string, number>();
  const categories = new Map<
    string,
    { usd: number; runs: number; keys: Set<string> }
  >();
  const category = (name: string) => {
    let entry = categories.get(name);
    if (!entry) {
      entry = { usd: 0, runs: 0, keys: new Set() };
      categories.set(name, entry);
    }
    return entry;
  };

  for (const item of items) {
    if (!inWindow(item.ms)) continue;
    if (item.group === 'chat') {
      const conversation = item.conversationId ?? '';
      chatByConversation.set(
        conversation,
        (chatByConversation.get(conversation) ?? 0) + item.usd,
      );
    } else {
      byGroup[item.group] += item.usd;
    }
    const entry = category(item.category);
    entry.usd += item.usd;
    if (item.runKey === undefined) entry.runs++;
    else if (!entry.keys.has(item.runKey)) {
      entry.keys.add(item.runKey);
      entry.runs++;
    }
  }
  const historicalChatUsd =
    key === 'all' && input.historicalChatUsd > 0 ? input.historicalChatUsd : 0;
  if (historicalChatUsd > 0) {
    category('chat:historical').usd += historicalChatUsd;
  }
  let measuredChatUsd = 0;
  for (const subtotal of chatByConversation.values())
    measuredChatUsd += subtotal;
  byGroup.chat = historicalChatUsd + measuredChatUsd;

  let inputTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  for (const line of input.runStats) {
    if (!inWindow(parseMs(line.timestamp))) continue;
    inputTokens += finiteNumber(line.inputTokens);
    cacheRead += finiteNumber(line.cacheReadTokens);
    cacheCreation += finiteNumber(line.cacheCreationTokens);
  }
  const tokenTotal = inputTokens + cacheRead + cacheCreation;

  const byCategory: Record<string, CategoryTotals> = {};
  let runs = 0;
  for (const [name, entry] of [...categories].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    byCategory[name] = { usd: round2(entry.usd), runs: entry.runs };
    runs += entry.runs;
  }

  return {
    totalUsd: round2(byGroup.trigger + byGroup.chat + byGroup.kanban),
    runs,
    byGroup: {
      trigger: round2(byGroup.trigger),
      chat: round2(byGroup.chat),
      kanban: round2(byGroup.kanban),
    },
    byCategory,
    brainCacheHitRatio: tokenTotal > 0 ? cacheRead / tokenTotal : null,
  };
}

function buildSeries(
  items: CostItem[],
  now: number,
  stepMs: number,
  count: number,
  keyLength: number,
): CostBucket[] {
  const currentStart = Math.floor(now / stepMs) * stepMs;
  const buckets = new Map<string, CostBucket>();
  const series: CostBucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const bucket = new Date(currentStart - i * stepMs)
      .toISOString()
      .slice(0, keyLength);
    const entry = { bucket, usd: 0, trigger: 0, chat: 0, kanban: 0 };
    buckets.set(bucket, entry);
    series.push(entry);
  }
  for (const item of items) {
    if (item.ms == null) continue;
    const entry = buckets.get(
      new Date(item.ms).toISOString().slice(0, keyLength),
    );
    if (!entry) continue;
    entry[item.group] += item.usd;
    entry.usd += item.usd;
  }
  return series.map((entry) => ({
    bucket: entry.bucket,
    usd: round2(entry.usd),
    trigger: round2(entry.trigger),
    chat: round2(entry.chat),
    kanban: round2(entry.kanban),
  }));
}

/** Pure builder: no I/O, all time handling derives from `now`. */
export function buildObjectiveCostReport(
  input: ObjectiveCostReportInput,
  now: Date,
): ObjectiveCostReport {
  const nowMs = now.getTime();
  const items = buildItems(input);
  const windows = {} as Record<CostWindowKey, CostWindowReport>;
  for (const key of WINDOW_KEYS) {
    windows[key] = buildWindow(items, input, key, nowMs);
  }
  return {
    generatedAt: now.toISOString(),
    pricing: 'board model_pricing.jsonc / runner-reported costUsd',
    windows,
    // Day buckets are UTC midnights; the hourly series ends at the current hour.
    daily: buildSeries(items, nowMs, DAY_MS, DAILY_BUCKETS, 10),
    hourly: buildSeries(items, nowMs, HOUR_MS, HOURLY_BUCKETS, 13),
  };
}

/** Every priced run of a task linked to the objective. */
export async function getObjectiveKanbanCostRows(
  objectiveId: string,
): Promise<KanbanCostRow[]> {
  const rows = await drizzleDbRef.current
    .select({
      taskId: tasks.id,
      projectId: tasks.project_id,
      costUsd: activeRuns.cost_usd,
      completedAt: activeRuns.completed_at,
      startedAt: activeRuns.started_at,
    })
    .from(tasks)
    .innerJoin(activeRuns, eq(activeRuns.task_id, tasks.id))
    .where(
      and(eq(tasks.objective_id, objectiveId), isNotNull(activeRuns.cost_usd)),
    );
  return rows.map((row) => ({
    taskId: row.taskId,
    projectId: row.projectId,
    usd: Number(row.costUsd),
    at: row.completedAt ?? row.startedAt,
  }));
}

function objectiveCostReportPath(objectiveDir: string): string {
  return path.join(objectiveDir, 'board-cost-report.json');
}

/** Build the report and write it atomically (tmp + rename). */
export async function writeObjectiveCostReport(
  objectiveDir: string,
  input: ObjectiveCostReportInput,
  now: Date = new Date(),
): Promise<ObjectiveCostReport> {
  const report = buildObjectiveCostReport(input, now);
  const reportPath = objectiveCostReportPath(objectiveDir);
  const tmpPath = `${reportPath}.board-${process.pid}-${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(report, null, 2), 'utf-8');
    await fsp.rename(tmpPath, reportPath);
  } finally {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
  return report;
}
