/**
 * Opt-in notification fixtures (`UI_SANDBOX_NOTIFICATIONS_EVAL=1 npm run ui:sandbox`).
 *
 * Unread notifications of the kinds the bell and the Now panel handle:
 * agent-ask forms of several shapes (select; multi-line + checkbox + email;
 * integer with a server-only rule; a long scrolling form; long labels), text
 * notifications (long Markdown with an action link, short without action,
 * long summary), and notifications attached to a question task, a failed
 * task, a review task and a conversation (those render in the Now panel).
 * Acknowledged notifications are not listed anywhere, so there is no read
 * fixture: the bell only ever shows unread items.
 * Kept out of the default seed so the other scenarios keep their small data.
 */
import { eq } from 'drizzle-orm';

import { drizzleDbRef } from '../../src/db/drizzle-client.js';
import { notificationPayloads, tasks } from '../../src/db/schema.js';
import { storePayload } from '../../src/modules/push/payload-store.js';

export const NOTIFICATIONS_EVAL = {
  project: 'ui-running',
  questionTask: 'ui-nt-question',
  failedTask: 'ui-nt-failed',
  reviewTask: 'ui-nt-review',
  /** Tasks whose attention notifications use the real lifecycle source ids. */
  attentionQuestionTask: 'ui-nt-attn-question',
  attentionFailedTask: 'ui-nt-attn-failed',
  attentionLateTask: 'ui-nt-attn-late',
  attentionCostTask: 'ui-nt-attn-cost',
  /** Stable `source_tool_use_id` prefix; the audit views find items by summary. */
  prefix: 'ui-nt-eval',
} as const;

const MARKDOWN_BODY = [
  'The audit finished at **03:12** and found **4 packages** that need a decision. Nothing was changed yet.',
  '',
  '| Package | Current | Latest | Risk |',
  '| --- | --- | --- | --- |',
  '| `vite` | 6.3.1 | 7.0.2 | build config changes |',
  '| `zod` | 3.24.0 | 4.1.0 | breaking schema API |',
  '| `drizzle-orm` | 0.41.0 | 0.44.2 | migration snapshot format |',
  '| `lucide-react` | 0.468.0 | 0.544.0 | none known |',
  '',
  '### What I checked',
  '',
  '1. Changelogs of every package above, back to the installed version.',
  '2. Usage in `ui/src` and `src` with `rg` (zod appears in 41 files).',
  '3. Whether the lockfile pins transitive versions that would block the bump.',
  '',
  '```bash',
  'bun outdated',
  'bun pm ls --all | rg "zod|drizzle"',
  '```',
  '',
  '> The zod 4 bump touches every route validator. I would not combine it with the Vite bump.',
  '',
  '### Suggested order',
  '',
  '- `lucide-react` first (low risk, one commit).',
  '- `vite` next, with the build config diff reviewed by you.',
  '- `drizzle-orm` only after the migration snapshot is regenerated on a copy.',
  '- `zod` as its own task with a separate review.',
  '',
  'Full report: [dependency audit](/chat/ui-chat) and the [board](/board/ui-running).',
  '',
  'Reply here if you want me to create the four tasks, or open the chat to discuss the order.',
].join('\n');

const LONG_FORM_FIELDS = Object.fromEntries(
  [
    ['project_name', 'Project name', 'string'],
    ['owner', 'Owner', 'string'],
    ['summary', 'One-line summary', 'string'],
    ['problem', 'Problem statement', 'multiline'],
    ['users', 'Who is affected', 'string'],
    ['deadline', 'Target date', 'date'],
    ['budget', 'Budget (EUR)', 'number'],
    ['priority', 'Priority', 'enum'],
    ['risk', 'Biggest risk', 'multiline'],
    ['contact', 'Contact email', 'email'],
    ['phone', 'Contact phone', 'tel'],
    ['needs_review', 'Needs a security review', 'boolean'],
    ['needs_design', 'Needs design input', 'boolean'],
    ['notes', 'Anything else', 'multiline'],
  ].map(([key, title, kind]) => [
    key,
    kind === 'multiline'
      ? { type: 'string', title, format: 'multiline' }
      : kind === 'date'
        ? { type: 'string', title, format: 'date' }
        : kind === 'email'
          ? { type: 'string', title, format: 'email' }
          : kind === 'tel'
            ? { type: 'string', title, format: 'tel' }
            : kind === 'number'
              ? { type: 'number', title, minimum: 0 }
              : kind === 'boolean'
                ? { type: 'boolean', title }
                : kind === 'enum'
                  ? { type: 'string', title, enum: ['low', 'normal', 'high'] }
                  : { type: 'string', title },
  ]),
);

