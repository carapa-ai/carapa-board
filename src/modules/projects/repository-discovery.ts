import path from 'node:path';
import type { RegisteredGroup } from '../../types.js';
import { slugify } from '../../utils.js';
import { isRecord } from '../../lib/type-guards.js';
import {
  RESERVED_PROJECT_FOLDERS,
  isReservedMainFolder,
} from './reserved-folders.js';
import { getSandboxClient } from '../../lib/mcp-client.js';
import {
  execInGroupSandbox,
  prepareGroupSandbox,
  shellQuote,
} from '../fs/sandbox-fs.js';

const DEFAULT_REPOSITORY_DISCOVERY_DEPTH = 4;
const MAX_REPOSITORY_DISCOVERY_DEPTH = 12;
export const REPOSITORY_SCANNER_PATH =
  '/usr/local/ai-cli-bin/carapa-repository-scan';
const DEFAULT_REPOSITORY_DISCOVERY_EXCLUSIONS = [
  '.worktrees',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.vite',
  '.parcel-cache',
  '.gradle',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'tmp',
  'temp',
] as const;

const REPOSITORY_SCANNER_EXCLUSION_NAME =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]*|\.[A-Za-z0-9][A-Za-z0-9._-]*)$/;

function isValidScannerExclusion(value: string): boolean {
  return (
    value === '__pycache__' ||
    (value !== '.git' &&
      value.length <= 100 &&
      REPOSITORY_SCANNER_EXCLUSION_NAME.test(value))
  );
}

export interface RepositoryDiscoveryOptions {
  maxDepth: number;
  exclusions: string[];
}

interface ScannedRepository {
  containerPath: string;
  originUrl?: string;
}

interface RepositoryDiscoveryEntry {
  relativePath: string;
  repositoryLocation?: string;
  workspacePath?: string;
  projectId?: string;
  name?: string;
  originUrl?: string;
  reason?: string;
}

export interface RepositoryDiscoveryReport {
  created: RepositoryDiscoveryEntry[];
  existing: RepositoryDiscoveryEntry[];
  ignored: RepositoryDiscoveryEntry[];
  ambiguous: RepositoryDiscoveryEntry[];
  missing: RepositoryDiscoveryEntry[];
}

export interface WorkspaceScanResult {
  repositories: ScannedRepository[];
  ignored: RepositoryDiscoveryEntry[];
  errors: RepositoryDiscoveryEntry[];
}

export function validateDiscoveryRequest(raw: unknown): string | undefined {
  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    return 'request body must be an object';
  }
  const body = isRecord(raw) ? raw : {};
  if (
    body.maxDepth !== undefined &&
    (typeof body.maxDepth !== 'number' ||
      !Number.isInteger(body.maxDepth) ||
      body.maxDepth < 1 ||
      body.maxDepth > MAX_REPOSITORY_DISCOVERY_DEPTH)
  ) {
    return `maxDepth must be an integer from 1 to ${MAX_REPOSITORY_DISCOVERY_DEPTH}`;
  }
  if (body.exclusions !== undefined) {
    if (
      !Array.isArray(body.exclusions) ||
      body.exclusions.length > 100 ||
      body.exclusions.some(
        (value) =>
          typeof value !== 'string' || !isValidScannerExclusion(value.trim()),
      )
    ) {
      return 'exclusions must contain at most 100 directory names, not paths';
    }
  }
  return undefined;
}

export function normalizeDiscoveryOptions(
  raw: unknown,
): RepositoryDiscoveryOptions {
  const body = isRecord(raw) ? raw : {};
  const requestedDepth =
    typeof body.maxDepth === 'number' && Number.isFinite(body.maxDepth)
      ? Math.floor(body.maxDepth)
      : DEFAULT_REPOSITORY_DISCOVERY_DEPTH;
  const maxDepth = Math.max(
    1,
    Math.min(MAX_REPOSITORY_DISCOVERY_DEPTH, requestedDepth),
  );
  const custom = Array.isArray(body.exclusions)
    ? body.exclusions
    : DEFAULT_REPOSITORY_DISCOVERY_EXCLUSIONS;
  const exclusions = new Set<string>();
  for (const value of custom) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    // Exclusions are directory names, never paths or shell fragments.
    if (isValidScannerExclusion(name)) {
      exclusions.add(name);
    }
  }
  return { maxDepth, exclusions: [...exclusions] };
}

