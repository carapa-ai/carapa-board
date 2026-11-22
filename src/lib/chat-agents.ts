import { runtimeChanges } from './runtime-changes.js';
import fs from 'fs';
import path from 'path';
import { parseJsonc } from './jsonc.js';
import {
  DISCOVER_KEYS,
  DISCOVERY_FILE_NAME,
  applyDiscoveredModels,
  readDiscoveryCache,
  type DiscoveryCache,
} from './discovered-models.js';
import {
  DATA_DIR,
  MODEL_ROUTING_ENGINE,
  PRIVACY_LOCAL_ENDPOINT_PREFIXES,
} from '../config.js';
import type { ModelRoutingEngine } from '../config.js';
import type { StageType } from '../modules/kanban/types.js';
import { logger } from '../logger.js';
import type { ModelTier } from './model-router.js';
import { isRecord } from './type-guards.js';

export interface RuntimeSelection {
  harnessId: string;
  modelId: string;
  reasoning?: string;
  /** Optional sampling override carried by presets and resolved onto Direct runtimes. */
  temperature?: number;
}
/** Model ID of the catalog's Jev-routed pseudo-model. */
export const AUTO_MODEL_ID = 'auto';
const AUTO_TIERS: readonly ModelTier[] = ['fast', 'balanced', 'frontier'];

/** A concrete enabled binding that a routing tier may run on. */
export interface AutoCandidate {
  harnessId: string;
  modelId: string;
  /** The candidate's own reasoning choices, never shared across harnesses. */
  reasoningOptions: string[];
  reasoningDefault?: string;
}
export interface AutoBinding {
  /** Ordered candidates per tier; resolution uses the first. */
  tiers: Record<ModelTier, AutoCandidate[]>;
  /** Reasoning choices Auto offers. */
  reasoning: RuntimeReasoning;
  /**
   * True when every tier is a single model on this binding's harness. Such a
   * binding accepts only reasoning every tier model supports. Otherwise a
   * candidate that lacks the requested reasoning runs on its default.
   */
  strictReasoning: boolean;
}
/** Valid Auto bindings keyed by harness ID, independent of `MODEL_ROUTING_ENGINE`. */
export type AutoTierMaps = ReadonlyMap<string, AutoBinding>;

/** Parse a `"<harnessId>:<modelId>"` tier candidate; undefined when malformed. */
function parseAutoCandidate(
  entry: unknown,
): { harnessId: string; modelId: string } | undefined {
  if (typeof entry !== 'string') return undefined;
  const separator = entry.indexOf(':');
  if (separator <= 0 || separator === entry.length - 1) return undefined;
  return {
    harnessId: entry.slice(0, separator),
    modelId: entry.slice(separator + 1),
  };
}

function toAutoCandidate(
  harnessId: string,
  modelId: string,
  agent: ChatAgentOption,
): AutoCandidate {
  return {
    harnessId,
    modelId,
    reasoningOptions: [...(agent.reasoningOptions ?? [])],
    reasoningDefault: agent.reasoningDefault,
  };
}
interface BoardAgentsSnapshot {
  agents: ChatAgentOption[];
  catalog: RuntimeCatalog;
  autoTiers: AutoTierMaps;
}
type LayeredRuntimeSelection = Omit<RuntimeSelection, 'reasoning'> & {
  reasoning?: string | null;
};
export interface RuntimeReasoning {
  options: string[];
  default?: string;
  map?: Record<string, string | null>;
  envVar?: string;
  /** Harness model to run for each choice, for harnesses that encode the effort in the model name. */
  models?: Record<string, string>;
}
export interface RuntimeDefaultPolicy {
  chat: RuntimeSelection;
  kanban: {
    fallback: RuntimeSelection;
    stages: Record<string, RuntimeSelection>;
  };
  observer?: RuntimeSelection;
  curator?: RuntimeSelection;
  reflector?: RuntimeSelection;
  transcription?: RuntimeSelection;
  imageOcr?: RuntimeSelection;
  peekFiles?: RuntimeSelection;
  commitMessage?: RuntimeSelection;
  auditMemories?: RuntimeSelection;
  publicSafetyJudge?: RuntimeSelection;
}

export type RuntimeLocality = 'local' | 'remote';

export interface ChatAgentOption {
  id: string;
  label: string;
  baseUrl?: string;
  model?: string;
  agentCmd?: string;
  agent?: string;
  bare?: boolean;
  apiKey?: string;
  wireApi?: 'chat_completions' | 'responses';
  env?: Record<string, string>;
  context_size?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  extra_body?: Record<string, any>;
  reasoning_effort?: string;
  image?: boolean;
  audio?: boolean;
  video?: boolean;
  apiFormat?: 'openai' | 'ollama';
  /** Declared by board_agents; see `getRuntimeLocality` for the effective value. */
  locality?: RuntimeLocality;
  /** v2 compatibility metadata. Existing consumers may keep using the fields above. */
  harnessId?: string;
  /** Runtime transport selected by the v2 harness. */
  harnessKind?: 'direct' | 'cli';
  modelId?: string;
  sessionFamily?: string;
  reasoningOptions?: string[];
  reasoningDefault?: string;
  reasoningMap?: Record<string, string | null>;
  reasoningEnvVar?: string;
  reasoningModels?: Record<string, string>;
  /** One-hop, same-harness capacity fallback resolved from the model catalog. */
  fallback?: ChatAgentOption;
}

/** Only direct harnesses may use the DirectLLM HTTP transport. */
export function isDirectRuntime(
  agent: Pick<ChatAgentOption, 'harnessKind'>,
): boolean {
  return agent.harnessKind === 'direct';
}

export function directRuntimeBaseUrl(
  agent: Pick<ChatAgentOption, 'baseUrl' | 'env'>,
): string | undefined {
  return (
    agent.baseUrl || agent.env?.OPENAI_BASE_URL || agent.env?.ANTHROPIC_BASE_URL
  );
}

function endpointParts(url: string): { origin: string; path: string } | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.origin === 'null') return null;
    return { origin: parsed.origin, path: parsed.pathname.replace(/\/+$/, '') };
  } catch {
    return null;
  }
}

/**
 * True when `url` falls under one of the configured local endpoint prefixes.
 * Compares scheme + host + port, then whole path segments, so a prefix ending
 * in `/laya` matches `/laya` and `/laya/v1` but not `/layax` or `/anthropic`.
 */
export function isLocalEndpoint(
  url: string,
  prefixes: readonly string[] = PRIVACY_LOCAL_ENDPOINT_PREFIXES,
): boolean {
  const target = endpointParts(url);
  if (!target) return false;
  return prefixes.some((prefix) => {
    const allowed = endpointParts(prefix);
    return (
      !!allowed &&
      allowed.origin === target.origin &&
      (target.path === allowed.path ||
        target.path.startsWith(`${allowed.path}/`))
    );
  });
}

/**
 * Whether a runtime keeps content on this host. Unknown means remote, and a
 * remote capacity fallback makes the whole runtime remote.
 */
export function getRuntimeLocality(
  agent: ChatAgentOption,
  prefixes: readonly string[] = PRIVACY_LOCAL_ENDPOINT_PREFIXES,
): RuntimeLocality {
  if (
    agent.fallback &&
    getRuntimeLocality(agent.fallback, prefixes) === 'remote'
  )
    return 'remote';
  if (agent.locality) return agent.locality;
  const baseUrl = directRuntimeBaseUrl(agent);
  return baseUrl && isLocalEndpoint(baseUrl, prefixes) ? 'local' : 'remote';
}

