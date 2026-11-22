import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import {
  type PinnedDir,
  lstatAtSync,
  openParentDir,
  openParentDirSync,
  readdirAt,
  readdirAtSync,
} from '../../lib/group-fs.js';
import { logger } from '../../logger.js';
import { PinnedArchive, TAR_OUTPUT_CAP_BYTES } from './archive-tar.js';
import {
  isTranscriptLockHeldInProcess,
  replaceTranscriptUnderLock,
  withTranscriptLock,
  withTranscriptLockSync,
} from './transcript-append-service.js';

// Transcript files routinely exceed the child-process default maxBuffer.
const EXTRACT_MAX_BUFFER = TAR_OUTPUT_CAP_BYTES;

/**
 * Shared round-trip restore primitive used by task, chat, and objective
 * transcript types. When `livePath` is missing, scan the archive directory
 * newest-first and try each candidate member name; the first hit is parsed
 * as JSONL and written back to `livePath`. After the first successful
 * restore, the live file exists and subsequent calls hit the
 * `fs.existsSync` fast path without re-extracting.
 *
 * The daily archive sweep names bundles `YYYY-MM-DD.tar.gz` by file mtime and
 * never removes older copies of a member from earlier bundles, so the newest
 * bundle holding a non-empty member is the only authoritative copy. The scan
 * therefore always walks date-named bundles newest-first (non-date bundles
 * such as `legacy-bot-*.tar.gz` only after all of them); `minArchiveName`
 * (the transcript's creation-date bundle) is merely the lower bound of that
 * scan. To keep the walk cheap, the bundle is chosen from a per-process
 * cached member list and only the chosen bundle is extracted.
 *
 * Best-effort: never throws. A missing archive, a listing or extract error,
 * a member-name mismatch, or a corrupt tarball is a miss for that bundle and
 * leaves `livePath` untouched, so the caller sees the same empty/missing
 * state it would have without the restore.
 *
 * This module is intentionally standalone (no `group-dir.ts` dependency) so
 * both `group-dir.ts` (chat reads/append) and `transcript-store.ts` (task
 * + objective restore) can depend on it without a static import cycle.
 */
export function restoreFromArchiveIfMissing(
  archiveDir: string,
  livePath: string,
  candidateMemberNames: string[],
  minArchiveName?: string | null,
): boolean {
  if (liveFileHasContent(livePath)) return false;
  // An in-process async writer owns and is producing this file; a sync caller
  // cannot wait for it, and restoring underneath it would be wrong anyway.
  if (isTranscriptLockHeldInProcess(livePath)) return false;
  try {
    return withTranscriptLockSync(livePath, () =>
      restoreFromArchiveIfMissingUnderLock(
        archiveDir,
        livePath,
        candidateMemberNames,
        minArchiveName,
      ),
    );
  } catch {
    // Lock acquisition refuses a swapped or linked transcripts directory.
    return false;
  }
}

/** Same restore operation for callers that already own `livePath`'s lock. */
export function restoreFromArchiveIfMissingUnderLock(
  archiveDir: string,
  livePath: string,
  candidateMemberNames: string[],
  minArchiveName?: string | null,
): boolean {
  if (liveFileHasContent(livePath)) return false;
  const expandedMemberNames = expandCandidateMemberNames(candidateMemberNames);
  if (expandedMemberNames.length === 0) return false;
  const dir = openArchiveDirSync(archiveDir);
  if (!dir) return false;
  try {
    const archives = orderArchives(readdirAtSync(dir) ?? [], minArchiveName);
    for (const archive of archives) {
      if (
        tryExtractFromArchive(
          dir,
          archiveDir,
          archive,
          expandedMemberNames,
          livePath,
        )
      ) {
        return true;
      }
    }
  } catch {
    return false;
  } finally {
    dir.closeSync();
  }
  return false;
}

/**
 * Promise API for async request paths. The shared lock is still held across
 * the restore so a concurrent writer cannot recreate the live file, but the
 * archive lookup and tar extraction yield while waiting on child processes.
 */
export async function restoreFromArchiveIfMissingAsync(
  archiveDir: string,
  livePath: string,
  candidateMemberNames: string[],
  minArchiveName?: string | null,
): Promise<boolean> {
  if (liveFileHasContent(livePath)) return false;
  try {
    return await withTranscriptLock(livePath, () =>
      restoreFromArchiveIfMissingUnderLockAsync(
        archiveDir,
        livePath,
        candidateMemberNames,
        minArchiveName,
      ),
    );
  } catch {
    // Lock acquisition refuses a swapped or linked transcripts directory.
    return false;
  }
}

