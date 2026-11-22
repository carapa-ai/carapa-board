#!/usr/bin/env bun

import path from 'path';
import { initDatabase } from '../src/db.js';
import { setGroupLookup } from '../src/group-dir.js';
import { getGroupByFolder, loadState } from '../src/state-manager.js';
import {
  applyHistoryReflectionManifest,
  assertHistoryProjectExists,
  defaultHistoryManifestPath,
  readHistoryManifest,
  refreshAppliedManifest,
  runHistoryReflectionPreview,
  writeHistoryManifest,
} from '../src/modules/memory/history-reflection.js';

function usage(): never {
  console.log(`reflect-conversation-history

Generate a high-precision, time-aware memory preview from conversations and
recovered .agent/memories files in one CarapaBoard project. Preview is the
default; applying always consumes an already-reviewed manifest and never calls
the LLM again.

Preview:
  bun scripts/reflect-conversation-history.ts --project <id> [options]

Apply:
  bun scripts/reflect-conversation-history.ts --apply <manifest> [--project <id>]

Options:
  --project <id>             Project/group folder
  --since <date>             Sources dated on or after this date
  --until <date>             Sources dated on or before this date
  --resume <manifest>        Reuse unchanged per-source candidate results
  --output <manifest>        Preview output path (default: project artifacts)
  --conversations-only       Exclude recovered memory files
  --memory-files-only        Exclude conversations
  --observer-agent <id>      Candidate-extraction runtime override
  --reflector-agent <id>     History-reflector runtime override
  --chunk-tokens <number>    Candidate chunk budget (default: 5000)
  --batch-size <number>      Candidates per reflection call (default: 30)
  --apply <manifest>         Apply this exact reviewed preview
  --help, -h                 Show this help`);
  process.exit(0);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) usage();

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`${flag} requires a value`);
  return value;
}

function dateBoundary(
  value: string | undefined,
  endOfDay = false,
): string | undefined {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = Date.parse(
    dateOnly
      ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
      : value,
  );
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date: ${value}`);
  return new Date(parsed).toISOString();
}

function positiveInteger(
  value: string | undefined,
  flag: string,
): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

await initDatabase();
await loadState();
setGroupLookup((folder) => getGroupByFolder(folder));

const applyPath = valueAfter('--apply');
const requestedProject = valueAfter('--project');

if (applyPath) {
  const resolved = path.resolve(applyPath);
  const manifest = readHistoryManifest(resolved);
  if (requestedProject && requestedProject !== manifest.project_id) {
    throw new Error(
      `Manifest project "${manifest.project_id}" does not match --project "${requestedProject}"`,
    );
  }
  const result = await applyHistoryReflectionManifest(manifest);
  await refreshAppliedManifest(resolved, manifest);
  console.log(
    JSON.stringify(
      {
        mode: 'apply',
        manifest: resolved,
        project: manifest.project_id,
        ...result,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (!requestedProject) {
  throw new Error('--project is required for preview');
}
await assertHistoryProjectExists(requestedProject);

const resumePath = valueAfter('--resume');
const priorManifest = resumePath ? readHistoryManifest(resumePath) : undefined;
if (priorManifest && priorManifest.project_id !== requestedProject) {
  throw new Error(
    `Resume manifest project "${priorManifest.project_id}" does not match "${requestedProject}"`,
  );
}

const since = dateBoundary(valueAfter('--since'));
const until = dateBoundary(valueAfter('--until'), true);
if (since && until && since > until)
  throw new Error('--since must not be after --until');
const conversationsOnly = args.includes('--conversations-only');
const memoryFilesOnly = args.includes('--memory-files-only');
if (conversationsOnly && memoryFilesOnly) {
  throw new Error(
    '--conversations-only and --memory-files-only are mutually exclusive',
  );
}

const manifest = await runHistoryReflectionPreview({
  projectId: requestedProject,
  since,
  until,
  priorManifest,
  observerAgentId: valueAfter('--observer-agent'),
  reflectorAgentId: valueAfter('--reflector-agent'),
  maxTokensPerChunk: positiveInteger(
    valueAfter('--chunk-tokens'),
    '--chunk-tokens',
  ),
  batchSize: positiveInteger(valueAfter('--batch-size'), '--batch-size'),
  includeConversations: !memoryFilesOnly,
  includeMemoryFiles: !conversationsOnly,
});
const outputPath = path.resolve(
  valueAfter('--output') ||
    resumePath ||
    defaultHistoryManifestPath(requestedProject, manifest.created_at),
);
writeHistoryManifest(outputPath, manifest);

const candidateCount =
  manifest.conversations.reduce(
    (sum, conversation) => sum + conversation.candidates.length,
    0,
  ) +
  manifest.memory_files.reduce((sum, file) => sum + file.candidates.length, 0);
console.log(
  JSON.stringify(
    {
      mode: 'preview',
      project: requestedProject,
      manifest: outputPath,
      conversations: manifest.conversations.length,
      memoryFiles: manifest.memory_files.length,
      candidates: candidateCount,
      memoryOps: manifest.envelope.memory_ops.length,
      skippedCandidates: manifest.envelope.skipped_candidates.length,
      errors: manifest.errors,
      applyCommand:
        manifest.errors.length === 0
          ? `bun scripts/reflect-conversation-history.ts --apply ${JSON.stringify(outputPath)}`
          : null,
    },
    null,
    2,
  ),
);

if (manifest.errors.length > 0) process.exitCode = 2;
