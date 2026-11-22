#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GROUPS_DIR } from '../src/config.js';
import { initDatabase } from '../src/db.js';
import { setGroupLookup } from '../src/group-dir.js';
import { getGroupByFolder, loadState } from '../src/state-manager.js';
import {
  getExistingConversationIds,
  getImportProjects,
  getKnownBoardSessionIds,
  getObjectiveProjectIds,
} from '../src/db/external-run-costs.js';
import {
  deterministicNativeConversationId,
  mapCwdToProject,
  objectiveIdFromSandboxPath,
  resolveProjectMapping,
  parseAntigravitySession,
  parseClaudeSession,
  parseCodexSession,
  parseCursorSession,
  parseCursorJsonlSession,
  parseGeminiSession,
  parseVscodeSession,
  replayVscodeSessionLog,
  type ImportProject,
  type ParsedNativeSession,
} from '../src/modules/transcripts/native-session-import.js';
import { nativeSessionToCarapaRunV1 } from '../src/modules/transcripts/native-run-v1.js';
import { loadCodexTitles } from '../src/modules/transcripts/codex-session-import.js';
import {
  installNativeV1Pair,
  nativeV1ExternalRunRows,
  projectNativeV1TranscriptEntries,
} from '../src/modules/transcripts/native-v1-import.js';
import {
  compareNativeImport,
  updateNativeImport,
  type NativeImportComparison,
  type NativeImportUpdateResult,
} from '../src/modules/transcripts/native-import-update.js';
import {
  admitNativeImportForReflection,
  NATIVE_IMPORT_REFLECT_DEFAULT_MAX_AGE_DAYS,
  nativeImportReflectAgeSkip,
  newestNativeMessageAt,
  type NativeImportReflectSkipReason,
} from '../src/modules/transcripts/native-import-reflect.js';
import {
  applyNativeConversationBatch,
  type NativeImportApplyInput,
  nativeImportTranscriptPath,
} from '../src/modules/transcripts/native-import-apply.js';

type Provider =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'cursor'
  | 'vscode'
  | 'antigravity';
type Candidate = {
  provider: Provider;
  file: string;
  title: string | null;
  session: ParsedNativeSession;
};

const DEFAULT_PROJECT_MAP_PATH = path.join(
  GROUPS_DIR,
  'carapa/carapa-board/artifacts/imports/native-conversation-project-map.json',
);
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: bun scripts/import-native-conversations.ts [options]

Options:
  --source <name>       claude, codex, gemini, cursor, vscode, antigravity, or all (default: all)
  --apply               Write imports; without this flag the command is a dry-run
  --update              Bring already imported conversations up to date with their
                        native session (append missing transcript lines, correct
                        run costs). Refuses conversations continued in the Board.
                        Dry-run unless combined with --apply
  --reflect             With --apply, admit sessions imported in this run and
                        --update appends whose newest message is recent to the
                        live memory reflector (the running Board processes them).
                        Without --apply, only report how many would be admitted
  --reflect-max-age-days <n>
                        Recency window for --reflect (default: ${NATIVE_IMPORT_REFLECT_DEFAULT_MAX_AGE_DAYS})
  --include-incomplete  Include sessions ending with an unanswered user turn
  --project <id>        Import only sessions mapped to this Board project
  --since <date>        Import sessions created on or after this date
  --until <date>        Import sessions created on or before this date
  --project-map <file>  JSON mappings file (default: ${DEFAULT_PROJECT_MAP_PATH})
  --claude-home <dir>   Claude config home (default: ~/.claude)
  --codex-home <dir>    Codex config home (default: CODEX_HOME or ~/.codex)
  --gemini-home <dir>   Gemini config home (default: ~/.gemini)
  --cursor-home <dir>   Cursor config home (default: ~/.cursor)
  --vscode-home <dir>   VS Code User data directory (default: ~/.config/Code/User)
  --antigravity-home <dir>
                        Decoded Antigravity data (default: ~/.gemini/antigravity-decoded)
  --explain <id>        Report what happened to sessions whose id contains <id>,
                        including a comparison for already imported sessions
  --help, -h            Show this help`);
  console.log(`
