import fs from 'node:fs';
import path from 'node:path';

import { and, eq, inArray } from 'drizzle-orm';

import { initDatabase, registerDeviceKey } from '../../src/db.js';
import { drizzleDbRef } from '../../src/db/drizzle-client.js';
import {
  activeRuns,
  conversations,
  cronjobs,
  datasetTasks,
  memories,
  objectives,
  scheduledTasks,
  stageEntryEvents,
  tasks,
  taskBoardEvents,
  taskStageComments,
  taskRunLogs,
} from '../../src/db/schema.js';
import { createUser } from '../../src/modules/knowledge/db-kb.js';
import { upsertProjectMember } from '../../src/modules/knowledge/db-kb.js';
import { storePayload } from '../../src/modules/push/payload-store.js';
import { saveChatMessage } from '../../src/modules/chat/db-chats.js';
import {
  insertAiUserRow,
  inviteConversationAiUser,
} from '../../src/modules/ai-users/db-ai-users.js';
import {
  writeAiUserAvatar,
  writeAiUserPrompt,
} from '../../src/modules/ai-users/storage.js';
import {
  appendRunStartMarker,
  appendTaskMessage,
} from '../../src/modules/transcripts/transcript-store.js';
import { DATA_DIR, GROUPS_DIR } from '../../src/config.js';
import { chatTranscriptPath } from '../../src/group-dir.js';
import { effectiveProjectUploadDir } from '../../src/sandbox/effective-settings.js';
import { getGroupByFolder } from '../../src/state-manager.js';
import { createOrEnableConversationPublicShare } from '../../src/modules/chat/db-public-shares.js';
import {
  SECURITY_CONVERSATION_ID,
  SECURITY_DEVICE,
  SECURITY_FOLDER,
  SECURITY_MCP,
  SECURITY_MESSAGE_ID,
  SECURITY_SHARE_ATTACHMENTS,
  SECURITY_SHARE_TOKEN_FILE,
  writeSecurityFiles,
  writeSecuritySymlinkFiles,
} from './security-fixtures.js';
import { serializeAiUserPrompt } from '../../src/modules/ai-users/prompt.js';
import { loadState, registerGroup } from '../../src/state-manager.js';
import {
  MEMORY_REVIEW_TARGET_IDS,
  seedMemoryReviewFixtures,
} from './memory-review-fixture.js';
import { seedKnowledgeFixtures } from './knowledge-fixture.js';
import { seedProposalFixtures } from './proposal-fixture.js';
import { seedChatEvalFixtures } from './chat-eval-fixture.js';
import { seedNotificationsEvalFixtures } from './notifications-eval-fixture.js';
import { seedTaskDetailEvalFixtures } from './task-detail-eval-fixture.js';
import {
  AB_BRANCHES,
  MEDIA_FIXTURE_DIR,
  SANDBOX_FIXTURE_IMAGE,
  fixtureRemoteUrl,
  runFixtureGit,
  seedCleanAbRepository,
  seedGitRepository,
} from './git-fixture.js';
import {
  SANDBOX_ADMIN,
  SANDBOX_DIRECT_RUNTIME,
  SANDBOX_MEMBER,
  SANDBOX_PERSONA_PRESET_ID,
  writeSandboxDirectLlmConfig,
} from './shared.js';

const T = {
  old: '2026-07-20T09:00:00.000Z',
  created: '2026-07-25T09:00:00.000Z',
  started: '2026-07-26T10:00:00.000Z',
  completed: '2026-07-26T10:12:00.000Z',
  recent: '2026-07-28T07:30:00.000Z',
  future: '2026-08-01T09:00:00.000Z',
} as const;

const stages = [
  { id: 'backlog', title: 'Backlog', type: 'queue', color: '#8B8FA3' },
  { id: 'question', title: 'Question', type: 'queue', color: '#F59E0B' },
  { id: 'in_progress', title: 'In Progress', type: 'active', color: '#3B82F6' },
  { id: 'testing', title: 'Testing', type: 'testing', color: '#8B5CF6' },
  { id: 'review', title: 'Review', type: 'review', color: '#EC4899' },
  { id: 'completed', title: 'Completed', type: 'done', color: '#22C55E' },
  { id: 'failed', title: 'Failed', type: 'queue', color: '#EF4444' },
] as const;

// Worktree-mode project for the A/B experiment walk: `coding.b` and `review.x`
// are stage alternatives (run-config overrides, never board columns).
const AB_PROJECT_ID = 'ui-ab';
// Same experiment shape on the shared, intentionally dirty default checkout:
// picking a winner there fails, keeping the 409 error path walkable.
const AB_DIRTY_PROJECT_ID = 'ui-ab-dirty';
const abStages = [
  { id: 'backlog', title: 'Backlog', type: 'queue', color: '#8B8FA3' },
  { id: 'question', title: 'Question', type: 'queue', color: '#F59E0B' },
  { id: 'coding', title: 'Coding', type: 'active', color: '#3B82F6' },
  { id: 'testing', title: 'Testing', type: 'testing', color: '#8B5CF6' },
  { id: 'review', title: 'Review', type: 'review', color: '#EC4899' },
  { id: 'completed', title: 'Completed', type: 'done', color: '#22C55E' },
  { id: 'failed', title: 'Failed', type: 'queue', color: '#EF4444' },
  {
    id: 'coding.b',
    title: 'Coding B',
    type: 'active',
    color: '#3B82F6',
    runtimeSelection: SANDBOX_DIRECT_RUNTIME,
  },
  {
    id: 'review.x',
    title: 'Review X',
    type: 'review',
    color: '#EC4899',
    runtimeSelection: SANDBOX_DIRECT_RUNTIME,
  },
] as const;

const projects = [
  {
    id: 'ui-running',
    name: 'UI · Running Kanban',
    status: 'running',
    mode: 'kanban',
  },
  {
    id: 'ui-task-steering',
    name: 'UI · Task steering',
    status: 'running',
    mode: 'kanban',
  },
  {
    id: 'ui-paused',
    name: 'UI · Paused project with a deliberately long multi-mode activity name',
    status: 'paused',
    mode: 'kanban',
  },
  {
    id: 'ui-stopped',
    name: 'UI · Stopped Kanban',
    status: 'stopped',
    mode: 'kanban',
  },
  {
    id: 'ui-chat',
    name: 'UI · Chat and Artifacts',
    status: 'running',
    mode: 'chat',
  },
  {
    id: 'ui-objectives',
    name: 'UI · Objectives',
    status: 'running',
    mode: 'objectives',
  },
  {
    // Paused: the experiment parent sits in its fork stage and must not be
    // picked up by the (stubbed) executor.
    id: AB_PROJECT_ID,
    name: 'UI · A/B experiments',
    status: 'paused',
    mode: 'kanban',
  },
  {
    id: AB_DIRTY_PROJECT_ID,
    name: 'UI · A/B experiments (dirty checkout)',
    status: 'paused',
    mode: 'kanban',
  },
] as const;

function task(
  id: string,
  project_id: string,
  title: string,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    project_id,
    title,
    description: `Deterministic UI fixture for ${title}.`,
    status,
    priority: 0,
    created_at: T.created,
    archived: 0,
    ...overrides,
  };
}

async function closeDatabase(): Promise<void> {
  const handle = drizzleDbRef.current as unknown as {
    $client?: { close?: () => Promise<void> };
    _?: { client?: { close?: () => Promise<void> } };
    session?: { client?: { close?: () => Promise<void> } };
  };
  const client = handle.$client ?? handle._?.client ?? handle.session?.client;
  await client?.close?.();
}

