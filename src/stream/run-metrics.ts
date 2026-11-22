import fs from 'node:fs';
import path from 'node:path';
import type { RunTokenStats } from '../db.js';
import { calculateTelemetryCostUsd } from '../lib/model-pricing.js';

export interface RunMetrics {
  version: 1;
  harness: string | null;
  model: string | null;
  sessionId: string | null;
  durationMs: number | null;
  promptDispatchedAtMs?: number | null;
  firstOutputAtMs?: number | null;
  timeToFirstOutputMs?: number | null;
  exitCode: number;
  status: 'success' | 'error';
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    cacheWriteTokens: number | null;
    reasoningOutputTokens: number | null;
    raw: unknown;
  } | null;
  cost: {
    amount: number;
    currency: string;
    pricingModel: string;
    source: string;
  } | null;
  costUsd: number | null;
  steps: number;
  toolCalls: Array<{
    id: string | null;
    name: string;
    kind: string;
    input: Record<string, unknown>;
  }>;
}

export function readRunMetrics(runDir: string): RunMetrics | null {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(runDir, 'metrics.json'), 'utf8'),
    ) as RunMetrics;
    return value.version === 1 ? value : null;
  } catch {
    return null;
  }
}

/** Overlay canonical runner measurements while preserving parser-owned display text. */
export function applyRunMetrics<
  T extends RunTokenStats & { session_id?: string },
>(
  parsed: T,
  metrics: RunMetrics | null | undefined,
): T & { cost_usd?: number } {
  if (!metrics) {
    return {
      ...parsed,
      cost_usd:
        parsed.cost_usd ??
        calculateTelemetryCostUsd(
          parsed as unknown as Record<string, unknown>,
        ) ??
        undefined,
    };
  }
  const usage = metrics.usage;
  const merged = {
    ...parsed,
    session_id: metrics.sessionId ?? parsed.session_id,
    model_name: metrics.model ?? parsed.model_name,
    // A metrics sidecar can legitimately have usage=null (for example when a
    // CLI did not emit provider usage). In that case retain the already
    // collected estimated/reported fallback instead of erasing it with undefined.
    tok_input: usage?.inputTokens ?? parsed.tok_input,
    inputTokenSemantics:
      usage?.inputTokens != null
        ? metrics.harness === 'codex'
          ? ('total' as const)
          : metrics.harness === 'pi'
            ? ('fresh' as const)
            : parsed.inputTokenSemantics
        : parsed.inputTokenSemantics,
    tok_output: usage?.outputTokens ?? parsed.tok_output,
    tok_cache_read: usage?.cachedInputTokens ?? parsed.tok_cache_read,
    tok_cache_write: usage?.cacheWriteTokens ?? parsed.tok_cache_write,
    tok_reasoning: usage?.reasoningOutputTokens ?? parsed.tok_reasoning,
    total_tokens: usage
      ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      : parsed.total_tokens,
    tool_usage_count:
      metrics.toolCalls.length > 0
        ? metrics.toolCalls.length
        : parsed.tool_usage_count,
    cost_usd: metrics.costUsd ?? parsed.cost_usd,
    prompt_dispatched_at_ms:
      metrics.promptDispatchedAtMs ?? parsed.prompt_dispatched_at_ms,
    first_output_at_ms: metrics.firstOutputAtMs ?? parsed.first_output_at_ms,
    time_to_first_output_ms:
      metrics.timeToFirstOutputMs ?? parsed.time_to_first_output_ms,
    usageSource: usage ? 'reported' : parsed.usageSource,
  };
  return {
    ...merged,
    // Interrupted agents do not always emit provider cost. If token telemetry
    // survived the clean stop, price it locally instead of leaving the run
    // uncosted.
    cost_usd:
      merged.cost_usd ??
      calculateTelemetryCostUsd(merged as unknown as Record<string, unknown>) ??
      undefined,
  };
}