Mappings use JSON keys such as "cwd:/workspace/carapa-board" and
"gemini-hash:<directory-name>", with Board project IDs as values. A key may
contain * wildcards (e.g. "cwd:/tmp/scratch/*"); exact keys win, then the most
specific pattern.`);
  process.exit(0);
}
const valueAfter = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const apply = args.includes('--apply');
const update = args.includes('--update');
const reflect = args.includes('--reflect');
const reflectMaxAgeRaw = valueAfter('--reflect-max-age-days');
const reflectMaxAgeDays =
  reflectMaxAgeRaw === undefined
    ? NATIVE_IMPORT_REFLECT_DEFAULT_MAX_AGE_DAYS
    : Number(reflectMaxAgeRaw);
if (
  args.includes('--reflect-max-age-days') &&
  (reflectMaxAgeRaw === undefined ||
    !Number.isFinite(reflectMaxAgeDays) ||
    reflectMaxAgeDays <= 0)
) {
  throw new Error(`Invalid --reflect-max-age-days: ${reflectMaxAgeRaw}`);
}
const includeIncomplete = args.includes('--include-incomplete');
const sourceArg = valueAfter('--source') || 'all';
const providers: Provider[] =
  sourceArg === 'all'
    ? ['claude', 'codex', 'gemini', 'cursor', 'vscode', 'antigravity']
    : [sourceArg as Provider];
if (
  providers.some(
    (provider) =>
      ![
        'claude',
        'codex',
        'gemini',
        'cursor',
        'vscode',
        'antigravity',
      ].includes(provider),
  )
) {
  throw new Error(`Invalid --source: ${sourceArg}`);
}

const providerHomes: Record<Provider, string> = {
  claude: path.resolve(
    valueAfter('--claude-home') || path.join(os.homedir(), '.claude'),
  ),
  codex: path.resolve(
    valueAfter('--codex-home') ||
      process.env.CODEX_HOME ||
      path.join(os.homedir(), '.codex'),
  ),
  gemini: path.resolve(
    valueAfter('--gemini-home') || path.join(os.homedir(), '.gemini'),
  ),
  cursor: path.resolve(
    valueAfter('--cursor-home') || path.join(os.homedir(), '.cursor'),
  ),
  vscode: path.resolve(
    valueAfter('--vscode-home') ||
      path.join(os.homedir(), '.config', 'Code', 'User'),
  ),
  antigravity: path.resolve(
    valueAfter('--antigravity-home') ||
      path.join(os.homedir(), '.gemini', 'antigravity-decoded'),
  ),
};
const explainId = valueAfter('--explain')?.toLowerCase() || null;
const projectFilter = valueAfter('--project');
const explicitProjectMapPath = valueAfter('--project-map');
const projectMapPath = explicitProjectMapPath || DEFAULT_PROJECT_MAP_PATH;
const since = valueAfter('--since');
const until = valueAfter('--until');

function parseBoundary(
  value: string | undefined,
  endOfDay = false,
): number | null {
  if (!value) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = Date.parse(
    dateOnly
      ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
      : value,
  );
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

const sinceMs = parseBoundary(since);
const untilMs = parseBoundary(until, true);

async function listFiles(
  root: string,
  extension: string,
  requiredPart?: string,
): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (
        entry.isFile() &&
        entry.name.endsWith(extension) &&
        (!requiredPart || full.includes(requiredPart))
      )
        result.push(full);
    }
  }
  await walk(root);
  return result.sort();
}

async function readJsonl(
  file: string,
): Promise<{ records: Record<string, any>[]; malformed: boolean }> {
  const records: Record<string, any>[] = [];
  let malformed = false;
  const raw = await fs.readFile(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed = true;
    }
  }
  return { records, malformed };
}

async function vscodeWorkspaceCwd(
  workspaceDirectory: string,
): Promise<string | null> {
  try {
    const data = JSON.parse(
      await fs.readFile(
        path.join(workspaceDirectory, 'workspace.json'),
        'utf8',
      ),
    );
    const uri = typeof data?.folder === 'string' ? data.folder : null;
    if (!uri) return null;
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:' && parsed.protocol !== 'vscode-remote:')
      return null;
    return decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
}

async function loadProjectMap(
  file: string,
  optional = false,
): Promise<Map<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return new Map();
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      '--project-map must contain a JSON object of mapping-key to project-id',
    );
  }
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Invalid project id for mapping key: ${key}`);
    }
    result.set(key, value);
  }
  return result;
}

