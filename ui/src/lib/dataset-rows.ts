export type DatasetRow = Record<string, string | number>;

/**
 * Mirrors the server's `isDatasetRow` (src/modules/kanban/dataset-validation.ts):
 * every cell must be a string or number. Returns an inline error for the first
 * offending cell, or '' when all rows are valid.
 */
export function findInvalidCell(rows: Record<string, unknown>[]): string {
  for (let i = 0; i < rows.length; i++) {
    for (const [key, value] of Object.entries(rows[i])) {
      if (typeof value !== 'string' && typeof value !== 'number') {
        return `Row ${i + 1}, "${key}": values must be a string or number`;
      }
    }
  }
  return '';
}

/**
 * Column names across all rows. `partial` lists the columns that some rows
 * lack; the executor leaves a literal `{{key}}` in those rows.
 */
export function datasetColumns(rows: DatasetRow[] | null): {
  columns: string[];
  partial: string[];
} {
  if (!rows) return { columns: [], partial: [] };
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return {
    columns: [...counts.keys()],
    partial: [...counts].filter(([, n]) => n < rows.length).map(([k]) => k),
  };
}
