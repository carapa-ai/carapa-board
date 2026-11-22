import { describe, expect, test } from 'bun:test';
import {
  buildObjectiveCostReport,
  pricedChatItems,
  type ObjectiveCostReportInput,
} from './objective-cost-report.js';

const NOW = new Date('2026-10-23T10:30:00.000Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function input(
  overrides: Partial<ObjectiveCostReportInput> = {},
): ObjectiveCostReportInput {
  return {
    runStats: [],
    chatItems: [],
    historicalChatUsd: 0,
    kanbanRows: [],
    ...overrides,
  };
}

describe('buildObjectiveCostReport', () => {
  test('windows, groups and categories across edges', () => {
    const report = buildObjectiveCostReport(
      input({
        runStats: [
          { timestamp: ago(HOUR), triggerType: 'board_started', costUsd: 1 },
          { timestamp: ago(DAY), triggerType: 'board_started', costUsd: 2 },
          { timestamp: ago(7 * DAY), costUsd: 4 },
          { timestamp: ago(30 * DAY + 1), triggerType: 'cron', costUsd: 8 },
          { triggerType: 'cron', costUsd: 16 },
        ],
        chatItems: [
          { at: ago(2 * HOUR), usd: 0.5 },
          { at: ago(2 * DAY), usd: 0.25 },
          { at: 'not a date', usd: 0.125 },
        ],
        historicalChatUsd: 10,
        kanbanRows: [
          { taskId: 't1', projectId: 'p1', usd: 3, at: ago(HOUR) },
          { taskId: 't1', projectId: 'p1', usd: 3, at: ago(2 * HOUR) },
          { taskId: 't2', projectId: 'p1', usd: 3, at: ago(3 * HOUR) },
        ],
      }),
      NOW,
    );
    const { windows } = report;

    expect(windows['1d'].totalUsd).toBe(1 + 2 + 0.5 + 9);
    expect(windows['1d'].byGroup).toEqual({ trigger: 3, chat: 0.5, kanban: 9 });
    expect(windows['1d'].byCategory['trigger:board_started']).toEqual({
      usd: 3,
      runs: 2,
    });
    // runs counts distinct tasks, not active_runs rows
    expect(windows['1d'].byCategory['kanban:p1']).toEqual({ usd: 9, runs: 2 });
    expect(windows['1d'].byCategory['chat']).toEqual({ usd: 0.5, runs: 1 });
    expect(windows['1d'].byCategory['chat:historical']).toBeUndefined();

    expect(windows['7d'].byCategory['trigger:unknown']).toEqual({
      usd: 4,
      runs: 1,
    });
    expect(windows['7d'].totalUsd).toBe(1 + 2 + 4 + 0.75 + 9);
    expect(windows['30d'].byGroup.trigger).toBe(7);

    // untimestamped items and historical chat only appear in `all`
    expect(windows['30d'].byCategory['trigger:cron']).toBeUndefined();
    expect(windows.all.byCategory['trigger:cron']).toEqual({
      usd: 24,
      runs: 2,
    });
    expect(windows.all.byCategory['chat:historical']).toEqual({
      usd: 10,
      runs: 0,
    });
    expect(windows.all.totalUsd).toBe(
      Math.round((1 + 2 + 4 + 8 + 16 + 0.875 + 10 + 9) * 100) / 100,
    );
    expect(windows.all.runs).toBe(5 + 3 + 2);
  });

  test('daily and hourly series are zero-filled with UTC bucket keys', () => {
    const report = buildObjectiveCostReport(
      input({
        runStats: [{ timestamp: ago(HOUR), triggerType: 'x', costUsd: 1.234 }],
        chatItems: [{ at: ago(3 * DAY), usd: 2 }],
        kanbanRows: [
          { taskId: 't', projectId: 'p', usd: 5, at: ago(20 * DAY) },
        ],
      }),
      NOW,
    );

    expect(report.daily).toHaveLength(14);
    expect(report.daily[0]!.bucket).toBe('2026-10-10');
    expect(report.daily[13]).toEqual({
      bucket: '2026-10-23',
      usd: 1.23,
      trigger: 1.23,
      chat: 0,
      kanban: 0,
    });
    expect(report.daily.find((b) => b.bucket === '2026-10-20')).toMatchObject({
      usd: 2,
      chat: 2,
    });
    // 20 days ago is outside the 14-day series
    expect(report.daily.reduce((sum, b) => sum + b.kanban, 0)).toBe(0);

    expect(report.hourly).toHaveLength(24);
    expect(report.hourly[0]!.bucket).toBe('2026-10-22T11');
    expect(report.hourly[23]!.bucket).toBe('2026-10-23T10');
    expect(report.hourly[22]).toMatchObject({
      bucket: '2026-10-23T09',
      trigger: 1.23,
    });
    expect(report.hourly.filter((b) => b.usd > 0)).toHaveLength(1);
  });

  test('brain cache hit ratio is null without tokens and windowed otherwise', () => {
    expect(
      buildObjectiveCostReport(
        input({ runStats: [{ timestamp: ago(HOUR), costUsd: 1 }] }),
        NOW,
      ).windows['1d'].brainCacheHitRatio,
    ).toBeNull();

    const { windows } = buildObjectiveCostReport(
      input({
        runStats: [
          {
            timestamp: ago(HOUR),
            inputTokens: 10,
            cacheReadTokens: 80,
            cacheCreationTokens: 10,
          },
          { timestamp: ago(3 * DAY), inputTokens: 100 },
        ],
      }),
      NOW,
    );
    expect(windows['1d'].brainCacheHitRatio).toBe(0.8);
    expect(windows.all.brainCacheHitRatio).toBeCloseTo(80 / 200);
  });
});

describe('pricedChatItems', () => {
  test('raw transcript telemetry lines keep their timestamp and land in the recent windows', () => {
    const rawEntries = [
      { type: 'message', role: 'assistant' },
      {
        type: 'telemetry',
        created_at: ago(2 * HOUR),
        telemetry: { cost_usd: 1.5 },
      },
      {
        type: 'telemetry',
        created_at: ago(3 * DAY),
        telemetry: { cost_usd: 2 },
      },
    ];
    const items = pricedChatItems(rawEntries, 'conv-1');
    expect(items.map((item) => item.usd)).toEqual([1.5, 2]);
    const { windows } = buildObjectiveCostReport(
      input({ chatItems: items }),
      NOW,
    );
    expect(windows['1d'].byGroup.chat).toBe(1.5);
    expect(windows['7d'].byGroup.chat).toBe(3.5);
    expect(windows.all.byGroup.chat).toBe(3.5);
  });
});