/** Build the immutable CarapaBox scanner invocation. */
export function buildRepositoryScanCommand(
  containerRoot: string,
  options: RepositoryDiscoveryOptions,
): string {
  const args = [
    REPOSITORY_SCANNER_PATH,
    shellQuote(containerRoot),
    String(options.maxDepth),
  ];
  for (const name of options.exclusions) {
    args.push(shellQuote(name));
  }
  return args.join(' ');
}

function decodeProtocolField(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) return undefined;
  return decoded.toString('utf8');
}

export function parseRepositoryScanOutput(output: string): WorkspaceScanResult {
  const repositories: ScannedRepository[] = [];
  const ignored: RepositoryDiscoveryEntry[] = [];
  const errors: RepositoryDiscoveryEntry[] = [];
  if (output.includes('\0')) {
    const fields = output.split('\0');
    if (fields.at(-1) === '') fields.pop();
    for (const candidatePath of fields) {
      if (path.posix.isAbsolute(candidatePath)) {
        repositories.push({ containerPath: candidatePath });
      } else {
        errors.push({
          relativePath: candidatePath || '.',
          reason: 'Invalid repository scan record',
        });
      }
    }
    return { repositories, ignored, errors };
  }

  // Retain D1 parsing for output captured from older scanner versions.
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [version, kind, encodedPath, encodedDetail, ...extra] =
      line.split('\t');
    const candidatePath = decodeProtocolField(encodedPath);
    const detail = decodeProtocolField(encodedDetail);
    if (
      version !== 'D1' ||
      extra.length > 0 ||
      candidatePath === undefined ||
      detail === undefined
    ) {
      errors.push({
        relativePath: line,
        reason: 'Invalid repository scan record',
      });
    } else if (kind === 'C' && candidatePath) {
      repositories.push({ containerPath: candidatePath });
    } else if (kind === 'I' && candidatePath) {
      ignored.push({
        relativePath: candidatePath,
        reason: detail || 'ignored',
      });
    } else if (kind === 'A' && candidatePath) {
      errors.push({
        relativePath: candidatePath,
        reason: detail || 'Git metadata is inaccessible or invalid',
      });
    } else if (kind === 'E') {
      errors.push({
        relativePath: candidatePath || '.',
        reason: detail || 'Workspace scan failed',
      });
    } else {
      errors.push({
        relativePath: candidatePath || line,
        reason: 'Unknown repository scan record',
      });
    }
  }
  return { repositories, ignored, errors };
}

function repositoryScanExecutionFailure(output: string): WorkspaceScanResult {
  const detail = output.trim();
  return {
    repositories: [],
    ignored: [],
    errors: [
      {
        relativePath: '.',
        reason: detail || 'CarapaBox repository scanner execution failed',
      },
    ],
  };
}

