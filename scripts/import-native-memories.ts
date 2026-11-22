#!/usr/bin/env bun
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  discoverClaudeMemories,
  discoverCodexMemories,
  loadProjectCatalog,
  manifestEntry,
  targetNativeMemory,
  type NativeMemoryTarget,
} from '../src/modules/memory/native-memory-import.js';

const args = process.argv.slice(2);
const valuesAfter = (flag: string): string[] => args.flatMap((value, index) =>
  value === flag && args[index + 1] ? [args[index + 1]] : []);
const valueAfter = (flag: string): string | undefined => valuesAfter(flag).at(-1);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: bun scripts/import-native-memories.ts [options]

Dry-run by default. Copies native memory files without overwriting destinations.

Options:
  --source claude|codex|all       Provider filter (default: all)
  --apply                         Copy files and write date manifests
  --claude-home <label=dir>       Repeatable Claude home
  --codex-home <label=dir>        Repeatable Codex home
  --groups-root <dir>             Knowledge-base groups root
  --project-map <json>            Native project/cwd mappings
  --projects-file <file>          Registered project paths
  --help, -h                      Show this help`);
  process.exit(0);
}

const source = valueAfter('--source') || 'all';
if (!['claude', 'codex', 'all'].includes(source)) throw new Error(`Invalid --source: ${source}`);
const apply = args.includes('--apply');
const workspaceRoot = path.resolve(import.meta.dir, '..', '..');
const groupsRoot = path.resolve(valueAfter('--groups-root')
  || path.join(workspaceRoot, 'ai-knowledge-base', 'groups'));
const projectMapPath = path.resolve(valueAfter('--project-map')
  || path.join(groupsRoot, 'carapa', 'carapa-board', 'artifacts', 'imports', 'native-conversation-project-map.json'));
const projectsFile = path.resolve(valueAfter('--projects-file')
  || path.join(groupsRoot, 'carapa', 'carapa-board', 'artifacts', 'imports', 'projects.txt'));

function homes(flag: string, fallback: string): Array<{ label: string; home: string }> {
  const values = valuesAfter(flag);
  return (values.length ? values : [`host=${fallback}`]).map((value) => {
    const separator = value.indexOf('=');
    if (separator < 1) throw new Error(`${flag} must use label=dir`);
    return {
      label: value.slice(0, separator),
      home: path.resolve(value.slice(separator + 1)),
    };
  });
}

const claudeHomes = homes('--claude-home', path.join(os.homedir(), '.claude'));
const codexHomes = homes('--codex-home', process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const projectMapJson = JSON.parse(await fs.readFile(projectMapPath, 'utf8'));
const projectMap = new Map<string, string>(Object.entries(projectMapJson));
const projectCatalog = loadProjectCatalog((await fs.readFile(projectsFile, 'utf8')).split(/\r?\n/));

const discovered = [];
if (source === 'all' || source === 'claude') {
  for (const item of claudeHomes) discovered.push(...await discoverClaudeMemories(item.home, item.label));
}
if (source === 'all' || source === 'codex') {
  for (const item of codexHomes) discovered.push(...await discoverCodexMemories(item.home, item.label));
}
const targets = discovered.map((memory) =>
  targetNativeMemory(memory, groupsRoot, projectCatalog, projectMap));

const counts = {
  discovered: targets.length,
  copyable: 0,
  copied: 0,
  existing: 0,
  conflicts: 0,
  mapped: targets.filter((target) => target.projectId).length,
  unmapped: targets.filter((target) => !target.projectId).length,
};
const unresolvedMappings = [...new Set(
  targets.filter((target) => !target.projectId).map((target) => target.mappingKey),
)].sort();
const manifests = new Map<string, Record<string, ReturnType<typeof manifestEntry>>>();
const preview = [];

async function atomicWrite(file: string, content: Buffer | string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, content, { flag: 'wx', mode });
  await fs.rename(temporary, file);
}

for (const target of targets) {
  let state: 'copyable' | 'existing' | 'conflict' = 'copyable';
  try {
    const current = await fs.readFile(target.destinationPath);
    const hash = crypto.createHash('sha256').update(current).digest('hex');
    state = hash === target.sha256 ? 'existing' : 'conflict';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (state === 'copyable') counts.copyable++;
  else if (state === 'existing') counts.existing++;
  else counts.conflicts++;
  if (preview.length < 100) {
    preview.push({
      provider: target.provider,
      sourceLabel: target.sourceLabel,
      nativeProject: target.nativeProject,
      projectId: target.projectId,
      source: target.sourcePath,
      destination: target.destinationPath,
      sourceBirthtime: target.sourceBirthtime,
      sourceMtime: target.sourceMtime,
      state,
    });
  }
  if (!apply || state === 'conflict') continue;
  if (state === 'copyable') {
    await atomicWrite(target.destinationPath, target.content, target.sourceMode);
    const sourceMtime = new Date(target.sourceMtime);
    await fs.utimes(target.destinationPath, sourceMtime, sourceMtime);
    counts.copied++;
  }
  const entries = manifests.get(target.destinationRoot) || {};
  entries[target.relativePath] = manifestEntry(target);
  manifests.set(target.destinationRoot, entries);
}

if (apply) {
  for (const [root, entries] of manifests) {
    const manifestPath = path.join(root, '.native-memory-import.json');
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {}
    await atomicWrite(manifestPath, `${JSON.stringify({ ...existing, ...entries }, null, 2)}\n`);
  }
}

console.log(JSON.stringify({
  dryRun: !apply,
  source,
  groupsRoot,
  homes: { claude: claudeHomes, codex: codexHomes },
  counts,
  byProvider: Object.fromEntries(['claude', 'codex'].map((provider) => [
    provider,
    targets.filter((target) => target.provider === provider).length,
  ])),
  unresolvedMappings,
  preview,
}, null, 2));
if (counts.conflicts > 0) process.exitCode = 2;
