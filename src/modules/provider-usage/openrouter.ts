import { getChatAgents, type ChatAgentOption } from '../../lib/chat-agents.js';

export interface OpenRouterModelPrice {
  model: string;
  name: string;
  /** US dollars per million tokens. */
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
}

const amount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/**
 * Prices for the models Board offers through OpenRouter (bindings that use
 * the relay's /openrouter route), taken from the list CarapaBox recorded.
 * Models missing from that list are omitted.
 */
export function openRouterModelPrices(
  recorded: any,
  agents?: ChatAgentOption[],
): OpenRouterModelPrice[] | undefined {
  const listed = recorded?.models;
  if (!listed || typeof listed !== 'object') return undefined;
  const ids = new Set<string>();
  for (const agent of agents ?? getChatAgents()) {
    if (!agent.baseUrl?.includes('/openrouter/') || !agent.model) continue;
    ids.add(agent.model.replace(/^carapa-openrouter\//, ''));
  }
  const prices: OpenRouterModelPrice[] = [];
  for (const model of [...ids].sort()) {
    if (!Object.hasOwn(listed, model)) continue;
    const entry = listed[model];
    const input = amount(entry?.input);
    const output = amount(entry?.output);
    if (input === undefined || output === undefined) continue;
    prices.push({
      model,
      name: typeof entry.name === 'string' ? entry.name : model,
      inputPerMillion: input,
      outputPerMillion: output,
      cacheReadPerMillion: amount(entry.cacheRead),
    });
  }
  return prices;
}

/** Allow-listed OpenRouter credit balance (US dollars) from a Box usage entry. */
export function openRouterCredits(credits: any):
  | {
      totalCredits: number;
      totalUsage: number;
      remaining: number;
      fetchedAt?: number;
    }
  | undefined {
  const totalCredits = amount(credits?.totalCredits);
  const totalUsage = amount(credits?.totalUsage);
  if (totalCredits === undefined || totalUsage === undefined) return undefined;
  return {
    totalCredits,
    totalUsage,
    remaining: totalCredits - totalUsage,
    fetchedAt: amount(credits.fetchedAt),
  };
}

/** Replaces Box's full OpenRouter price list with the models Board offers. */
export function withOpenRouterModels(usageBody: any): any {
  if (!usageBody || typeof usageBody !== 'object') return usageBody;
  const { openRouterPrices, ...rest } = usageBody;
  const openRouterModels = openRouterModelPrices(openRouterPrices);
  return openRouterModels ? { ...rest, openRouterModels } : rest;
}