/**
 * Async counterpart for HTTP/background readers. The synchronous restore
 * primitive is still used by startup and sync writers, but using it here
 * would execute tar synchronously while the Board's event loop is handling a
 * request. A history preview can touch hundreds of archived conversations,
 * so that otherwise turns an ordinary read into a gateway timeout.
 */
async function restoreFromArchiveIfMissingUnderLockAsync(
  archiveDir: string,
  livePath: string,
  candidateMemberNames: string[],
  minArchiveName?: string | null,
): Promise<boolean> {
  if (liveFileHasContent(livePath)) return false;
  const expandedMemberNames = expandCandidateMemberNames(candidateMemberNames);
  if (expandedMemberNames.length === 0) return false;
  const dir = await openArchiveDir(archiveDir);
  if (!dir) return false;
  try {
    const archives = orderArchives(
      (await readdirAt(dir)) ?? [],
      minArchiveName,
    );
    for (const archive of archives) {
      if (
        await tryExtractFromArchiveAsync(
          dir,
          archiveDir,
          archive,
          expandedMemberNames,
          livePath,
        )
      ) {
        return true;
      }
    }
  } catch {
    return false;
  } finally {
    await dir.close();
  }
  return false;
}

const DATE_BUNDLE_PATTERN = /^\d{4}-\d{2}-\d{2}\.tar\.gz$/;

/**
 * Newest-first scan order: date-named bundles first, then any other bundle
 * (e.g. `legacy-bot-*.tar.gz`, which would otherwise sort as the newest).
 */
function orderArchives(
  files: string[],
  minArchiveName?: string | null,
): string[] {
  const newestFirst = files
    .filter((file) => shouldTryArchive(file, minArchiveName))
    .sort()
    .reverse();
  return [
    ...newestFirst.filter((file) => DATE_BUNDLE_PATTERN.test(file)),
    ...newestFirst.filter((file) => !DATE_BUNDLE_PATTERN.test(file)),
  ];
}

function shouldTryArchive(
  fileName: string,
  minArchiveName?: string | null,
): boolean {
  if (!fileName.endsWith('.tar.gz')) return false;
  if (!minArchiveName) return true;
  return fileName >= minArchiveName;
}

function expandCandidateMemberNames(names: string[]): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    for (const candidate of [name, `./${name}`]) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        expanded.push(candidate);
      }
    }
  }
  return expanded;
}

/** Whether `livePath` is a regular file with content, looked up through its pinned parent. */
function liveFileHasContent(livePath: string): boolean {
  try {
    const parent = openParentDirSync(livePath);
    if (!parent) return false;
    try {
      const stat = lstatAtSync(parent.dir, parent.name);
      return !!stat && stat.isFile() && stat.size > 0;
    } finally {
      parent.dir.closeSync();
    }
  } catch {
    return false;
  }
}

function validJsonlLines(content: string): {
  lines: string[];
  malformedLines: number;
  firstMalformedLine?: string;
} {
  const lines: string[] = [];
  let malformedLines = 0;
  let firstMalformedLine: string | undefined;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      lines.push(line);
    } catch {
      malformedLines++;
      firstMalformedLine ??= line.slice(0, 300);
    }
  }
  return { lines, malformedLines, firstMalformedLine };
}

/**
 * The archive directory is agent-writable: pin it without following links
 * (a symlinked `archive/` is refused). A missing directory is a normal miss;
 * anything else is logged and skipped.
 */
function archiveDirFailed(archiveDir: string, err: unknown): null {
  logger.warn(
    { archiveDir, error: String(err) },
    'Refusing to restore from an archive directory that cannot be opened safely',
  );
  return null;
}

function openArchiveDirSync(archiveDir: string): PinnedDir | null {
  try {
    return openParentDirSync(path.join(archiveDir, 'x'))?.dir ?? null;
  } catch (err) {
    return archiveDirFailed(archiveDir, err);
  }
}

async function openArchiveDir(archiveDir: string): Promise<PinnedDir | null> {
  try {
    return (await openParentDir(path.join(archiveDir, 'x')))?.dir ?? null;
  } catch (err) {
    return archiveDirFailed(archiveDir, err);
  }
}

/**
 * The bundle is agent-writable: open it through the pinned archive directory
 * as a plain file (not a symlink to another project's bundle). A missing
 * bundle is a normal miss; anything else is logged and skipped.
 */
function bundleRefused(tarPath: string, err: unknown): null {
  memberListCache.delete(tarPath);
  logger.warn(
    { tarPath, error: String(err) },
    'Refusing to restore from an archive that is not a regular file inside its transcripts directory',
  );
  return null;
}