export async function scanParentWorkspace(
  parent: RegisteredGroup,
  options: RepositoryDiscoveryOptions,
): Promise<WorkspaceScanResult> {
  const containerRoot = path.posix.normalize(
    parent.settings?.sharedWorkspaceContainerRoot || '/workspace',
  );
  const result = await execInGroupSandbox(
    parent.folder,
    buildRepositoryScanCommand(containerRoot, options),
    { timeout: 120 },
  );
  // sandbox_exec policy failures are MCP error text, not scanner protocol.
  // Parsing them would hide the useful CarapaBox denial behind a protocol error.
  if (result.isError)
    return repositoryScanExecutionFailure(result.stdout || '');
  const parsed = parseRepositoryScanOutput(result.stdout || '');
  const bounded: WorkspaceScanResult = {
    repositories: [],
    ignored: parsed.ignored,
    errors: [...parsed.errors],
  };
  for (const candidate of parsed.repositories) {
    if (isWithin(containerRoot, candidate.containerPath, true)) {
      bounded.repositories.push(candidate);
    } else {
      bounded.errors.push({
        relativePath: candidate.containerPath,
        reason:
          'Repository candidate resolved outside the configured workspace',
      });
    }
  }
  const resolved = await prepareGroupSandbox(parent.folder);
  const client = getSandboxClient();
  return inspectRepositoryCandidates(bounded, async (containerPath) => {
    const prefix = `-C ${shellQuote(containerPath)}`;
    const validation = await client.sandboxGit(
      resolved.stack,
      `${prefix} rev-parse --is-inside-work-tree`,
      resolved.instance,
      resolved.service,
    );
    if (validation.isError || validation.stdout.trim() !== 'true') {
      return {
        valid: false,
        error:
          validation.stdout.trim() || 'Git metadata is inaccessible or invalid',
      };
    }
    const origin = await client.sandboxGit(
      resolved.stack,
      `${prefix} config --get remote.origin.url`,
      resolved.instance,
      resolved.service,
    );
    return {
      valid: true,
      ...(!origin.isError && origin.stdout
        ? { originUrl: origin.stdout.replace(/\n$/, '') }
        : {}),
    };
  });
}

