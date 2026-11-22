import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildToolQualityReport,
  classifyToolAttempt,
  readAttemptLedger,
  runToolQualityAnalyzer,
} from './tool-quality-analyzer.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-quality-'));
const groupsDir = path.join(root, 'groups');
const outputDir = path.join(root, 'output');
const transcriptDir = path.join(groupsDir, 'project-a', 'transcripts');
const statePath = path.join(outputDir, 'state.json');
const ledgerPath = path.join(outputDir, 'ledger.jsonl');
const reportDir = path.join(outputDir, 'reports');

function jsonl(events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}

function run() {
  return runToolQualityAnalyzer({
    groupsDir,
    statePath,
    ledgerPath,
    reportDir,
  });
}

beforeAll(() => fs.mkdirSync(transcriptDir, { recursive: true }));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('tool quality classification', () => {
  test('keeps code failures and infrastructure failures out of agent faults', () => {
    expect(
      classifyToolAttempt('Bash', { command: 'bun test' }, { exit_code: 1 })
        .outcome,
    ).toBe('code_failure');
    expect(
      classifyToolAttempt(
        'Bash',
        { command: 'bun test' },
        { exit_code: 1, output: 'Error: invalid input in application test' },
        true,
      ).outcome,
    ).toBe('code_failure');
    expect(
      classifyToolAttempt(
        'Bash',
        { command: 'printf "invalid input"' },
        undefined,
      ).outcome,
    ).toBe('unknown');
    expect(
      classifyToolAttempt('Bash', { command: 'bun test' }, 'Exited with code 2')
        .outcome,
    ).toBe('code_failure');
    expect(
      classifyToolAttempt(
        'run_shell_command',
        { command: 'bun test' },
        'Command exited with code 1',
      ).outcome,
    ).toBe('code_failure');
    expect(
      classifyToolAttempt(
        'RUN_SHELL_COMMAND',
        { command: 'bun test' },
        { exitCode: 1, output: 'tests failed' },
        true,
      ).agentAttributable,
    ).toBe(false);
    expect(
      classifyToolAttempt('fetch', {}, 'Error: service unavailable', true)
        .outcome,
    ).toBe('transport_failure');
    for (const successfulContent of [
      'service unavailable is the expected fixture text',
      'unknown tool is mentioned in this README',
      'Error: is a heading in the file',
    ])
      expect(
        classifyToolAttempt('Read', { path: 'fixture.txt' }, successfulContent)
          .outcome,
      ).toBe('success');
    expect(
      classifyToolAttempt(
        'Bash',
        { command: 'curl http://service' },
        { exit_code: 7, output: 'connection refused' },
        true,
      ).outcome,
    ).toBe('transport_failure');
    expect(
      classifyToolAttempt(
        'Bash',
        { command: 'run adapter' },
        { exit_code: 1, output: 'adapter dispatch unavailable' },
        true,
      ).outcome,
    ).toBe('harness_error');
    expect(
      classifyToolAttempt('missing', {}, 'unknown tool', true)
        .agentAttributable,
    ).toBe(true);
  });
});

