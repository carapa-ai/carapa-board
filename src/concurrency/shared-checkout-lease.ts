import { randomUUID } from 'node:crypto';
import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR } from '../config.js';
import {
  getActiveRunForTask,
  getActiveChatRunsForConversation,
  getActiveChatRunsForLegacyIdentity,
  getConversation,
} from '../db.js';
import { sleep } from '../lib/async.js';
import { logger } from '../logger.js';

type SharedCheckoutLeaseOwner = {
  type: 'task' | 'conversation';
  id: string;
};
type TaskCheckoutLeaseOwner = SharedCheckoutLeaseOwner & { type: 'task' };
export type SharedCheckoutLease = {
  projectId: string;
  owner: SharedCheckoutLeaseOwner;
  release: () => Promise<void>;
  heartbeat: () => Promise<boolean>;
};

/** Another owner holds the checkout and the caller asked not to wait for it. */
export class SharedCheckoutBusyError extends Error {
  constructor(projectId: string) {
    super(`Shared checkout of ${projectId} is held by another owner`);
    this.name = 'SharedCheckoutBusyError';
  }
}

/** A bounded wait for the checkout ran out while another holder kept it. */
export class CheckoutBusyError extends Error {
  constructor(
    readonly resource: 'shared-checkout lease' | 'project git lock',
    readonly holder: string,
  ) {
    super(
      `Checkout is busy: ${resource} is held by ${holder}. Try again later.`,
    );
    this.name = 'CheckoutBusyError';
  }
}

const LEASE_TTL_MS = 30_000;
const RETRY_MS = 100;
/** A caller still waiting after this long logs a warning, then every repeat. */
const WAIT_WARN_MS = 30_000;
const WAIT_WARN_REPEAT_MS = 300_000;
const mutexes = new Map<string, Promise<void>>();

