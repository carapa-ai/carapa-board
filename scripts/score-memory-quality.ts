#!/usr/bin/env bun

import fs from 'fs';
import path from 'path';
import {
  scoreMemoryQuality,
  type QualityItem,
  type QualityScopeReport,
} from '../src/modules/memory/memory-quality-score.js';

const USAGE = `score-memory-quality

Read-only quality baseline for stored memories. Never writes to the database.
Prints counts and ids only; content is shown only with --show.

Usage (exactly one input mode):
  bun scripts/score-memory-quality.ts --project <folder> [options]
  bun scripts/score-memory-quality.ts --manifest <path> [options]

Input modes:
  --project <folder>   Score the current memories of ONE project
  --manifest <path>    Score the create/supersede operations of a
                       history-reflection manifest JSON

Options:
  --json               Print the full JSON report instead of a table
  --show               Also print the first 120 chars of each flagged item
  --help, -h           Show this help`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

interface Options {
  project?: string;
  manifest?: string;
  json: boolean;
  show: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { json: false, show: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--show') opts.show = true;
    else if (arg === '--project' || arg === '--manifest') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) fail(`${arg} requires a value`);
      const key = arg === '--project' ? 'project' : 'manifest';
      if (opts[key] !== undefined) fail(`${arg} given more than once`);
      opts[key] = value;
    } else fail(`Unknown argument: ${arg}`);
  }
  if (opts.project && opts.manifest) {
    fail('--project and --manifest are mutually exclusive');
  }
  if (!opts.project && !opts.manifest) {
    fail('Exactly one of --project or --manifest is required');
  }
  return opts;
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const options = parseArgs(rawArgs);

const PAGE_SIZE = 200;

async function loadProjectItems(groupFolder: string): Promise<QualityItem[]> {
  // Loaded lazily so --help and argument errors need no config or DB.
  const { initDatabase } = await import('../src/db.js');
  const { listCurrentProjectMemories } =
    await import('../src/modules/memory/db-memories.js');
  await initDatabase();
  const items: QualityItem[] = [];
  let total = Infinity;
  while (items.length < total) {
    const page = await listCurrentProjectMemories({
      groupFolder,
      limit: PAGE_SIZE,
      offset: items.length,
    });
    total = page.total;
    if (page.memories.length === 0) break;
    for (const memory of page.memories) {
      items.push({
        id: memory.id,
        content: memory.content,
        memory_type: memory.memory_type,
        importance: memory.importance,
        tags: memory.tags,
        source: memory.source,
      });
    }
  }
  return items;
}

function loadManifestItems(manifestPath: string): QualityItem[] {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(manifestPath), 'utf8'),
  ) as import('../src/modules/memory/history-reflector-core.js').HistoryReflectionManifest;
  const ops = manifest?.envelope?.memory_ops;
  if (!Array.isArray(ops)) {
    throw new Error('Manifest has no envelope.memory_ops array');
  }
  const items: QualityItem[] = [];
  for (const op of ops) {
    if (op.op !== 'create' && op.op !== 'supersede') continue;
    items.push({
      id: op.new_memory_id,
      content: op.op === 'create' ? op.content : op.correction_content,
      memory_type: op.memory_type,
      importance: op.importance,
      tags: op.tags,
      source: 'manifest',
    });
  }
  return items;
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function printTable(
  rows: Array<[string, QualityScopeReport]>,
  heading: string,
): void {
  const header = [
    'scope',
    'count',
    'median',
    'p90',
    'max',
    '>600',
    'lead<=240',
    'stale',
    'tags!2-6',
    'imp>=.9',
    'dupPairs',
  ];
  const body = rows.map(([name, r]) => [
    name,
    String(r.count),
    String(r.length.median),
    String(r.length.p90),
    String(r.length.max),
    pct(r.length.shareOver600),
    pct(r.leadSentence.share),
    pct(r.staleStatus.share),
    pct(r.tags.share),
    pct(r.importance.share),
    r.nearDuplicates.skipped
      ? `skipped(${r.nearDuplicates.itemCount})`
      : String(r.nearDuplicates.pairCount),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );
  const line = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  console.log(heading);
  console.log(line(header));
  for (const row of body) console.log(line(row));
}

function snippet(content: string | undefined): string {
  return (content ?? '').slice(0, 120).replace(/\s+/g, ' ');
}

/** Every id the overall report flags, including both ends of each duplicate pair. */
function flaggedIds(report: QualityScopeReport): string[] {
  return [
    ...new Set([
      ...report.length.over600Ids,
      ...report.leadSentence.missingIds,
      ...report.staleStatus.ids,
      ...report.tags.ids,
      ...report.importance.ids,
      ...report.nearDuplicates.pairs.flatMap((p) => [p.a, p.b]),
    ]),
  ];
}

function snippetsFor(
  ids: string[],
  items: QualityItem[],
): Record<string, string> {
  const contentById = new Map(items.map((item) => [item.id, item.content]));
  return Object.fromEntries(
    ids.map((id) => [id, snippet(contentById.get(id))]),
  );
}

function printFlagged(
  report: QualityScopeReport,
  snippets: Record<string, string> | undefined,
): void {
  const lists: Array<[string, string[]]> = [
    ['over 600 chars', report.length.over600Ids],
    ['no lead sentence within 240 chars', report.leadSentence.missingIds],
    ['stale status wording', report.staleStatus.ids],
    ['tag count outside 2-6', report.tags.ids],
    ['importance >= 0.9', report.importance.ids],
  ];
  for (const [label, ids] of lists) {
    if (ids.length === 0) continue;
    console.log(`\n${label} (${ids.length} listed, capped at 50):`);
    for (const id of ids) {
      console.log(snippets ? `  ${id}  ${snippets[id]}` : `  ${id}`);
    }
  }
  const { pairs } = report.nearDuplicates;
  if (pairs.length > 0) {
    console.log(
      `\nnear-duplicate pairs (${pairs.length} listed, capped at 50):`,
    );
    for (const p of pairs) {
      console.log(`  ${p.a} ~ ${p.b} (${p.similarity})`);
      if (snippets) {
        console.log(`    ${p.a}  ${snippets[p.a]}`);
        console.log(`    ${p.b}  ${snippets[p.b]}`);
      }
    }
  }
  if (report.nearDuplicates.skipped) {
    console.log(
      `\nnear-duplicate check skipped: ${report.nearDuplicates.itemCount} items exceed the comparison limit`,
    );
  }
}

try {
  const items = options.project
    ? await loadProjectItems(options.project)
    : loadManifestItems(options.manifest!);
  const report = scoreMemoryQuality(items);

  // Content leaves the process only with --show, and only for flagged ids.
  const snippets = options.show
    ? snippetsFor(flaggedIds(report.overall), items)
    : undefined;

  if (options.json) {
    console.log(
      JSON.stringify(snippets ? { ...report, snippets } : report, null, 2),
    );
  } else if (report.overall.count === 0) {
    console.log('count 0');
  } else {
    const rows: Array<[string, QualityScopeReport]> = [
      ['overall', report.overall],
      ...Object.entries(report.bySource).map(
        ([source, r]) => [source, r] as [string, QualityScopeReport],
      ),
    ];
    printTable(rows, `source: ${options.project ?? options.manifest}`);
    printFlagged(report.overall, snippets);
  }
  process.exit(0);
} catch (error) {
  console.error(
    `score-memory-quality failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