function seedGroupMediaFixtures(groupFolders: string[]): void {
  for (const groupFolder of groupFolders) {
    const artifactDir = path.join(
      GROUPS_DIR,
      groupFolder,
      'artifacts',
      'media',
    );
    fs.mkdirSync(artifactDir, { recursive: true });
    for (const fileName of [
      'fixture-audio.WAV',
      'fixture-video.WEBM',
      'fixture-video.mp4',
    ]) {
      fs.copyFileSync(
        path.join(MEDIA_FIXTURE_DIR, fileName),
        path.join(artifactDir, fileName),
      );
    }
    fs.writeFileSync(
      path.join(artifactDir, 'fixture-image.png'),
      SANDBOX_FIXTURE_IMAGE,
    );
    fs.writeFileSync(
      path.join(artifactDir, 'fixture-corrupt.mp4'),
      'This is intentionally not a media file.',
    );
  }
}

/** Files, conversation and transcript for security-smoke.ts. */
async function seedSecurityScenario(adminId: string): Promise<void> {
  const group = getGroupByFolder(SECURITY_FOLDER);
  if (!group) throw new Error(`${SECURITY_FOLDER} is not registered`);
  writeSecurityFiles(
    effectiveProjectUploadDir(group, DATA_DIR),
    path.join(GROUPS_DIR, SECURITY_FOLDER),
    process.env.CARAPA_DATA_DIR ?? '',
  );
  writeSecuritySymlinkFiles(process.env.CARAPA_DATA_DIR ?? '', GROUPS_DIR);
  // Approved admin device whose key the smoke signs requests with.
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  await registerDeviceKey(
    SECURITY_DEVICE.id,
    adminId,
    Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString(
      'base64',
    ),
    'Security smoke',
    true,
  );
  fs.writeFileSync(
    path.join(process.env.CARAPA_DATA_DIR ?? '', SECURITY_DEVICE.keyFile),
    JSON.stringify(await crypto.subtle.exportKey('jwk', keys.privateKey)),
  );
  await drizzleDbRef.current.insert(conversations).values({
    id: SECURITY_CONVERSATION_ID,
    group_folder: SECURITY_FOLDER,
    title: 'Security smoke share',
    preview: 'Attachments for the public share containment checks.',
    pinned: 0,
    created_at: T.recent,
    read_at: T.recent,
    ownerUserId: adminId,
    lastTriggeredByUserId: adminId,
    lastTriggerSource: 'user',
    lastTriggeredAt: T.recent,
  } as any);
  const transcript = chatTranscriptPath(
    SECURITY_FOLDER,
    undefined,
    SECURITY_CONVERSATION_ID,
  );
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(
    transcript,
    JSON.stringify({
      type: 'message',
      id: SECURITY_MESSAGE_ID,
      role: 'assistant',
      content: 'Files attached.',
      timestamp: T.recent,
      created_at: T.recent,
      attachments: SECURITY_SHARE_ATTACHMENTS.map((url) => ({
        type: 'document',
        url,
      })),
    }) + '\n',
  );
  // Member of exactly one project for the MCP-reach checks (security-mcp.ts).
  // Created here, not over the API: user mutations need a device signature.
  const member = await createUser(
    SANDBOX_MEMBER.username,
    SANDBOX_MEMBER.password,
    'user',
  );
  await upsertProjectMember(member.id, SECURITY_MCP.memberProject, 'editor');
  await drizzleDbRef.current
    .insert(tasks)
    .values([
      task(
        SECURITY_MCP.memberTask.id,
        SECURITY_MCP.memberProject,
        SECURITY_MCP.memberTask.title,
        'backlog',
      ),
      task(
        SECURITY_MCP.privateTask.id,
        SECURITY_MCP.privateProject,
        SECURITY_MCP.privateTask.title,
        'backlog',
      ),
    ]);
  // The owner API for shares needs a fresh device signature, so the token is
  // created here and handed to the smoke through a file in the sandbox root.
  const share = await createOrEnableConversationPublicShare(
    SECURITY_CONVERSATION_ID,
    adminId,
  );
  fs.writeFileSync(
    path.join(process.env.CARAPA_DATA_DIR ?? '', SECURITY_SHARE_TOKEN_FILE),
    share.publicToken,
  );
}