/** Native CLI sessions are portable only within the same provider profile. */
export function runtimeSessionKey(
  agent: Pick<
    ChatAgentOption,
    'sessionFamily' | 'agentCmd' | 'id' | 'env' | 'model'
  >,
): string {
  const family = agent.sessionFamily || agent.agentCmd || agent.id;
  if (agent.agentCmd === 'pi' || agent.agentCmd === 'prime-agent-acp') {
    const provider = agent.model?.includes('/')
      ? agent.model.split('/', 1)[0]
      : 'default';
    return `${family}@${provider}`;
  }
  if (agent.agentCmd === 'claude') {
    const baseUrl = agent.env?.ANTHROPIC_BASE_URL?.trim();
    if (baseUrl) return `${family}@${baseUrl}`;
  }
  if (agent.agentCmd === 'hermes-acp') {
    const baseUrl = agent.env?.OPENAI_BASE_URL?.trim();
    if (baseUrl) return `${family}@${baseUrl}`;
  }
  if (agent.agentCmd !== 'codex') return family;
  const profile = agent.env?.CODEX_PROFILE?.trim() || 'relay';
  return `${family}@${profile}`;
}

interface V2Settings {
  label?: string;
  baseUrl?: string;
  model?: string;
  agentCmd?: string;
  agent?: string;
  bare?: boolean;
  apiKey?: string;
  wireApi?: 'chat_completions' | 'responses';
  env?: Record<string, string>;
  contextSize?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  extraBody?: Record<string, any>;
  apiFormat?: 'openai' | 'ollama';
  locality?: RuntimeLocality;
}
interface V2Connection extends V2Settings {
  label?: string;
  disabled?: boolean;
}
interface V2Harness extends V2Settings {
  label: string;
  kind: 'direct' | 'cli';
  sessionFamily?: string;
  icon?: string;
  /** Generate this harness's models from discovery (see discovered-models.ts). */
  discover?: Record<string, any>;
}
interface V2Model extends V2Settings {
  label: string;
  /** Jev-routed pseudo-model; its bindings are tier maps. */
  auto?: boolean;
  fallbackModel?: string;
  contextSize?: number;
  maxTokens?: number;
  extraBody?: Record<string, any>;
  capabilities?: string[];
  reasoning?: RuntimeReasoning;
  bindings: Record<string, V2Binding>;
}
interface V2Binding extends V2Settings {
  connection?: string;
  /** Per tier: a model ID on this harness, or `"<harnessId>:<modelId>"` candidates. */
  tiers?: Partial<Record<ModelTier, string | string[]>>;
  capabilities?: string[];
  reasoning?: RuntimeReasoning;
}
interface V2Config {
  version: 2;
  connections?: Record<string, V2Connection>;
  harnesses: Record<string, V2Harness>;
  models: Record<string, V2Model>;
  presets?: Record<string, RuntimeSelection & { label: string }>;
  defaults:
    | (RuntimeSelection & V2Settings)
    | {
        chat: RuntimeSelection;
        kanban: {
          fallback: RuntimeSelection;
          stages?: Record<string, RuntimeSelection>;
        };
        observer?: RuntimeSelection;
        curator?: RuntimeSelection;
        reflector?: RuntimeSelection;
        transcription?: RuntimeSelection;
        imageOcr?: RuntimeSelection;
        peekFiles?: RuntimeSelection;
        commitMessage?: RuntimeSelection;
        auditMemories?: RuntimeSelection;
        publicSafetyJudge?: RuntimeSelection;
        settings?: V2Settings;
      };
}

const DEFAULT_V2_CONFIG: V2Config = {
  version: 2,
  harnesses: {
    direct: { label: 'Direct', kind: 'direct', sessionFamily: 'direct' },
  },
  models: {
    default: { label: 'Default Agent', bindings: { direct: {} } },
  },
  defaults: {
    chat: { harnessId: 'direct', modelId: 'default' },
    kanban: {
      fallback: { harnessId: 'direct', modelId: 'default' },
      stages: {},
    },
  },
};

export interface RuntimeCatalog {
  version: 2;
  harnesses: Array<{
    id: string;
    label: string;
    kind: 'direct' | 'cli';
    sessionFamily: string;
    icon?: string;
  }>;
  models: Array<{
    id: string;
    label: string;
    capabilities: string[];
    fallbackModel?: string;
    /** Added from model discovery rather than written in board_agents.jsonc. */
    discovered?: true;
    /** The provider account or harness no longer offers this model. */
    unavailable?: true;
    bindings: Array<{
      harnessId: string;
      runtimeId: string;
      /** Harness-native model string recorded on runs, when declared. */
      model?: string;
      /** Model capabilities plus the ones only this harness binding adds. */
      capabilities?: string[];
      reasoning: RuntimeReasoning;
    }>;
  }>;
  presets: Array<{ id: string; label: string; selection: RuntimeSelection }>;
  defaults: RuntimeDefaultPolicy;
}

let agentsCache: ChatAgentOption[] | null = null;
let catalogCache: RuntimeCatalog | null = null;
let autoTiersCache: AutoTierMaps | null = null;
let lastKnownGood: BoardAgentsSnapshot | null = null;
const BOARD_AGENTS_POLL_INTERVAL_MS = 2_000;
const BOARD_AGENTS_WATCH_RETRY_INTERVAL_MS = 30_000;
let watcher: fs.FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastFileSignature: string | null = null;
let nextWatcherRetryAt = 0;

function assertRecord(
  value: unknown,
  name: string,
): asserts value is Record<string, any> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
}
function assertId(id: string, kind: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id))
    throw new Error(`Invalid ${kind} id "${id}"`);
}
function mergeEnv(
  ...values: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const result = Object.assign({}, ...values.filter(Boolean));
  return Object.keys(result).length ? result : undefined;
}
function capabilities(...values: Array<string[] | undefined>): string[] {
  return [...new Set(values.flatMap((v) => v || []))];
}
function pick<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((v) => v !== undefined);
}

