import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  appendPendingChatReflectionRange,
  appendChannelInstruction,
  appendLiveInstructionForContinuation,
  buildSessionRecoveryPrompt,
  extractPlanArtifact,
  resolveConversationCheckout,
  resolveTurnInstructionDelivery,
  shouldInterceptReflect,
  shouldRunDirectLlmInline,
  shouldReplayDirectLlmPersonaTail,
  type ChatAgentInspection,
  type ChatReflectionRange,
} from './agent-runner.js';
import type { RegisteredGroup } from './types.js';

describe('DirectLLM persona provider context', () => {
  test('keeps ordinary main-persona identity in stable top-level instructions', () => {
    expect(
      shouldReplayDirectLlmPersonaTail(
        'ai-main:main-id',
        'responses',
        undefined,
      ),
    ).toBe(false);
  });

  test('uses a replayable developer tail only for ephemeral persona turns', () => {
    expect(
      shouldReplayDirectLlmPersonaTail('ai-main:main-id', 'responses', true),
    ).toBe(true);
    expect(
      shouldReplayDirectLlmPersonaTail('ai:invited-id', 'responses', true),
    ).toBe(true);
    expect(
      shouldReplayDirectLlmPersonaTail('llm:direct:gpt', 'responses', true),
    ).toBe(false);
    expect(
      shouldReplayDirectLlmPersonaTail(
        'ai-main:main-id',
        'chat_completions',
        true,
      ),
    ).toBe(false);
    expect(
      shouldReplayDirectLlmPersonaTail(
        'ai-main:main-id',
        'responses',
        true,
        true,
      ),
    ).toBe(false);
  });
});

describe('scheduled Direct runtime lifecycle', () => {
  test('uses tracked execution for scheduled Direct runs', () => {
    expect(shouldRunDirectLlmInline(true)).toBe(true);
    expect(shouldRunDirectLlmInline(true, 'scheduled-1')).toBe(false);
    expect(shouldRunDirectLlmInline(false, 'scheduled-1')).toBe(false);
  });

  test('schedules only new transcript ranges with each runtime profile', () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-runner-reflection-range-'),
    );
    const script = String.raw`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';

      const root = process.cwd();
      const db = await import(root + '/src/db.ts');
      const runner = await import(root + '/src/agent-runner.ts');
      const groupDir = await import(root + '/src/group-dir.ts');
      await db.initDatabase(':memory:');
      const { drizzleDbRef } = await import(root + '/src/db/drizzle-client.ts');
      const handle = drizzleDbRef.current;
      const client = handle.$client ?? handle._?.client ?? handle.session?.client;
      const projectId = 'runner-reflection-range';
      await client.exec(
        "INSERT INTO projects (id, jid, name, folder, trigger, added_at, settings, is_main) " +
        "VALUES ('" + projectId + "', '" + projectId + "@web', 'Reflection range', '" +
        projectId + "', '!', '2026-09-11T00:00:00.000Z', '{}', 0)"
      );
      const directConversation = await db.createConversation(projectId);
      const cliConversation = await db.createConversation(projectId);
      const historical = JSON.stringify({
        type: 'message',
        role: 'user',
        content: 'Historical transcript content must remain outside automatic reflection.',
        created_at: '2026-09-10T00:00:00.000Z',
      }) + '\n';
      for (const conversation of [directConversation, cliConversation]) {
        const target = groupDir.chatTranscriptPath(
          projectId,
          undefined,
          conversation.id,
        );
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, historical);
      }

      const scheduled = [];
      runner.setChatReflectionSchedulerForTests((range) => scheduled.push(range));
      const server = Bun.serve({
        port: 0,
        fetch: () => new Response(
          'data: {"choices":[{"delta":{"content":"Direct answer"}}]}\n\n' +
          'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      });
      const group = {
        jid: projectId + '@web',
        folder: projectId,
        name: 'Reflection range',
        trigger: '!',
        added_at: '2026-09-11T00:00:00.000Z',
        settings: {},
      };
      try {
        await runner.runChatAgent(
          group,
          'Direct question',
          group.jid,
          undefined,
          null,
          false,
          directConversation.id,
          undefined,
          {
            agent_cmd: 'direct-reflection-test',
            agentConfig: {
              id: 'direct-reflection-test',
              label: 'Direct reflection test',
              harnessId: 'openai',
              harnessKind: 'direct',
              modelId: 'test-model',
              model: 'test-model',
              baseUrl: 'http://127.0.0.1:' + server.port + '/v1',
              apiKey: 'test-key',
              allowedToolNames: [],
            },
          },
        );

        runner.setContainerAgentRunnerForTests(async () => {
          const target = groupDir.chatTranscriptPath(
            projectId,
            undefined,
            cliConversation.id,
          );
          const transcriptOffset = fs.statSync(target).size;
          fs.appendFileSync(
            target,
            JSON.stringify({
              type: 'message',
              role: 'assistant',
              content: 'CLI answer',
              created_at: '2026-09-11T00:00:02.000Z',
            }) + '\n',
          );
          return {
            status: 'success',
            result: 'CLI answer',
            transcriptTarget: target,
            transcriptOffset,
            workspaceRoot: groupDir.getGroupDir(projectId),
            duration: 1,
          };
        });
        await runner.runChatAgent(
          group,
          'CLI question',
          group.jid,
          undefined,
          null,
          false,
          cliConversation.id,
          undefined,
          {
            agent_cmd: 'cli-reflection-test',
            agentConfig: {
              id: 'cli-reflection-test',
              label: 'CLI reflection test',
              harnessId: 'codex',
              harnessKind: 'cli',
              modelId: 'default',
              agentCmd: 'codex',
            },
          },
        );
      } finally {
        server.stop(true);
        runner.setContainerAgentRunnerForTests(null);
        runner.setChatReflectionSchedulerForTests(null);
      }

      assert.equal(scheduled.length, 2);
      assert.equal(scheduled[0].profile, 'direct-llm-conversation');
      assert.equal(scheduled[1].profile, 'run-agent-conversation');
      assert.equal(scheduled[0].conversationId, directConversation.id);
      assert.equal(scheduled[1].conversationId, cliConversation.id);
      assert.equal(scheduled[0].objectiveId, null);
      assert.equal(scheduled[1].objectiveId, null);
      assert.equal(
        scheduled[1].sandboxWorkspacePath,
        '/workspace/' + projectId,
      );
      for (const range of scheduled) {
        assert.ok(range.byteOffset > Buffer.byteLength(historical));
        assert.ok(range.byteEndOffset > range.byteOffset);
        const bytes = fs.readFileSync(range.transcriptTarget);
        const prefix = bytes.subarray(0, range.byteOffset).toString();
        assert.ok(prefix.startsWith(historical));
        const state = JSON.parse(prefix.slice(historical.length).trim());
        assert.equal(state.type, 'turn_instruction_state');
        assert.equal(state.provider_context, true);
        assert.equal(state.channel, 'direct');
      }
      const directBytes = fs.readFileSync(scheduled[0].transcriptTarget);
      const directRange = directBytes
        .subarray(scheduled[0].byteOffset, scheduled[0].byteEndOffset)
        .toString();
      assert.match(directRange, /Direct question/);
      assert.match(directRange, /Direct answer/);
      assert.doesNotMatch(directRange, /Historical transcript content/);
      process.exit(0);
    `;
    try {
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CARAPA_DATA_DIR: dataDir,
          DATABASE_URL: '',
          DB_HOST: '',
          DB_PASSWORD: '',
          POSTGRES_PASSWORD: '',
        },
        encoding: 'utf8',
        timeout: 90_000,
      });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout);
      }
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 100_000);
});

