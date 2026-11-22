#!/usr/bin/env bun
import path from 'path';
import { GROUPS_DIR, STORE_DIR } from '../src/config.js';
import { runToolQualityAnalyzer } from '../src/modules/transcripts/tool-quality-analyzer.js';

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes('--help')) {
  console.log(`Usage: bun run analyze:tool-quality [options]

Options:
  --groups-dir PATH   Transcript groups root (default: configured GROUPS_DIR)
  --output-dir PATH   State, ledger, and reports root (default: store/tool-quality)
  --project IDS       Comma-separated project folder names
  --since YYYY-MM-DD  Include sources on or after this date
  --until YYYY-MM-DD  Include sources on or before this date
  --no-archives       Do not inspect transcript archive members
`);
  process.exit(0);
}

const outputDir = path.resolve(
  value('--output-dir') || path.join(STORE_DIR, 'tool-quality'),
);
const result = runToolQualityAnalyzer({
  groupsDir: path.resolve(value('--groups-dir') || GROUPS_DIR),
  statePath: path.join(outputDir, 'scan-state.json'),
  ledgerPath: path.join(outputDir, 'attempt-ledger.jsonl'),
  reportDir: path.join(outputDir, 'reports'),
  projects: value('--project')
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean),
  since: value('--since'),
  until: value('--until'),
  archives: !process.argv.includes('--no-archives'),
});

console.log(JSON.stringify(result, null, 2));
