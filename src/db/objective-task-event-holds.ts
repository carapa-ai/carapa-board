import { and, asc, eq, lt } from 'drizzle-orm';
import { drizzleDbRef } from './drizzle-client.js';
import { objectiveTaskEventHolds } from './schema.js';

export type ObjectiveTaskEventHold =
  typeof objectiveTaskEventHolds.$inferSelect;
export type ObjectiveTaskEventType = ObjectiveTaskEventHold['event_type'];

export async function insertObjectiveTaskEventHold(
  hold: typeof objectiveTaskEventHolds.$inferInsert,
): Promise<void> {
  await drizzleDbRef.current.insert(objectiveTaskEventHolds).values(hold);
}

/**
 * Atomically move a `held` row to its final state. Returns the row only to the
 * caller that won the transition, so each hold is delivered at most once.
 */
export async function settleObjectiveTaskEventHold(
  id: string,
  state: 'notified' | 'dropped',
): Promise<ObjectiveTaskEventHold | undefined> {
  const [row] = await drizzleDbRef.current
    .update(objectiveTaskEventHolds)
    .set({ state, settled_at: new Date().toISOString() })
    .where(
      and(
        eq(objectiveTaskEventHolds.id, id),
        eq(objectiveTaskEventHolds.state, 'held'),
      ),
    )
    .returning();
  return row;
}

/** Open holds for one task, event type and objective, oldest first. */
export async function listOpenObjectiveTaskEventHolds(match: {
  task_id: string;
  event_type: ObjectiveTaskEventType;
  objective_id: string;
  event_timestamp?: string;
}): Promise<ObjectiveTaskEventHold[]> {
  return drizzleDbRef.current
    .select()
    .from(objectiveTaskEventHolds)
    .where(
      and(
        eq(objectiveTaskEventHolds.state, 'held'),
        eq(objectiveTaskEventHolds.task_id, match.task_id),
        eq(objectiveTaskEventHolds.event_type, match.event_type),
        eq(objectiveTaskEventHolds.objective_id, match.objective_id),
        match.event_timestamp
          ? eq(objectiveTaskEventHolds.event_timestamp, match.event_timestamp)
          : undefined,
      ),
    )
    .orderBy(asc(objectiveTaskEventHolds.created_at));
}

/** Open holds created before `cutoff` (ISO). */
export async function listOverdueObjectiveTaskEventHolds(
  cutoff: string,
): Promise<ObjectiveTaskEventHold[]> {
  return drizzleDbRef.current
    .select()
    .from(objectiveTaskEventHolds)
    .where(
      and(
        eq(objectiveTaskEventHolds.state, 'held'),
        lt(objectiveTaskEventHolds.created_at, cutoff),
      ),
    )
    .orderBy(asc(objectiveTaskEventHolds.created_at));
}
