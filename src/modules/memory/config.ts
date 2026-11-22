/**
 * Memory system configuration.
 * Runtime roles come from board_agents.jsonc; operational toggles remain env-driven.
 */

import { ENABLE_MEMORY_REFLECTOR } from '../../config.js';
import {
  getRuntimeCatalog,
  resolveRuntimeSelection,
  type RuntimeSelection,
} from '../../lib/chat-agents.js';

export interface LLMEndpointConfig {
  agentId?: string;
  runtimeSelection?: RuntimeSelection;
  maxTokens?: number;
}

export interface MemoryConfig {
  /** Automatic transcript memory (ENABLE_MEMORY_REFLECTOR) */
  enabled: boolean;

  observer: {
    /** LLM endpoint for History Review candidate extraction (defaults.observer) */
    llm: LLMEndpointConfig;
    /** Minimum transcript length (chars) the reflector processes */
    minTranscriptLength: number;
    /** Skip automatic memory for these group folders */
    excludeGroups: string[];
    /** Max estimated tokens per transcript chunk (0 = single call, no chunking). */
    maxTokensPerChunk: number;
  };

  reflector: {
    /** LLM endpoint for the memory reflector (defaults.reflector) */
    llm: LLMEndpointConfig;
  };

  /** Group folder that acts as the central hub (receives cross-project observations) */
  mainGroup: string;
}

export function getMemoryConfig(): MemoryConfig {
  const chunkRaw = process.env.OBSERVER_CHUNK_TOKENS?.trim();
  const chunkParsed = chunkRaw != null ? Number(chunkRaw) : 5000;
  const maxTokensPerChunk =
    Number.isFinite(chunkParsed) && chunkParsed >= 0 ? chunkParsed : 5000;

  const runtimeDefaults = getRuntimeCatalog({ watch: false }).defaults;
  const observerRuntime = runtimeDefaults.observer;
  const reflectorRuntime = runtimeDefaults.reflector;
  const observerAgentId = observerRuntime
    ? resolveRuntimeSelection(observerRuntime).id
    : undefined;
  const reflectorAgentId = reflectorRuntime
    ? resolveRuntimeSelection(reflectorRuntime).id
    : undefined;

  return {
    enabled: ENABLE_MEMORY_REFLECTOR,
    observer: {
      llm: {
        ...(observerAgentId ? { agentId: observerAgentId } : {}),
        ...(observerRuntime ? { runtimeSelection: observerRuntime } : {}),
      },
      minTranscriptLength: 200,
      excludeGroups: [],
      maxTokensPerChunk,
    },
    reflector: {
      llm: {
        ...(reflectorAgentId ? { agentId: reflectorAgentId } : {}),
        ...(reflectorRuntime ? { runtimeSelection: reflectorRuntime } : {}),
      },
    },
    mainGroup: 'main',
  };
}