const forms: Array<{
  key: string;
  summary: string;
  ageMinutes: number;
  schema: object;
  action_url?: string;
  respondTo?: { kind: 'task'; id: string };
}> = [
  {
    key: 'form-select',
    summary: 'Which environment should I deploy to?',
    ageMinutes: 4,
    schema: {
      type: 'object',
      title: 'Deploy target',
      description:
        'The release build is green. I need the environment before I start the deploy.',
      properties: {
        environment: {
          type: 'string',
          title: 'Environment',
          enum: ['staging', 'preview', 'production'],
        },
        note: {
          type: 'string',
          title: 'Note for the release log',
          description: 'Optional. Shown next to the deploy entry.',
        },
      },
      required: ['environment'],
    },
  },
  {
    key: 'form-multiline',
    summary: 'Draft the release announcement',
    ageMinutes: 55,
    schema: {
      type: 'object',
      title: 'Release announcement',
      description:
        'I wrote the changelog. Tell me what the announcement should say.',
      properties: {
        message: {
          type: 'string',
          title: 'Announcement text',
          format: 'multiline',
          minLength: 20,
          description: 'At least 20 characters.',
        },
        tone: {
          type: 'string',
          title: 'Tone',
          enum: ['neutral', 'friendly', 'formal'],
        },
        contact: { type: 'string', title: 'Reply-to email', format: 'email' },
        notify: { type: 'boolean', title: 'Also notify the team channel' },
      },
      required: ['message'],
      submit_label: 'Send to agent',
    },
  },
  {
    key: 'form-server-rule',
    summary: 'Capacity plan: how many runners?',
    ageMinutes: 190,
    schema: {
      type: 'object',
      title: 'Runner capacity',
      properties: {
        runners: {
          type: 'integer',
          title: 'Runners',
          minimum: 5,
          maximum: 100,
          multipleOf: 5,
          description: 'Multiples of 5 only (checked by the server).',
        },
        start: { type: 'string', title: 'Start date', format: 'date' },
      },
      required: ['runners'],
      submit_label: 'Send plan',
    },
  },
  {
    key: 'form-long',
    summary: 'Quarterly project intake',
    ageMinutes: 60 * 26,
    schema: {
      type: 'object',
      title: 'Project intake',
      description: 'Fill in what you know. Required fields are marked.',
      properties: LONG_FORM_FIELDS,
      required: ['project_name', 'owner', 'problem', 'priority'],
    },
  },
  {
    key: 'form-long-labels',
    summary:
      'Weekly review of the staging environment finished with 3 warnings and 1 blocked deployment waiting for your approval',
    ageMinutes: 60 * 24 * 4,
    schema: {
      type: 'object',
      title:
        'Approve or reject the blocked staging deployment of the billing service after the three warnings',
      properties: {
        decision: {
          type: 'string',
          title:
            'Your decision on the blocked deployment of the billing service to the staging environment',
          enum: [
            'approve and deploy now',
            'approve, deploy after the maintenance window tonight',
            'reject and roll back to the previous release',
          ],
          description:
            'The warnings are: a slow migration on the invoices table, a deprecated payment API call and a missing index on customer_id.',
        },
      },
      required: ['decision'],
    },
  },
];

const texts: Array<{
  key: string;
  summary: string;
  content: string;
  ageMinutes: number;
  action_url?: string;
}> = [
  {
    key: 'text-markdown',
    summary: 'Nightly dependency audit: 4 packages need a decision',
    content: MARKDOWN_BODY,
    ageMinutes: 18,
    action_url: '/chat/ui-chat',
  },
  {
    key: 'text-short',
    summary: 'Nightly backup finished',
    content: 'All 5 projects were backed up in 42 seconds. No action needed.',
    ageMinutes: 60 * 9,
  },
  {
    key: 'text-board-link',
    summary: 'Paused project has 2 tasks ready to resume',
    content:
      'The paused project has two backlog tasks whose dependencies are done. Open the board to resume them.',
    ageMinutes: 60 * 50,
    action_url: '/board/ui-paused',
  },
];

async function insertTask(
  id: string,
  title: string,
  status: string,
  ageMinutes: number,
  extra: Record<string, unknown> = {},
) {
  await drizzleDbRef.current.insert(tasks).values({
    id,
    project_id: NOTIFICATIONS_EVAL.project,
    title,
    description: `Fixture task for the notification evaluation (${status}).`,
    status,
    priority: 0,
    created_at: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
    archived: 0,
    ...extra,
  } as never);
}