describe('deferred chat reflection admission', () => {
  test('keeps a worktree-to-shared transition as ordered durable jobs during debounce', () => {
    const ranges: ChatReflectionRange[] = [];
    const worktreeRange: ChatReflectionRange = {
      groupFolder: 'reflection-scope-transition',
      transcriptTarget: 'groups/reflection/transcripts/chat.output.jsonl',
      byteOffset: 10,
      byteEndOffset: 20,
      profile: 'run-agent-conversation',
      workspaceRoot: '/workspace/project',
      objectiveId: null,
      conversationId: 'conversation-1',
      sandboxStack: 'carapa-bot',
      sandboxService: 'agent',
      sandboxInstance: 'worktree-sandbox',
      sandboxWorkspacePath: '/workspace/project/.worktrees/chat-1',
      admittedRunId: 'worktree-admission',
    };

    appendPendingChatReflectionRange(ranges, worktreeRange);
    appendPendingChatReflectionRange(ranges, {
      ...worktreeRange,
      byteOffset: 10,
      byteEndOffset: 30,
    });
    appendPendingChatReflectionRange(ranges, {
      ...worktreeRange,
      byteOffset: 30,
      byteEndOffset: 40,
      sandboxInstance: 'shared-sandbox',
      sandboxWorkspacePath: '/workspace/project',
      admittedRunId: 'shared-admission',
    });

    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({
      admittedRunId: 'worktree-admission',
      byteOffset: 10,
      byteEndOffset: 30,
      sandboxWorkspacePath: '/workspace/project/.worktrees/chat-1',
    });
    expect(ranges[1]).toMatchObject({
      admittedRunId: 'shared-admission',
      byteOffset: 30,
      byteEndOffset: 40,
      sandboxWorkspacePath: '/workspace/project',
    });
  });
});

describe('native Codex plan artifacts', () => {
  test('extracts the artifact from a streamed plan message when no final result exists', () => {
    const plan = [
      '# Saved plan',
      '',
      '```carapaplan',
      '{"artifactPath":"artifacts/plans/saved-plan.md","planText":"# Saved plan\\n"}',
      '```',
    ].join('\n');

    expect(extractPlanArtifact(undefined)).toBeNull();
    expect(extractPlanArtifact(plan)).toEqual({
      relPath: 'plans/saved-plan.md',
      text: '# Saved plan\n',
    });
  });
});

describe('Live Mode CLI continuation prompt', () => {
  test('repeats Live on every continuation and clears it only on a change', () => {
    expect(
      appendLiveInstructionForContinuation('hello', 'conv', false, true),
    ).toContain('[[live: concise status]]');
    expect(
      appendLiveInstructionForContinuation('hello', 'conv', false, true, false),
    ).toContain('[[live: concise status]]');
    expect(
      appendLiveInstructionForContinuation('hello', 'conv', false, false),
    ).toContain('LIVE MODE IS OFF');
    expect(
      appendLiveInstructionForContinuation('hello', 'conv', false, false),
    ).toContain('Do not emit');
    expect(
      appendLiveInstructionForContinuation('hello', 'conv', true, true),
    ).toBe('hello');
    expect(
      appendLiveInstructionForContinuation(
        'hello',
        'conv',
        false,
        false,
        false,
      ),
    ).toBe('hello');
  });
});
describe('current human context', () => {
  test('delivers state once per runtime and refreshes only changed context', () => {
    const current = {
      channel: 'direct' as const,
      liveMode: false,
      chatMode: null,
      humanUserId: 'human-a',
    };
    const priorDelivery = {
      type: 'turn_instruction_state',
      provider_context: true,
      contextRecipient: 'codex-session',
      channel: 'direct',
      liveMode: false,
      chatMode: null,
      humanUserId: 'human-a',
      humanContextUserId: 'human-a',
      messageId: 'turn-a1',
    };

    expect(
      resolveTurnInstructionDelivery([], 'codex-session', current, 'turn-a1'),
    ).toMatchObject({
      channel: true,
      liveMode: true,
      chatMode: true,
      humanContext: true,
    });
    expect(
      resolveTurnInstructionDelivery(
        [priorDelivery],
        'codex-session',
        current,
        'turn-a2',
      ),
    ).toMatchObject({
      channel: false,
      liveMode: false,
      chatMode: false,
      humanContext: false,
    });
    expect(
      resolveTurnInstructionDelivery(
        [priorDelivery],
        'codex-session',
        { ...current, channel: 'WhatsApp' },
        'turn-a2',
      ),
    ).toMatchObject({
      channel: true,
      liveMode: true,
      chatMode: true,
      humanContext: false,
    });
    expect(
      resolveTurnInstructionDelivery(
        [priorDelivery],
        'codex-session',
        { ...current, liveMode: true },
        'turn-a2',
      ),
    ).toMatchObject({
      channel: false,
      liveMode: true,
      chatMode: false,
      humanContext: false,
    });
    expect(
      resolveTurnInstructionDelivery(
        [priorDelivery],
        'codex-session',
        { ...current, chatMode: 'debug' },
        'turn-a2',
      ),
    ).toMatchObject({
      channel: false,
      liveMode: false,
      chatMode: true,
      humanContext: false,
    });
    expect(
      resolveTurnInstructionDelivery(
        [priorDelivery],
        'codex-session',
        { ...current, humanUserId: 'human-b' },
        'turn-b1',
      ).humanContext,
    ).toBe(true);
    expect(
      resolveTurnInstructionDelivery(
        [priorDelivery],
        'claude-session',
        current,
        'turn-a2',
      ).channel,
    ).toBe(true);
    expect(
      resolveTurnInstructionDelivery(
        [{ ...priorDelivery, messageId: 'turn-a2' }],
        'codex-session',
        current,
        'turn-a2',
      ).channel,
    ).toBe(true);
    expect(
      resolveTurnInstructionDelivery(
        [{ ...priorDelivery, messageId: undefined }],
        'codex-session',
        current,
      ).channel,
    ).toBe(false);
    expect(
      resolveTurnInstructionDelivery(
        [priorDelivery, { type: 'compaction_marker' }],
        'codex-session',
        current,
        'turn-a2',
      ).channel,
    ).toBe(true);
  });
});