function normalizeV2(
  raw: unknown,
  routingEngine: ModelRoutingEngine = MODEL_ROUTING_ENGINE,
): BoardAgentsSnapshot {
  assertRecord(raw, 'configuration');
  if (raw.version !== 2)
    throw new Error(`Unsupported board_agents version ${String(raw.version)}`);
  assertRecord(raw.harnesses, 'harnesses');
  assertRecord(raw.models, 'models');
  assertRecord(raw.defaults, 'defaults');
  if (raw.connections !== undefined)
    assertRecord(raw.connections, 'connections');
  if (raw.presets !== undefined) assertRecord(raw.presets, 'presets');
  const cfg = raw as V2Config;
  const connections = cfg.connections || {};
  const scopedDefaults = 'chat' in cfg.defaults || 'kanban' in cfg.defaults;
  const defaultSettings: V2Settings = scopedDefaults
    ? (cfg.defaults as { settings?: V2Settings }).settings || {}
    : (cfg.defaults as RuntimeSelection & V2Settings);
  const settingsKeys = [
    'label',
    'baseUrl',
    'model',
    'agentCmd',
    'agent',
    'bare',
    'apiKey',
    'wireApi',
    'env',
    'contextSize',
    'temperature',
    'topP',
    'topK',
    'maxTokens',
    'frequencyPenalty',
    'presencePenalty',
    'extraBody',
    'apiFormat',
    'locality',
  ];
  const assertAllowedKeys = (
    value: Record<string, any>,
    allowed: string[],
    location: string,
  ) => {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown)
      throw new Error(`${location}.${unknown} is not a supported v2 field`);
    if (
      value.locality !== undefined &&
      value.locality !== 'local' &&
      value.locality !== 'remote'
    )
      throw new Error(`${location}.locality must be "local" or "remote"`);
    if (value.env !== undefined) {
      assertRecord(value.env, `${location}.env`);
      if (Object.values(value.env).some((item) => typeof item !== 'string'))
        throw new Error(`${location}.env values must be strings`);
    }
  };
  assertAllowedKeys(
    raw,
    ['version', 'connections', 'harnesses', 'models', 'presets', 'defaults'],
    'configuration',
  );
  const invalidV2Keys = [
    'context_size',
    'max_tokens',
    'extra_body',
    'top_p',
    'top_k',
    'frequency_penalty',
    'presence_penalty',
    'reasoning_effort',
  ];
  const rejectInvalidV2Keys = (value: unknown, location: string) => {
    if (!isRecord(value)) return;
    for (const key of invalidV2Keys)
      if (key in (value as Record<string, unknown>))
        throw new Error(`${location}.${key} is not valid in v2; use camelCase`);
  };
  for (const [id, value] of Object.entries(connections)) {
    assertRecord(value, `connections.${id}`);
    rejectInvalidV2Keys(value, `connections.${id}`);
    assertAllowedKeys(
      value,
      [...settingsKeys, 'disabled'],
      `connections.${id}`,
    );
    if (value.disabled !== undefined && typeof value.disabled !== 'boolean')
      throw new Error(`connections.${id}.disabled must be a boolean`);
  }
  for (const [id, value] of Object.entries(cfg.harnesses)) {
    assertRecord(value, `harnesses.${id}`);
    rejectInvalidV2Keys(value, `harnesses.${id}`);
    assertAllowedKeys(
      value,
      [...settingsKeys, 'kind', 'sessionFamily', 'icon', 'discover'],
      `harnesses.${id}`,
    );
    if (value.discover !== undefined) {
      assertRecord(value.discover, `harnesses.${id}.discover`);
      rejectInvalidV2Keys(value.discover, `harnesses.${id}.discover`);
      assertAllowedKeys(
        value.discover,
        [...settingsKeys, 'connection', ...DISCOVER_KEYS],
        `harnesses.${id}.discover`,
      );
    }
    if (
      value.icon !== undefined &&
      (typeof value.icon !== 'string' || !value.icon.trim())
    ) {
      throw new Error(`harnesses.${id}.icon must be a non-empty string`);
    }
  }
  rejectInvalidV2Keys(cfg.defaults, 'defaults');
  if (scopedDefaults) {
    const policy = cfg.defaults as {
      chat: RuntimeSelection;
      kanban: {
        fallback: RuntimeSelection;
        stages?: Record<string, RuntimeSelection>;
      };
      observer?: RuntimeSelection;
      curator?: RuntimeSelection;
      reflector?: RuntimeSelection;
      transcription?: RuntimeSelection;
      imageOcr?: RuntimeSelection;
      peekFiles?: RuntimeSelection;
      commitMessage?: RuntimeSelection;
      auditMemories?: RuntimeSelection;
      publicSafetyJudge?: RuntimeSelection;
      settings?: V2Settings;
    };
    assertAllowedKeys(
      cfg.defaults,
      [
        'chat',
        'kanban',
        'observer',
        'curator',
        'reflector',
        'transcription',
        'imageOcr',
        'peekFiles',
        'commitMessage',
        'auditMemories',
        'publicSafetyJudge',
        'settings',
      ],
      'defaults',
    );
    assertRecord(policy.chat, 'defaults.chat');
    assertAllowedKeys(
      policy.chat,
      ['harnessId', 'modelId', 'reasoning', 'temperature'],
      'defaults.chat',
    );
    assertRecord(policy.kanban, 'defaults.kanban');
    assertAllowedKeys(policy.kanban, ['fallback', 'stages'], 'defaults.kanban');
    assertRecord(policy.kanban.fallback, 'defaults.kanban.fallback');
    assertAllowedKeys(
      policy.kanban.fallback,
      ['harnessId', 'modelId', 'reasoning', 'temperature'],
      'defaults.kanban.fallback',
    );
    if (policy.settings !== undefined) {
      assertRecord(policy.settings, 'defaults.settings');
      rejectInvalidV2Keys(policy.settings, 'defaults.settings');
      assertAllowedKeys(policy.settings, settingsKeys, 'defaults.settings');
    }
    if (policy.kanban.stages !== undefined)
      assertRecord(policy.kanban.stages, 'defaults.kanban.stages');
    for (const [stageId, selection] of Object.entries(
      policy.kanban.stages || {},
    )) {
      if (!/^[a-z][a-z0-9_]*$/.test(stageId))
        throw new Error(`Invalid default stage id "${stageId}"`);
      assertRecord(selection, `defaults.kanban.stages.${stageId}`);
      assertAllowedKeys(
        selection,
        ['harnessId', 'modelId', 'reasoning', 'temperature'],
        `defaults.kanban.stages.${stageId}`,
      );
    }
    for (const role of [
      'observer',
      'curator',
      'reflector',
      'transcription',
      'imageOcr',
      'peekFiles',
      'commitMessage',
      'auditMemories',
      'publicSafetyJudge',
    ] as const) {
      const selection = policy[role];
      if (selection === undefined) continue;
      assertRecord(selection, `defaults.${role}`);
      assertAllowedKeys(
        selection,
        ['harnessId', 'modelId', 'reasoning', 'temperature'],
        `defaults.${role}`,
      );
    }
  } else {
    assertAllowedKeys(
      cfg.defaults,
      [...settingsKeys, 'harnessId', 'modelId', 'reasoning'],
      'defaults',
    );
  }
  for (const [modelId, model] of Object.entries(cfg.models)) {
    assertRecord(model, `models.${modelId}`);
    rejectInvalidV2Keys(model, `models.${modelId}`);
    assertAllowedKeys(
      model,
      model.auto === true
        ? ['label', 'auto', 'capabilities', 'bindings']
        : [
            ...settingsKeys,
            'fallbackModel',
            'capabilities',
            'reasoning',
            'bindings',
            'auto',
          ],
      `models.${modelId}`,
    );
    if (model.auto !== undefined && typeof model.auto !== 'boolean')
      throw new Error(`models.${modelId}.auto must be a boolean`);
    if ((model.auto === true) !== (modelId === AUTO_MODEL_ID))
      throw new Error(
        `Model id "${AUTO_MODEL_ID}" is reserved for the model with "auto": true`,
      );
    if (
      model.fallbackModel !== undefined &&
      (typeof model.fallbackModel !== 'string' || !model.fallbackModel)
    ) {
      throw new Error(
        `models.${modelId}.fallbackModel must be a non-empty string`,
      );
    }
    for (const [harnessId, binding] of Object.entries(model.bindings || {})) {
      // Malformed Auto bindings are dropped with a warning during resolution.
      if (model.auto === true) continue;
      assertRecord(binding, `models.${modelId}.bindings.${harnessId}`);
      rejectInvalidV2Keys(binding, `models.${modelId}.bindings.${harnessId}`);
      assertAllowedKeys(
        binding,
        [...settingsKeys, 'connection', 'capabilities', 'reasoning'],
        `models.${modelId}.bindings.${harnessId}`,
      );
    }
  }
  for (const [id, preset] of Object.entries(cfg.presets || {})) {
    assertRecord(preset, `presets.${id}`);
    assertAllowedKeys(
      preset,
      ['label', 'harnessId', 'modelId', 'reasoning', 'temperature'],
      `presets.${id}`,
    );
    if (typeof preset.label !== 'string' || !preset.label)
      throw new Error(`Preset "${id}" is missing label`);
    if (
      preset.temperature !== undefined &&
      (typeof preset.temperature !== 'number' ||
        !Number.isFinite(preset.temperature) ||
        preset.temperature < 0 ||
        preset.temperature > 2)
    )
      throw new Error(
        `Preset "${id}" temperature must be a finite number between 0 and 2`,
      );
  }
  const seen = new Set<string>();
  for (const [kind, entries] of [
    ['connection', connections],
    ['harness', cfg.harnesses],
    ['model', cfg.models],
    ['preset', cfg.presets || {}],
  ] as const) {
    for (const id of Object.keys(entries)) {
      assertId(id, kind);
      const key = `${kind}:${id}`;
      if (seen.has(key)) throw new Error(`Duplicate ${kind} id "${id}"`);
      seen.add(key);
    }
  }
  const agents: ChatAgentOption[] = [];
  const publicModels: RuntimeCatalog['models'] = [];
  for (const [modelId, model] of Object.entries(cfg.models)) {
    if (!model.label) throw new Error(`Model "${modelId}" is missing label`);
    assertRecord(model.bindings, `models.${modelId}.bindings`);
    if (model.auto) continue; // Resolved below, once concrete bindings exist.
    const publicBindings: RuntimeCatalog['models'][number]['bindings'] = [];
    for (const [harnessId, binding] of Object.entries(model.bindings)) {
      const harness = cfg.harnesses[harnessId];
      if (!harness)
        throw new Error(
          `Model "${modelId}" references unknown harness "${harnessId}"`,
        );
      if (!harness.label || !['direct', 'cli'].includes(harness.kind))
        throw new Error(`Harness "${harnessId}" requires label and kind`);
      const connection = binding.connection
        ? connections[binding.connection]
        : undefined;
      if (binding.connection && !connection)
        throw new Error(
          `Binding ${modelId}/${harnessId} references unknown connection "${binding.connection}"`,
        );
      if (connection?.disabled) continue;
      const reasoning = binding.reasoning || model.reasoning || { options: [] };
      if (
        !Array.isArray(reasoning.options) ||
        reasoning.options.some((v) => typeof v !== 'string')
      )
        throw new Error(
          `Binding ${modelId}/${harnessId} has invalid reasoning options`,
        );
      if (reasoning.default && !reasoning.options.includes(reasoning.default))
        throw new Error(
          `Reasoning default "${reasoning.default}" is not supported by ${modelId}/${harnessId}`,
        );
      for (const [choice, harnessModel] of Object.entries(
        reasoning.models || {},
      ))
        if (
          !reasoning.options.includes(choice) ||
          typeof harnessModel !== 'string' ||
          !harnessModel
        )
          throw new Error(
            `Binding ${modelId}/${harnessId} has an invalid reasoning model for "${choice}"`,
          );
      const caps = capabilities(model.capabilities, binding.capabilities);
      const id = `${harnessId}:${modelId}`;
      const effective: ChatAgentOption = {
        id,
        label: `${harness.label} · ${model.label}`,
        harnessId,
        harnessKind: harness.kind,
        modelId,
        sessionFamily: harness.sessionFamily || harness.agentCmd || harnessId,
        agentCmd: pick(
          binding.agentCmd,
          model.agentCmd,
          connection?.agentCmd,
          harness.agentCmd,
          defaultSettings.agentCmd,
        ),
        agent: pick(
          binding.agent,
          model.agent,
          connection?.agent,
          harness.agent,
          defaultSettings.agent,
        ),
        // A logical model entry does not necessarily imply a CLI --model
        // override. Harness-only bindings use the CLI's configured default.
        // Direct bindings must still resolve an API model; when none is
        // declared, their logical model id is the fallback.
        model:
          pick(
            binding.model,
            model.model,
            connection?.model,
            harness.model,
            defaultSettings.model,
          ) || (harness.kind === 'direct' ? modelId : undefined),
        baseUrl: pick(
          binding.baseUrl,
          model.baseUrl,
          connection?.baseUrl,
          harness.baseUrl,
          defaultSettings.baseUrl,
        ),
        apiKey: pick(
          binding.apiKey,
          model.apiKey,
          connection?.apiKey,
          harness.apiKey,
          defaultSettings.apiKey,
        ),
        wireApi: pick(
          binding.wireApi,
          model.wireApi,
          connection?.wireApi,
          harness.wireApi,
          defaultSettings.wireApi,
        ),
        env: mergeEnv(
          defaultSettings.env,
          harness.env,
          connection?.env,
          model.env,
          binding.env,
        ),
        context_size: pick(
          binding.contextSize,
          model.contextSize,
          connection?.contextSize,
          harness.contextSize,
          defaultSettings.contextSize,
        ),
        max_tokens: pick(
          binding.maxTokens,
          model.maxTokens,
          connection?.maxTokens,
          harness.maxTokens,
          defaultSettings.maxTokens,
        ),
        extra_body: pick(
          binding.extraBody,
          model.extraBody,
          connection?.extraBody,
          harness.extraBody,
          defaultSettings.extraBody,
        ),
        temperature: pick(
          binding.temperature,
          model.temperature,
          connection?.temperature,
          harness.temperature,
          defaultSettings.temperature,
        ),
        top_p: pick(
          binding.topP,
          model.topP,
          connection?.topP,
          harness.topP,
          defaultSettings.topP,
        ),
        top_k: pick(
          binding.topK,
          model.topK,
          connection?.topK,
          harness.topK,
          defaultSettings.topK,
        ),
        frequency_penalty: pick(
          binding.frequencyPenalty,
          model.frequencyPenalty,
          connection?.frequencyPenalty,
          harness.frequencyPenalty,
          defaultSettings.frequencyPenalty,
        ),
        presence_penalty: pick(
          binding.presencePenalty,
          model.presencePenalty,
          connection?.presencePenalty,
          harness.presencePenalty,
          defaultSettings.presencePenalty,
        ),
        bare: pick(
          binding.bare,
          model.bare,
          connection?.bare,
          harness.bare,
          defaultSettings.bare,
        ),
        apiFormat: pick(
          binding.apiFormat,
          model.apiFormat,
          connection?.apiFormat,
          harness.apiFormat,
          defaultSettings.apiFormat,
        ),
        locality: pick(
          binding.locality,
          model.locality,
          connection?.locality,
          harness.locality,
          defaultSettings.locality,
        ),
        image: caps.includes('image'),
        audio: caps.includes('audio'),
        video: caps.includes('video'),
        reasoningOptions: [...reasoning.options],
        reasoningDefault: reasoning.default,
        reasoningMap: reasoning.map,
        reasoningEnvVar: reasoning.envVar,
        reasoningModels: reasoning.models,
      };
      if (harness.kind === 'direct')
        effective.id = `llm:${harnessId}:${modelId}`;
      if (harness.kind === 'cli' && !effective.agentCmd)
        throw new Error(`CLI harness "${harnessId}" requires agentCmd`);
      agents.push(effective);
      publicBindings.push({
        harnessId,
        runtimeId: effective.id,
        model: effective.model,
        ...(binding.capabilities?.length ? { capabilities: caps } : {}),
        reasoning: {
          options: [...reasoning.options],
          default: reasoning.default,
          map: reasoning.map,
        },
      });
    }
    if (publicBindings.length === 0) continue;
    publicModels.push({
      id: modelId,
      label: model.label,
      capabilities: capabilities(model.capabilities),
      ...(model.fallbackModel ? { fallbackModel: model.fallbackModel } : {}),
      bindings: publicBindings,
    });
  }
  const autoTiers = new Map<string, AutoBinding>();
  const enabledAgent = (harnessId: string, modelId: string) =>
    agents.find(
      (agent) => agent.harnessId === harnessId && agent.modelId === modelId,
    );
  const autoModel = cfg.models[AUTO_MODEL_ID];
  if (autoModel?.auto) {
    const publicBindings: RuntimeCatalog['models'][number]['bindings'] = [];
    for (const [harnessId, binding] of Object.entries(autoModel.bindings)) {
      const harness = cfg.harnesses[harnessId];
      const isRecord =
        !!binding && typeof binding === 'object' && !Array.isArray(binding);
      const extraKey = isRecord
        ? Object.keys(binding).find((key) => key !== 'tiers')
        : undefined;
      const tiers = isRecord ? binding.tiers : undefined;
      let problem = !harness
        ? `unknown harness "${harnessId}"`
        : !isRecord
          ? 'binding must be an object'
          : extraKey
            ? `unsupported field "${extraKey}"`
            : !tiers || typeof tiers !== 'object' || Array.isArray(tiers)
              ? 'tiers must be an object'
              : undefined;
      const resolved = {} as Record<ModelTier, AutoCandidate[]>;
      for (const tier of AUTO_TIERS) {
        if (problem) break;
        const raw = tiers?.[tier];
        if (Array.isArray(raw)) {
          // Invalid candidates are dropped; a tier with none invalidates the binding.
          const candidates: AutoCandidate[] = [];
          for (const entry of raw) {
            const ref = parseAutoCandidate(entry);
            const agent = ref && enabledAgent(ref.harnessId, ref.modelId);
            if (ref && agent)
              candidates.push(
                toAutoCandidate(ref.harnessId, ref.modelId, agent),
              );
            else
              logger.warn(
                { modelId: AUTO_MODEL_ID, harnessId, tier, candidate: entry },
                'Dropping invalid auto tier candidate',
              );
          }
          resolved[tier] = candidates;
          if (!candidates.length)
            problem = `tier "${tier}" has no enabled candidate`;
        } else if (typeof raw !== 'string' || !raw) {
          problem = `tier "${tier}" is missing`;
        } else {
          const agent = enabledAgent(harnessId, raw);
          if (agent) resolved[tier] = [toAutoCandidate(harnessId, raw, agent)];
          else
            problem = `tier "${tier}" model "${raw}" has no enabled "${harnessId}" binding`;
        }
      }
      if (problem) {
        logger.warn(
          { modelId: AUTO_MODEL_ID, harnessId, problem },
          'Dropping invalid auto tier map',
        );
        continue;
      }
      const strictReasoning = AUTO_TIERS.every(
        (tier) => !Array.isArray(tiers![tier]),
      );
      const allCandidates = AUTO_TIERS.flatMap((tier) => resolved[tier]);
      // Strict bindings offer only the choices every tier model accepts.
      // Otherwise the choices are every candidate's, and each candidate
      // falls back to its own default when a selection asks for another.
      const options = strictReasoning
        ? resolved.fast[0]!.reasoningOptions.filter((option) =>
            allCandidates.every((candidate) =>
              candidate.reasoningOptions.includes(option),
            ),
          )
        : [
            ...new Set(
              allCandidates.flatMap((candidate) => candidate.reasoningOptions),
            ),
          ];
      const balancedDefault = resolved.balanced[0]!.reasoningDefault;
      const reasoning: RuntimeReasoning = {
        options,
        ...(balancedDefault && options.includes(balancedDefault)
          ? { default: balancedDefault }
          : {}),
      };
      autoTiers.set(harnessId, {
        tiers: resolved,
        reasoning,
        strictReasoning,
      });
      publicBindings.push({
        harnessId,
        runtimeId:
          harness!.kind === 'direct'
            ? `llm:${harnessId}:${AUTO_MODEL_ID}`
            : `${harnessId}:${AUTO_MODEL_ID}`,
        reasoning: { ...reasoning, options: [...options] },
      });
    }
    // Auto is only offered while the routing engine is on. Tier maps stay
    // resolvable either way so stored `auto` selections keep working.
    if (routingEngine === 'jev' && publicBindings.length) {
      publicModels.push({
        id: AUTO_MODEL_ID,
        label: autoModel.label,
        capabilities: capabilities(autoModel.capabilities),
        bindings: publicBindings,
      });
      const order = Object.keys(cfg.models);
      publicModels.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    }
  }
  for (const [modelId, model] of Object.entries(cfg.models)) {
    if (!model.fallbackModel) continue;
    if (model.fallbackModel === modelId) {
      throw new Error(`Model "${modelId}" cannot fall back to itself`);
    }
    const fallbackModel = cfg.models[model.fallbackModel];
    if (!fallbackModel) {
      throw new Error(
        `Model "${modelId}" references unknown fallback model "${model.fallbackModel}"`,
      );
    }
    for (const harnessId of Object.keys(model.bindings)) {
      if (!fallbackModel.bindings?.[harnessId]) {
        throw new Error(
          `Fallback model "${model.fallbackModel}" has no "${harnessId}" binding required by "${modelId}"`,
        );
      }
      const source = agents.find(
        (agent) => agent.modelId === modelId && agent.harnessId === harnessId,
      );
      const fallback = agents.find(
        (agent) =>
          agent.modelId === model.fallbackModel &&
          agent.harnessId === harnessId,
      );
      if (source && !fallback) {
        throw new Error(
          `Fallback model "${model.fallbackModel}" has no enabled "${harnessId}" binding required by "${modelId}"`,
        );
      }
      if (source && fallback)
        source.fallback = { ...fallback, fallback: undefined };
    }
  }
  const validateSelection = (selection: RuntimeSelection, label: string) => {
    const autoBinding =
      selection.modelId === AUTO_MODEL_ID
        ? autoTiers.get(selection.harnessId)
        : undefined;
    const model = publicModels.find((m) => m.id === selection.modelId);
    const binding = autoBinding
      ? autoBinding
      : model?.bindings.find((b) => b.harnessId === selection.harnessId);
    if (!binding)
      throw new Error(
        `${label} selects incompatible runtime ${selection.harnessId}/${selection.modelId}`,
      );
    if (
      selection.reasoning &&
      !binding.reasoning.options.includes(selection.reasoning)
    )
      throw new Error(
        `${label} uses unsupported reasoning "${selection.reasoning}"`,
      );
    if (
      selection.temperature !== undefined &&
      (typeof selection.temperature !== 'number' ||
        !Number.isFinite(selection.temperature) ||
        selection.temperature < 0 ||
        selection.temperature > 2)
    )
      throw new Error(
        `${label} temperature must be a finite number between 0 and 2`,
      );
  };
  const defaults: RuntimeDefaultPolicy = scopedDefaults
    ? {
        chat: (cfg.defaults as any).chat,
        kanban: {
          fallback: (cfg.defaults as any).kanban.fallback,
          stages: { ...((cfg.defaults as any).kanban.stages || {}) },
        },
        ...((cfg.defaults as any).observer
          ? { observer: (cfg.defaults as any).observer }
          : {}),
        ...((cfg.defaults as any).curator
          ? { curator: (cfg.defaults as any).curator }
          : {}),
        ...((cfg.defaults as any).reflector
          ? { reflector: (cfg.defaults as any).reflector }
          : {}),
        ...((cfg.defaults as any).transcription
          ? { transcription: (cfg.defaults as any).transcription }
          : {}),
        ...((cfg.defaults as any).imageOcr
          ? { imageOcr: (cfg.defaults as any).imageOcr }
          : {}),
        ...((cfg.defaults as any).peekFiles
          ? { peekFiles: (cfg.defaults as any).peekFiles }
          : {}),
        ...((cfg.defaults as any).commitMessage
          ? { commitMessage: (cfg.defaults as any).commitMessage }
          : {}),
        ...((cfg.defaults as any).auditMemories
          ? { auditMemories: (cfg.defaults as any).auditMemories }
          : {}),
        ...((cfg.defaults as any).publicSafetyJudge
          ? { publicSafetyJudge: (cfg.defaults as any).publicSafetyJudge }
          : {}),
      }
    : {
        chat: cfg.defaults as RuntimeSelection,
        kanban: { fallback: cfg.defaults as RuntimeSelection, stages: {} },
      };
  validateSelection(defaults.chat, 'defaults.chat');
  validateSelection(defaults.kanban.fallback, 'defaults.kanban.fallback');
  for (const [stageId, selection] of Object.entries(defaults.kanban.stages)) {
    validateSelection(selection, `defaults.kanban.stages.${stageId}`);
  }
  if (defaults.observer)
    validateSelection(defaults.observer, 'defaults.observer');
  if (defaults.curator) validateSelection(defaults.curator, 'defaults.curator');
  if (defaults.reflector)
    validateSelection(defaults.reflector, 'defaults.reflector');
  if (defaults.transcription)
    validateSelection(defaults.transcription, 'defaults.transcription');
  if (defaults.imageOcr)
    validateSelection(defaults.imageOcr, 'defaults.imageOcr');
  if (defaults.auditMemories)
    validateSelection(defaults.auditMemories, 'defaults.auditMemories');
  if (defaults.publicSafetyJudge)
    validateSelection(defaults.publicSafetyJudge, 'defaults.publicSafetyJudge');
  if (defaults.publicSafetyJudge) {
    const judge = agents.find(
      (agent) =>
        agent.harnessId === defaults.publicSafetyJudge!.harnessId &&
        agent.modelId === defaults.publicSafetyJudge!.modelId,
    );
    if (!judge || !isDirectRuntime(judge) || !judge.baseUrl || !judge.model) {
      throw new Error(
        'defaults.publicSafetyJudge must select an HTTP-capable direct runtime',
      );
    }
  }
  if (defaults.peekFiles) {
    validateSelection(defaults.peekFiles, 'defaults.peekFiles');
    const peekAgent = agents.find(
      (agent) =>
        agent.harnessId === defaults.peekFiles!.harnessId &&
        agent.modelId === defaults.peekFiles!.modelId,
    );
    if (
      !peekAgent ||
      !isDirectRuntime(peekAgent) ||
      !peekAgent.model ||
      !peekAgent.baseUrl
    ) {
      throw new Error(
        'defaults.peekFiles must select an HTTP-capable direct runtime',
      );
    }
  }
  if (defaults.commitMessage) {
    const commitSelection = defaults.commitMessage;
    validateSelection(commitSelection, 'defaults.commitMessage');
    const commitAgent = agents.find(
      (agent) =>
        agent.harnessId === commitSelection.harnessId &&
        agent.modelId === commitSelection.modelId,
    );
    const commitBaseUrl =
      commitAgent?.baseUrl ||
      commitAgent?.env?.OPENAI_BASE_URL ||
      commitAgent?.env?.ANTHROPIC_BASE_URL;
    if (
      !commitAgent ||
      !isDirectRuntime(commitAgent) ||
      !commitAgent.model ||
      !commitBaseUrl
    ) {
      throw new Error(
        'defaults.commitMessage must select an HTTP-capable direct runtime',
      );
    }
  }
  const presets = Object.entries(cfg.presets || {}).map(([id, preset]) => {
    validateSelection(preset, `preset "${id}"`);
    return {
      id,
      label: preset.label,
      selection: {
        harnessId: preset.harnessId,
        modelId: preset.modelId,
        reasoning: preset.reasoning,
        temperature: preset.temperature,
      },
    };
  });
  const enabledHarnessIds = new Set(
    publicModels.flatMap((model) =>
      model.bindings.map((binding) => binding.harnessId),
    ),
  );
  const catalog: RuntimeCatalog = {
    version: 2,
    defaults,
    harnesses: Object.entries(cfg.harnesses)
      .filter(([id]) => enabledHarnessIds.has(id))
      .map(([id, h]) => ({
        id,
        label: h.label,
        kind: h.kind,
        sessionFamily: h.sessionFamily || h.agentCmd || id,
        ...(h.icon ? { icon: h.icon } : {}),
      })),
    models: publicModels,
    presets,
  };
  return { agents, catalog, autoTiers };
}

