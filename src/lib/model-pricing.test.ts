import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import {
  aggregateConversationCost,
  calculateTelemetryCostUsd,
} from './model-pricing.js';

describe('model pricing', () => {
  const file = path.join(DATA_DIR, 'model_pricing.jsonc');

  afterEach(() => {
    try {
      fs.unlinkSync(file);
    } catch {}
  });

  it('matches provider model names case-insensitively and backfills telemetry cost', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        currency: 'USD',
        models: {
          'gpt-5.6-luna': { input: 1, cachedInput: 0.1, output: 6 },
        },
      }),
    );

    expect(
      calculateTelemetryCostUsd({
        model_name: 'GPT-5.6-luna',
        tok_input: 1_000,
        inputTokenSemantics: 'total',
        tok_cache_read: 600,
        tok_output: 100,
      }),
    ).toBe(0.00106);
  });

  it('prices output-only Codex telemetry as a historical estimate', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        currency: 'USD',
        models: {
          'gpt-5.6-luna': { input: 1, cachedInput: 0.1, output: 6 },
        },
      }),
    );

    expect(
      calculateTelemetryCostUsd({
        model_name: 'gpt-5.6-luna',
        tok_output: 5,
        usageSource: 'estimated',
      }),
    ).toBe(0.00003);
  });

  it('aggregates telemetry attached directly to normal conversation messages', () => {
    expect(
      aggregateConversationCost([
        { telemetry: { cost_usd: 0.0242638, usageSource: 'reported' } },
        { telemetry: { cost_usd: 0.0797208, usageSource: 'reported' } },
      ]),
    ).toEqual({
      costUsd: 0.1039846,
      costEstimated: false,
    });
  });

  it('includes hidden conversation operations in the conversation total', () => {
    expect(
      aggregateConversationCost([
        {
          telemetry: {
            operation: 'conversation_rename',
            cost_usd: 0.00125,
          },
        },
      ]),
    ).toEqual({
      costUsd: 0.00125,
      costEstimated: false,
    });
  });

  it('marks a conversation total estimated when any priced historical turn is estimated', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        currency: 'USD',
        models: {
          'gpt-5.6-luna': { input: 1, cachedInput: 0.1, output: 6 },
        },
      }),
    );

    expect(
      aggregateConversationCost([
        { telemetry: { cost_usd: 0.01, usageSource: 'reported' } },
        {
          telemetry: {
            model_name: 'gpt-5.6-luna',
            tok_output: 5,
            usageSource: 'estimated',
          },
        },
      ]),
    ).toEqual({
      costUsd: 0.01003,
      costEstimated: true,
    });
  });

  it('excludes transcript entries inherited before a fork boundary', () => {
    expect(
      aggregateConversationCost(
        [
          {
            created_at: '2026-07-28T10:00:00.000Z',
            telemetry: { cost_usd: 2 },
          },
          {
            created_at: '2026-07-28T10:01:00.000Z',
            telemetry: { cost_usd: 0.5 },
          },
        ],
        { after: '2026-07-28T10:00:30.000Z' },
      ),
    ).toEqual({
      costUsd: 0.5,
      costEstimated: false,
    });
  });
});
