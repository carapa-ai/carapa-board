import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import {
  aggregateDailyProviderCosts,
  classifyRunProvider,
  summarizeUncostedRuns,
  type UncostedCandidateRow,
} from './run-cost-report.js';

const pricingFile = path.join(DATA_DIR, 'model_pricing.jsonc');

function writePricing(currency = 'USD') {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    pricingFile,
    JSON.stringify({
      version: 1,
      currency,
      models: { 'claude-test': { input: 1, cachedInput: 0.1, output: 5 } },
    }),
  );
}

function removePricing() {
  fs.rmSync(pricingFile, { force: true });
}

describe('run cost report', () => {
  test('classifies providers with model identity taking precedence over harness', () => {
    expect(classifyRunProvider('codex', null, 'gpt-5.6-sol')).toBe('OpenAI');
    expect(classifyRunProvider('claude', null, 'claude-sonnet-4-6')).toBe(
      'Anthropic',
    );
    expect(classifyRunProvider('claude', 'gemini-2.5-pro', null)).toBe(
      'Gemini',
    );
    expect(classifyRunProvider('claude', null, 'gemini-3-flash')).toBe(
      'Gemini',
    );
  });

  test('groups costs by local day and provider', () => {
    const report = aggregateDailyProviderCosts(
      [
        {
          startedAt: '2026-07-27T22:30:00.000Z',
          agentName: 'codex',
          model: null,
          modelName: 'gpt-5.6-sol',
          costUsd: 2,
        },
        {
          startedAt: '2026-07-27T23:30:00.000Z',
          agentName: 'claude',
          model: 'gemini-3-flash',
          modelName: null,
          costUsd: 1.5,
        },
      ],
      -120,
    );

    expect(report).toEqual([
      {
        date: '2026-07-28',
        provider: 'Gemini',
        costUsd: 1.5,
        runCount: 1,
        models: ['gemini-3-flash'],
      },
      {
        date: '2026-07-28',
        provider: 'OpenAI',
        costUsd: 2,
        runCount: 1,
        models: ['gpt-5.6-sol'],
      },
    ]);
  });

  test('uses task lifecycle date for synthetic legacy rows', () => {
    const report = aggregateDailyProviderCosts(
      [
        {
          startedAt: '2026-07-27T12:00:00.000Z',
          stage: 'legacy',
          taskCompletedAt: '2026-07-09T08:00:00.000Z',
          agentName: 'claude',
          model: 'glm-5.2:cloud',
          modelName: null,
          costUsd: 3,
        },
      ],
      0,
    );

    expect(report[0]?.date).toBe('2026-07-09');
  });

  describe('summarizeUncostedRuns', () => {
    afterAll(removePricing);

    const options = { firstDate: '2026-07-10', timezoneOffset: 0 };
    const base: UncostedCandidateRow = {
      startedAt: '2026-07-12T10:00:00.000Z',
      agentName: 'claude',
      model: null,
      modelName: 'claude-test',
      costUsd: null,
      taskId: 'task-1',
      groupFolder: 'proj',
      status: 'completed',
      stage: 'in_progress',
      tokInput: 10,
      tokOutput: 5,
    };
    const reasonOf = (row: UncostedCandidateRow) =>
      summarizeUncostedRuns([row], options)[0]?.reason;

    test('assigns a reason per unpriced row', () => {
      writePricing();
      expect(reasonOf({ ...base, status: 'running' })).toBe('running');
      expect(reasonOf({ ...base, modelName: null })).toBe('no_model');
      expect(reasonOf({ ...base, modelName: 'mystery-model' })).toBe(
        'model_not_priced',
      );
      expect(
        reasonOf({
          ...base,
          status: 'stalled',
          tokInput: null,
          tokOutput: null,
        }),
      ).toBe('no_usage_telemetry');
      expect(reasonOf(base)).toBe('other');
      removePricing();
      expect(reasonOf(base)).toBe('pricing_file_missing');
      writePricing('EUR');
      expect(reasonOf(base)).toBe('pricing_file_missing');
    });

    test('groups identical rows, excludes priced and out-of-window rows, and caps groups', () => {
      writePricing();
      const noUsage = { ...base, tokInput: null, tokOutput: null };
      const groups = summarizeUncostedRuns(
        [
          { ...noUsage, taskId: 'task-1' },
          { ...noUsage, taskId: 'task-2' },
          { ...noUsage, costUsd: 1 },
          { ...noUsage, startedAt: '2026-07-01T10:00:00.000Z' },
        ],
        options,
      );
      expect(groups).toEqual([
        {
          date: '2026-07-12',
          source: 'task',
          agentName: 'claude',
          model: 'claude-test',
          stage: 'in_progress',
          status: 'completed',
          reason: 'no_usage_telemetry',
          count: 2,
          examples: [
            { id: 'task-1', groupFolder: 'proj' },
            { id: 'task-2', groupFolder: 'proj' },
          ],
        },
      ]);

      const many = Array.from({ length: 5 }, (_, i) => ({
        ...noUsage,
        agentName: `agent-${i}`,
      }));
      expect(
        summarizeUncostedRuns(many, { ...options, limit: 3 }),
      ).toHaveLength(3);
    });
  });
});
