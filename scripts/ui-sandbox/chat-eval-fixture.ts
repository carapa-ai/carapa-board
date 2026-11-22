/**
 * Opt-in chat-rendering fixtures (`UI_SANDBOX_CHAT_EVAL=1 npm run ui:sandbox`).
 *
 * One realistic long conversation plus one surface per consumer of
 * `ChatMessageBubble`: a task run with stages (task detail), an objective event
 * run (Runs tab) and a scheduled-task run. Kept out of the default seed so the
 * other sandbox scenarios keep their small, stable fixtures.
 */
import fs from 'node:fs';
import path from 'node:path';

import { drizzleDbRef } from '../../src/db/drizzle-client.js';
import {
  activeRuns,
  conversations,
  taskRunLogs,
  tasks,
} from '../../src/db/schema.js';
import { saveChatMessage } from '../../src/modules/chat/db-chats.js';
import { inviteConversationAiUser } from '../../src/modules/ai-users/db-ai-users.js';
import {
  appendRunStartMarker,
  appendTaskMessage,
} from '../../src/modules/transcripts/transcript-store.js';
import { GROUPS_DIR } from '../../src/config.js';
import { getObjectiveDir } from '../../src/modules/objectives/objective-folder.js';

export const CHAT_EVAL = {
  project: 'ui-chat',
  conversation: 'ui-chat-eval',
  forkConversation: 'ui-chat-eval-fork',
  revealConversation: 'ui-chat-eval-reveal',
  taskProject: 'ui-running',
  task: 'ui-task-chat-eval',
  objectiveProject: 'ui-objectives',
  objective: 'ui-objective-active',
  objectiveRun: 'run-chat-eval-1',
  scheduledTask: 'ui-scheduled-chat',
  scheduledRun: 'ui-scheduled-run-chat-eval',
} as const;

