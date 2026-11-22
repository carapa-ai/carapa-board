import {
  openGroupDir,
  readdirAt,
  readFileAt,
  type PinnedDir,
} from './group-fs.js';
import { parseJsonl } from './jsonl.js';

export interface BrainRunCostRow {
  groupFolder: string;
  startedAt: string;
  agentName: string | null;
  model: string | null;
  modelName: string | null;
  costUsd: number | null;
}

type JsonRecord = Record<string, unknown>;

/** Largest cost log read; a bigger (or non-regular, linked) file counts as zero cost. */
const MAX_COST_LOG_BYTES = 32 * 1024 * 1024;

async function readJsonl(dir: PinnedDir, rel: string): Promise<JsonRecord[]> {
  try {
    const read = await readFileAt(dir, rel, { maxBytes: MAX_COST_LOG_BYTES });
    if (!read) return [];
    return parseJsonl<unknown>(read.data.toString('utf8')).filter(
      (value): value is JsonRecord => !!value && typeof value === 'object',
    );
  } catch {
    return [];
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function finiteCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read autonomous Brain invocations for projects, deduplicated by runner ID. */
export async function readBrainRunCosts(
  projectIds: Iterable<string>,
): Promise<BrainRunCostRow[]> {
  const runs = new Map<string, BrainRunCostRow>();

  for (const projectId of projectIds) {
    // Pinned without following links: a swapped folder or log link counts as zero cost.
    const groupDir = await openGroupDir(projectId).catch(() => null);
    if (!groupDir) continue;
    try {
      await collectProjectRuns(projectId, groupDir, runs);
    } finally {
      await groupDir.close();
    }
  }

  return [...runs.values()];
}

async function collectProjectRuns(
  projectId: string,
  groupDir: PinnedDir,
  runs: Map<string, BrainRunCostRow>,
): Promise<void> {
  const sessions = await readJsonl(groupDir, 'session-log.jsonl');
  for (const entry of sessions) {
    if (entry.runType !== 'brain-run') continue;
    const runId = text(entry.runId);
    const timestamp = text(entry.timestamp);
    if (!runId || !timestamp) continue;
    runs.set(runId, {
      groupFolder: projectId,
      startedAt: timestamp,
      agentName: text(entry.agentCmd),
      model: text(entry.model),
      modelName: text(entry.model),
      costUsd: finiteCost(entry.costUsd),
    });
  }

  let objectiveIds: string[] = [];
  try {
    const entries = await readdirAt(groupDir, 'objectives', {
      withFileTypes: true,
    });
    objectiveIds = (entries ?? [])
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // Projects without objectives have no autonomous Brain runs.
  }
  for (const objectiveId of objectiveIds) {
    const stats = await readJsonl(
      groupDir,
      `objectives/${objectiveId}/run-stats.jsonl`,
    );
    for (const entry of stats) {
      const runId = text(entry.runId);
      const timestamp = text(entry.timestamp);
      if (!runId || !timestamp) continue;
      const existing = runs.get(runId);
      const model = text(entry.model) ?? existing?.model ?? null;
      runs.set(runId, {
        groupFolder: projectId,
        startedAt: timestamp,
        agentName:
          text(entry.harness) ??
          text(entry.agentCmd) ??
          existing?.agentName ??
          null,
        model,
        modelName: model,
        costUsd: finiteCost(entry.costUsd),
      });
    }
  }
}
