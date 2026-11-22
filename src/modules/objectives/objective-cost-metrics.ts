import path from 'path';
import {
  GroupFsError,
  openParentDir,
  readFileAt,
  writeFileAt,
} from '../../lib/group-fs.js';
import { logger } from '../../logger.js';

export interface ObjectiveCostMetricUpdates {
  autonomousCostUsd?: number;
  conversationCostUsd?: number;
  taskCostUsd?: number;
  costedConversationTurns?: number;
}

export interface PersistedObjectiveCostMetrics {
  changed: boolean;
  totalCostUsd: number;
}

function finiteMetric(metrics: Record<string, unknown>, key: string): number {
  const value = metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

const metricMutationQueues = new Map<string, Promise<void>>();

export function objectiveCostMetricsPath(objectiveDir: string): string {
  return path.join(objectiveDir, 'board-cost-metrics.json');
}

/** Largest metrics/state file read; a bigger file is treated as invalid. */
const MAX_METRICS_BYTES = 8 * 1024 * 1024;

/**
 * Read a JSON file the agent can replace, through the pinned parent directory:
 * never following a link and never blocking on a FIFO. Null when the file is
 * missing or is not a readable regular file (logged); malformed JSON throws.
 */
async function readJsonFile(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  let data: Buffer | null;
  try {
    const parent = await openParentDir(filePath);
    if (!parent) return null;
    try {
      data =
        (
          await readFileAt(parent.dir, parent.name, {
            maxBytes: MAX_METRICS_BYTES,
          })
        )?.data ?? null;
    } finally {
      await parent.dir.close();
    }
  } catch (err) {
    if (!(err instanceof GroupFsError)) throw err;
    logger.warn({ err, filePath }, 'Ignoring unreadable objective cost file');
    return null;
  }
  return data
    ? (JSON.parse(data.toString('utf-8')) as Record<string, unknown>)
    : null;
}

async function readMetrics(
  metricsPath: string,
): Promise<{ metrics: Record<string, unknown>; exists: boolean }> {
  const current = await readJsonFile(metricsPath);
  return current
    ? { metrics: current, exists: true }
    : { metrics: {}, exists: false };
}

/** Read the retained pre-Board conversation cost from the Board metrics file. */
export async function readHistoricalConversationCostUsd(
  metricsPath: string,
): Promise<number> {
  const { metrics } = await readMetrics(metricsPath);
  return finiteMetric(metrics, 'historicalConversationCostUsd');
}

/**
 * Persist Board-derived cost metrics without mutating Brain-owned state.json.
 */
export async function persistObjectiveCostMetrics(
  metricsPath: string,
  updates: ObjectiveCostMetricUpdates,
): Promise<PersistedObjectiveCostMetrics> {
  const previous = metricMutationQueues.get(metricsPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  metricMutationQueues.set(metricsPath, current);

  await previous;
  try {
    const { metrics, exists } = await readMetrics(metricsPath);
    const mergedMetrics = { ...metrics, ...updates };
    const totalCostUsd =
      finiteMetric(mergedMetrics, 'autonomousCostUsd') +
      finiteMetric(mergedMetrics, 'conversationCostUsd') +
      finiteMetric(mergedMetrics, 'taskCostUsd');
    const nextMetrics: Record<string, number> = {
      ...updates,
      totalCostUsd,
    };
    const changed = Object.entries(nextMetrics).some(
      ([key, value]) => metrics[key] !== value,
    );

    if (changed || !exists) {
      Object.assign(metrics, nextMetrics, {
        ...(changed ? { costUpdatedAt: new Date().toISOString() } : {}),
      });
      // Atomic temp+rename in the pinned directory: a planted link or FIFO at
      // the leaf is replaced, never written through.
      const parent = await openParentDir(metricsPath);
      if (!parent)
        throw new Error(`Objective directory missing: ${metricsPath}`);
      try {
        await writeFileAt(
          parent.dir,
          parent.name,
          JSON.stringify(metrics, null, 2),
        );
      } finally {
        await parent.dir.close();
      }
    }

    return { changed, totalCostUsd };
  } finally {
    release();
    if (metricMutationQueues.get(metricsPath) === current) {
      metricMutationQueues.delete(metricsPath);
    }
  }
}