describe('human context runner dispatch', () => {
  test('preserves human and inherited objective group context across sandbox lifecycle boundaries and tracked Direct runs', () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-runner-human-context-'),
    );
    const script = String.raw`
      const root = process.cwd();
      const db = await import(root + '/src/db.ts');
      const runner = await import(root + '/src/agent-runner.ts');
      await db.initDatabase(':memory:');
      const { drizzleDbRef } = await import(root + '/src/db/drizzle-client.ts');
      const handle = drizzleDbRef.current;
      const client = handle.$client ?? handle._?.client ?? handle.session?.client;
      const projectId = 'runner-human-context';
      await client.exec(
        "INSERT INTO users (id, username, password_hash, role, created_at, disabled, preferences, display_name) VALUES " +
        "('human-a', 'human-a-login', 'hash', 'user', '2026-09-10T00:00:00.000Z', 0, 'Account preference A', 'Human A'), " +
        "('human-b', 'human-b-login', 'hash', 'user', '2026-09-10T00:00:00.000Z', 0, 'Account preference B', 'Human B')"
      );
      await client.exec(
        "INSERT INTO projects (id, jid, name, folder, trigger, added_at, settings, is_main) " +
        "VALUES ('" + projectId + "', '" + projectId + "@web', 'Runner context', '" +
        projectId + "', '!', '2026-09-10T00:00:00.000Z', '{}', 0)"
      );
      await db.upsertProjectMember('human-b', projectId, 'viewer');
      await db.setMemberPreferences('human-b', projectId, 'Project preference B');
      const objective = await db.createObjective({
        project_id: projectId,
        title: 'Runner objective',
        status: 'active',
        priority: 0,
        progress: 0,
      });
      const conversation = await db.createObjectiveConversation(projectId, objective.id);
      const { GROUPS_DIR } = await import(root + '/src/config.ts');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const rulesDir = path.join(GROUPS_DIR, projectId, '.agent', 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, 'always.md'), '---\ntrigger: always_on\n---\nInherited group policy.');
      fs.writeFileSync(path.join(rulesDir, 'conditional.md'), '---\ntrigger: model_decision\ndescription: Read for deployment work.\n---\nConditional group policy.');
      const objectiveRulesDir = path.join(GROUPS_DIR, projectId, 'objectives', objective.id, '.agent', 'rules');
      fs.mkdirSync(objectiveRulesDir, { recursive: true });
      fs.writeFileSync(path.join(objectiveRulesDir, 'local.md'), '---\ntrigger: always_on\n---\nObjective local policy.');
      const objectiveCwd = '/workspace/group/objectives/' + objective.id;
      const launches = [];
      runner.setContainerAgentRunnerForTests(async (_group, input, onChunk) => {
        launches.push({
          prompt: input.prompt,
          fallbackPrompt: input.fallbackPrompt,
          systemPrompt: input.systemPrompt,
          injectAgentContext: input.injectAgentContext,
          workDir: input.work_dir,
        });
        if (input.prompt.startsWith('Compaction trigger')) {
          onChunk?.({ type: 'compaction', session_id: 'session-b' });
        }
        return {
          status: 'success',
          result: 'ok',
          duration: 1,
          newSessionId: input.session_id || 'fresh-session',
        };
      });
      const group = {
        folder: projectId,
        name: 'Runner context',
        trigger: '!',
        added_at: '2026-09-10T00:00:00.000Z',
        settings: {},
      };
      const cli = {
        id: 'runner-cli',
        label: 'Runner CLI',
        harnessId: 'codex',
        harnessKind: 'cli',
        modelId: 'default',
        agentCmd: 'runner-cli',
        sessionFamily: 'runner-family',
      };
      const direct = {
        id: 'runner-direct',
        label: 'Runner Direct',
        harnessId: 'openai',
        harnessKind: 'direct',
        modelId: 'test-model',
        model: 'test-model',
        sessionFamily: 'direct-family',
      };
      await runner.runSandboxAgent(group, 'Fresh turn', projectId + '@web', undefined, null, false, undefined, undefined, {
        agent_cmd: cli.id,
        agentConfig: cli,
        senderUserId: 'human-a',
      });
      await runner.runSandboxAgent(group, 'Continuation turn', projectId + '@web', undefined, 'session-b', false, conversation.id, undefined, {
        agent_cmd: cli.id,
        agentConfig: cli,
        senderUserId: 'human-b',
      });
      await runner.runSandboxAgent(group, 'Compaction trigger', projectId + '@web', undefined, 'session-b', false, conversation.id, undefined, {
        agent_cmd: cli.id,
        agentConfig: cli,
        senderUserId: 'human-b',
      });
      await runner.runSandboxAgent(group, 'Post-compaction turn', projectId + '@web', undefined, 'session-b', false, conversation.id, objectiveCwd, {
        agent_cmd: cli.id,
        agentConfig: cli,
        senderUserId: 'human-b',
      });
      await runner.runSandboxAgent(group, 'Unknown turn', projectId + '@web', undefined, null, false, undefined, undefined, {
        agent_cmd: cli.id,
        agentConfig: cli,
        senderUserId: 'missing-human',
      });
      await runner.runSandboxAgent(group, 'Skipped turn', projectId + '@web', undefined, null, false, undefined, undefined, {
        agent_cmd: cli.id,
        agentConfig: cli,
        senderUserId: 'human-a',
        skipUserPreferences: true,
      });
      await runner.runSandboxAgent(group, 'Tracked Direct turn', projectId + '@web', undefined, null, false, conversation.id, objectiveCwd, {
        agent_cmd: direct.id,
        agentConfig: direct,
        senderUserId: 'human-a',
        scheduledTaskId: 'scheduled-context-run',
        isScheduledTask: true,
      });
      await runner.runSandboxAgent(group, 'Fresh objective turn', projectId + '@web', undefined, null, false, conversation.id, objectiveCwd, {
        agent_cmd: cli.id,
        agentConfig: cli,
      });
      runner.setContainerAgentRunnerForTests(null);
      console.log('HUMAN_CONTEXT_LAUNCHES=' + JSON.stringify(launches));
      process.exit(0);
    `;
    try {
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CARAPA_DATA_DIR: dataDir,
          DATABASE_URL: '',
          DB_HOST: '',
          DB_PASSWORD: '',
          POSTGRES_PASSWORD: '',
        },
        encoding: 'utf8',
        timeout: 90_000,
      });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout);
      }
      const marker = result.stdout
        .split('\n')
        .find((line) => line.startsWith('HUMAN_CONTEXT_LAUNCHES='));
      expect(marker).toBeDefined();
      const launches = JSON.parse(
        marker!.slice('HUMAN_CONTEXT_LAUNCHES='.length),
      ) as Array<{
        prompt: string;
        fallbackPrompt?: string;
        systemPrompt?: string;
        injectAgentContext: boolean;
        workDir?: string;
      }>;
      const contextCount = (value: string | undefined) =>
        value?.match(/\[CURRENT HUMAN CONTEXT\]/g)?.length ?? 0;

      expect(launches).toHaveLength(8);
      expect(contextCount(launches[0].prompt)).toBe(1);
      expect(launches[0].prompt).toContain('Display name: Human A');
      expect(launches[0].prompt).toContain('Account preference A');
      expect(launches[0].systemPrompt).not.toContain('Human Participant');

      expect(contextCount(launches[1].prompt)).toBe(1);
      expect(launches[1].prompt).toContain('Display name: Human B');
      expect(launches[1].prompt).toContain('Project preference B');
      expect(launches[1].prompt).not.toContain('Human A');
      expect(contextCount(launches[1].fallbackPrompt)).toBe(1);
      expect(launches[1].fallbackPrompt).toContain('Continuation turn');

      expect(contextCount(launches[3].prompt)).toBe(1);
      expect(launches[3].injectAgentContext).toBe(true);
      expect(launches[3].systemPrompt).not.toContain('Human Participant');

      expect(contextCount(launches[4].prompt)).toBe(0);
      expect(contextCount(launches[5].prompt)).toBe(0);
      expect(contextCount(launches[6].prompt)).toBe(1);
      expect(launches[6].prompt).toContain('Tracked Direct turn');
      expect(launches[6].systemPrompt).not.toContain('Human Participant');

      // Every harness receives inherited rules in the actual prompt, without
      // repeating them during continuation or relying on system-prompt support.
      expect(launches[0].prompt).not.toContain('Inherited group policy.');
      expect(launches[1].prompt).not.toContain('Inherited group policy.');
      expect(launches[1].fallbackPrompt).toContain('Inherited group policy.');
      for (const index of [3, 7]) {
        expect(launches[index].prompt).toContain('Inherited group policy.');
        expect(launches[index].prompt).toContain(
          '/workspace/group/.agent/rules/conditional.md',
        );
        expect(launches[index].prompt).not.toContain(
          'Conditional group policy.',
        );
        expect(launches[index].prompt).not.toContain('Objective local policy.');
        expect(launches[index].workDir).toStartWith(
          '/workspace/group/objectives/',
        );
      }
      expect(launches[6].prompt).not.toContain('Inherited group policy.');
      expect(
        launches[6].systemPrompt?.match(/Inherited group policy\./g),
      ).toHaveLength(1);
      expect(launches[6].systemPrompt).toContain('Objective local policy.');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 100_000);

  test('sends enriched inline Direct prompts over the wire and exposes the same inspection', () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-direct-human-context-'),
    );
    const script = String.raw`
      const root = process.cwd();
      const db = await import(root + '/src/db.ts');
      const { runChatAgent } = await import(root + '/src/agent-runner.ts');
      await db.initDatabase(':memory:');
      const { drizzleDbRef } = await import(root + '/src/db/drizzle-client.ts');
      const handle = drizzleDbRef.current;
      const client = handle.$client ?? handle._?.client ?? handle.session?.client;
      const projectId = 'direct-human-context';
      await client.exec(
        "INSERT INTO users (id, username, password_hash, role, created_at, disabled, preferences, display_name) VALUES " +
        "('direct-a', 'direct-a-login', 'hash', 'user', '2026-09-10T00:00:00.000Z', 0, 'Direct account A', 'Direct A'), " +
        "('direct-b', 'direct-b-login', 'hash', 'user', '2026-09-10T00:00:00.000Z', 0, 'Direct account B', 'Direct B')"
      );
      await client.exec(
        "INSERT INTO projects (id, jid, name, folder, trigger, added_at, settings, is_main) " +
        "VALUES ('" + projectId + "', '" + projectId + "@web', 'Direct context', '" +
        projectId + "', '!', '2026-09-10T00:00:00.000Z', '{}', 0)"
      );
      await db.upsertProjectMember('direct-b', projectId, 'viewer');
      await db.setMemberPreferences('direct-b', projectId, 'Direct project B');
      const bodies = [];
      const server = Bun.serve({
        port: 0,
        fetch: async (request) => {
          bodies.push(await request.json());
          return new Response(
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });
      const group = {
        folder: projectId,
        name: 'Direct context',
        trigger: '!',
        added_at: '2026-09-10T00:00:00.000Z',
        settings: {},
      };
      const config = {
        id: 'direct-test',
        label: 'Direct test',
        harnessId: 'openai',
        harnessKind: 'direct',
        modelId: 'test-model',
        model: 'test-model',
        baseUrl: 'http://127.0.0.1:' + server.port + '/v1',
        apiKey: 'test-key',
        allowedToolNames: [],
      };
      const runs = [];
      for (const options of [
        { senderUserId: 'direct-a' },
        { senderUserId: 'direct-b' },
        { senderUserId: 'missing-direct-user' },
        { senderUserId: 'direct-a', skipUserPreferences: true },
      ]) {
        runs.push(await runChatAgent(
          group,
          'Original Direct text',
          projectId + '@web',
          undefined,
          null,
          false,
          undefined,
          undefined,
          {
            agent_cmd: config.id,
            agentConfig: config,
            captureInspection: true,
            ...options,
          },
        ));
      }
      server.stop(true);
      console.log('DIRECT_HUMAN_CONTEXT=' + JSON.stringify({ bodies, runs }));
      process.exit(0);
    `;
    try {
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CARAPA_DATA_DIR: dataDir,
          DATABASE_URL: '',
          DB_HOST: '',
          DB_PASSWORD: '',
          POSTGRES_PASSWORD: '',
        },
        encoding: 'utf8',
        timeout: 90_000,
      });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout);
      }
      const marker = result.stdout
        .split('\n')
        .find((line) => line.startsWith('DIRECT_HUMAN_CONTEXT='));
      expect(marker).toBeDefined();
      const captured = JSON.parse(
        marker!.slice('DIRECT_HUMAN_CONTEXT='.length),
      ) as { bodies: any[]; runs: Array<{ inspection: ChatAgentInspection }> };
      const currentTurn = (body: any) => {
        const message = body.messages.findLast(
          (candidate: any) => candidate.role === 'user',
        );
        return message.content.findLast((part: any) => part.type === 'text')
          .text;
      };
      const contextCount = (value: string) =>
        value.match(/\[CURRENT HUMAN CONTEXT\]/g)?.length ?? 0;
      const turns = captured.bodies.map(currentTurn);

      expect(captured.bodies).toHaveLength(4);
      expect(contextCount(turns[0])).toBe(1);
      expect(turns[0]).toContain('Display name: Direct A');
      expect(turns[0]).toContain('Direct account A');
      expect(turns[1]).toContain('Display name: Direct B');
      expect(turns[1]).toContain('Direct project B');
      expect(turns[1]).not.toContain('Direct A');
      expect(contextCount(turns[2])).toBe(0);
      expect(contextCount(turns[3])).toBe(0);
      for (let index = 0; index < turns.length; index += 1) {
        expect(turns[index]).toContain('Original Direct text');
        expect(turns[index]).toContain('[CHANNEL: direct]');
        expect(captured.runs[index].inspection.prompt).toBe(turns[index]);
        expect(captured.runs[index].inspection.systemPrompt).not.toContain(
          'Human Participant',
        );
      }
      expect(captured.runs[0].inspection.systemPrompt).toBe(
        captured.runs[1].inspection.systemPrompt,
      );
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 100_000);
});

