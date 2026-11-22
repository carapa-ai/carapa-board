import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('History Review preview deduplicates sequential tool writes before applying', () => {
  const dataRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'carapa-history-preview-boundary-'),
  );
  const script = String.raw`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';

    const root = process.cwd();
    const project = 'history-preview-boundary';
    const conversationId = 'history-preview-conversation';
    const messageId = 'history-preview-message';
    let objectiveId;
    const effectiveAt = '2025-02-01T10:00:00.000Z';
    const fact =
      'Production deploys run in Berlin, then move to Paris. Delete the obsolete launch-code memory.';
    const berlin = 'Production deploys run in Berlin';
    const paris = 'Production deploys run in Paris';
    const evidenceId = 'history:' + conversationId + ':' + messageId;
    const berlinEvidence = [
      { message_id: evidenceId, excerpt: 'Production deploys run in Berlin' },
    ];
    const parisEvidence = [
      { message_id: evidenceId, excerpt: 'move to Paris' },
    ];
    const forgetEvidence = [
      { message_id: evidenceId, excerpt: 'Delete the obsolete launch-code memory' },
    ];
    let requestCount = 0;
    let stagedBerlinId;
    let stagedBerlinVersion;
    let stagedParisId;
    let stagedParisVersion;
    let forgottenMemoryId;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const requestIndex = requestCount++;
        const index = Math.max(0, requestIndex - 1);
        const body = await request.json();
        if (requestIndex === 0) {
          assert.match(
            body.messages[0].content,
            /Source profile: DirectLLM conversation/,
          );
          assert.doesNotMatch(
            body.messages[0].content,
            /Source profile: CLI agent conversation/,
          );
          assert.match(
            body.messages
              .at(-1)
              .content.map((part) => part.text || '')
              .join(''),
            new RegExp('objective_id="' + objectiveId + '"'),
          );
        }
        const lastToolResult = body.messages
          .filter((message) => message.role === 'tool')
          .at(-1)?.content;
        if (requestIndex === 1) {
          assert.match(lastToolResult, /not verbatim/);
          assert.match(lastToolResult, /retry the same operation_key/);
        }
        let call;
        if (index === 0) {
          call = {
            name: 'memorize',
            args: {
              operation: 'create',
              content: berlin,
              memory_type: 'project',
              validFrom: effectiveAt,
              operation_key: 'create-a',
              evidence: requestIndex === 0
                ? [{ message_id: evidenceId, excerpt: 'invented quotation' }]
                : berlinEvidence,
            },
          };
        } else if (index === 1) {
          stagedBerlinId = lastToolResult.match(/mem-ref-[A-Za-z0-9_-]+/)[0];
          call = {
            name: 'recall',
            args: {
              query: 'Production deploys Berlin',
              objective_id: objectiveId,
              limit: 10,
            },
          };
        } else if (index === 2) {
          const recalled = JSON.parse(lastToolResult);
          stagedBerlinVersion = recalled.memories.find(
            (memory) => memory.id === stagedBerlinId,
          ).updated;
          call = {
            name: 'memorize',
            args: {
              operation: 'create',
              content: berlin,
              memory_type: 'project',
              objective_id: objectiveId,
              validFrom: effectiveAt,
              operation_key: 'create-b',
              evidence: berlinEvidence,
            },
          };
        } else if (index === 3) {
          assert.match(lastToolResult, /Duplicate detected/);
          call = {
            name: 'memorize',
            args: {
              operation: 'supersede',
              memory_id: stagedBerlinId,
              expected_version: stagedBerlinVersion,
              content: paris,
              memory_type: 'project',
              validFrom: '2025-02-02T10:00:00.000Z',
              operation_key: 'move-to-paris',
              evidence: parisEvidence,
            },
          };
        } else if (index === 4) {
          stagedParisId = [
            ...lastToolResult.matchAll(/mem-ref-[A-Za-z0-9_-]+/g),
          ].at(-1)[0];
          call = {
            name: 'recall',
            args: {
              query: 'Production deploys Paris',
              objective_id: objectiveId,
              limit: 10,
            },
          };
        } else if (index === 5) {
          const recalled = JSON.parse(lastToolResult);
          stagedParisVersion = recalled.memories.find(
            (memory) => memory.id === stagedParisId,
          ).updated;
          call = {
            name: 'memorize',
            args: {
              operation: 'invalidate',
              memory_id: stagedParisId,
              expected_version: stagedParisVersion,
              effectiveAt: '2025-02-03T10:00:00.000Z',
              operation_key: 'close-paris',
              evidence: parisEvidence,
            },
          };
        } else if (index === 6) {
          call = {
            name: 'recall',
            args: {
              query: 'Production deploys Paris',
              objective_id: objectiveId,
              limit: 10,
            },
          };
        } else if (index === 7) {
          assert.deepEqual(JSON.parse(lastToolResult).memories, []);
          call = {
            name: 'forget',
            args: {
              memory_id: forgottenMemoryId,
              operation_key: 'erase-launch-code',
              evidence: forgetEvidence,
            },
          };
        } else if (index === 8) {
          call = {
            name: 'recall',
            args: { query: 'obsolete launch code', limit: 10 },
          };
        } else if (index === 9) {
          assert.deepEqual(JSON.parse(lastToolResult).memories, []);
        }
        const delta = call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'preview-call-' + requestIndex,
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.args),
                  },
                },
              ],
            }
          : { content: 'REFLECTION_COMPLETE' };
        return new Response(
          'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n' +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });

    try {
      const configDir = path.join(process.env.CARAPA_DATA_DIR, 'data');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'board_agents.jsonc'),
        JSON.stringify({
          version: 2,
          connections: {
            probe: { baseUrl: 'http://127.0.0.1:' + server.port + '/v1' },
          },
          harnesses: { direct: { label: 'Direct', kind: 'direct' } },
          models: {
            probe: {
              label: 'Probe',
              bindings: { direct: { connection: 'probe' } },
            },
          },
          defaults: {
            chat: { harnessId: 'direct', modelId: 'probe' },
            kanban: {
              fallback: { harnessId: 'direct', modelId: 'probe' },
              stages: {},
            },
            reflector: { harnessId: 'direct', modelId: 'probe' },
          },
        }),
      );

      const db = await import(root + '/src/db.ts');
      const drizzle = await import(root + '/src/db/drizzle-client.ts');
      const schema = await import(root + '/src/db/schema.ts');
      const runtime = await import(root + '/src/lib/chat-agents.ts');
      const groupDir = await import(root + '/src/group-dir.ts');
      const history = await import(
        root + '/src/modules/memory/history-reflection.ts'
      );
      runtime.reloadChatAgents();
      await db.initDatabase(':memory:');
      await drizzle.drizzleDbRef.current.insert(schema.projects).values({
        id: project,
        jid: project + '@test',
        name: 'History Preview Boundary',
        folder: project,
        trigger: '!',
        added_at: '2025-01-01T00:00:00.000Z',
        is_main: 0,
      });
      objectiveId = (
        await db.createObjective({
          project_id: project,
          title: 'Scoped deployment',
          description: '',
          status: 'active',
          priority: 0,
          progress: 0,
        })
      ).id;
      await drizzle.drizzleDbRef.current.insert(schema.conversations).values({
        id: conversationId,
        group_folder: project,
        preview: fact,
        title: 'Deployment location',
        created_at: effectiveAt,
        objective_id: objectiveId,
      });
      const forgotten = await db.insertMemory({
        group_folder: project,
        content: 'The obsolete launch code is ALPHA',
        memory_type: 'project',
        source: 'agent',
        valid_from: '2024-01-01T00:00:00.000Z',
      });
      forgottenMemoryId = forgotten.id;
      const transcriptPath = groupDir.chatTranscriptPath(
        project,
        undefined,
        conversationId,
      );
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(
        transcriptPath,
        JSON.stringify({
          type: 'message',
          id: messageId,
          role: 'user',
          content: fact,
          created_at: effectiveAt,
        }) + '\n',
      );

      const manifest = await history.runHistoryReflectionPreview({
        projectId: project,
        cutoffAt: '2026-01-01T00:00:00.000Z',
        includeMemoryFiles: false,
      });
      assert.deepEqual(manifest.errors, []);
      assert.equal(requestCount, 11);
      assert.deepEqual(
        manifest.envelope.memory_ops.map((operation) => operation.op),
        ['create', 'supersede', 'invalidate', 'forget'],
      );
      assert.equal(manifest.envelope.memory_ops[0].objective_id, objectiveId);
      assert.equal(manifest.envelope.memory_ops[1].objective_id, objectiveId);
      assert.equal(manifest.conversations[0].candidates.length, 4);
      const liveBefore = await db.getMemoryTimeline(project);
      assert.equal(liveBefore.length, 1);
      assert.equal(liveBefore[0].id, forgottenMemoryId);
      assert.equal(liveBefore[0].valid_to, null);

      const applied = await history.applyHistoryReflectionManifest(manifest);
      assert.deepEqual(applied.applied, {
        created: 1,
        superseded: 1,
        invalidated: 1,
        forgotten: 1,
      });
      assert.equal(await db.getMemory(forgottenMemoryId), undefined);
      const berlinHistory = await db.searchMemories({
        groupFolders: [project],
        query: 'Berlin',
        objective_id: objectiveId,
        asOf: '2025-02-01T20:00:00.000Z',
        skipTouch: true,
      });
      const parisHistory = await db.searchMemories({
        groupFolders: [project],
        query: 'Paris',
        objective_id: objectiveId,
        asOf: '2025-02-02T20:00:00.000Z',
        skipTouch: true,
      });
      const current = await db.searchMemories({
        groupFolders: [project],
        skipTouch: true,
      });
      assert.equal(berlinHistory.length, 1);
      assert.equal(berlinHistory[0].content, berlin);
      assert.equal(berlinHistory[0].objective_id, objectiveId);
      assert.equal(parisHistory.length, 1);
      assert.equal(parisHistory[0].content, paris);
      assert.equal(parisHistory[0].objective_id, objectiveId);
      assert.deepEqual(current, []);
      console.log('HISTORY_PREVIEW_BOUNDARY_OK');
    } finally {
      server.stop(true);
    }
    process.exit(0);
  `;

  try {
    const result = spawnSync(
      process.execPath,
      ['--no-env-file', '-e', script],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          CARAPA_DATA_DIR: dataRoot,
          DATABASE_URL: '',
          DB_HOST: '',
          DB_PASSWORD: '',
          POSTGRES_PASSWORD: '',
          LOG_LEVEL: 'silent',
        },
        encoding: 'utf8',
        timeout: 90_000,
      },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || String(result.error));
    }
    expect(result.stdout).toContain('HISTORY_PREVIEW_BOUNDARY_OK');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}, 100_000);

