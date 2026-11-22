import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectAgentRunning, invalidateRunningCache } from './objectives.js';

let groupDir: string;
let objectiveDir: string;

const writeJsonl = (name: string, rows: unknown[]) =>
  fs.writeFileSync(
    path.join(objectiveDir, name),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );

const invoked = (payload: Record<string, unknown>, ageMs = 0) => ({
  type: 'agent_invoked',
  timestamp: new Date(Date.now() - ageMs).toISOString(),
  payload,
});

beforeAll(() => {
  groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-running-'));
  objectiveDir = path.join(groupDir, 'objectives', 'obj-1');
  fs.mkdirSync(objectiveDir, { recursive: true });
});

beforeEach(() => {
  invalidateRunningCache();
  fs.rmSync(path.join(objectiveDir, 'run-stats.jsonl'), { force: true });
});

afterAll(() => {
  fs.rmSync(groupDir, { recursive: true, force: true });
});

describe('detectAgentRunning', () => {
  test('brain run_id without a run-stats row is running', async () => {
    writeJsonl('events.jsonl', [invoked({ run_id: 'run-x' })]);
    expect(await detectAgentRunning(objectiveDir)).toBe(true);
  });

  test('a matching run-stats row means the run completed', async () => {
    writeJsonl('events.jsonl', [invoked({ run_id: 'run-x' })]);
    writeJsonl('run-stats.jsonl', [{ runId: 'run-x' }]);
    expect(await detectAgentRunning(objectiveDir)).toBe(false);
  });

  test('an invocation older than 30 minutes is stale', async () => {
    writeJsonl('events.jsonl', [invoked({ run_id: 'run-x' }, 31 * 60 * 1000)]);
    expect(await detectAgentRunning(objectiveDir)).toBe(false);
  });
});
