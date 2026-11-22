import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { escapeRegex } from '../utils.js';
import { parseJsonc } from './jsonc.js';

interface Rate {
  aliases?: string[];
  input: number;
  cachedInput: number;
  cacheWrite?: number;
  output: number;
}
interface PricingFile {
  version: 1;
  currency: string;
  models: Record<string, Rate>;
}

// Keep newly released provider models usable before the operator's local
// pricing file is refreshed. Explicit entries in model_pricing.jsonc still
// take precedence over these defaults.
const BUILT_IN_MODEL_RATES: Record<string, Rate> = {
  'gpt-6-astra': {
    aliases: ['*/gpt-6-astra'],
    input: 10,
    cachedInput: 1,
    cacheWrite: 12.5,
    output: 50,
  },
};

const pricingPath = path.join(DATA_DIR, 'model_pricing.jsonc');
let pricingCache:
  | { mtimeMs: number; size: number; pricing: PricingFile | null }
  | undefined;

export function getModelPricingConfig(): PricingFile | null {
  try {
    const { mtimeMs, size } = fs.statSync(pricingPath);
    if (pricingCache?.mtimeMs === mtimeMs && pricingCache.size === size)
      return pricingCache.pricing;
    let pricing: PricingFile | null = null;
    try {
      const parsed = parseJsonc(
        fs.readFileSync(pricingPath, 'utf8'),
      ) as PricingFile;
      pricing = {
        ...parsed,
        models: { ...BUILT_IN_MODEL_RATES, ...parsed.models },
      };
    } catch {
      // Retry when the invalid file changes.
    }
    pricingCache = { mtimeMs, size, pricing };
    return pricing;
  } catch {
    pricingCache = undefined;
    return null;
  }
}

function wildcardMatches(pattern: string, value: string): boolean {
  const escaped = escapeRegex(pattern).replaceAll('\\*', '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

export function calculateModelCostUsd(
  model: string | null | undefined,
  usage: {
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    cacheWriteTokens?: number | null;
    outputTokens?: number | null;
  },
): number | null {
  if (!model) return null;
  const pricing = getModelPricingConfig();
  if (!pricing) return null;
  // Claude Code reports context-window variants such as `claude-haiku-5-5[1m]`;
  // price them with the base model's entry.
  model = model.replace(/\[[^\]]*\]$/, '');
  const normalizedModel = model.toLowerCase();
  const exactEntry = Object.entries(pricing.models).find(
    ([id]) => id.toLowerCase() === normalizedModel,
  );
  const exact = exactEntry?.[1];
  const matched = exact
    ? exact
    : Object.values(pricing.models).find((rate) =>
        rate.aliases?.some((alias) => wildcardMatches(alias, model)),
      );
  if (!matched || pricing.currency !== 'USD') return null;
  return (
    ((usage.inputTokens ?? 0) * matched.input +
      (usage.cachedInputTokens ?? 0) * matched.cachedInput +
      (usage.cacheWriteTokens ?? 0) * (matched.cacheWrite ?? matched.input) +
      (usage.outputTokens ?? 0) * matched.output) /
    1_000_000
  );
}

export function calculateTelemetryCostUsd(
  telemetry: Record<string, unknown>,
): number | null {
  if (
    typeof telemetry.cost_usd === 'number' &&
    Number.isFinite(telemetry.cost_usd)
  ) {
    return telemetry.cost_usd;
  }
  const model =
    typeof telemetry.model_name === 'string' ? telemetry.model_name : null;
  const hasInput = typeof telemetry.tok_input === 'number';
  const hasOutput = typeof telemetry.tok_output === 'number';
  if (!hasInput && !hasOutput) return null;
  const totalInput =
    typeof telemetry.tok_input === 'number' ? telemetry.tok_input : 0;
  const cachedInput =
    typeof telemetry.tok_cache_read === 'number' ? telemetry.tok_cache_read : 0;
  // Only total-input counters include cache reads; fresh counters are already net.
  const freshInput =
    telemetry.inputTokenSemantics === 'total'
      ? Math.max(0, totalInput - cachedInput)
      : totalInput;
  return calculateModelCostUsd(model, {
    inputTokens: freshInput,
    cachedInputTokens: cachedInput,
    cacheWriteTokens:
      typeof telemetry.tok_cache_write === 'number'
        ? telemetry.tok_cache_write
        : 0,
    outputTokens:
      typeof telemetry.tok_output === 'number' ? telemetry.tok_output : 0,
  });
}

function telemetryCostIsEstimated(telemetry: Record<string, unknown>): boolean {
  return (
    telemetry.cost_estimated === true ||
    (typeof telemetry.cost_usd !== 'number' &&
      (telemetry.usageSource === 'estimated' ||
        typeof telemetry.tok_input !== 'number'))
  );
}

type TimedEntry = {
  telemetry?: Record<string, unknown>;
  created_at?: string;
  timestamp?: string;
};

/**
 * Entries created after `after`. Forks retain the source transcript for
 * context, so their own entries start at the fork boundary; entries without a
 * parseable timestamp are kept.
 */
export function entriesAfter<T extends TimedEntry>(
  entries: T[],
  after?: string | null,
): T[] {
  const afterMs = after ? Date.parse(after) : null;
  if (afterMs === null) return entries;
  return entries.filter((entry) => {
    const entryTimestamp = entry.created_at ?? entry.timestamp;
    const entryMs = entryTimestamp ? Date.parse(entryTimestamp) : NaN;
    return !(Number.isFinite(entryMs) && entryMs <= afterMs);
  });
}

export function aggregateConversationCost(
  entries: TimedEntry[],
  options?: { after?: string | null },
): { costUsd: number | null; costEstimated: boolean } {
  let total = 0;
  let measured = false;
  let estimated = false;
  for (const entry of entriesAfter(entries, options?.after)) {
    if (!entry.telemetry) continue;
    const cost = calculateTelemetryCostUsd(entry.telemetry);
    if (cost == null) continue;
    total += cost;
    measured = true;
    estimated ||= telemetryCostIsEstimated(entry.telemetry);
  }
  return {
    costUsd: measured ? total : null,
    costEstimated: measured && estimated,
  };
}
