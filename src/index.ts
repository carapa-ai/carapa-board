/**
 * Thin bootstrap: wires together the extracted modules and starts all services.
 *
 * Module breakdown:
 *  - state-manager.ts:    State loading/saving, sessions, registered groups, group operations
 *  - messaging/send-message.ts:  Bridge, task, and external message delivery
 *  - recovery.ts:         Boot-time sweep/recover functions for crashed tasks/agents
 *  - group-bootstrap.ts:  IPC watcher and sandbox bootstrapping
 */

import {
  ENABLE_CHAT,
  ENABLE_KANBAN,
  ENABLE_WHATSAPP,
  AUTO_START_SANDBOXES,
  ENABLE_SCHEDULER,
  ENABLE_SERVICE_WATCHER,
  AUTO_RESTART_OUTDATED_SANDBOXES,
  STUCK_CONVERSATION_SWEEP_INTERVAL,
} from './config.js';
import { setGroupLookup, getGroupDir } from './group-dir.js';
import {
  getPgliteLocation,
  initDatabase,
  isUsingPostgres,
  purgeExpiredNotificationPayloads,
  snapshotTaskAdmissionOwners,
  type TaskAdmissionSnapshot,
} from './db.js';
import { hydrateTokenRegistry } from './mcp/auth-tokens.js';
import { revokePendingShellTokens } from './lib/pending-shell-tokens.js';
import {
  rescopeAllMainTokens,
  startMainReachSync,
} from './mcp/main-reach-sync.js';
import { startSchedulerLoop } from './modules/chat/scheduling/task-scheduler.js';
import { cleanupProcesses } from './mcp/mcp-runner.js';
import {
  setGroupResolver,
  drainProjectQueue,
  holdQueueDrains,
  releaseQueueDrains,
  resumeActiveDatasetTasks,
  recoverStageEntryEvents,
} from './modules/kanban/task-executor.js';
import {
  OBJECTIVE_EVENT_HOLD_SWEEP_INTERVAL_MS,
  settleOverdueObjectiveTaskEventHolds,
} from './modules/kanban/task/objective-event-holds.js';
import { startHttpBridge } from './http-service.js';
import {
  ensureAndroidOtaSigningKey,
  publishInstalledWebAsAndroidOta,
} from './lib/android-ota.js';
import { broadcast } from './modules/objectives/ws-events.js';
import { getTmuxClient } from './lib/tmux-client.js';
import { logger } from './logger.js';
import { startBrowserIdleCleanup } from './sandbox/browser-idle.js';
import { startModelDiscovery } from './lib/model-discovery.js';
import { onProviderReconnected } from './lib/provider-login-state.js';
import { recoverMemoryAudits } from './modules/memory/memory-audit.js';
import { recoverInterruptedHistoryReviewGenerations } from './modules/memory/history-review-generation.js';
import {
  recoverPendingTranscriptReflections,
  releaseOwnReflectorLeases,
  startPendingReflectorSweep,
} from './modules/memory/tool-reflector.js';
import { recoverLiveQueues } from './modules/ai-users/live-queue.js';
import {
  recoverPendingDeployDispatches,
  recoverPendingHostBuilds,
} from './modules/kanban/task/deploy.js';
import {
  isMergeRetrySweepEnabled,
  MERGE_RETRY_SWEEP_INTERVAL_MS,
  sweepParkedApprovedMerges,
} from './modules/kanban/task/merge-retry.js';
import { recoverConversationExecutionLeases } from './modules/chat/conversation-execution-lease.js';
import { startIssueImportPoller } from './modules/kanban/issue-import.js';

