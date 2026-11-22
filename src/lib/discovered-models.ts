/**
 * Catalog models generated from board_agents.discovered.json for harnesses
 * with a `discover` block. board_agents.jsonc stays authoritative: a model or
 * binding written there overrides the generated fields.
 */
import fs from 'fs';

export const DISCOVERY_FILE_NAME = 'board_agents.discovered.json';

/** A model reported by a provider account (CarapaBox) or by a harness itself. */
export interface DiscoveredModel {
  id: string;
  name?: string;
  contextSize?: number;
  reasoning?: string[];
  defaultReasoning?: string;
  inputs?: string[];
  /** Name the harness must send when the relay serves this model under another one. */
  harnessModel?: string;
}
export interface DiscoverySource {
  at: number;
  models: DiscoveredModel[];
  /** Seen before but no longer offered; kept so pinned models keep working. */
  retired?: DiscoveredModel[];
}
export interface DiscoveryCache {
  version: 1;
  /** Keyed by provider (anthropic, codex, antigravity, ...). */
  accounts: Record<string, DiscoverySource>;
  /** Keyed by harness id. */
  harnesses: Record<string, DiscoverySource>;
}
export type DiscoveryFlag = 'discovered' | 'unavailable';

/** A missing or damaged cache only means nothing has been discovered yet. */
export function readDiscoveryCache(file: string): DiscoveryCache | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value?.version === 1 && value.accounts && value.harnesses
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** `discover` block keys besides ordinary binding settings. */
export const DISCOVER_KEYS = [
  'account',
  'from',
  'model',
  'capabilities',
  'reasoning',
  'effortVariants',
];

type Json = Record<string, any>;

// Harnesses report efforts in their own order; the picker lists them weakest first.
const EFFORT_ORDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];
const ordered = (efforts: string[] | undefined) =>
  efforts?.every((e) => EFFORT_ORDER.includes(e))
    ? [...efforts].sort(
        (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b),
      )
    : efforts;
// "muse-spark-1.3" -> "Muse Spark 1.3", for harnesses that report ids only.
const readable = (id: string) =>
  id
    .split('-')
    .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
// Cursor appends its settings to a model id ("claude-opus-5-5[effort=high]");
// the catalog keys the model by its name and sends the full id to the harness.
const baseId = (id: string) => id.replace(/\[[^\]]*\]$/, '');
// Same rule as the catalog loader's ids; anything else would reject the catalog.
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// Some harnesses repeat the id as its name.
const named = (m: DiscoveredModel | undefined) =>
  m?.name && m.name !== m.id && m.name !== baseId(m.id) ? m.name : undefined;

interface Candidate {
  key: string;
  label: string;
  bindingModel: string;
  offered: boolean;
  contextSize?: number;
  reasoning?: string[];
  defaultReasoning?: string;
  inputs?: string[];
  /** Harness model for each reasoning choice, when variants were merged. */
  variantModels?: Record<string, string>;
}

/**
 * Antigravity lists one model per effort ("gemini-3.8-flash-low", "-high").
 * Merge them into one model whose reasoning picker chooses the variant.
 */
function mergeEffortVariants(
  list: Candidate[],
  efforts: string[],
): Candidate[] {
  const suffix = new RegExp(`^(.+)-(${efforts.join('|')})$`);
  const groups = new Map<string, Map<string, Candidate>>();
  const merged: Array<Candidate | string> = [];
  for (const c of list) {
    const match = suffix.exec(c.key);
    if (!match) {
      merged.push(c);
      continue;
    }
    let group = groups.get(match[1]);
    if (!group) {
      group = new Map();
      groups.set(match[1], group);
      merged.push(match[1]);
    }
    if (!group.has(match[2])) group.set(match[2], c);
  }
  return merged.map((item) => {
    if (typeof item !== 'string') return item;
    const members = efforts.flatMap((e) => {
      const c = groups.get(item)!.get(e);
      return c ? [[e, c] as const] : [];
    });
    const available = members.filter(([, c]) => c.offered);
    const choices = available.length ? available : members;
    const chosen = choices.find(([e]) => e === 'medium') ?? choices[0];
    const first = chosen[1];
    return {
      ...first,
      key: item,
      label: first.label.replace(
        new RegExp(`\\s*\\(?(?:${efforts.join('|')})\\)?$`, 'i'),
        '',
      ),
      bindingModel: first.bindingModel,
      offered: available.length > 0,
      reasoning: choices.map(([e]) => e),
      defaultReasoning: chosen[0],
      variantModels: Object.fromEntries(
        choices.map(([e, c]) => [e, c.bindingModel]),
      ),
    };
  });
}

