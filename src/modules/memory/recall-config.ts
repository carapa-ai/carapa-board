/**
 * Tunable recall / hybrid fusion parameters (env overrides).
 */

function parsePositiveFloat(env: string | undefined, fallback: number): number {
  const n = parseFloat(env ?? '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parsePositiveInt(env: string | undefined, fallback: number): number {
  const n = parseInt(env ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Over-fetch multiplier for keyword + vector candidate pools (default 5). */
export const RECALL_FETCH_MULTIPLIER = parsePositiveInt(
  process.env.RECALL_FETCH_MULTIPLIER,
  5,
);

/** RRF damping constant k (default 40; lower = more weight on top ranks). */
export const RECALL_RRF_K = parsePositiveInt(process.env.RECALL_RRF_K, 40);

/** Blend weight for cosine vs temporal recency when re-ranking vector hits. */
export const VECTOR_TEMPORAL_BLEND = parsePositiveFloat(
  process.env.VECTOR_TEMPORAL_BLEND,
  0.3,
);