import {
  registeredGroups,
  sessions,
  loadState,
  ensureAgentSymlinks,
  getGroupByFolder,
} from './state-manager.js';
import { sendMessage } from './modules/messaging/send-message.js';
import {
  recoverStalledRuns,
  recoverUnfinalizedScheduledRuns,
  recoverOrphanedScheduledTaskClaims,
  reattachOrphanedRuns,
  recoverDirectFollowups,
  sweepOrphanedIpcDirs,
  sweepStuckConversations,
  sweepOrphanedWorktrees,
} from './recovery.js';
import { ensureGroupSandboxes } from './group-bootstrap.js';
import { syncAllDisabledSkillsFiles } from './sandbox/disabled-skills.js';
import { groupReplica, ipcReplica } from './sandbox/ipc-replica.js';
import { installBoxRouting } from './modules/boxes/routing.js';
import { startServiceWatcher, stopServiceWatcher } from './service-watcher.js';
import { startOutdatedSandboxRestarts } from './sandbox/outdated-restart.js';
import {
  startEventLoopLagMonitor,
  stopEventLoopLagMonitor,
} from './lib/event-loop-lag.js';
// Module system
import {
  registerModule,
  initModules,
  shutdownModules,
} from './modules/loader.js';
import whisperModule from './modules/whisper/index.js';
import vectorStoreModule from './modules/vector-store/index.js';
import objectivesModule from './modules/objectives/index.js';
import { reconcilePendingObjectiveStateEvents } from './modules/objectives/brain-client.js';
import { startSystemEventPublishing } from './modules/objectives/system-events.js';
import { reconcileInterruptedProposals } from './modules/proposals/service.js';
import webModule from './modules/web/index.js';
import { knowledgeModule } from './modules/knowledge/index.js';
import {
  listUsers,
  ensureUserMainGroup,
  ensureBootstrapAdmin,
} from './modules/knowledge/db-kb.js';
import gitnexusModule from './modules/gitnexus/index.js';
import kanbanModule from './modules/kanban/index.js';
import chatModule from './modules/chat/index.js';
import fsModule from './modules/fs/index.js';
import ttsModule from './modules/tts/index.js';
import liveVoiceModule from './modules/live-voice/index.js';

registerModule(whisperModule);
registerModule(vectorStoreModule);
registerModule(objectivesModule);
registerModule(webModule);
registerModule(knowledgeModule);
registerModule(gitnexusModule);
registerModule(kanbanModule);
registerModule(chatModule);
registerModule(fsModule);
registerModule(ttsModule);
registerModule(liveVoiceModule);

// Module system

const REFLECTOR_LEASE_RELEASE_TIMEOUT_MS = 2000;

/** Free this process's reflector leases so the next boot resumes at once; never blocks shutdown. */
async function releaseReflectorLeasesBounded(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const released = await Promise.race([
      releaseOwnReflectorLeases(),
      new Promise<null>((resolve) => {
        timer = setTimeout(
          () => resolve(null),
          REFLECTOR_LEASE_RELEASE_TIMEOUT_MS,
        );
      }),
    ]);
    if (released === null) {
      logger.warn('Timed out releasing reflector leases on shutdown');
    } else {
      logger.info({ released }, 'Released reflector leases on shutdown');
    }
  } catch (error) {
    logger.warn({ err: error }, 'Failed to release reflector leases');
  } finally {
    clearTimeout(timer);
  }
}

let stopIssueImportPoller: (() => void) | null = null;
let stopMainReachSync: (() => void) | null = null;
let stopPendingReflectorSweep: (() => void) | null = null;

// Cleanup active containers on exit
['SIGINT', 'SIGTERM', 'exit'].forEach((signal) => {
  process.on(signal, async () => {
    stopIssueImportPoller?.();
    stopMainReachSync?.();
    stopPendingReflectorSweep?.();
    stopServiceWatcher();
    stopEventLoopLagMonitor();
    cleanupProcesses();
    ipcReplica.stop();
    groupReplica.stop();
    if (signal !== 'exit') await releaseReflectorLeasesBounded();
    await shutdownModules();
    if (signal !== 'exit') process.exit();
  });
});

