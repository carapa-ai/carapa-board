import { createSecretReader, parseBooleanEnv } from '../../lib/env.js';

const readSecret = createSecretReader();

export const NEO4J_URI = process.env.NEO4J_URI || 'bolt://sia-neo4j:7687';
export const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
export const NEO4J_PASSWORD = readSecret('NEO4J_PASSWORD');
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'embeddinggemma';
export const EMBEDDING_API_URL =
  process.env.EMBEDDING_API_URL || 'http://llama-proxy:11434/api/embed';
export const VECTOR_ONLY_RECALL = process.env.VECTOR_ONLY_RECALL === 'true';
export const VECTOR_MIN_SCORE = parseFloat(
  process.env.VECTOR_MIN_SCORE || '0.55',
);

/** Neo4j vector query over-fetch before min-score filter (default 5× limit). */
export const VECTOR_SEARCH_K_MULTIPLIER = (() => {
  const n = parseInt(process.env.VECTOR_SEARCH_K_MULTIPLIER || '5', 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
})();
export const EMBEDDING_DIMENSIONS = parseInt(
  process.env.EMBEDDING_DIMENSIONS || '768',
  10,
);

export const ENABLE_VECTOR_STORE = parseBooleanEnv(
  process.env.ENABLE_VECTOR_STORE,
);

/**
 * Most orphan vector nodes the sweep deletes per group per maintenance pass.
 * Defaults to the sweep's 20,000-node scan cap, so one pass clears a backlog;
 * lower it to bound deletes if the SQL answer is in doubt.
 */
export const ORPHAN_SWEEP_MAX_DELETE_PER_PASS = (() => {
  const n = parseInt(
    process.env.ORPHAN_SWEEP_MAX_DELETE_PER_PASS || '20000',
    10,
  );
  return Number.isFinite(n) && n >= 0 ? n : 20_000;
})();