describe('privacy mode DirectLLM chat gate', () => {
  test('refuses a remote-locality Direct runtime under strict mode only', () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-direct-privacy-'),
    );
    const script = String.raw`
      const root = process.cwd();
      const db = await import(root + '/src/db.ts');
      const { runChatAgent } = await import(root + '/src/agent-runner.ts');
      const state = await import(root + '/src/state-manager.ts');
      await db.initDatabase(':memory:');
      const projectId = 'direct-privacy';
      let hits = 0;
      const server = Bun.serve({
        port: 0,
        fetch: async () => {
          hits += 1;
          return new Response(
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });
      // Declared locality wins over the loopback URL, so only the
      // runChatAgent runtime gate can refuse this run.
      const config = {
        id: 'direct-privacy-test',
        label: 'Direct privacy test',
        harnessId: 'openai',
        harnessKind: 'direct',
        modelId: 'test-model',
        model: 'test-model',
        locality: 'remote',
        baseUrl: 'http://127.0.0.1:' + server.port + '/v1',
        apiKey: 'test-key',
        allowedToolNames: [],
      };
      const results = {};
      for (const mode of ['strict', 'off', 'local_memory']) {
        const group = {
          folder: projectId,
          name: 'Direct privacy',
          trigger: '!',
          added_at: '2026-09-10T00:00:00.000Z',
          settings: { privacyMode: mode },
        };
        state.registeredGroups[projectId + '@web'] = group;
        state.applyGroupUpdateInMemory(projectId + '@web', {});
        const before = hits;
        const run = await runChatAgent(
          group, 'hello', projectId + '@web', undefined, null, false,
          undefined, undefined,
          { agent_cmd: config.id, agentConfig: config },
        );
        results[mode] = { failed: run.failed === true, isLlm: run.isLlm, result: run.result, hits: hits - before };
      }
      server.stop(true);
      console.log('DIRECT_PRIVACY=' + JSON.stringify(results));
      process.exit(0);
    `;
    try {
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CARAPA_DATA_DIR: dataDir,
          DATABASE_URL: '',
          DB_HOST: '',
          DB_PASSWORD: '',
          POSTGRES_PASSWORD: '',
        },
        encoding: 'utf8',
        timeout: 90_000,
      });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout);
      }
      const marker = result.stdout
        .split('\n')
        .find((line) => line.startsWith('DIRECT_PRIVACY='));
      expect(marker).toBeDefined();
      const runs = JSON.parse(
        marker!.slice('DIRECT_PRIVACY='.length),
      ) as Record<
        string,
        { failed: boolean; isLlm: boolean; result: string; hits: number }
      >;
      expect(runs.strict).toMatchObject({ failed: true, isLlm: true, hits: 0 });
      expect(runs.strict.result).toContain('Privacy mode "strict"');
      expect(runs.off).toMatchObject({ failed: false, hits: 1 });
      expect(runs.local_memory).toMatchObject({ failed: false, hits: 1 });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 100_000);
});