function openBundleSync(dir: PinnedDir, tarPath: string): PinnedArchive | null {
  try {
    const archive = PinnedArchive.openSync(dir, path.basename(tarPath));
    if (!archive) memberListCache.delete(tarPath);
    return archive;
  } catch (err) {
    return bundleRefused(tarPath, err);
  }
}

async function openBundle(
  dir: PinnedDir,
  tarPath: string,
): Promise<PinnedArchive | null> {
  try {
    const archive = await PinnedArchive.open(dir, path.basename(tarPath));
    if (!archive) memberListCache.delete(tarPath);
    return archive;
  } catch (err) {
    return bundleRefused(tarPath, err);
  }
}

/**
 * Try to extract the transcript JSONL from a single tarball. Returns true
 * on a successful restore (non-empty content was written), false on a
 * miss (archive missing, member absent, or member empty). The caller
 * treats a miss as a signal to try the next, older bundle.
 */
function tryExtractFromArchive(
  dir: PinnedDir,
  archiveDir: string,
  archiveName: string,
  candidateMemberNames: string[],
  livePath: string,
): boolean {
  const tarPath = path.join(archiveDir, archiveName);
  const archive = openBundleSync(dir, tarPath);
  if (!archive) return false;
  try {
    const members = selectArchiveMembers(
      listArchiveMembersCached(tarPath, archive),
      candidateMemberNames,
    );
    return members.length > 0
      ? tryExtractMemberFromArchive(tarPath, archive, members, livePath)
      : false;
  } finally {
    archive.closeSync();
  }
}

async function tryExtractFromArchiveAsync(
  dir: PinnedDir,
  archiveDir: string,
  archiveName: string,
  candidateMemberNames: string[],
  livePath: string,
): Promise<boolean> {
  const tarPath = path.join(archiveDir, archiveName);
  const archive = await openBundle(dir, tarPath);
  if (!archive) return false;
  try {
    const members = selectArchiveMembers(
      await listArchiveMembersCachedAsync(tarPath, archive),
      candidateMemberNames,
    );
    return members.length > 0
      ? await tryExtractMemberFromArchiveAsync(
          tarPath,
          archive,
          members,
          livePath,
        )
      : false;
  } finally {
    await archive.close();
  }
}

/**
 * Read one member from the pinned bundle (`tar -xzf - -O`, stdout captured in
 * memory up to the extraction cap) and install its valid JSONL lines as
 * `livePath` through the pinned append service. Nothing is written beside the
 * live transcript. Returns false for a miss (empty or invalid member, tar
 * failure), logging the reason.
 */
function installArchivedMember(
  tarPath: string,
  fileName: string,
  output: Buffer,
  livePath: string,
): boolean {
  const content = output.toString('utf8');
  if (!content) {
    logger.warn(
      { tarPath, memberName: fileName },
      'transcript archive member extracted empty content',
    );
    return false;
  }
  const { lines, malformedLines, firstMalformedLine } =
    validJsonlLines(content);
  if (lines.length === 0) {
    logger.warn(
      {
        tarPath,
        memberName: fileName,
        outputBytes: output.length,
        malformedLines,
        firstMalformedLine,
      },
      'transcript archive member contained no valid JSONL lines',
    );
    return false;
  }
  // Re-write the live file with one JSON object per line.
  replaceTranscriptUnderLock(livePath, lines.join('\n') + '\n');
  return true;
}

function logExtractFailure(
  tarPath: string,
  fileName: string,
  err: unknown,
): void {
  logger.warn(
    { tarPath, memberName: fileName, error: String(err) },
    'transcript archive member extract failed',
  );
}

const EXTRACT_MEMBER_ARGS = ['-xzf', '-', '-O', '--'];

function tryExtractMemberFromArchive(
  tarPath: string,
  archive: PinnedArchive,
  memberNames: string[],
  livePath: string,
): boolean {
  for (const fileName of memberNames) {
    if (!isSafeArchiveMember(fileName)) continue;
    try {
      const output = archive.runSync(
        [...EXTRACT_MEMBER_ARGS, fileName],
        EXTRACT_MAX_BUFFER,
      );
      if (installArchivedMember(tarPath, fileName, output, livePath)) {
        return true;
      }
    } catch (err) {
      logExtractFailure(tarPath, fileName, err);
    }
  }
  return false;
}

