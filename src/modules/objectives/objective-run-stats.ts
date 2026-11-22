/**
 * Objective run-stats and cost aggregation, shared by the objective routes and
 * the conversation send path (an objective chat is a normal chat whose
 * completion refreshes these totals).
 */
import path from 'path';
import { getObjectiveConversations } from '../../db.js';
import {
  chatTranscriptStatKey,
  readChatTranscriptAsync,
} from '../../group-dir.js';
import { parseJsonl } from '../../lib/jsonl.js';
import { logger } from '../../logger.js';
import { serialize } from '../../lib/serial-queue.js';
import {
  GroupFsError,
  lstatGroupPath,
  openParentDir,
  readFileAt,
} from '../../lib/group-fs.js';
import {
  aggregateConversationCost,
  calculateTelemetryCostUsd,
  entriesAfter,
} from '../../lib/model-pricing.js';
import type { ObjectiveRunStats } from './types.js';
import {
  objectiveCostMetricsPath,
  persistObjectiveCostMetrics,
  readHistoricalConversationCostUsd,
} from './objective-cost-metrics.js';
import { enforceObjectiveCostLimit } from './objective-budget.js';
import {
  getObjectiveKanbanCostRows,
  pricedChatItems,
  writeObjectiveCostReport,
  type ChatCostItem,
} from './objective-cost-report.js';

async function allObjectiveConversationCost(
  projectId: string,
  objectiveId: string,
): Promise<{
  costUsd: number;
  measuredTurns: number;
  chatItems: ChatCostItem[];
}> {
  let costUsd = 0;
  let measuredTurns = 0;
  const chatItems: ChatCostItem[] = [];
  const conversations = await getObjectiveConversations(projectId, objectiveId);
  for (const { id, forkedAt } of conversations) {
    // Price the raw transcript, like the conversation view does. The formatted
    // replay merges telemetry into message bubbles that carry no timestamp (so
    // windowed totals lost every chat item) and can drop priced entries.
    // A fork's transcript starts with its parent's entries, which the parent
    // already counts: only entries after the fork point are its own.
    const entries = entriesAfter(
      (await readChatTranscriptAsync(projectId, id)) as Parameters<
        typeof aggregateConversationCost
      >[0],
      forkedAt,
    );
    const total = aggregateConversationCost(entries);
    if (total.costUsd != null) costUsd += total.costUsd;
    measuredTurns += entries.filter(
      (entry) =>
        entry.telemetry && calculateTelemetryCostUsd(entry.telemetry) != null,
    ).length;
    chatItems.push(...pricedChatItems(entries, id));
  }
  return { costUsd, measuredTurns, chatItems };
}

const MAX_JSONL_BYTES = 128 * 1024 * 1024;

/**
 * Read a JSONL file through a pinned parent directory (no links, no FIFO
 * blocking) and return parsed lines (skips malformed). Unreadable reads as empty.
 */
export async function readJsonl(
  filePath: string,
): Promise<Record<string, unknown>[]> {
  try {
    const parent = await openParentDir(filePath);
    if (!parent) return [];
    try {
      const read = await readFileAt(parent.dir, parent.name, {
        maxBytes: MAX_JSONL_BYTES,
        tail: true,
      });
      return read
        ? parseJsonl<Record<string, unknown>>(read.data.toString('utf-8'))
        : [];
    } finally {
      await parent.dir.close();
    }
  } catch (err) {
    if (err instanceof GroupFsError && err.code !== 'not_found') {
      logger.warn({ err, filePath }, 'Ignoring unreadable objective log');
    }
    return [];
  }
}

async function runStatsFileKey(objectiveDir: string): Promise<string> {
  try {
    const stat = await lstatGroupPath(
      path.join(objectiveDir, 'run-stats.jsonl'),
    );
    return stat ? `${stat.size}:${stat.mtimeMs}` : '-';
  } catch {
    return '?';
  }
}

/**
 * Cheap key over everything refreshRunStats reads: run-stats.jsonl and each
 * conversation transcript (size/mtime), the retained historical cost, the
 * conversation set and the linked task costs. Equal keys mean a refresh would
 * compute the same totals.
 */
async function runStatsInputKey(
  objectiveDir: string,
  projectId: string,
  objectiveId: string,
): Promise<string> {
  const [conversations, kanbanRows, historicalUsd, runStatsKey] =
    await Promise.all([
      getObjectiveConversations(projectId, objectiveId),
      getObjectiveKanbanCostRows(objectiveId),
      readHistoricalConversationCostUsd(objectiveCostMetricsPath(objectiveDir)),
      runStatsFileKey(objectiveDir),
    ]);
  const transcriptKeys = await Promise.all(
    conversations.map(
      async ({ id, forkedAt }) =>
        `${id}:${forkedAt ?? ''}:${await chatTranscriptStatKey(projectId, id).catch(() => '?')}`,
    ),
  );
  return JSON.stringify([
    runStatsKey,
    historicalUsd,
    transcriptKeys.sort(),
    kanbanRows.map((row) => [row.taskId, row.usd, row.at]).sort(),
  ]);
}

const runStatsMemo = new Map<
  string,
  { key: string; stats: ObjectiveRunStats | null }
>();