describe('native session crash recovery prompt', () => {
  test('replays canonical transcript context before the interrupted user turn', () => {
    expect(
      buildSessionRecoveryPrompt(
        'continue the benchmark',
        '[CONTEXT_SUMMARY: Assistant: I was measuring verify:changed]',
      ),
    ).toBe(
      '[CONTEXT_SUMMARY: Assistant: I was measuring verify:changed]\n\ncontinue the benchmark',
    );
  });
});
describe('channel instructions', () => {
  test('adds long-task messaging guidance for WhatsApp chats', () => {
    for (const jid of ['12345@g.us', '12345@s.whatsapp.net']) {
      const prompt = appendChannelInstruction('hello', jid);
      expect(prompt).toContain('[CHANNEL: WhatsApp]');
      expect(prompt).toContain('mcp__carapa-board__send_message');
      expect(prompt).toContain('intermediate updates');
    }
  });

  test('keeps web and API progress in-band', () => {
    for (const jid of ['project@web', 'project@bridge']) {
      const prompt = appendChannelInstruction('hello', jid);
      expect(prompt).toContain('[CHANNEL: direct]');
      expect(prompt).toContain('Do not use mcp__carapa-board__send_message');
    }
  });
});

describe('/reflect routing', () => {
  test('intercepts the command for the DirectLLM harness', () => {
    expect(
      shouldInterceptReflect({
        id: 'llm:memory-pipeline',
        label: 'Memory pipeline',
        harnessId: 'openai',
        harnessKind: 'direct',
      }),
    ).toBe(true);
  });

  test('leaves the command to Codex and Claude harnesses', () => {
    for (const harnessId of ['codex', 'claude']) {
      expect(
        shouldInterceptReflect({
          id: `${harnessId}:default`,
          label: harnessId,
          harnessId,
          harnessKind: 'cli',
        }),
      ).toBe(false);
    }
  });
});