async function tryExtractMemberFromArchiveAsync(
  tarPath: string,
  archive: PinnedArchive,
  memberNames: string[],
  livePath: string,
): Promise<boolean> {
  for (const fileName of memberNames) {
    if (!isSafeArchiveMember(fileName)) continue;
    try {
      const output = await archive.run(
        [...EXTRACT_MEMBER_ARGS, fileName],
        EXTRACT_MAX_BUFFER,
      );
      // Keep the caller's lock while installing the validated transcript.
      // The expensive archive lookup/extraction above has already yielded.
      if (installArchivedMember(tarPath, fileName, output, livePath)) {
        return true;
      }
    } catch (err) {
      logExtractFailure(tarPath, fileName, err);
    }
  }
  return false;
}

/**
 * Member lists are cached per process, keyed by bundle path and validated
 * against (inode, size, mtime): an unchanged bundle is listed (gunzipped) at
 * most once, and a rewritten or replaced bundle is listed again. Entries are
 * kept for the life of the process (bounded by the number of bundle files, a
 * name list each) and dropped when their bundle disappears. Failed listings
 * are never cached so a transient error is retried.
 */
interface ArchiveSignature {
  ino: number;
  size: number;
  mtimeMs: number;
}

const memberListCache = new Map<
  string,
  { signature: ArchiveSignature; members: string[] }
>();

function archiveSignature(archive: PinnedArchive): ArchiveSignature {
  const { ino, size, mtimeMs } = archive.stat;
  return { ino, size, mtimeMs };
}

function cachedMemberList(
  tarPath: string,
  signature: ArchiveSignature,
): string[] | null {
  const hit = memberListCache.get(tarPath);
  return hit && sameSignature(hit.signature, signature) ? hit.members : null;
}

function sameSignature(a: ArchiveSignature, b: ArchiveSignature): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function cacheMemberList(
  tarPath: string,
  signature: ArchiveSignature,
  members: string[],
): void {
  memberListCache.set(tarPath, { signature, members });
}

/**
 * An async listing runs `tar -tzf` once and writes the result to a temp file
 * (`<out>` on success, `<out>.failed` on failure; the success file appears
 * atomically via rename). Async callers for the same unchanged bundle share
 * its promise. A synchronous caller cannot await a promise, so it waits on
 * the temp file instead of launching a second `tar -tzf` for the bundle.
 */
interface InflightListing {
  signature: ArchiveSignature;
  listing: Promise<string[]>;
  outFile: string;
}

const inflightMemberLists = new Map<string, InflightListing>();
const LISTING_SCRIPT =
  'tar -tzf - > "$1.part" 2>/dev/null && mv "$1.part" "$1" || : > "$1.failed"';
const LISTING_SYNC_WAIT_MAX_MS = 30_000;
const LISTING_SYNC_POLL_MS = 5;

function readListingFile(tarPath: string, outFile: string): string[] | null {
  try {
    return parseArchiveMemberList(fs.readFileSync(outFile, 'utf8'), tarPath);
  } catch {
    return null;
  }
}

function startAsyncListing(
  tarPath: string,
  archive: PinnedArchive,
  signature: ArchiveSignature,
): InflightListing | null {
  const outFile = path.join(
    os.tmpdir(),
    `archive-listing-${process.pid}-${randomUUID()}`,
  );
  let child: ReturnType<typeof spawn>;
  // The listing reads the pinned bundle from stdin; the child owns its own
  // copy of the descriptor once spawn() returns.
  const stdin = archive.openStdin();
  try {
    child = spawn('sh', ['-c', LISTING_SCRIPT, 'sh', outFile], {
      stdio: [stdin, 'ignore', 'ignore'],
    });
  } catch {
    return null; // synchronous spawn failure: a miss for this bundle
  } finally {
    fs.closeSync(stdin);
  }
  // Attach the handlers before anything else: a failed spawn (e.g. EAGAIN)
  // reports through an asynchronous 'error' event that must not go unhandled.
  const listing = new Promise<string[]>((resolve) => {
    const finish = () => {
      const members =
        cachedMemberList(tarPath, signature) ??
        readListingFile(tarPath, outFile);
      for (const file of [outFile, `${outFile}.part`, `${outFile}.failed`]) {
        fs.rmSync(file, { force: true });
      }
      if (members) cacheMemberList(tarPath, signature, members);
      if (inflightMemberLists.get(tarPath)?.outFile === outFile) {
        inflightMemberLists.delete(tarPath);
      }
      resolve(members ?? []);
    };
    child.once('error', finish);
    child.once('close', finish);
  });
  // Without a pid nothing is running; the 'error' event above just cleans up.
  if (!child.pid) return null;
  const entry = { signature, listing, outFile };
  inflightMemberLists.set(tarPath, entry);
  return entry;
}

