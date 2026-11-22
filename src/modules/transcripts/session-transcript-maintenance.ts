import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  type PinnedDir,
  lstatAtSync,
  mkdirAtSync,
  openFileAtSync,
  openParentDirSync,
  readFileAtSync,
  readdirAtSync,
  removeAtSync,
  writeFileAtSync,
} from '../../lib/group-fs.js';
import {
  assertExtractedTreeRegular,
  assertRegularArchive,
  assertRegularArchiveMembers,
} from './archive-safety.js';
import { PinnedArchive, boardTranscriptTempRoot } from './archive-tar.js';
import { TRANSCRIPT_READ_LIMIT_BYTES } from './transcript-append-service.js';

const DAY_MS = 86_400_000;
const TAR_MAX_BUFFER = 64 * 1024 * 1024;

export interface SessionTranscriptMaintenanceOptions {
  groupsDir: string;
  archiveAfterDays?: number;
  deleteAfterDays?: number;
  apply?: boolean;
  now?: number;
}

interface SessionTranscriptDirectoryResult {
  directory: string;
  eligibleBundles: number;
  eligibleFiles: number;
  archivedBundles: number;
  archivedFiles: number;
  prunableArchives: number;
  prunedArchives: number;
  skippedIncompleteV1Bundles: string[];
  skippedFiles: string[];
}

export interface SessionTranscriptMaintenanceResult {
  mode: 'dry-run' | 'apply';
  groupsDir: string;
  archiveAfterDays: number;
  deleteAfterDays: number;
  directories: SessionTranscriptDirectoryResult[];
  errors: Array<{ path: string; error: string }>;
}

interface BundleFile {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

interface Bundle {
  id: string;
  files: BundleFile[];
  newestMtimeMs: number;
}

function assertDays(archiveAfterDays: number, deleteAfterDays: number): void {
  if (!Number.isInteger(archiveAfterDays) || archiveAfterDays < 1) {
    throw new Error('archiveAfterDays must be a positive integer');
  }
  if (
    !Number.isInteger(deleteAfterDays) ||
    deleteAfterDays <= archiveAfterDays
  ) {
    throw new Error(
      'deleteAfterDays must be an integer greater than archiveAfterDays',
    );
  }
}

function discoverSessionTranscriptDirectories(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'session-transcripts') {
        found.push(path.join(directory, entry.name));
        continue;
      }
      if (['archive', '.git', 'node_modules'].includes(entry.name)) continue;
      visit(path.join(directory, entry.name));
    }
  };
  visit(root);
  return found.sort();
}

function bundleId(fileName: string): string | null {
  const fixedSuffixes = [
    '.jsonl.transcript-index.json',
    '.v1.meta.json',
    '.v1.jsonl',
    '.prompt.txt',
    '.system.txt',
  ];
  for (const suffix of fixedSuffixes) {
    if (fileName.endsWith(suffix) && fileName.length > suffix.length) {
      return fileName.slice(0, -suffix.length);
    }
  }
  const rawMatch = fileName.match(/^(.*)\.[^.]+\.raw\.(?:jsonl|txt)$/);
  if (rawMatch?.[1]) return rawMatch[1];
  return fileName.endsWith('.jsonl') && fileName.length > '.jsonl'.length
    ? fileName.slice(0, -'.jsonl'.length)
    : null;
}

