import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GROUPS_DIR } from '../config.js';
import { ipcRoot } from '../lib/ipc-fs.js';
import { cleanupRunDir, persistPerRunTranscript } from './process.js';

describe('persistPerRunTranscript', () => {
  test('copies raw-provider and runtime V1 run artifacts, never output.jsonl', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-run-transcript-'),
    );
    const runDir = path.join(root, 'ipc', 'runs', 'run-test');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'repair prompt');
    const systemPrompt = 'Review rules.\n\nKeep exact wording.\n';
    fs.writeFileSync(path.join(runDir, 'system-prompt.txt'), systemPrompt);
    fs.writeFileSync(
      path.join(runDir, 'output.jsonl'),
      '{"type":"turn.started"}\n',
    );
    const rawAcp =
      ' { "jsonrpc": "2.0", "method": "session/update", "params": {} } \n';
    const rawCodex =
      ' { "method": "item/completed", "params": { "item": {} } } \n';
    const rawPi =
      ' { "type": "message_update", "assistantMessageEvent": {} } \n';
    const v1Events =
      '{"type":"run","status":"started"}\n{"type":"run","status":"completed"}\n';
    const v1Manifest =
      '{"format":"carapa-run","version":1,"harness":"pi","requestedModel":"gpt-test"}\n';
    fs.writeFileSync(path.join(runDir, 'acp.raw.jsonl'), rawAcp);
    fs.writeFileSync(path.join(runDir, 'codex.raw.jsonl'), rawCodex);
    fs.writeFileSync(path.join(runDir, 'pi.raw.jsonl'), rawPi);
    fs.writeFileSync(path.join(runDir, 'output.v1.jsonl'), v1Events);
    fs.writeFileSync(path.join(runDir, 'output.v1.meta.json'), v1Manifest);
    const groupDir = path.join(root, 'groups', 'project');

    expect(
      persistPerRunTranscript('project', 'run-test', runDir, groupDir),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          root,
          'groups',
          'project',
          'session-transcripts',
          'run-test.jsonl',
        ),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(
          root,
          'groups',
          'project',
          'session-transcripts',
          'run-test.prompt.txt',
        ),
        'utf8',
      ),
    ).toBe('repair prompt');
    expect(
      fs.readFileSync(
        path.join(
          root,
          'groups',
          'project',
          'session-transcripts',
          'run-test.system.txt',
        ),
        'utf8',
      ),
    ).toBe(systemPrompt);
    expect(
      fs.readFileSync(
        path.join(
          root,
          'groups',
          'project',
          'session-transcripts',
          'run-test.acp.raw.jsonl',
        ),
        'utf8',
      ),
    ).toBe(rawAcp);
    expect(
      fs.readFileSync(
        path.join(
          root,
          'groups',
          'project',
          'session-transcripts',
          'run-test.codex.raw.jsonl',
        ),
        'utf8',
      ),
    ).toBe(rawCodex);
    expect(
      fs.readFileSync(
        path.join(
          root,
          'groups',
          'project',
          'session-transcripts',
          'run-test.pi.raw.jsonl',
        ),
        'utf8',
      ),
    ).toBe(rawPi);
    expect(
      fs.readFileSync(
        path.join(
          root,
          'groups',
          'project',
          'session-transcripts',
          'run-test.v1.jsonl',
        ),
        'utf8',
      ),
    ).toBe(v1Events);
    expect(
      fs.readFileSync(
        path.join(
          root,
          'groups',
          'project',
          'session-transcripts',
          'run-test.v1.meta.json',
        ),
        'utf8',
      ),
    ).toBe(v1Manifest);

    expect(
      persistPerRunTranscript('project', 'run-test', runDir, groupDir),
    ).toBe(true);
  });

  test('refuses run artifacts that are symlinks to other files', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-run-transcript-'),
    );
    const secret = path.join(root, 'secret.txt');
    fs.writeFileSync(secret, '{"secret":true}\n');
    const groupDir = path.join(root, 'groups', 'project');

    const linkedPrompt = path.join(root, 'run-linked-prompt');
    fs.mkdirSync(linkedPrompt, { recursive: true });
    fs.symlinkSync(secret, path.join(linkedPrompt, 'prompt.txt'));
    expect(
      persistPerRunTranscript(
        'project',
        'run-linked-prompt',
        linkedPrompt,
        groupDir,
      ),
    ).toBe(false);

    const linkedSystemPrompt = path.join(root, 'run-linked-system-prompt');
    fs.mkdirSync(linkedSystemPrompt, { recursive: true });
    fs.symlinkSync(secret, path.join(linkedSystemPrompt, 'system-prompt.txt'));
    expect(
      persistPerRunTranscript(
        'project',
        'run-linked-system-prompt',
        linkedSystemPrompt,
        groupDir,
      ),
    ).toBe(false);

    const transcriptDir = path.join(groupDir, 'session-transcripts');
    expect(
      fs
        .readdirSync(transcriptDir)
        .filter((name) => name.endsWith('.jsonl') || name.endsWith('.txt')),
    ).toEqual([]);
  });

  test('treats a run dir with no preservable artifacts as a success', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-run-transcript-'),
    );
    const runDir = path.join(root, 'run-empty');
    fs.mkdirSync(runDir, { recursive: true });
    // Only launch metadata — no prompt.txt, no output.
    fs.writeFileSync(path.join(runDir, 'args.json'), '{}');
    const groupDir = path.join(root, 'groups', 'project');

    expect(
      persistPerRunTranscript('project', 'run-empty', runDir, groupDir),
    ).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'session-transcripts'))).toBe(
      false,
    );
  });
});