const BASE = Date.parse('2026-07-27T08:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

export const PROSE = [
  'The renderer keeps one message component for every surface, so a change to spacing or typography shows up in the project chat, the task details dialog, the objective Runs tab and the scheduled-task dialog at the same time. That is the main reason to measure each surface instead of judging one screenshot.',
  'Line length matters most for the long assistant turns. When a reply spans the full width of a wide window, the eye has to travel more than a hundred characters before it can return to the start of the next line, and readers lose their place. A measure between sixty and ninety characters keeps long prose comfortable without wasting space on tables and code.',
  'Tool activity is the other source of noise. A single turn can call a dozen tools, and each one can print several screens of output. The summary line has to tell the reader what happened, whether it worked and how long it took, and only the failures should draw attention.',
  'Streaming adds a third concern: the viewport must stay where the reader put it. Following the newest token is right when the reader is already at the bottom and wrong as soon as they scroll up to re-read something.',
];

export const WIDE_CODE = [
  '```ts',
  'export async function loadConversationPage(projectId: string, conversationId: string, options: { before?: string; limit?: number; includeToolActivity?: boolean; signal?: AbortSignal } = {}): Promise<ConversationPage> {',
  '  const params = new URLSearchParams({ limit: String(options.limit ?? 50) });',
  "  if (options.before) params.set('before', options.before);",
  '  const response = await apiFetch(`${API_BASE_URL}/api/projects/${projectId}/conversations/${conversationId}/messages?${params}`, { signal: options.signal });',
  '  if (!response.ok) throw new Error(`Request failed (${response.status})`);',
  '  return (await response.json()) as ConversationPage;',
  '}',
  '```',
].join('\n');

export const TABLE = [
  '| Surface | Mode | Wrapper | Max height | Notes |',
  '| --- | --- | --- | --- | --- |',
  '| Project chat | chat-page | `chat-message-content` | 50vh | Bubble-first layout, actions below |',
  '| Task details | task-detail | `chat-message-content` | 40vh | Metadata above, run divider carries the agent |',
  '| Objective Runs | task-detail | `chat-message-content` | 40vh | Telemetry from run-stats |',
  '| Scheduled run | task-detail | `chat-message-content` | 40vh | Same as task details |',
  '| Long cells | chat-page | `ui/src/components/chat/message/chat-message-bubble/chat-message-bubble-content.tsx` | 50vh | This row is deliberately verbose so the table shows how a wide, prose-heavy cell wraps inside a capped column instead of stretching the whole table sideways: every agent answer that pastes a long explanation, a command line or a URL into a cell should stay readable without any horizontal scrolling inside the bubble or the pane, even on a phone. See https://example.com/docs/reference/very/long/path/to/some/resource?query=value&other=another-value |',
].join('\n');

function toolCall(
  id: string,
  name: string,
  arg: string,
  result: string | null,
  failed = false,
): string {
  const request = `<!-- carapa-tool:request tool-id="${id}" -->\n> **${name}** \`${arg}\``;
  if (result === null) return request;
  const quoted = result
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${request}\n\n<!-- carapa-tool:${failed ? 'error' : 'result'} tool-id="${id}" -->\n${quoted}`;
}

const fence = (lines: string[]) => ['```', ...lines, '```'].join('\n');

const longBashOutput = fence(
  Array.from(
    { length: 160 },
    (_, i) =>
      `src/modules/example/file-${String(i + 1).padStart(3, '0')}.test.ts ... ${i % 17 === 0 ? 'skipped' : 'ok'} (${(i % 9) + 1}ms)`,
  ),
);

export function toolRound(
  seed: string,
  withErrorAndLongOutput = false,
): string {
  const calls = [
    toolCall(
      `${seed}-1`,
      'Read',
      'ui/src/components/chat/chat-message-bubble.tsx',
      fence([
        'export const ChatMessageBubble = memo(function ChatMessageBubble({',
        '  id,',
        '  role,',
        '  content,',
        '}: ChatMessageBubbleProps) {',
      ]),
    ),
    toolCall(`${seed}-2`, 'Grep', 'ChatMessageBubble ui/src', '4 files'),
    toolCall(
      `${seed}-3`,
      'Glob',
      'ui/src/**/*.browser.test.ts',
      fence([
        'ui/src/components/chat/chat-message-bubble.browser.test.ts',
        'ui/src/components/chat/queued-prompt-list.browser.test.ts',
      ]),
    ),
    toolCall(
      `${seed}-4`,
      'Bash',
      'git status --short',
      fence([' M ui/src/components/chat/chat-message-bubble.tsx']),
    ),
    toolCall(
      `${seed}-5`,
      'Edit',
      'ui/src/components/markdown-content.tsx',
      'ok',
    ),
  ];
  if (withErrorAndLongOutput) {
    calls.push(
      toolCall(`${seed}-6`, 'Bash', 'bun test --only-failures', longBashOutput),
      toolCall(
        `${seed}-7`,
        'Bash',
        'bun run typecheck',
        'Permission denied while opening the configured workspace.',
        true,
      ),
    );
  }
  return calls.join('\n\n');
}

function assistantTurn(index: number): string {
  const parts: string[] = [];
  const kind = index % 6;
  if (kind === 0) {
    parts.push(`## Findings for step ${index}`, PROSE[index % PROSE.length]);
    parts.push(
      '- First, the width of the reading column\n- Second, how much vertical space tool blocks take\n- Third, what happens while the answer streams',
      TABLE,
      PROSE[(index + 1) % PROSE.length],
    );
  } else if (kind === 1) {
    parts.push(
      PROSE[index % PROSE.length],
      WIDE_CODE,
      PROSE[(index + 2) % PROSE.length],
    );
  } else if (kind === 2) {
    parts.push(
      'Let me look at the current implementation before changing anything.',
      toolRound(`t${index}`),
      PROSE[index % PROSE.length],
    );
  } else if (kind === 3) {
    parts.push(
      PROSE[index % PROSE.length],
      '> Keep the shared component as the single renderer; surfaces differ only through props.',
    );
  } else if (kind === 4) {
    parts.push(
      `### Notes\n\n1. Check the **desktop** layout first.\n2. Then the \`390px\` mobile layout.\n3. Finally the dark theme.\n\n${PROSE[(index + 3) % PROSE.length]}`,
    );
  } else {
    parts.push(PROSE[index % PROSE.length]);
  }
  return parts.join('\n\n');
}

const USER_PROMPTS = [
  'Can you review how the chat renders long answers?',
  'Please check the tool output handling too.',
  'What does the table look like on a narrow screen?',
  'Thanks. Now compare the task details dialog.',
  'Is anything different in the objective Runs tab?',
  'Summarize what you would change first.',
];