function readBundles(directory: string): {
  bundles: Bundle[];
  skippedFiles: string[];
} {
  const grouped = new Map<string, BundleFile[]>();
  const skippedFiles: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const id = bundleId(entry.name);
    if (!id) {
      if (!entry.name.startsWith('.')) skippedFiles.push(entry.name);
      continue;
    }
    const filePath = path.join(directory, entry.name);
    const stat = fs.statSync(filePath);
    const files = grouped.get(id) ?? [];
    files.push({
      name: entry.name,
      path: filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    grouped.set(id, files);
  }
  return {
    bundles: [...grouped.entries()].map(([id, files]) => {
      files.sort((left, right) => left.name.localeCompare(right.name));
      return {
        id,
        files,
        newestMtimeMs: files.reduce(
          (newest, file) => Math.max(newest, file.mtimeMs),
          -Infinity,
        ),
      };
    }),
    skippedFiles: skippedFiles.sort(),
  };
}

function hasIncompleteV1Pair(bundle: Bundle): boolean {
  let hasTranscript = false;
  let hasMetadata = false;
  for (const file of bundle.files) {
    if (file.name === `${bundle.id}.v1.jsonl`) hasTranscript = true;
    if (file.name === `${bundle.id}.v1.meta.json`) hasMetadata = true;
  }
  return hasTranscript !== hasMetadata;
}

function weekStart(mtimeMs: number): string {
  const date = new Date(mtimeMs);
  date.setUTCHours(0, 0, 0, 0);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function parseMembers(listing: string): string[] {
  return listing
    .split('\n')
    .map((member) => member.trim().replace(/^\.\//, ''))
    .filter(Boolean);
}

function assertSafeMembers(members: string[]): string[] {
  for (const member of members) {
    if (
      path.posix.isAbsolute(member) ||
      member === '..' ||
      member.startsWith('../') ||
      member.includes('/../')
    ) {
      throw new Error(`unsafe archive member: ${member}`);
    }
  }
  return members;
}

/** Check a board-owned bundle file (one built in board temp space). */
function assertSafeArchive(archivePath: string): string[] {
  const members = assertSafeMembers(
    parseMembers(
      execFileSync('tar', ['-tzf', archivePath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: TAR_MAX_BUFFER,
      }),
    ),
  );
  assertRegularArchive(archivePath);
  return members;
}

/** Check a bundle in the agent-writable archive/ through its pinned descriptor. */
function assertSafePinnedArchive(archive: PinnedArchive): string[] {
  const members = assertSafeMembers(
    parseMembers(archive.runSync(['-tzf', '-'], TAR_MAX_BUFFER).toString()),
  );
  assertRegularArchiveMembers(
    archive.runSync(['-tvzf', '-'], TAR_MAX_BUFFER).toString(),
  );
  return members;
}

function fsyncPinned(descriptor: number): void {
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw error;
  }
}

function fsyncDirectory(directory: PinnedDir): void {
  fsyncPinned(directory.fd);
}

function fileIsUnchanged(directory: PinnedDir, file: BundleFile): boolean {
  try {
    const stat = lstatAtSync(directory, file.name);
    return (
      !!stat &&
      stat.isFile() &&
      stat.size === file.size &&
      stat.mtimeMs === file.mtimeMs
    );
  } catch {
    return false;
  }
}

/**
 * Add `bundles` to the weekly archive. The session directory and its
 * `archive/` are agent-writable, so both are pinned and every read, write and
 * delete goes through them; tar reads the existing bundle from a pinned
 * descriptor and unpacks/packs only in board temp space.
 */
function installArchive(
  archivePath: string,
  bundles: Bundle[],
): { bundles: number; files: number } {
  const archiveName = path.basename(archivePath);
  const directory = path.dirname(path.dirname(archivePath));
  const session = openParentDirSync(path.join(directory, 'x'));
  if (!session) throw new Error(`directory not found: ${directory}`);
  let archiveDirectory: PinnedDir | null = null;
  let work: string | null = null;
  try {
    // A symlinked archive/ is refused, never followed.
    archiveDirectory = mkdirAtSync(session.dir, 'archive');
    fs.mkdirSync(boardTranscriptTempRoot(), { recursive: true });
    work = fs.mkdtempSync(path.join(boardTranscriptTempRoot(), 'maintenance-'));
    const staging = path.join(work, 'staging');
    fs.mkdirSync(staging);
    const candidate = path.join(work, 'candidate.tar.gz');

    // The existing bundle must be a plain file holding only regular, safely
    // named members before it is unpacked.
    const existing = PinnedArchive.openSync(archiveDirectory, archiveName);
    if (existing) {
      try {
        assertSafePinnedArchive(existing);
        existing.runSync(['-xzf', '-', '-C', staging], TAR_MAX_BUFFER);
      } finally {
        existing.closeSync();
      }
      assertExtractedTreeRegular(staging);
    }
    const files = bundles.flatMap((bundle) => bundle.files);
    for (const file of files) {
      if (!fileIsUnchanged(session.dir, file)) {
        throw new Error(`source changed during archival: ${file.path}`);
      }
      const read = readFileAtSync(session.dir, file.name, {
        maxBytes: TRANSCRIPT_READ_LIMIT_BYTES,
      });
      if (!read)
        throw new Error(`source changed during archival: ${file.path}`);
      const member = path.join(staging, file.name);
      fs.rmSync(member, { force: true });
      fs.writeFileSync(member, read.data, { flag: 'wx' });
    }
    execFileSync('tar', ['-czf', candidate, '-C', staging, '.'], {
      stdio: 'ignore',
    });
    const installedMembers = new Set(assertSafeArchive(candidate));
    for (const file of files) {
      if (!installedMembers.has(file.name)) {
        throw new Error(`candidate archive is missing ${file.name}`);
      }
    }
    // Atomic replace of the bundle in the pinned archive directory.
    writeFileAtSync(archiveDirectory, archiveName, fs.readFileSync(candidate));
    const installed = openFileAtSync(archiveDirectory, archiveName);
    if (installed) {
      try {
        fsyncPinned(installed.fd);
      } finally {
        fs.closeSync(installed.fd);
      }
    }
    fsyncDirectory(archiveDirectory);
    for (const file of files) {
      if (!fileIsUnchanged(session.dir, file)) {
        throw new Error(`source changed before deletion: ${file.path}`);
      }
    }
    for (const file of files) {
      removeAtSync(session.dir, file.name);
    }
    fsyncDirectory(session.dir);
    return { bundles: bundles.length, files: files.length };
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true });
    archiveDirectory?.closeSync();
    session.dir.closeSync();
  }
}

/** Delete expired, verified bundles from `directory`/archive through the pinned archive dir. */
function pruneExpiredArchives(
  directory: string,
  cutoffMs: number,
  apply: boolean,
  directoryResult: SessionTranscriptDirectoryResult,
  errors: SessionTranscriptMaintenanceResult['errors'],
): void {
  const archivePath = path.join(directory, 'archive');
  let pinned: ReturnType<typeof openParentDirSync>;
  try {
    pinned = openParentDirSync(path.join(archivePath, 'x'));
  } catch (error) {
    errors.push({ path: archivePath, error: String(error) });
    return;
  }
  if (!pinned) return;
  const archiveDirectory = pinned.dir;
  try {
    for (const entry of readdirAtSync(archiveDirectory, undefined, {
      withFileTypes: true,
    }) ?? []) {
      if (!entry.isFile() || !entry.name.endsWith('.tar.gz')) continue;
      const bundlePath = path.join(archivePath, entry.name);
      let archive: PinnedArchive | null = null;
      try {
        archive = PinnedArchive.openSync(archiveDirectory, entry.name);
        if (!archive || archive.stat.mtimeMs >= cutoffMs) continue;
        directoryResult.prunableArchives += 1;
        assertSafePinnedArchive(archive);
        if (apply) {
          removeAtSync(archiveDirectory, entry.name);
          fsyncDirectory(archiveDirectory);
          directoryResult.prunedArchives += 1;
        }
      } catch (error) {
        errors.push({ path: bundlePath, error: String(error) });
      } finally {
        archive?.closeSync();
      }
    }
  } finally {
    archiveDirectory.closeSync();
  }
}

export function maintainSessionTranscripts(
  options: SessionTranscriptMaintenanceOptions,
): SessionTranscriptMaintenanceResult {
  const groupsDir = path.resolve(options.groupsDir);
  const archiveAfterDays = options.archiveAfterDays ?? 7;
  const deleteAfterDays = options.deleteAfterDays ?? 30;
  const apply = options.apply === true;
  const now = options.now ?? Date.now();
  assertDays(archiveAfterDays, deleteAfterDays);
  const result: SessionTranscriptMaintenanceResult = {
    mode: apply ? 'apply' : 'dry-run',
    groupsDir,
    archiveAfterDays,
    deleteAfterDays,
    directories: [],
    errors: [],
  };

  for (const directory of discoverSessionTranscriptDirectories(groupsDir)) {
    const { bundles, skippedFiles } = readBundles(directory);
    const incomplete: Bundle[] = [];
    const eligible: Bundle[] = [];
    let eligibleFiles = 0;
    for (const bundle of bundles) {
      if (hasIncompleteV1Pair(bundle)) {
        incomplete.push(bundle);
        result.errors.push({
          path: path.join(directory, bundle.id),
          error: 'incomplete V1 transcript pair; bundle retained live',
        });
      } else if (bundle.newestMtimeMs < now - archiveAfterDays * DAY_MS) {
        eligible.push(bundle);
        eligibleFiles += bundle.files.length;
      }
    }
    const byWeek = new Map<string, Bundle[]>();
    for (const bundle of eligible) {
      const key = weekStart(bundle.newestMtimeMs);
      const weekBundles = byWeek.get(key);
      if (weekBundles) weekBundles.push(bundle);
      else byWeek.set(key, [bundle]);
    }
    const archiveDirectory = path.join(directory, 'archive');
    const directoryResult: SessionTranscriptDirectoryResult = {
      directory,
      eligibleBundles: eligible.length,
      eligibleFiles,
      archivedBundles: 0,
      archivedFiles: 0,
      prunableArchives: 0,
      prunedArchives: 0,
      skippedIncompleteV1Bundles: incomplete.map((bundle) => bundle.id),
      skippedFiles,
    };

    if (apply) {
      for (const [week, weekBundles] of byWeek) {
        const archivePath = path.join(
          archiveDirectory,
          `week-of-${week}.tar.gz`,
        );
        try {
          const archived = installArchive(archivePath, weekBundles);
          directoryResult.archivedBundles += archived.bundles;
          directoryResult.archivedFiles += archived.files;
        } catch (error) {
          result.errors.push({ path: archivePath, error: String(error) });
        }
      }
    }

    pruneExpiredArchives(
      directory,
      now - deleteAfterDays * DAY_MS,
      apply,
      directoryResult,
      result.errors,
    );
    if (
      directoryResult.eligibleBundles > 0 ||
      directoryResult.prunableArchives > 0 ||
      directoryResult.skippedIncompleteV1Bundles.length > 0 ||
      directoryResult.skippedFiles.length > 0
    ) {
      result.directories.push(directoryResult);
    }
  }
  return result;
}