describe('run cleanup transcript durability', () => {
  test('keeps ordinary IPC artifacts when raw capture preservation fails', async () => {
    const suffix = `${process.pid}-${Date.now()}-acp-copy-failure`;
    const groupFolder = `chat-cleanup-${suffix}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-acp-run-'));
    const runDir = path.join(root, `run-${suffix}`);
    const target = path.join(root, 'chat-conv-acp.output.jsonl');
    const groupDir = path.join(GROUPS_DIR, groupFolder);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'must survive');
    fs.writeFileSync(
      path.join(runDir, 'acp.raw.jsonl'),
      '{"jsonrpc":"2.0","method":"session/update"}\n',
    );
    fs.writeFileSync(
      path.join(runDir, 'codex.raw.jsonl'),
      '{"method":"item/completed","params":{}}\n',
    );
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'session-transcripts'), 'blocked');

    try {
      await cleanupRunDir(
        runDir,
        target,
        groupFolder,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        'omp:gpt-test',
        undefined,
        undefined,
        true,
        false,
      );
      expect(fs.existsSync(runDir)).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'acp.raw.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'codex.raw.jsonl'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  test('keeps Pi IPC artifacts when the runtime V1 pair is incomplete', async () => {
    const suffix = `${process.pid}-${Date.now()}-pi-v1-incomplete`;
    const groupFolder = `scheduled-cleanup-${suffix}`;
    // The harness lookup reads args.json through the pinned IPC reader, which
    // only opens run directories below the IPC root.
    fs.mkdirSync(ipcRoot(), { recursive: true });
    const root = fs.mkdtempSync(path.join(ipcRoot(), 'scheduled-run-'));
    const runDir = path.join(root, `run-${suffix}`);
    const target = path.join(root, 'chat-conv-pi-refusal.output.jsonl');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'must survive');
    fs.writeFileSync(
      path.join(runDir, 'args.json'),
      JSON.stringify({
        agentCmd: 'pi',
        conversationId: 'conv-pi-refusal',
      }),
    );
    // An event spool without its manifest cannot be repaired (a manifest-only
    // pair is completed by ensureCarapaRunV1Terminal instead).
    fs.writeFileSync(
      path.join(runDir, 'output.v1.jsonl'),
      `${JSON.stringify({ type: 'run', status: 'started' })}\n`,
    );

    try {
      await cleanupRunDir(
        runDir,
        target,
        groupFolder,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        'pi',
        undefined,
        undefined,
        true,
        false,
      );
      expect(fs.existsSync(runDir)).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'output.v1.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'output.v1.meta.json'))).toBe(
        false,
      );
      // A present-but-invalid V1 artifact is an explicit canonical failure.
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, groupFolder), {
        recursive: true,
        force: true,
      });
    }
  });

  test('keeps IPC artifacts when scheduled transcript preservation fails', async () => {
    const suffix = `${process.pid}-${Date.now()}-copy-failure`;
    const groupFolder = `scheduled-cleanup-${suffix}`;
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-scheduled-run-'),
    );
    const runDir = path.join(root, `run-${suffix}`);
    const groupDir = path.join(GROUPS_DIR, groupFolder);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'must survive');
    fs.mkdirSync(groupDir, { recursive: true });
    // A file at the target-directory path deterministically makes mkdir/copy fail.
    fs.writeFileSync(path.join(groupDir, 'session-transcripts'), 'blocked');

    try {
      await cleanupRunDir(
        runDir,
        undefined,
        groupFolder,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
      );
      expect(fs.existsSync(runDir)).toBe(true);
      expect(fs.readFileSync(path.join(runDir, 'prompt.txt'), 'utf8')).toBe(
        'must survive',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  test.each(['success'])(
    '%s runs preserve artifacts before deleting IPC',
    async (outcome) => {
      const suffix = `${process.pid}-${Date.now()}-${outcome}`;
      const groupFolder = `scheduled-cleanup-${suffix}`;
      const runId = `run-${suffix}`;
      fs.mkdirSync(ipcRoot(), { recursive: true });
      const root = fs.mkdtempSync(path.join(ipcRoot(), 'scheduled-run-'));
      const runDir = path.join(root, 'runs', runId);
      const transcriptDir = path.join(
        GROUPS_DIR,
        groupFolder,
        'session-transcripts',
      );
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'prompt.txt'), `${outcome} prompt`);
      fs.writeFileSync(
        path.join(runDir, 'output.v1.meta.json'),
        '{"format":"carapa-run","version":1,"harness":"pi","requestedModel":null}\n',
      );
      fs.writeFileSync(
        path.join(runDir, 'output.v1.jsonl'),
        `${JSON.stringify({ type: 'run', status: 'started' })}\n${JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', content: outcome, status: 'completed' })}\n${JSON.stringify({ type: 'run', status: 'completed' })}\n`,
      );

      try {
        await cleanupRunDir(
          runDir,
          undefined,
          groupFolder,
          undefined,
          undefined,
          true,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          true,
        );

        expect(fs.existsSync(runDir)).toBe(false);
        expect(
          fs.readFileSync(
            path.join(transcriptDir, `${runId}.prompt.txt`),
            'utf8',
          ),
        ).toBe(`${outcome} prompt`);
        expect(
          fs.readFileSync(
            path.join(transcriptDir, `${runId}.v1.jsonl`),
            'utf8',
          ),
        ).toContain(outcome);
        expect(fs.existsSync(path.join(transcriptDir, `${runId}.jsonl`))).toBe(
          false,
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(path.join(GROUPS_DIR, groupFolder), {
          recursive: true,
          force: true,
        });
      }
    },
  );
});