function projectLocations(
  rows: Awaited<ReturnType<typeof getImportProjects>>,
): ImportProject[] {
  const projects: ImportProject[] = [];
  const commonParent = (locations: string[]): string | null => {
    if (locations.length === 0) return null;
    let candidate = path.resolve(locations[0]);
    for (const location of locations.slice(1)) {
      const target = path.resolve(location);
      while (
        target !== candidate &&
        !target.startsWith(`${candidate}${path.sep}`)
      ) {
        const parent = path.dirname(candidate);
        if (parent === candidate) return null;
        candidate = parent;
      }
    }
    return candidate;
  };
  for (const row of rows) {
    try {
      const settings =
        typeof row.settings === 'string'
          ? JSON.parse(row.settings)
          : row.settings;
      let repositoryLocation = settings?.repositoryLocation;
      if (
        (!repositoryLocation || !String(repositoryLocation).trim()) &&
        settings?.isParent === true &&
        Array.isArray(settings.relatedRepositories)
      ) {
        repositoryLocation = commonParent(
          settings.relatedRepositories.filter(
            (value: unknown): value is string =>
              typeof value === 'string' && value.length > 0,
          ),
        );
      }
      projects.push({
        id: row.id,
        folder: row.folder,
        repositoryLocation:
          typeof repositoryLocation === 'string' ? repositoryLocation : '',
      });
    } catch {
      projects.push({ id: row.id, folder: row.folder, repositoryLocation: '' });
    }
  }
  return projects;
}

