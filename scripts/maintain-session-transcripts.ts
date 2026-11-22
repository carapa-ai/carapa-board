#!/usr/bin/env bun

import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { maintainSessionTranscripts } from '../src/modules/transcripts/session-transcript-maintenance.js';

const args = process.argv.slice(2);
const valueAfter = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const integerAfter = (flag: string, fallback: number): number => {
  const value = valueAfter(flag);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${flag} requires an integer`);
  return Number(value);
};

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: bun scripts/maintain-session-transcripts.ts [options]

Options:
  --apply                    Write archives and prune expired archives; default is dry-run
  --groups-dir <dir>         Groups root (default: configured GROUPS_DIR)
  --project <folder>         Restrict maintenance to one group path, including nested paths
  --archive-after-days <n>   Keep run bundles live for this many days (default: 7)
  --delete-after-days <n>    Delete verified archives this many days after creation (default: 30)
  --report <file>            Write the complete JSON report
  --help, -h                 Show this help

Run this command weekly. A run bundle is archived atomically as one unit; an
incomplete V1 events/manifest pair is reported and retained live.`);
  process.exit(0);
}

const groupsDir = path.resolve(valueAfter('--groups-dir') || GROUPS_DIR);
const project = valueAfter('--project');
const selectedRoot = project ? path.resolve(groupsDir, project) : groupsDir;
const relativeSelection = path.relative(groupsDir, selectedRoot);
if (relativeSelection.startsWith('..') || path.isAbsolute(relativeSelection)) {
  throw new Error('--project must resolve inside --groups-dir');
}
const apply = args.includes('--apply');
const lockPath = path.join(DATA_DIR, 'session-transcript-maintenance.lock');
let lockDescriptor: number | undefined;

function acquireApplyLock(): number {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      );
      return descriptor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let ownerIsRunning = true;
      try {
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
          pid?: unknown;
        };
        if (typeof owner.pid !== 'number') ownerIsRunning = false;
        else process.kill(owner.pid, 0);
      } catch (lockError) {
        ownerIsRunning = (lockError as NodeJS.ErrnoException).code === 'EPERM';
      }
      if (ownerIsRunning) {
        throw new Error(`maintenance is already running: ${lockPath}`);
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`could not acquire maintenance lock: ${lockPath}`);
}

try {
  if (apply) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    lockDescriptor = acquireApplyLock();
  }
  const result = maintainSessionTranscripts({
    groupsDir: selectedRoot,
    archiveAfterDays: integerAfter('--archive-after-days', 7),
    deleteAfterDays: integerAfter('--delete-after-days', 30),
    apply,
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  const reportPath = valueAfter('--report');
  if (reportPath) {
    const resolved = path.resolve(reportPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, output);
  }
  console.log(output);
  if (result.errors.length > 0) process.exitCode = 1;
} finally {
  if (lockDescriptor !== undefined) {
    fs.closeSync(lockDescriptor);
    fs.rmSync(lockPath, { force: true });
  }
}