export function normalizeBoardAgentsConfig(
  raw: unknown,
  options?: { routingEngine?: ModelRoutingEngine },
): BoardAgentsSnapshot {
  return normalizeV2(raw, options?.routingEngine);
}

export function normalizeBoardAgentsText(
  data: string,
  previous?: BoardAgentsSnapshot,
  discovery?: DiscoveryCache,
): {
  snapshot: BoardAgentsSnapshot;
  error?: Error;
} {
  try {
    const parsed = parseJsonc(data);
    let snapshot: BoardAgentsSnapshot;
    try {
      const { raw, flags } = applyDiscoveredModels(parsed, discovery);
      snapshot = normalizeBoardAgentsConfig(raw);
      for (const model of snapshot.catalog.models) {
        if (flags[model.id] === 'discovered') model.discovered = true;
        if (flags[model.id] === 'unavailable') model.unavailable = true;
      }
    } catch (err) {
      // Discovered models must never take down the hand-written catalog.
      if (!discovery) throw err;
      logger.warn(
        { err },
        'Discovered models rejected; using board_agents.jsonc alone',
      );
      snapshot = normalizeBoardAgentsConfig(parsed);
    }
    return { snapshot };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (previous) return { snapshot: previous, error };
    throw error;
  }
}

function loadConfig(): BoardAgentsSnapshot {
  const agentsFile = path.join(DATA_DIR, 'board_agents.jsonc');
  if (!fs.existsSync(agentsFile)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(agentsFile, JSON.stringify(DEFAULT_V2_CONFIG, null, 2));
  }
  return normalizeBoardAgentsText(
    fs.readFileSync(agentsFile, 'utf8'),
    undefined,
    readDiscoveryCache(path.join(DATA_DIR, DISCOVERY_FILE_NAME)),
  ).snapshot;
}