export async function seedNotificationsEvalFixtures(opts: {
  adminId: string;
}): Promise<void> {
  const { project, questionTask, failedTask, reviewTask, prefix } =
    NOTIFICATIONS_EVAL;
  await insertTask(
    questionTask,
    'Which payment provider should checkout use?',
    'question',
    35,
  );
  await insertTask(
    failedTask,
    'Migrate invoices table to the new schema',
    'failed',
    130,
  );
  await insertTask(
    reviewTask,
    'Add CSV export to the reports page',
    'review',
    75,
  );

  const ages = new Map<string, number>();
  const store = async (
    key: string,
    input: Parameters<typeof storePayload>[0],
    ageMinutes: number,
  ) => {
    const { id } = await storePayload({
      ...input,
      user_id: opts.adminId,
      source_tool_use_id: `${prefix}-${key}`,
    });
    ages.set(id, ageMinutes);
  };

  for (const f of forms) {
    await store(
      f.key,
      {
        user_id: opts.adminId,
        kind: 'json_form',
        summary: f.summary,
        content: JSON.stringify(f.schema),
        action_url: f.action_url ?? null,
        respond_to: f.respondTo ?? null,
      },
      f.ageMinutes,
    );
  }
  for (const t of texts) {
    await store(
      t.key,
      {
        user_id: opts.adminId,
        kind: 'text',
        summary: t.summary,
        content: t.content,
        action_url: t.action_url ?? null,
      },
      t.ageMinutes,
    );
  }

  // Attached to a Now row: a form for the question task, plain notifications
  // for the failed task, the review task and a conversation.
  await store(
    'form-task-question',
    {
      user_id: opts.adminId,
      kind: 'json_form',
      summary: 'Which payment provider should checkout use?',
      content: JSON.stringify({
        type: 'object',
        title: 'Payment provider',
        description: 'The task is blocked until you pick one.',
        properties: {
          provider: {
            type: 'string',
            title: 'Provider',
            enum: ['Stripe', 'Adyen', 'Mollie'],
          },
          reason: {
            type: 'string',
            title: 'Why this one',
            format: 'multiline',
          },
        },
        required: ['provider'],
      }),
      action_url: `/board/${project}?taskId=${questionTask}`,
      respond_to: { kind: 'task', id: questionTask },
    },
    35,
  );
  await store(
    'text-task-failed',
    {
      user_id: opts.adminId,
      kind: 'text',
      summary: 'Task failed: Migrate invoices table to the new schema',
      content:
        'The migration run exited with code 1 after 14 minutes.\n\nLast error: `relation "invoice_lines" does not exist`. The rollback succeeded, so no data changed.',
      action_url: `/board/${project}?taskId=${failedTask}`,
    },
    130,
  );
  await store(
    'text-task-review',
    {
      user_id: opts.adminId,
      kind: 'text',
      summary: 'Ready for review: Add CSV export to the reports page',
      content:
        'The reviewer approved with 8/10. Two optional follow-ups were noted in the task history.',
      action_url: `/board/${project}?taskId=${reviewTask}`,
    },
    75,
  );
  await store(
    'text-conversation',
    {
      user_id: opts.adminId,
      kind: 'text',
      summary: 'New reply in "Pinned conversation"',
      content: 'The agent answered your question about the release checklist.',
      action_url: '/chat/ui-chat?conversationId=ui-conversation-pinned',
    },
    12,
  );

  // Lifecycle-sourced attention notifications (`task:<task>:<run>:<event>:<user>`,
  // as `notifyEntityLifecycle` stores them), unlike the fixtures above. The
  // Question and Failed task rows go away when the task is moved out; the late
  // delivery (task in Backlog) is never shown; the cost-limit alert is.
  const {
    attentionQuestionTask,
    attentionFailedTask,
    attentionLateTask,
    attentionCostTask,
  } = NOTIFICATIONS_EVAL;
  await insertTask(
    attentionQuestionTask,
    'Pick the retry policy for webhook delivery',
    'question',
    20,
  );
  await insertTask(
    attentionFailedTask,
    'Rebuild the search index',
    'failed',
    25,
  );
  await insertTask(attentionLateTask, 'Late delivery fixture', 'backlog', 30);
  await insertTask(
    attentionCostTask,
    'Cost limit reached fixture',
    'backlog',
    40,
  );
  for (const [taskId, run, event, summary] of [
    [
      attentionQuestionTask,
      'run-seed-1',
      'needs_input',
      'Task needs your attention',
    ],
    [
      attentionFailedTask,
      'run-seed-1',
      'failed',
      'Task failed: Rebuild the search index',
    ],
    [
      attentionLateTask,
      'run-seed-1',
      'failed',
      'Task failed: Late delivery fixture',
    ],
    [
      attentionCostTask,
      'cost-limit',
      'needs_input',
      'Task needs your attention',
    ],
  ] as const) {
    await storePayload({
      user_id: opts.adminId,
      kind: 'text',
      summary,
      content: summary,
      action_url: `/board/${project}?taskId=${taskId}`,
      source_tool_use_id: `task:${taskId}:${run}:${event}:${opts.adminId}`,
    });
  }

  // storePayload stamps "now"; spread the ages so the list shows a realistic
  // mix of minutes, hours and days.
  const now = Date.now();
  for (const [id, minutes] of ages) {
    await drizzleDbRef.current
      .update(notificationPayloads)
      .set({ created_at: new Date(now - minutes * 60_000).toISOString() })
      .where(eq(notificationPayloads.id, id));
  }
}