function matchingInflightListing(
  tarPath: string,
  signature: ArchiveSignature,
): InflightListing | null {
  const inflight = inflightMemberLists.get(tarPath);
  return inflight && sameSignature(inflight.signature, signature)
    ? inflight
    : null;
}

/** Block until a running async listing finishes; null when it never does. */
function waitForInflightListing(
  tarPath: string,
  inflight: InflightListing,
): string[] | null {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + LISTING_SYNC_WAIT_MAX_MS;
  while (Date.now() < deadline) {
    const members = readListingFile(tarPath, inflight.outFile);
    if (members) {
      cacheMemberList(tarPath, inflight.signature, members);
      return members;
    }
    if (fs.existsSync(`${inflight.outFile}.failed`)) return [];
    Atomics.wait(sleeper, 0, 0, LISTING_SYNC_POLL_MS);
  }
  return null;
}

function listArchiveMembersCached(
  tarPath: string,
  archive: PinnedArchive,
): string[] {
  const signature = archiveSignature(archive);
  const cached = cachedMemberList(tarPath, signature);
  if (cached) return cached;
  const inflight = matchingInflightListing(tarPath, signature);
  const awaited = inflight ? waitForInflightListing(tarPath, inflight) : null;
  if (awaited) return awaited;
  try {
    const list = archive.runSync(['-tzf', '-'], EXTRACT_MAX_BUFFER);
    const members = parseArchiveMemberList(list.toString('utf8'), tarPath);
    cacheMemberList(tarPath, signature, members);
    return members;
  } catch {
    return [];
  }
}

function listArchiveMembersCachedAsync(
  tarPath: string,
  archive: PinnedArchive,
): Promise<string[]> {
  const signature = archiveSignature(archive);
  const cached = cachedMemberList(tarPath, signature);
  if (cached) return Promise.resolve(cached);
  const inflight =
    matchingInflightListing(tarPath, signature) ??
    startAsyncListing(tarPath, archive, signature);
  return inflight ? inflight.listing : Promise.resolve([]);
}

/**
 * Archive member names come from an agent-writable tarball. Reject any name
 * that tar could read as an option (leading `-`), that escapes the archive
 * root (absolute path or `..` segment), or that contains NUL.
 */
function isSafeArchiveMember(name: string): boolean {
  if (!name || name.startsWith('-') || name.includes('\0')) return false;
  if (name.startsWith('/')) return false;
  return !name.split(/[\\/]/).includes('..');
}

function parseArchiveMemberList(list: string, tarPath: string): string[] {
  const members = list
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const safe = members.filter(isSafeArchiveMember);
  if (safe.length !== members.length) {
    logger.warn(
      { tarPath, skippedMembers: members.length - safe.length },
      'Skipping unsafe transcript archive member names',
    );
  }
  return safe;
}

/**
 * Members of one bundle to try, in order: exact candidate names present in the
 * listing, then the first fuzzy basename match.
 */
function selectArchiveMembers(
  archiveMembers: string[],
  candidateMemberNames: string[],
): string[] {
  const present = new Set(archiveMembers);
  const selected = candidateMemberNames.filter((name) => present.has(name));
  const fuzzyMember = selectFuzzyArchiveMemberFromList(
    archiveMembers,
    candidateMemberNames,
  );
  if (fuzzyMember && !selected.includes(fuzzyMember)) {
    selected.push(fuzzyMember);
  }
  return selected;
}

function selectFuzzyArchiveMemberFromList(
  archiveMembers: string[],
  candidateMemberNames: string[],
): string | null {
  const suffixes = fuzzyBasenameSuffixes(candidateMemberNames);
  if (suffixes.length === 0) return null;

  for (const member of archiveMembers) {
    if (!member.endsWith('.jsonl')) continue;
    const base = path.basename(member);
    if (suffixes.some((suffix) => base === suffix || base.endsWith(suffix))) {
      return member;
    }
  }
  return null;
}

function fuzzyBasenameSuffixes(candidateMemberNames: string[]): string[] {
  const suffixes: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidateMemberNames) {
    const base = path.basename(candidate.replace(/^\.\//, ''));
    if (!base.endsWith('.jsonl')) continue;
    for (const suffix of [base, base.replace(/^\d{4}-\d{2}-\d{2}-/, '')]) {
      if (suffix && !seen.has(suffix)) {
        seen.add(suffix);
        suffixes.push(suffix);
      }
    }
  }
  return suffixes;
}
