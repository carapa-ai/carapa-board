/**
 * Read caps for agent-writable memory files. A planted oversized file is
 * refused instead of being loaded into the board process.
 */

/** Rules, memory notes and observation journals: 1 MiB per file. */
export const MAX_MEMORY_TEXT_BYTES = 1024 * 1024;

/** Manifests, batches, leases, preview state and eval records: 8 MiB per file. */
export const MAX_MEMORY_STATE_BYTES = 8 * 1024 * 1024;