describe('delegated conversation checkout', () => {
  const group = {
    folder: 'project',
    settings: { repositoryLocation: '/host/repo' },
  } as RegisteredGroup;
  const conversation = {
    id: 'parent',
    group_folder: 'project',
    use_worktree: 1,
  } as any;

  test('prepares the parent worktree while keeping child session and transcript detached', () => {
    const checkout = resolveConversationCheckout(group, conversation, 'parent');
    expect(checkout).toMatchObject({
      branch_name: 'chat-parent',
      localRepo: '/host/repo',
      worktreeRequested: true,
      checkoutConversationId: 'parent',
    });
    expect(checkout).not.toHaveProperty('conversation_id');
    expect(checkout).not.toHaveProperty('session_id');
    expect(
      resolveConversationCheckout(
        group,
        {
          ...conversation,
          branch_name: 'existing',
          worktree_path: '/host/repo/.worktrees/existing',
        },
        'parent',
      ),
    ).toMatchObject({
      branch_name: 'existing',
      worktree_path: '/host/repo/.worktrees/existing',
    });
    expect(
      resolveConversationCheckout(
        group,
        { ...conversation, use_worktree: 0 },
        'parent',
      ),
    ).toEqual({});
  });

  test('rejects unavailable or foreign checkout ownership instead of using the shared checkout', () => {
    for (const candidate of [
      undefined,
      { ...conversation, group_folder: 'other' },
      { ...conversation, worktreeMissing: true },
    ]) {
      expect(() =>
        resolveConversationCheckout(group, candidate, 'parent'),
      ).toThrow();
    }
    expect(() =>
      resolveConversationCheckout(
        { ...group, settings: {} },
        conversation,
        'parent',
      ),
    ).toThrow();
  });
});

