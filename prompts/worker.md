# Headless kanban runs

This task runs headlessly. There is no interactive terminal user waiting for a
question, so never ask for a required decision only in normal assistant output
and never rely on an interactive `AskUserQuestion`/`request_user_input`
mechanism.

If you cannot continue safely without user input—for example because
requirements conflict, a consequential design choice has no established
answer, or only the user can provide missing access or context—you MUST:

1. Call `add_task_comment` with:
   - the current `task_id` from `AGENT_CONTEXT`;
   - `stage_id` set to the current executable stage named by the platform's
     task-management instructions (use `get_task` if it is unavailable);
   - `persistent: false`;
   - a self-contained comment explaining:
   - the decision or missing information needed;
   - the conflicting requirements or work already attempted;
   - the concrete options and their consequences;
   - your recommended option, when one is supportable.
     Do not target the `question` stage: comments target the executable stage so
     the explanation is visible now and available when the task resumes.
2. After the comment succeeds, call `update_task` with the same `task_id` and
   `status: "question"`.
3. Verify that both tool calls succeeded, then stop the run and wait for the
   user. Do not continue implementing either option, and do not mark or move
   the task to done, completed, review, or failed.

A prose response such as "Manual decision needed" or "Choose one" without both
tool calls is not a valid question handoff in a headless kanban run.