// The discovered-model cache sits beside board_agents.jsonc in the watched
// directory, so either file changing reloads the catalog.
function boardAgentsFileSignature(file: string): string {
  return [file, path.join(path.dirname(file), DISCOVERY_FILE_NAME)]
    .map((item) => {
      try {
        const stat = fs.statSync(item);
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return 'missing';
      }
    })
    .join('|');
}

function scheduleBoardAgentsReload(): void {
  if (reloadTimer) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    const previous = JSON.stringify(catalogCache);
    reloadChatAgents();
    ensureLoaded();
    if (JSON.stringify(catalogCache) !== previous)
      runtimeChanges.emit('catalog');
  }, 150);
}

function checkBoardAgentsSignature(file: string): void {
  const nextSignature = boardAgentsFileSignature(file);
  if (lastFileSignature === null) {
    lastFileSignature = nextSignature;
    return;
  }
  if (nextSignature === lastFileSignature) return;
  lastFileSignature = nextSignature;
  scheduleBoardAgentsReload();
}

function startBoardAgentsPoller(file: string): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    checkBoardAgentsSignature(file);
    if (!watcher && Date.now() >= nextWatcherRetryAt)
      startBoardAgentsWatcher(file);
  }, BOARD_AGENTS_POLL_INTERVAL_MS);
  pollTimer.unref();
}

