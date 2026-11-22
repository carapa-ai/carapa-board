/**
 * system-events.ts
 * Tells every objective brain when the Board starts or CarapaBox restarts, so
 * brains can verify deploys and drain work without being told by chat.
 *
 * Events carry only service version/time data. `BRAIN_SYSTEM_EVENTS=0`
 * disables both the Board-start event and the Box restart watcher.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import { registeredGroups } from '../../state-manager.js';
import { boardBuildInfo, boxInfo } from '../build-info/tools.js';
import type { BoxInfo } from '../build-info/tools.js';
import {
  isBrainEventsEnabled,
  publishEvent,
  refreshBrainPortCache,
  resolveBrainAuthToken,
  resolveBrainContainer,
  resolveBrainUrl,
} from './brain-client.js';
import type { BrainEvent, SystemEventType } from './brain-client.js';

const BOX_WATCH_INTERVAL_MS = 60_000;
/** Box start time is derived from uptime, so smaller shifts are jitter. */
export const BOX_RESTART_JITTER_MS = 30_000;

type SystemEventGroup = Parameters<typeof publishEvent>[2] & {
  folder: string;
};

export interface SystemEventDeps {
  groups: () => Iterable<SystemEventGroup>;
  /** Brain URL for a group, or null when it has no reachable brain. */
  resolveUrl: (group: SystemEventGroup) => string | null;
  /** Whether publishEvent would accept an event from this group. */
  canPublish: (group: SystemEventGroup) => boolean;
  publish: typeof publishEvent;
  now: () => Date;
}

const defaultDeps: SystemEventDeps = {
  groups: () => Object.values(registeredGroups),
  resolveUrl: (g) => resolveBrainUrl(resolveBrainContainer(g)),
  canPublish: (g) => isBrainEventsEnabled(g) && !!resolveBrainAuthToken(g),
  publish: publishEvent,
  now: () => new Date(),
};

function isSystemEventsEnabled(): boolean {
  return process.env.BRAIN_SYSTEM_EVENTS !== '0';
}

/**
 * Publish a system event to every distinct brain that has a registered
 * project. One event per brain URL, however many projects share that brain.
 * Never throws.
 */
export function fanOutSystemEvent(
  type: SystemEventType,
  data: Record<string, unknown>,
  deps: SystemEventDeps = defaultDeps,
): void {
  try {
    const timestamp = deps.now().toISOString();
    const seen = new Set<string>();
    for (const g of deps.groups()) {
      const brainUrl = deps.resolveUrl(g);
      if (!brainUrl || seen.has(brainUrl) || !deps.canPublish(g)) continue;
      seen.add(brainUrl);
      const event: BrainEvent = {
        type,
        project_id: g.folder,
        timestamp,
        data,
      };
      deps.publish(brainUrl, event, g);
    }
    logger.info({ type, brains: seen.size }, 'System event sent to brains');
  } catch (err) {
    logger.warn({ err, type }, 'System event fan-out failed');
  }
}

/** Announce this Board process start. Call once, after the brain port cache is usable. */
export function publishBoardStarted(deps: SystemEventDeps = defaultDeps): void {
  if (!isSystemEventsEnabled()) return;
  fanOutSystemEvent(
    'board_started',
    { service: 'board', ...boardBuildInfo() },
    deps,
  );
}

export interface BoxWatcherDeps {
  fetchBox: () => Promise<BoxInfo | { error: string }>;
  fanOut: typeof fanOutSystemEvent;
  setInterval: (fn: () => Promise<void>, ms: number) => { unref?: () => void };
  clearInterval: (handle: { unref?: () => void }) => void;
  /** Baseline file; defaults to `<DATA_DIR>/box-restart-watcher.json`. */
  stateFile?: string;
  /** Returns file contents, or null when missing/unreadable. */
  readState?: (file: string) => string | null;
  /** Atomically replaces the file contents. May throw. */
  writeState?: (file: string, content: string) => void;
}

interface BoxBaseline {
  version: string | null;
  startedAt: string;
}

function defaultReadState(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function defaultWriteState(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function parseBaseline(raw: string | null): BoxBaseline | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BoxBaseline> | null;
    if (
      !parsed ||
      typeof parsed.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.startedAt))
    ) {
      return null;
    }
    return {
      version: typeof parsed.version === 'string' ? parsed.version : null,
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

const defaultWatcherDeps: BoxWatcherDeps = {
  fetchBox: boxInfo,
  fanOut: fanOutSystemEvent,
  setInterval: (fn, ms) => setInterval(() => void fn(), ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/**
 * Poll CarapaBox `/health` (immediately, then every interval) and publish
 * `box_started` when its start time moves by more than the jitter threshold.
 * The last seen start time is persisted so a Box restart that coincides with a
 * Board restart is still reported; without a stored baseline the first
 * successful read only records one. Returns a stop function carrying the
 * initial poll promise, or null when disabled.
 */
export function startBoxRestartWatcher(
  deps: BoxWatcherDeps = defaultWatcherDeps,
): ((() => void) & { initialPoll: Promise<void> }) | null {
  if (!isSystemEventsEnabled()) return null;

  const stateFile =
    deps.stateFile ?? path.join(DATA_DIR, 'box-restart-watcher.json');
  const readState = deps.readState ?? defaultReadState;
  const writeState = deps.writeState ?? defaultWriteState;

  const persist = (baseline: BoxBaseline): void => {
    try {
      writeState(stateFile, JSON.stringify(baseline));
    } catch (err) {
      logger.debug({ err }, 'Box restart watcher: baseline write failed');
    }
  };

  let last: BoxBaseline | null = null;
  try {
    last = parseBaseline(readState(stateFile));
  } catch (err) {
    logger.debug({ err }, 'Box restart watcher: baseline read failed');
  }
  let polling = false;

  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const info = await deps.fetchBox();
      if ('error' in info || !info.startedAt) {
        logger.debug(
          { reason: 'error' in info ? info.error : 'no startedAt' },
          'Box restart watcher: health unavailable',
        );
        return;
      }
      const current = { version: info.version, startedAt: info.startedAt };
      if (!last) {
        last = current;
        persist(current);
        return;
      }
      const shiftMs = Math.abs(
        Date.parse(current.startedAt) - Date.parse(last.startedAt),
      );
      if (!(shiftMs > BOX_RESTART_JITTER_MS)) return;
      const previous = last;
      last = current;
      persist(current);
      deps.fanOut('box_started', {
        service: 'box',
        version: info.version,
        buildTime: info.buildTime,
        startedAt: info.startedAt,
        previousVersion: previous.version,
        previousStartedAt: previous.startedAt,
      });
    } catch (err) {
      logger.debug({ err }, 'Box restart watcher: poll failed');
    } finally {
      polling = false;
    }
  };

  const handle = deps.setInterval(poll, BOX_WATCH_INTERVAL_MS);
  handle.unref?.();
  const initialPoll = poll();
  return Object.assign(() => deps.clearInterval(handle), { initialPoll });
}

/**
 * Board-start entry point for `src/index.ts`: refresh the brain port cache,
 * announce the start, then watch the Box. Never throws.
 */
export async function startSystemEventPublishing(): Promise<void> {
  if (!isSystemEventsEnabled()) return;
  try {
    await refreshBrainPortCache();
  } catch (err) {
    logger.debug(
      { err },
      'Brain port cache refresh before board_started failed',
    );
  }
  publishBoardStarted();
  startBoxRestartWatcher();
}