function leasePath(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(DATA_DIR, 'shared-checkout-leases', `${safe}.json`);
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function withMutex<T>(
  file: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mutexes.get(file) ?? Promise.resolve();
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  mutexes.set(
    file,
    previous.then(() => gate),
  );
  await previous;
  try {
    return await operation();
  } finally {
    unlock();
  }
}

async function withFileMutex<T>(
  file: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withMutex(file, async () => {
    const lockFile = `${file}.lock`;
    const lockToken = randomUUID();
    for (;;) {
      try {
        const temporary = `${lockFile}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, lockToken, { mode: 0o600 });
          await fs.link(temporary, lockFile);
          break;
        } finally {
          await fs.unlink(temporary).catch(() => undefined);
        }
      } catch (error: unknown) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : undefined;
        if (code !== 'EEXIST') throw error;
        const lockStat = await fs.stat(lockFile).catch(() => undefined);
        if (lockStat && Date.now() - lockStat.mtimeMs > LEASE_TTL_MS) {
          const staleFile = `${lockFile}.stale.${randomUUID()}`;
          try {
            // rename is atomic: only one contender can move this exact path;
            // a loser observes ENOENT and retries against the replacement lock.
            await fs.rename(lockFile, staleFile);
            const retiredToken = await fs.readFile(staleFile, 'utf8');
            const retiredStat = await fs.stat(staleFile);
            if (
              retiredStat.ino === lockStat.ino &&
              retiredStat.mtimeMs === lockStat.mtimeMs &&
              retiredToken.length > 0
            ) {
              await fs.unlink(staleFile).catch(() => undefined);
              continue;
            }
            await fs.rename(staleFile, lockFile).catch(() => undefined);
          } catch (takeoverError: unknown) {
            const takeoverCode =
              takeoverError &&
              typeof takeoverError === 'object' &&
              'code' in takeoverError
                ? takeoverError.code
                : undefined;
            if (takeoverCode !== 'ENOENT') throw takeoverError;
          }
        }
        await sleep(RETRY_MS);
      }
    }
    const heartbeat = setInterval(
      () => {
        void fs.utimes(lockFile, new Date(), new Date()).catch(() => undefined);
      },
      Math.max(1000, Math.floor(LEASE_TTL_MS / 3)),
    );
    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      const currentToken = await fs.readFile(lockFile, 'utf8').catch(() => '');
      if (currentToken === lockToken) {
        await fs.unlink(lockFile).catch(() => undefined);
      }
    }
  });
}

export async function acquireSharedCheckoutLease(
  projectId: string,
  owner: TaskCheckoutLeaseOwner,
  options: {
    signal?: AbortSignal;
    retryMs?: number;
    reattachActiveOwner?: boolean;
    /** Throw SharedCheckoutBusyError instead of waiting for a different owner. */
    deferToOtherOwner?: boolean;
    /** Throw CheckoutBusyError once the wait exceeds this many ms, whoever holds the lease. */
    maxWaitMs?: number;
  } = {},
): Promise<SharedCheckoutLease> {
  const file = leasePath(projectId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const retryMs = options.retryMs ?? RETRY_MS;
  const leaseToken: string = randomUUID();
  let ownedToken: string = leaseToken;
  const waitStartedAt = Date.now();
  let nextWarnAt = waitStartedAt + WAIT_WARN_MS;
  /** The live holder that blocked the latest failed attempt, for the wait warning. */
  let blockingOwner: SharedCheckoutLeaseOwner | undefined;
  let lastHolder: SharedCheckoutLeaseOwner | undefined;
  const busyError = () =>
    new CheckoutBusyError(
      'shared-checkout lease',
      lastHolder ? `${lastHolder.type} ${lastHolder.id}` : 'another owner',
    );
  /** Remove the lease file an abandoned attempt wrote after its caller gave up. */
  const dropLateLease = () =>
    withFileMutex(file, async () => {
      try {
        const current = JSON.parse(await fs.readFile(file, 'utf8')) as {
          leaseToken?: string;
        };
        if (current.leaseToken === ownedToken) await fs.unlink(file);
      } catch {
        /* expiry remains safe */
      }
    });
  for (;;) {
    if (options.signal?.aborted)
      throw new Error('Shared checkout lease aborted');
    blockingOwner = undefined;
    let attemptAbandoned = false;
    const attempt = withFileMutex(file, async () => {
      // A bounded caller that gave up must not take the lease late.
      if (attemptAbandoned) return false;
      try {
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(
            temporary,
            JSON.stringify({
              projectId,
              owner,
              leaseToken,
              expiresAt: Date.now() + LEASE_TTL_MS,
            }),
            { mode: 0o600 },
          );
          await fs.link(temporary, file);
          return true;
        } finally {
          await fs.unlink(temporary).catch(() => undefined);
        }
      } catch (error: unknown) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : undefined;
        if (code !== 'EEXIST') throw error;
        let current: {
          expiresAt?: number;
          owner?: SharedCheckoutLeaseOwner;
          leaseToken?: string;
        };
        try {
          current = JSON.parse(await fs.readFile(file, 'utf8')) as {
            expiresAt?: number;
            owner?: SharedCheckoutLeaseOwner;
            leaseToken?: string;
          };
        } catch {
          await fs.unlink(file).catch(() => undefined);
          return false;
        }
        if (
          typeof current.expiresAt === 'number' &&
          current.expiresAt <= Date.now()
        ) {
          const ownerUsesDedicatedWorktree =
            current.owner?.type === 'conversation' &&
            Boolean((await getConversation(current.owner.id))?.use_worktree);
          const ownerStillRunning = ownerUsesDedicatedWorktree
            ? false
            : current.owner?.type === 'task'
              ? (await getActiveRunForTask(current.owner.id))?.group_folder ===
                projectId
              : (
                  await getActiveChatRunsForConversation(
                    projectId,
                    current.owner?.id ?? '',
                  )
                ).length > 0 ||
                (
                  await getActiveChatRunsForLegacyIdentity(
                    projectId,
                    current.owner?.id ?? '',
                  )
                ).length > 0;
          const sameOwner =
            current.owner?.type === owner.type &&
            current.owner?.id === owner.id;
          if (attemptAbandoned) return false;
          if (ownerStillRunning && sameOwner && options.reattachActiveOwner) {
            ownedToken = current.leaseToken ?? leaseToken;
            await atomicWrite(file, {
              ...current,
              expiresAt: Date.now() + LEASE_TTL_MS,
            });
            return true;
          }
          if (ownerStillRunning) {
            if (options.deferToOtherOwner && !sameOwner) {
              throw new SharedCheckoutBusyError(projectId);
            }
            blockingOwner = current.owner;
            return false;
          }
          await fs.unlink(file).catch(() => undefined);
          return false;
        } else if (
          options.deferToOtherOwner &&
          typeof current.expiresAt === 'number' &&
          (current.owner?.type !== owner.type || current.owner?.id !== owner.id)
        ) {
          throw new SharedCheckoutBusyError(projectId);
        }
        blockingOwner = current.owner;
        return false;
      }
    });
    let acquired: boolean;
    if (options.maxWaitMs === undefined) {
      acquired = await attempt;
    } else {
      // The deadline covers the whole attempt, including a slow file lock or
      // active-run lookup, not just the gaps between attempts.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        attempt,
        new Promise<'timeout'>((resolve) => {
          deadline = setTimeout(
            () => resolve('timeout'),
            Math.max(0, options.maxWaitMs! - (Date.now() - waitStartedAt)),
          );
        }),
      ]).finally(() => clearTimeout(deadline));
      if (outcome === 'timeout') {
        attemptAbandoned = true;
        // An attempt that still wins after the deadline hands the lease back.
        void attempt
          .then(async (late) => {
            if (late) await dropLateLease();
          })
          .catch(() => undefined);
        throw busyError();
      }
      acquired = outcome;
    }
    if (!acquired) {
      if (blockingOwner) lastHolder = blockingOwner;
      if (
        options.maxWaitMs !== undefined &&
        Date.now() - waitStartedAt >= options.maxWaitMs
      ) {
        throw busyError();
      }
      // A failed attempt that found no live holder (a stale lease was just
      // cleared) keeps the warning pending for the next attempt that does.
      if (blockingOwner && Date.now() >= nextWarnAt) {
        nextWarnAt = Date.now() + WAIT_WARN_REPEAT_MS;
        logger.warn(
          {
            projectId,
            waitingOwner: owner,
            holder: blockingOwner,
            waitedMs: Date.now() - waitStartedAt,
          },
          'Still waiting for the shared checkout lease',
        );
      }
      const retryDelayMs =
        options.maxWaitMs === undefined
          ? retryMs
          : Math.min(
              retryMs,
              Math.max(0, options.maxWaitMs - (Date.now() - waitStartedAt)),
            );
      await new Promise<void>((resolve, reject) => {
        // Detach the listener when the retry timer wins; otherwise every retry
        // leaves one behind on the caller's long-lived signal.
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('Shared checkout lease aborted'));
        };
        const timer = setTimeout(() => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, retryDelayMs);
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
      continue;
    }
    let released = false;
    const heartbeat = (): Promise<boolean> =>
      withFileMutex(file, async () => {
        if (released) return false;
        try {
          const current = JSON.parse(await fs.readFile(file, 'utf8')) as {
            owner?: SharedCheckoutLeaseOwner;
            leaseToken?: string;
          };
          if (
            current.owner?.id !== owner.id ||
            current.owner?.type !== owner.type ||
            current.leaseToken !== ownedToken
          )
            return false;
          await atomicWrite(file, {
            ...current,
            expiresAt: Date.now() + LEASE_TTL_MS,
          });
          return true;
        } catch {
          return false;
        }
      });
    const releaseLease = (): Promise<void> =>
      withFileMutex(file, async () => {
        if (released) return;
        released = true;
        try {
          const current = JSON.parse(await fs.readFile(file, 'utf8')) as {
            owner?: SharedCheckoutLeaseOwner;
            leaseToken?: string;
          };
          if (
            current.owner?.id === owner.id &&
            current.owner?.type === owner.type &&
            current.leaseToken === ownedToken
          )
            await fs.unlink(file);
        } catch {
          /* expiry remains safe after restart */
        }
      });
    const heartbeatTimer = setInterval(
      () => {
        void heartbeat();
      },
      Math.max(1000, Math.floor(LEASE_TTL_MS / 3)),
    );
    heartbeatTimer.unref?.();
    const release = async (): Promise<void> => {
      clearInterval(heartbeatTimer);
      await releaseLease();
    };
    return { projectId, owner, release, heartbeat };
  }
}
