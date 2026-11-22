import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  objectiveCostMetricsPath,
  persistObjectiveCostMetrics,
  readHistoricalConversationCostUsd,
} from './objective-cost-metrics.js';

let testDir = '';

beforeAll(async () => {
  testDir = await mkdtemp(path.join(tmpdir(), 'objective-cost-metrics-'));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function seedState(dirname: string): Promise<{
  statePath: string;
  metricsPath: string;
}> {
  const objectiveDir = path.join(testDir, dirname);
  await mkdir(objectiveDir, { recursive: true });
  const statePath = path.join(objectiveDir, 'state.json');
  await writeFile(statePath, JSON.stringify({ status: 'paused' }), 'utf-8');
  const metricsPath = objectiveCostMetricsPath(objectiveDir);
  await writeFile(
    metricsPath,
    JSON.stringify({
      autonomousCostUsd: 1,
      conversationCostUsd: 2,
      taskCostUsd: 3,
      totalCostUsd: 6,
      costedConversationTurns: 4,
      costUpdatedAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf-8',
  );
  return { statePath, metricsPath };
}

describe('persistObjectiveCostMetrics', () => {
  test('does not rewrite unchanged Board metrics', async () => {
    const { metricsPath } = await seedState('unchanged');
    const beforeContent = await readFile(metricsPath, 'utf-8');
    const beforeInode = (await stat(metricsPath)).ino;

    const result = await persistObjectiveCostMetrics(metricsPath, {
      autonomousCostUsd: 1,
      conversationCostUsd: 2,
      taskCostUsd: 3,
      costedConversationTurns: 4,
    });

    expect(result).toEqual({ changed: false, totalCostUsd: 6 });
    expect(await readFile(metricsPath, 'utf-8')).toBe(beforeContent);
    expect((await stat(metricsPath)).ino).toBe(beforeInode);
  });

  test('refreshes costUpdatedAt after a real change', async () => {
    const { statePath, metricsPath } = await seedState('changed');
    const beforeState = await readFile(statePath, 'utf-8');
    const beforeInode = (await stat(statePath)).ino;

    const result = await persistObjectiveCostMetrics(metricsPath, {
      taskCostUsd: 4,
    });
    const metrics = JSON.parse(await readFile(metricsPath, 'utf-8')) as Record<
      string,
      number | string
    >;

    expect(result).toEqual({ changed: true, totalCostUsd: 7 });
    expect(metrics.taskCostUsd).toBe(4);
    expect(metrics.totalCostUsd).toBe(7);
    expect(metrics.costUpdatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    expect(await readFile(statePath, 'utf-8')).toBe(beforeState);
    expect((await stat(statePath)).ino).toBe(beforeInode);
  });

  test('reads the retained historical cost from the Board metrics file only', async () => {
    const { statePath, metricsPath } = await seedState('historical-source');
    await writeFile(
      statePath,
      JSON.stringify({
        status: 'paused',
        metrics: { historicalConversationCostUsd: 9 },
      }),
      'utf-8',
    );
    expect(await readHistoricalConversationCostUsd(metricsPath)).toBe(0);

    await writeFile(
      metricsPath,
      JSON.stringify({ historicalConversationCostUsd: 5 }),
      'utf-8',
    );
    expect(await readHistoricalConversationCostUsd(metricsPath)).toBe(5);
  });

  test('preserves an external full-file state update during Board cost writes', async () => {
    const { statePath, metricsPath } = await seedState('external-writer');
    await persistObjectiveCostMetrics(metricsPath, { taskCostUsd: 3 });

    const externalWriter = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { writeFile, rename } from 'fs/promises';
       const statePath = process.argv[1];
       const tmpPath = statePath + '.brain-' + process.pid + '.tmp';
       await writeFile(tmpPath, JSON.stringify({ status: 'active', progress: 60, lastSessionId: 'brain-new' }));
       await rename(tmpPath, statePath);`,
        statePath,
      ],
      { env: {} },
    );
    const [externalExitCode] = await Promise.all([
      externalWriter.exited,
      ...Array.from({ length: 20 }, (_, taskCostUsd) =>
        persistObjectiveCostMetrics(metricsPath, { taskCostUsd }),
      ),
    ]);

    expect(externalExitCode).toBe(0);
    expect(JSON.parse(await readFile(statePath, 'utf-8'))).toEqual({
      status: 'active',
      progress: 60,
      lastSessionId: 'brain-new',
    });
    expect(JSON.parse(await readFile(metricsPath, 'utf-8'))).toMatchObject({
      autonomousCostUsd: 1,
      conversationCostUsd: 2,
      taskCostUsd: 19,
      totalCostUsd: 22,
    });
  });
});
