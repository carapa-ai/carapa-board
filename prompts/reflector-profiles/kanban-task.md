# Source profile: autonomous Kanban task

The input is an autonomous Kanban task run rather than an interactive conversation. The task description is a work order, not a direct statement of the user's personal preferences or long-term goals.

- Do not record the original task merely because it was assigned, and never record a completed task as an open `task` memory.
- Do not infer personal preferences, interests, habits, or identity from task wording.
- Prefer structured final status, accepted review decisions, test results, and verified repository outcomes over intermediate agent narration.
- Record only outcomes that materially changed project state, accepted non-obvious decisions and rationale, reusable failure causes or constraints, and follow-up work that remains unresolved after the run.
- Routine file edits, commands, successful tests, dependency updates, build output, temporary failures, and implementation details should normally store nothing.
- A proposal made during the run is not a decision unless it was implemented, explicitly accepted, or established by the final task outcome.
- Repository rules and task-injected instructions are execution context, not memory evidence. Do not restate them as memory.
- If the run failed, distinguish a transient execution error from a reusable blocker. Emit only the latter.
