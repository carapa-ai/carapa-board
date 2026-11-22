import { arrayMove } from '@dnd-kit/sortable';
import type { StageDefinition, TaskSummary } from '@/types';

export interface ReorderUpdate {
  id: string;
  priority: number;
}

type ReorderTask = Pick<TaskSummary, 'id' | 'priority' | 'running'>;

/** Spacing used when a card is moved past the first or last neighbour. */
const PRIORITY_STEP = 1000;

interface Placement {
  /** Priority the dragged card ends up with. */
  priority: number;
  /** Priority rewrites needed, in the shape `computeReorderUpdates` returns. */
  updates: ReorderUpdate[];
}

/**
 * Give the dragged card a priority between `prev` and `next` (its non-running
 * neighbours; either may be absent). Without an integer gap the whole known
 * column is renumbered around it.
 */
function placeBetween(
  prev: ReorderTask | undefined,
  next: ReorderTask | undefined,
  dragged: ReorderTask,
  fullColumn: readonly ReorderTask[],
): Placement | null {
  let priority: number | undefined;
  if (prev && next) {
    if (next.priority - prev.priority >= 2) {
      priority = Math.floor((prev.priority + next.priority) / 2);
    }
  } else if (next) {
    priority = next.priority - PRIORITY_STEP;
  } else if (prev) {
    priority = prev.priority + PRIORITY_STEP;
  } else {
    return null;
  }

  if (priority !== undefined) {
    return {
      priority,
      updates:
        priority === dragged.priority ? [] : [{ id: dragged.id, priority }],
    };
  }

  // No integer gap between the neighbours (equal or adjacent priorities, e.g.
  // legacy all-0 columns): renumber the whole known column. Owner/triggerer
  // filters are applied server-side, so cards they hide are not in
  // `fullColumn` and keep their old priorities (accepted residual).
  const rest = fullColumn.filter((t) => t.id !== dragged.id);
  const draggedFull = fullColumn.find((t) => t.id === dragged.id) ?? dragged;
  let insertAt = prev ? rest.findIndex((t) => t.id === prev.id) + 1 : -1;
  if (insertAt <= 0 && next) insertAt = rest.findIndex((t) => t.id === next.id);
  if (insertAt < 0) return null;
  rest.splice(insertAt, 0, draggedFull);

  const before = new Map(fullColumn.map((t) => [t.id, t.priority]));
  const renumbered = rest.map((task, idx) => ({
    id: task.id,
    priority: idx * PRIORITY_STEP,
  }));
  return {
    priority: renumbered[insertAt].priority,
    updates: renumbered.filter(({ id, priority: p }) => before.get(id) !== p),
  };
}

/**
 * Non-running card following `prev` in the full column, skipping the dragged
 * card. Used when no visible card follows the drop slot, so hidden cards
 * after the visible slice still bound the new priority.
 */
function nextHiddenNeighbour(
  prev: ReorderTask | undefined,
  dragged: ReorderTask,
  fullColumn: readonly ReorderTask[],
): ReorderTask | undefined {
  if (!prev) return undefined;
  const prevFullIdx = fullColumn.findIndex((t) => t.id === prev.id);
  if (prevFullIdx < 0) return undefined;
  return fullColumn
    .slice(prevFullIdx + 1)
    .find((t) => !t.running && t.id !== dragged.id);
}

/**
 * Priority rewrites needed after moving a card inside one column. Done
 * columns sort by completion time, so a drag there must not rewrite priorities.
 *
 * `col` is the visible slice the user dragged within. `fullColumn` holds every
 * client-known card of the stage in canonical order, including cards hidden by
 * search, objective/archived filters or pagination. Only the dragged card gets
 * a new priority (between its new neighbours, looking past the visible slice
 * for the next one), so hidden cards keep their relative order; the server
 * queue runs tasks in priority order.
 */
export function computeReorderUpdates(
  col: readonly ReorderTask[],
  oldIdx: number,
  newIdx: number,
  stageType: StageDefinition['type'] | undefined,
  fullColumn: readonly ReorderTask[],
): ReorderUpdate[] {
  if (stageType === 'done' || oldIdx === newIdx) return [];

  const moved = arrayMove([...col], oldIdx, newIdx);
  const dragged = moved[newIdx];
  if (!dragged) return [];

  // Running cards always sort first regardless of priority, so they say
  // nothing about where the dragged card belongs in priority order.
  const prev = moved
    .slice(0, newIdx)
    .reverse()
    .find((t) => !t.running);
  const next =
    moved.slice(newIdx + 1).find((t) => !t.running) ??
    nextHiddenNeighbour(prev, dragged, fullColumn);
  return placeBetween(prev, next, dragged, fullColumn)?.updates ?? [];
}

export interface InsertPlacement {
  /** New priority of the card that moves into the column. */
  priority: number;
  /** Other cards renumbered because no integer gap exists; apply them first. */
  others: ReorderUpdate[];
}

/**
 * Priority for a card entering a column from another one, inserted at
 * `insertIdx` of the visible slice `col` (which does not contain the card).
 * Returns null when the column has no non-running card to anchor on (the card
 * then simply moves and keeps its priority) or for done columns. A card placed
 * after the last visible card goes directly after it, ahead of hidden cards.
 */
export function computeInsertPlacement(
  col: readonly ReorderTask[],
  insertIdx: number,
  dragged: ReorderTask,
  stageType: StageDefinition['type'] | undefined,
  fullColumn: readonly ReorderTask[],
): InsertPlacement | null {
  if (stageType === 'done') return null;

  const prev = col
    .slice(0, insertIdx)
    .reverse()
    .find((t) => !t.running);
  const next =
    col.slice(insertIdx).find((t) => !t.running) ??
    nextHiddenNeighbour(prev, dragged, fullColumn);

  const placement = placeBetween(prev, next, dragged, fullColumn);
  if (!placement) return null;
  return {
    priority: placement.priority,
    others: placement.updates.filter((u) => u.id !== dragged.id),
  };
}