export async function inspectRepositoryCandidates(
  scan: WorkspaceScanResult,
  inspect: (
    containerPath: string,
  ) => Promise<{ valid: boolean; originUrl?: string; error?: string }>,
): Promise<WorkspaceScanResult> {
  const repositories: ScannedRepository[] = [];
  const errors = [...scan.errors];
  for (const candidate of scan.repositories) {
    try {
      const result = await inspect(candidate.containerPath);
      if (result.valid) {
        repositories.push({
          containerPath: candidate.containerPath,
          ...(result.originUrl ? { originUrl: result.originUrl } : {}),
        });
      } else {
        errors.push({
          relativePath: candidate.containerPath,
          reason: result.error || 'Git metadata is inaccessible or invalid',
        });
      }
    } catch (error) {
      errors.push({
        relativePath: candidate.containerPath,
        reason: `Git inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { repositories, ignored: scan.ignored, errors };
}

function isWithin(root: string, candidate: string, posix = false): boolean {
  const api = posix ? path.posix : path;
  const relative = api.relative(api.normalize(root), api.normalize(candidate));
  return (
    relative === '' || (!relative.startsWith('..') && !api.isAbsolute(relative))
  );
}

interface RegisteredRepositoryPaths {
  containerPaths: Set<string>;
  reportRelativePath?: string;
}

function relativeContainerPath(
  root: string,
  candidate: string,
): string | undefined {
  if (!isWithin(root, candidate, true)) return undefined;
  return path.posix.relative(root, path.posix.normalize(candidate)) || '.';
}

/** Resolve every supported representation of a registered repository. */
export function resolveRegisteredRepositoryPaths(
  group: RegisteredGroup,
  parent: RegisteredGroup,
): RegisteredRepositoryPaths {
  const hostRoot = path.normalize(
    parent.settings?.sharedWorkspaceHostLocation || '',
  );
  const containerRoot = path.posix.normalize(
    parent.settings?.sharedWorkspaceContainerRoot || '/workspace',
  );
  const isChild = group.parentId === parent.folder;
  const containerPaths = new Set<string>();
  let workspaceRelative: string | undefined;
  let metadataRelative: string | undefined;
  let hostRelative: string | undefined;

  const workspace = group.settings?.workspacePath?.trim();
  if (workspace && isChild) {
    const resolved = path.posix.isAbsolute(workspace)
      ? path.posix.normalize(workspace)
      : path.posix.resolve(containerRoot, workspace);
    if (!isWithin(containerRoot, resolved, true)) {
      const fallback = path.posix.join(containerRoot, group.folder);
      containerPaths.add(fallback);
      workspaceRelative = relativeContainerPath(containerRoot, fallback);
    } else {
      containerPaths.add(resolved);
      workspaceRelative = relativeContainerPath(containerRoot, resolved);
    }
  } else if (isChild) {
    // This is the same default used by computeEffectiveWorkspaceRoot().
    const fallback = path.posix.join(containerRoot, group.folder);
    containerPaths.add(fallback);
    workspaceRelative = relativeContainerPath(containerRoot, fallback);
  }

  if (isChild) {
    const relative = group.settings?.repositoryRelativePath?.trim();
    if (relative && !path.posix.isAbsolute(relative)) {
      const resolved = path.posix.resolve(containerRoot, relative);
      if (isWithin(containerRoot, resolved, true)) {
        containerPaths.add(resolved);
        metadataRelative = relativeContainerPath(containerRoot, resolved);
      }
    }
  }

  const location = group.settings?.repositoryLocation?.trim();
  if (location && hostRoot && isWithin(hostRoot, location)) {
    hostRelative =
      path
        .relative(hostRoot, path.normalize(location))
        .split(path.sep)
        .join('/') || '.';
    const resolved =
      hostRelative === '.'
        ? containerRoot
        : path.posix.resolve(containerRoot, hostRelative);
    if (isWithin(containerRoot, resolved, true)) containerPaths.add(resolved);
  }

  return {
    containerPaths,
    // Preserve explicit discovery metadata first, then host metadata, while
    // adding effective workspace/default semantics as the final fallback.
    reportRelativePath: metadataRelative || hostRelative || workspaceRelative,
  };
}

function uniqueSlug(
  baseName: string,
  parentFolder: string,
  used: Set<string>,
): string {
  // `main-` is reserved for per-user mains, so such a candidate counts as used.
  const taken = (slug: string) => used.has(slug) || isReservedMainFolder(slug);
  const base = slugify(baseName) || 'repository';
  if (!taken(base)) return base;
  let parentBase = `${slugify(parentFolder) || 'parent'}-${base}`;
  if (isReservedMainFolder(parentBase)) parentBase = `repo-${base}`;
  if (!taken(parentBase)) return parentBase;
  let suffix = 2;
  while (taken(`${parentBase}-${suffix}`)) suffix++;
  return `${parentBase}-${suffix}`;
}

function uniqueName(baseName: string, used: Set<string>): string {
  if (!used.has(baseName.toLowerCase())) return baseName;
  let suffix = 2;
  while (used.has(`${baseName} ${suffix}`.toLowerCase())) suffix++;
  return `${baseName} ${suffix}`;
}

export async function reconcileDiscoveredRepositories(args: {
  parent: RegisteredGroup;
  groups: RegisteredGroup[];
  scan: WorkspaceScanResult;
  create: (group: RegisteredGroup) => Promise<void>;
}): Promise<RepositoryDiscoveryReport> {
  const { parent, groups, scan, create } = args;
  const hostRoot = path.normalize(
    parent.settings?.sharedWorkspaceHostLocation || '',
  );
  const containerRoot = path.posix.normalize(
    parent.settings?.sharedWorkspaceContainerRoot || '/workspace',
  );
  const report: RepositoryDiscoveryReport = {
    created: [],
    existing: [],
    ignored: [...scan.ignored],
    ambiguous: [...scan.errors],
    missing: [],
  };
  const usedSlugs = new Set([
    ...RESERVED_PROJECT_FOLDERS,
    ...groups.map((group) => group.folder.toLowerCase()),
    // A configured sandbox instance is a name of its project too.
    ...groups.flatMap((group) => {
      const instance = group.settings?.defaultSandboxInstance?.trim();
      return instance ? [instance.toLowerCase()] : [];
    }),
  ]);
  const usedNames = new Set(groups.map((group) => group.name.toLowerCase()));
  const discoveredRelative = new Set<string>();

  for (const repository of scan.repositories) {
    if (!isWithin(containerRoot, repository.containerPath, true)) {
      report.ambiguous.push({
        relativePath: repository.containerPath,
        reason: 'Repository resolved outside the configured workspace',
      });
      continue;
    }
    const relativePath =
      path.posix.relative(
        containerRoot,
        path.posix.normalize(repository.containerPath),
      ) || '.';
    discoveredRelative.add(relativePath);
    const repositoryLocation =
      relativePath === '.'
        ? hostRoot
        : path.join(hostRoot, ...relativePath.split('/'));
    const normalizedRepositoryPath = path.posix.normalize(
      repository.containerPath,
    );
    const matches = groups.filter((group) =>
      resolveRegisteredRepositoryPaths(group, parent).containerPaths.has(
        normalizedRepositoryPath,
      ),
    );
    if (
      matches.length > 1 ||
      (matches.length === 1 && matches[0].parentId !== parent.folder)
    ) {
      report.ambiguous.push({
        relativePath,
        repositoryLocation,
        workspacePath: repository.containerPath,
        reason:
          matches.length > 1
            ? 'Multiple registered projects use this repository path'
            : `Repository is already registered outside parent ${parent.folder}`,
      });
      continue;
    }
    if (matches.length === 1) {
      report.existing.push({
        relativePath,
        repositoryLocation,
        workspacePath: repository.containerPath,
        projectId: matches[0].folder,
        name: matches[0].name,
        originUrl: repository.originUrl,
      });
      continue;
    }

    const baseName =
      path.posix.basename(repository.containerPath) || parent.name;
    const preferredFolder = slugify(baseName) || 'repository';
    const folder = uniqueSlug(baseName, parent.folder, usedSlugs);
    const name = uniqueName(baseName, usedNames);
    const collisionNotes = [
      folder !== preferredFolder
        ? `project ID "${preferredFolder}" was already in use`
        : '',
      name !== baseName ? `project name "${baseName}" was already in use` : '',
    ].filter(Boolean);
    usedSlugs.add(folder);
    usedNames.add(name.toLowerCase());
    // origin.url is read from the agent-writable repo config, so it is an
    // unverified suggestion only. Never persist it as repositoryUrl (the
    // trusted remote pin); an owner sets that through the owner-gated path.
    const group: RegisteredGroup = {
      name,
      folder,
      parentId: parent.folder,
      trigger: parent.trigger,
      added_at: new Date().toISOString(),
      user_id: parent.user_id,
      settings: {
        mode: 'chat',
        repositoryLocation,
        workspacePath: repository.containerPath,
        repositoryRelativePath: relativePath,
      },
    };
    try {
      await create(group);
      report.created.push({
        relativePath,
        repositoryLocation,
        workspacePath: repository.containerPath,
        projectId: folder,
        name,
        originUrl: repository.originUrl,
        ...(collisionNotes.length
          ? { reason: `Collision resolved: ${collisionNotes.join('; ')}` }
          : {}),
      });
    } catch (error) {
      report.ambiguous.push({
        relativePath,
        repositoryLocation,
        workspacePath: repository.containerPath,
        projectId: folder,
        name,
        reason: `Could not create project: ${String(error)}`,
      });
    }
  }

  for (const child of groups.filter(
    (group) => group.parentId === parent.folder,
  )) {
    const relative = resolveRegisteredRepositoryPaths(
      child,
      parent,
    ).reportRelativePath;
    if (relative && !discoveredRelative.has(relative)) {
      report.missing.push({
        relativePath: relative,
        repositoryLocation: child.settings?.repositoryLocation,
        workspacePath: child.settings?.workspacePath,
        projectId: child.folder,
        name: child.name,
        reason: 'Registered child repository was not found during this scan',
      });
    }
  }
  return report;
}