function candidates(
  harnessId: string,
  discover: Json,
  cache: DiscoveryCache,
): Candidate[] {
  const account = discover.account
    ? cache.accounts[discover.account]
    : undefined;
  const listed = cache.harnesses[harnessId];
  const result: Candidate[] = [];
  if (listed) {
    // The harness only accepts its own names. Where the account's list is
    // known, keep the names it serves and use the account's id and details.
    const served = account
      ? new Map(
          [
            ...account.models.map((m) => [m, true] as const),
            ...(account.retired || []).map((m) => [m, false] as const),
          ].map(([m, offered]) => [m.harnessModel ?? m.id, { m, offered }]),
        )
      : undefined;
    for (const [h, listedNow] of [
      ...listed.models.map((m) => [m, true] as const),
      ...(listed.retired || []).map((m) => [m, false] as const),
    ]) {
      const match = served?.get(h.id);
      if (served && !match) continue;
      const a = match?.m;
      result.push({
        key: a?.id ?? baseId(h.id),
        label: named(a) ?? named(h) ?? readable(a?.id ?? baseId(h.id)),
        bindingModel: h.id,
        offered: listedNow && (match?.offered ?? true),
        contextSize: a?.contextSize ?? h.contextSize,
        reasoning: ordered(h.reasoning ?? a?.reasoning),
        defaultReasoning: h.defaultReasoning ?? a?.defaultReasoning,
        inputs: a?.inputs ?? h.inputs,
      });
    }
  } else if (account && discover.from !== 'harness') {
    // `from: "harness"` harnesses accept only their own names, so they get
    // nothing from the account alone until they report a list.
    for (const [a, offered] of [
      ...account.models.map((m) => [m, true] as const),
      ...(account.retired || []).map((m) => [m, false] as const),
    ]) {
      result.push({
        key: a.id,
        label: named(a) ?? readable(a.id),
        bindingModel: a.id,
        offered,
        contextSize: a.contextSize,
        reasoning: ordered(a.reasoning),
        defaultReasoning: a.defaultReasoning,
        inputs: a.inputs,
      });
    }
  }
  return result;
}

// claude-opus-5-5 -> family "claude-opus-#", version [5, 5];
// gemini-3.8-flash-high -> "gemini-#-flash-high", [3, 8].
function versioned(id: string): { family: string; version: number[] } {
  const match = /\d+(?:[.-]\d+)*/.exec(id);
  if (!match) return { family: id, version: [] };
  return {
    family:
      id.slice(0, match.index) + '#' + id.slice(match.index + match[0].length),
    version: match[0].split(/[.-]/).map(Number),
  };
}
function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) > (b[i] ?? -1);
  }
  return false;
}
/** Only the newest offered model of each family is added on its own. */
function newestOffered(list: Candidate[]): Set<string> {
  const best = new Map<string, { key: string; version: number[] }>();
  for (const c of list) {
    if (!c.offered) continue;
    const { family, version } = versioned(c.key);
    const current = best.get(family);
    if (!current || newer(version, current.version))
      best.set(family, { key: c.key, version });
  }
  return new Set([...best.values()].map((v) => v.key));
}