async function discover(): Promise<{
  candidates: Candidate[];
  malformed: number;
  malformedFiles: Array<{ provider: Provider; file: string; reason: string }>;
  discovered: number;
  skippedSubagents: number;
}> {
  const candidates: Candidate[] = [];
  let malformed = 0;
  let skippedSubagents = 0;
  const malformedFiles: Array<{
    provider: Provider;
    file: string;
    reason: string;
  }> = [];
  let discovered = 0;
  const markMalformed = (provider: Provider, file: string, reason: string) => {
    malformed++;
    if (malformedFiles.length < 50)
      malformedFiles.push({ provider, file, reason });
  };
  const codexTitles = providers.includes('codex')
    ? await loadCodexTitles(
        path.join(providerHomes.codex, 'session_index.jsonl'),
      )
    : new Map<string, string>();

  if (providers.includes('claude')) {
    const files = await listFiles(
      path.join(providerHomes.claude, 'projects'),
      '.jsonl',
    );
    discovered += files.length;
    for (const file of files) {
      if (
        file.includes(`${path.sep}subagents${path.sep}`) ||
        file.includes(`${path.sep}tool-results${path.sep}`)
      ) {
        skippedSubagents++;
        continue;
      }
      try {
        const parsed = await readJsonl(file);
        if (parsed.malformed)
          markMalformed('claude', file, 'one or more invalid JSONL records');
        const session = parseClaudeSession(parsed.records);
        if (session)
          candidates.push({ provider: 'claude', file, title: null, session });
        else markMalformed('claude', file, 'missing session id or cwd');
      } catch {
        markMalformed('claude', file, 'unreadable session file');
      }
    }
  }

  if (providers.includes('codex')) {
    const files = await listFiles(
      path.join(providerHomes.codex, 'sessions'),
      '.jsonl',
    );
    discovered += files.length;
    for (const file of files) {
      try {
        const parsed = await readJsonl(file);
        if (parsed.malformed)
          markMalformed('codex', file, 'one or more invalid JSONL records');
        const codex = parseCodexSession(parsed.records);
        if (codex) {
          candidates.push({
            provider: 'codex',
            file,
            title: codexTitles.get(codex.sessionId) || null,
            session: {
              ...codex,
              cwd: codex.cwd,
              mappingKey: null,
              objectiveId: objectiveIdFromSandboxPath(codex.cwd),
            },
          });
        } else markMalformed('codex', file, 'missing session metadata');
      } catch {
        markMalformed('codex', file, 'unreadable session file');
      }
    }
  }

  if (providers.includes('gemini')) {
    const files = await listFiles(
      path.join(providerHomes.gemini, 'tmp'),
      '.json',
      `${path.sep}chats${path.sep}`,
    );
    discovered += files.length;
    for (const file of files) {
      try {
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        const projectHash = path.basename(path.dirname(path.dirname(file)));
        const session = parseGeminiSession(data, projectHash);
        if (session)
          candidates.push({ provider: 'gemini', file, title: null, session });
        else markMalformed('gemini', file, 'missing session id or messages');
      } catch {
        markMalformed('gemini', file, 'invalid or unreadable JSON');
      }
    }
  }

  if (providers.includes('cursor')) {
    const cursorRoot = path.join(providerHomes.cursor, 'projects');
    const files = [
      ...(await listFiles(
        cursorRoot,
        '.txt',
        `${path.sep}agent-transcripts${path.sep}`,
      )),
      ...(await listFiles(
        cursorRoot,
        '.jsonl',
        `${path.sep}agent-transcripts${path.sep}`,
      )),
    ].sort();
    discovered += files.length;
    for (const file of files) {
      try {
        const stats = await fs.stat(file);
        const sessionId = path.basename(file, path.extname(file));
        const parts = file.split(path.sep);
        const projectIndex = parts.lastIndexOf('projects');
        const projectFolder = projectIndex >= 0 ? parts[projectIndex + 1] : '';
        const session =
          path.extname(file) === '.jsonl'
            ? parseCursorJsonlSession(
                (await readJsonl(file)).records,
                sessionId,
                projectFolder,
                stats.mtime.toISOString(),
              )
            : parseCursorSession(
                await fs.readFile(file, 'utf8'),
                sessionId,
                projectFolder,
                stats.mtime.toISOString(),
              );
        if (session)
          candidates.push({ provider: 'cursor', file, title: null, session });
        else
          markMalformed('cursor', file, 'missing session id or project folder');
      } catch {
        markMalformed('cursor', file, 'unreadable transcript');
      }
    }
  }

  if (providers.includes('vscode')) {
    const workspaceRoot = path.join(providerHomes.vscode, 'workspaceStorage');
    // Older VS Code versions save one `.json` snapshot; newer ones an
    // append-only `.jsonl` edit log.
    const workspaceFiles = [
      ...(await listFiles(
        workspaceRoot,
        '.json',
        `${path.sep}chatSessions${path.sep}`,
      )),
      ...(await listFiles(
        workspaceRoot,
        '.jsonl',
        `${path.sep}chatSessions${path.sep}`,
      )),
    ];
    const emptyWindowRoot = path.join(
      providerHomes.vscode,
      'globalStorage',
      'emptyWindowChatSessions',
    );
    const emptyWindowFiles = [
      ...(await listFiles(emptyWindowRoot, '.json')),
      ...(await listFiles(emptyWindowRoot, '.jsonl')),
    ];
    const files = [...workspaceFiles, ...emptyWindowFiles].sort();
    discovered += files.length;
    for (const file of files) {
      try {
        const data = file.endsWith('.jsonl')
          ? replayVscodeSessionLog((await readJsonl(file)).records)
          : JSON.parse(await fs.readFile(file, 'utf8'));
        const inWorkspaceStorage = file.startsWith(
          `${workspaceRoot}${path.sep}`,
        );
        const relative = inWorkspaceStorage
          ? path.relative(workspaceRoot, file)
          : '';
        const workspaceKey = inWorkspaceStorage
          ? relative.split(path.sep)[0]
          : 'empty-window';
        const workspaceDirectory = inWorkspaceStorage
          ? path.join(workspaceRoot, workspaceKey)
          : '';
        const cwd = workspaceDirectory
          ? await vscodeWorkspaceCwd(workspaceDirectory)
          : null;
        const session = parseVscodeSession(data, workspaceKey, cwd);
        if (session)
          candidates.push({ provider: 'vscode', file, title: null, session });
        else markMalformed('vscode', file, 'missing session id or requests');
      } catch {
        markMalformed('vscode', file, 'invalid or unreadable JSON');
      }
    }
  }

  if (providers.includes('antigravity')) {
    const files = await listFiles(
      path.join(providerHomes.antigravity, 'conversations'),
      '.json',
    );
    discovered += files.length;
    for (const file of files) {
      try {
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        const session = parseAntigravitySession(data);
        if (session)
          candidates.push({
            provider: 'antigravity',
            file,
            title: null,
            session,
          });
        else
          markMalformed(
            'antigravity',
            file,
            'missing cascade trajectory or steps',
          );
      } catch {
        markMalformed(
          'antigravity',
          file,
          'invalid or unreadable decoded JSON',
        );
      }
    }
  }

  return {
    candidates,
    malformed,
    malformedFiles,
    discovered,
    skippedSubagents,
  };
}