function startBoardAgentsWatcher(file: string): void {
  startBoardAgentsPoller(file);
  checkBoardAgentsSignature(file);
  if (watcher || Date.now() < nextWatcherRetryAt) return;
  try {
    const directory = path.dirname(file);
    // Watch the stable parent directory rather than the file inode. Editors
    // and apply_patch commonly save via atomic rename, which leaves a watcher
    // attached to the now-deleted old inode and prevents future hot reloads.
    // Some runtimes report only the temporary filename for that rename, so
    // compare the target's own signature instead of trusting changedFilename.
    const nextWatcher = fs.watch(directory, () => {
      checkBoardAgentsSignature(file);
    });
    watcher = nextWatcher;
    nextWatcherRetryAt = 0;
    nextWatcher.on('error', (err) => {
      if (watcher !== nextWatcher) return;
      watcher = null;
      nextWatcherRetryAt = Date.now() + BOARD_AGENTS_WATCH_RETRY_INTERVAL_MS;
      try {
        nextWatcher.close();
      } catch {}
      logger.warn({ err }, 'board_agents.jsonc watch unavailable');
    });
  } catch (err) {
    nextWatcherRetryAt = Date.now() + BOARD_AGENTS_WATCH_RETRY_INTERVAL_MS;
    logger.warn({ err }, 'board_agents.jsonc watch unavailable');
  }
}
export interface GetChatAgentsOptions {
  watch?: boolean;
}
function ensureLoaded(options?: GetChatAgentsOptions): void {
  const file = path.join(DATA_DIR, 'board_agents.jsonc');
  if (agentsCache && catalogCache) {
    if (options?.watch !== false) startBoardAgentsWatcher(file);
    return;
  }
  try {
    const loaded = loadConfig();
    agentsCache = loaded.agents;
    catalogCache = loaded.catalog;
    autoTiersCache = loaded.autoTiers;
    lastKnownGood = loaded;
  } catch (err) {
    logger.error(
      { err, path: file },
      'Invalid board_agents.jsonc — retaining last known-good catalog',
    );
    const fallback = lastKnownGood || normalizeV2(DEFAULT_V2_CONFIG);
    agentsCache = fallback.agents;
    catalogCache = fallback.catalog;
    autoTiersCache = fallback.autoTiers;
  }
  lastFileSignature = boardAgentsFileSignature(file);
  if (options?.watch !== false) startBoardAgentsWatcher(file);
}
export function getChatAgents(
  options?: GetChatAgentsOptions,
): ChatAgentOption[] {
  ensureLoaded(options);
  return agentsCache!;
}
export function getRuntimeCatalog(
  options?: GetChatAgentsOptions,
): RuntimeCatalog {
  ensureLoaded(options);
  return catalogCache!;
}
export function reloadChatAgents(): void {
  agentsCache = null;
  catalogCache = null;
  autoTiersCache = null;
}

