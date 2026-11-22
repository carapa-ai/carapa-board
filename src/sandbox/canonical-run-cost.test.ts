import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import type { RunMetrics } from '../stream/run-metrics.js';
import { canonicalizeRunResult } from './process.js';

// Run directories are read through the pinned IPC reader, which only opens
// directories below DATA_DIR/ipc.
const ipcTmp = (prefix: string) => {
  fs.mkdirSync(path.join(DATA_DIR, 'ipc'), { recursive: true });
  return path.join(DATA_DIR, 'ipc', prefix);
};

const PRICING_FILE = path.join(DATA_DIR, 'model_pricing.jsonc');

const PRICED_MODEL = 'cost-test/pi-model';
const UNPRICED_MODEL = 'unpriced/no-entry';

/**
 * Rate card installed for the duration of each test (USD per 1M tokens).
 * input 1, cachedInput 0.1, cacheWrite 2, output 2.
 */
const PRICING_FILE_CONTENTS = `${JSON.stringify({
  version: 1,
  currency: 'USD',
  models: {
    [PRICED_MODEL]: {
      input: 1,
      cachedInput: 0.1,
      cacheWrite: 2,
      output: 2,
    },
  },
})}\n`;

// Two incremental usage events emitted by the pi runner.
const FIRST_USAGE = {
  inputTokens: 100,
  outputTokens: 10,
  cachedInputTokens: 50,
  cacheWriteInputTokens: 2,
};
const SECOND_USAGE = {
  inputTokens: 200,
  outputTokens: 20,
  cachedInputTokens: 100,
  cacheWriteInputTokens: 4,
};

// Sum of both usage events, priced with the rate card above.
const SUMMED_COST_USD = (300 * 1 + 150 * 0.1 + 6 * 2 + 30 * 2) / 1_000_000; // 0.000387
// The last assistant turn alone, priced with the same rate card.
const LAST_TURN_COST_USD = (200 * 1 + 100 * 0.1 + 4 * 2 + 20 * 2) / 1_000_000; // 0.000258

interface PiRunOptions {
  /** Model recorded in the V1 manifest/run events (the merged telemetry). */
  v1Model?: string;
}

/** Writes a minimal pi V1 run dir. */
function writePiRun(
  root: string,
  options: PiRunOptions = {},
): { runDir: string } {
  const v1Model = options.v1Model ?? PRICED_MODEL;
  const runDir = path.join(root, 'run-pi-cost');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'args.json'),
    JSON.stringify({ agentCmd: 'pi', model: v1Model }),
  );
  fs.writeFileSync(
    path.join(runDir, 'output.v1.meta.json'),
    `${JSON.stringify({
      format: 'carapa-run',
      version: 1,
      harness: 'pi',
      requestedModel: v1Model,
    })}\n`,
  );
  const events = [
    { type: 'run', status: 'started', model: v1Model },
    { type: 'session', id: 'pi-session-1', status: 'started' },
    {
      type: 'message',
      id: 'message-1',
      role: 'assistant',
      content: 'First answer.',
      status: 'completed',
    },
    { type: 'usage', scope: 'incremental', ...FIRST_USAGE },
    {
      type: 'message',
      id: 'message-2',
      role: 'assistant',
      content: 'Final answer.',
      status: 'completed',
    },
    { type: 'usage', scope: 'incremental', ...SECOND_USAGE },
    { type: 'run', status: 'completed', stopReason: 'stop' },
  ];
  fs.writeFileSync(
    path.join(runDir, 'output.v1.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  return { runDir };
}

/** Installs the rate card for the test body and restores the file afterwards. */
function withPricingFile<T>(body: () => T): T {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const previous = fs.existsSync(PRICING_FILE)
    ? fs.readFileSync(PRICING_FILE)
    : null;
  fs.writeFileSync(PRICING_FILE, PRICING_FILE_CONTENTS);
  try {
    return body();
  } finally {
    if (previous === null) fs.rmSync(PRICING_FILE, { force: true });
    else fs.writeFileSync(PRICING_FILE, previous);
  }
}

const METRICS: RunMetrics = {
  version: 1,
  harness: 'pi',
  model: PRICED_MODEL,
  sessionId: 'pi-session-1',
  durationMs: 100,
  exitCode: 0,
  status: 'success',
  usage: null,
  cost: null,
  costUsd: null,
  steps: 2,
  toolCalls: [],
};

describe('canonicalizeRunResult cost', () => {
  test('prices a multi-turn pi run on the sum of all usage events', () => {
    const root = fs.mkdtempSync(ipcTmp('carapa-pi-cost-'));
    try {
      const { runDir } = writePiRun(root);
      const canonical = withPricingFile(() =>
        canonicalizeRunResult(null, runDir),
      );

      // Token totals come from the summed V1 usage events.
      expect(canonical.tok_input).toBe(300);
      expect(canonical.tok_output).toBe(30);
      expect(canonical.total_tokens).toBe(330);
      // ...and the cost is priced on those totals, not on the last turn.
      expect(canonical.cost_usd).toBeCloseTo(SUMMED_COST_USD, 12);
      expect(canonical.cost_usd).not.toBeCloseTo(LAST_TURN_COST_USD, 12);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps the runner-reported metrics cost', () => {
    const root = fs.mkdtempSync(ipcTmp('carapa-pi-cost-'));
    try {
      const { runDir } = writePiRun(root);
      const canonical = withPricingFile(() =>
        canonicalizeRunResult({ ...METRICS, costUsd: 0.000608 }, runDir),
      );

      expect(canonical.cost_usd).toBe(0.000608);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('leaves the cost undefined when the model has no pricing entry', () => {
    const root = fs.mkdtempSync(ipcTmp('carapa-pi-cost-'));
    try {
      const { runDir } = writePiRun(root, {
        v1Model: UNPRICED_MODEL,
      });
      const canonical = withPricingFile(() =>
        canonicalizeRunResult(null, runDir),
      );

      expect(canonical.cost_usd).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
