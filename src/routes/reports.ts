import { Router } from 'express';
import {
  getProjectHierarchyRows,
  getRunCostRowsSince,
} from '../db/active-runs.js';
import { getExternalRunCostRowsSince } from '../db/external-run-costs.js';
import {
  aggregateDailyProviderCosts,
  effectiveRunTimestamp,
  summarizeUncostedRuns,
} from '../lib/run-cost-report.js';
import { readBrainRunCosts } from '../lib/brain-run-costs.js';
import { requireAdmin } from './_helpers.js';

const router = Router();
type ReportRunType = 'chat' | 'task' | 'event';

router.get('/reports/run-costs', requireAdmin, async (req: any, res) => {
  const requestedDays = Number.parseInt(String(req.query.days ?? '30'), 10);
  const days = Number.isFinite(requestedDays)
    ? Math.min(366, Math.max(1, requestedDays))
    : 30;
  const requestedOffset = Number.parseInt(
    String(req.query.timezoneOffset ?? '0'),
    10,
  );
  const timezoneOffset = Number.isFinite(requestedOffset)
    ? Math.min(840, Math.max(-840, requestedOffset))
    : 0;
  const projectId =
    typeof req.query.projectId === 'string' && req.query.projectId
      ? req.query.projectId
      : null;
  const requestedRunType = String(req.query.runType ?? '');
  const runType: ReportRunType | null =
    requestedRunType === 'chat' ||
    requestedRunType === 'task' ||
    requestedRunType === 'event'
      ? requestedRunType
      : null;
  const hierarchy = await getProjectHierarchyRows();
  let includedProjectIds: Set<string> | null = null;
  if (projectId) {
    if (!hierarchy.some((project) => project.id === projectId)) {
      return res.status(404).json({ error: 'Project not found' });
    }
    includedProjectIds = new Set([projectId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const project of hierarchy) {
        if (
          project.parentId &&
          includedProjectIds.has(project.parentId) &&
          !includedProjectIds.has(project.id)
        ) {
          includedProjectIds.add(project.id);
          changed = true;
        }
      }
    }
  }
  const since = new Date(Date.now() - (days + 1) * 86_400_000).toISOString();
  const reportProjectIds =
    includedProjectIds ?? new Set(hierarchy.map((row) => row.id));
  const [queriedRows, externalRows, brainRunRows] = await Promise.all([
    getRunCostRowsSince(since),
    getExternalRunCostRowsSince(since),
    readBrainRunCosts(reportProjectIds),
  ]);
  const projectBoardRows = includedProjectIds
    ? queriedRows.filter((row) => includedProjectIds.has(row.groupFolder))
    : queriedRows;
  const projectBrainRows = brainRunRows.filter((row) => row.startedAt >= since);
  const importedRows = includedProjectIds
    ? externalRows.filter((row) => includedProjectIds.has(row.groupFolder))
    : externalRows;
  const boardRows =
    runType === 'event'
      ? []
      : projectBoardRows.filter((row) =>
          runType === 'task'
            ? row.taskId != null
            : runType === 'chat'
              ? row.taskId == null
              : true,
        );
  const visibleImportedRows =
    runType === 'event' || runType === 'task' ? [] : importedRows;
  const brainRows = runType && runType !== 'event' ? [] : projectBrainRows;
  const rows = [
    ...boardRows,
    ...visibleImportedRows.map((row) => ({
      ...row,
      source: 'external' as const,
    })),
    ...brainRows.map((row) => ({ ...row, source: 'brain' as const })),
  ];
  const daily = aggregateDailyProviderCosts(
    rows.flatMap((row) =>
      row.costUsd == null
        ? []
        : [
            {
              ...row,
              costUsd: Number(row.costUsd),
            },
          ],
    ),
    timezoneOffset,
  );
  const firstDate = new Date(
    Date.now() - (days - 1) * 86_400_000 - timezoneOffset * 60_000,
  )
    .toISOString()
    .slice(0, 10);
  const visible = daily.filter((row) => row.date >= firstDate);
  const coverageByDate = new Map<
    string,
    { totalRuns: number; costedRuns: number }
  >();
  for (const row of rows) {
    const timestamp = effectiveRunTimestamp({
      ...row,
      costUsd: Number(row.costUsd ?? 0),
    });
    if (!Number.isFinite(timestamp)) continue;
    const date = new Date(timestamp - timezoneOffset * 60_000)
      .toISOString()
      .slice(0, 10);
    if (date < firstDate) continue;
    const coverage = coverageByDate.get(date) ?? {
      totalRuns: 0,
      costedRuns: 0,
    };
    coverage.totalRuns += 1;
    if (row.costUsd != null) coverage.costedRuns += 1;
    coverageByDate.set(date, coverage);
  }
  const coverage = Array.from({ length: days }, (_, index) => {
    const date = new Date(
      Date.now() - index * 86_400_000 - timezoneOffset * 60_000,
    )
      .toISOString()
      .slice(0, 10);
    const counts = coverageByDate.get(date) ?? { totalRuns: 0, costedRuns: 0 };
    return {
      date,
      ...counts,
      uncostedRuns: counts.totalRuns - counts.costedRuns,
    };
  });

  res.json({
    days,
    timezoneOffset,
    projectId,
    runType,
    includedProjectIds: includedProjectIds ? [...includedProjectIds] : null,
    daily: visible,
    coverage,
    uncosted: summarizeUncostedRuns(rows, { firstDate, timezoneOffset }),
    totalCostUsd: visible.reduce((sum, row) => sum + row.costUsd, 0),
    totalRuns: visible.reduce((sum, row) => sum + row.runCount, 0),
  });
});

export default router;