export function resolveRuntimeSelection(
  selection: RuntimeSelection,
): ChatAgentOption {
  ensureLoaded();
  return resolveRuntimeFromAgents(agentsCache!, selection);
}

/** True for a stored Auto selection (resolve it with `resolveAutoSelection`). */
export function isAutoSelection(
  selection: Pick<RuntimeSelection, 'modelId'>,
): boolean {
  return selection.modelId === AUTO_MODEL_ID;
}

/** True when the catalog declares a valid Auto tier map for the harness. */
export function harnessSupportsAuto(harnessId: string): boolean {
  ensureLoaded();
  return autoTiersCache!.has(harnessId);
}

function autoBindingFor(
  selection: RuntimeSelection,
  tierMaps?: AutoTierMaps,
): AutoBinding {
  if (!tierMaps) {
    ensureLoaded();
    tierMaps = autoTiersCache!;
  }
  const auto = tierMaps.get(selection.harnessId);
  if (!auto)
    throw new Error(
      `Incompatible runtime selection ${selection.harnessId}/${selection.modelId}`,
    );
  return auto;
}

/** A strict binding's tier models all accept the reasoning, whichever one runs. */
function assertStrictAutoReasoning(
  selection: RuntimeSelection,
  auto: AutoBinding,
): void {
  if (
    auto.strictReasoning &&
    typeof selection.reasoning === 'string' &&
    selection.reasoning.trim() &&
    !auto.reasoning.options.includes(selection.reasoning)
  )
    throw new Error(
      `Reasoning "${selection.reasoning}" is not supported by ${selection.harnessId}/${selection.modelId}`,
    );
}

/** `selection` moved onto `candidate`; a reasoning the candidate lacks is dropped so its default applies. */
function selectAutoCandidate(
  selection: RuntimeSelection,
  candidate: AutoCandidate,
): RuntimeSelection {
  const next: RuntimeSelection = {
    ...selection,
    harnessId: candidate.harnessId,
    modelId: candidate.modelId,
  };
  if (
    typeof selection.reasoning === 'string' &&
    selection.reasoning.trim() &&
    !candidate.reasoningOptions.includes(selection.reasoning)
  )
    delete next.reasoning;
  return next;
}

/**
 * Turn an Auto selection into the concrete selection for a routing tier: the
 * first enabled candidate of the tier, which may be on another harness, or
 * the one `choose` returns from the tier's candidates (in config order).
 * `tier = null` (no routing decision, including `MODEL_ROUTING_ENGINE=off`)
 * means `balanced`. Non-Auto selections are returned unchanged. `tierMaps`
 * defaults to the loaded catalog.
 */
export function resolveAutoSelection(
  selection: RuntimeSelection,
  tier: ModelTier | null,
  tierMaps?: AutoTierMaps,
  choose?: (candidates: readonly AutoCandidate[]) => AutoCandidate,
): RuntimeSelection {
  if (!isAutoSelection(selection)) return selection;
  const auto = autoBindingFor(selection, tierMaps);
  assertStrictAutoReasoning(selection, auto);
  const candidates = auto.tiers[tier ?? 'balanced'];
  return selectAutoCandidate(selection, choose?.(candidates) ?? candidates[0]!);
}

/**
 * The concrete selection a stored Auto routing ran on: the recorded harness
 * and model (a continuing session, or a chat pin). The candidate is found
 * among the tiers, preferring `pinned.tier` when one model appears in several.
 * A pair no tier lists is kept as recorded and resolves, or fails, like any
 * explicit selection.
 */
export function resolveAutoPinnedSelection(
  selection: RuntimeSelection,
  pinned: { harnessId: string; modelId: string; tier?: string | null },
  tierMaps?: AutoTierMaps,
): RuntimeSelection {
  if (!isAutoSelection(selection)) return selection;
  const auto = autoBindingFor(selection, tierMaps);
  assertStrictAutoReasoning(selection, auto);
  const preferred = AUTO_TIERS.find((tier) => tier === pinned.tier);
  const order: readonly ModelTier[] = preferred
    ? [preferred, ...AUTO_TIERS.filter((tier) => tier !== preferred)]
    : AUTO_TIERS;
  const candidate = order
    .flatMap((tier) => auto.tiers[tier])
    .find(
      (entry) =>
        entry.modelId === pinned.modelId &&
        entry.harnessId === pinned.harnessId,
    );
  if (candidate) return selectAutoCandidate(selection, candidate);
  return { ...selection, harnessId: pinned.harnessId, modelId: pinned.modelId };
}

