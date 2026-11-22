import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { applyRunMetrics, type RunMetrics } from './run-metrics.js';

describe('applyRunMetrics', () => {
  it('overlays canonical measurements without changing rendered output', () => {
    const parsed: any = {
      result: 'hello',
      hasAssistantText: true,
      tok_input: 1,
      tok_output: 2,
      tok_cache_read: undefined,
      tok_cache_write: undefined,
      tok_reasoning: undefined,
      tok_context_last: undefined,
      total_tokens: 3,
      model_name: undefined,
      tool_usage_count: 0,
      usageSource: undefined,
      rawUsage: undefined,
      session_id: 'old',
    };
    const metrics: RunMetrics = {
      version: 1,
      harness: 'codex',
      model: 'gpt-5',
      sessionId: 'thread-1',
      durationMs: 1200,
      promptDispatchedAtMs: 1_000,
      firstOutputAtMs: 1_275,
      timeToFirstOutputMs: 275,
      exitCode: 0,
      status: 'success',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 60,
        cacheWriteTokens: 0,
        reasoningOutputTokens: 5,
        raw: { input_tokens: 100 },
      },
      cost: {
        amount: 0.000535,
        currency: 'USD',
        pricingModel: 'gpt-5',
        source: 'model_pricing.jsonc',
      },
      costUsd: 0.000535,
      steps: 4,
      toolCalls: [{ id: '1', name: 'recall', kind: 'mcp', input: {} }],
    };

    const result = applyRunMetrics(parsed, metrics);
    expect(result.result).toBe('hello');
    expect(result.session_id).toBe('thread-1');
    expect(result.model_name).toBe('gpt-5');
    expect(result.total_tokens).toBe(120);
    expect(result.tok_cache_read).toBe(60);
    expect(result.tool_usage_count).toBe(1);
    expect(result.usageSource).toBe('reported');
    expect(result.cost_usd).toBe(0.000535);
    expect(result.prompt_dispatched_at_ms).toBe(1_000);
    expect(result.first_output_at_ms).toBe(1_275);
    expect(result.time_to_first_output_ms).toBe(275);
  });

  it('retains parser fallback telemetry when the metrics sidecar has no usage', () => {
    const parsed = {
      result: 'fallback output',
      tok_output: 123,
      total_tokens: 123,
      tool_usage_count: 4,
      usageSource: 'estimated' as const,
      cost_usd: 0.01,
    };
    const metrics = {
      version: 1 as const,
      harness: 'codex',
      model: null,
      sessionId: null,
      durationMs: 100,
      exitCode: 0,
      status: 'success' as const,
      usage: null,
      cost: null,
      costUsd: null,
      steps: 0,
      toolCalls: [],
    };

    const result = applyRunMetrics(parsed, metrics);

    expect(result.tok_output).toBe(123);
    expect(result.total_tokens).toBe(123);
    expect(result.tool_usage_count).toBe(4);
    expect(result.usageSource).toBe('estimated');
    expect(result.cost_usd).toBe(0.01);
  });

  it('prices surviving token telemetry when an interrupted run has no provider cost', () => {
    const pricingFile = path.join(DATA_DIR, 'model_pricing.jsonc');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      pricingFile,
      JSON.stringify({
        version: 1,
        currency: 'USD',
        models: {
          'gpt-5.6-sol': { input: 2, cachedInput: 0.2, output: 8 },
        },
      }),
    );
    try {
      const result = applyRunMetrics(
        {
          model_name: 'gpt-5.6-sol',
          tok_output: 28_000,
          usageSource: 'estimated' as const,
        },
        {
          version: 1,
          harness: 'codex',
          model: 'gpt-5.6-sol',
          sessionId: 'session-1',
          durationMs: 280_000,
          exitCode: 0,
          status: 'success',
          usage: null,
          cost: null,
          costUsd: null,
          steps: 34,
          toolCalls: [],
        },
      );

      expect(result.cost_usd).toBe(0.224);
    } finally {
      fs.unlinkSync(pricingFile);
    }
  });
});