describe('resumable mixed-harness analysis', () => {
  test('normalizes all supported harnesses and preserves available model identities', () => {
    fs.writeFileSync(
      path.join(transcriptDir, '2026-07-22-chat-mixed.jsonl'),
      jsonl([
        {
          entry_type: 'run_start',
          run_id: 'claude-run',
          agent_name: 'claude',
          model_name: 'claude-sonnet-4',
        },
        {
          type: 'assistant',
          agent_name: 'claude',
          message: {
            model: 'claude-sonnet-4-20260601',
            content: [
              {
                type: 'tool_use',
                id: 'claude-1',
                name: 'Read',
                input: { file_path: 'a.ts' },
              },
            ],
          },
        },
        {
          type: 'user',
          agent_name: 'claude',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'claude-1',
                content: 'contents',
              },
            ],
          },
        },
        {
          type: 'item.completed',
          agent_name: 'codex',
          model_name: 'gpt-5-codex',
          item: {
            id: 'codex-1',
            type: 'command_execution',
            command: 'bun test',
            exit_code: 1,
            aggregated_output: 'tests failed',
          },
        },
        {
          type: 'tool_use',
          agent_name: 'gemini',
          model: 'gemini-2.5-pro',
          tool_name: 'search',
          id: 'gemini-1',
          parameters: { q: 'x' },
          result: 'found',
        },
        {
          type: 'tool_use',
          agent_name: 'opencode',
          model_name: 'qwen3',
          part: {
            type: 'tool',
            id: 'open-1',
            tool: 'write',
            state: { status: 'completed', input: { path: 'x' }, output: 'ok' },
          },
        },
        {
          type: 'tool_call',
          subtype: 'completed',
          agent_name: 'cursor',
          model: 'cursor-auto',
          call_id: 'cursor-1',
          tool_call: {
            readToolCall: {
              args: { path: 'x' },
              result: { success: { content: 'ok' } },
            },
          },
        },
        {
          type: 'tool_call',
          subtype: 'completed',
          agent_name: 'cursor',
          model: 'cursor-auto',
          call_id: 'cursor-error',
          tool_call: {
            readToolCall: {
              args: { path: 'missing' },
              result: { error: { errorMessage: 'permission denied' } },
            },
          },
        },
        {
          type: 'agent_end',
          agent_name: 'pi',
          model: 'pi-model',
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'toolCall',
                  id: 'pi-1',
                  name: 'read',
                  arguments: { path: 'x' },
                },
              ],
            },
            {
              role: 'tool',
              content: [
                { type: 'toolResult', toolCallId: 'pi-1', content: 'ok' },
              ],
            },
          ],
        },
        {
          type: 'tool_use',
          agent_name: 'llm:direct:qwen-3.6',
          part: {
            type: 'tool',
            id: 'direct-qwen',
            tool: 'search',
            state: { status: 'completed', input: { q: 'x' }, output: 'ok' },
          },
        },
        {
          type: 'tool_use',
          agent_name: 'llm:direct:gemma4',
          part: {
            type: 'tool',
            id: 'direct-gemma',
            tool: 'search',
            state: {
              status: 'completed',
              input: { q: 'y' },
              output: 'Error: invalid parameter q',
            },
          },
        },
        {
          type: 'assistant',
          agent_name: 'llm:direct:qwen-3.6',
          message: {
            tool_calls: [
              {
                id: 'direct-malformed',
                function: { name: 'write', arguments: '{bad json' },
              },
            ],
          },
        },
      ]),
    );

    const first = run();
    expect(first.activeAttempts).toBe(10);
    const attempts = [...readAttemptLedger(ledgerPath).values()];
    expect(new Set(attempts.map((item) => item.harness))).toEqual(
      new Set([
        'claude',
        'codex',
        'gemini',
        'opencode',
        'cursor',
        'pi',
        'direct',
      ]),
    );
    expect(
      attempts.find((item) => item.harness === 'claude')?.configuredModel,
    ).toBe('claude-sonnet-4');
    expect(
      attempts.find((item) => item.harness === 'claude')?.reportedModel,
    ).toBe('claude-sonnet-4-20260601');
    expect(attempts.find((item) => item.harness === 'codex')?.outcome).toBe(
      'code_failure',
    );
    expect(
      attempts.find((item) => item.eventIdentity.includes('cursor-error'))
        ?.outcome,
    ).toBe('tool_execution_error');

    const report = buildToolQualityReport(readAttemptLedger(ledgerPath)) as any;
    expect(report.byHarnessModel['direct/qwen-3.6'].totalAttempts).toBe(2);
    expect(report.byHarnessModel['direct/gemma4'].agentFaultRate).toBe(1);
    expect(report.byHarness.codex.totalAttempts).toBe(1);
    expect(fs.existsSync(path.join(reportDir, 'summary.md'))).toBe(true);

    const second = run();
    expect(second.linesProcessed).toBe(0);
    expect(second.ledgerRecordsAdded).toBe(0);
  });

  test('processes only appended lines and pairs a resumed result', () => {
    const file = path.join(transcriptDir, '2026-07-22-chat-resumed.jsonl');
    fs.writeFileSync(
      file,
      jsonl([
        {
          type: 'tool_use',
          agent_name: 'llm:direct:model-a',
          part: {
            type: 'tool',
            id: 'resume-1',
            tool: 'fetch',
            state: { status: 'running', input: { url: 'x' } },
          },
        },
      ]),
    );
    const first = run();
    expect(first.linesProcessed).toBe(1);
    expect(
      [...readAttemptLedger(ledgerPath).values()].find((item) =>
        item.eventIdentity.includes('resume-1'),
      )?.outcome,
    ).toBe('unknown');

    fs.appendFileSync(
      file,
      jsonl([
        {
          type: 'tool_use',
          agent_name: 'llm:direct:model-a',
          part: {
            type: 'tool',
            id: 'resume-1',
            tool: 'fetch',
            state: { status: 'completed', input: { url: 'x' }, output: 'ok' },
          },
        },
      ]),
    );
    const resumed = run();
    expect(resumed.linesProcessed).toBe(1);
    expect(
      [...readAttemptLedger(ledgerPath).values()].find((item) =>
        item.eventIdentity.includes('resume-1'),
      )?.outcome,
    ).toBe('success');
  });

  test('rescans rewrites safely and deduplicates an archived copy', () => {
    const file = path.join(transcriptDir, '2026-07-22-chat-rotation.jsonl');
    const original = jsonl([
      {
        type: 'tool_use',
        agent_name: 'llm:direct:model-r',
        part: {
          type: 'tool',
          id: 'rotate-1',
          tool: 'read',
          state: { status: 'completed', input: { path: 'x' }, output: 'ok' },
        },
      },
    ]);
    fs.writeFileSync(file, original);
    run();
    const before = readAttemptLedger(ledgerPath).size;

    const archiveDir = path.join(transcriptDir, 'archive');
    const staging = path.join(root, 'archive-stage');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, path.basename(file)), original);
    execFileSync('tar', [
      '-czf',
      path.join(archiveDir, '2026-07-22.tar.gz'),
      '-C',
      staging,
      path.basename(file),
    ]);
    const archived = run();
    expect(archived.activeAttempts).toBe(before);

    fs.writeFileSync(
      file,
      jsonl([
        {
          type: 'tool_use',
          agent_name: 'llm:direct:model-r',
          part: {
            type: 'tool',
            id: 'rotate-2',
            tool: 'read',
            state: { status: 'completed', input: { path: 'y' }, output: 'ok' },
          },
        },
      ]),
    );
    const rewritten = run();
    expect(rewritten.linesProcessed).toBeGreaterThan(0);
    const ids = [...readAttemptLedger(ledgerPath).values()].map(
      (item) => item.eventIdentity,
    );
    expect(ids.some((id) => id.includes('rotate-1'))).toBe(true); // archive still owns it
    expect(ids.some((id) => id.includes('rotate-2'))).toBe(true);
  });
});