export function validateRuntimeSelection(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    return 'runtimeSelection must be an object or null';
  const item = value as Record<string, unknown>;
  if (
    typeof item.harnessId !== 'string' ||
    !item.harnessId.trim() ||
    typeof item.modelId !== 'string' ||
    !item.modelId.trim()
  )
    return 'runtimeSelection requires harnessId and modelId strings';
  if (item.reasoning !== undefined && item.reasoning !== null) {
    if (typeof item.reasoning !== 'string')
      return 'runtimeSelection.reasoning must be a string or null';
    if (!item.reasoning.trim())
      return 'runtimeSelection.reasoning must be a non-empty string or null';
  }
  if (
    item.temperature !== undefined &&
    item.temperature !== null &&
    (typeof item.temperature !== 'number' ||
      !Number.isFinite(item.temperature) ||
      item.temperature < 0 ||
      item.temperature > 2)
  )
    return 'runtimeSelection.temperature must be a finite number between 0 and 2 or null';
  try {
    resolveRuntimeSelection(item as unknown as RuntimeSelection);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

/** Resolve layered Kanban selections, inheriting reasoning from lower layers. */
export function resolveKanbanRuntimeSelection(
  overrides: Array<RuntimeSelection | undefined>,
  stageId?: string,
  stageType?: StageType,
): { selection: RuntimeSelection; agent: ChatAgentOption } {
  ensureLoaded();
  const configured = [
    ...overrides,
    getDefaultRuntimeSelection('kanban', stageId, stageType),
    getDefaultRuntimeSelection('kanban'),
  ];
  const selection = mergeKanbanRuntimeSelections(configured);
  try {
    return { selection, agent: resolveRuntimeSelection(selection) };
  } catch (error) {
    if (
      selection.reasoning !== undefined &&
      /Reasoning .* not supported/.test(String(error))
    ) {
      const fallback = {
        harnessId: selection.harnessId,
        modelId: selection.modelId,
      };
      return { selection: fallback, agent: resolveRuntimeSelection(fallback) };
    }
    throw error;
  }
}

export function mergeKanbanRuntimeSelections(
  selections: Array<LayeredRuntimeSelection | undefined>,
): RuntimeSelection {
  const binding = selections.find(Boolean);
  if (!binding) throw new Error('No Kanban runtime selection configured');
  const reasoning = selections
    .map((item) => item?.reasoning)
    .find((value) => typeof value === 'string' && value.trim().length > 0);
  return {
    harnessId: binding.harnessId,
    modelId: binding.modelId,
    ...(typeof reasoning === 'string' ? { reasoning } : {}),
  };
}

/**
 * Kanban default for a stage: the exact stage id key, then the stage's type key
 * (`active`, `testing`, `review`), then `defaults.kanban.fallback`.
 */
function kanbanStageDefault(
  kanban: RuntimeCatalog['defaults']['kanban'],
  stageId?: string,
  stageType?: StageType,
): RuntimeSelection {
  return (
    (stageId && kanban.stages[stageId]) ||
    (stageType && kanban.stages[stageType]) ||
    kanban.fallback
  );
}

export function getDefaultRuntimeSelection(
  scope: 'chat' | 'kanban',
  stageId?: string,
  stageType?: StageType,
): RuntimeSelection {
  ensureLoaded();
  if (scope === 'chat') return catalogCache!.defaults.chat;
  return kanbanStageDefault(catalogCache!.defaults.kanban, stageId, stageType);
}

/**
 * Resolve a runtime reference against the normalized catalog. Exact generated
 * IDs win. Convenience aliases then match the underlying
 * command, harness, or model; ambiguous aliases prefer the configured v2
 * default and otherwise retain catalog order. Callers that represent an
 * implicit runtime choice may explicitly request the configured v2 default.
 */
export function resolveAgentReference(
  reference?: string | null,
  options?: {
    fallbackToDefault?: boolean;
    defaultScope?: 'chat' | 'kanban';
    stageId?: string;
    stageType?: StageType;
  },
): ChatAgentOption | undefined {
  ensureLoaded();
  return resolveAgentReferenceFromCatalog(
    agentsCache!,
    catalogCache!,
    reference,
    options,
  );
}

export function resolveAgentReferenceFromCatalog(
  agents: ChatAgentOption[],
  catalog: RuntimeCatalog,
  reference?: string | null,
  options?: {
    fallbackToDefault?: boolean;
    defaultScope?: 'chat' | 'kanban';
    stageId?: string;
    stageType?: StageType;
  },
): ChatAgentOption | undefined {
  const defaultSelection =
    options?.defaultScope === 'chat'
      ? catalog.defaults.chat
      : kanbanStageDefault(
          catalog.defaults.kanban,
          options?.stageId,
          options?.stageType,
        );
  const materialize = (agent: ChatAgentOption): ChatAgentOption =>
    agent.harnessId && agent.modelId
      ? resolveRuntimeFromAgents(agents, {
          harnessId: agent.harnessId,
          modelId: agent.modelId,
        })
      : agent;
  if (reference) {
    if (reference === 'default') {
      return resolveRuntimeFromAgents(agents, defaultSelection);
    }
    const exact = agents.find((agent) => agent.id === reference);
    if (exact) return materialize(exact);

    const modelAlias = reference.startsWith('llm:')
      ? reference.slice('llm:'.length)
      : reference;
    const candidates = agents.filter(
      (agent) =>
        agent.agentCmd === reference ||
        agent.harnessId === reference ||
        agent.modelId === reference ||
        agent.modelId === modelAlias,
    );
    if (candidates.length) {
      return materialize(
        candidates.find(
          (agent) =>
            agent.harnessId === defaultSelection.harnessId &&
            agent.modelId === defaultSelection.modelId,
        ) || candidates[0],
      );
    }
  }

  if (options?.fallbackToDefault)
    return resolveRuntimeFromAgents(agents, defaultSelection);
  return undefined;
}

export function resolveRuntimeFromAgents(
  agents: ChatAgentOption[],
  selection: RuntimeSelection,
  autoTiers?: AutoTierMaps,
): ChatAgentOption {
  // An Auto selection without a routing decision runs as its balanced tier.
  // Without explicit tier maps, resolution uses the loaded catalog's.
  if (isAutoSelection(selection))
    selection = resolveAutoSelection(selection, null, autoTiers);
  const cfg = agents.find(
    (a) =>
      a.harnessId === selection.harnessId && a.modelId === selection.modelId,
  );
  if (!cfg)
    throw new Error(
      `Incompatible runtime selection ${selection.harnessId}/${selection.modelId}`,
    );
  const requestedReasoning =
    typeof selection.reasoning === 'string' && selection.reasoning.trim()
      ? selection.reasoning
      : undefined;
  const reasoning = requestedReasoning ?? cfg.reasoningDefault;
  const materializeReasoning = (
    agent: ChatAgentOption,
    logicalReasoning?: string,
  ): ChatAgentOption => {
    if (
      logicalReasoning &&
      !agent.reasoningOptions?.includes(logicalReasoning)
    ) {
      throw new Error(
        `Reasoning "${logicalReasoning}" is not supported by ${agent.harnessId}/${agent.modelId}`,
      );
    }
    const hasMapping =
      !!logicalReasoning &&
      Object.prototype.hasOwnProperty.call(
        agent.reasoningMap || {},
        logicalReasoning,
      );
    const mapped = logicalReasoning
      ? hasMapping
        ? agent.reasoningMap?.[logicalReasoning]
        : logicalReasoning
      : undefined;
    const env =
      mapped && agent.reasoningEnvVar
        ? { ...agent.env, [agent.reasoningEnvVar]: mapped }
        : agent.env;
    // Qwen's llama.cpp chat template does not understand reasoning_effort="none".
    // Keep the logical reasoning choice at the board level, but translate the
    // disabled state into the provider-specific template flag on the resolved
    // request body. Preserve any other chat-template options configured by the
    // model/binding (for example preserve_thinking).
    const extra_body =
      logicalReasoning === 'none' && agent.extra_body
        ? {
            ...agent.extra_body,
            chat_template_kwargs: {
              ...(agent.extra_body.chat_template_kwargs || {}),
              enable_thinking: false,
            },
          }
        : agent.extra_body;
    return {
      ...agent,
      ...(logicalReasoning && agent.reasoningModels?.[logicalReasoning]
        ? { model: agent.reasoningModels[logicalReasoning] }
        : {}),
      env,
      extra_body,
      reasoning_effort: mapped || undefined,
    };
  };
  const resolved = {
    ...materializeReasoning(cfg, reasoning),
    ...(selection.temperature !== undefined
      ? { temperature: selection.temperature }
      : {}),
  };
  if (cfg.fallback) {
    const fallbackReasoning =
      requestedReasoning &&
      cfg.fallback.reasoningOptions?.includes(requestedReasoning)
        ? requestedReasoning
        : cfg.fallback.reasoningDefault;
    resolved.fallback = {
      ...materializeReasoning(cfg.fallback, fallbackReasoning),
      ...(selection.temperature !== undefined
        ? { temperature: selection.temperature }
        : {}),
      fallback: undefined,
    };
  }
  return resolved;
}