async function main(): Promise<void> {
  const simulatorBaseUrl = process.env.UI_SANDBOX_LLM_BASE_URL;
  if (!simulatorBaseUrl) {
    throw new Error('UI_SANDBOX_LLM_BASE_URL is required for sandbox seeding');
  }
  writeSandboxDirectLlmConfig(
    process.env.CARAPA_DATA_DIR ?? '',
    simulatorBaseUrl,
    // The attachment-path checks need the model to read image attachments.
    { imageInput: process.env.UI_SANDBOX_SMOKE_SCENARIO === 'security' },
  );
  await initDatabase();
  await loadState();
  const gitRepo = process.env.UI_SANDBOX_GIT_REPO;
  if (!gitRepo) throw new Error('UI_SANDBOX_GIT_REPO is required');
  const dirtyForkCommit = seedGitRepository(gitRepo);
  const abRepo = process.env.UI_SANDBOX_AB_GIT_REPO;
  if (!abRepo) throw new Error('UI_SANDBOX_AB_GIT_REPO is required');
  const abForkCommit = seedCleanAbRepository(abRepo);
  // Bare remotes behind the saved `repositoryUrl` of the repositories that
  // show the Changes-tab default-branch sync row.
  for (const repo of [gitRepo, abRepo]) {
    runFixtureGit(repo, ['clone', '-q', '--bare', '.', fixtureRemoteUrl(repo)]);
  }
  // `ui-ab` owns a clean checkout, so picking a winner merges; `ui-ab-dirty`
  // shares the dirty default checkout, so picking a winner is rejected.
  const abExperiments = [
    {
      projectId: AB_PROJECT_ID,
      repo: abRepo,
      forkCommit: abForkCommit,
      parentId: 'ui-ab-parent',
      childPrefix: 'ui-ab-child',
      runPrefix: 'ui-ab-run',
    },
    {
      projectId: AB_DIRTY_PROJECT_ID,
      repo: gitRepo,
      forkCommit: dirtyForkCommit,
      parentId: 'ui-ab-dirty-parent',
      childPrefix: 'ui-ab-dirty-child',
      runPrefix: 'ui-ab-dirty-run',
    },
  ] as const;
  const admin = await createUser(
    SANDBOX_ADMIN.username,
    SANDBOX_ADMIN.password,
    'admin',
  );
  const twoUser = process.env.UI_SANDBOX_TWO_USER === 'true';
  const member = twoUser
    ? await createUser(SANDBOX_MEMBER.username, SANDBOX_MEMBER.password, 'user')
    : null;
  const personaId = 'ui-sandbox-persona';
  const personaPromptPath = await writeAiUserPrompt(
    personaId,
    serializeAiUserPrompt({
      identity: 'UI validation persona',
      turn: 'after',
      tools: [],
      body: 'Answer as Mara, a concise UI sandbox persona.',
    }),
  );
  const personaAvatarPath = await writeAiUserAvatar(
    personaId,
    '.png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  await insertAiUserRow({
    id: personaId,
    name: 'Mara',
    presetId: SANDBOX_PERSONA_PRESET_ID,
    promptPath: personaPromptPath,
    avatarPath: personaAvatarPath,
    identity: 'UI validation persona',
    turn: 'after',
    tools: [],
    enabled: 1,
    createdAt: T.created,
    updatedAt: T.recent,
  });

  for (const [index, project] of projects.entries()) {
    await registerGroup(
      `${project.id}@ui-sandbox`,
      {
        id: project.id,
        jid: `${project.id}@ui-sandbox`,
        folder: project.id,
        name: project.name,
        trigger: '!',
        added_at: T.old,
        order: index,
        user_id: admin.id,
        settings: {
          mode: project.mode,
          status: project.status,
          stages: (project.id === AB_PROJECT_ID ||
          project.id === AB_DIRTY_PROJECT_ID
            ? abStages
            : stages
          ).map((stage) => ({ ...stage })),
          enabledModes: ['kanban', 'chat', 'objectives'],
          autoStartStack: false,
          maxParallelWorktrees: 2,
          custom_values: [
            { key: 'customer', label: 'Customer', type: 'text' },
            { key: 'estimate', label: 'Estimate', type: 'number' },
          ],
          ...(project.id === 'ui-chat'
            ? {
                chatRuntimeSelection: SANDBOX_DIRECT_RUNTIME,
                // The Changes tab only exists for projects with a repository.
                repositoryLocation: gitRepo,
                defaultBranch: 'develop',
              }
            : {}),
          ...(project.id === AB_PROJECT_ID || project.id === AB_DIRTY_PROJECT_ID
            ? {
                repositoryLocation:
                  project.id === AB_PROJECT_ID ? abRepo : gitRepo,
                defaultBranch: 'develop',
                ...(project.id === AB_PROJECT_ID
                  ? { repositoryUrl: fixtureRemoteUrl(abRepo) }
                  : {}),
                taskCheckoutMode: 'worktree' as const,
              }
            : {}),
          ...(project.id === 'ui-running'
            ? {
                repositoryLocation: gitRepo,
                repositoryUrl: fixtureRemoteUrl(gitRepo),
                defaultBranch: 'develop',
                ...(process.env.UI_SANDBOX_SMOKE_SCENARIO === 'mobile-kanban'
                  ? {
                      status: 'paused' as const,
                      taskCheckoutMode: 'shared' as const,
                    }
                  : { taskCheckoutMode: 'worktree' as const }),
              }
            : {}),
        },
      } as any,
      { requirePersistence: true },
    );
  }

  if (member) {
    for (const project of projects) {
      await upsertProjectMember(member.id, project.id, 'editor');
    }
  }

  await drizzleDbRef.current.insert(tasks).values([
    task(
      'ui-task-steering',
      'ui-task-steering',
      'Running task steering lifecycle',
      'backlog',
      {
        skip_stages: JSON.stringify(['testing', 'review']),
      },
    ),
    task('ui-task-backlog', 'ui-running', 'Backlog task', 'backlog', {
      priority: -1,
      lastTriggerSource: 'system',
      lastTriggeredAt: T.started,
    }),
    task(
      'ui-task-question',
      'ui-running',
      'Task awaiting an answer',
      'question',
    ),
    task('ui-task-active', 'ui-running', 'Idle active task', 'in_progress', {
      custom_values: JSON.stringify({ customer: 'Regun', estimate: 5 }),
      author: 'user',
    }),
    task(
      'ui-task-auto-waiting',
      'ui-running',
      'Automatic task remains capped',
      'in_progress',
      { priority: 1 },
    ),
    task(
      'ui-task-symlink-changes',
      'ui-running',
      'Symlink changes acceptance',
      // Boot recovery clears the worktree pointer of non-active-stage tasks;
      // a review-stage task keeps it (same as the default-branch merge tasks).
      'review',
      {
        priority: 2,
        branch_name: 'ui-symlink-task',
        worktree_path: path.join(gitRepo, '.worktrees', 'ui-symlink-task'),
        sandbox_instance: 'ui-running',
      },
    ),
    task('ui-task-testing', 'ui-running', 'Task ready for testing', 'testing'),
    ...['clean', 'conflict'].map((outcome) =>
      task(
        `ui-task-merge-${outcome}`,
        'ui-running',
        `Default branch merge · ${outcome}`,
        // Recovery preserves owned worktrees awaiting review. Backlog worktree
        // pointers are swept at boot, before the browser opens the fixture.
        'review',
        {
          branch_name: `ui-merge-${outcome}`,
          worktree_path: path.join(
            gitRepo,
            '.worktrees',
            `ui-merge-${outcome}`,
          ),
          sandbox_instance: 'ui-running',
        },
      ),
    ),
    task('ui-task-review', 'ui-running', 'Task awaiting review', 'review', {
      description:
        'Implementation is ready.\n\n## Review notes\nCheck keyboard navigation and empty states.',
    }),
    task(
      'ui-task-review-archived',
      'ui-running',
      'Archived review task for stage migration',
      'review',
      {
        archived: 1,
        completed_at: T.completed,
      },
    ),
    task(
      'ui-task-failed',
      'ui-running',
      'Task with an execution error',
      'failed',
      {
        error: 'Fixture failure: external service unavailable',
        started_at: T.started,
        completed_at: T.completed,
      },
    ),
    task(
      'ui-task-completed',
      'ui-running',
      'Completed task with history',
      'completed',
      {
        started_at: T.started,
        completed_at: T.completed,
        output: 'Implemented and verified.',
        branch_name: 'task/ui-completed',
        ownerUserId: member?.id ?? admin.id,
        lastTriggeredByUserId: admin.id,
        lastTriggerSource: 'user',
        lastTriggeredAt: T.started,
      },
    ),
    task(
      'ui-task-scored-review',
      'ui-running',
      'Scored review navigation fixture',
      'completed',
      {
        description:
          'Implementation is ready.\n\n## Review notes\nPreserve this handoff text while navigating to the review transcript.',
        custom_values: JSON.stringify({ quality_score: 9 }),
        started_at: T.old,
        completed_at: T.future,
      },
    ),
    // The mobile Kanban smoke needs a Backlog list taller than a phone viewport
    // regardless of card height, so it can tell list scrolling from stage swipes.
    ...(process.env.UI_SANDBOX_SMOKE_SCENARIO === 'mobile-kanban'
      ? [1, 2, 3, 4, 5].map((index) =>
          task(
            `ui-task-backlog-filler-${index}`,
            'ui-running',
            `Backlog filler ${index}`,
            'backlog',
            { priority: 3 },
          ),
        )
      : []),
    // Review verdict fixtures: a rejected round sends the card back to rework
    // (score + rejection count on the card), an approved one completes it.
    task(
      'ui-task-review-rejected',
      'ui-running',
      'Review rejected: empty states and keyboard focus are missing',
      'in_progress',
      {
        description:
          'Implementation was reviewed and rejected twice; rework is pending.',
        custom_values: JSON.stringify({
          quality_score: 4,
          rejection_count: 2,
          review_history: JSON.stringify([
            {
              timestamp: T.started,
              commit: '1a2b3c4d5e6f',
              summary: 'Empty states and focus handling are missing.',
              issues: [
                {
                  id: 'empty-state',
                  text: 'No empty state for a project without tasks',
                },
                { id: 'focus-ring', text: 'Keyboard focus ring is clipped' },
              ],
            },
            {
              timestamp: T.completed,
              commit: '6f5e4d3c2b1a',
              summary: 'Empty state added; focus ring still clipped.',
              issues: [
                { id: 'focus-ring', text: 'Keyboard focus ring is clipped' },
              ],
              comparison: {
                decision: 'retry',
                progress: 'persistent_issue',
                reason: 'One of two issues is resolved.',
              },
            },
          ]),
        }),
        started_at: T.started,
        completed_at: T.completed,
      },
    ),
    task(
      'ui-task-review-approved',
      'ui-running',
      'Review approved after one rejection: bulk selection on touch',
      'completed',
      {
        description:
          'Implementation was rejected once, reworked and then approved.',
        custom_values: JSON.stringify({ quality_score: 8, rejection_count: 1 }),
        started_at: T.started,
        completed_at: T.completed,
      },
    ),
    task(
      'ui-task-blocked',
      'ui-running',
      'Blocked by completed dependency demo',
      'backlog',
      {
        depends_on_ids: JSON.stringify(['ui-task-active']),
        priority: 2,
      },
    ),
    task(
      'ui-task-archived',
      'ui-running',
      'Archived completed task',
      'completed',
      {
        archived: 1,
        completed_at: T.completed,
      },
    ),
    task(
      'ui-task-paused-manual',
      'ui-paused',
      'Manual trigger while paused',
      'in_progress',
    ),
    task(
      'ui-task-paused-review',
      'ui-paused',
      'Manual review while paused',
      'review',
    ),
    task(
      'ui-task-paused-completed',
      'ui-paused',
      'New Kanban result awaiting acknowledgement',
      'completed',
      {
        started_at: T.started,
        completed_at: T.recent,
      },
    ),
    task(
      'ui-task-stopped-manual',
      'ui-stopped',
      'Manual trigger while stopped',
      'testing',
    ),
    task(
      'ui-task-stopped-failed',
      'ui-stopped',
      'Stopped board failure',
      'failed',
      {
        error: 'Stopped by user',
        started_at: T.started,
        completed_at: T.completed,
      },
    ),

    task(
      'ui-task-objective',
      'ui-objectives',
      'Task linked to active objective',
      'in_progress',
      {
        objective_id: 'ui-objective-active',
      },
    ),

    // A/B experiment walks (projects `ui-ab` and `ui-ab-dirty`, worktree mode).
    task(
      'ui-ab-backlog',
      AB_PROJECT_ID,
      'Add rate limiting to the export API',
      'backlog',
    ),
    ...abExperiments.flatMap(
      ({ projectId, repo, forkCommit, parentId, childPrefix }) => [
        task(parentId, projectId, 'Speed up the export pipeline', 'coding', {
          started_at: T.started,
          abVariants: JSON.stringify(['a', 'b']),
          abForkStage: 'coding',
          abForkCommit: forkCommit,
        }),
        ...(
          [
            ['a', 8, 0, 0],
            ['b', 9, 0, 0],
          ] as const
        ).map(([variant, score, rejections, testingFailures]) =>
          task(
            `${childPrefix}-${variant}`,
            projectId,
            `Speed up the export pipeline [${variant.toUpperCase()}]`,
            'completed',
            {
              started_at: T.started,
              completed_at: T.completed,
              branch_name: AB_BRANCHES[variant],
              worktree_path: path.join(
                repo,
                '.worktrees',
                AB_BRANCHES[variant],
              ),
              stageVariant: variant,
              abParentTaskId: parentId,
              custom_values: JSON.stringify({
                quality_score: score,
                rejection_count: rejections,
                testing_failure_total: testingFailures,
              }),
            },
          ),
        ),
      ],
    ),
  ] as any);
  // Boot resumes queued work, and this sandbox has no worktree support, so a
  // seeded card in an executable stage would be started and fail. A failed
  // stage-entry receipt parks its own card (the board's "entry failed" hold)
  // until the card changes stage, which keeps the fixtures idle.
  const heldAt = new Date().toISOString();
  const idleCards = await drizzleDbRef.current
    .select({
      id: tasks.id,
      project_id: tasks.project_id,
      status: tasks.status,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.archived, 0),
        inArray(
          tasks.status,
          [...stages, ...abStages]
            .filter((stage) =>
              ['active', 'testing', 'review'].includes(stage.type),
            )
            .map((stage) => stage.id),
        ),
      ),
    );
  if (idleCards.length > 0) {
    await drizzleDbRef.current.insert(stageEntryEvents).values(
      idleCards.map((card) => ({
        id: `ui-hold-${card.id}`,
        project_id: card.project_id,
        task_id: card.id,
        stage_id: card.status,
        state: 'failed' as const,
        created_at: heldAt,
        completed_at: heldAt,
        error: 'UI sandbox fixture: kept idle at boot',
      })),
    );
  }
  await drizzleDbRef.current.insert(taskBoardEvents).values({
    project_id: 'ui-paused',
    task_id: 'ui-task-paused-completed',
    event_type: 'updated',
    occurred_at: T.recent,
    snapshot: task(
      'ui-task-paused-completed',
      'ui-paused',
      'New Kanban result awaiting acknowledgement',
      'completed',
      { started_at: T.started, completed_at: T.recent },
    ),
  });

  await drizzleDbRef.current.insert(activeRuns).values([
    ...abExperiments.flatMap(({ projectId, childPrefix, runPrefix }) =>
      (
        [
          ['a', 'codex', 'gpt-5.5', 0.31, 9 * 60_000],
          ['b', 'claude', 'claude-sonnet-4.6', 0.54, 14 * 60_000],
        ] as const
      ).flatMap(([variant, coder, coderModel, cost, durationMs]) =>
        (
          [
            ['coding', coder, coderModel, cost * 0.8, durationMs * 0.7, null],
            [
              'review',
              'claude',
              'claude-opus-4.8',
              cost * 0.2,
              durationMs * 0.3,
              variant === 'a' ? 8 : 9,
            ],
          ] as const
        ).map(([stage, agent, model, runCost, runMs, reviewScore], index) => {
          const startedAt = new Date(
            Date.parse(T.started) + index * 20 * 60_000,
          );
          return {
            id: `${runPrefix}-${variant}-${stage}`,
            group_folder: projectId,
            chat_jid: `task-${childPrefix}-${variant}@kanban`,
            task_id: `${childPrefix}-${variant}`,
            sandbox_stack: 'unavailable-in-ui-sandbox',
            sandbox_service: 'agent',
            started_at: startedAt.toISOString(),
            timeout_at: T.completed,
            completed_at: new Date(startedAt.getTime() + runMs).toISOString(),
            status: 'completed',
            stage,
            agent_name: agent,
            model_name: model,
            cost_usd: runCost,
            ...(reviewScore != null ? { reviewScore } : {}),
          };
        }),
      ),
    ),
    {
      id: 'ui-run-completed',
      group_folder: 'ui-running',
      chat_jid: 'task-ui-task-completed@kanban',
      task_id: 'ui-task-completed',
      sandbox_stack: 'unavailable-in-ui-sandbox',
      sandbox_service: 'agent',
      started_at: T.started,
      timeout_at: T.completed,
      completed_at: T.completed,
      status: 'completed',
      stage: 'in_progress',
      agent_name: 'codex',
      model_name: 'fixture-model',
      tok_total: 2450,
      tok_input: 1800,
      tok_output: 650,
      tool_usage_count: 4,
      cost_usd: 0.12,
      triggeredByUserId: admin.id,
      triggerSource: 'user',
    },
    {
      id: 'ui-run-error',
      group_folder: 'ui-running',
      chat_jid: 'task-ui-task-failed@kanban',
      task_id: 'ui-task-failed',
      sandbox_stack: 'unavailable-in-ui-sandbox',
      sandbox_service: 'agent',
      started_at: T.started,
      timeout_at: T.completed,
      completed_at: T.completed,
      status: 'error',
      stage: 'testing',
      agent_name: 'claude',
      model_name: 'fixture-model',
      tok_total: 900,
      tok_input: 700,
      tok_output: 200,
      tool_usage_count: 1,
      cost_usd: 0.04,
    },
    {
      id: 'ui-run-score-old',
      group_folder: 'ui-running',
      chat_jid: 'task-ui-task-scored-review@kanban',
      task_id: 'ui-task-scored-review',
      sandbox_stack: 'unavailable-in-ui-sandbox',
      sandbox_service: 'agent',
      started_at: '2026-07-29T09:00:00.000Z',
      timeout_at: '2026-07-29T09:12:00.000Z',
      completed_at: '2026-07-29T09:12:00.000Z',
      status: 'completed',
      stage: 'review',
      agent_name: 'codex',
      model_name: 'fixture-model',
      reviewScore: 6,
    },
    {
      id: 'ui-run-score-latest',
      group_folder: 'ui-running',
      chat_jid: 'task-ui-task-scored-review@kanban',
      task_id: 'ui-task-scored-review',
      sandbox_stack: 'unavailable-in-ui-sandbox',
      sandbox_service: 'agent',
      started_at: '2026-07-30T09:00:00.000Z',
      timeout_at: '2026-07-30T09:15:00.000Z',
      completed_at: '2026-07-30T09:15:00.000Z',
      status: 'completed',
      stage: 'review',
      agent_name: 'codex',
      model_name: 'fixture-model',
      reviewScore: 9,
    },
    {
      id: 'ui-run-implementation-newer',
      group_folder: 'ui-running',
      chat_jid: 'task-ui-task-scored-review@kanban',
      task_id: 'ui-task-scored-review',
      sandbox_stack: 'unavailable-in-ui-sandbox',
      sandbox_service: 'agent',
      started_at: '2026-07-31T09:00:00.000Z',
      timeout_at: '2026-07-31T09:20:00.000Z',
      completed_at: '2026-07-31T09:20:00.000Z',
      status: 'completed',
      stage: 'in_progress',
      agent_name: 'codex',
      model_name: 'fixture-model',
    },
    ...(
      [
        ['rejected', 'ui-task-review-rejected', 1, 5, 'review'],
        ['rejected', 'ui-task-review-rejected', 2, 4, 'review'],
        ['approved', 'ui-task-review-approved', 1, 5, 'review'],
        ['approved', 'ui-task-review-approved', 2, 8, 'review'],
      ] as const
    ).flatMap(([verdict, taskId, round, reviewScore, stage]) => {
      const startedAt = new Date(Date.parse(T.started) + round * 30 * 60_000);
      const run = (
        id: string,
        runStage: string,
        offsetMin: number,
        extra: Record<string, unknown> = {},
      ) => ({
        id,
        group_folder: 'ui-running',
        chat_jid: `task-${taskId}@kanban`,
        task_id: taskId,
        sandbox_stack: 'unavailable-in-ui-sandbox',
        sandbox_service: 'agent',
        started_at: new Date(
          startedAt.getTime() + offsetMin * 60_000,
        ).toISOString(),
        timeout_at: T.completed,
        completed_at: new Date(
          startedAt.getTime() + (offsetMin + 8) * 60_000,
        ).toISOString(),
        status: 'completed',
        stage: runStage,
        agent_name: 'codex',
        model_name: 'fixture-model',
        ...extra,
      });
      return [
        run(`ui-run-${verdict}-${round}-coding`, 'in_progress', 0, {
          cost_usd: 0.08,
        }),
        run(`ui-run-${verdict}-${round}-${stage}`, stage, 10, {
          reviewScore,
          cost_usd: 0.03,
        }),
      ];
    }),
  ] as any);

  if (member) {
    await storePayload({
      user_id: admin.id,
      kind: 'json_form',
      summary: 'Review the completed fixture',
      content: JSON.stringify({
        type: 'object',
        title: 'Completed task review',
        properties: {
          verdict: {
            type: 'string',
            title: 'Verdict',
            enum: ['approved', 'needs changes'],
          },
        },
        required: ['verdict'],
      }),
      respond_to: { kind: 'task', id: 'ui-task-completed' },
      source_tool_use_id: 'ui-sandbox-two-user-form',
    });
    await storePayload({
      user_id: admin.id,
      kind: 'text',
      summary: 'Open the attributed task',
      content: 'Open the exact task owned by the other project member.',
      action_url: '/board/ui-running?taskId=ui-task-completed',
      source_tool_use_id: 'ui-sandbox-task-deep-link',
    });
    await storePayload({
      user_id: member.id,
      kind: 'text',
      summary: 'Open the attributed conversation',
      content: 'Open the exact conversation triggered by the administrator.',
      action_url: '/chat/ui-chat?conversationId=ui-conversation-pinned',
      source_tool_use_id: 'ui-sandbox-conversation-deep-link',
    });
  }

  // Keep the ordinary one-user sandbox useful for notification UI flows too.
  // These are disposable fixtures persisted through the same production
  // payload store used by agent-created notifications.
  await storePayload({
    user_id: admin.id,
    kind: 'text',
    summary: 'UI sandbox notification',
    content: 'A deterministic notification for mounted overlay verification.',
    action_url: '/chat/ui-chat',
    source_tool_use_id: 'ui-sandbox-notification-overlay-text',
  });
  await storePayload({
    user_id: admin.id,
    kind: 'json_form',
    summary: 'UI sandbox notification form',
    content: JSON.stringify({
      type: 'object',
      title: 'Mounted notification form',
      properties: {
        response: { type: 'string', title: 'Response' },
      },
      required: ['response'],
    }),
    source_tool_use_id: 'ui-sandbox-notification-overlay-form',
  });
  await storePayload({
    user_id: admin.id,
    kind: 'text',
    summary: 'Project A completed conversation',
    content: 'Open the completed conversation in the chat project.',
    action_url: '/chat/ui-chat?conversationId=ui-conversation-pinned',
    source_tool_use_id: 'ui-sandbox-cross-project-completion-a',
  });
  await storePayload({
    user_id: admin.id,
    kind: 'text',
    summary: 'Project B completed conversation',
    content: 'Open the completed conversation in the paused project.',
    action_url: '/chat/ui-paused?conversationId=ui-conversation-cross-project',
    source_tool_use_id: 'ui-sandbox-cross-project-completion-b',
  });

  await drizzleDbRef.current.insert(taskStageComments).values({
    task_id: 'ui-task-completed',
    stage_id: 'review',
    content: 'Confirm the final implementation matches the accepted scope.',
    updated_at: T.recent,
    run_id: 'ui-run-completed',
  });

  await drizzleDbRef.current.insert(cronjobs).values([
    {
      id: 'ui-cron-active',
      project_id: 'ui-running',
      title: 'Daily UI fixture',
      description: 'A deterministic active cronjob.',
      cron_expression: '0 9 * * *',
      queue_mode: 'if_empty',
      status: 'active',
      archived: 0,
      next_run: T.future,
      created_at: T.created,
    },
    {
      id: 'ui-cron-paused',
      project_id: 'ui-running',
      title: 'Paused weekly fixture',
      description: 'A deterministic paused cronjob.',
      cron_expression: '0 10 * * 1',
      queue_mode: 'always',
      status: 'paused',
      archived: 0,
      created_at: T.created,
    },
  ]);

  await drizzleDbRef.current.insert(datasetTasks).values({
    id: 'ui-dataset',
    project_id: 'ui-running',
    title: 'Customer dataset fixture',
    description: 'Prepare a summary for {{customer}}.',
    dataset: JSON.stringify([{ customer: 'Alpha' }, { customer: 'Beta' }]),
    total_rows: 2,
    completed_rows: 1,
    current_row_index: 1,
    spawned_row_index: 0,
    status: 'paused',
    archived: 0,
    created_at: T.created,
  });

  await drizzleDbRef.current.insert(scheduledTasks).values([
    {
      id: 'ui-scheduled-chat',
      group_folder: 'ui-chat',
      chat_jid: 'ui-chat@ui-sandbox',
      prompt: 'Summarize new UI feedback.',
      schedule_type: 'cron',
      schedule_value: '0 8 * * *',
      next_run: T.future,
      status: 'paused',
      context_mode: 'group',
      created_at: T.created,
    },
    {
      id: 'ui-scheduled-empty',
      group_folder: 'ui-chat',
      chat_jid: 'ui-chat@ui-sandbox',
      prompt: 'Scheduled task with no runs.',
      schedule_type: 'interval',
      schedule_value: '3600000',
      next_run: T.future,
      status: 'paused',
      context_mode: 'isolated',
      created_at: T.created,
    },
    {
      id: 'ui-scheduled-completed-once',
      group_folder: 'ui-chat',
      chat_jid: 'ui-chat@ui-sandbox',
      prompt: 'Completed one-off scheduled task.',
      schedule_type: 'once',
      schedule_value: T.created,
      next_run: null,
      last_run: T.created,
      status: 'completed',
      context_mode: 'isolated',
      created_at: T.created,
    },
    {
      id: 'ui-scheduled-running-state',
      group_folder: 'ui-chat',
      chat_jid: 'ui-chat@ui-sandbox',
      prompt: 'Scheduled task running state.',
      schedule_type: 'interval',
      schedule_value: '3600000',
      next_run: T.future,
      status: 'active',
      context_mode: 'isolated',
      created_at: T.created,
    },
    {
      id: 'ui-scheduled-error-state',
      group_folder: 'ui-chat',
      chat_jid: 'ui-chat@ui-sandbox',
      prompt: 'Scheduled task error state.',
      schedule_type: 'interval',
      schedule_value: '3600000',
      next_run: T.future,
      status: 'paused',
      context_mode: 'isolated',
      created_at: T.created,
    },
  ]);
  await drizzleDbRef.current.insert(activeRuns).values({
    id: 'ui-scheduled-run-completed',
    group_folder: 'ui-chat',
    chat_jid: 'ui-chat@ui-sandbox',
    isScheduledTask: 1,
    scheduled_task_id: 'ui-scheduled-chat',
    sandbox_stack: 'unavailable-in-ui-sandbox',
    sandbox_service: 'agent',
    started_at: T.started,
    timeout_at: T.completed,
    completed_at: T.completed,
    status: 'completed',
    agent_name: 'codex',
    model_name: 'fixture-model',
    tok_total: 3210,
    cost_usd: 0.08,
  } as any);
  await drizzleDbRef.current.insert(taskRunLogs).values({
    task_id: 'ui-scheduled-chat',
    run_id: 'ui-scheduled-run-completed',
    run_at: T.completed,
    duration_ms: 720000,
    status: 'success',
    result: 'Scheduled fixture completed.',
    error: null,
  });
  await drizzleDbRef.current.insert(taskRunLogs).values({
    task_id: 'ui-scheduled-chat',
    run_id: null,
    run_at: T.started,
    duration_ms: 1000,
    status: 'error',
    result: null,
    error: 'Legacy summary only.',
  });
  const scheduledTranscriptDir = path.join(
    GROUPS_DIR,
    'ui-chat',
    'session-transcripts',
  );
  fs.mkdirSync(scheduledTranscriptDir, { recursive: true });
  fs.writeFileSync(
    path.join(scheduledTranscriptDir, 'ui-scheduled-run-completed.prompt.txt'),
    'Summarize new UI feedback.',
  );
  fs.writeFileSync(
    path.join(scheduledTranscriptDir, 'ui-scheduled-run-completed.jsonl'),
    [
      JSON.stringify({
        type: 'message',
        role: 'user',
        content: 'Summarize new UI feedback.',
      }),
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: 'No blocking feedback was found.',
      }),
    ].join('\n') + '\n',
  );

  await drizzleDbRef.current.insert(objectives).values([
    {
      id: 'ui-objective-draft',
      project_id: 'ui-objectives',
      title: 'Draft objective',
      description: 'Not started.',
      status: 'draft',
      priority: 0,
      progress: 0,
      created_at: T.created,
      updated_at: T.recent,
    },
    {
      id: 'ui-objective-active',
      project_id: 'ui-objectives',
      title: 'Improve onboarding',
      description: 'Make first-run setup measurable and clear.',
      status: 'active',
      priority: 1,
      progress: 45,
      deadline: T.future,
      created_at: T.created,
      updated_at: T.recent,
      metadata: JSON.stringify({ metric: 'activation rate' }),
    },
    {
      id: 'ui-objective-paused',
      project_id: 'ui-objectives',
      title: 'Paused objective',
      description: 'Waiting for input.',
      status: 'paused',
      priority: 2,
      progress: 30,
      created_at: T.created,
      updated_at: T.recent,
    },
    {
      id: 'ui-objective-achieved',
      project_id: 'ui-objectives',
      title: 'Achieved objective',
      description: 'Completed outcome.',
      status: 'achieved',
      priority: 3,
      progress: 100,
      created_at: T.old,
      updated_at: T.recent,
    },
    {
      id: 'ui-objective-failed',
      project_id: 'ui-objectives',
      title: 'Failed objective',
      description: 'Outcome was not reached.',
      status: 'failed',
      priority: 4,
      progress: 60,
      created_at: T.old,
      updated_at: T.recent,
    },
  ] as any);

  await drizzleDbRef.current.insert(conversations).values([
    {
      id: 'ui-conversation-pinned',
      group_folder: 'ui-chat',
      title: 'Pinned Markdown conversation',
      preview: 'A seeded conversation with rich content.',
      pinned: 1,
      created_at: T.created,
      read_at: T.recent,
      last_user_at: T.started,
      last_assistant_at: T.completed,
      ownerUserId: member?.id ?? admin.id,
      lastTriggeredByUserId: admin.id,
      lastTriggerSource: 'user',
      lastTriggeredAt: T.started,
      // Gives the production route-boundary smoke test a real conversation
      // Changes scope to distinguish from Kanban's main-tree request.
      use_worktree: 1,
    },
    {
      id: 'ui-conversation-repo-media',
      group_folder: 'ui-running',
      title: 'Media repository conversation',
      preview: 'A seeded conversation with a media worktree checkout.',
      pinned: 0,
      created_at: T.recent,
      read_at: T.recent,
      last_user_at: T.recent,
      last_assistant_at: T.recent,
      ownerUserId: admin.id,
      lastTriggeredByUserId: admin.id,
      lastTriggerSource: 'user',
      lastTriggeredAt: T.recent,
      use_worktree: 1,
      branch_name: 'ui-media-conversation',
      worktree_path: path.join(gitRepo, '.worktrees', 'ui-media-conversation'),
    },
    {
      id: 'ui-conversation-cross-project',
      group_folder: 'ui-paused',
      title: 'Cross-project completion stream',
      preview: 'Completed stream fixture for project ownership checks.',
      pinned: 0,
      created_at: T.recent,
      read_at: null,
      last_user_at: T.started,
      last_assistant_at: T.completed,
      ownerUserId: admin.id,
      lastTriggeredByUserId: admin.id,
      lastTriggerSource: 'user',
      lastTriggeredAt: T.completed,
    },
    ...(
      [
        ['ui-conversation-direct', 'Direct LLM steering lifecycle'],
        ['ui-conversation-direct-queue', 'Direct LLM queued follow-up'],
        ['ui-conversation-direct-failure', 'Direct LLM provider failure'],
        ['ui-conversation-direct-stop', 'Direct LLM stopped run'],
        ['ui-conversation-direct-reconnect', 'Direct LLM reconnect recovery'],
      ] as const
    ).map(([id, title]) => ({
      id,
      group_folder: 'ui-chat',
      title,
      preview: 'Disposable conversation for real streaming lifecycle tests.',
      pinned: 0,
      created_at: T.recent,
      read_at: T.recent,
      ownerUserId: admin.id,
      lastTriggeredByUserId: admin.id,
      lastTriggerSource: 'user',
      lastTriggeredAt: T.recent,
    })),
    {
      id: 'ui-conversation-unread',
      group_folder: 'ui-chat',
      title: 'Unread fixture conversation',
      preview: 'Unread assistant reply.',
      pinned: 0,
      created_at: T.recent,
      read_at: null,
      last_user_at: T.started,
      last_assistant_at: T.recent,
    },
    {
      id: 'ui-conversation-pending',
      group_folder: 'ui-chat',
      title: 'Pending implementation plan',
      preview: 'Plan ready for approval.',
      pinned: 0,
      created_at: T.recent,
      read_at: T.recent,
      last_user_at: T.started,
      last_assistant_at: T.completed,
    },
    {
      id: 'ui-objective-conversation',
      group_folder: 'ui-objectives',
      title: 'Objective planning conversation',
      preview: 'Progress and next actions.',
      pinned: 0,
      objective_id: 'ui-objective-active',
      created_at: T.created,
      read_at: null,
      last_user_at: T.started,
      last_assistant_at: T.completed,
    },
    {
      id: 'ui-objective-pending-conversation',
      group_folder: 'ui-objectives',
      title: 'Pending objective plan',
      preview: 'Plan ready for implementation.',
      pinned: 0,
      objective_id: 'ui-objective-active',
      created_at: T.recent,
      read_at: T.recent,
      last_user_at: T.started,
      last_assistant_at: T.completed,
    },
    {
      id: 'ui-paused-chat-unread',
      group_folder: 'ui-paused',
      title: 'Multi-mode ordinary chat result',
      preview: 'Unread ordinary chat result for status indicators.',
      created_at: T.recent,
      read_at: null,
      last_user_at: T.started,
      last_assistant_at: T.recent,
    },
    {
      id: 'ui-paused-objective-unread',
      group_folder: 'ui-paused',
      objective_id: 'ui-paused-status-objective',
      title: 'Multi-mode objective result',
      preview: 'Unread objective result for status indicators.',
      created_at: T.recent,
      read_at: null,
      last_user_at: T.started,
      last_assistant_at: T.recent,
    },
  ] as any);
  await inviteConversationAiUser('ui-conversation-pinned', personaId, admin.id);

  await saveChatMessage({
    id: 'ui-chat-user-1',
    group_folder: 'ui-chat',
    conversation_id: 'ui-conversation-pinned',
    role: 'user',
    source: 'web',
    created_at: T.started,
    content: 'Show a rich Markdown response with code and a checklist.',
  });
  await saveChatMessage({
    id: 'ui-cross-project-user',
    group_folder: 'ui-paused',
    conversation_id: 'ui-conversation-cross-project',
    role: 'user',
    source: 'web',
    created_at: T.started,
    content: 'Show the completed cross-project response.',
  });
  await saveChatMessage({
    id: 'ui-cross-project-assistant',
    group_folder: 'ui-paused',
    conversation_id: 'ui-conversation-cross-project',
    role: 'assistant',
    source: 'web',
    created_at: T.completed,
    content: 'Completed response owned by the paused project.',
    telemetry: {
      model_name: 'fixture-model',
      total_tokens: 128,
      duration_ms: 900,
    },
  });
  await saveChatMessage({
    id: 'ui-chat-assistant-1',
    group_folder: 'ui-chat',
    conversation_id: 'ui-conversation-pinned',
    role: 'assistant',
    source: 'web',
    created_at: T.completed,
    content:
      '## Fixture response\n\n- [x] Markdown\n- [x] Lists\n- [ ] Live execution\n\n```ts\nconst sandbox = "isolated";\n```',
    telemetry: {
      model_name: 'fixture-model',
      total_tokens: 320,
      duration_ms: 1400,
    },
  });
  await saveChatMessage({
    id: 'ui-chat-other-user',
    group_folder: 'ui-chat',
    conversation_id: 'ui-conversation-pinned',
    role: 'user',
    sender_name: 'Taylor',
    senderUserId: 'user-ui-sandbox-other',
    source: 'web',
    created_at: '2026-07-26T10:13:00.000Z',
    content: 'A compact message from another participant.',
  });
  // Agent-authored messages: no senderUserId, sender_name may equal the admin's
  // own display name (the username in the sandbox) and must still render as
  // another participant with the Agent badge.
  await saveChatMessage({
    id: 'ui-chat-agent-same-name',
    group_folder: 'ui-chat',
    conversation_id: 'ui-conversation-pinned',
    role: 'user',
    sender_name: SANDBOX_ADMIN.username,
    source: 'agent',
    created_at: '2026-07-26T10:13:20.000Z',
    content: 'Agent-authored message that carries the admin name.',
  });
  await saveChatMessage({
    id: 'ui-chat-agent-ask',
    group_folder: 'ui-chat',
    conversation_id: 'ui-conversation-pinned',
    role: 'user',
    sender_name: `Angy (main) for ${SANDBOX_ADMIN.username}`,
    source: 'agent',
    created_at: '2026-07-26T10:13:40.000Z',
    content: 'Agent-authored question posted by another project agent.',
  });
  await saveChatMessage({
    id: 'ui-chat-persona-long',
    group_folder: 'ui-chat',
    conversation_id: 'ui-conversation-pinned',
    role: 'assistant',
    sender_name: 'Mara',
    senderUserId: 'ai:ui-sandbox-persona',
    source: 'web',
    created_at: '2026-07-26T10:14:00.000Z',
    content: [
      '## Long persona response',
      '',
      'This fixture exercises readable prose while rich output keeps the full response width.',
      '',
      ...Array.from(
        { length: 18 },
        (_, index) =>
          `Section ${index + 1} keeps enough prose in this individual response to exercise its viewport-capped inner scrollbar.`,
      ).flatMap((paragraph) => [paragraph, '']),
      '| Status | Detail |',
      '| --- | --- |',
      '| Ready | Table content remains horizontally accessible |',
      '',
      '```ts',
      'const responseSurface = { scroll: "inner", transcript: "outer" };',
      '```',
      '',
      '<!-- carapa-tool:request -->',
      '> **Read** `ui/src/components/chat/chat-message-bubble.tsx` and preserve the mounted scroll owner while rendering a deliberately detailed tool call that crosses the existing collapse threshold.',
      '',
      '<!-- carapa-tool:result -->',
      '> Command output remains available across the full response width without becoming a nested card.',
      '',
      '> *Thinking stays visually secondary and can still be expanded when its content exceeds the collapsed height. This sentence is intentionally long enough to exercise that control.*',
      '',
      '> **Error** A quiet destructive treatment keeps this tool error distinct without overpowering the response.',
    ].join('\n'),
    telemetry: {
      model_name: 'persona-fixture-model',
      total_tokens: 2400,
      duration_ms: 3200,
    },
  });
  await saveChatMessage({
    id: 'ui-chat-user-2',
    group_folder: 'ui-chat',
    conversation_id: 'ui-conversation-unread',
    role: 'user',
    source: 'web',
    created_at: T.started,
    content: 'Is this conversation unread?',
  });
  await saveChatMessage({
    id: 'ui-chat-assistant-2',
    group_folder: 'ui-chat',
    conversation_id: 'ui-conversation-unread',
    role: 'assistant',
    source: 'web',
    created_at: T.recent,
    content: 'Selected model is at capacity. Please try a different model.',
    failed: true,
  });
  await saveChatMessage({
    id: 'ui-chat-plan',
    group_folder: 'ui-chat',
    conversation_id: 'ui-conversation-pending',
    role: 'assistant',
    source: 'web',
    created_at: T.completed,
    content:
      'Implementation plan ready. Select Start implementing when approved.',
    pending: true,
  });
  await saveChatMessage({
    id: 'ui-objective-chat-user',
    group_folder: 'ui-objectives',
    conversation_id: 'ui-objective-conversation',
    objective_id: 'ui-objective-active',
    role: 'user',
    source: 'web',
    created_at: T.started,
    content: 'What is the next measurable step?',
  });
  await saveChatMessage({
    id: 'ui-objective-chat-assistant',
    group_folder: 'ui-objectives',
    conversation_id: 'ui-objective-conversation',
    objective_id: 'ui-objective-active',
    role: 'assistant',
    source: 'web',
    created_at: T.completed,
    content: 'Selected model is at capacity. Please try a different model.',
    failed: true,
  });
  await saveChatMessage({
    id: 'ui-objective-plan',
    group_folder: 'ui-objectives',
    conversation_id: 'ui-objective-pending-conversation',
    objective_id: 'ui-objective-active',
    role: 'assistant',
    source: 'web',
    created_at: T.completed,
    content: 'Objective implementation plan ready.',
    pending: true,
  });

  appendRunStartMarker('ui-running', 'ui-task-completed', 'ui-run-completed', {
    agent_name: 'codex',
    model_name: 'fixture-model',
    created_at: T.started,
  });
  appendTaskMessage('ui-running', {
    task_id: 'ui-task-completed',
    role: 'user',
    content: 'Implement the completed fixture.',
    created_at: T.started,
  });
  appendTaskMessage('ui-running', {
    task_id: 'ui-task-completed',
    role: 'assistant',
    content: 'Implemented the fixture and verified the expected UI state.',
    agent_name: 'codex',
    model_name: 'fixture-model',
    created_at: T.completed,
  });
  for (const [runId, createdAt, content] of [
    ['ui-run-score-old', '2026-07-29T09:12:00.000Z', 'Older review score: 6.'],
    [
      'ui-run-score-latest',
      '2026-07-30T09:15:00.000Z',
      'Latest review score: 9.',
    ],
    [
      'ui-run-implementation-newer',
      '2026-07-31T09:20:00.000Z',
      'Implementation follow-up completed.',
    ],
  ] as const) {
    appendRunStartMarker('ui-running', 'ui-task-scored-review', runId, {
      agent_name: 'codex',
      model_name: 'fixture-model',
      created_at: createdAt,
    });
    appendTaskMessage('ui-running', {
      task_id: 'ui-task-scored-review',
      role: 'assistant',
      content,
      agent_name: 'codex',
      model_name: 'fixture-model',
      created_at: createdAt,
    });
  }
  for (const [taskId, runId, createdAt, content] of [
    [
      'ui-task-review-rejected',
      'ui-run-rejected-1-review',
      '2026-07-26T10:40:00.000Z',
      '**Review rejected** (score: 5/10, rejection 1)\n\n- No empty state for a project without tasks\n- Keyboard focus ring is clipped',
    ],
    [
      'ui-task-review-rejected',
      'ui-run-rejected-2-review',
      '2026-07-26T11:10:00.000Z',
      '**Review rejected** (score: 4/10, rejection 2)\n\n- Keyboard focus ring is clipped',
    ],
    [
      'ui-task-review-approved',
      'ui-run-approved-1-review',
      '2026-07-26T10:40:00.000Z',
      '**Review rejected** (score: 5/10, rejection 1)\n\n- Selection checkbox is too small on touch',
    ],
    [
      'ui-task-review-approved',
      'ui-run-approved-2-review',
      '2026-07-26T11:10:00.000Z',
      '**Review approved** (score: 8/10)\n\nThe selection checkbox is now a comfortable touch target.',
    ],
  ] as const) {
    appendRunStartMarker('ui-running', taskId, runId, {
      agent_name: 'codex',
      model_name: 'fixture-model',
      created_at: createdAt,
    });
    appendTaskMessage('ui-running', {
      task_id: taskId,
      role: 'assistant',
      content,
      agent_name: 'codex',
      model_name: 'fixture-model',
      created_at: createdAt,
    });
  }
  appendRunStartMarker('ui-running', 'ui-task-failed', 'ui-run-error', {
    agent_name: 'claude',
    model_name: 'fixture-model',
    created_at: T.started,
  });
  appendTaskMessage('ui-running', {
    task_id: 'ui-task-failed',
    role: 'assistant',
    content: 'The external service is unavailable in this UI sandbox.',
    agent_name: 'claude',
    model_name: 'fixture-model',
    created_at: T.completed,
  });

  const artifactDir = path.join(GROUPS_DIR, 'ui-chat', 'artifacts', 'reports');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, 'fixture-report.md'),
    '# Fixture report\n\nThis browser-loadable artifact belongs to the disposable UI sandbox.\n',
  );
  fs.writeFileSync(
    path.join(artifactDir, 'fixture-data.json'),
    JSON.stringify({ fixture: true, rows: 2 }, null, 2),
  );
  fs.writeFileSync(
    path.join(artifactDir, 'fixture-report.md.meta.json'),
    JSON.stringify(
      { caption: 'Seeded Markdown report', source: 'ui-sandbox' },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(artifactDir, 'fixture-report.md.meta.json'),
    JSON.stringify(
      { caption: 'Seeded Markdown report', source: 'ui-sandbox' },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(artifactDir, 'fixture-image.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  fs.writeFileSync(
    path.join(artifactDir, 'fixture-image.png.meta.json'),
    JSON.stringify(
      {
        caption: 'Seeded image artifact',
        source: 'web',
        source_url: 'https://example.test/fixture-image',
      },
      null,
      2,
    ),
  );
  const nestedArtifactDir = path.join(artifactDir, 'nested');
  fs.mkdirSync(nestedArtifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(nestedArtifactDir, 'fixture-nested-match.txt'),
    'Nested artifact search fixture.\n',
  );
  for (let index = 1; index <= 51; index += 1) {
    fs.writeFileSync(
      path.join(
        artifactDir,
        `fixture-page-${String(index).padStart(2, '0')}.txt`,
      ),
      `Paginated artifact fixture ${index}.\n`,
    );
  }
  seedGroupMediaFixtures(['ui-chat', 'ui-objectives']);

  const memoryRow = (
    id: string,
    memory_type: string,
    importance: number,
    tags: string[],
    content: string,
  ) => ({
    id,
    group_folder: 'ui-running',
    content,
    memory_type,
    importance,
    source: 'agent',
    tags: JSON.stringify(tags),
    created_at: T.created,
    updated_at: T.recent,
    last_accessed_at: T.recent,
    valid_from: T.created,
    valid_to: null,
  });
  await drizzleDbRef.current
    .insert(memories)
    .values([
      memoryRow(
        MEMORY_REVIEW_TARGET_IDS.supersede,
        'decision',
        0.8,
        ['deploy'],
        'Deployments happen on Friday afternoons.',
      ),
      memoryRow(
        MEMORY_REVIEW_TARGET_IDS.forget,
        'contact',
        0.5,
        ['privacy'],
        'Private phone number of the on-call contact: +49 000 0000000.',
      ),
      memoryRow(
        'ui-memory-review-style',
        'preference',
        0.6,
        ['review', 'style'],
        'Prefers small, focused pull requests with a short summary.',
      ),
      memoryRow(
        'ui-memory-stack',
        'project',
        0.9,
        ['stack'],
        'The board runs on Bun with a Vite and React frontend.',
      ),
      memoryRow(
        'ui-memory-test-policy',
        'decision',
        0.7,
        ['testing'],
        'Default to no new permanent tests unless a core workflow is unprotected.',
      ),
      memoryRow(
        'ui-memory-standup',
        'event',
        0.3,
        ['meeting'],
        'Weekly planning sync happens on Monday at 09:30.',
      ),
    ]);
  await seedMemoryReviewFixtures('ui-running');
  await seedProposalFixtures('ui-chat');
  await seedKnowledgeFixtures(admin.id, ['ui-chat', 'ui-running']);

  if (process.env.UI_SANDBOX_SMOKE_SCENARIO === 'security') {
    await seedSecurityScenario(admin.id);
  }

  await Bun.sleep(50);
  if (process.env.UI_SANDBOX_CHAT_EVAL === '1') {
    await seedChatEvalFixtures({ adminId: admin.id, personaId });
  }
  if (process.env.UI_SANDBOX_TASK_DETAIL_EVAL === '1') {
    await seedTaskDetailEvalFixtures({ adminId: admin.id, gitRepo });
  }
  if (process.env.UI_SANDBOX_NOTIFICATIONS_EVAL === '1') {
    await seedNotificationsEvalFixtures({ adminId: admin.id });
  }
  await closeDatabase();
  console.log(
    `Seeded ${projects.length} UI sandbox projects for ${admin.username}.`,
  );
}

await main();
