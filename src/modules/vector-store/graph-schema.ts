/**
 * Graph memory schema — entity helpers.
 *
 * v1 of the (subject, relation, object) knowledge graph layered on top of the
 * existing Neo4j store.
 *
 * This module is pure (no Neo4j / network imports) so it can be imported by the
 * memory graph code and unit-tested in isolation.
 */

/**
 * Normalize an entity name for lightweight (case-insensitive exact) resolution.
 *
 * Entity resolution v1 is exact-match only — a MERGE on this normalized key
 * within a group scope. TODO(v2): embedding-based fuzzy resolution to merge
 * "Marta R." with "Marta Rossi". The seam is here: swap this for a resolver
 * that returns a canonical entity id.
 */
export function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A 1-hop relation fact surfaced during recall expansion (with provenance). */
export interface GraphFact {
  subject: string;
  relation: string;
  object: string;
  rawLabel?: string | null;
  /** Memory node this fact was anchored to, for citation (may be null). */
  sourceMemoryId?: string | null;
}
