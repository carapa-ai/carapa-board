/**
 * Admission of a sandbox run, and the launch inputs that depend on the project
 * and its objective as they are once admission is granted.
 *
 * A launch that waits for maintenance (a parent change) resumes against a
 * different project row and, for an objective conversation, a different
 * stored working directory. Whatever the caller captured before waiting is
 * therefore read again here, in one place, instead of being forwarded.
 */
import { objectiveWorkDir } from '../modules/objectives/work-dir.js';
import type { RegisteredGroup } from '../types.js';

interface LaunchTicket {
  settle(): void;
  waited: boolean;
}

export interface RunAdmissionDeps {
  admit(
    instance: string | undefined,
    options: { chat: boolean; conversationId?: string },
  ): Promise<LaunchTicket>;
  resolveInstance(group: RegisteredGroup): string;
  getGroup(folder: string): RegisteredGroup | undefined;
  getObjective(
    id: string,
  ): Promise<{ id: string; work_dir?: string | null } | undefined>;
}

/** The objective working directory for `group` as it is now; undefined if gone. */
async function currentObjectiveWorkDir(
  group: RegisteredGroup,
  objectiveId: string,
  getObjective: RunAdmissionDeps['getObjective'],
): Promise<string | undefined> {
  const objective = await getObjective(objectiveId);
  return objective ? objectiveWorkDir(group, objective) : undefined;
}

export interface RunInput {
  group_folder: string;
  task_id?: string;
  scheduled_task_id?: string;
  conversation_id?: string;
  work_dir?: string;
  /** Set when `work_dir` was derived from this objective, not given by the caller. */
  objective_work_dir_of?: string;
}

export async function admitRun<I extends RunInput>(
  group: RegisteredGroup,
  input: I,
  deps: RunAdmissionDeps,
): Promise<{ group: RegisteredGroup; input: I; settle(): void }> {
  // Scheduled chat-context runs also need to wait for an executing restart.
  const chat = !input.task_id;
  let ticket: LaunchTicket | undefined;
  try {
    let current = group;
    // Any admission that waited means the project may have changed under the
    // caller, even when the final one found nothing to wait for.
    let waited = false;
    for (let attempt = 0; ; attempt++) {
      // Parallel-slot instances share the owner's mounts: hold by the owner's.
      const instance = deps.resolveInstance(current);
      ticket = await deps.admit(instance, {
        chat,
        conversationId: input.conversation_id,
      });
      waited ||= ticket.waited;
      if (!ticket.waited) break;
      const fresh = deps.getGroup(input.group_folder) ?? current;
      const moved = deps.resolveInstance(fresh) !== instance;
      current = fresh;
      if (!moved || attempt >= 2) break;
      // Admitted to an instance the project no longer uses: admit again.
      ticket.settle();
    }
    let launchInput = input;
    if (waited && input.objective_work_dir_of) {
      const workDir = await currentObjectiveWorkDir(
        current,
        input.objective_work_dir_of,
        deps.getObjective,
      );
      if (workDir) launchInput = { ...input, work_dir: workDir };
    }
    const held = ticket;
    return { group: current, input: launchInput, settle: () => held.settle() };
  } catch (err) {
    ticket?.settle();
    throw err;
  }
}