describe('ephemeral sandbox session isolation', () => {
  test('does not replace durable group session ownership while ordinary runs still persist', () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-runner-ephemeral-session-'),
    );
    const script = String.raw`
      const root = process.cwd();
      const db = await import(root + '/src/db.ts');
      const runner = await import(root + '/src/agent-runner.ts');
      const state = await import(root + '/src/state-manager.ts');
      const { DATA_DIR } = await import(root + '/src/config.ts');
      const { saveJson } = await import(root + '/src/utils.ts');
      const fs = await import('node:fs');
      const path = await import('node:path');
      await db.initDatabase(':memory:');
      const { drizzleDbRef } = await import(root + '/src/db/drizzle-client.ts');
      const handle = drizzleDbRef.current;
      const client = handle.$client ?? handle._?.client ?? handle.session?.client;
      const projectId = 'runner-ephemeral-session';
      await client.exec(
        "INSERT INTO projects (id, jid, name, folder, trigger, added_at, settings, is_main) " +
        "VALUES ('" + projectId + "', '" + projectId + "@web', 'Runner session isolation', '" +
        projectId + "', '!', '2026-09-12T00:00:00.000Z', '{}', 0)"
      );
      state.sessions[projectId] = 'existing-group-session';
      state.sessionAgentCmds[projectId] = 'existing-runtime';
      saveJson(path.join(DATA_DIR, 'sessions.json'), state.sessions);

      const launches = [];
      runner.setContainerAgentRunnerForTests(async (_group, input) => {
        launches.push({ rawMessage: input.rawMessage, sessionId: input.session_id });
        return {
          status: 'success',
          result: 'ok',
          duration: 1,
          newSessionId: input.ephemeral
            ? 'detached-browser-session'
            : 'ordinary-next-session',
        };
      });
      const group = {
        folder: projectId,
        name: 'Runner session isolation',
        trigger: '!',
        added_at: '2026-09-12T00:00:00.000Z',
        settings: {},
      };
      const runtime = (id) => ({
        id,
        label: id,
        harnessId: 'codex',
        harnessKind: 'cli',
        modelId: 'default',
        agentCmd: id,
        sessionFamily: id,
      });

      await runner.runSandboxAgent(
        group,
        'Detached browser worker',
        'web-view-agent',
        undefined,
        null,
        false,
        undefined,
        undefined,
        {
          agent_cmd: 'browser-runtime',
          agentConfig: runtime('browser-runtime'),
          ephemeral: true,
          skipUserPreferences: true,
        },
      );
      const afterEphemeral = {
        inMemorySession: state.sessions[projectId],
        persistedSessions: JSON.parse(
          fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'),
        ),
        agentCmd: state.sessionAgentCmds[projectId],
      };

      await runner.runSandboxAgent(
        group,
        'Ordinary detached run',
        projectId + '@web',
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        {
          agent_cmd: 'existing-runtime',
          agentConfig: runtime('existing-runtime'),
        },
      );
      const afterOrdinary = {
        inMemorySession: state.sessions[projectId],
        persistedSessions: JSON.parse(
          fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'),
        ),
        agentCmd: state.sessionAgentCmds[projectId],
      };
      runner.setContainerAgentRunnerForTests(null);
      console.log(
        'EPHEMERAL_SESSION_ISOLATION=' +
          JSON.stringify({ launches, afterEphemeral, afterOrdinary }),
      );
      process.exit(0);
    `;
    try {
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        env: {
          CARAPA_DATA_DIR: dataDir,
          DATABASE_URL: '',
          DB_HOST: '',
          DB_PASSWORD: '',
          POSTGRES_PASSWORD: '',
          LOG_LEVEL: 'silent',
        },
        encoding: 'utf8',
        timeout: 90_000,
      });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout);
      }
      const marker = result.stdout
        .split('\n')
        .find((line) => line.startsWith('EPHEMERAL_SESSION_ISOLATION='));
      expect(marker).toBeDefined();
      const captured = JSON.parse(
        marker!.slice('EPHEMERAL_SESSION_ISOLATION='.length),
      );
      expect(captured.launches).toEqual([
        { rawMessage: 'Detached browser worker' },
        {
          rawMessage: 'Ordinary detached run',
          sessionId: 'existing-group-session',
        },
      ]);
      expect(captured.afterEphemeral).toEqual({
        inMemorySession: 'existing-group-session',
        persistedSessions: {
          'runner-ephemeral-session': 'existing-group-session',
        },
        agentCmd: 'existing-runtime',
      });
      expect(captured.afterOrdinary).toEqual({
        inMemorySession: 'ordinary-next-session',
        persistedSessions: {
          'runner-ephemeral-session': 'ordinary-next-session',
        },
        agentCmd: 'existing-runtime',
      });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 100_000);
});

describe('chat turn failing before the agent session starts', () => {
  test('persists a scrubbed reason that an ask answer reads, and leaves a started run untouched', () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-runner-prelaunch-'),
    );
    const script = String.raw`
      const root = process.cwd();
      const db = await import(root + '/src/db.ts');
      const runner = await import(root + '/src/agent-runner.ts');
      const groupDir = await import(root + '/src/group-dir.ts');
      const { readAskAnswer } = await import(root + '/src/modules/agent-asks/delivery.ts');
      await db.initDatabase(':memory:');
      const { drizzleDbRef } = await import(root + '/src/db/drizzle-client.ts');
      const handle = drizzleDbRef.current;
      const client = handle.$client ?? handle._?.client ?? handle.session?.client;
      const projectId = 'runner-prelaunch';
      await client.exec(
        "INSERT INTO projects (id, jid, name, folder, trigger, added_at, settings, is_main) " +
        "VALUES ('" + projectId + "', '" + projectId + "@web', 'Prelaunch', '" +
        projectId + "', '!', '2026-09-12T00:00:00.000Z', '{}', 0)"
      );
      const group = {
        folder: projectId, name: 'Prelaunch', trigger: '!',
        added_at: '2026-09-12T00:00:00.000Z', settings: {},
      };
      const overrides = {
        agent_cmd: 'codex',
        agentConfig: {
          id: 'codex', label: 'codex', harnessId: 'codex', harnessKind: 'cli',
          modelId: 'default', agentCmd: 'codex', sessionFamily: 'codex',
        },
      };
      const run = async (fail, started) => {
        const conversationId = (await db.createConversation(projectId)).id;
        groupDir.appendChatTranscriptEntry(projectId, conversationId, {
          id: 'ask-msg', type: 'message', role: 'user', content: 'hi',
          created_at: '2026-09-12T00:00:00.000Z',
        });
        runner.setContainerAgentRunnerForTests(async (_g, _i, onChunk) => {
          if (started) onChunk({ type: 'text', content: 'partial' });
          return { status: 'error', result: started ? 'partial' : null, error: fail, duration: 1 };
        });
        const result = await runner.runChatAgent(
          group, 'hi', projectId + '@web', undefined, null, false, conversationId, undefined, overrides,
        );
        const entries = groupDir.readChatTranscript(projectId, conversationId);
        const answer = await readAskAnswer({
          targetProjectId: projectId, targetConversationId: conversationId, askMessageId: 'ask-msg',
        });
        return { failed: result.failed, assistant: entries.filter((e) => e.role === 'assistant').length, answer };
      };
      const pre = await run(
        'Failed to launch agent: cwd missing token=sk-secret123 ' + 'x'.repeat(800),
        false,
      );
      const started = await run('Failed to launch agent: late', true);
      runner.setContainerAgentRunnerForTests(null);
      console.log('PRELAUNCH=' + JSON.stringify({ pre, started }));
      process.exit(0);
    `;
    try {
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        env: {
          CARAPA_DATA_DIR: dataDir,
          DATABASE_URL: '',
          DB_HOST: '',
          DB_PASSWORD: '',
          POSTGRES_PASSWORD: '',
          LOG_LEVEL: 'silent',
        },
        encoding: 'utf8',
        timeout: 90_000,
      });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout);
      }
      const marker = result.stdout
        .split('\n')
        .find((line) => line.startsWith('PRELAUNCH='));
      expect(marker).toBeDefined();
      const { pre, started } = JSON.parse(marker!.slice('PRELAUNCH='.length));
      expect(pre.failed).toBe(true);
      expect(pre.assistant).toBe(1);
      expect(pre.answer).toStartWith(
        '⚠️ **Sandbox Error**: The agent could not start: cwd missing',
      );
      expect(pre.answer).not.toContain('sk-secret123');
      expect(pre.answer.length).toBeLessThan(600);
      expect(started.failed).toBe(true);
      expect(started.assistant).toBe(0);
      expect(started.answer).toBe('');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 100_000);
});