test.each(['unconfirmed', 'turn-limit'] as const)(
  'History Review retains completed tool operations when a later chunk fails (%s)',
  (failureMode) => {
    const dataRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-history-preview-partial-boundary-'),
    );
    const script = String.raw`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';

    const root = process.cwd();
    const project = 'history-preview-partial-boundary';
    const failureMode = ${JSON.stringify(failureMode)};
    const conversationId = 'history-preview-partial-conversation';
    const firstMessageId = 'history-preview-first-message';
    const secondMessageId = 'history-preview-second-message';
    const evidenceId = 'history:' + conversationId + ':' + firstMessageId;
    const fact = 'Production releases require a signed manifest';
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        await request.json();
        const index = requestCount++;
        let delta;
        if (index === 0) {
          delta = {
            tool_calls: [
              {
                index: 0,
                id: 'partial-preview-create',
                function: {
                  name: 'memorize',
                  arguments: JSON.stringify({
                    operation: 'create',
                    content: fact,
                    memory_type: 'decision',
                    validFrom: '2025-02-01T10:00:00.000Z',
                    operation_key: 'signed-manifest-decision',
                    evidence: [
                      {
                        message_id: evidenceId,
                        excerpt: 'require a signed manifest',
                      },
                    ],
                  }),
                },
              },
            ],
          };
        } else if (index === 1) {
          delta = { content: 'REFLECTION_COMPLETE' };
        } else if (index === 2 || failureMode === 'turn-limit') {
          delta = {
            tool_calls: [{
              index: 0,
              id: 'partial-preview-invalid',
              function: {
                name: 'memorize',
                arguments: JSON.stringify({
                  operation: 'create',
                  content: 'A proposal missing its evidence timestamp',
                  memory_type: 'decision',
                }),
              },
            }],
          };
        } else {
          delta = { content: 'Unable to complete this chunk' };
        }
        return new Response(
          'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n' +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });

    try {
      const configDir = path.join(process.env.CARAPA_DATA_DIR, 'data');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'board_agents.jsonc'),
        JSON.stringify({
          version: 2,
          connections: {
            probe: { baseUrl: 'http://127.0.0.1:' + server.port + '/v1' },
          },
          harnesses: { direct: { label: 'Direct', kind: 'direct' } },
          models: {
            probe: {
              label: 'Probe',
              bindings: { direct: { connection: 'probe' } },
            },
          },
          defaults: {
            chat: { harnessId: 'direct', modelId: 'probe' },
            kanban: {
              fallback: { harnessId: 'direct', modelId: 'probe' },
              stages: {},
            },
            reflector: { harnessId: 'direct', modelId: 'probe' },
          },
        }),
      );

      const db = await import(root + '/src/db.ts');
      const drizzle = await import(root + '/src/db/drizzle-client.ts');
      const schema = await import(root + '/src/db/schema.ts');
      const runtime = await import(root + '/src/lib/chat-agents.ts');
      const groupDir = await import(root + '/src/group-dir.ts');
      const history = await import(
        root + '/src/modules/memory/history-reflection.ts'
      );
      runtime.reloadChatAgents();
      await db.initDatabase(':memory:');
      await drizzle.drizzleDbRef.current.insert(schema.projects).values({
        id: project,
        jid: project + '@test',
        name: 'History Preview Partial Boundary',
        folder: project,
        trigger: '!',
        added_at: '2025-01-01T00:00:00.000Z',
        is_main: 0,
      });
      await drizzle.drizzleDbRef.current.insert(schema.conversations).values({
        id: conversationId,
        group_folder: project,
        preview: fact,
        title: 'Release manifests',
        created_at: '2025-02-01T10:00:00.000Z',
      });
      const transcriptPath = groupDir.chatTranscriptPath(
        project,
        undefined,
        conversationId,
      );
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(
        transcriptPath,
        [
          {
            type: 'message',
            id: firstMessageId,
            role: 'user',
            content: fact,
            created_at: '2025-02-01T10:00:00.000Z',
          },
          {
            type: 'message',
            id: secondMessageId,
            role: 'user',
            content: 'This later chunk cannot be completed.',
            created_at: '2025-02-02T10:00:00.000Z',
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n') + '\n',
      );

      const manifest = await history.runHistoryReflectionPreview({
        projectId: project,
        cutoffAt: '2026-01-01T00:00:00.000Z',
        includeMemoryFiles: false,
      });
      assert.equal(requestCount, failureMode === 'turn-limit' ? 22 : 4);
      assert.deepEqual(
        manifest.envelope.memory_ops.map((operation) => operation.op),
        ['create'],
      );
      assert.equal(manifest.conversations[0].candidates.length, 1);
      assert.match(manifest.errors.join(' '), /did not complete/);
      assert.match(
        manifest.errors.join(' '),
        /memorize: evidence must contain at least one/,
      );
      assert.match(manifest.errors.join(' '), /chunk 2\/2/);
      if (failureMode === 'turn-limit') {
        assert.match(manifest.errors.join(' '), /exhausted its 20 model-turn limit/);
      }
      assert.deepEqual(await db.getMemoryTimeline(project), []);

      const finalized = history.finalizePartialHistoryReflectionManifest(
        manifest,
        [],
        '2026-01-02T00:00:00.000Z',
      );
      const applied = await history.applyHistoryReflectionManifest(finalized);
      assert.equal(applied.applied.created, 1);
      const memories = await db.getMemoryTimeline(project);
      assert.equal(memories.length, 1);
      assert.equal(memories[0].content, fact);
      console.log('HISTORY_PREVIEW_PARTIAL_BOUNDARY_OK');
    } finally {
      server.stop(true);
    }
    process.exit(0);
  `;

    try {
      const result = spawnSync(
        process.execPath,
        ['--no-env-file', '-e', script],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            CARAPA_DATA_DIR: dataRoot,
            DATABASE_URL: '',
            DB_HOST: '',
            DB_PASSWORD: '',
            POSTGRES_PASSWORD: '',
            LOG_LEVEL: 'silent',
          },
          encoding: 'utf8',
          timeout: 90_000,
        },
      );
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || String(result.error));
      }
      expect(result.stdout).toContain('HISTORY_PREVIEW_PARTIAL_BOUNDARY_OK');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  },
  100_000,
);