/** Model ids named by defaults, presets, Auto tiers or fallbacks. */
function referencedModels(raw: Json): Set<string> {
  const ids = new Set<string>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'modelId' && typeof item === 'string') ids.add(item);
      else walk(item);
    }
  };
  walk(raw.defaults);
  walk(raw.presets);
  for (const model of Object.values<Json>(raw.models || {})) {
    if (typeof model?.fallbackModel === 'string') ids.add(model.fallbackModel);
    if (model?.auto)
      for (const binding of Object.values<Json>(model.bindings || {}))
        for (const id of Object.values(binding?.tiers || {}))
          if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

function mergeModel(generated: Json, existing: Json | undefined): Json {
  if (!existing) return generated;
  const bindings: Json = { ...generated.bindings };
  for (const [harnessId, binding] of Object.entries<Json>(
    existing.bindings || {},
  )) {
    const base = bindings[harnessId];
    bindings[harnessId] = base
      ? {
          ...base,
          ...binding,
          ...(base.env || binding?.env
            ? { env: { ...base.env, ...binding?.env } }
            : {}),
        }
      : binding;
  }
  return { ...generated, ...existing, bindings };
}

export function applyDiscoveredModels(
  raw: any,
  cache: DiscoveryCache | undefined,
): { raw: any; flags: Record<string, DiscoveryFlag> } {
  const flags: Record<string, DiscoveryFlag> = {};
  if (!cache || !raw?.harnesses || !raw?.models) return { raw, flags };
  const offered = new Set<string>();
  const referenced = referencedModels(raw);
  const models: Json = { ...raw.models };
  for (const [harnessId, harness] of Object.entries<Json>(raw.harnesses)) {
    const discover = harness?.discover;
    if (!discover) continue;
    const found = candidates(harnessId, discover, cache);
    const list = Array.isArray(discover.effortVariants)
      ? mergeEffortVariants(found, discover.effortVariants)
      : found;
    const newest = newestOffered(list);
    for (const c of list) if (c.offered) offered.add(c.key);
    const seen = new Set<string>();
    for (const c of list) {
      if (seen.has(c.key) || !VALID_ID.test(c.key)) continue;
      seen.add(c.key);
      const curated = raw.models[c.key];
      if (!newest.has(c.key) && !referenced.has(c.key) && !curated) continue;
      const settings = Object.fromEntries(
        Object.entries(discover).filter(([k]) => !DISCOVER_KEYS.includes(k)),
      );
      const contextSize = settings.contextSize ?? c.contextSize;
      const binding: Json = {
        ...settings,
        model:
          typeof discover.model === 'string'
            ? discover.model.replaceAll('${id}', c.bindingModel)
            : c.bindingModel,
        ...(contextSize ? { contextSize } : {}),
      };
      const reasoning =
        discover.reasoning ??
        (c.reasoning?.length
          ? {
              options: c.reasoning,
              ...(c.defaultReasoning && c.reasoning.includes(c.defaultReasoning)
                ? { default: c.defaultReasoning }
                : {}),
              ...(c.variantModels ? { models: c.variantModels } : {}),
            }
          : undefined);
      const capabilities = [
        ...new Set([
          ...(discover.capabilities || []),
          ...(c.inputs?.includes('image') ? ['image'] : []),
        ]),
      ];
      models[c.key] = mergeModel(
        {
          label: c.label,
          ...(capabilities.length ? { capabilities } : {}),
          // Merged variants are specific to this harness; another harness
          // listing the same model keeps its own reasoning.
          ...(reasoning && !c.variantModels ? { reasoning } : {}),
          bindings: {
            [harnessId]: c.variantModels ? { ...binding, reasoning } : binding,
          },
        },
        models[c.key],
      );
      if (!c.offered) flags[c.key] = 'unavailable';
      else if (!curated && !flags[c.key]) flags[c.key] = 'discovered';
    }
  }
  for (const key of offered) {
    if (flags[key] !== 'unavailable') continue;
    if (raw.models[key]) delete flags[key];
    else flags[key] = 'discovered';
  }
  return { raw: { ...raw, models }, flags };
}
