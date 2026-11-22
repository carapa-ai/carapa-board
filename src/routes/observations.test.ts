import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  resolveObservationTranscriptPath,
  resolveObservationWorkspaceRoot,
} from './observations.js';

describe('observation reflector options', () => {
  it('durably admits a short authenticated transcript before processing it', () => {
    const dataRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-observation-route-reflector-'),
    );
    const script = String.raw`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { execFileSync } from 'node:child_process';

      const root = process.cwd();
      const project = 'observation-route-project';
      let requestCount = 0;
      const llm = Bun.serve({
        port: 0,
        fetch() {
          requestCount++;
          return new Response(
            'data: ' + JSON.stringify({
              choices: [{ delta: { content: 'REFLECTION_COMPLETE' } }],
            }) + '\n\n' + 'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });

      let http;
      try {
        const configDir = path.join(process.env.CARAPA_DATA_DIR, 'data');
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(
          path.join(configDir, 'board_agents.jsonc'),
          JSON.stringify({
            version: 2,
            connections: {
              probe: { baseUrl: 'http://127.0.0.1:' + llm.port + '/v1' },
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

        const express = (await import('express')).default;
        const db = await import(root + '/src/db.ts');
        const drizzle = await import(root + '/src/db/drizzle-client.ts');
        const schema = await import(root + '/src/db/schema.ts');
        const runtime = await import(root + '/src/lib/chat-agents.ts');
        const groupDir = await import(root + '/src/group-dir.ts');
        const state = await import(root + '/src/state-manager.ts');
        const observations = await import(root + '/src/routes/observations.ts');
        runtime.reloadChatAgents();
        await db.initDatabase(':memory:');
        await drizzle.drizzleDbRef.current.insert(schema.projects).values({
          id: project,
          jid: project + '@test',
          name: 'Observation route project',
          folder: project,
          trigger: '!',
          added_at: '2025-01-01T00:00:00.000Z',
          is_main: 0,
        });
        await state.loadState();

        const transcriptPath = path.join(
          groupDir.getGroupDir(project),
          'transcripts',
          'short-external.output.jsonl',
        );
        fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
        fs.writeFileSync(
          transcriptPath,
          JSON.stringify({
            type: 'message',
            id: 'external-erasure',
            role: 'user',
            content: 'Forget my private phone number.',
            created_at: '2025-02-01T10:00:00.000Z',
          }) + '\n',
        );

        const app = express();
        app.use(express.json());
        const viewer = await db.createUser('observation-viewer', 'pw');
        await db.upsertProjectMember(viewer.id, project, 'viewer');
        app.use((req, _res, next) => {
          if (req.headers['x-test-viewer']) {
            req.authUser = { id: viewer.id, role: 'user' };
          } else {
            req.tokenScope = { group_folder: project };
          }
          next();
        });
        app.use('/api', observations.default);
        http = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => http.once('listening', resolve));
        const address = http.address();
        assert.ok(address && typeof address === 'object');
        const url =
          'http://127.0.0.1:' + address.port +
          '/api/groups/' + project + '/extract-observations';
        const requestBody = JSON.stringify({
          transcriptPath: 'transcripts/short-external.output.jsonl',
        });
        const viewerResponse = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-test-viewer': '1' },
          body: requestBody,
        });
        assert.equal(viewerResponse.status, 403);
        assert.equal(requestCount, 0);
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: requestBody,
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.completed, true);
        assert.match(body.reflectorRunId, /^mrr-/);
        assert.equal(requestCount, 1);

        const post = (transcriptPath) =>
          fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ transcriptPath }),
          });
        const transcriptsDir = path.dirname(transcriptPath);
        const outside = path.join(process.env.CARAPA_DATA_DIR, 'outside.jsonl');
        fs.writeFileSync(outside, '{"type":"message","role":"user","content":"x"}\n');
        fs.symlinkSync(outside, path.join(transcriptsDir, 'link.jsonl'));
        assert.equal((await post('transcripts/link.jsonl')).status, 400);
        try {
          execFileSync('mkfifo', [path.join(transcriptsDir, 'fifo.jsonl')]);
          assert.equal((await post('transcripts/fifo.jsonl')).status, 400);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err; // mkfifo unavailable
        }
        assert.equal((await post('transcripts/missing.jsonl')).status, 404);
        assert.equal((await post('../outside.jsonl')).status, 400);
        assert.equal(requestCount, 1);

        const runs = await drizzle.drizzleDbRef.current
          .select()
          .from(schema.memoryReflectorRuns);
        assert.equal(runs.length, 1);
        assert.equal(runs[0].status, 'completed');
        assert.equal(runs[0].byteOffset, 0);
        console.log('OBSERVATION_ROUTE_SHORT_ADMISSION_OK');
      } finally {
        if (http) await new Promise((resolve) => http.close(resolve));
        llm.stop(true);
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
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
          },
          encoding: 'utf8',
          timeout: 90_000,
        },
      );
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || String(result.error));
      }
      expect(result.stdout).toContain('OBSERVATION_ROUTE_SHORT_ADMISSION_OK');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 100_000);
});

describe('resolveObservationWorkspaceRoot', () => {
  const groupDir = '/board/groups/demo-site';

  it('maps a Brain objective path without duplicating the project folder', () => {
    expect(
      resolveObservationWorkspaceRoot(
        '/workspace/group/demo-site/objectives/obj-123',
        'demo-site',
        groupDir,
      ),
    ).toBe('/board/groups/demo-site/objectives/obj-123');
  });

  it('maps a Brain path already relative to the project root', () => {
    expect(
      resolveObservationWorkspaceRoot(
        '/workspace/group/objectives/obj-123',
        'demo-site',
        groupDir,
      ),
    ).toBe('/board/groups/demo-site/objectives/obj-123');
  });

  it('rejects roots outside the requested project', () => {
    expect(
      resolveObservationWorkspaceRoot(
        '/workspace/group/../other-project',
        'demo-site',
        groupDir,
      ),
    ).toBeUndefined();
    expect(
      resolveObservationWorkspaceRoot(
        '/some/other/repository',
        'demo-site',
        groupDir,
      ),
    ).toBeUndefined();
    expect(
      resolveObservationWorkspaceRoot(
        '/board/groups/demo-site/../other',
        'demo-site',
        groupDir,
      ),
    ).toBeUndefined();
  });
});

describe('resolveObservationTranscriptPath', () => {
  const groupDir = '/board/groups/demo-site';

  it('maps the Brain form into the group', () => {
    expect(
      resolveObservationTranscriptPath(
        '/workspace/group/session-transcripts/run-1.jsonl',
        groupDir,
      ),
    ).toBe('/board/groups/demo-site/session-transcripts/run-1.jsonl');
    expect(
      resolveObservationTranscriptPath('transcripts/x.jsonl', groupDir),
    ).toBe('/board/groups/demo-site/transcripts/x.jsonl');
  });

  it('rejects traversal, relative escapes and the group directory itself', () => {
    expect(
      resolveObservationTranscriptPath(
        `${groupDir}/../other-project/transcripts/x.jsonl`,
        groupDir,
      ),
    ).toBeUndefined();
    expect(
      resolveObservationTranscriptPath('../other/x.jsonl', groupDir),
    ).toBeUndefined();
    expect(
      resolveObservationTranscriptPath(groupDir, groupDir),
    ).toBeUndefined();
  });
});