describe('post-removal sandbox launch', () => {
  test('launches the real runner on the configured default checkout with canonical handoff context', () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-runner-removal-'),
    );
    const script = String.raw`
      import { mock } from 'bun:test';
      const root = process.cwd();
      let launch;
      const realMcpRunner = await import(root + '/src/mcp/mcp-runner.ts');
      mock.module(root + '/src/mcp/mcp-runner.ts', () => ({
        ...realMcpRunner,
        runContainerAgent: async (group, input) => {
          launch = { group, input };
          return {
            status: 'success',
            result: 'ok',
            duration: 1,
            newSessionId: 'fresh-runner-session',
          };
        },
      }));
      const db = await import(root + '/src/db.ts');
      const { runChatAgent } = await import(root + '/src/agent-runner.ts');
      await db.initDatabase(':memory:');
      const { drizzleDbRef } = await import(root + '/src/db/drizzle-client.ts');
      const handle = drizzleDbRef.current;
      const client = handle.$client ?? handle._?.client ?? handle.session?.client;
      const projectId = 'runner-post-removal';
      await client.exec(
        "INSERT INTO projects (id, jid, name, folder, trigger, added_at, settings, is_main) " +
        "VALUES ('" + projectId + "', '" + projectId + "@web', 'Runner removal', '" +
        projectId + "', '!', '2026-09-09T00:00:00.000Z', '{}', 0)",
      );
      const conversation = await db.createConversation(projectId, {
        use_worktree: true,
        branch_name: 'removed-runner-branch',
      });
      await db.updateConversationWorktreePath(
        conversation.id,
        '.worktrees/removed-runner-branch',
      );
      await db.saveChatMessage({
        group_folder: projectId,
        conversation_id: conversation.id,
        role: 'user',
        content: 'Canonical runner question.',
        source: 'web',
        created_at: '2026-09-09T00:00:01.000Z',
      });
      await db.saveChatMessage({
        group_folder: projectId,
        conversation_id: conversation.id,
        role: 'assistant',
        content: 'Canonical runner answer.',
        source: 'web',
        created_at: '2026-09-09T00:00:02.000Z',
      });
      await db.setConversationSessionId(
        conversation.id,
        'runner-family',
        'removed-runner-session',
      );
      await db.transitionConversationsFromRemovedWorktree(
        projectId,
        'removed-runner-branch',
        async () => undefined,
      );
      const before = await db.getChatMessages(projectId, 10, conversation.id);
      await runChatAgent(
        {
          folder: projectId,
          name: 'Runner removal',
          trigger: '!',
          added_at: '2026-09-09T00:00:00.000Z',
          settings: {
            repositoryLocation: '/configured/default-checkout',
            defaultBranch: 'develop',
          },
        },
        'Continue on the default checkout.',
        projectId + '@web',
        undefined,
        null,
        false,
        conversation.id,
        undefined,
        {
          agent_cmd: 'runner-cli',
          agentConfig: {
            id: 'runner-cli',
            label: 'Runner CLI',
            harnessId: 'codex',
            harnessKind: 'cli',
            modelId: 'default',
            agentCmd: 'runner-cli',
            sessionFamily: 'runner-family',
          },
        },
      );
      const after = await db.getChatMessages(projectId, 10, conversation.id);
      console.log('RUNNER_LAUNCH=' + JSON.stringify({ launch, before, after }));
      process.exit(0);
    `;
    try {
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CARAPA_DATA_DIR: dataDir,
          DATABASE_URL: '',
          DB_HOST: '',
          DB_PASSWORD: '',
          POSTGRES_PASSWORD: '',
        },
        encoding: 'utf8',
        timeout: 90_000,
      });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout);
      }
      const marker = result.stdout
        .split('\n')
        .find((line) => line.startsWith('RUNNER_LAUNCH='));
      expect(marker).toBeDefined();
      const captured = JSON.parse(marker!.slice('RUNNER_LAUNCH='.length));
      expect(captured.launch.group.settings.repositoryLocation).toBe(
        '/configured/default-checkout',
      );
      expect(captured.launch.input).not.toHaveProperty('branch_name');
      expect(captured.launch.input).not.toHaveProperty('worktree_path');
      expect(captured.launch.input).not.toHaveProperty('worktreeRequested');
      expect(captured.launch.input).not.toHaveProperty('localRepo');
      expect(captured.launch.input).not.toHaveProperty('session_id');
      expect(captured.launch.input.prompt).toContain(
        'Canonical runner question.',
      );
      expect(captured.launch.input.prompt).toContain(
        'Canonical runner answer.',
      );
      expect(captured.before).toHaveLength(2);
      expect(captured.after).toHaveLength(2);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 100_000);
});
