/**
 * Shared dataset shape validation.
 *
 * Both dataset task creation surfaces — the REST route
 * (src/routes/datasets.ts) and the MCP tool
 * (src/modules/kanban/dataset-tools.ts) — must reject the same malformed
 * payloads before anything is persisted.
 */

import { isRecord } from '../../lib/type-guards.js';

function isDatasetRow(
  value: unknown,
): value is Record<string, string | number> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (field) => typeof field === 'string' || typeof field === 'number',
    )
  );
}

export function isValidDataset(
  value: unknown,
): value is Record<string, string | number>[] {
  return Array.isArray(value) && value.length > 0 && value.every(isDatasetRow);
}
