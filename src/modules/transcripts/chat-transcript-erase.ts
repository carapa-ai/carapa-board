import fs from 'node:fs';
import path from 'node:path';

import { chatArchiveMemberNames, getGroupDir } from '../../group-dir.js';
import {
  type PinnedDir,
  openDirAt,
  openGroupDir,
  readdirAt,
  removeAt,
  writeFileAt,
} from '../../lib/group-fs.js';
import { assertExtractedTreeRegular } from './archive-safety.js';
import {
  PinnedArchive,
  assertPinnedArchiveRegular,
  extractPinnedArchive,
  listArchiveMemberNames,
  listTarFileMemberNames,
  makeBoardTranscriptTempDir,
  runTar,
} from './archive-tar.js';
import {
  deleteTranscriptUnderLockAsync,
  withTranscriptLocks,
} from './transcript-append-service.js';

/**
 * Rewrite one daily bundle without the given member names. Removes the bundle
 * when nothing else remains. Throws (fails closed) when the bundle is not a
 * plain regular file in the pinned archive directory, holds a non-regular
 * member, cannot be listed, unpacked or repacked, or the repacked bundle does
 * not hold exactly the surviving members. The caller holds the bundle's lock.
 *
 * tar reads the bundle from a pinned descriptor and unpacks/packs only in
 * board temp space; the rebuilt bundle replaces the original atomically, so a
 * failed erase leaves the original in place.
 */
async function scrubBundle(
  aDir: PinnedDir,
  bundleName: string,
  memberNames: ReadonlySet<string>,
): Promise<void> {
  // The bundle is agent-writable: refuse symlinks and any non-regular member
  // before reading or unpacking it.
  const archive = await PinnedArchive.open(aDir, bundleName);
  if (!archive) return;
  try {
    await assertPinnedArchiveRegular(archive);
    if (
      !(await listArchiveMemberNames(archive)).some((name) =>
        memberNames.has(name),
      )
    ) {
      return;
    }

    const work = await makeBoardTranscriptTempDir('erase-');
    try {
      const members = path.join(work, 'members');
      await fs.promises.mkdir(members);
      await extractPinnedArchive(archive, members);
      assertExtractedTreeRegular(members);
      for (const name of memberNames) {
        await fs.promises.rm(path.join(members, name), { force: true });
      }
      const remaining = (await fs.promises.readdir(members)).sort();
      if (remaining.length === 0) {
        await removeAt(aDir, bundleName);
        return;
      }
      // Member names come from the agent-writable bundle: `--` keeps a name
      // such as `--exclude=...` from being parsed as a tar option, and the
      // listing check rejects any other name that tar interprets instead of
      // storing.
      const rebuilt = path.join(work, 'bundle.tar.gz');
      await runTar(
        ['-czf', rebuilt, '-C', members, '--', ...remaining],
        'ignore',
      );
      const written = (await listTarFileMemberNames(rebuilt)).sort();
      if (
        written.length !== remaining.length ||
        written.some((name, i) => name !== remaining[i])
      ) {
        throw new Error(
          `repacked bundle does not match its members: ${bundleName}`,
        );
      }
      // Never truncate the bundle in place: it may be the only copy of other
      // conversations' transcripts. The atomic write replaces it only now.
      await writeFileAt(aDir, bundleName, await fs.promises.readFile(rebuilt));
    } finally {
      await fs.promises.rm(work, { recursive: true, force: true });
    }
  } finally {
    await archive.close();
  }
}

async function listBundles(aDir: PinnedDir | null): Promise<string[]> {
  if (!aDir) return [];
  return ((await readdirAt(aDir)) ?? [])
    .filter((file) => file.endsWith('.tar.gz'))
    .sort();
}

/**
 * Permanently erase the named transcript files: the live JSONL file(s) in
 * `transcripts/` plus every copy archived into `transcripts/archive/*.tar.gz`.
 * Other transcripts' files and archive members are left untouched.
 *
 * Throws if any live file or bundle cannot be safely erased, so a caller never
 * reports success while content survives.
 */
export async function eraseTranscriptFiles(
  group_folder: string,
  names: readonly string[],
): Promise<void> {
  // `transcripts/` is agent-writable: pin it without following links.
  const tDir = await openGroupDir(group_folder, 'transcripts');
  if (!tDir) return;
  try {
    const tDirPath = path.join(getGroupDir(group_folder), 'transcripts');
    const memberNames = new Set(names);
    const livePaths = names.map((name) => path.join(tDirPath, name));
    const aDirPath = path.join(tDirPath, 'archive');
    let aDir: PinnedDir | null = null;
    try {
      // Hold the live-file locks AND every bundle lock for the whole erase,
      // taken in one sorted acquisition (the same order `archiveOldTranscripts`
      // uses for its sources + bundle, so the two cannot deadlock). The live
      // lock is what `restoreFromArchiveIfMissing*` takes before copying an
      // archived member back to its live path: releasing it before the bundles
      // are scrubbed would let a concurrent read resurrect the content. The
      // bundle locks stop a concurrent sweep from renaming a stale copy over a
      // scrubbed bundle. A bundle that appears between listing and locking is
      // picked up by retrying with it included; none can gain this
      // conversation's members while the live locks are held, because the
      // sweep needs those locks to archive them.
      for (;;) {
        aDir ??= await openDirAt(tDir, 'archive');
        const bundles = await listBundles(aDir);
        const done = await withTranscriptLocks(
          [...livePaths, ...bundles.map((name) => path.join(aDirPath, name))],
          async () => {
            aDir ??= await openDirAt(tDir, 'archive');
            const current = await listBundles(aDir);
            if (current.some((bundle) => !bundles.includes(bundle))) {
              return false;
            }
            // Live files. rm unlinks a planted symlink itself, never
            // following it.
            for (const livePath of livePaths) {
              await deleteTranscriptUnderLockAsync(livePath);
            }
            for (const bundle of bundles) {
              await scrubBundle(aDir!, bundle, memberNames);
            }
            return true;
          },
        );
        if (done) return;
      }
    } finally {
      await aDir?.close();
    }
  } finally {
    await tDir.close();
  }
}

/**
 * Permanently erase a chat conversation's transcript: the live JSONL file(s)
 * and index sidecar, plus every copy archived into
 * `transcripts/archive/*.tar.gz`. Other conversations' files and archive
 * members are left untouched.
 */
export async function eraseChatTranscript(
  group_folder: string,
  conversation_id: string,
): Promise<void> {
  await eraseTranscriptFiles(
    group_folder,
    chatArchiveMemberNames(conversation_id),
  );
}