export async function seedChatEvalFixtures(opts: {
  adminId: string;
  personaId: string;
}): Promise<void> {
  const db = drizzleDbRef.current;
  const { project, conversation } = CHAT_EVAL;
  const FIRST = at(0);
  const LAST = at(240);

  // ── Long conversation ────────────────────────────────────────────────────
  await db.insert(conversations).values([
    {
      id: conversation,
      group_folder: project,
      title: 'Chat rendering evaluation (long)',
      preview: 'Long conversation with markdown, tools and a persona turn.',
      pinned: 0,
      created_at: FIRST,
      read_at: LAST,
      last_user_at: LAST,
      last_assistant_at: LAST,
      ownerUserId: opts.adminId,
      lastTriggeredByUserId: opts.adminId,
      lastTriggerSource: 'user',
      lastTriggeredAt: LAST,
    },
  ] as never);
  await inviteConversationAiUser(conversation, opts.personaId, opts.adminId);

  const save = (
    id: string,
    role: 'user' | 'assistant' | 'system',
    minute: number,
    content: string,
    extra: Record<string, unknown> = {},
  ) =>
    saveChatMessage({
      id: `chat-eval-${id}`,
      group_folder: project,
      conversation_id: conversation,
      role,
      source: 'web',
      created_at: at(minute),
      content,
      ...extra,
    } as never);

  let minute = 0;
  for (let turn = 1; turn <= 24; turn++) {
    await save(
      `u${turn}`,
      'user',
      minute++,
      USER_PROMPTS[turn % USER_PROMPTS.length],
    );
    const heavy = turn === 9;
    await save(
      `a${turn}`,
      'assistant',
      minute++,
      heavy
        ? [
            'I will run the checks and read the failing output.',
            toolRound(`heavy${turn}`, true),
            '> *The suite is mostly green; only the typecheck call failed because the workspace was not mounted.*',
            'The typecheck failure is environmental, so I am treating the run as passing and moving on.',
          ].join('\n\n')
        : assistantTurn(turn),
      {
        telemetry: {
          model_name: 'claude-sonnet-4.6',
          tok_input: 1200 + turn * 37,
          tok_output: 380 + turn * 11,
          tok_cache_read: 8200,
          tok_context_last: 24_000 + turn * 800,
          context_size: 200_000,
          duration_ms: 4200 + turn * 130,
          cost_usd: 0.0123 + turn * 0.0007,
        },
      },
    );
    if (turn === 5) {
      await save(
        `sys${turn}`,
        'system',
        minute++,
        'Model switched to claude-sonnet-4.6 for this conversation.',
      );
    }
    if (turn === 7) {
      await save(
        `u${turn}-att`,
        'user',
        minute++,
        'Here is the screenshot of the current layout and the spec.',
        {
          attachments: [
            {
              type: 'image',
              url: `/artifacts/${project}/media/fixture-image.png`,
              mimetype: 'image/png',
              filename: 'chat-layout.png',
            },
            {
              type: 'document',
              url: `/artifacts/${project}/media/fixture-image.png`,
              mimetype: 'application/pdf',
              filename: 'chat-spec-v3-final-review-comments.pdf',
            },
          ],
        },
      );
      await save(
        `a${turn}-att`,
        'assistant',
        minute++,
        'Thanks, I can see both the layout and the spec.',
      );
    }
    if (turn === 12) {
      await save(
        `persona${turn}`,
        'assistant',
        minute++,
        `${PROSE[1]}\n\n${TABLE}`,
        {
          sender_name: 'Mara',
          senderUserId: `ai:${opts.personaId}`,
          telemetry: {
            model_name: 'persona-fixture-model',
            total_tokens: 2400,
            duration_ms: 3200,
          },
        },
      );
    }
  }

  // ── Fork: inherited messages, divider, then fork-only messages ─────────────
  const forkAt = at(500);
  await db.insert(conversations).values({
    id: CHAT_EVAL.forkConversation,
    group_folder: project,
    title: 'Chat rendering evaluation (fork)',
    preview: 'Fork of the long evaluation conversation.',
    pinned: 0,
    forked_from: conversation,
    created_at: forkAt,
    read_at: at(520),
    last_user_at: at(520),
    last_assistant_at: at(520),
    ownerUserId: opts.adminId,
    lastTriggeredByUserId: opts.adminId,
    lastTriggerSource: 'user',
    lastTriggeredAt: at(520),
  } as never);
  const forkSave = (
    id: string,
    role: 'user' | 'assistant',
    minuteAt: number,
    content: string,
  ) =>
    saveChatMessage({
      id: `chat-eval-fork-${id}`,
      group_folder: project,
      conversation_id: CHAT_EVAL.forkConversation,
      role,
      source: 'web',
      created_at: at(minuteAt),
      content,
    } as never);
  await forkSave('u1', 'user', 490, USER_PROMPTS[0]);
  await forkSave('a1', 'assistant', 491, assistantTurn(1));
  await forkSave(
    'u2',
    'user',
    510,
    'In this fork, try the narrower reading column.',
  );
  await forkSave('a2', 'assistant', 511, assistantTurn(3));

  // ── Reveal: short final answer under many deferred rich bubbles ───────────
  // The last assistant bubble renders Markdown eagerly and is short here, so
  // the viewport also shows deferred bubbles above it (code, table, mermaid,
  // image) that turn from plain text into rendered Markdown after the first
  // paint. Used to measure transcript movement after the reveal gate opens.
  const revealAt = (n: number) => at(600 + n);
  await db.insert(conversations).values({
    id: CHAT_EVAL.revealConversation,
    group_folder: project,
    title: 'Chat rendering evaluation (reveal)',
    preview: 'Rich deferred bubbles above a short final answer.',
    pinned: 0,
    created_at: revealAt(0),
    read_at: revealAt(80),
    last_user_at: revealAt(80),
    last_assistant_at: revealAt(80),
    ownerUserId: opts.adminId,
    lastTriggeredByUserId: opts.adminId,
    lastTriggerSource: 'user',
    lastTriggeredAt: revealAt(80),
  } as never);
  const MERMAID = [
    '```mermaid',
    'graph TD',
    '  A[Open chat] --> B{Cached?}',
    '  B -->|yes| C[Render]',
    '  B -->|no| D[Fetch]',
    '  D --> C',
    '```',
  ].join('\n');
  const IMAGE = (turn: number) =>
    `![Chat layout ${turn}](/artifacts/${project}/media/fixture-image.png)`;
  // The last turns are short so several deferred bubbles share the viewport.
  const richTurn = (turn: number) =>
    turn >= 16
      ? [
          `### Step ${turn}`,
          [IMAGE(turn), MERMAID, IMAGE(turn)][turn % 3],
        ].join('\n\n')
      : [
          `### Step ${turn}`,
          PROSE[turn % PROSE.length],
          turn % 3 === 0 ? WIDE_CODE : TABLE,
          turn % 4 === 0 ? MERMAID : IMAGE(turn),
        ].join('\n\n');
  for (let turn = 1; turn <= 20; turn++) {
    await saveChatMessage({
      id: `chat-eval-reveal-u${turn}`,
      group_folder: project,
      conversation_id: CHAT_EVAL.revealConversation,
      role: 'user',
      source: 'web',
      created_at: revealAt(turn * 2),
      content: USER_PROMPTS[turn % USER_PROMPTS.length],
    } as never);
    await saveChatMessage({
      id: `chat-eval-reveal-a${turn}`,
      group_folder: project,
      conversation_id: CHAT_EVAL.revealConversation,
      role: 'assistant',
      source: 'web',
      created_at: revealAt(turn * 2 + 1),
      content:
        turn === 20 ? 'Done. Details are in the steps above.' : richTurn(turn),
    } as never);
  }

  // ── Task run with stages (task details dialog) ───────────────────────────
  await db.insert(tasks).values({
    id: CHAT_EVAL.task,
    project_id: CHAT_EVAL.taskProject,
    title: 'Chat rendering evaluation task',
    description: 'Task run with coding, testing and review stages.',
    status: 'completed',
    priority: 0,
    created_at: FIRST,
    started_at: FIRST,
    completed_at: LAST,
    archived: 0,
  } as never);
  const stageRuns = [
    ['coding', 'codex', 'gpt-5.5'],
    ['testing', 'claude', 'claude-sonnet-4.6'],
    ['review', 'claude', 'claude-opus-4.8'],
  ] as const;
  for (const [i, [stage, agent, model]] of stageRuns.entries()) {
    const runId = `ui-run-chat-eval-${stage}`;
    const start = 600 + i * 30;
    await db.insert(activeRuns).values({
      id: runId,
      group_folder: CHAT_EVAL.taskProject,
      chat_jid: `task-${CHAT_EVAL.task}@kanban`,
      task_id: CHAT_EVAL.task,
      sandbox_stack: 'unavailable-in-ui-sandbox',
      sandbox_service: 'agent',
      started_at: at(start),
      timeout_at: at(start + 25),
      completed_at: at(start + 20),
      status: 'completed',
      stage,
      agent_name: agent,
      model_name: model,
      cost_usd: 0.21 + i * 0.07,
    } as never);
    appendRunStartMarker(CHAT_EVAL.taskProject, CHAT_EVAL.task, runId, {
      agent_name: agent,
      model_name: model,
      created_at: at(start),
    });
    if (i === 0) {
      appendTaskMessage(CHAT_EVAL.taskProject, {
        task_id: CHAT_EVAL.task,
        role: 'user',
        content:
          'Implement the chat rendering evaluation task and keep the existing behaviour.',
        created_at: at(start),
      });
    }
    appendTaskMessage(CHAT_EVAL.taskProject, {
      task_id: CHAT_EVAL.task,
      role: 'assistant',
      content: [
        `Starting the ${stage} stage.`,
        toolRound(`task${i}`, stage === 'testing'),
        PROSE[i % PROSE.length],
        i === 0 ? WIDE_CODE : TABLE,
      ].join('\n\n'),
      agent_name: agent,
      model_name: model,
      created_at: at(start + 15),
    });
  }

  // ── Objective event run (Runs tab) ───────────────────────────────────────
  const objectiveDir = getObjectiveDir(
    CHAT_EVAL.objectiveProject,
    CHAT_EVAL.objective,
  );
  fs.mkdirSync(objectiveDir, { recursive: true });
  fs.appendFileSync(
    path.join(objectiveDir, 'run-stats.jsonl'),
    JSON.stringify({
      runId: CHAT_EVAL.objectiveRun,
      timestamp: at(700),
      triggerType: 'event',
      durationMs: 84_000,
      costUsd: 0.1842,
      numTurns: 6,
      numSteps: 14,
      inputTokens: 18_400,
      outputTokens: 2_300,
      cacheReadTokens: 61_000,
      cacheCreationTokens: 4_200,
      model: 'claude-sonnet-4.6',
      exitCode: 0,
    }) + '\n',
  );
  const sessionDir = path.join(
    GROUPS_DIR,
    CHAT_EVAL.objectiveProject,
    'session-transcripts',
  );
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionEntries = (prompt: string, minuteAt: number) =>
    [
      {
        type: 'message',
        role: 'user',
        content: prompt,
        created_at: at(minuteAt),
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          'I checked the new events against the objective.',
          toolRound('session', true),
          PROSE[0],
          TABLE,
        ].join('\n\n'),
        created_at: at(minuteAt + 1),
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n';
  fs.writeFileSync(
    path.join(sessionDir, `${CHAT_EVAL.objectiveRun}.prompt.txt`),
    'Process the new events for this objective and report the next measurable step.',
  );
  fs.writeFileSync(
    path.join(sessionDir, `${CHAT_EVAL.objectiveRun}.jsonl`),
    sessionEntries(
      'Process the new events for this objective and report the next measurable step.',
      700,
    ),
  );

  // ── Scheduled task run ───────────────────────────────────────────────────
  await db.insert(activeRuns).values({
    id: CHAT_EVAL.scheduledRun,
    group_folder: project,
    chat_jid: 'ui-chat@ui-sandbox',
    isScheduledTask: 1,
    scheduled_task_id: CHAT_EVAL.scheduledTask,
    sandbox_stack: 'unavailable-in-ui-sandbox',
    sandbox_service: 'agent',
    started_at: at(800),
    timeout_at: at(830),
    completed_at: at(812),
    status: 'completed',
    agent_name: 'codex',
    model_name: 'fixture-model',
    tok_total: 5210,
    cost_usd: 0.11,
  } as never);
  await db.insert(taskRunLogs).values({
    task_id: CHAT_EVAL.scheduledTask,
    run_id: CHAT_EVAL.scheduledRun,
    run_at: at(812),
    duration_ms: 720_000,
    status: 'success',
    result: 'Scheduled evaluation run completed.',
    error: null,
  } as never);
  const scheduledDir = path.join(GROUPS_DIR, project, 'session-transcripts');
  fs.mkdirSync(scheduledDir, { recursive: true });
  fs.writeFileSync(
    path.join(scheduledDir, `${CHAT_EVAL.scheduledRun}.prompt.txt`),
    'Summarize new UI feedback.',
  );
  fs.writeFileSync(
    path.join(scheduledDir, `${CHAT_EVAL.scheduledRun}.jsonl`),
    sessionEntries('Summarize new UI feedback.', 800),
  );
}