await initDatabase();
// Child projects live under their parent (groups/<parent>/<project>); without
// the lookup getGroupDir resolves the flat groups/<project> path instead.
await loadState();
setGroupLookup((folder) => getGroupByFolder(folder));
const [
  { candidates, malformed, malformedFiles, discovered, skippedSubagents },
  projectRows,
  boardSessionIds,
  projectMap,
  objectiveProjectIds,
] = await Promise.all([
  discover(),
  getImportProjects(),
  getKnownBoardSessionIds(),
  loadProjectMap(projectMapPath, !explicitProjectMapPath),
  getObjectiveProjectIds(),
]);
const projects = projectLocations(projectRows);
const projectIds = new Set(projectRows.map((row) => row.id));
for (const [key, projectId] of projectMap) {
  if (!projectIds.has(projectId))
    throw new Error(
      `Unknown project id "${projectId}" for mapping key "${key}"`,
    );
}
const conversationIds = candidates.map(({ provider, session }) =>
  deterministicNativeConversationId(provider, session.sessionId),
);
const existingIds = await getExistingConversationIds(conversationIds);

const counts: Record<string, number> = {
  discovered,
  parsed: candidates.length,
  importable: 0,
  imported: 0,
  existing: 0,
  orphanTranscript: 0,
  failed: 0,
  boardOwned: 0,
  subagent: skippedSubagents,
  empty: 0,
  incomplete: 0,
  malformed,
  unmatched: 0,
  ambiguous: 0,
  filtered: 0,
  ...(update ? { updated: 0, unchanged: 0, refused: 0 } : {}),
};
const unresolvedMappings = new Set<string>();
const unmatchedCwds = new Set<string>();
const ambiguousMappings = new Set<string>();
const explained: string[] = [];
const comparisons: Record<string, NativeImportComparison> = {};
const updateReports: Array<Record<string, unknown>> = [];
const decide = (provider: string, sessionId: string, outcome: string) => {
  if (explainId && sessionId.toLowerCase().includes(explainId))
    explained.push(`${provider} ${sessionId}: ${outcome}`);
};
const recordUpdate = (
  provider: string,
  sessionId: string,
  result: NativeImportUpdateResult,
) => {
  counts[result.status]++;
  const reasons =
    result.status === 'refused' ? result.reasons : result.comparison.reasons;
  updateReports.push({
    provider,
    sessionId,
    conversationId: result.comparison.conversationId,
    status: result.status,
    applied: apply && result.status === 'updated',
    reasons,
    ...(result.status === 'refused' ? {} : { changes: result.changes }),
  });
  decide(
    provider,
    sessionId,
    `update ${result.status}${apply ? '' : ' (dry run)'}${reasons.length ? `: ${reasons.join('; ')}` : ''}`,
  );
};
const mappedProjectId = (key: string): string | undefined => {
  const { projectId, ambiguous } = resolveProjectMapping(projectMap, key);
  if (ambiguous) ambiguousMappings.add(key);
  return projectId ?? undefined;
};
const preview: Array<Record<string, unknown>> = [];
const failures: string[] = [];
const pending: Array<{
  provider: string;
  sessionId: string;
  input: NativeImportApplyInput;
}> = [];
const recordFailure = (provider: string, sessionId: string, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  counts.failed++;
  failures.push(`${provider} ${sessionId}: ${message}`);
  console.error(`Failed to import ${provider} ${sessionId}: ${message}`);
  decide(provider, sessionId, `failed: ${message}`);
};