// Log unhandled promise rejections with full context.
// We do NOT crash: the scheduler and messaging loops are resilient enough
// that a single failed promise should not bring down the whole process.
// Fatal-looking errors (e.g. EADDRINUSE, cannot reach DB) are already
// handled at their call sites; anything else surfacing here is unexpected
// but recoverable.
process.on(
  'unhandledRejection',
  (reason: unknown, promise: Promise<unknown>) => {
    logger.error(
      {
        err: reason instanceof Error ? reason : undefined,
        reason: reason instanceof Error ? undefined : reason,
        promise: String(promise),
      },
      'Unhandled promise rejection — continuing process',
    );
  },
);

async function main(): Promise<void> {
  await initDatabase();
  logger.info(
    `Database initialized (${isUsingPostgres() ? 'Postgres' : `PGlite at ${getPgliteLocation()}`})`,
  );
  // Incomplete shell starts must not regain access on hydration. A failed
  // durable deletion aborts startup, retaining the tracker record for retry.
  await revokePendingShellTokens();
  // Restore agent tokens issued before the last restart so running sandboxes
  // keep their MCP auth without needing to be restarted themselves.
  await hydrateTokenRegistry();
  await loadState();
  // Keep per-user mains' live tokens in step with project ownership/membership.
  stopMainReachSync = startMainReachSync(() => registeredGroups);
  // Tokens hydrated above carry whatever scope was last persisted; recompute
  // every per-user main's before anything can use them.
  await rescopeAllMainTokens(() => registeredGroups);

  // Sandbox tool calls follow each project's box placement (settings.boxId),
  // which needs the registered groups. Then bring the IPC replicas up to date
  // before any recovery sweep reads run or session state from them.
  installBoxRouting();
  // Nested projects' group directories live at <parent>/<child>; the replica
  // must read and write them there, not at the flat <groups>/<child> path.
  groupReplica.setProjectDir(getGroupDir);
  try {
    await ipcReplica.syncAll();
    await groupReplica.syncAll();
  } catch (err) {
    logger.warn({ err }, 'IPC replica boot sync failed');
  }

  // Capture owners before modules can dispatch work (including WhatsApp
  // polling). If the read fails, an empty snapshot keeps later recovery from
  // sweeping admissions whose ownership was never observed.
  let admissionSnapshot: TaskAdmissionSnapshot | undefined;
  try {
    admissionSnapshot = await snapshotTaskAdmissionOwners();
  } catch (err) {
    logger.error({ err }, 'Admission snapshot failed; continuing startup');
  }

  if (ENABLE_WHATSAPP) {
    // Resolve at runtime so disabled installations can omit this directory.
    const modulePath = './modules/whatsapp/index.js';
    registerModule((await import(modulePath)).default);
  }

  // Initialize optional modules (whisper, vector-store, whatsapp, objectives,
  // web, knowledge, gitnexus)
  await initModules();

  // Ensure every user has a personal main group. Each user owns their own
  // `main-<username>` (or, for legacy installs, the original `main`). New users
  // get one created in `createUser`; this loop backfills users who pre-date
  // that behavior. Idempotent — skipped if the user already owns any is_main.
  try {
    await ensureBootstrapAdmin();
    const allUsers = await listUsers();
    for (const u of allUsers) {
      if (u.disabled) continue;
      try {
        await ensureUserMainGroup(u.id, u.username);
      } catch (err) {
        logger.error(
          { err: String(err), user: u.username },
          'Failed to backfill main group for user',
        );
      }
    }
  } catch (err) {
    logger.error(
      { err: String(err) },
      'Failed to backfill per-user main groups',
    );
  }

  // Register group directory resolver before any filesystem work so that
  // getGroupDir() resolves nested paths (groups/<parent>/<project>) correctly.
  const findGroup = (folder: string) => getGroupByFolder(folder);
  setGroupLookup(findGroup);

  // Project state/path resolution is authoritative before any conversation
  // recovery. Expired claims are safe to clear; unexpired claims may belong to
  // another live Board process and must remain intact.
  await recoverConversationExecutionLeases();
  if (ENABLE_KANBAN) {
    setGroupResolver(findGroup);
  }

  // Ensure cross-agent symlinks exist for all registered groups
  for (const group of Object.values(registeredGroups)) {
    ensureAgentSymlinks(getGroupDir(group.folder), group);
  }

  // Containers read each project's disabled-skills file at start, and one that
  // survived this restart is refreshed when its list is stale. Group paths are
  // final here (resolver set, nested layout migrated), so nested projects are
  // reconciled at their real directory; do it before recovery, schedulers or
  // stage-entry work can launch agents.
  await syncAllDisabledSkillsFiles();

  void recoverInterruptedHistoryReviewGenerations()
    .then(({ resumed, terminalized }) => {
      if (resumed > 0) {
        logger.info(
          { resumed },
          'Resuming interrupted history proposal generations',
        );
      }
      if (terminalized > 0) {
        logger.info(
          { terminalized },
          'Terminalized interrupted history proposal generations',
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, 'History proposal generation recovery failed');
    });

  try {
    const queued = await recoverPendingTranscriptReflections();
    if (queued > 0) {
      logger.info({ queued }, 'Recovered durable transcript reflections');
    }
  } catch (err) {
    logger.error({ err }, 'Transcript reflector recovery failed');
  }
  stopPendingReflectorSweep = startPendingReflectorSweep();

  // Objective state changes are committed to a Board-owned outbox before the
  // originating request succeeds. Retry those receipts after path migration
  // and group lookup are authoritative, without delaying unrelated recovery.
  void reconcilePendingObjectiveStateEvents().catch((err) =>
    logger.warn({ err }, 'Objective state event recovery failed'),
  );

  // Recover stalled runs from any previous server crash.
  // Check each run's IPC directory to determine if it already finished.
  // Note: reattachOrphanedRuns() is deferred until after startHttpBridge() below
  // so that its task_started / chat_started broadcasts reach a live WS server
  // (and arriving UI clients see streaming live, not via the buffer-replay path).
  // A failing recovery step must never keep the Board from starting; it is
  // retried on the next boot and DB-initialization failures surface earlier.
  // Both recovery phases must use the pre-recovery owners: stalled-run
  // finalization can launch a replacement before it has an active run row.
  holdQueueDrains();
  try {
    await recoverStalledRuns({
      admissionSnapshot: admissionSnapshot ?? new Map(),
    });
  } catch (err) {
    logger.error({ err }, 'Stalled-run recovery failed; continuing startup');
  }

  // A crash can occur after an active run becomes terminal but before its
  // schedule advances. Reconcile that occurrence before the scheduler starts;
  // dispatching it again would duplicate already-completed work.
  await recoverUnfinalizedScheduledRuns();

  // A scheduled occurrence is claimed before it waits for sandbox capacity.
  // If the process stopped during that wait, no active_runs row exists to
  // recover; release that orphaned reservation so it is immediately retried.
  await recoverOrphanedScheduledTaskClaims();

  // Sweep leftover IPC run directories that have no active DB row
  // (from runs that completed but whose cleanup was interrupted).
  await sweepOrphanedIpcDirs();

  await recoverLiveQueues();

  // A restart during a rule/skill proposal's write leaves it in `applying`
  // with no one to finish it; close it without replaying the action.
  await reconcileInterruptedProposals().catch((err) =>
    logger.warn({ err }, 'Proposal recovery failed'),
  );

  // A host build queued before this restart is still tracked by CarapaBox;
  // resume waiting for it so its tasks get the deploy outcome.
  if (ENABLE_KANBAN) {
    try {
      for (const resumed of await recoverPendingHostBuilds()) {
        void resumed.catch((err) =>
          logger.error({ err }, 'Resumed host build failed'),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Host build recovery failed');
    }
  }
  // Dispatch any deploy handoff whose marker was persisted before the restart,
  // including the ones the unconditional run recovery above just wrote. That
  // recovery runs in every startup mode and this is the only step that starts
  // its builds; with Kanban disabled only the handoffs it marked as its own
  // are dispatched, as a live run's marker stays with that run.
  try {
    for (const dispatched of await recoverPendingDeployDispatches({
      recoveredOnly: !ENABLE_KANBAN,
    })) {
      void dispatched.catch((err) =>
        logger.error({ err }, 'Pending deploy dispatch recovery failed'),
      );
    }
  } catch (err) {
    logger.error({ err }, 'Pending deploy dispatch recovery failed');
  }
  // Queue drains (hooks included) wait until the builds above are submitted.
  releaseQueueDrains();

  // Clear worktree_path on tasks that are no longer running.
  // Actual directory cleanup happens via `git worktree prune` in the sandbox.
  await sweepOrphanedWorktrees();

  // Sweep stale entries from `ipc/tmux-sessions.json`. After a box
  // restart (or a long-idle board), the persisted index can carry
  // entries whose underlying streams are gone on the box side. The
  // reconcile is a TTL-based drop (default 24h) so it can't hammer
  // the box with N HTTP pings on startup. Live streams held by the
  // current process are protected.
  try {
    const dropped = await getTmuxClient().reconcile();
    if (dropped > 0) {
      logger.info(
        { dropped },
        'tmux session index reconcile dropped aged-out entries',
      );
    }
  } catch (err) {
    logger.warn(
      { error: String(err) },
      'tmux session index reconcile failed (non-fatal)',
    );
  }

  // Start services that don't depend on WhatsApp
  startEventLoopLagMonitor();
  startHttpBridge(parseInt(process.env.API_PORT || '3000', 10));

  // Publish this image's web assets to Android only once the server they talk
  // to is up. Unchanged content publishes nothing; failures keep the last
  // published bundle and never block boot.
  setImmediate(() => {
    try {
      if (ensureAndroidOtaSigningKey() === 'created') {
        logger.info('Created Android OTA signing key');
      }
    } catch (err) {
      logger.warn({ err }, 'Android OTA signing key could not be created');
    }
    try {
      const result = publishInstalledWebAsAndroidOta();
      if (result.status === 'published') {
        broadcast({
          type: 'android_update_ready',
          payload: {
            version: result.manifest.version,
            size: result.manifest.size,
          },
        });
      }
    } catch (err) {
      logger.warn({ err }, 'Boot-time Android OTA publish skipped');
    }
  });

  // Direct follow-ups have no IPC directory. Recover their durable claims only
  // after WebSocket publication is available, before generic stuck-run sweeps.
  await recoverDirectFollowups();
  await sweepStuckConversations();
  const stuckConversationSweepTimer = setInterval(() => {
    void sweepStuckConversations().catch((err: unknown) =>
      logger.warn({ err }, 'Periodic stuck-conversation sweep failed'),
    );
    void purgeExpiredNotificationPayloads().catch((err: unknown) =>
      logger.warn({ err }, 'Expired notification payload sweep failed'),
    );
  }, STUCK_CONVERSATION_SWEEP_INTERVAL);
  stuckConversationSweepTimer.unref?.();

  // Retry review-approved cards parked by a refused (e.g. dirty-checkout)
  // merge. TASK_MERGE_RETRY_SWEEP=0 disables it.
  if (isMergeRetrySweepEnabled()) {
    const runMergeRetrySweep = () =>
      void sweepParkedApprovedMerges().catch((err: unknown) =>
        logger.warn({ err }, 'Parked approved-merge retry sweep failed'),
      );
    runMergeRetrySweep();
    setInterval(runMergeRetrySweep, MERGE_RETRY_SWEEP_INTERVAL_MS).unref();
  }

  // Tell objective brains this Board just started and watch for Box restarts.
  void startSystemEventPublishing().catch((err: unknown) =>
    logger.warn({ err }, 'System event publishing failed to start'),
  );

  recoverMemoryAudits().catch((err: unknown) =>
    logger.error({ err }, 'Memory audit recovery failed'),
  );

  // Reattach in-flight runs that were interrupted by the previous shutdown.
  // Wait for ownership/Stop controls to be installed, not for agent completion.
  // Recovered runs remain authoritative while unrelated schedulers and queue
  // drains start; a long-running agent must not hold the whole board in boot.
  try {
    await reattachOrphanedRuns({
      admissionSnapshot: admissionSnapshot ?? new Map(),
    });
  } catch (err) {
    logger.error({ err }, 'Orphaned run recovery failed');
  }

  startBrowserIdleCleanup();
  // Cards held while a provider account needed a login start again once it
  // is connected, even when nobody has the admin page open.
  onProviderReconnected((provider) => {
    if (!ENABLE_KANBAN) return;
    logger.info({ provider }, 'Provider account usable again, draining queues');
    for (const group of Object.values(registeredGroups))
      drainProjectQueue(group.folder, group).catch((err) =>
        logger.error({ err, provider }, 'Queue drain after reconnect failed'),
      );
  });
  startModelDiscovery();
  if (ENABLE_CHAT && ENABLE_SCHEDULER) {
    startSchedulerLoop({
      sendMessage,
      registeredGroups: () => registeredGroups,
      getSessions: () => sessions,
    });
  }

  // Start the service health watcher (polls managed services and restarts unhealthy ones)
  if (ENABLE_SERVICE_WATCHER) {
    startServiceWatcher();
  }

  if (AUTO_RESTART_OUTDATED_SANDBOXES) {
    startOutdatedSandboxRestarts();
  }

  // Reconcile durable one-shot stage-entry receipts independently of sandbox
  // auto-start. AUTO_START_SANDBOXES=false is supported, and a failed startup
  // probe must not leave claimed receipts blocking the project forever. The
  // recovered drain starts entry work on demand when a sandbox is available.
  if (ENABLE_KANBAN) {
    try {
      await recoverStageEntryEvents();
    } catch (err) {
      logger.error({ err }, 'Automatic stage-entry recovery failed');
    }
    stopIssueImportPoller = startIssueImportPoller();

    // Notifications held for an objective's handling of a failed / question
    // event: release overdue ones now and keep checking while running.
    const sweepObjectiveEventHolds = () =>
      settleOverdueObjectiveTaskEventHolds().catch((err: unknown) =>
        logger.warn({ err }, 'Objective task-event hold sweep failed'),
      );
    await sweepObjectiveEventHolds();
    setInterval(
      () => void sweepObjectiveEventHolds(),
      OBJECTIVE_EVENT_HOLD_SWEEP_INTERVAL_MS,
    ).unref();
  }

  // Resume ordinary executable-stage tasks and dataset chains broken by the
  // restart. Independent of AUTO_START_SANDBOXES, which only gates sandbox
  // auto-start; with it on, wait until sandboxes and entry barriers are known.
  const resumeQueuedWork = () => {
    if (!ENABLE_KANBAN) return;
    try {
      for (const group of Object.values(registeredGroups)) {
        drainProjectQueue(group.folder, group);
      }
      resumeActiveDatasetTasks();
    } catch (err) {
      logger.error({ err }, 'Boot queue resume failed');
    }
  };

  if (AUTO_START_SANDBOXES) {
    ensureGroupSandboxes()
      .catch((err: unknown) =>
        logger.error({ err }, 'Sandbox auto-start failed'),
      )
      .then(resumeQueuedWork);
  } else {
    resumeQueuedWork();
  }

  // WhatsApp messaging is now handled by the whatsapp module (via initModules above)
}

main().catch(async (err) => {
  logger.error({ err }, 'Failed to start CarapaBoard');
  process.exit(1);
});