/** Drop the cached result of a deleted objective. */
export function forgetObjectiveRunStats(objectiveId: string): void {
  runStatsMemo.delete(objectiveId);
}

/**
 * aggregateRunStats for read paths (the objective list): while the inputs are
 * unchanged since the last refresh, reuse its result instead of re-reading
 * every transcript. The cost limit is still enforced against the reused total
 * so a limit change or reactivation pauses exactly as a refresh would.
 */
export async function aggregateRunStatsIfChanged(
  objectiveDir: string,
  projectId: string,
  objectiveId: string,
  readRunStats?: () => Promise<Record<string, unknown>[]>,
): Promise<ObjectiveRunStats | null> {
  // The key is taken before the refresh reads its sources: an input that
  // changes meanwhile leaves the memo stale, so the next call refreshes again.
  const key = await runStatsInputKey(objectiveDir, projectId, objectiveId);
  const memo = runStatsMemo.get(objectiveId);
  if (memo?.key === key) {
    // A refresh enforces the limit even at a zero total (null stats).
    await enforceObjectiveCostLimit(
      projectId,
      objectiveId,
      memo.stats?.totalCostUsd ?? 0,
    );
    return memo.stats;
  }
  // Read run-stats.jsonl only now, after the key: an append in between makes
  // the next key differ instead of pairing a newer key with older entries.
  const stats = await aggregateRunStats(
    objectiveDir,
    projectId,
    objectiveId,
    await readRunStats?.(),
  );
  runStatsMemo.set(objectiveId, { key, stats });
  return stats;
}

/** Aggregate run-stats.jsonl into summary metrics. */
export function aggregateRunStats(
  objectiveDir: string,
  projectId: string,
  objectiveId: string,
  runStats?: Record<string, unknown>[],
): Promise<ObjectiveRunStats | null> {
  // Run refreshes of one objective strictly one after another. Each refresh
  // reads its sources and publishes metrics and report together, so a later
  // refresh can never be overwritten by an older one and both files keep the
  // same total.
  return serialize(`objective-refresh:${objectiveDir}`, () =>
    refreshRunStats(objectiveDir, projectId, objectiveId, runStats),
  );
}

async function refreshRunStats(
  objectiveDir: string,
  projectId: string,
  objectiveId: string,
  runStats?: Record<string, unknown>[],
): Promise<ObjectiveRunStats | null> {
  const entries =
    runStats ?? (await readJsonl(path.join(objectiveDir, 'run-stats.jsonl')));
  const historicalConversationCostUsd = await readHistoricalConversationCostUsd(
    objectiveCostMetricsPath(objectiveDir),
  );
  const measuredConversationCost = await allObjectiveConversationCost(
    projectId,
    objectiveId,
  );
  const conversationCost = {
    costUsd: historicalConversationCostUsd + measuredConversationCost.costUsd,
    measuredTurns: measuredConversationCost.measuredTurns,
  };
  // One kanban snapshot feeds both the metrics total and the report, so the
  // two files agree even while a linked task run is updating its cost.
  const kanbanRows = await getObjectiveKanbanCostRows(objectiveId);
  const taskCostUsd = kanbanRows.reduce((sum, row) => sum + row.usd, 0);

  let autonomousCostUsd = 0;
  let totalDurationMs = 0;
  let successCount = 0;
  let lastRunAt: string | null = null;

  for (const e of entries) {
    if (typeof e.costUsd === 'number') autonomousCostUsd += e.costUsd;
    const duration = e.durationMs ?? e.duration_ms;
    if (typeof duration === 'number') totalDurationMs += duration;
    if (e.exitCode === 0) successCount++;
    if (typeof e.timestamp === 'string') {
      if (!lastRunAt || e.timestamp > lastRunAt) lastRunAt = e.timestamp;
    }
  }

  const totalCostUsd =
    autonomousCostUsd + conversationCost.costUsd + taskCostUsd;
  try {
    await persistObjectiveCostMetrics(objectiveCostMetricsPath(objectiveDir), {
      autonomousCostUsd,
      conversationCostUsd: conversationCost.costUsd,
      taskCostUsd,
      costedConversationTurns: conversationCost.measuredTurns,
    });
  } catch (err) {
    logger.warn(
      { err, projectId, objectiveId },
      'Failed to persist objective cost total',
    );
  }
  try {
    await writeObjectiveCostReport(objectiveDir, {
      runStats: entries,
      chatItems: measuredConversationCost.chatItems,
      historicalChatUsd: historicalConversationCostUsd,
      kanbanRows,
    });
  } catch (err) {
    logger.warn(
      { err, projectId, objectiveId },
      'Failed to write objective cost report',
    );
  }
  await enforceObjectiveCostLimit(projectId, objectiveId, totalCostUsd);

  if (
    entries.length === 0 &&
    historicalConversationCostUsd === 0 &&
    conversationCost.measuredTurns === 0 &&
    taskCostUsd === 0
  )
    return null;

  return {
    totalCostUsd,
    runCount: entries.length,
    lastRunAt,
    avgDurationMs:
      entries.length > 0 ? Math.round(totalDurationMs / entries.length) : 0,
    successRate: entries.length > 0 ? successCount / entries.length : 0,
  };
}