const reflectSkipped: Record<NativeImportReflectSkipReason, number> = {
  too_old: 0,
  no_timestamp: 0,
  not_in_project: 0,
  not_admitted: 0,
};
let reflectAdmitted = 0;
let reflectWouldAdmit = 0;
/** Dry run: count what --reflect --apply would admit; nothing is written. */
const countReflectCandidate = (newestMessageAt: string | null) => {
  const reason = nativeImportReflectAgeSkip(newestMessageAt, reflectMaxAgeDays);
  if (reason) reflectSkipped[reason]++;
  else reflectWouldAdmit++;
};
/** One failing admission is a failure for its session, not for the batch. */
const reflectAdmit = async (
  provider: string,
  sessionId: string,
  input: Omit<
    Parameters<typeof admitNativeImportForReflection>[0],
    'maxAgeDays'
  >,
) => {
  try {
    const result = await admitNativeImportForReflection({
      ...input,
      maxAgeDays: reflectMaxAgeDays,
    });
    if (result.status === 'admitted') reflectAdmitted++;
    else reflectSkipped[result.reason]++;
    decide(
      provider,
      sessionId,
      result.status === 'admitted'
        ? `reflection admitted (run ${result.runId})`
        : `reflection skipped: ${result.reason}`,
    );
  } catch (error) {
    recordFailure(
      provider,
      sessionId,
      new Error(
        `reflection admission failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
};

for (const { provider, session, title: nativeTitle } of candidates) {
  try {
    if (session.isSubagent) {
      counts.subagent++;
      decide(provider, session.sessionId, 'skipped: subagent session');
      continue;
    }
    if (boardSessionIds.has(session.sessionId) || session.boardOwnedHint) {
      counts.boardOwned++;
      decide(
        provider,
        session.sessionId,
        'skipped: created by CarapaBoard (known Board session id or AGENT_CONTEXT/task envelope in a message)',
      );
      continue;
    }
    const createdMs = Date.parse(session.createdAt);
    if (
      (sinceMs != null &&
        (!Number.isFinite(createdMs) || createdMs < sinceMs)) ||
      (untilMs != null && (!Number.isFinite(createdMs) || createdMs > untilMs))
    ) {
      counts.filtered++;
      decide(
        provider,
        session.sessionId,
        `skipped: created ${session.createdAt}, outside --since/--until`,
      );
      continue;
    }

    let project: ImportProject | null = null;
    const sessionMappedId = mappedProjectId(
      `${provider}-session:${session.sessionId}`,
    );
    if (sessionMappedId) {
      project =
        projects.find((candidate) => candidate.id === sessionMappedId) || null;
    } else if (session.objectiveId) {
      const projectId = objectiveProjectIds.get(session.objectiveId);
      project =
        projects.find((candidate) => candidate.id === projectId) || null;
      if (!project) unresolvedMappings.add(`objective:${session.objectiveId}`);
    } else if (session.cwd) {
      const mapping = mapCwdToProject(session.cwd, projects);
      if (mapping.ambiguous) {
        counts.ambiguous++;
        unmatchedCwds.add(session.cwd);
        decide(
          provider,
          session.sessionId,
          `skipped: ambiguous project for ${session.cwd}`,
        );
        continue;
      }
      project = mapping.project;
      if (!project) {
        const mappedId = mappedProjectId(`cwd:${session.cwd}`);
        project =
          projects.find((candidate) => candidate.id === mappedId) || null;
        if (!project) {
          unmatchedCwds.add(session.cwd);
          unresolvedMappings.add(`cwd:${session.cwd}`);
        }
      }
    } else if (session.mappingKey) {
      const mappedId = mappedProjectId(session.mappingKey);
      if (mappedId) {
        const row = projects.find((candidate) => candidate.id === mappedId);
        project = row || { id: mappedId, repositoryLocation: '' };
      } else unresolvedMappings.add(session.mappingKey);
    }
    if (!project) {
      counts.unmatched++;
      decide(
        provider,
        session.sessionId,
        `skipped: no project mapping (${session.cwd || session.mappingKey})`,
      );
      continue;
    }
    if (projectFilter && project.id !== projectFilter) {
      counts.filtered++;
      decide(
        provider,
        session.sessionId,
        `skipped: belongs to ${project.id}, not --project ${projectFilter}`,
      );
      continue;
    }

    const messageEntries = session.messages.filter(
      (entry) => entry.type === 'message',
    );
    const lastMessage = messageEntries.at(-1);
    if (
      !session.firstUserText ||
      !messageEntries.some((entry) => entry.role === 'assistant')
    ) {
      counts.empty++;
      decide(
        provider,
        session.sessionId,
        'skipped: no user question with an assistant reply',
      );
      continue;
    }
    if (
      !includeIncomplete &&
      (!session.lastAssistantAt ||
        lastMessage?.role !== 'assistant' ||
        (session.lastUserAt != null &&
          session.lastAssistantAt < session.lastUserAt))
    ) {
      counts.incomplete++;
      decide(
        provider,
        session.sessionId,
        `skipped: incomplete (last user ${session.lastUserAt}, last assistant ${session.lastAssistantAt}); use --include-incomplete`,
      );
      continue;
    }

    const conversationId = deterministicNativeConversationId(
      provider,
      session.sessionId,
    );
    if (existingIds.has(conversationId)) {
      counts.existing++;
      decide(
        provider,
        session.sessionId,
        `skipped: already imported as ${conversationId}`,
      );
      const explainsSession =
        explainId && session.sessionId.toLowerCase().includes(explainId);
      if (update || explainsSession) {
        const nativeInput = {
          conversationId,
          v1Runs: nativeSessionToCarapaRunV1(session),
          native: {
            lastUserAt: session.lastUserAt,
            lastAssistantAt: session.lastAssistantAt,
            preview: session.firstUserText
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 500),
          },
        };
        if (update) {
          const result = await updateNativeImport(nativeInput, { apply });
          recordUpdate(provider, session.sessionId, result);
          if (reflect && result.status === 'updated') {
            const newestMessageAt = newestNativeMessageAt(
              nativeInput.native.lastUserAt,
              nativeInput.native.lastAssistantAt,
            );
            if (!apply) {
              if (result.changes.transcriptLinesMissing > 0)
                countReflectCandidate(newestMessageAt);
            } else if (result.appendedRange) {
              await reflectAdmit(provider, session.sessionId, {
                projectId: project.id,
                objectiveId: session.objectiveId ?? null,
                conversationId,
                // The path update wrote; admission refuses it unless it lies
                // inside this project's own group directory.
                transcriptPath: result.comparison.transcriptPath,
                ...result.appendedRange,
                newestMessageAt,
              });
            }
          }
          if (explainsSession)
            comparisons[`${provider} ${session.sessionId}`] = result.comparison;
        } else {
          comparisons[`${provider} ${session.sessionId}`] =
            await compareNativeImport(nativeInput);
        }
      }
      continue;
    }
    const existingTranscriptPath = nativeImportTranscriptPath(
      project.id,
      session.objectiveId,
      conversationId,
    );
    if (existsSync(existingTranscriptPath)) {
      counts.orphanTranscript++;
      decide(
        provider,
        session.sessionId,
        `skipped: orphan transcript exists at ${existingTranscriptPath}`,
      );
      continue;
    }
    const title = (nativeTitle || session.firstUserText)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    const previewText = session.firstUserText
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    const v1Runs = nativeSessionToCarapaRunV1(session);
    if (v1Runs.length === 0) {
      counts.empty++;
      decide(provider, session.sessionId, 'skipped: no usable turns');
      continue;
    }
    counts.importable++;
    decide(
      provider,
      session.sessionId,
      `importable into ${project.id}${apply ? ' (applying)' : ' (dry run)'}`,
    );
    const transcriptEntries = projectNativeV1TranscriptEntries(
      v1Runs,
      conversationId,
    );
    const runRows = nativeV1ExternalRunRows(v1Runs, project.id, conversationId);
    preview.push({
      provider,
      sessionId: session.sessionId,
      source: session.source,
      projectId: project.id,
      conversationId,
      title,
      messages: messageEntries.length,
      turns: v1Runs.length,
      costUsd: runRows.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0),
    });
    if (!apply) {
      if (reflect)
        countReflectCandidate(
          newestNativeMessageAt(session.lastUserAt, session.lastAssistantAt),
        );
      continue;
    }

    pending.push({
      provider,
      sessionId: session.sessionId,
      input: {
        projectId: project.id,
        objectiveId: session.objectiveId,
        conversationId,
        v1Runs,
        transcriptEntries,
        conversation: {
          id: conversationId,
          group_folder: project.id,
          preview: previewText,
          created_at: session.createdAt,
          // Imported history has already been reviewed outside the Board. Mark it
          // read through its final response so it does not appear as a new,
          // completed conversation in the sidebar.
          read_at: session.lastAssistantAt || session.createdAt,
          title,
          pinned: 0,
          session_id: null,
          forked_from: null,
          use_worktree: 0,
          worktree_path: null,
          branch_name: null,
          brain_managed: 0,
          objective_id: session.objectiveId,
          last_agent_cmd: null,
          runtimeHarnessId: null,
          runtimeModelId: null,
          runtimeReasoning: null,
          last_user_at: session.lastUserAt,
          last_assistant_at: session.lastAssistantAt,
        },
        runRows,
      },
    });
    existingIds.add(conversationId);
  } catch (error) {
    recordFailure(provider, session.sessionId, error);
  }
}

// Each session is applied independently: a failure is recorded and the
// remaining sessions are still imported.
const applyResults = await applyNativeConversationBatch(
  pending.map(({ input }) => input),
);
for (const [index, result] of applyResults.entries()) {
  const { provider, sessionId, input } = pending[index];
  if (result.status === 'imported') {
    counts.imported++;
    if (reflect) {
      const transcriptPath = nativeImportTranscriptPath(
        input.projectId,
        input.objectiveId,
        input.conversationId,
      );
      try {
        await reflectAdmit(provider, sessionId, {
          projectId: input.projectId,
          objectiveId: input.objectiveId ?? null,
          conversationId: input.conversationId,
          transcriptPath,
          byteOffset: 0,
          byteEndOffset: (await fs.stat(transcriptPath)).size,
          newestMessageAt: newestNativeMessageAt(
            input.conversation.last_user_at,
            input.conversation.last_assistant_at,
          ),
        });
      } catch (error) {
        recordFailure(provider, sessionId, error);
      }
    }
  } else if (result.status === 'orphanTranscript') {
    counts.orphanTranscript++;
    decide(
      provider,
      sessionId,
      `skipped: orphan transcript exists at ${result.transcriptPath}`,
    );
  } else recordFailure(provider, sessionId, result.error);
}

console.log(
  JSON.stringify(
    {
      dryRun: !apply,
      sources: providers,
      homes: Object.fromEntries(
        providers.map((provider) => [provider, providerHomes[provider]]),
      ),
      filters: {
        project: projectFilter || null,
        since: since || null,
        until: until || null,
        includeIncomplete,
        projectMap: path.resolve(projectMapPath),
      },
      counts,
      ...(reflect
        ? {
            reflect: {
              enabled: true,
              maxAgeDays: reflectMaxAgeDays,
              admitted: reflectAdmitted,
              ...(apply ? {} : { wouldAdmit: reflectWouldAdmit }),
              skipped: reflectSkipped,
            },
          }
        : {}),
      malformedFiles,
      ...(failures.length ? { failures } : {}),
      unmatchedCwds: [...unmatchedCwds].sort(),
      unresolvedMappings: [...unresolvedMappings].sort(),
      ambiguousMappings: [...ambiguousMappings].sort(),
      ...(explainId
        ? {
            explain: explained.length
              ? explained
              : [
                  `no parsed session id contains "${explainId}"; check malformedFiles, --source and the --*-home folders`,
                  ...malformedFiles
                    .filter((entry) =>
                      entry.file.toLowerCase().includes(explainId),
                    )
                    .map((entry) => `${entry.file}: ${entry.reason}`),
                ],
          }
        : {}),
      ...(Object.keys(comparisons).length ? { comparison: comparisons } : {}),
      // Unchanged sessions are only counted, keeping the report readable.
      ...(update
        ? { update: updateReports.filter((r) => r.status !== 'unchanged') }
        : {}),
      preview: preview.slice(0, 50),
    },
    null,
    2,
  ),
);

// Per-session failures do not stop the batch, but must not look like success.
// Exit explicitly: the open database connection would otherwise keep the
// process alive after the summary is printed.
process.exit(counts.failed > 0 ? 1 : 0);
