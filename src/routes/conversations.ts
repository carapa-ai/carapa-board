/**
 * Conversation and chat message endpoints — project-level conversations,
 * message sending, file uploads, scheduled tasks, slash commands, and chat stop.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { CronExpressionParser } from 'cron-parser';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Objective } from '../modules/objectives/types.js';
import { getObjectiveDir } from '../modules/objectives/objective-folder.js';
import { aggregateRunStats } from '../modules/objectives/objective-run-stats.js';
import {
  broadcastConversationEvent,
  chatEventScope,
} from '../modules/chat/conversation-scope.js';
import {
  saveChatMessage,
  consumeQueuedChatMessageExactlyOnce,
  withdrawQueuedChatMessageExactlyOnce,
  releaseUnconsumedQueuedChatMessages,
  getQueuedChatMessageStates,
  getChatMessages,
  getPendingChatMessages,
  getDirectChatMessageDelivery,
  beginChatSteeringDelivery,
  completeChatSteeringDelivery,
  createConversation,
  getConversations,
  getObjective,
  updateConversationPreview,
  markConversationRead,
  resolvePendingConversation,
  markFinishedConversationsRead,
  deleteConversation,
  eraseConversationTranscript,
  updateConversation,
  getConversation,
  getConversationSessionId,
  setConversationSessionId,
  setConversationRuntimeSelection,
  setConversationRoutedModel,
  setConversationAgentCmd,
  forkConversation,
  isConversationForkPending,
  getTasksForGroup,
  getTask as getKanbanTask,
  getRunningScheduledTaskStatesForGroup,
  getRunningScheduledTaskState,
  getTaskById,
  updateScheduledTask,
  updateScheduledTaskIfIdle,
  getScheduledTaskRuns,
  getScheduledTaskRunIds,
  clearConversationSession,
  ConversationWorktreeInUseError,
  ConversationWorktreeTransitionInProgressError,
  transitionConversationsFromRemovedWorktree,
  withConversationWorktreeMaintenance,
  upsertConversationMember,
  userMayPostInConversation,
  getSharedConversationIds,
  getAiUserRow,
  getPushTokensForUser,
  inviteConversationAiUser,
  listConversationAiUserRows,
  setConversationContinuousPersonaLoop,
  setMainConversationAiUser,
  getActiveRunForConversation,
  getUserById,
  getProjectAccess,
} from '../db.js';
import {
  claimReleasedDirectFollowup,
  releaseAndClaimDirectFollowups,
  scheduleClaimedDirectFollowup,
  stopClaimedDirectFollowups,
} from '../modules/chat/direct-followups.js';
import { deleteScheduledTaskWithTranscripts } from '../modules/chat/scheduling/delete-task.js';
import type { ScheduledTask } from '../modules/chat/scheduling/types.js';
import {
  getGroupByFolder,
  getGroupEntryByFolder,
  resetGroupSession,
} from '../state-manager.js';
import { registeredGroups } from '../state-manager.js';
import {
  buildMemoryCapsule,
  parseMemoryContext,
  prependMemoryCapsule,
  resolveAuthorizedRelatedGroups,
} from '../modules/memory/memory-capsule.js';
import { runChatAgent } from '../agent-runner.js';
import { notifyEntityLifecycle } from '../modules/tools/push-tools.js';
import {
  canAdvancePersonaDiscussion,
  finishPersonaEmoteTurn,
  formatPersonaConversationTurn,
  getAiCoordinatorInstructions,
  initialPersonaHandoffAfterHumanPrompt,
  listActivePersonaIds,
  normalizeTalkingStickHandoff,
  parseTalkingStickDecision,
  reinstateAddressedPersona,
  resolveActivePersonaMention,
  resolveEffectiveMainAiUser,
  resolveMainAiUserContext,
  resolveMainPersonaSession,
  resolveTalkingStickTarget,
  runAiUserPhase,
  runContinuousAiUserTurns,
  runMainAiUserFollowUp,
  speechProfileForAiUser,
  type AiUserHandoff,
} from '../modules/ai-users/orchestrator.js';
import {
  inviteProjectDefaultAiUsers,
  inviteProjectDefaultAiUserTeams,
} from '../modules/ai-users/project-default-invitations.js';
import { mainPersonaSessionKey } from '../modules/ai-users/session-revision.js';
import {
  getLiveModeKind,
  getPersonaLiveOwner,
  getPersonaLiveSession,
  setPersonaLiveSession,
  type LiveModeKind,
} from '../modules/ai-users/playback-gate.js';
import {
  enableLiveQueue,
  failLiveQueueMessage,
  getBindableLiveRunMode,
  getLiveQueueSnapshot,
  isDeviceSpeechRun,
  markLiveQueueSpeechReady,
  registerLiveQueueWatcher,
  registerLiveQueueMessage,
  renewLiveLease,
  startLiveQueueItem,
  stopLiveQueue,
  unregisterLiveQueueWatcher,
  waitForLiveQueueStart,
} from '../modules/ai-users/live-queue.js';
import { parseConversationAiUserSelection } from '../modules/ai-users/conversation-selection.js';
import {
  hasTalkingStickMarker,
  stripTalkingStickControl,
  TalkingStickStreamParser,
} from '../modules/ai-users/talking-stick.js';
import { getAiTurnRunInspection } from '../modules/ai-users/db-ai-users.js';
import { sharedDeps } from '../mcp/mcp-deps.js';
import { getTranscriber } from '../modules/whisper/index.js';
import {
  readChatTranscript,
  readChatTranscriptAsync,
  readLiveChatTranscriptAsync,
  appendChatTranscriptEntry,
  getGroupDir,
} from '../group-dir.js';
import { isProviderContextEntry } from '../modules/transcripts/transcript-store.js';
import { readAttachmentFile } from '../lib/attachment-file.js';
import { lstatAt, openGroupDir, readdirAt } from '../lib/group-fs.js';
import { adminBypassesProject } from '../lib/project-ownership.js';
import { resolveUploadedAttachmentPath } from '../modules/chat/attachment-paths.js';
import {
  deleteArtifactByPath,
  writeArtifactFile,
} from '../modules/chat/artifacts.js';
import {
  filterTrustedGeneratedArtifacts,
  generatedArtifactsToAttachments,
  type GeneratedImageArtifact,
} from '../modules/image-generation/artifacts.js';
import type { FileExplorerEntry, RepoFilesResponse } from '../types.js';
import {
  appendUntrackedDiffFromList,
  commitWorkingTree,
  countCommitsBehindDefaultBranch,
  getWorkingTreeDiff,
  getIndexDiffSections,
  parseGitNumstat,
  runGitInRepo,
  updateWorktreeFromDefaultBranch,
  withProjectGitLock,
  type GitDiffFile,
} from '../lib/git-ops.js';
import { COMMIT_SHA_PATTERN } from '../lib/git-commit.js';
import {
  isSafeRelativePath,
  detectMimetype,
  isTextMimetype,
  mimetypeForPath,
  parseChunkParams,
  applyUtf8SafeWindow,
  readContainedText,
  setRawFileHeaders,
  trimUtf8Sample,
} from '../lib/file-content.js';
import { createFileThumbnail, isImageFilePath } from '../lib/file-thumbnail.js';
import { buildConversationPreview } from '../lib/conversation-preview.js';
import type { ChatMessage } from '../modules/chat/types.js';
import {
  appendOpenFileContext,
  validateOpenFileContext,
} from '../lib/open-file-context.js';
import {
  directLlmFallbackOption,
  runDirectLlm,
} from '../modules/chat/direct-llm.js';
import {
  copyChatTranscript,
  formatPrivateUiTranscriptEntries,
  formatTranscriptEntries,
  getAgentContextGap,
  getAgentInterleavedContextGap,
  getPersonaHandoffMessages,
} from '../modules/transcripts/transcript-store.js';
import {
  archivedCarapaRunV1Paths,
  projectCarapaRunV1Entries,
  readCarapaRunV1Pair,
  summarizeCarapaRunV1,
} from '../modules/transcripts/carapa-run-v1.js';
import {
  CodexThreadImportError,
  importCodexThread,
} from '../modules/transcripts/codex-thread-import.js';
import {
  answerChatAgentUserInput,
  stopChatBackgroundTask,
  abortChatAgentWatcher,
  gracefullyInterruptRun,
  killRun,
  killChatAgentProcess,
  steerChatAgentProcess,
  chatRunAbortControllers,
  chatAbortKey,
  tryClaimChatRunAbortController,
} from '../mcp/mcp-runner.js';
import {
  completeActiveRun,
  getActiveChatRunsForConversation,
} from '../db/active-runs.js';
import {
  acquireConversationExecutionLease,
  getConversationExecutionLease,
  releaseConversationExecutionLease,
  startConversationExecutionLeaseHeartbeat,
} from '../modules/chat/conversation-execution-lease.js';

import {
  broadcast,
  getActiveStreamBoundaryForConv,
  getActiveMainStreamBoundaryForConv,
  getActiveStreamKeyForConv,
  type ActiveStreamBoundary,
} from '../modules/objectives/ws-events.js';
import { publishPublicConversationEvent } from '../modules/chat/public-conversation-events.js';
import { isSafeWorktreeBranch } from '../modules/chat/worktree-branch.js';
import {
  ensurePersonaMessageSpeech,
  MAIN_AGENT_SPEAKER_ID,
  getReadyMessageSpeechAsset,
  listReadyMessageSpeechAssets,
  resolvePersonaSpeechSource,
  type PersonaSpeechInput,
} from '../modules/tts/message-speech.js';
import { serveTtsAsset } from '../modules/tts/audio-response.js';
import { sendPing } from '../modules/push/fcm-sender.js';
import { logger } from '../logger.js';
import { shellQuote } from '../utils.js';
import {
  effectiveContainerUploadDir,
  effectiveGitArgs,
  effectiveProjectUploadDir,
  effectiveRemoteUrl,
  effectiveSandboxIpcDir,
  resolveEffectiveSandbox,
} from '../sandbox/effective-settings.js';
import { ipcReplica } from '../sandbox/ipc-replica.js';
import { isMountConfigStale } from '../sandbox/mount-generation.js';
import { hostIpcDir } from '../sandbox/process.js';
import type { RegisteredGroup } from '../types.js';

function conversationWorktreeOptions(body: any): {
  use_worktree: boolean;
  branch: string | null;
  invalidBranch: boolean;
} {
  const branch =
    typeof body?.branch === 'string' && body.branch.trim()
      ? body.branch.trim()
      : null;
  return {
    use_worktree: body?.use_worktree === true || body?.use_worktree === 1,
    branch,
    invalidBranch: branch !== null && !isSafeWorktreeBranch(branch),
  };
}

function worktreeGitPrefix(worktreeDirectory?: string): string {
  return worktreeDirectory ? `-C ${shellQuote(worktreeDirectory)} ` : '';
}

function repoPageCommand(
  directory: string,
  limit: number,
  cursor: string | undefined,
  worktreeDirectory?: string,
): string {
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error('Invalid cursor');
  const pathspec = directory || '.';
  // Reduce paths to immediate children and apply the page *inside* the
  // sandbox. The board receives at most limit + one records, never a repo tree.
  // Ignored files are listed with --directory so an ignored tree (vendor,
  // node_modules, storage with millions of files) stays one entry; inside an
  // ignored directory git cannot list children, so `find` lists one level.
  return repoSandboxCommand(
    `if [ ${shellQuote(pathspec)} != '.' ] && ! test -d ${shellQuote(pathspec)}; then echo __INVALID_DIRECTORY__; exit 2; fi; { git ls-files --cached --others --exclude-standard -- ${shellQuote(pathspec)} | sed 's/^/0\\t/'; if git check-ignore -q -- ${shellQuote(pathspec)}; then find ${shellQuote(pathspec)} -mindepth 1 -maxdepth 1 \\( -type d -printf '%p/\\n' -o -printf '%p\\n' \\); else git ls-files --others --ignored --exclude-standard --directory -- ${shellQuote(pathspec)}; fi | sed 's/^/1\\t/'; } | awk -F '\\t' -v d=${shellQuote(directory)} '{ p=$2; if (d != "") p=substr(p,length(d)+2); if (p == "") next; n=split(p,a,"/"); kind=n>1 ? "directory" : "file"; name=a[1]; full=d != "" ? d "/" name : name; if (!(full in seen) || kind == "directory") { seen[full]=1; ignored[full]=($1 == "1" && kind == "file"); kinds[full]=kind; names[full]=name } } END { for (full in seen) print (kinds[full] == "directory" ? "0" : "1") "\\t" names[full] "\\t" full "\\t" ignored[full] }' | sort -t $'\\t' -k1,1 -k2,2 | awk -F '\\t' 'NR > ${offset} && NR <= ${offset + limit + 1} { print }' | while IFS="$(printf '\\t')" read -r k n f i; do s=; if [ "$k" = 1 ] && [ -f "$f" ]; then s=$(wc -c < "$f"); fi; printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$k" "$n" "$f" "$i" "$s"; done`,
    worktreeDirectory,
  );
}

function repoSandboxCommand(
  script: string,
  worktreeDirectory?: string,
): string {
  return `${worktreeGitPrefix(worktreeDirectory)}-c alias.carapa-file-explorer=${shellQuote(`!${script}`)} carapa-file-explorer`;
}

function repoSearchCommand(
  query: string,
  limit: number,
  cursor: string | undefined,
  worktreeDirectory?: string,
): string {
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error('Invalid cursor');
  return repoSandboxCommand(
    `{ git ls-files --cached --others --exclude-standard | sed 's/^/0\\t/'; git ls-files --others --ignored --exclude-standard | sed 's/^/1\\t/'; } | awk -F '\\t' -v q=${shellQuote(query.toLowerCase())} '{ p=tolower($2); if (index(p,q)) { n=split($2,a,"/"); print a[n] "\\t" $2 "\\t" $1 } }' | sort -t $'\\t' -k1,1 -k2,2 | awk -F '\\t' 'NR > ${offset} && NR <= ${offset + limit + 1} { print }' | while IFS="$(printf '\\t')" read -r n p i; do s=; if [ -f "$p" ]; then s=$(wc -c < "$p"); fi; printf '%s\\t%s\\t%s\\t%s\\n' "$n" "$p" "$i" "$s"; done`,
    worktreeDirectory,
  );
}

/**
 * Tab-separated rows with at least `minColumns` fields. Any other stdout line
 * (a git warning, a shell notice) is skipped so it cannot become a nameless entry.
 */
function parseRepoRows(output: string, minColumns: number): string[][] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter((row) => row.length >= minColumns);
}

/** `{ sizeBytes }` for a numeric shell-reported size; `{}` when it is blank or unreadable. */
function sizeFields(value: string | undefined): { sizeBytes?: number } {
  return value && /^\d+$/.test(value) ? { sizeBytes: Number(value) } : {};
}

function parseRepoSearchPage(output: string, limit: number, cursor?: string) {
  const rows = parseRepoRows(output, 3);
  const offset = cursor ? Number(cursor) : 0;
  return {
    entries: rows.slice(0, limit).map(([name, path, ignored, size]) => ({
      kind: 'file' as const,
      name,
      path,
      ...(ignored === '1' ? { ignored: true } : {}),
      ...sizeFields(size),
    })),
    ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
  };
}

function parseRepoPage(
  output: string,
  limit: number,
  cursor?: string,
): {
  entries: FileExplorerEntry[];
  nextCursor?: string;
} {
  const rows = parseRepoRows(output, 3);
  const page = rows
    .slice(0, limit)
    .map(([kind, name, path, ignored, size]) => ({
      kind: kind === '0' ? ('directory' as const) : ('file' as const),
      name,
      path,
      ...(ignored === '1' ? { ignored: true } : {}),
      ...(kind === '0' ? {} : sizeFields(size)),
    }));
  const offset = cursor ? Number(cursor) : 0;
  return {
    entries: page,
    ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
  };
}
import {
  ASSISTANT_NAME,
  DATA_DIR,
  ENABLE_VIDEO,
  MAX_HANDOFF_LENGTH,
  TIMEZONE,
} from '../config.js';
import {
  publishEvent,
  resolveBrainUrl,
  resolveBrainContainer,
} from '../modules/objectives/brain-client.js';
import {
  MAX_LEN,
  lenError,
  getProjectCommands,
  invalidateCommandsCache,
  requireConversationAccess,
  requireSignedInUser,
  userCanAccessGroup,
  canEditProjectLocalFiles,
  explicitLevelAtLeast,
} from './_helpers.js';
import {
  dropDeletedFavorites,
  settleFavoriteMoves,
  withFavoritesLock,
} from '../lib/file-favorite-sync.js';

/** Exact invited-persona mentions own the human prompt instead of preceding a main-agent turn. */
function isExclusiveInvitedPersonaMention(
  mention: AiUserHandoff | undefined,
): mention is Extract<AiUserHandoff, { kind: 'select' }> {
  return mention?.kind === 'select';
}

async function generateAndPublishPersonaSpeech(
  input: PersonaSpeechInput,
  autoSpeak: boolean,
): Promise<void> {
  try {
    if (autoSpeak && (await isDeviceSpeechRun(input.conversationId))) {
      // The Live Mode device speaks this reply with its own TTS engine.
      await markLiveQueueSpeechReady(
        input.conversationId,
        input.messageId,
        null,
      );
      return;
    }
    let asset;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3 && !asset; attempt++) {
      try {
        asset = await ensurePersonaMessageSpeech(input);
      } catch (error) {
        lastError = error;
      }
    }
    if (!asset && lastError) throw lastError;
    if (!asset) throw new Error('TTS asset was not persisted');
    if (autoSpeak) {
      await markLiveQueueSpeechReady(
        input.conversationId,
        input.messageId,
        asset,
      );
      return;
    }
    broadcast({
      type: 'speech_ready',
      payload: {
        folder: input.projectId,
        conversation_id: input.conversationId,
        messageId: input.messageId,
        durationMs: asset.durationMs,
        mimeType: asset.mimeType,
        autoSpeak,
      },
    });
    publishPublicConversationEvent(input.conversationId, {
      type: 'speechReady',
      messageId: input.messageId,
      durationMs: asset.durationMs,
      autoSpeak,
    });
    const owner = getPersonaLiveOwner(input.conversationId);
    if (
      autoSpeak &&
      owner?.platform === 'android' &&
      owner.userId &&
      owner.deviceId
    ) {
      const tokens = (await getPushTokensForUser(owner.userId)).filter(
        (token) => token.device_id === owner.deviceId,
      );
      if (tokens.length) {
        const ref = [input.conversationId, input.messageId, owner.sessionId]
          .map((part) => encodeURIComponent(part))
          .join('|');
        void sendPing(tokens, ref, 'live_tts', {
          user_id: owner.userId,
        }).catch((error) =>
          logger.warn(
            { error, deviceId: owner.deviceId },
            'background speech push failed',
          ),
        );
      }
    }
  } catch (error) {
    logger.warn(
      {
        error,
        conversationId: input.conversationId,
        messageId: input.messageId,
      },
      'persona speech generation failed',
    );
    if (autoSpeak) {
      await failLiveQueueMessage(
        input.conversationId,
        input.messageId,
        error instanceof Error ? error.message : 'Speech synthesis failed',
      );
      return;
    }
    broadcast({
      type: 'speech_failed',
      payload: {
        folder: input.projectId,
        conversation_id: input.conversationId,
        messageId: input.messageId,
      },
    });
    publishPublicConversationEvent(input.conversationId, {
      type: 'speechFailed',
      messageId: input.messageId,
    });
  }
}

import {
  getChatAgents,
  getDefaultRuntimeSelection,
  directRuntimeBaseUrl,
  getRuntimeCatalog,
  isAutoSelection,
  isDirectRuntime,
  resolveAgentReference,
  resolveRuntimeSelection,
  runtimeSessionKey,
  validateRuntimeSelection,
  type RuntimeSelection,
} from '../lib/chat-agents.js';
import {
  persistAutoModelPin,
  routeAutoSelection,
  type AutoRouting,
} from '../lib/auto-model-pin.js';
import {
  getResolvedRuntimeConfig,
  resolveConversationRuntimeSelection,
  resolveSessionAgentKey,
  runtimeSelectionFromResolvedAgent,
} from '../lib/resolve-agent-config.js';
import { transcribeAudioWithAgent } from '../lib/transcribe-audio-llm.js';
import {
  isImplausibleShortAudioTranscript,
  isTranscriptionPromptEcho,
  wavDurationMs,
} from '../lib/audio-transcript-guard.js';
import {
  LiveMarkerParser,
  resolveLiveCompletionState,
  stripLiveMarkers,
  upsertLiveActivity,
  getLiveActivities,
} from '../modules/chat/live-activity.js';
import { calcNextRun } from '../modules/chat/scheduling/next-run.js';
import { parseIntervalMs } from '../modules/chat/scheduling/interval.js';
import { aggregateConversationCost } from '../lib/model-pricing.js';
import { generateConversationTitle } from '../modules/chat/conversation-title.js';
import {
  hydrateTranscriptSenderNames,
  resolveConversationParticipants,
} from '../modules/chat/conversation-participants.js';
import { presentAccountIdentity } from '../modules/account/profile.js';
import {
  claimDirectLlmDelivery,
  closeActiveDirectLlmDeliveryGate,
  closeDirectLlmDeliveryGate,
  deleteDirectLlmDeliveryGate,
  openDirectLlmDeliveryGate,
  type DirectLlmDeliveryGate,
} from '../modules/chat/direct-llm-delivery.js';

const router = Router();

/** Client attachments mirror `ChatMessageAttachment`; extra keys pass through. */
const incomingAttachmentSchema = z.looseObject({
  type: z.enum(['audio', 'image', 'video', 'document']),
  url: z.string().optional(),
  mimetype: z.string(),
  filename: z.string().optional(),
  caption: z.string().optional(),
  path: z.string().optional(),
  durationSeconds: z.number().optional(),
});
// A stop is a run-lifecycle fact, never something inferred from assistant prose.
const stoppedLiveStreamKeys = new Set<string>();
// Conversation-scoped stop survives killing the current persona request and is
// observed by every autonomous loop for that conversation. It is cleared only
// when a genuinely new human turn starts after the previous loop has ended.
const stoppedLiveConversationIds = new Set<string>();
// Unlike user Stop, disabling automatic continuation takes effect only at the
// next completed persona boundary. A manual round remains available.
const disabledContinuousPersonaConversationIds = new Set<string>();
// Admission gate for durable human prompts consumed by an active persona
// loop. The loop closes this synchronously before its terminal pending check,
// so a racing request is either included in that check or remains browser
// owned for the completion follow-up.
const personaBoundaryQueueConsumers = new Set<string>();
const directLlmQueueConsumers = new Set<string>();
type ConversationRunTerminalizer = {
  streamKey: string;
  stop: () => Promise<void>;
};

// The production Stop route settles an inline DirectLLM run through the same
// closure that owns its terminal WebSocket and queue handoff. Keeping the
// concrete stream key prevents a late stop from touching a newer run.
const conversationRunTerminalizers = new Map<
  string,
  ConversationRunTerminalizer
>();
type DirectPendingReceiptTestBarrier = (delivery: {
  groupFolder: string;
  conversationId: string;
  messageId: string;
}) => Promise<void>;
let directPendingReceiptTestBarrier:
  | DirectPendingReceiptTestBarrier
  | undefined;

/** Pause Direct receipt persistence in focused route tests; null restores production behavior. */
export function setDirectPendingReceiptTestBarrier(
  barrier: DirectPendingReceiptTestBarrier | null,
): void {
  directPendingReceiptTestBarrier = barrier ?? undefined;
}

const MAX_COMMIT_MESSAGE_LEN = 2000;
const MAX_COMMIT_CONTEXT_MSGS = 8;
const MAX_COMMIT_CONTEXT_CHARS = 4000;
const MAX_HANDOFF_MESSAGES = 12;
const STALE_TERMINAL_LEASE_GRACE_MS = 30_000;
export const DEFAULT_CHAT_MODES = [
  { id: 'ask', label: 'Ask' },
  { id: 'plan', label: 'Plan' },
  { id: 'code', label: 'Code' },
  { id: 'debug', label: 'Debug' },
] as const;

function stripCommitContextNoise(content: string): string {
  return content
    .replace(/\[CONTEXT_SUMMARY:[\s\S]*?\]/g, '')
    .replace(/\[AGENT_CONTEXT:[^\]]*\]/g, '')
    .trim();
}

function truncateForCommitContext(text: string, maxLen = 800): string {
  const t = stripCommitContextNoise(text).replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 1)}…`;
}

function truncateHandoffLine(value: string, maxLength: number): string {
  const marker = '… [truncated]';
  if (value.length <= maxLength) return value;
  if (maxLength <= marker.length) return marker.slice(0, maxLength);
  return `${value.slice(0, maxLength - marker.length)}${marker}`;
}

function normalizeHandoffMetadata(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildConversationHandoff(
  sourceProject: string,
  sourceConversationId: string,
  sourceTitle: string | null | undefined,
): string {
  const transcript = readChatTranscript(sourceProject, sourceConversationId);
  const formatted = formatTranscriptEntries(transcript) as Array<{
    type?: string;
    role?: string;
    content?: string;
  }>;
  const allVisible = formatted.filter(
    (entry) =>
      entry.type === 'message' &&
      (entry.role === 'user' || entry.role === 'assistant') &&
      typeof entry.content === 'string' &&
      entry.content.trim(),
  );
  const truncatedByMessageCap = allVisible.length > MAX_HANDOFF_MESSAGES;
  const visible = allVisible.slice(-MAX_HANDOFF_MESSAGES);
  const sourceDescription = truncateHandoffLine(
    normalizeHandoffMetadata(
      `Continued from project "${sourceProject}", conversation ${sourceConversationId}${sourceTitle ? ` ("${sourceTitle}")` : ''}.`,
    ),
    1_024,
  );
  const sourceReference = truncateHandoffLine(
    normalizeHandoffMetadata(
      `Source reference: ${sourceProject}/${sourceConversationId}`,
    ),
    1_024,
  );
  const opening = [
    '[CONVERSATION_HANDOFF]',
    sourceDescription,
    'This is a new conversation with a fresh agent session. Continue from the context below; do not assume access to the prior native session.',
    '',
    'Recent visible context:',
  ];
  const closing = ['', sourceReference, '[/CONVERSATION_HANDOFF]'];
  const truncationNotice =
    'Truncation notice: recent context was shortened to fit the configured handoff budget.';
  const retainedLines: string[] = [];
  let truncated = truncatedByMessageCap;

  for (const entry of [...visible].reverse()) {
    const label = entry.role === 'user' ? 'User' : 'Assistant';
    const normalized = normalizeHandoffMetadata(entry.content!);
    const available =
      MAX_HANDOFF_LENGTH -
      [...opening, ...retainedLines, '', truncationNotice, ...closing].join(
        '\n',
      ).length;
    if (available <= label.length + 2) {
      truncated = true;
      break;
    }
    const maxContentLength = available - label.length - 2;
    const content = truncateHandoffLine(normalized, maxContentLength);
    if (content.length < normalized.length) truncated = true;
    retainedLines.push(`${label}: ${content}`);
    if (content.length < normalized.length) break;
  }

  const lines = [...opening, ...retainedLines.reverse()];
  if (truncated) lines.push(truncationNotice);
  lines.push(...closing);
  return lines.join('\n');
}

/** Recent user/assistant turns to clarify intent — not a substitute for the diff. */
async function recentConversationContextForCommit(
  group_folder: string,
  conversation_id: string | null,
): Promise<string> {
  if (!conversation_id) return '';
  // The JSONL transcript is the canonical chat store (`chat_messages` was
  // retired); if it's empty, the conversation has no history.
  const transcript = readChatTranscript(group_folder, conversation_id);
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];

  const formatted = formatTranscriptEntries(transcript) as Array<{
    type?: string;
    role?: string;
    content?: string;
  }>;
  for (const e of formatted) {
    if (
      e.type === 'message' &&
      (e.role === 'user' || e.role === 'assistant') &&
      e.content
    ) {
      const content = truncateForCommitContext(e.content);
      if (content) messages.push({ role: e.role, content });
    }
  }

  if (messages.length === 0) return '';

  const recent = messages.slice(-MAX_COMMIT_CONTEXT_MSGS);
  const lines: string[] = [];
  let total = 0;
  for (const m of recent) {
    const label = m.role === 'user' ? 'User' : 'Assistant';
    const line = `${label}: ${m.content}`;
    if (total + line.length > MAX_COMMIT_CONTEXT_CHARS) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join('\n');
}

/** Heuristic subject when the LLM is unavailable — derived from changed files only. */
function fallbackWorkingTreeCommitMessage(files: GitDiffFile[]): string {
  if (files.length === 1) {
    const base = path.basename(files[0].path, path.extname(files[0].path));
    return `chore: update ${base}`;
  }
  if (files.length > 0) {
    const names = files
      .slice(0, 3)
      .map((f) => path.basename(f.path))
      .join(', ');
    const extra = files.length > 3 ? ` (+${files.length - 3} more)` : '';
    return `chore: update ${names}${extra}`;
  }
  return 'chore: save changes';
}

/** Select an HTTP-capable binding, preferring the model used by the conversation. */
function selectInternalDirectAgent(
  selections: Array<RuntimeSelection | null | undefined>,
): ReturnType<typeof getChatAgents>[number] | undefined {
  const agents = getChatAgents();
  for (const selection of selections) {
    if (!selection) continue;
    const exact = agents.find(
      (agent) =>
        agent.harnessId === selection.harnessId &&
        agent.modelId === selection.modelId,
    );
    if (
      exact &&
      exact.model &&
      isDirectRuntime(exact) &&
      directRuntimeBaseUrl(exact)
    ) {
      return exact;
    }

    const directBinding = agents.find(
      (agent) =>
        agent.modelId === selection.modelId &&
        agent.model &&
        isDirectRuntime(agent) &&
        directRuntimeBaseUrl(agent),
    );
    if (directBinding) return directBinding;
  }

  return agents.find(
    (agent) =>
      agent.model && isDirectRuntime(agent) && directRuntimeBaseUrl(agent),
  );
}

export async function suggestWorkingTreeCommitMessage(
  group: ReturnType<typeof getGroupByFolder>,
  conversation_id: string | null,
  files: GitDiffFile[],
  patch: string,
): Promise<string> {
  if (!group) return 'chore: save changes';

  const conversation = conversation_id
    ? await getConversation(conversation_id)
    : undefined;
  const commitMessageSelection = getRuntimeCatalog().defaults.commitMessage;
  const agentConfig = commitMessageSelection
    ? resolveRuntimeSelection(commitMessageSelection)
    : selectInternalDirectAgent([
        conversation?.runtimeSelection,
        group.settings?.chatRuntimeSelection,
        getDefaultRuntimeSelection('chat'),
      ]);
  if (!agentConfig) {
    logger.warn(
      { conversation_id },
      'No HTTP-capable runtime for commit message — using fallback',
    );
    return fallbackWorkingTreeCommitMessage(files);
  }
  const agentId = agentConfig.id;
  const modelId = agentConfig.model!;
  const baseUrl = directRuntimeBaseUrl(agentConfig)!;

  // Larger changes get more output headroom for longer reasoning and a
  // fuller message body.
  const commitOutputBudget = Math.min(
    2048,
    1024 + files.length * 128 + Math.ceil(patch.length / 800) * 64,
  );

  const fileSummary = files
    .map((f) => `- ${f.path} (+${f.additions}/-${f.deletions})`)
    .join('\n');

  const conversationContext = await recentConversationContextForCommit(
    group.folder,
    conversation_id,
  );

  const prompt = `Write a git commit message that explains what changed in the code below.
${
  conversationContext
    ? `
Recent conversation (for intent — verify against the diff):
${conversationContext}
`
    : ''
}
Changed files:
${fileSummary || '(none)'}

Diff excerpt:
${patch.slice(0, 8000) || '(empty)'}

Rules:
- Primary source: the diff and file list — the message must accurately describe the code changes
- Use conversation only to clarify *why* or intent; never copy a user message verbatim as the subject
- If conversation and diff disagree, trust the diff
- Conventional commit prefix (feat:, fix:, chore:, docs:, refactor:, test:) when it fits
- Subject line: imperative mood, specific, ≤72 chars — never "update files" or "save changes"
- Summarize the actual code change (feature, bugfix, refactor), not just file names or counts
- Optional body after a blank line for non-obvious details
- Reply with ONLY the commit message text, no code fences or quotes`;

  const llmOptions = {
    wireApi: agentConfig?.wireApi,
    reasoning_effort: agentConfig?.reasoning_effort,
    temperature: 0.2,
    // Reasoning models spend part of the output budget on thinking before
    // answering; a 256-token cap left no room for the message itself and
    // came back empty (the local llama.cpp adapter reports that as a
    // completed response with zero text).
    max_tokens: commitOutputBudget,
    skipInitialLog: true,
    baseUrl,
    apiKey:
      agentConfig?.apiKey ||
      agentConfig?.env?.OPENAI_API_KEY ||
      agentConfig?.env?.ANTHROPIC_API_KEY,
    agent_id: agentId,
    fallback: directLlmFallbackOption(agentConfig),
    privacy: { projectId: group.folder, purpose: 'helper' as const },
  };

  if (!llmOptions.baseUrl) {
    logger.warn(
      { conversation_id, agentId },
      'No LLM baseUrl for commit message — using fallback',
    );
    return fallbackWorkingTreeCommitMessage(files);
  }

  try {
    const response = await runDirectLlm(
      'You write clear, accurate git commit messages. Ground the message in the diff; use recent conversation only to clarify intent. Never use a user message as the subject line verbatim — describe the code change itself.',
      prompt,
      modelId,
      () => {},
      [],
      [],
      llmOptions,
    );
    const msg = response.result?.trim().replace(/^["'`]+|["'`]+$/g, '');
    if (msg) return msg;
    logger.warn(
      {
        conversation_id,
        agentId,
        modelId,
        tok_output: response.tok_output,
        tok_reasoning: response.tok_reasoning,
      },
      'LLM returned empty commit message',
    );
  } catch (err) {
    logger.warn(
      { err, conversation_id, agentId, modelId },
      'Failed to generate commit message via LLM',
    );
  }

  return fallbackWorkingTreeCommitMessage(files);
}

// --- Chat Agents ---

/**
 * GET /api/chat-agents
 * Returns list of available chat agents for the UI selector.
 */
router.get('/chat-agents', (req, res) => {
  res.json(getChatAgents());
});

router.get('/runtime-catalog', (_req, res) => {
  res.json(getRuntimeCatalog());
});

// --- Conversations ---

// PostgreSQL integer parameters (including LIMIT/OFFSET) must fit in a
// signed 32-bit integer. Keep user-controlled pagination inside that range so
// oversized finite JavaScript numbers cannot reach the database.
const MAX_PAGINATION_VALUE = 2_147_483_647;

async function conversationMetrics(
  groupFolder: string,
  conversationId: string,
  forkedAt?: string | null,
): Promise<{
  costUsd: number | null;
  costEstimated: boolean;
  entries: unknown[];
}> {
  const entries = (await readLiveChatTranscriptAsync(
    groupFolder,
    conversationId,
  )) as unknown as Array<{
    telemetry?: Record<string, unknown>;
    created_at?: string;
    timestamp?: string;
  }>;
  return {
    ...aggregateConversationCost(entries, { after: forkedAt }),
    entries,
  };
}

/**
 * An objective chat is a normal chat that carries an `objective_id`. Resolve
 * the optional `objective_id` of a request (body or query) and require the
 * objective to belong to the project. `null` means a project chat.
 */
async function resolveRequestObjective(
  req: any,
  projectId: string,
): Promise<{ objective: Objective | null } | { error: string }> {
  const raw = req.body?.objective_id ?? req.query?.objective_id;
  if (typeof raw !== 'string' || !raw.trim()) return { objective: null };
  const objective = await getObjective(raw.trim());
  if (!objective || objective.project_id !== projectId)
    return { error: 'Objective not found' };
  return { objective };
}

/**
 * GET /api/projects/:pid/conversations?limit=10&offset=0[&objective_id=...]
 * List conversations for a project, grouped by visibility/pin status, with
 * unpinned conversations ordered by latest assistant response. With
 * `objective_id`, lists that objective's chats instead of the project's.
 */
router.get('/projects/:pid/conversations', async (req: any, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });
  const scope = await resolveRequestObjective(req, req.params.pid);
  if ('error' in scope) return res.status(404).json({ error: scope.error });

  const parsedLimit = parseInt(String(req.query.limit ?? '10'), 10);
  const parsedOffset = parseInt(String(req.query.offset ?? '0'), 10);
  // Keep malformed and negative pagination values out of the DB query. A
  // negative OFFSET/LIMIT is rejected by PostgreSQL instead of behaving like
  // a request for the first page.
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(1, parsedLimit), 2000, MAX_PAGINATION_VALUE)
    : 10;
  const offset = Number.isFinite(parsedOffset)
    ? Math.min(Math.max(0, parsedOffset), MAX_PAGINATION_VALUE)
    : 0;
  const ownerUserId =
    typeof req.query.ownerUserId === 'string'
      ? req.query.ownerUserId
      : undefined;
  const triggeredByUserId =
    typeof req.query.triggeredByUserId === 'string'
      ? req.query.triggeredByUserId
      : undefined;
  const allowedConversationIds =
    req.projectAccess?.kind === 'implicit'
      ? await getSharedConversationIds(req.authUser.id, req.params.pid)
      : undefined;
  const conversations = await getConversations(req.params.pid, limit, offset, {
    ownerUserId,
    triggeredByUserId,
    allowedConversationIds,
    objectiveId: scope.objective?.id,
  });
  // Cost is shown for the current/recent conversation. Older infinite-scroll
  // pages must stay database-only: scanning dozens of large transcript files
  // here blocks the board process and can make the entire UI unresponsive.
  let all = conversations;
  if (offset === 0) {
    const metrics = await Promise.all(
      conversations.map((conversation) =>
        conversationMetrics(
          group.folder,
          conversation.id,
          conversation.forked_from ? conversation.created_at : null,
        ),
      ),
    );
    const participantGroups = await resolveConversationParticipants(
      metrics.map((metric) => metric.entries),
    );
    all = conversations.map((conversation, index) => {
      const { entries: _entries, ...cost } = metrics[index];
      return {
        ...conversation,
        ...cost,
        participants: participantGroups[index],
      };
    });
  }

  res.json(all);
});

router.get('/projects/:pid/conversations/:cid', async (req: any, res) => {
  const conversation = await getConversation(req.params.cid);
  if (!conversation || conversation.group_folder !== req.params.pid) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  if (!(await requireConversationAccess(req, res, conversation.id, 'read')))
    return;
  return res.json(conversation);
});

/** Import one local Codex conversation selected by a codex://threads deep link. */
router.post(
  '/projects/:pid/conversations/imports/codex',
  async (req: any, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    // The Codex home belongs to the Board host account, not to an arbitrary
    // project member. Keep this host-data bridge behind the admin boundary.
    if (req.authUser?.role !== 'admin') {
      return res
        .status(403)
        .json({ error: 'Admin access is required to import Codex threads' });
    }
    // The import creates a conversation, so an admin who reaches the project
    // only through membership needs the editor level, as for any new chat.
    if (
      !adminBypassesProject(req.authUser, group.folder) &&
      !explicitLevelAtLeast(req.projectAccess, 'editor')
    ) {
      return res
        .status(403)
        .json({ error: 'Cannot create conversations in this project' });
    }
    const threadLink =
      typeof req.body?.threadLink === 'string' ? req.body.threadLink : '';
    try {
      const projectCodexHome = path.join(
        effectiveSandboxIpcDir(group, DATA_DIR),
        'codex-home',
      );
      // The project Codex home lives in the box-owned IPC tree.
      await ipcReplica.flushPath(projectCodexHome);
      const result = await importCodexThread({
        threadLink,
        projectId: group.folder,
        ownerUserId: req.authUser.id,
        projectCodexHome,
      });
      logger.info(
        {
          project: group.folder,
          conversation_id: result.conversation.id,
          imported: result.imported,
        },
        'Codex thread import resolved',
      );
      return res.status(result.imported ? 201 : 200).json(result);
    } catch (error) {
      if (error instanceof CodexThreadImportError) {
        return res.status(error.status).json({ error: error.message });
      }
      logger.warn(
        { error, project: group.folder },
        'Codex thread import failed',
      );
      return res.status(500).json({ error: 'Failed to import Codex thread' });
    }
  },
);

/** Safe progress metadata for background conversation inspection. */
router.get('/projects/:pid/live-activity', async (req: any, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });
  const activities = getLiveActivities().filter(
    (activity) => activity.folder === group.folder,
  );
  if (req.projectAccess?.kind === 'implicit') {
    const allowed = new Set(
      await getSharedConversationIds(req.authUser.id, group.folder),
    );
    return res.json({
      activities: activities.filter((activity) =>
        allowed.has(activity.conversation_id),
      ),
    });
  }
  res.json({ activities });
});

type NewConversationSettings = Extract<
  Awaited<ReturnType<typeof prepareNewConversationSettings>>,
  { mainAiUserSelection: unknown }
>;

/**
 * Validate the persona, persona-loop and Live Mode options of a new
 * conversation request.
 */
async function prepareNewConversationSettings(
  req: any,
  group: RegisteredGroup,
) {
  const parsedAiUsers = parseConversationAiUserSelection(req.body);
  if ('error' in parsedAiUsers) return { error: parsedAiUsers.error };
  const { mainAiUserSelection, invitedAiUserIds, invitedAiUserIdsProvided } =
    parsedAiUsers.selection;
  const mainAiUserId =
    mainAiUserSelection.mode === 'persona'
      ? mainAiUserSelection.aiUserId
      : null;
  let effectiveInitialMainAiUserId =
    mainAiUserSelection.mode === 'inherit'
      ? (group.settings?.defaultMainAiUserId ?? null)
      : mainAiUserId;
  const taskContextId =
    typeof req.body?.taskContextId === 'string'
      ? req.body.taskContextId.trim()
      : '';
  if (taskContextId) {
    const taskContext = await getKanbanTask(taskContextId);
    if (!taskContext || taskContext.project_id !== group.folder)
      return { error: 'taskContextId must identify a task in this project' };
  }
  const inheritedInvitedAiUserIds = (
    group.settings?.defaultInvitedAiUserIds ?? []
  ).filter((id): id is string => typeof id === 'string' && Boolean(id.trim()));
  const selectedInvitedAiUserIds = invitedAiUserIdsProvided
    ? invitedAiUserIds
    : inheritedInvitedAiUserIds;
  const eligibleInvitedAiUserIds = [
    ...new Set(selectedInvitedAiUserIds.map((id) => id.trim())),
  ].filter((id) => id !== effectiveInitialMainAiUserId);
  const [initialMain, ...invitedUsers] = await Promise.all([
    effectiveInitialMainAiUserId
      ? getAiUserRow(effectiveInitialMainAiUserId)
      : Promise.resolve(undefined),
    ...eligibleInvitedAiUserIds.map((id) => getAiUserRow(id)),
  ]);
  if (
    (mainAiUserSelection.mode === 'persona' &&
      (!initialMain || initialMain.enabled !== 1)) ||
    (invitedAiUserIdsProvided &&
      invitedUsers.some((row) => !row || row.enabled !== 1))
  ) {
    return { error: 'All selected AI users must exist and be enabled' };
  }
  if (mainAiUserSelection.mode === 'inherit') {
    if (!initialMain || initialMain.enabled !== 1) {
      effectiveInitialMainAiUserId = null;
    }
  }
  const activeInvitedAiUserIds = eligibleInvitedAiUserIds.filter(
    (_id, index) => invitedUsers[index]?.enabled === 1,
  );
  const startInLiveMode = req.body?.liveMode === true;
  const liveModeSessionId =
    typeof req.body?.liveModeSessionId === 'string'
      ? req.body.liveModeSessionId.trim().slice(0, 128)
      : '';
  if (startInLiveMode && !liveModeSessionId) {
    return { error: 'liveModeSessionId is required to start in Live Mode' };
  }
  const liveModeKind: LiveModeKind =
    req.body?.liveModeKind === 'personas' ? 'personas' : 'work';
  if (
    req.body?.continuousPersonaLoop !== undefined &&
    typeof req.body.continuousPersonaLoop !== 'boolean'
  ) {
    return { error: 'continuousPersonaLoop must be a boolean' };
  }
  const continuousPersonaLoop = req.body?.continuousPersonaLoop === true;
  return {
    mainAiUserSelection,
    mainAiUserId,
    effectiveInitialMainAiUserId,
    invitedAiUserIdsProvided,
    activeInvitedAiUserIds,
    startInLiveMode,
    liveModeSessionId,
    liveModeKind,
    continuousPersonaLoop,
  };
}

/** Apply settings validated by `prepareNewConversationSettings` to a just-created conversation. */
async function applyNewConversationSettings(
  req: any,
  group: RegisteredGroup,
  conversation: Awaited<ReturnType<typeof createConversation>>,
  prepared: NewConversationSettings,
): Promise<void> {
  const {
    mainAiUserSelection,
    mainAiUserId,
    effectiveInitialMainAiUserId,
    invitedAiUserIdsProvided,
    activeInvitedAiUserIds,
    startInLiveMode,
    liveModeSessionId,
    liveModeKind,
    continuousPersonaLoop,
  } = prepared;
  await setMainConversationAiUser(conversation.id, mainAiUserSelection);
  await setConversationContinuousPersonaLoop(
    conversation.id,
    continuousPersonaLoop,
  );
  conversation.mainAiUserMode = mainAiUserSelection.mode;
  conversation.mainAiUserId = mainAiUserId;
  conversation.continuousPersonaLoop = continuousPersonaLoop;
  if (!invitedAiUserIdsProvided) {
    await inviteProjectDefaultAiUsers(
      conversation.id,
      group,
      req.authUser?.id ?? null,
      effectiveInitialMainAiUserId,
    );
  } else {
    await Promise.all(
      activeInvitedAiUserIds.map((aiUserId) =>
        inviteConversationAiUser(
          conversation.id,
          aiUserId,
          req.authUser?.id ?? null,
        ),
      ),
    );
    // The draft persona menu cannot express team removal, so default teams are
    // always applied. A persona removed in the draft who belongs to a default
    // team is therefore re-invited through the team.
    await inviteProjectDefaultAiUserTeams(
      conversation.id,
      group,
      req.authUser?.id ?? null,
      effectiveInitialMainAiUserId,
    );
  }
  if (startInLiveMode) {
    const platform =
      req.body?.platform === 'android' || req.body?.platform === 'ios'
        ? req.body.platform
        : 'web';
    setPersonaLiveSession(conversation.id, liveModeSessionId, {
      mode: liveModeKind,
      userId: req.authUser?.id,
      deviceId: req.authDeviceId,
      platform,
    });
    await enableLiveQueue(conversation.id, {
      sessionId: liveModeSessionId,
      mode: liveModeKind,
      userId: req.authUser?.id,
      deviceId: req.authDeviceId,
      platform,
    });
    broadcast({
      type: 'persona_live_mode',
      payload: {
        folder: group.folder,
        conversation_id: conversation.id,
        enabled: true,
        liveModeKind,
        liveModeSessionId,
      },
    });
  }
}

/**
 * POST /api/projects/:pid/conversations
 * Start a new conversation (resets the agent session).
 */
router.post('/projects/:pid/conversations', async (req: any, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });
  const scope = await resolveRequestObjective(req, req.params.pid);
  if ('error' in scope) return res.status(404).json({ error: scope.error });
  const objective = scope.objective;

  // Creating a conversation is a project write, so the same rule as the
  // message route's auto-create guard applies: only explicit non-viewer
  // members (or admins outside projects owned by another user) may create.
  // Without this, a read-only (viewer) project member could mint conversations
  // they own and post in freely.
  if (req.authUser && !adminBypassesProject(req.authUser, req.params.pid)) {
    if (!explicitLevelAtLeast(req.projectAccess, 'editor')) {
      return res
        .status(403)
        .json({ error: 'Cannot create conversations in this project' });
    }
  }

  // Objective chats run in the objective folder, never in a chat worktree.
  const { use_worktree, branch, invalidBranch } = objective
    ? { use_worktree: false, branch: undefined, invalidBranch: false }
    : conversationWorktreeOptions(req.body);
  if (invalidBranch)
    return res.status(400).json({ error: 'Invalid branch name' });
  // Optional: bind the conversation to an existing worktree's branch. Empty/absent
  // means "new worktree" (chat-{id}). Only honored when use_worktree is on.
  const prepared = await prepareNewConversationSettings(req, group);
  if ('error' in prepared)
    return res.status(400).json({ error: prepared.error });
  let conversation: Awaited<ReturnType<typeof createConversation>>;
  try {
    conversation = await createConversation(group.folder, {
      use_worktree,
      branch_name: branch,
      promptCache1h: req.body?.promptCache1h === true,
      objective_id: objective?.id,
      ownerUserId: req.authUser?.id ?? group.user_id ?? null,
      triggerSource: req.authUser?.id ? 'user' : 'system',
    });
  } catch (err) {
    if (err instanceof ConversationWorktreeTransitionInProgressError) {
      return res.status(409).json({ error: err.message, branch: err.branch });
    }
    throw err;
  }
  // The project session is shared by project chats only. Reset it only once
  // the conversation exists, so a rejected create leaves the session intact.
  if (!objective) resetGroupSession(group.folder);
  if (req.authUser?.id) {
    try {
      await upsertConversationMember(req.authUser.id, conversation.id, 'owner');
    } catch (err) {
      logger.warn(
        { err, conversation_id: conversation.id },
        'Failed to record conversation owner',
      );
    }
  }
  await applyNewConversationSettings(req, group, conversation, prepared);
  if (objective) {
    broadcast({
      type: 'conversations_changed',
      payload: chatEventScope(group.folder, objective.id),
    });
  }
  logger.info(
    { project: req.params.pid, conversation_id: conversation.id, use_worktree },
    'New conversation created',
  );
  res.status(201).json(conversation);
});

/**
 * GET /api/projects/:pid/worktrees
 * List existing git worktrees for the project's local repo so a new conversation
 * can be bound to one. Returns [] when the project has no Repository Location
 * (worktrees require a local repo, not just a Repository URL).
 */
router.get('/projects/:pid/worktrees', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });

  const localRepo = group.settings?.repositoryLocation;
  if (!localRepo) return res.json([]);

  const effective = resolveEffectiveSandbox(group);
  const stack = effective.stack;
  // Match the run path's instance/service derivation (process.ts): when
  // defaultSandboxInstance is unset, the instance is the bare group folder, not
  // undefined — otherwise carapa-box resolves the wrong project and the exec fails.
  const instance = effective.instance;
  const service = effective.service;
  try {
    const { getSandboxClient } = await import('../lib/mcp-client.js');
    const result = await getSandboxClient().sandboxWorktree(stack, 'list', {
      instance,
      localRepo,
      remoteUrl: effectiveRemoteUrl(effective),
      repoPath: effective.inherited ? effective.workspaceRoot : undefined,
      service,
    });
    if (result.isError) {
      logger.warn(
        { project: req.params.pid, stdout: result.stdout },
        'Worktree list failed',
      );
      return res.status(503).json({ error: 'Failed to list worktrees' });
    }
    // Parse `git worktree list --porcelain`: blocks separated by blank lines,
    // each with `worktree <path>` and either `branch refs/heads/<name>` or `detached`.
    // Only managed worktrees (under `.worktrees/`) are selectable — this excludes the
    // primary checkout (the base branch at the mount root), which can't be re-added as a
    // worktree and shouldn't be edited directly by a chat.
    const worktrees: { branch: string; path: string; merged?: boolean }[] = [];
    let curPath: string | null = null;
    for (const line of (result.stdout || '').split('\n')) {
      if (line.startsWith('worktree ')) {
        curPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ') && curPath) {
        const branch = line
          .slice('branch '.length)
          .replace(/^refs\/heads\//, '')
          .trim();
        if (branch && curPath.includes('/.worktrees/')) {
          worktrees.push({ branch, path: curPath });
        }
      } else if (line.trim() === '') {
        curPath = null;
      }
    }

    // Annotate each worktree with whether its branch is fully merged into the
    // base branch. One `git branch --merged` call covers all of them; a branch
    // is "merged" when its tip is reachable from base (safe to delete). On any
    // failure we leave `merged` undefined so the UI treats it as unknown and
    // warns before deletion.
    if (worktrees.length > 0) {
      const baseBranch = group.settings?.defaultBranch || 'develop';
      try {
        const mergedRes = await getSandboxClient().sandboxGit(
          stack,
          effectiveGitArgs(effective, `branch --merged ${baseBranch}`),
          instance,
          service,
        );
        if (!mergedRes.isError) {
          const mergedSet = new Set(
            (mergedRes.stdout || '')
              .split('\n')
              // `git branch` prefixes the current branch with '*' and
              // worktree-checked-out branches with '+'.
              .map((l) => l.replace(/^[*+]/, '').trim())
              .filter(Boolean),
          );
          for (const wt of worktrees) wt.merged = mergedSet.has(wt.branch);
        }
      } catch (err) {
        logger.warn(
          { project: req.params.pid, error: String(err) },
          'Worktree merge-status check failed',
        );
      }
    }

    res.json(worktrees);
  } catch (err) {
    logger.warn(
      { project: req.params.pid, error: String(err) },
      'Failed to list worktrees',
    );
    res.status(503).json({ error: 'Failed to list worktrees' });
  }
});

/**
 * POST /api/projects/:pid/conversations/:cid/read
 * Mark a conversation as read (hides the "finished" badge).
 */
router.post('/projects/:pid/conversations/:cid/read', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) {
    logger.warn(
      { pid: req.params.pid },
      'Mark-as-read failed: Project not found',
    );
    return res.status(404).json({ error: 'Project not found' });
  }

  if (!(await requireConversationAccess(req, res, req.params.cid, 'read')))
    return;
  if (!(await loadConversationInProject(req.params.cid, group)))
    return res.status(404).json({ error: 'Conversation not found' });

  await markConversationRead(req.params.pid, req.params.cid);
  res.json({ ok: true });
});

/** POST /api/projects/:pid/conversations/:cid/resolve-pending */
router.post(
  '/projects/:pid/conversations/:cid/resolve-pending',
  async (req, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    if (!(await requireConversationAccess(req, res, req.params.cid, 'write')))
      return;

    const resolved = await resolvePendingConversation(
      req.params.pid,
      req.params.cid,
    );
    res.json({ ok: true, resolved });
  },
);

/** POST /api/projects/:pid/conversations/mark-all-read */
router.post(
  '/projects/:pid/conversations/mark-all-read',
  async (req: any, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const scope = await resolveRequestObjective(req, req.params.pid);
    if ('error' in scope) return res.status(404).json({ error: scope.error });
    let allowedIds: string[] | undefined;
    if (req.projectAccess?.kind === 'implicit') {
      allowedIds = await getSharedConversationIds(
        req.authUser.id,
        req.params.pid,
      );
    }
    await markFinishedConversationsRead(
      req.params.pid,
      scope.objective?.id ?? null,
      allowedIds,
    );
    res.json({ ok: true });
  },
);

/**
 * GET /api/projects/:pid/conversations/:cid/transcript
 * Returns the raw JSONL transcript for a conversation.
 *
 * The JSONL transcript is the canonical chat store (`chat_messages` was
 * retired alongside this change). There is no DB fallback: a missing or
 * empty transcript simply means the conversation has no history. Telemetry
 * (model, context, token totals, duration) lives in `type:"telemetry"`
 * entries alongside the message entries in the same JSONL file.
 *
 * Supports optional `limit` and `offset` query params for pagination.
 * When paginating, `offset=0` returns the last `limit` entries; `offset=limit`
 * returns the `limit` entries before those, etc. (newest-last convention).
 * Paginated response: { _source, entries, total, hasMore, nextOffset }.
 * Without pagination params: returns all entries as { _source, entries }.
 */
router.post(
  '/projects/:pid/conversations/:cid/queued-messages/reconcile',
  async (req, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    if (!(await requireConversationAccess(req, res, req.params.cid, 'write')))
      return;
    const conversation = await getConversation(req.params.cid);
    if (!conversation || conversation.group_folder !== group.folder) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const abortKey = chatAbortKey(
      group.folder,
      conversation.id,
      `${group.folder}@web`,
    );
    const active =
      chatRunAbortControllers.has(abortKey) ||
      !!getActiveStreamKeyForConv(conversation.id) ||
      !!(await getActiveRunForConversation(conversation.id));
    if (!active) {
      const handoff = await releaseAndClaimDirectFollowups(
        group.folder,
        conversation.id,
      );
      for (const claim of handoff.claimed) {
        scheduleClaimedDirectFollowup(claim.runId);
      }
    }
    return res.json({
      active,
      ...getQueuedChatMessageStates(group.folder, conversation.id),
    });
  },
);

router.delete(
  '/projects/:pid/conversations/:cid/queued-messages/:messageId',
  async (req, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    if (!(await requireConversationAccess(req, res, req.params.cid, 'write')))
      return;
    const conversation = await getConversation(req.params.cid);
    if (!conversation || conversation.group_folder !== group.folder) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const messageId = req.params.messageId;
    if (!messageId || messageId.length > 200) {
      return res.status(400).json({ error: 'Invalid queued message ID' });
    }
    const withdrawal = await withdrawQueuedChatMessageExactlyOnce(
      group.folder,
      conversation.id,
      messageId,
    );
    return res.json(withdrawal);
  },
);

router.get('/projects/:pid/conversations/:cid/transcript', async (req, res) => {
  const routeStartedAt = Date.now();
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });

  if (!(await requireConversationAccess(req, res, req.params.cid, 'read')))
    return;
  const convLookupStartedAt = Date.now();
  const conv = await loadConversationInProject(req.params.cid, group);
  const convLookupMs = Date.now() - convLookupStartedAt;
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  // Transcript fetches are React Query data reads, not browser-cacheable
  // documents. Express's default ETag handling can turn a refetch into `304
  // Not Modified`; the frontend expects JSON and treats the bodyless 304 as a
  // failed conversation load. Force every transcript response to be a fresh
  // JSON 200, and make any stale If-None-Match value impossible to match.
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader(
    'ETag',
    `"transcript-${Date.now()}-${Math.random().toString(36).slice(2)}"`,
  );

  const objectiveId = conv.objective_id ?? null;

  const readStartedAt = Date.now();
  const rawEntries = await readChatTranscriptAsync(
    req.params.pid,
    req.params.cid,
    conv?.created_at ?? null,
  );
  const readMs = Date.now() - readStartedAt;
  const transcript = rawEntries;

  // Telemetry already lives in the transcript (as `type:"telemetry"` entries
  // adjacent to the corresponding message entries), so we can format once and
  // return — no DB lookup, no positional DB backfill.
  const formatStartedAt = Date.now();
  const hydratedEntries = await hydrateTranscriptSenderNames(
    formatPrivateUiTranscriptEntries(transcript),
  );
  const readySpeech = new Map(
    (await listReadyMessageSpeechAssets(req.params.cid)).map(
      ({ messageId, asset }) => [messageId, asset],
    ),
  );
  const allEntries = hydratedEntries.map((entry: any) => {
    const id = String(entry?.id ?? '');
    const senderUserId = String(entry?.senderUserId ?? '');
    const agentName = String(entry?.agent_name ?? '');
    const isPersona =
      entry?.role === 'assistant' &&
      (senderUserId.startsWith('ai:') ||
        agentName.startsWith('ai:') ||
        agentName.startsWith('ai-main:'));
    if (!isPersona || !id) return entry;
    const asset = readySpeech.get(id);
    const url = `/api/projects/${encodeURIComponent(req.params.pid)}/conversations/${encodeURIComponent(req.params.cid)}/messages/${encodeURIComponent(id)}/speech`;
    return {
      ...entry,
      speech: asset
        ? {
            state: 'ready',
            durationMs: asset.durationMs,
            mimeType: asset.mimeType,
            url,
          }
        : { state: 'available', durationMs: null, mimeType: null, url },
    };
  });
  const formatMs = Date.now() - formatStartedAt;
  const source = 'transcript' as const;
  const routeMs = Date.now() - routeStartedAt;

  const logPayload = {
    project: req.params.pid,
    conversation_id: req.params.cid,
    objective_id: objectiveId,
    entries: allEntries.length,
    rawEntries: rawEntries.length,
    convLookupMs,
    readMs,
    formatMs,
    routeMs,
  };
  const logMessage = 'Serving chat transcript from JSONL';
  if (
    routeMs >= 250 ||
    readMs >= 250 ||
    formatMs >= 250 ||
    convLookupMs >= 250
  ) {
    logger.warn(logPayload, logMessage);
  } else {
    logger.debug(logPayload, logMessage);
  }

  const { limit: rawLimit, offset: rawOffset } = req.query;
  if (rawLimit !== undefined || rawOffset !== undefined) {
    const parsedLimit = parseInt(String(rawLimit ?? '20'), 10);
    const parsedOffset = parseInt(String(rawOffset ?? '0'), 10);
    // Do not pass NaN into pagination arithmetic when a client sends a
    // malformed query value. Treat invalid values as the first page, matching
    // the task transcript endpoint's behavior.
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(1, parsedLimit), 500)
      : 20;
    const offset = Number.isFinite(parsedOffset)
      ? Math.max(0, parsedOffset)
      : 0;

    // Find turn boundaries (indices of user-role entries).
    // An initial assistant block (before any user entry) is also treated as a boundary.
    const turnBoundaries: number[] = [];
    for (let i = 0; i < allEntries.length; i++) {
      const e = allEntries[i] as { role?: string };
      if (e.role === 'user') turnBoundaries.push(i);
    }
    if (
      allEntries.length > 0 &&
      (allEntries[0] as { role?: string }).role !== 'user'
    ) {
      turnBoundaries.unshift(0);
    }

    const totalTurns = turnBoundaries.length;
    const endTurnIdx = Math.max(0, totalTurns - offset);
    const startTurnIdx = Math.max(0, endTurnIdx - limit);
    const startEntry = turnBoundaries[startTurnIdx] ?? 0;
    const endEntry =
      endTurnIdx < totalTurns
        ? (turnBoundaries[endTurnIdx] ?? allEntries.length)
        : allEntries.length;
    const hasMore = startTurnIdx > 0;

    return res.json({
      _source: source,
      entries: allEntries.slice(startEntry, endEntry),
      total: totalTurns,
      hasMore,
      nextOffset: hasMore ? offset + limit : totalTurns,
    });
  }

  res.json({ _source: source, entries: allEntries });
});

/** Load the captured prompt and raw provider transcript for one persona turn. */
router.get(
  '/projects/:pid/conversations/:cid/persona-turns/:messageId/inspection',
  async (req, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    if (!(await requireConversationAccess(req, res, req.params.cid, 'read')))
      return;

    const conversation = await getConversation(req.params.cid);
    if (!conversation || conversation.group_folder !== group.folder) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const turn = await getAiTurnRunInspection(
      req.params.messageId,
      req.params.cid,
    );
    if (!turn?.inspection) {
      return res
        .status(404)
        .json({ error: 'Persona turn inspection is unavailable' });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      messageId: turn.id,
      aiUserId: turn.aiUserId,
      phase: turn.phase,
      presetId: turn.presetId,
      decision: turn.decision,
      status: turn.status,
      createdAt: turn.createdAt,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      ...turn.inspection,
    });
  },
);

/**
 * PATCH /api/projects/:pid/conversations/:cid
 * Update conversation title, pinned state and/or the 1-hour prompt cache flag.
 */
router.patch('/projects/:pid/conversations/:cid', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });

  if (!(await requireConversationAccess(req, res, req.params.cid, 'write')))
    return;
  if (!(await loadConversationInProject(req.params.cid, group)))
    return res.status(404).json({ error: 'Conversation not found' });

  const { title, pinned, promptCache1h } = req.body ?? {};
  const convTitleErr = lenError(title, MAX_LEN.convTitle, 'title');
  if (convTitleErr) return res.status(400).json({ error: convTitleErr });
  if ('promptCache1h' in (req.body ?? {}) && typeof promptCache1h !== 'boolean')
    return res.status(400).json({ error: 'promptCache1h must be a boolean' });
  const fields: {
    title?: string | null;
    pinned?: boolean;
    promptCache1h?: boolean;
  } = {};
  if ('title' in (req.body ?? {}))
    fields.title = typeof title === 'string' ? title.trim() || null : null;
  if ('pinned' in (req.body ?? {})) fields.pinned = Boolean(pinned);
  if (typeof promptCache1h === 'boolean') fields.promptCache1h = promptCache1h;

  if (Object.keys(fields).length === 0)
    return res.status(400).json({ error: 'No updatable fields provided' });

  await updateConversation(req.params.cid, req.params.pid, fields);
  res.json({ ok: true, promptCache1h: fields.promptCache1h });
});

/** POST /api/projects/:pid/conversations/:cid/generate-title */
router.post(
  '/projects/:pid/conversations/:cid/generate-title',
  async (req, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    if (!(await requireConversationAccess(req, res, req.params.cid, 'write')))
      return;

    const conversation = await getConversation(req.params.cid);
    if (!conversation || conversation.group_folder !== group.folder) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    try {
      const title = await generateConversationTitle(
        group.folder,
        conversation.id,
      );
      await updateConversation(conversation.id, group.folder, { title });
      broadcast({
        type: 'conversations_changed',
        payload: { folder: group.folder },
      });
      res.json({ title });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status =
        message === 'Conversation has no messages to name' ? 400 : 502;
      if (status !== 400) {
        logger.warn(
          { err, conversation_id: conversation.id, group: group.folder },
          'Failed to generate conversation title',
        );
      }
      res.status(status).json({ error: message });
    }
  },
);

/**
 * DELETE /api/projects/:pid/conversations/:cid
 * Delete a conversation and all its messages.
 */
router.delete('/projects/:pid/conversations/:cid', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });

  if (!(await requireConversationAccess(req, res, req.params.cid, 'write')))
    return;
  if (!(await loadConversationInProject(req.params.cid, group)))
    return res.status(404).json({ error: 'Conversation not found' });

  // A run that outlives the row (active_runs.conversation_id is set-null) would
  // keep appending to, and so recreate, the erased transcript. Hold the
  // conversation's execution slot from here through row deletion so no message
  // submission can be admitted (or already be awaiting run creation) meanwhile;
  // taking it first also refuses with 409 before any erase or worktree side
  // effect when execution already owns the conversation.
  const activeRunError = {
    error: 'Conversation has an active run; stop it before deleting',
  };
  const deleteLeaseId = `delete:${randomUUID()}`;
  const deleteLease = await acquireConversationExecutionLease(
    req.params.cid,
    deleteLeaseId,
  );
  if (!deleteLease) return res.status(409).json(activeRunError);
  const stopDeleteLeaseHeartbeat = startConversationExecutionLeaseHeartbeat(
    req.params.cid,
    deleteLeaseId,
  );
  let conv: Awaited<ReturnType<typeof getConversation>>;
  try {
    if (await getActiveRunForConversation(req.params.cid)) {
      return res.status(409).json(activeRunError);
    }
    conv = await getConversation(req.params.cid);

    // Erase the transcript before the worktree removal below, which clears the
    // row's legacy session_id: a failed erase must stay retryable with the
    // full identity. A later failure (worktree removal) leaves the emptied
    // conversation in place; deleting it again is safe.
    try {
      await eraseConversationTranscript(req.params.pid, req.params.cid);
    } catch (err) {
      logger.error(
        { err, conversation_id: req.params.cid, group: req.params.pid },
        'Failed to erase conversation transcript',
      );
      return res.status(500).json({ error: 'Failed to delete conversation' });
    }

    // Clean up the worktree only if THIS conversation owns it. A conversation owns
    // its worktree when it auto-created one (branch_name unset, i.e. `chat-{cid}`).
    // If it was bound to an existing/selected worktree (a task branch or another
    // chat's branch), it's shared — never remove it on delete.
    const ownsWorktree =
      !conv?.branch_name || conv.branch_name === `chat-${req.params.cid}`;
    if (
      conv?.worktree_path &&
      ownsWorktree &&
      group.settings?.repositoryLocation
    ) {
      const effective = resolveEffectiveSandbox(group);
      const stack = effective.stack;
      // Same derivation as the run path: bare group folder when no fixed instance.
      const instance = effective.instance;
      const branch = conv.branch_name || `chat-${req.params.cid}`;
      let failedRemoval: { stdout: string; isError: boolean } | undefined;
      try {
        const { getSandboxClient } = await import('../lib/mcp-client.js');
        const { affectedConversationIds } =
          await transitionConversationsFromRemovedWorktree(
            group.folder,
            branch,
            async () => {
              const result = await getSandboxClient().sandboxWorktree(
                stack,
                'remove',
                {
                  branch,
                  instance,
                  localRepo: group.settings!.repositoryLocation,
                  remoteUrl: effectiveRemoteUrl(effective),
                  repoPath: effective.inherited
                    ? effective.workspaceRoot
                    : undefined,
                  service: effective.service,
                },
              );
              if (result.isError) {
                failedRemoval = result;
                throw new Error('CarapaBox could not remove the worktree');
              }
              return result;
            },
            undefined,
            deleteLeaseId,
          );
        broadcast({
          type: 'conversations_changed',
          payload: { folder: group.folder },
        });
        logger.info(
          { conversation_id: req.params.cid, branch, affectedConversationIds },
          'Removed chat worktree on conversation delete',
        );
      } catch (err) {
        if (err instanceof ConversationWorktreeInUseError) {
          return res.status(409).json({
            error: err.message,
            conversationIds: err.conversationIds,
          });
        }
        logger.warn(
          { conversation_id: req.params.cid, error: String(err) },
          'Failed to remove chat worktree',
        );
        return res.status(409).json({
          error: 'Worktree could not be removed',
          detail: failedRemoval?.stdout ?? String(err),
        });
      }
    }

    try {
      await deleteConversation(req.params.pid, req.params.cid, {
        transcriptErased: true,
      });
    } catch (err) {
      logger.error(
        { err, conversation_id: req.params.cid, group: req.params.pid },
        'Failed to delete conversation',
      );
      return res.status(500).json({ error: 'Failed to delete conversation' });
    }
  } finally {
    stopDeleteLeaseHeartbeat();
    await releaseConversationExecutionLease(req.params.cid, deleteLeaseId);
  }
  if (conv?.objective_id) {
    broadcast({
      type: 'conversations_changed',
      payload: chatEventScope(group.folder, conv.objective_id),
    });
  }
  res.json({ ok: true });
});

function conversationOwnsWorktree(conversation: {
  id: string;
  branch_name?: string | null;
}): boolean {
  return (
    !conversation.branch_name ||
    conversation.branch_name === `chat-${conversation.id}`
  );
}

/**
 * Load a conversation only when it belongs to the project in the URL, so a
 * conversation grant cannot be used to read another project's repository.
 */
async function loadConversationInProject(
  conversationId: string,
  group: RegisteredGroup,
) {
  const conversation = await getConversation(conversationId);
  return conversation && conversation.group_folder === group.folder
    ? conversation
    : null;
}

/**
 * Run a git operation on a conversation-owned worktree while no conversation
 * bound to its branch can run (same admission as update-from-default). Callers
 * map `ConversationWorktreeInUseError` with `respondWorktreeInUse`.
 */
function withIdleBranchGitLock<T>(
  groupFolder: string,
  branch: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withConversationWorktreeMaintenance(groupFolder, branch, () =>
    withProjectGitLock(groupFolder, operation, { waitForCompletion: true }),
  );
}

function respondWorktreeInUse(res: Response, err: unknown): boolean {
  if (!(err instanceof ConversationWorktreeInUseError)) return false;
  res.status(409).json({
    error: err.message,
    conversationIds: err.conversationIds,
  });
  return true;
}

async function requireIdleOwnedConversationWorktree(
  req: any,
  res: Response,
): Promise<
  | {
      group: NonNullable<ReturnType<typeof getGroupByFolder>>;
      conversation: NonNullable<Awaited<ReturnType<typeof getConversation>>>;
      branch: string;
    }
  | undefined
> {
  const group = getGroupByFolder(String(req.params.pid));
  if (!group) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  if (!(await requireConversationAccess(req, res, req.params.cid, 'write'))) {
    return;
  }
  const conversation = await getConversation(String(req.params.cid));
  if (!conversation || conversation.group_folder !== group.folder) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  if (!conversation.use_worktree) {
    res.status(400).json({ error: 'Conversation does not use a worktree' });
    return;
  }
  if (!conversationOwnsWorktree(conversation)) {
    res.status(409).json({
      error: 'This conversation is bound to a shared worktree',
    });
    return;
  }
  if (!group.settings?.repositoryLocation) {
    res
      .status(400)
      .json({ error: 'No repository configured for this project' });
    return;
  }
  if (
    chatRunAbortControllers.has(
      chatAbortKey(group.folder, conversation.id, `${group.folder}@web`),
    ) ||
    getActiveStreamKeyForConv(conversation.id) ||
    (await getActiveRunForConversation(conversation.id))
  ) {
    res.status(409).json({
      error: 'Wait for the active conversation run to finish first',
    });
    return;
  }
  const branch = conversation.branch_name || `chat-${conversation.id}`;
  if (!isSafeWorktreeBranch(branch)) {
    res.status(400).json({ error: 'Invalid worktree branch' });
    return;
  }
  return { group, conversation, branch };
}

async function getConversationWorktreeDiff(
  group: NonNullable<ReturnType<typeof getGroupByFolder>>,
  branch: string,
  instance?: string | null,
): Promise<{ files: GitDiffFile[]; patch: string } | null> {
  const gitPrefix = `-C ${shellQuote(`.worktrees/${branch}`)} `;
  const [patchResult, statResult, untrackedResult] = await Promise.all([
    runGitInRepo(group, `${gitPrefix}diff --no-color HEAD`, instance),
    runGitInRepo(group, `${gitPrefix}diff --no-color --numstat HEAD`, instance),
    runGitInRepo(
      group,
      `${gitPrefix}ls-files --others --exclude-standard`,
      instance,
    ),
  ]);
  if (!patchResult.ok || !statResult.ok || !untrackedResult.ok) return null;

  let files = parseGitNumstat(statResult.output);
  let patch = patchResult.output;
  ({ files, patch } = await appendUntrackedDiffFromList(
    group,
    instance,
    gitPrefix,
    patch,
    files,
    untrackedResult.output,
  ));
  return { files, patch };
}

/** Merge a conversation-owned worktree into the configured default branch. */
router.post(
  '/projects/:pid/conversations/:cid/worktree/merge',
  async (req: any, res) => {
    const target = await requireIdleOwnedConversationWorktree(req, res);
    if (!target) return;
    if (!canEditProjectLocalFiles(req))
      return res
        .status(403)
        .json({ error: 'Write access to this project required' });
    const { group, conversation, branch } = target;
    const effective = resolveEffectiveSandbox(group);
    const base = group.settings?.defaultBranch || 'develop';
    const removeWorktree = req.body?.removeWorktree === true;
    const requestedMessage =
      typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (requestedMessage) {
      const msgErr = lenError(
        requestedMessage,
        MAX_COMMIT_MESSAGE_LEN,
        'message',
      );
      if (msgErr) return res.status(400).json({ error: msgErr });
    }
    const commitMessage =
      requestedMessage ||
      `feat: ${conversation.title?.trim() || 'conversation changes'}`;
    if (!isSafeWorktreeBranch(base)) {
      return res.status(400).json({ error: 'Invalid default branch' });
    }
    const client = (await import('../lib/mcp-client.js')).getSandboxClient();
    let failedRemoval: { stdout: string; isError: boolean } | undefined;
    try {
      const merge = (lockOptions?: { waitForCompletion?: boolean }) =>
        withProjectGitLock(
          group.folder,
          async () => {
            if (removeWorktree) {
              return client.sandboxBranch(effective.stack, 'merge', {
                branch,
                base,
                instance: effective.instance,
                localRepo: group.settings!.repositoryLocation,
                remoteUrl: effectiveRemoteUrl(effective),
                repoPath: effective.inherited
                  ? effective.workspaceRoot
                  : undefined,
                service: effective.service,
                autoPush: !!group.settings?.autoPushAfterMerge,
                worktree_path: `.worktrees/${branch}`,
                commitMessage,
              });
            }

            const commit = await client.sandboxBranch(
              effective.stack,
              'commit',
              {
                branch,
                instance: effective.instance,
                localRepo: group.settings!.repositoryLocation,
                remoteUrl: effectiveRemoteUrl(effective),
                repoPath: effective.inherited
                  ? effective.workspaceRoot
                  : undefined,
                service: effective.service,
                worktree_path: `.worktrees/${branch}`,
                commitMessage,
              },
            );
            const commitOutput = commit.stdout || '';
            const cleanCommit =
              /no changes|nothing to commit|working tree clean/i.test(
                commitOutput,
              );
            if (commit.isError && !cleanCommit) return commit;

            const [checkout, status] = await Promise.all([
              runGitInRepo(
                group,
                'symbolic-ref --short HEAD',
                effective.instance,
              ),
              runGitInRepo(
                group,
                'status --porcelain=v1 -z --untracked-files=all',
                effective.instance,
              ),
            ]);
            if (!checkout.ok || checkout.output.trim() !== base) {
              return {
                isError: true,
                stdout: `Default checkout is not on ${base}`,
              };
            }
            if (!status.ok || status.output.length > 0) {
              return {
                isError: true,
                stdout: status.ok
                  ? 'Default checkout has uncommitted changes'
                  : status.output,
              };
            }

            const merge = await runGitInRepo(
              group,
              `merge --no-edit ${shellQuote(branch)}`,
              effective.instance,
            );
            if (!merge.ok) {
              await runGitInRepo(group, 'merge --abort', effective.instance);
              return { isError: true, stdout: merge.output };
            }
            const alignWorktree = await runGitInRepo(
              group,
              `-C ${shellQuote(`.worktrees/${branch}`)} reset --hard ${shellQuote(base)}`,
              effective.instance,
            );
            let output = [commitOutput, merge.output, alignWorktree.output]
              .filter(Boolean)
              .join('\n');
            if (!alignWorktree.ok) return { isError: true, stdout: output };
            if (group.settings?.autoPushAfterMerge) {
              const push = await runGitInRepo(
                group,
                `push origin ${shellQuote(base)}`,
                effective.instance,
              );
              output = [output, push.output].filter(Boolean).join('\n');
              if (!push.ok) return { isError: true, stdout: output };
            }
            return {
              isError: false,
              stdout: JSON.stringify({ merged: true, output }),
            };
          },
          lockOptions,
        );
      const mergeSucceeded = (result: {
        isError: boolean;
        stdout: string;
      }): boolean => {
        if (result.isError) return false;
        try {
          return (
            (JSON.parse(result.stdout || '{}') as { merged?: boolean })
              .merged === true
          );
        } catch {
          return false;
        }
      };
      const transition = removeWorktree
        ? await transitionConversationsFromRemovedWorktree(
            group.folder,
            branch,
            async () => {
              const result = await merge();
              if (!mergeSucceeded(result)) {
                failedRemoval = result;
                throw new Error('Worktree could not be merged');
              }
              return result;
            },
          )
        : {
            // Keeping the worktree: the commit and `reset --hard` edit it, so
            // no conversation bound to the branch may run meanwhile. Same
            // admission, ordering and lock completion as update-from-default.
            result: await withConversationWorktreeMaintenance(
              group.folder,
              branch,
              () => merge({ waitForCompletion: true }),
            ),
            affectedConversationIds: [],
          };
      const { result, affectedConversationIds } = transition;
      const merged = mergeSucceeded(result);
      if (!merged) {
        return res.status(409).json({
          error: 'Worktree could not be merged',
          detail: result.stdout,
        });
      }
      if (removeWorktree) {
        broadcast({
          type: 'conversations_changed',
          payload: { folder: group.folder },
        });
      }
      logger.info(
        {
          conversation_id: conversation.id,
          branch,
          base,
          worktree_removed: removeWorktree,
          affectedConversationIds,
        },
        'Merged conversation worktree into default branch',
      );
      return res.json({
        ok: true,
        branch,
        base,
        worktreeRemoved: removeWorktree,
        output: result.stdout,
      });
    } catch (err) {
      if (err instanceof ConversationWorktreeInUseError) {
        return res.status(409).json({
          error: err.message,
          conversationIds: err.conversationIds,
        });
      }
      if (failedRemoval) {
        return res.status(409).json({
          error: 'Worktree could not be merged',
          detail: failedRemoval.stdout,
        });
      }
      logger.warn(
        { conversation_id: conversation.id, branch, error: String(err) },
        'Failed to merge conversation worktree',
      );
      return res.status(500).json({ error: String(err) });
    }
  },
);

/**
 * Merge the local default branch into a conversation-owned worktree. A
 * conflicting merge is aborted so the worktree is left exactly as before.
 */
router.post(
  '/projects/:pid/conversations/:cid/worktree/update-from-default',
  async (req: any, res) => {
    const target = await requireIdleOwnedConversationWorktree(req, res);
    if (!target) return;
    const { group, conversation, branch } = target;
    const instance = resolveEffectiveSandbox(group).instance;
    const base = group.settings?.defaultBranch || 'develop';
    if (!isSafeWorktreeBranch(base)) {
      return res.status(400).json({ error: 'Invalid default branch' });
    }
    try {
      // Same ordering as worktree removal: branch admission first, then the
      // project git lock. Maintenance admission covers every conversation
      // bound to this branch: it rejects when any of them has a run or lease
      // (checked on the admission transaction) and holds the others' admission
      // until the merge (or its abort) has finished.
      const result = await withConversationWorktreeMaintenance(
        group.folder,
        branch,
        () =>
          withProjectGitLock(
            group.folder,
            () =>
              updateWorktreeFromDefaultBranch(group, branch, base, instance),
            { waitForCompletion: true },
          ),
      );
      if (result.status === 'updated' || result.status === 'up-to-date') {
        logger.info(
          { conversation_id: conversation.id, branch, base, ...result },
          'Updated conversation worktree from default branch',
        );
        return res.json({
          ok: true,
          branch,
          base,
          updated: result.status === 'updated',
          output: result.output,
        });
      }
      if (result.status === 'dirty') {
        return res.status(409).json({
          error: 'Commit or discard changes first',
          detail: result.output,
        });
      }
      if (result.status === 'conflict') {
        return res.status(409).json({
          error: `Merging ${base} into ${branch} conflicts in ${result.conflicts.join(', ')}. The merge was aborted and the worktree is unchanged.`,
          conflicts: result.conflicts,
        });
      }
      return res.status(500).json({
        error: `Could not update ${branch} from ${base}`,
        detail: result.output,
      });
    } catch (err) {
      if (err instanceof ConversationWorktreeInUseError) {
        return res.status(409).json({
          error: err.message,
          conversationIds: err.conversationIds,
        });
      }
      logger.warn(
        { conversation_id: conversation.id, branch, error: String(err) },
        'Failed to update conversation worktree from default branch',
      );
      return res.status(500).json({ error: String(err) });
    }
  },
);

/** Discard a conversation-owned branch and remove its worktree. */
router.delete(
  '/projects/:pid/conversations/:cid/worktree',
  async (req: any, res) => {
    const target = await requireIdleOwnedConversationWorktree(req, res);
    if (!target) return;
    const { group, conversation, branch } = target;
    const effective = resolveEffectiveSandbox(group);
    const client = (await import('../lib/mcp-client.js')).getSandboxClient();
    let failedRemoval: { stdout: string; isError: boolean } | undefined;
    try {
      const { result, affectedConversationIds } =
        await transitionConversationsFromRemovedWorktree(
          group.folder,
          branch,
          async () => {
            const result = await client.sandboxWorktree(
              effective.stack,
              'remove',
              {
                branch,
                instance: effective.instance,
                localRepo: group.settings!.repositoryLocation,
                remoteUrl: effectiveRemoteUrl(effective),
                repoPath: effective.inherited
                  ? effective.workspaceRoot
                  : undefined,
                service: effective.service,
              },
            );
            if (result.isError) {
              failedRemoval = result;
              throw new Error('Worktree could not be removed');
            }
            return result;
          },
        );
      broadcast({
        type: 'conversations_changed',
        payload: { folder: group.folder },
      });
      logger.info(
        { conversation_id: conversation.id, branch, affectedConversationIds },
        'Discarded conversation worktree',
      );
      return res.json({ ok: true, branch, output: result.stdout });
    } catch (err) {
      if (err instanceof ConversationWorktreeInUseError) {
        return res.status(409).json({
          error: err.message,
          conversationIds: err.conversationIds,
        });
      }
      if (failedRemoval) {
        return res.status(409).json({
          error: 'Worktree could not be removed',
          detail: failedRemoval.stdout,
        });
      }
      logger.warn(
        { conversation_id: conversation.id, branch, error: String(err) },
        'Failed to discard conversation worktree',
      );
      return res.status(500).json({ error: String(err) });
    }
  },
);

/**
 * POST /api/projects/:pid/conversations/:cid/fork
 * Fork a conversation: create a new conversation inheriting the source session_id.
 * The first message sent to the forked conversation will use --fork-session --resume
 * to branch the Claude session rather than continuing it in place.
 */
router.post('/projects/:pid/conversations/:cid/fork', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });

  if (!(await requireConversationAccess(req, res, req.params.cid, 'write')))
    return;
  if (!canEditProjectLocalFiles(req))
    return res
      .status(403)
      .json({ error: 'Cannot create conversations in this project' });

  const { messageId, includeAssistantTurn } = req.body || {};
  if (messageId && typeof messageId !== 'string')
    return res.status(400).json({ error: 'messageId must be a string' });

  let newConv: Awaited<ReturnType<typeof forkConversation>> | undefined;
  try {
    const forkingUserId = (req as any).authUser?.id ?? null;
    newConv = await forkConversation(req.params.pid, req.params.cid, {
      ownerUserId: forkingUserId,
      triggerSource: forkingUserId ? 'user' : 'system',
    });
    if ((req as any).authUser?.id) {
      try {
        await upsertConversationMember(
          (req as any).authUser.id,
          newConv.id,
          'owner',
        );
      } catch (err) {
        logger.warn(
          { err, conversation_id: newConv.id },
          'Failed to record fork owner',
        );
      }
    }
    const includeAssistant = !!includeAssistantTurn;
    if (messageId) {
      // Use transcript as the source of truth for "isLast" check
      const entries = readChatTranscript(req.params.pid, req.params.cid);
      const targetIdx = entries.findIndex((e: any) => {
        const eid = e.id || e.uuid || e.message?.id || e.part?.id;
        const cleanTarget = messageId.replace(/^(u-|a-|msg-|chat-)/, '');
        const cleanEid = eid?.replace(/^(u-|a-|msg-|chat-)/, '');
        return (
          cleanTarget === cleanEid ||
          `msg-${e.created_at}` === messageId ||
          `chat-${e.created_at}` === messageId ||
          `u-${e.created_at}` === messageId ||
          `a-${e.created_at}` === messageId
        );
      });

      // Forking "after an assistant turn" anchors on the preceding USER message
      // and includes its following assistant turn. The slice endpoint is the
      // end of that turn; agent resolution and the isLast check both operate on
      // this endpoint so the fork continues with the included turn's agent and
      // doesn't clear the session when the included turn is the last one.
      let endIdx = targetIdx;
      if (targetIdx !== -1 && includeAssistant) {
        for (let i = targetIdx + 1; i < entries.length; i++) {
          const e = entries[i] as any;
          const role =
            e.role ||
            (e.type === 'assistant' ||
            e.type === 'tool_use' ||
            e.type === 'result' ||
            e.type === 'step_start'
              ? 'assistant'
              : '');
          if (role === 'assistant') endIdx = i;
          else if (role === 'user' && !isProviderContextEntry(e)) break;
        }
      }

      // Resolve the agent that was active at the forked bubble so the fork
      // continues with THAT agent, not whichever agent the source conversation
      // most recently switched to. Walk backwards from the slice endpoint to
      // the first entry that carries an agent_name (some entry types omit it).
      if (endIdx !== -1) {
        let forkAgent: string | null = null;
        for (let i = endIdx; i >= 0; i--) {
          const an = (entries[i] as any)?.agent_name;
          if (typeof an === 'string' && an.trim()) {
            forkAgent = an;
            break;
          }
        }
        if (forkAgent) {
          const forkRuntime = resolveAgentReference(forkAgent);
          if (forkRuntime) {
            // forkConversation already copied the source conversation's exact
            // structured selection. Retain it when it targets the same binding
            // as the runtime at the fork point so an explicit reasoning choice is not
            // replaced by the binding default while forking.
            const copiedBindingMatches =
              newConv.runtimeSelection?.harnessId === forkRuntime.harnessId &&
              newConv.runtimeSelection?.modelId === forkRuntime.modelId;
            if (!copiedBindingMatches) {
              const runtimeSelection =
                runtimeSelectionFromResolvedAgent(forkRuntime);
              if (runtimeSelection) {
                await setConversationRuntimeSelection(
                  newConv.id,
                  runtimeSelection,
                );
                newConv.runtimeSelection = runtimeSelection;
              }
            }
          }
        }
      }

      let isLast = false;
      if (endIdx !== -1) {
        // If it's the absolute last entry, it's definitely isLast
        if (endIdx === entries.length - 1) {
          isLast = true;
        } else {
          // If there are entries after it, check if they are all just part of the same turn
          const following = entries
            .slice(endIdx + 1)
            .filter((entry) => !isProviderContextEntry(entry));
          const hasUserFollowing = following.some(
            (e: any) =>
              (e as any).role === 'user' ||
              ((e as any).type === 'message' && (e as any).role === 'user'),
          );
          const hasDifferentAssistantFollowing = following.some((e: any) => {
            const role =
              (e as any).role ||
              ((e as any).type === 'assistant' ||
              (e as any).type === 'tool_use' ||
              (e as any).type === 'result'
                ? 'assistant'
                : '');
            return (
              role === 'assistant' &&
              (e as any).created_at !== (entries[endIdx] as any).created_at
            );
          });

          if (!hasUserFollowing && !hasDifferentAssistantFollowing) {
            isLast = true;
          }
        }
      }

      if (!isLast) {
        // Intermediate slice: drop all per-agent sessions so whichever agent
        // resumes the fork starts fresh with a context summary of ONLY the
        // sliced transcript. This prevents "remembering the future".
        await clearConversationSession(newConv.id);
        newConv.session_id = null;
      }

      await copyChatTranscript(
        req.params.pid,
        req.params.cid,
        newConv.id,
        messageId,
        includeAssistant,
      );
    }
    broadcast({
      type: 'conversations_changed',
      payload: chatEventScope(req.params.pid, newConv.objective_id),
    });
    res.json({ id: newConv.id, conversation: newConv });
  } catch (err: any) {
    // Remove the half-built fork (cascades to its member and session rows and
    // erases any partially copied transcript).
    if (newConv) {
      await deleteConversation(req.params.pid, newConv.id).catch((cleanupErr) =>
        logger.warn(
          { err: cleanupErr, conversation_id: newConv?.id },
          'Failed to remove conversation after failed fork',
        ),
      );
    }
    res
      .status(404)
      .json({ error: err.message ?? 'Source conversation not found' });
  }
});

/**
 * POST /api/projects/:pid/conversations/:cid/handoff
 * Continue a conversation in another project without inheriting session or
 * worktree state. The destination starts with a bounded visible-context note.
 */
router.post('/projects/:pid/conversations/:cid/handoff', async (req, res) => {
  const authUser = (req as any).authUser;
  const sourceGroup = getGroupByFolder(req.params.pid);
  if (!sourceGroup)
    return res.status(404).json({ error: 'Source project not found' });
  if (!(await requireConversationAccess(req, res, req.params.cid, 'write')))
    return;

  const destinationProjectId =
    typeof req.body?.destinationProjectId === 'string'
      ? req.body.destinationProjectId.trim()
      : '';
  const requestedSelection = req.body?.runtimeSelection as
    | RuntimeSelection
    | null
    | undefined;
  const selectionError = validateRuntimeSelection(requestedSelection);
  if (selectionError) return res.status(400).json({ error: selectionError });
  if (!destinationProjectId || destinationProjectId === req.params.pid) {
    return res
      .status(400)
      .json({ error: 'Choose a different destination project' });
  }
  const destinationGroup = getGroupByFolder(destinationProjectId);
  if (!destinationGroup)
    return res.status(404).json({ error: 'Destination project not found' });
  if (!(await userCanAccessGroup(req, destinationProjectId))) {
    return res
      .status(403)
      .json({ error: 'Write access to destination project required' });
  }
  // Same rule as POST /conversations: only admins or explicit non-viewer
  // members may create (and own) a conversation in the destination project.
  if (authUser && !adminBypassesProject(authUser, destinationProjectId)) {
    const destinationAccess = await getProjectAccess(
      authUser.id,
      destinationProjectId,
    );
    if (!explicitLevelAtLeast(destinationAccess, 'editor')) {
      return res
        .status(403)
        .json({ error: 'Write access to destination project required' });
    }
  }

  const sourceConversation = await getConversation(req.params.cid);
  if (
    !sourceConversation ||
    sourceConversation.group_folder !== req.params.pid
  ) {
    return res.status(404).json({ error: 'Source conversation not found' });
  }
  const handoffSelection =
    requestedSelection || sourceConversation.runtimeSelection || undefined;

  const conversation = await createConversation(destinationProjectId, {
    ownerUserId: authUser?.id ?? destinationGroup.user_id ?? null,
    triggerSource: authUser?.id ? 'user' : 'system',
  });
  try {
    await inviteProjectDefaultAiUsers(
      conversation.id,
      destinationGroup,
      authUser?.id ?? null,
    );
    if (authUser?.id) {
      await upsertConversationMember(authUser.id, conversation.id, 'owner');
    }
    const handoff = buildConversationHandoff(
      req.params.pid,
      req.params.cid,
      sourceConversation.title,
    );
    appendChatTranscriptEntry(destinationProjectId, conversation.id, {
      id: `handoff-${Date.now()}-${randomUUID().slice(0, 8)}`,
      type: 'message',
      role: 'user',
      content: handoff,
      senderUserId: authUser?.id ?? undefined,
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });
    if (handoffSelection) {
      await setConversationRuntimeSelection(conversation.id, handoffSelection);
    }
    await updateConversation(conversation.id, destinationProjectId, {
      title: sourceConversation.title
        ? `Continued: ${sourceConversation.title}`
        : `Continued from ${sourceGroup.name || sourceGroup.folder}`,
    });
    const created = await getConversation(conversation.id);
    broadcast({
      type: 'conversations_changed',
      payload: { folder: destinationProjectId },
    });
    res.status(201).json({
      conversation: created || conversation,
      destinationProjectId,
      sourceConversationId: req.params.cid,
      handoffCreated: true,
    });
  } catch (error) {
    try {
      await deleteConversation(destinationProjectId, conversation.id);
    } catch (cleanupError) {
      logger.error(
        { error: cleanupError, conversation_id: conversation.id },
        'Failed to clean up conversation after failed handoff',
      );
    }
    logger.error(
      { error, conversation_id: req.params.cid, destinationProjectId },
      'Conversation handoff failed',
    );
    res.status(500).json({ error: 'Failed to create conversation handoff' });
  }
});

// --- Messages ---

/**
 * GET /api/projects/:pid/messages?limit=100&conversation_id=xxx
 * Returns the chat message history (WhatsApp + web) for a chat-mode project.
 */
router.get('/projects/:pid/messages', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });

  const parsedLimit = parseInt(String(req.query.limit ?? '100'), 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(1, parsedLimit), 500, MAX_PAGINATION_VALUE)
    : 100;
  const conversation_id = req.query.conversation_id
    ? String(req.query.conversation_id)
    : undefined;

  // Implicit (chat-only) users reach this route through the project guard, so
  // conversation scoping has to be enforced here.
  if (conversation_id) {
    const conversation = await getConversation(conversation_id);
    if (!conversation || conversation.group_folder !== req.params.pid)
      return res.status(404).json({ error: 'Conversation not found' });
    if (!(await requireConversationAccess(req, res, conversation_id, 'read')))
      return;
  } else if ((req as any).projectAccess?.kind === 'implicit') {
    return res.status(403).json({ error: 'Access denied to this project' });
  }

  const messages = await getChatMessages(
    req.params.pid,
    limit,
    conversation_id,
  );
  const hydratedMessages = await hydrateTranscriptSenderNames(messages);
  res.json(hydratedMessages.reverse());
});

/**
 * POST /api/projects/:pid/upload
 * Save an attached file to the group's IPC uploads dir so the agent container can access it.
 * Body: { filename: string, data: string (base64) }
 * Returns: { containerPath: string } — the path visible inside the container
 */
router.post('/projects/:pid/upload', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });

  const { filename, data, conversation_id, mimetype } = req.body ?? {};
  if (typeof filename !== 'string' || !filename || typeof data !== 'string') {
    return res
      .status(400)
      .json({ error: 'filename and data (base64) are required' });
  }

  // Enforce upload size limit (50 MB base64 ≈ ~37 MB decoded)
  const MAX_UPLOAD_BASE64 = 50 * 1024 * 1024;
  if (data.length > MAX_UPLOAD_BASE64) {
    return res.status(413).json({ error: 'File too large (max ~37 MB)' });
  }

  // Sanitise filename — strip path traversal
  const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._\-]/g, '_');
  const storedName = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`;

  const uploadDir = effectiveProjectUploadDir(group, DATA_DIR);
  await fsp.mkdir(uploadDir, { recursive: true });

  const filePath = path.join(uploadDir, storedName);
  const buffer = Buffer.from(data, 'base64');
  await fsp.writeFile(filePath, buffer);

  const containerPath = `${effectiveContainerUploadDir(group)}/${storedName}`;
  const browserUrl = `/uploads/${group.folder}/${storedName}`;
  logger.info({ project: req.params.pid, file: storedName }, 'File uploaded');

  // Keep conversation attachments in the durable artifact tree as well as
  // the IPC upload directory used by the agent. Artifact persistence is
  // best-effort so a thumbnail/sidecar failure never blocks the chat upload.
  if (typeof conversation_id === 'string' && conversation_id) {
    try {
      await writeArtifactFile(
        group.folder,
        `upload/${conversation_id}/${storedName}`,
        buffer,
        {
          mimetype: typeof mimetype === 'string' ? mimetype : null,
          caption: safeName,
          source: 'uploaded',
        },
      );
      broadcast({
        type: 'artifacts_changed',
        payload: { folder: group.folder },
      });
    } catch (err) {
      logger.warn(
        { err, conversation_id },
        'Failed to save chat attachment as artifact',
      );
    }
  }

  res.json({
    containerPath,
    browserUrl,
    originalName: safeName,
    absolutePath: filePath,
  });
});

/**
 * DELETE /api/projects/:pid/artifacts/*path
 * Remove an artifact file (and its best-effort sidecar) by its artifact-relative
 * path (e.g. "meetings/conv-123.md").
 */
router.delete('/projects/:pid/artifacts/*path', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });
  if (!(await userCanAccessGroup(req, group.folder))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // Express wildcard param is an array; join to reconstruct the rel-path.
  const parts = (req.params as Record<string, string | string[]>)['path'];
  const relPath = Array.isArray(parts)
    ? parts.join('/')
    : (parts as string) || '';
  if (!relPath) return res.status(404).json({ error: 'Artifact not found' });
  const outcome = await withFavoritesLock(group.folder, async () => {
    // Pending moves are judged by the files: settle them before this delete
    // changes the evidence.
    if (!(await settleFavoriteMoves(group.folder))) return 'unsettled';
    const removed = await deleteArtifactByPath(group.folder, relPath);
    if (!removed) return 'missing';
    await dropDeletedFavorites(group.folder, `artifacts/${relPath}`).catch(
      (err) =>
        logger.warn(
          { err, folder: group.folder },
          'File favorites sync failed',
        ),
    );
    return 'deleted';
  });
  if (outcome === 'unsettled')
    return res.status(503).json({
      error:
        'Favorites are still being updated for an earlier change; try again',
    });
  if (outcome === 'missing')
    return res.status(404).json({ error: 'Artifact not found' });
  broadcast({
    type: 'artifacts_changed',
    payload: { folder: group.folder },
  });
  res.json({ ok: true });
});

/**
 * GET /api/projects/:pid/diff
 * GET /api/projects/:pid/conversations/:cid/diff
 * Git diff for the project's main checkout or a conversation worktree. Two scopes:
 *   - "worktree": conversation runs in its own git worktree → diff since merge-base
 *     with the default branch, including uncommitted edits and untracked files when
 *     the worktree exists. Falls back to committed-only base...branch when not.
 *   - "working-tree": conversation edits the repo's shared checkout directly
 *     (objective chats and chats without a worktree) → uncommitted `git diff HEAD`
 *     plus untracked files. This reflects the repo's CURRENT uncommitted state,
 *     shared across conversations — not strictly this conversation's edits.
 * Git always runs inside the sandbox via runGitInRepo — never the host path.
 */
router.get(
  ['/projects/:pid/diff', '/projects/:pid/conversations/:cid/diff'],
  async (req, res) => {
    const projectId = String(req.params.pid);
    const group = getGroupByFolder(projectId);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const conversationId =
      typeof req.params.cid === 'string' ? req.params.cid : undefined;
    if (
      conversationId &&
      !(await requireConversationAccess(req, res, conversationId, 'read'))
    )
      return;

    const conv = conversationId
      ? await loadConversationInProject(conversationId, group)
      : null;
    if (conversationId && !conv)
      return res.status(404).json({ error: 'Conversation not found' });
    if (!group.settings?.repositoryLocation) {
      return res.json({ available: false, reason: 'no-repo' });
    }

    res.set('Cache-Control', 'no-store');

    // Generous per-request ceiling. With batched git calls a worktree diff with
    // hundreds of untracked files completes in <1s; this just guards against a
    // pathological sandbox so the worker doesn't sit on a stuck call forever.
    req.setTimeout(180_000);

    const refPattern = /^[\w./-]+$/;
    const instance = resolveEffectiveSandbox(group).instance;

    try {
      if (conv?.use_worktree) {
        const scope = 'worktree' as const;
        const branch = conv.branch_name || `chat-${conversationId}`;
        const base = group.settings?.defaultBranch || 'develop';
        if (!refPattern.test(branch) || !refPattern.test(base)) {
          return res.status(400).json({ error: 'Invalid branch/base ref' });
        }

        // Prefer the isolated worktree (committed + uncommitted + untracked).
        const wtRel = `.worktrees/${branch}`;
        const gitPrefix = `-C ${wtRel} `;
        // merge-base must complete first to know the right baseRef for `git diff`.
        // It's a cheap ref-only call so it stays sequential.
        const mbRes = await runGitInRepo(
          group,
          `${gitPrefix}merge-base ${base} ${branch}`,
          instance,
        );
        const mb = mbRes.ok
          ? (mbRes.output.trim().split('\n')[0] || '').trim()
          : '';
        const baseRef = COMMIT_SHA_PATTERN.test(mb) ? mb : base;
        // Now fan out: the diff itself, the numstat, and the untracked file list
        // are all independent. Replaces the previous sequential 3+ RTTs with a
        // single round-trip wall-clock for the read-only part of the request.
        const [wtPatchRes, wtStatRes, lsRes, statusRes, defaultBranchAhead] =
          await Promise.all([
            runGitInRepo(
              group,
              `${gitPrefix}diff --no-color ${baseRef}`,
              instance,
            ),
            runGitInRepo(
              group,
              `${gitPrefix}diff --no-color --numstat ${baseRef}`,
              instance,
            ),
            runGitInRepo(
              group,
              `${gitPrefix}ls-files --others --exclude-standard`,
              instance,
            ),
            runGitInRepo(
              group,
              `${gitPrefix}status --porcelain=v1 -z --untracked-files=all`,
              instance,
            ),
            countCommitsBehindDefaultBranch(group, branch, base, instance),
          ]);
        if (wtPatchRes.ok) {
          const changeSections = await getIndexDiffSections(
            group,
            instance,
            gitPrefix,
            baseRef,
          );
          let files = parseGitNumstat(wtStatRes.ok ? wtStatRes.output : '');
          let patch = wtPatchRes.output;
          // Reuse the ls-files output we already have so we don't issue a second one.
          ({ patch, files } = await appendUntrackedDiffFromList(
            group,
            instance,
            gitPrefix,
            patch,
            files,
            lsRes.ok ? lsRes.output : '',
          ));
          return res.json({
            available: true,
            scope,
            base,
            branch,
            files,
            patch,
            ...(changeSections ? { changeSections } : {}),
            ...(statusRes.ok
              ? { uncommitted: statusRes.output.length > 0 }
              : {}),
            ...(defaultBranchAhead !== undefined ? { defaultBranchAhead } : {}),
          });
        }

        // Worktree gone (merged/removed): committed changes only. Same fan-out
        // pattern: diff + numstat are independent.
        const range = `${base}...${branch}`;
        const [patchRes, statRes] = await Promise.all([
          runGitInRepo(group, `diff --no-color ${range}`, instance),
          runGitInRepo(group, `diff --no-color --numstat ${range}`, instance),
        ]);
        if (!patchRes.ok) {
          return res.json({
            available: false,
            reason: 'diff-failed',
            scope,
            base,
            branch,
          });
        }
        const files = parseGitNumstat(statRes.ok ? statRes.output : '');
        return res.json({
          available: true,
          scope,
          base,
          branch,
          files,
          patch: patchRes.output,
        });
      }

      const scope = 'working-tree' as const;
      const base = 'HEAD';
      const wtDiff = await getWorkingTreeDiff(group, instance);
      if (wtDiff?.repositoryState === 'not-initialized') {
        return res.json({
          available: false,
          reason: 'not-initialized',
          scope,
          defaultBranch: group.settings?.defaultBranch || 'develop',
        });
      }
      if (!wtDiff) {
        return res.json({
          available: false,
          reason: 'diff-failed',
          scope,
          base,
        });
      }
      return res.json({
        available: true,
        scope,
        base,
        files: wtDiff.files,
        patch: wtDiff.patch,
        changeSections: await getIndexDiffSections(group, instance),
        uncommitted: true,
        repositoryState: wtDiff.repositoryState,
        branch: wtDiff.branch,
      });
    } catch (err) {
      logger.warn(
        { err, cid: conversationId },
        'Failed to compute repository diff',
      );
      res.json({ available: false, reason: 'diff-error' });
    }
  },
);

/** Stage or unstage one file in the checkout shown by the Changes tab. */
router.post(
  ['/projects/:pid/git/index', '/projects/:pid/conversations/:cid/git/index'],
  async (req: any, res) => {
    const group = getGroupByFolder(String(req.params.pid));
    if (!group) return res.status(404).json({ error: 'Project not found' });
    if (!group.settings?.repositoryLocation)
      return res
        .status(400)
        .json({ error: 'No repository configured for this project' });
    const filePath = req.body?.path;
    const previousPath = req.body?.previousPath;
    const action = req.body?.action;
    if (
      !['stage', 'unstage', 'stageAll'].includes(action) ||
      (action === 'stageAll'
        ? filePath !== undefined || previousPath !== undefined
        : !isSafeRelativePath(filePath) ||
          (previousPath !== undefined && !isSafeRelativePath(previousPath)) ||
          filePath === '.' ||
          previousPath === '.')
    )
      return res
        .status(400)
        .json({ error: 'Valid file path and action are required' });

    const conversationId =
      typeof req.params.cid === 'string' ? req.params.cid : null;
    let gitPrefix = '';
    let worktreeBranch: string | undefined;
    if (conversationId) {
      const conversation = await getConversation(conversationId);
      if (!conversation || conversation.group_folder !== group.folder)
        return res.status(404).json({ error: 'Conversation not found' });
      if (!(await requireConversationAccess(req, res, conversationId, 'write')))
        return;
      if (!conversation.use_worktree)
        return res
          .status(400)
          .json({ error: 'Conversation does not use a worktree' });
      const target = await requireIdleOwnedConversationWorktree(req, res);
      if (!target) return;
      worktreeBranch = target.branch;
      gitPrefix = `-C ${shellQuote(`.worktrees/${target.branch}`)} `;
    } else if (!canEditProjectLocalFiles(req)) {
      return res
        .status(403)
        .json({ error: 'Write access to this project required' });
    }

    const instance = resolveEffectiveSandbox(group).instance;
    const updateIndex = async () => {
      let command =
        action === 'stageAll'
          ? 'add -A'
          : action === 'stage'
            ? 'add'
            : 'restore --staged';
      if (action === 'unstage') {
        const head = await runGitInRepo(
          group,
          `${gitPrefix}rev-parse --verify HEAD`,
          instance,
        );
        if (!head.ok) command = 'rm --cached -q';
      }
      return runGitInRepo(
        group,
        action === 'stageAll'
          ? `${gitPrefix}${command}`
          : `${gitPrefix}${command} -- ${shellQuote(`:(literal)${filePath}`)}${previousPath ? ` ${shellQuote(`:(literal)${previousPath}`)}` : ''}`,
        instance,
        { waitForCompletion: true },
      );
    };
    let result: Awaited<ReturnType<typeof updateIndex>>;
    try {
      result = worktreeBranch
        ? await withIdleBranchGitLock(group.folder, worktreeBranch, updateIndex)
        : await withProjectGitLock(group.folder, updateIndex);
    } catch (err) {
      if (respondWorktreeInUse(res, err)) return;
      throw err;
    }
    if (!result.ok)
      return res
        .status(400)
        .json({ error: 'Git index update failed', detail: result.output });
    res.json({ ok: true });
  },
);

/**
 * GET /api/projects/:pid/commit-message
 * GET /api/projects/:pid/conversations/:cid/commit-message
 * Suggest a commit message for uncommitted changes (LLM-generated).
 * Conversation-owned worktrees use their isolated checkout; other chats use
 * the shared default checkout.
 */
router.get(
  [
    '/projects/:pid/commit-message',
    '/projects/:pid/conversations/:cid/commit-message',
  ],
  async (req, res) => {
    const group = getGroupByFolder(String(req.params.pid));
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const conversationId =
      typeof req.params.cid === 'string' ? req.params.cid : null;
    let conv: Awaited<ReturnType<typeof getConversation>> | null = null;
    if (conversationId) {
      if (!(await requireConversationAccess(req, res, conversationId, 'read')))
        return;
      conv = await loadConversationInProject(conversationId, group);
      if (!conv)
        return res.status(404).json({ error: 'Conversation not found' });
      if (conv.use_worktree && !conversationOwnsWorktree(conv)) {
        return res.status(409).json({
          error: 'This conversation is bound to a shared worktree',
        });
      }
    }
    if (!group.settings?.repositoryLocation) {
      return res
        .status(400)
        .json({ error: 'No repository configured for this project' });
    }

    const instance = resolveEffectiveSandbox(group).instance;
    const branch = conv?.use_worktree
      ? conv.branch_name || `chat-${conversationId}`
      : null;
    if (branch && !isSafeWorktreeBranch(branch)) {
      return res.status(400).json({ error: 'Invalid worktree branch' });
    }
    const wtDiff = branch
      ? await getConversationWorktreeDiff(group, branch, instance)
      : await getWorkingTreeDiff(group, instance);
    const indexSections =
      req.query.stagedOnly === 'true'
        ? await getIndexDiffSections(
            group,
            instance,
            branch ? `-C ${shellQuote(`.worktrees/${branch}`)} ` : '',
          )
        : null;
    const staged = indexSections?.find((section) => section.kind === 'staged');
    if (!wtDiff) {
      return res
        .status(500)
        .json({ error: 'Failed to read working-tree diff' });
    }
    if (req.query.stagedOnly === 'true' && !indexSections)
      return res.status(500).json({ error: 'Failed to read staged diff' });
    if (
      req.query.stagedOnly === 'true'
        ? !staged?.files.length
        : wtDiff.files.length === 0 && !wtDiff.patch.trim()
    ) {
      return res
        .status(400)
        .json({ error: 'No uncommitted changes to commit' });
    }

    const message = await suggestWorkingTreeCommitMessage(
      group,
      conversationId,
      staged?.files ?? wtDiff.files,
      staged?.patch ?? wtDiff.patch,
    );
    res.json({ message });
  },
);

/**
 * POST /api/projects/:pid/commit
 * POST /api/projects/:pid/conversations/:cid/commit
 * Commit all uncommitted changes in the shared repo checkout or an owned
 * conversation worktree. Body: { message: string }.
 */
router.post(
  ['/projects/:pid/commit', '/projects/:pid/conversations/:cid/commit'],
  async (req: any, res) => {
    const group = getGroupByFolder(String(req.params.pid));
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const conversationId =
      typeof req.params.cid === 'string' ? req.params.cid : null;
    let conversation: Awaited<ReturnType<typeof getConversation>>;
    if (conversationId) {
      if (!(await requireConversationAccess(req, res, conversationId, 'write')))
        return;
      conversation = await getConversation(conversationId);
      if (!conversation || conversation.group_folder !== group.folder)
        return res.status(404).json({ error: 'Conversation not found' });
      if (
        conversation.use_worktree &&
        !conversationOwnsWorktree(conversation)
      ) {
        return res.status(409).json({
          error: 'This conversation is bound to a shared worktree',
        });
      }
    }
    // Committing the shared project checkout needs project write access; only
    // an owned conversation worktree is covered by conversation access alone.
    if (!conversation?.use_worktree && !canEditProjectLocalFiles(req)) {
      return res
        .status(403)
        .json({ error: 'Write access to this project required' });
    }
    if (!group.settings?.repositoryLocation) {
      return res
        .status(400)
        .json({ error: 'No repository configured for this project' });
    }

    const message =
      typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'message is required' });
    const msgErr = lenError(message, MAX_COMMIT_MESSAGE_LEN, 'message');
    if (msgErr) return res.status(400).json({ error: msgErr });

    if (req.body?.stagedOnly === true) {
      let gitPrefix = '';
      let worktreeBranch: string | undefined;
      if (conversation?.use_worktree) {
        const target = await requireIdleOwnedConversationWorktree(req, res);
        if (!target) return;
        worktreeBranch = target.branch;
        gitPrefix = `-C ${shellQuote(`.worktrees/${target.branch}`)} `;
      }
      const instance = resolveEffectiveSandbox(group).instance;
      const commitStaged = async () => {
        const staged = await runGitInRepo(
          group,
          `${gitPrefix}diff --cached --name-only`,
          instance,
        );
        if (!staged.ok || !staged.output.trim())
          return { ok: false, output: 'No staged changes to commit' };
        return runGitInRepo(
          group,
          `${gitPrefix}commit -m ${shellQuote(message)}`,
          instance,
          { waitForCompletion: true },
        );
      };
      let result: Awaited<ReturnType<typeof commitStaged>>;
      try {
        result = worktreeBranch
          ? await withIdleBranchGitLock(
              group.folder,
              worktreeBranch,
              commitStaged,
            )
          : await withProjectGitLock(group.folder, commitStaged);
      } catch (err) {
        if (respondWorktreeInUse(res, err)) return;
        throw err;
      }
      if (!result.ok)
        return res
          .status(400)
          .json({ error: 'Commit failed', detail: result.output });
      return res.json({ ok: true, output: result.output });
    }

    if (conversation?.use_worktree) {
      const target = await requireIdleOwnedConversationWorktree(req, res);
      if (!target) return;
      const effective = resolveEffectiveSandbox(group);
      const wtDiff = await getConversationWorktreeDiff(
        group,
        target.branch,
        effective.instance,
      );
      if (!wtDiff) {
        return res.status(500).json({ error: 'Failed to read worktree diff' });
      }
      if (wtDiff.files.length === 0 && !wtDiff.patch.trim()) {
        return res
          .status(400)
          .json({ error: 'No uncommitted changes to commit' });
      }

      const client = (await import('../lib/mcp-client.js')).getSandboxClient();
      let result: Awaited<ReturnType<typeof client.sandboxBranch>>;
      try {
        result = await withIdleBranchGitLock(group.folder, target.branch, () =>
          client.sandboxBranch(effective.stack, 'commit', {
            branch: target.branch,
            instance: effective.instance,
            localRepo: group.settings!.repositoryLocation,
            remoteUrl: effectiveRemoteUrl(effective),
            repoPath: effective.inherited ? effective.workspaceRoot : undefined,
            service: effective.service,
            worktree_path: `.worktrees/${target.branch}`,
            commitMessage: message,
          }),
        );
      } catch (err) {
        if (respondWorktreeInUse(res, err)) return;
        throw err;
      }
      const output = result.stdout || '';
      if (result.isError) {
        return res.status(500).json({ error: 'Commit failed', detail: output });
      }
      return res.json({ ok: true, output });
    }

    const instance = resolveEffectiveSandbox(group).instance;
    const wtDiff = await getWorkingTreeDiff(group, instance);
    if (!wtDiff) {
      return res
        .status(500)
        .json({ error: 'Failed to read working-tree diff' });
    }
    if (wtDiff.files.length === 0 && !wtDiff.patch.trim()) {
      return res
        .status(400)
        .json({ error: 'No uncommitted changes to commit' });
    }

    const result = await commitWorkingTree(group, message, instance);
    if (!result.ok) {
      return res
        .status(500)
        .json({ error: 'Commit failed', detail: result.output });
    }
    res.json({ ok: true, output: result.output });
  },
);

/**
 * GET /api/projects/:pid/files/repo
 * GET /api/projects/:pid/conversations/:cid/files/repo
 * List the project repo's full file tree for the chat "Files" sidebar tab.
 *
 * Two `git ls-files` invocations run inside the sandbox via runGitInRepo:
 *   1. `ls-files --cached --others --exclude-standard` — tracked + untracked
 *      files that AREN'T ignored. This is the canonical "what's in the
 *      project" listing the user opens 99% of the time.
 *   2. `ls-files --others --ignored --exclude-standard` — untracked files
 *      that ARE matched by .gitignore. Returned separately so the UI can
 *      render them grayed out (and visibly tagged as "gitignored") rather
 *      than hide them entirely. `.env`, `node_modules`, `dist`, … are the
 *      common cases — useful to inspect but not the main file tree.
 *
 * The board container has no repo, so both calls go through the sandbox;
 * we mirror how the diff endpoint resolves the instance. Returns
 * { available: false, reason } when there's no repo or the sandbox call
 * fails; ignored stays as an empty array in that case so the UI can render
 * a clean empty state without a separate field check.
 */
router.get(
  ['/projects/:pid/files/repo', '/projects/:pid/conversations/:cid/files/repo'],
  async (req, res) => {
    const projectId = String(req.params.pid);
    const group = getGroupByFolder(projectId);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const conversationId =
      typeof req.params.cid === 'string' ? req.params.cid : undefined;
    if (
      conversationId &&
      !(await requireConversationAccess(req, res, conversationId, 'read'))
    )
      return;

    const conv = conversationId
      ? await loadConversationInProject(conversationId, group)
      : null;
    if (conversationId && !conv)
      return res.status(404).json({ error: 'Conversation not found' });
    if (!group.settings?.repositoryLocation) {
      return res.json({
        available: false,
        reason: 'no-repo',
        ignored: [],
      } satisfies RepoFilesResponse);
    }

    const instance = resolveEffectiveSandbox(group).instance;
    const directory = typeof req.query.path === 'string' ? req.query.path : '';
    const cursor =
      typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const requestedLimit = Number(req.query.limit ?? 50);
    const limit =
      Number.isSafeInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 100)
        : 50;
    if (directory && !isSafeRelativePath(directory)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    // Worktree conversations have their own checkout under .worktrees/<branch>,
    // so list THAT tree (not the shared main checkout) — otherwise the Files
    // tab would show the main repo's files for a conversation whose edits live
    // in an isolated worktree. Non-worktree conversations all share the main
    // repo; the UI caches that listing once per project and reuses it across
    // conversations (see queryKeys.repoFiles.shared), so it isn't re-fetched
    // on every conversation switch.
    const worktreeBranch = conv?.use_worktree
      ? conv.branch_name || `chat-${conversationId}`
      : undefined;
    if (worktreeBranch !== undefined && !isSafeWorktreeBranch(worktreeBranch)) {
      return res.json({
        available: false,
        reason: 'list-failed',
        ignored: [],
      } satisfies RepoFilesResponse);
    }
    const worktreeDirectory =
      worktreeBranch !== undefined ? `.worktrees/${worktreeBranch}` : undefined;

    try {
      if (search) {
        // Search remains a separate submitted operation; it is not part of
        // directory browsing and therefore never runs on folder expansion.
        const listRes = await runGitInRepo(
          group,
          repoSearchCommand(search, limit, cursor, worktreeDirectory),
          instance,
        );
        if (!listRes.ok) throw new Error('list failed');
        return res.json({
          available: true,
          ...parseRepoSearchPage(listRes.output, limit, cursor),
          ignored: [],
        } satisfies RepoFilesResponse);
      }
      const listRes = await runGitInRepo(
        group,
        repoPageCommand(directory, limit, cursor, worktreeDirectory),
        instance,
      );
      if (!listRes.ok) {
        if (listRes.output.includes('__INVALID_DIRECTORY__')) {
          return res.status(400).json({ error: 'Invalid directory' });
        }
        return res.json({
          available: false,
          reason: 'list-failed',
          ignored: [],
        } satisfies RepoFilesResponse);
      }
      res.json({
        available: true,
        ...parseRepoPage(listRes.output, limit, cursor),
        ignored: [],
      } satisfies RepoFilesResponse);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message === 'Invalid cursor' ||
          err.message === 'Invalid directory')
      ) {
        return res.status(400).json({ error: err.message });
      }
      logger.warn(
        { err, cid: conversationId },
        'Failed to list conversation repo files',
      );
      res.json({
        available: false,
        reason: 'repo-error',
        ignored: [],
      } satisfies RepoFilesResponse);
    }
  },
);

/**
 * HEAD /api/projects/:pid/files/repo/content?path=<relative>
 * HEAD /api/projects/:pid/conversations/:cid/files/repo/content?path=<relative>
 * Same safety checks as the GET counterpart, but returns only headers
 * (Content-Length) so the preview pane can probe a file's size before
 * pulling the body. Mirrors the group-folder HEAD endpoint in kanban.ts.
 *
 * Must be registered before the GET route: Express lets `router.get` answer
 * HEAD requests, so a later HEAD handler would never run.
 */
router.head(
  [
    '/projects/:pid/files/repo/content',
    '/projects/:pid/conversations/:cid/files/repo/content',
  ],
  async (req, res) => {
    const projectId = String(req.params.pid);
    const group = getGroupByFolder(projectId);
    if (!group) return res.status(404).end();
    const conversationId =
      typeof req.params.cid === 'string' ? req.params.cid : undefined;
    if (
      conversationId &&
      !(await requireConversationAccess(req, res, conversationId, 'read'))
    )
      return;

    const conv = conversationId
      ? await loadConversationInProject(conversationId, group)
      : null;
    if (conversationId && !conv) return res.status(404).end();
    if (!group.settings?.repositoryLocation) {
      return res.status(404).end();
    }

    const relPath = req.query.path;
    if (!isSafeRelativePath(relPath)) {
      return res.status(400).end();
    }
    const quotedPath = shellQuote(relPath);
    const quotedRef = shellQuote(`HEAD:${relPath}`);

    const instance = resolveEffectiveSandbox(group).instance;
    const worktreeBranch = conv?.use_worktree
      ? conv.branch_name || `chat-${conversationId}`
      : undefined;
    if (worktreeBranch && !isSafeWorktreeBranch(worktreeBranch)) {
      return res.status(400).end();
    }
    const worktreeDirectory = worktreeBranch
      ? `.worktrees/${worktreeBranch}`
      : undefined;
    const gitPrefix = worktreeGitPrefix(worktreeDirectory);
    const mimetype = await resolveRepoMimetype(
      group,
      relPath,
      instance,
      worktreeDirectory,
    );

    // Tracked files: ask git for the blob size without reading the blob.
    // `git cat-file -s` returns the on-disk byte count, which is what we
    // want — same number we'd send in Content-Length for the GET.
    const sizeRes = await runGitInRepo(
      group,
      `${gitPrefix}cat-file -s ${quotedRef}`,
      instance,
    );
    if (sizeRes.ok && /^\d+$/.test(sizeRes.output.trim())) {
      res.setHeader('Content-Type', mimetype);
      res.setHeader('Content-Length', sizeRes.output.trim());
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.status(200).end();
    }

    // Untracked: confirm via ls-files, then `wc -c` for size. If the file
    // isn't in the untracked-non-ignored listing (i.e. it's gitignored) we
    // fall back to a plain stat — the GET counterpart can then serve it via
    // cat. The repo mount is the trust boundary either way (the path is
    // already validated by isSafeRelativePath above).
    const untrackedRes = await runGitInRepo(
      group,
      `${gitPrefix}ls-files --others --exclude-standard`,
      instance,
    );
    const untracked = untrackedRes.ok
      ? new Set(
          untrackedRes.output
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        )
      : new Set<string>();
    const isUntracked = untracked.has(relPath);
    if (isUntracked) {
      const wcRes = await runGitInRepo(
        group,
        repoSandboxCommand(`wc -c < ${quotedPath}`, worktreeDirectory),
        instance,
      );
      if (!wcRes.ok) {
        return res.status(404).end();
      }
      // `wc -c` prints leading whitespace before the number; trim and validate.
      const size = wcRes.output.trim().split(/\s+/)[0];
      if (!/^\d+$/.test(size)) {
        return res.status(500).end();
      }
      res.setHeader('Content-Type', mimetype);
      res.setHeader('Content-Length', size);
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.status(200).end();
    }

    // Gitignored fallback: stat the file directly. The `|| true` swallows
    // wc's exit code on missing files so we can read stdout cleanly; a
    // missing file prints nothing, so an empty / non-numeric match = 404.
    const statRes = await runGitInRepo(
      group,
      repoSandboxCommand(
        `test -f ${quotedPath} && wc -c < ${quotedPath} || true`,
        worktreeDirectory,
      ),
      instance,
    );
    const sizeMatch = statRes.ok
      ? statRes.output.trim().match(/^(\d+)$/)
      : null;
    if (!sizeMatch) {
      return res.status(404).end();
    }
    res.setHeader('Content-Type', mimetype);
    res.setHeader('Content-Length', sizeMatch[1]);
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).end();
  },
);

/**
 * GET /api/projects/:pid/files/repo/content?path=<relative>
 * GET /api/projects/:pid/conversations/:cid/files/repo/content?path=<relative>
 * Return the raw bytes of a single file from the project repo. The board
 * container has no repo, so the read runs inside the sandbox via runGitInRepo:
 *   - tracked files → `git show HEAD:<path>` returns the committed blob.
 *   - untracked files → `cat <path>` (git ls-files --others confirms it's
 *     actually present in the working tree, not just listed by git status).
 *
 * Response shape mirrors the group counterpart: text-like mimetypes are
 * sent as JSON; binary mimetypes (images, pdf, audio, video, octet-stream)
 * go back as raw bytes with the matching Content-Type so the browser /
 * native client can render them directly.
 *
 * **Binary transport.** runGitInRepo returns stdout as a JavaScript string,
 * which is fine for text but corrupts arbitrary binary (a PNG byte that
 * isn't valid UTF-8 round-trips through the MCP transport as U+FFFD, or is
 * dropped entirely by the sandbox's text-only tool response). For binary
 * mimetypes we therefore pipe the command through `base64 -w 0` so the wire
 * payload is a guaranteed-ASCII string, then decode on the server before
 * sending. This costs ~33% in bandwidth but is the only way to round-trip
 * binary data through the existing text-typed sandbox tool. Text mimetypes
 * stay on the plain `cat` / `git show` path — base64-encoding a 500 KiB log
 * to send as text only to JSON-decode it client-side is wasted work.
 */
router.get(
  [
    '/projects/:pid/files/repo/content',
    '/projects/:pid/conversations/:cid/files/repo/content',
  ],
  async (req, res) => {
    const projectId = String(req.params.pid);
    const group = getGroupByFolder(projectId);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const conversationId =
      typeof req.params.cid === 'string' ? req.params.cid : undefined;
    if (
      conversationId &&
      !(await requireConversationAccess(req, res, conversationId, 'read'))
    )
      return;

    const conv = conversationId
      ? await loadConversationInProject(conversationId, group)
      : null;
    if (conversationId && !conv)
      return res.status(404).json({ error: 'Conversation not found' });
    if (!group.settings?.repositoryLocation) {
      return res
        .status(404)
        .json({ error: 'No repository configured for this project' });
    }

    const relPath = req.query.path;
    if (!isSafeRelativePath(relPath)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    const quotedPath = shellQuote(relPath);
    const quotedRef = shellQuote(`HEAD:${relPath}`);
    // No local `safeResolve` call: the board container has no repo, so we have
    // no real base directory to resolve against. `isSafeRelativePath` already
    // rejects `..`, absolute paths, and null bytes — that is the safety we need
    // before passing the path to git. The sandbox tool itself rejects any path
    // that escapes the repo.

    const instance = resolveEffectiveSandbox(group).instance;
    const worktreeBranch = conv?.use_worktree
      ? conv.branch_name || `chat-${conversationId}`
      : undefined;
    if (worktreeBranch && !isSafeWorktreeBranch(worktreeBranch)) {
      return res.status(400).json({ error: 'Invalid worktree branch' });
    }
    const worktreeDirectory = worktreeBranch
      ? `.worktrees/${worktreeBranch}`
      : undefined;
    const gitPrefix = worktreeGitPrefix(worktreeDirectory);
    const mimetype = await resolveRepoMimetype(
      group,
      relPath,
      instance,
      worktreeDirectory,
    );
    // Branch the transport up front so the same mimetype-driven sendRepoFile
    // helper can decode whichever encoding the wire payload uses.
    const binaryTransport = !isTextMimetype(mimetype);

    const wantsThumbnail = req.query.thumbnail === '1';
    if (wantsThumbnail && !isImageFilePath(relPath))
      return res.status(415).json({ error: 'Thumbnail unavailable' });

    // Chunked reads (preview pane scrolling) are only meaningful for text
    // mimetypes — the binary path is the rendered image/pdf itself, which
    // the UI never streams in pieces. Reject chunked binary cleanly so the
    // client doesn't silently get the whole file when it asked for a slice.
    const chunk = isTextMimetype(mimetype)
      ? parseChunkParams(req.query, Number.POSITIVE_INFINITY)
      : null;
    if (chunk && !isTextMimetype(mimetype)) {
      return res.status(416).json({ error: 'Range not supported for binary' });
    }

    // Tracked files: ask git to print the HEAD blob. Refusing to use anything
    // but `HEAD` keeps the response stable across worktrees / branches; the
    // files tab is a "what's in the repo" view, not "what's currently dirty".
    // For binary mimetypes we pipe through base64 (see binaryTransport above)
    // so the sandbox's text-typed stdout can carry the bytes losslessly.
    // For chunked text reads we additionally pipe through `tail -c +N | head -c M`
    // (see textWindow); the window travels as base64 and is aligned to UTF-8
    // boundaries here, so `length` is a byte count that lines up with `offset`.
    const window = chunk ? textWindow(chunk) : null;
    const transportSuffix = binaryTransport ? ' | base64 -w 0' : '';
    const showCmd = `${gitPrefix}show ${quotedRef}${window?.suffix ?? ''}${transportSuffix}`;
    const showRes = await runGitInRepo(group, showCmd, instance);
    logger.info(
      {
        relPath,
        ok: showRes.ok,
        outLen: showRes.output.length,
        outHead: showRes.output.slice(0, 120),
      },
      '[files-repo-content] HEAD branch',
    );
    // An empty blob prints nothing, exactly like a missing one; only a blob
    // that exists in HEAD may be served from HEAD.
    const trackedBlob =
      showRes.ok &&
      (showRes.output.length > 0 ||
        (
          await runGitInRepo(
            group,
            `${gitPrefix}cat-file -e ${quotedRef}`,
            instance,
          )
        ).ok);
    if (trackedBlob) {
      // For chunked reads we still need the *total* size, which `git show` on
      // a sliced blob doesn't return. Pull it from `cat-file -s` so the
      // envelope can include `total` and the client knows when to stop.
      if (window) {
        const sizeRes = await runGitInRepo(
          group,
          `${gitPrefix}cat-file -s ${quotedRef}`,
          instance,
        );
        return sendRepoTextWindow(
          res,
          relPath,
          mimetype,
          showRes.output,
          window,
          sizeRes.ok && /^\d+$/.test(sizeRes.output.trim())
            ? Number(sizeRes.output.trim())
            : undefined,
        );
      }
      if (wantsThumbnail) {
        const thumbnail = await createFileThumbnail(
          Buffer.from(showRes.output, 'base64'),
        );
        if (!thumbnail)
          return res.status(415).json({ error: 'Thumbnail unavailable' });
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Length', String(thumbnail.length));
        res.setHeader('Cache-Control', 'private, max-age=60');
        return res.send(thumbnail);
      }
      return sendRepoFile(
        res,
        relPath,
        mimetype,
        showRes.output,
        binaryTransport,
      );
    }

    // Fallback: untracked file in the working tree. Confirm it's actually
    // listed by `git ls-files --others` (respects .gitignore) before cat'ing,
    // so a `.env` or other ignored path can't leak.
    const untrackedRes = await runGitInRepo(
      group,
      `${gitPrefix}ls-files --others --exclude-standard`,
      instance,
    );
    const untracked = untrackedRes.ok
      ? new Set(
          untrackedRes.output
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        )
      : new Set<string>();
    const isUntracked = untracked.has(relPath);
    logger.info(
      { relPath, isUntracked, untrackedCount: untracked.size },
      '[files-repo-content] untracked check',
    );

    // Final fallback: the file is on disk but git doesn't know about it.
    // The most common case is `.gitignore`'d files (e.g. `logs/*.log`,
    // `.env`, `node_modules/…`) which `ls-files --others --exclude-standard`
    // deliberately excludes. The UI now surfaces these in an "Ignored"
    // subsection, and clicking them must open the file just like a normal
    // tracked one — so we drop down to a plain `cat` and trust the
    // sandbox's repo mount as the trust boundary (the path is already
    // validated by isSafeRelativePath above). A non-existent file fails
    // the cat with a non-zero exit, so we don't need a separate
    // allowlist check here.
    if (!isUntracked) {
      logger.info(
        { relPath },
        '[files-repo-content] entering gitignored fallback branch',
      );
      // Probe the file's existence with a stat; we use this both to decide
      // whether to attempt the cat and to fill the `total` field on chunked
      // reads. `cat` would work too, but its exit code is the only signal
      // — a separate stat keeps the error path clean and the size code
      // simple.
      const statRes = await runGitInRepo(
        group,
        repoSandboxCommand(
          `test -f ${quotedPath} && wc -c < ${quotedPath} || true`,
          worktreeDirectory,
        ),
        instance,
      );
      // `wc -c` on a missing file prints to stderr and exits non-zero; the
      // `|| true` swallows that, leaving statRes.output empty. We use a
      // numeric match to distinguish "file exists" from "missing" / "error".
      const sizeMatch = statRes.ok
        ? statRes.output.trim().match(/^(\d+)$/)
        : null;
      if (!sizeMatch) {
        return res.status(404).json({ error: 'File not found' });
      }
      const total = Number(sizeMatch[1]);
      // Read the (possibly chunked) body with cat. Binary mimetypes go
      // through base64 for the same transport reason as the tracked branch.
      const catCmd = binaryTransport
        ? `base64 -w 0 < ${quotedPath}`
        : `cat ${quotedPath}${window?.suffix ?? ''}`;
      const catRes = await runGitInRepo(
        group,
        repoSandboxCommand(catCmd, worktreeDirectory),
        instance,
      );
      if (!catRes.ok) {
        return res.status(404).json({ error: 'File not found' });
      }
      if (wantsThumbnail) {
        const thumbnail = await createFileThumbnail(
          Buffer.from(catRes.output, 'base64'),
        );
        if (!thumbnail)
          return res.status(415).json({ error: 'Thumbnail unavailable' });
        res.setHeader('Content-Type', 'image/jpeg');
        return res.send(thumbnail);
      }
      if (window) {
        return sendRepoTextWindow(
          res,
          relPath,
          mimetype,
          catRes.output,
          window,
          total,
        );
      }
      return sendRepoFile(
        res,
        relPath,
        mimetype,
        catRes.output,
        binaryTransport,
      );
    }

    // `cat` is fine here — the path is already validated by isSafeRelativePath
    // and confirmed present by ls-files. Wrap in -v to fail loudly rather
    // than silently return empty on missing files. Binary mimetypes go
    // through base64 for the same reason as the tracked branch above. Chunked
    // text reads use the same window as the tracked branch, plus `wc -c` to
    // fill the envelope's `total` field so the client knows the file's real
    // length.
    const catCmd = binaryTransport
      ? `base64 -w 0 < ${quotedPath}`
      : `cat ${quotedPath}${window?.suffix ?? ''}`;
    const catRes = await runGitInRepo(
      group,
      repoSandboxCommand(catCmd, worktreeDirectory),
      instance,
    );
    if (!catRes.ok) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (wantsThumbnail) {
      const thumbnail = await createFileThumbnail(
        Buffer.from(catRes.output, 'base64'),
      );
      if (!thumbnail)
        return res.status(415).json({ error: 'Thumbnail unavailable' });
      res.setHeader('Content-Type', 'image/jpeg');
      return res.send(thumbnail);
    }
    if (window) {
      const wcRes = await runGitInRepo(
        group,
        repoSandboxCommand(`wc -c < ${quotedPath}`, worktreeDirectory),
        instance,
      );
      const wcSize = wcRes.output.trim().split(/\s+/)[0];
      return sendRepoTextWindow(
        res,
        relPath,
        mimetype,
        catRes.output,
        window,
        wcRes.ok && /^\d+$/.test(wcSize) ? Number(wcSize) : undefined,
      );
    }
    return sendRepoFile(res, relPath, mimetype, catRes.output, binaryTransport);
  },
);

/**
 * Resolve a repo MIME type before selecting the sandbox transport. Text-like
 * paths are sampled through base64, while iconv/grep validate the complete
 * stream inside the sandbox. Binary paths keep the existing decision and
 * avoid an unnecessary probe. The full file never crosses the MCP response.
 */
async function resolveRepoMimetype(
  group: Parameters<typeof runGitInRepo>[0],
  relPath: string,
  instance: string,
  worktreeDirectory?: string,
): Promise<string> {
  const gitPrefix = worktreeGitPrefix(worktreeDirectory);
  const quotedPath = shellQuote(relPath);
  const quotedRef = shellQuote(`HEAD:${relPath}`);
  const pathMimetype = mimetypeForPath(relPath);
  // application/octet-stream is ambiguous here: it can mean a genuinely
  // binary extension, or simply an extensionless/unknown text file. Probe it
  // so the repository route matches group-file and artifact behavior.
  if (
    pathMimetype !== 'application/octet-stream' &&
    !isTextMimetype(pathMimetype)
  ) {
    return pathMimetype;
  }

  const tracked = await runGitInRepo(
    group,
    `${gitPrefix}cat-file -e ${quotedRef}`,
    instance,
  );
  const source = tracked.ok ? `git show ${quotedRef}` : `cat ${quotedPath}`;
  if (!tracked.ok) {
    const present = await runGitInRepo(
      group,
      repoSandboxCommand(`test -f ${quotedPath}`, worktreeDirectory),
      instance,
    );
    if (!present.ok) return pathMimetype;
  }

  // iconv rejects malformed UTF-8; grep -a catches NUL and other disallowed
  // control bytes. Both commands consume the complete file inside the
  // sandbox and emit no file content to the board.
  const validation = await runGitInRepo(
    group,
    repoSandboxCommand(
      `${source} | iconv -f UTF-8 -t UTF-8 >/dev/null && ! (${source} | LC_ALL=C grep -aP -q '[\\x00-\\x08\\x0b\\x0e-\\x1f]')`,
      worktreeDirectory,
    ),
    instance,
  );
  if (!validation.ok) return 'application/octet-stream';

  const sampleResult = await runGitInRepo(
    group,
    repoSandboxCommand(
      `${source} | head -c 65536 | base64 -w 0`,
      worktreeDirectory,
    ),
    instance,
  );
  if (!sampleResult.ok || !/^[A-Za-z0-9+/=\s]*$/.test(sampleResult.output)) {
    return pathMimetype;
  }
  try {
    return detectMimetype(
      relPath,
      trimUtf8Sample(Buffer.from(sampleResult.output.trim(), 'base64')),
    );
  } catch {
    return pathMimetype;
  }
}

/** Bytes read beyond each end of a text window so it can snap to UTF-8 boundaries. */
const UTF8_WINDOW_MARGIN = 3;

/**
 * Sandbox shell suffix that prints the byte window `chunk` (plus the UTF-8
 * margin on both sides) as base64. Cutting text by bytes inside the sandbox
 * could split a multi-byte character, and the board only sees stdout decoded
 * to a string, so the alignment happens in `sendRepoTextWindow` on raw bytes.
 */
function textWindow(chunk: { offset: number; length: number }) {
  const readStart = Math.max(0, chunk.offset - UTF8_WINDOW_MARGIN);
  const readLength =
    chunk.offset - readStart + chunk.length + UTF8_WINDOW_MARGIN;
  return {
    chunk,
    readStart,
    suffix: ` | tail -c +${readStart + 1} | head -c ${readLength} | base64 -w 0`,
  };
}

/**
 * Send a window printed by `textWindow` as a chunked text envelope. `offset`
 * and `length` are bytes of the UTF-8-aligned window actually returned, so the
 * client's `offset + length` starts the next chunk exactly where this one ends.
 * `total` falls back to the end of the window when the size is unknown.
 */
function sendRepoTextWindow(
  res: Response,
  relPath: string,
  mimetype: string,
  base64Output: string,
  window: ReturnType<typeof textWindow>,
  total?: number,
): void {
  const buf = Buffer.from(base64Output, 'base64');
  const { chunk, readStart } = window;
  const { start, end } = applyUtf8SafeWindow(
    buf,
    chunk.offset - readStart,
    chunk.offset - readStart + chunk.length,
    0,
  );
  const offset = readStart + start;
  const length = end - start;
  sendRepoFile(
    res,
    relPath,
    mimetype,
    buf.subarray(start, end).toString('utf-8'),
    false,
    { offset, length, total: total ?? offset + length },
  );
}

/**
 * Stream a repo file back to the client. Binary types go as raw bytes
 * (Content-Type header); text-like types go as a JSON wrapper so the
 * existing JSON path in api.ts can decode them via handleResponse.
 *
 * `binaryTransport` mirrors the route's decision about whether `raw` is a
 * base64-encoded payload (true) or a literal text body (false). For text
 * types the wire payload is the file as-is, and the JSON wrapper takes
 * care of the rest. For binary types we decode base64 → Buffer and send
 * the raw bytes; setting Content-Length matters here because without it
 * Transfer-Encoding: chunked kicks in and some HTTP intermediaries (and
 * Capacitor's native HTTP stack) misbehave on binary bodies.
 */
function sendRepoFile(
  res: Response,
  relPath: string,
  mimetype: string,
  raw: string,
  binaryTransport: boolean,
  chunk?: { offset: number; length: number; total: number },
): void {
  if (isTextMimetype(mimetype)) {
    res.json({
      path: relPath,
      mimetype,
      content: raw,
      encoding: 'utf-8',
      ...(chunk ?? {}),
    });
    return;
  }
  const buf = binaryTransport
    ? Buffer.from(raw, 'base64')
    : Buffer.from(raw, 'binary');
  setRawFileHeaders(res, mimetype, path.basename(relPath));
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.send(buf);
}

/**
 * Files of an extra read-only mount (`/workspace/<name>` inside the sandbox).
 * The board container cannot see these host folders, so — like the repo
 * routes — every read runs as a shell script inside the sandbox. The script
 * resolves symlinks and refuses anything that leaves the mount root.
 */
async function resolveExtraMount(req: Request, res: Response) {
  const group = getGroupByFolder(String(req.params.pid));
  if (!group) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  const effective = resolveEffectiveSandbox(group);
  const mount = effective.extraMounts.find(
    (m) => String(m.slot) === String(req.params.slot),
  );
  if (!mount) {
    res.status(404).json({ error: 'Extra mount not configured' });
    return null;
  }
  return {
    group,
    instance: effective.instance,
    mount,
    stale: await isMountConfigStale(group),
  };
}

/**
 * Shell prelude: set $t to the real path of <root>/<rel>, or exit 2 if it escapes.
 * A root that does not exist also prints `__ROOT_MISSING__`.
 */
function mountResolveScript(root: string, rel: string): string {
  return `r=$(realpath -e -- ${shellQuote(root)}) || { echo __INVALID_DIRECTORY__ __ROOT_MISSING__; exit 2; }; t=$(realpath -e -- ${shellQuote(rel ? `${root}/${rel}` : root)} 2>/dev/null) || { echo __INVALID_DIRECTORY__; exit 2; }; case "$t" in "$r"|"$r"/*) ;; *) echo __INVALID_DIRECTORY__; exit 2;; esac`;
}

/** A read-only sandbox folder (extra mount or extra workspace root) served by the shared file routes. */
interface ExtraFilesTarget {
  group: RegisteredGroup;
  instance: string;
  containerPath: string;
}

async function listExtraFiles(
  req: Request,
  res: Response,
  { group, instance, containerPath }: ExtraFilesTarget,
  opts: { isRoot?: boolean } = {},
) {
  const directory = typeof req.query.path === 'string' ? req.query.path : '';
  const cursor =
    typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  const search =
    typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const requestedLimit = Number(req.query.limit ?? 50);
  const limit =
    Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 50;
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    return res.status(400).json({ error: 'Invalid cursor' });
  if (directory && !isSafeRelativePath(directory))
    return res.status(400).json({ error: 'Invalid path' });

  const tab = `"$(printf '\\t')"`;
  const page = `awk 'NR > ${offset} && NR <= ${offset + limit + 1} { print }'`;
  // Search covers the whole root, but root routes still refuse a `path` that
  // resolves outside it.
  const searchGuard =
    opts.isRoot && directory
      ? `${mountResolveScript(containerPath, directory)}; `
      : '';
  const script = search
    ? `${searchGuard}${mountResolveScript(containerPath, '')}; cd "$t" && find . -type f -printf '%s\\t%P\\n' 2>/dev/null | head -n 50000 | awk -F '\\t' -v q=${shellQuote(search.toLowerCase())} '{ p=$2; if (index(tolower(p),q)) { n=split(p,a,"/"); print a[n] "\\t" p "\\t" $1 } }' | sort -t ${tab} -k1,1 -k2,2 | ${page}`
    : `${mountResolveScript(containerPath, directory)}; cd "$t" && find . -mindepth 1 -maxdepth 1 \\( -type d -o -type f \\) -printf '%y\\t%s\\t%f\\n' | awk -F '\\t' -v d=${shellQuote(directory)} '{ k=($1=="d") ? "0" : "1"; print k "\\t" $3 "\\t" (d != "" ? d "/" : "") $3 "\\t" ($1=="f" ? $2 : "") }' | sort -t ${tab} -k1,1 -k2,2 | ${page}`;
  try {
    const listRes = await runGitInRepo(
      group,
      repoSandboxCommand(script),
      instance,
    );
    if (!listRes.ok) {
      if (
        !(opts.isRoot && listRes.output.includes('__ROOT_MISSING__')) &&
        listRes.output.includes('__INVALID_DIRECTORY__')
      )
        return res.status(400).json({ error: 'Invalid directory' });
      return res.json({ available: false, reason: 'list-failed', ignored: [] });
    }
    const rows = parseRepoRows(listRes.output, search ? 2 : 3);
    const entries = rows.slice(0, limit).map((row) =>
      search
        ? {
            kind: 'file' as const,
            name: row[0],
            path: row[1],
            ...sizeFields(row[2]),
          }
        : {
            kind: row[0] === '0' ? ('directory' as const) : ('file' as const),
            name: row[1],
            path: row[2],
            ...(row[0] === '0' ? {} : sizeFields(row[3])),
          },
    );
    res.json({
      available: true,
      entries,
      ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
      ignored: [],
    });
  } catch (err) {
    logger.warn({ err, containerPath }, 'Failed to list extra folder files');
    res.json({ available: false, reason: 'list-failed', ignored: [] });
  }
}

/** Size of a regular file inside the root, or null when it is missing or escapes the root. */
async function extraFileSize(
  { group, instance, containerPath }: ExtraFilesTarget,
  relPath: string,
): Promise<number | null> {
  const sizeRes = await runGitInRepo(
    group,
    repoSandboxCommand(
      `${mountResolveScript(containerPath, relPath)}; test -f "$t" && wc -c < "$t"`,
    ),
    instance,
  );
  const size = sizeRes.ok ? sizeRes.output.trim().split(/\s+/)[0] : '';
  return /^\d+$/.test(size) ? Number(size) : null;
}

/** Text files are sent as-is; ambiguous or unknown extensions are validated as UTF-8 in the sandbox. */
async function extraFileMimetype(
  { group, instance, containerPath }: ExtraFilesTarget,
  relPath: string,
): Promise<string> {
  const pathMimetype = mimetypeForPath(relPath);
  if (
    pathMimetype !== 'application/octet-stream' &&
    !isTextMimetype(pathMimetype)
  )
    return pathMimetype;
  const validation = await runGitInRepo(
    group,
    repoSandboxCommand(
      `${mountResolveScript(containerPath, relPath)}; iconv -f UTF-8 -t UTF-8 "$t" >/dev/null && ! LC_ALL=C grep -aP -q '[\\x00-\\x08\\x0b\\x0e-\\x1f]' "$t"`,
    ),
    instance,
  );
  if (!validation.ok) return 'application/octet-stream';
  return isTextMimetype(pathMimetype) ? pathMimetype : 'text/plain';
}

async function headExtraFile(
  req: Request,
  res: Response,
  target: ExtraFilesTarget,
) {
  const relPath = req.query.path;
  if (!isSafeRelativePath(relPath)) return res.status(400).end();
  const size = await extraFileSize(target, relPath);
  if (size === null) return res.status(404).end();
  res.setHeader('Content-Type', await extraFileMimetype(target, relPath));
  res.setHeader('Content-Length', String(size));
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.status(200).end();
}

async function sendExtraFile(
  req: Request,
  res: Response,
  target: ExtraFilesTarget,
) {
  const { group, instance, containerPath } = target;
  const relPath = req.query.path;
  if (!isSafeRelativePath(relPath))
    return res.status(400).json({ error: 'Invalid path' });
  const total = await extraFileSize(target, relPath);
  if (total === null) return res.status(404).json({ error: 'File not found' });
  const mimetype = await extraFileMimetype(target, relPath);
  const binaryTransport = !isTextMimetype(mimetype);
  const wantsThumbnail = req.query.thumbnail === '1';
  if (wantsThumbnail && !isImageFilePath(relPath))
    return res.status(415).json({ error: 'Thumbnail unavailable' });
  const chunk = binaryTransport
    ? null
    : parseChunkParams(req.query, Number.POSITIVE_INFINITY);
  const window = chunk ? textWindow(chunk) : null;
  const readRes = await runGitInRepo(
    group,
    repoSandboxCommand(
      `${mountResolveScript(containerPath, relPath)}; cat "$t"${window?.suffix ?? ''}${binaryTransport ? ' | base64 -w 0' : ''}`,
    ),
    instance,
  );
  if (!readRes.ok) return res.status(404).json({ error: 'File not found' });
  if (wantsThumbnail) {
    const thumbnail = await createFileThumbnail(
      Buffer.from(readRes.output, 'base64'),
    );
    if (!thumbnail)
      return res.status(415).json({ error: 'Thumbnail unavailable' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', String(thumbnail.length));
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.send(thumbnail);
  }
  if (window) {
    return sendRepoTextWindow(
      res,
      relPath,
      mimetype,
      readRes.output,
      window,
      total,
    );
  }
  return sendRepoFile(res, relPath, mimetype, readRes.output, binaryTransport);
}

router.get('/projects/:pid/files/mount/:slot', async (req, res) => {
  const resolved = await resolveExtraMount(req, res);
  if (!resolved) return;
  if (resolved.stale) {
    return res.json({ available: false, reason: 'sandbox-stale', ignored: [] });
  }
  return listExtraFiles(req, res, {
    group: resolved.group,
    instance: resolved.instance,
    containerPath: resolved.mount.containerPath,
  });
});

router.head('/projects/:pid/files/mount/:slot/content', async (req, res) => {
  const resolved = await resolveExtraMount(req, res);
  if (!resolved) return;
  if (resolved.stale) return res.status(503).end();
  return headExtraFile(req, res, {
    group: resolved.group,
    instance: resolved.instance,
    containerPath: resolved.mount.containerPath,
  });
});

router.get('/projects/:pid/files/mount/:slot/content', async (req, res) => {
  const resolved = await resolveExtraMount(req, res);
  if (!resolved) return;
  if (resolved.stale) {
    return res.status(503).json({
      error:
        'Sandbox is running with outdated mount settings. Restart the sandbox to apply the configured mounts.',
    });
  }
  return sendExtraFile(req, res, {
    group: resolved.group,
    instance: resolved.instance,
    containerPath: resolved.mount.containerPath,
  });
});

/**
 * Files of an extra workspace root (`settings.workspaceRoots`), addressed by
 * its index in `resolveEffectiveSandbox(group).extraRoots` — never by a
 * client-supplied path. Same sandbox-side `realpath` guard as the mounts; roots
 * are not sandbox mounts, so there is no stale-config check.
 */
function resolveExtraRoot(
  req: Request,
  res: Response,
): ExtraFilesTarget | null {
  const group = getGroupByFolder(String(req.params.pid));
  if (!group) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  const effective = resolveEffectiveSandbox(group);
  const index = /^\d+$/.test(String(req.params.index))
    ? Number(req.params.index)
    : -1;
  const containerPath = effective.extraRoots[index];
  if (!containerPath) {
    res.status(404).json({ error: 'Extra workspace root not configured' });
    return null;
  }
  return { group, instance: effective.instance, containerPath };
}

router.get('/projects/:pid/files/root/:index', async (req, res) => {
  const target = resolveExtraRoot(req, res);
  if (!target) return;
  return listExtraFiles(req, res, target, { isRoot: true });
});

router.head('/projects/:pid/files/root/:index/content', async (req, res) => {
  const target = resolveExtraRoot(req, res);
  if (!target) return;
  return headExtraFile(req, res, target);
});

router.get('/projects/:pid/files/root/:index/content', async (req, res) => {
  const target = resolveExtraRoot(req, res);
  if (!target) return;
  return sendExtraFile(req, res, target);
});

/**
 * POST /api/projects/:pid/messages
 * Send a message to the group's orchestrator from the web UI.
 * Body: { content: string, conversation_id?: string }
 */
async function sendConversationMessage(req: any, res: Response) {
  const entry = getGroupEntryByFolder(req.params.pid);
  if (!entry) return res.status(404).json({ error: 'Project not found' });
  // Stores a user turn and starts a chat run: agent credentials never do that.
  if (!req.authUser && req.tokenScope && !requireSignedInUser(req, res)) return;

  const { group } = entry;
  // Set once the target conversation is known: an objective chat is a normal
  // chat whose conversation (or a new conversation's body) carries the
  // objective_id.
  let objective: Objective | undefined;
  const broadcast: typeof import('../modules/objectives/ws-events.js').broadcast =
    (event) => broadcastConversationEvent(event, group.folder, objective?.id);
  const brainUrl = resolveBrainUrl(resolveBrainContainer(group));
  const rawContent = (req.body?.content ?? '').trim();
  if (!rawContent)
    return res.status(400).json({ error: 'content is required' });
  const chatMsgErr = lenError(rawContent, MAX_LEN.message, 'content');
  if (chatMsgErr) return res.status(400).json({ error: chatMsgErr });

  // Permission: explicit project editor+/admin can post freely. Implicit (chat-shared)
  // users must have editor or owner on the specific conversation. Auto-create is
  // limited to explicit project members.
  const isAdmin = adminBypassesProject(req.authUser, req.params.pid);
  const projectAccess = req.projectAccess;
  const requestedConvId =
    (typeof req.body?.conversation_id === 'string' &&
      req.body.conversation_id.trim()) ||
    (typeof req.body?.conversationId === 'string' &&
      req.body.conversationId.trim()) ||
    (typeof req.query?.conversation_id === 'string' &&
      req.query.conversation_id.trim()) ||
    (typeof req.query?.conversationId === 'string' &&
      req.query.conversationId.trim()) ||
    '';

  if (!isAdmin && req.authUser?.id) {
    if (!requestedConvId) {
      // Auto-create path — only explicit non-viewer can create
      if (!explicitLevelAtLeast(projectAccess, 'editor')) {
        return res
          .status(403)
          .json({ error: 'Insufficient access to create conversation' });
      }
    } else {
      if (
        !(await userMayPostInConversation(
          req.authUser.id,
          String(requestedConvId),
        ))
      ) {
        return res
          .status(403)
          .json({ error: 'Write access to this conversation required' });
      }
    }
  }

  const memoryContext = parseMemoryContext(req.body?.memoryContext, rawContent);
  if (memoryContext.invalid)
    return res.status(400).json({ error: 'memoryContext.level is invalid' });
  const content = memoryContext.content;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const parsedOpenFileContext = validateOpenFileContext(
    req.body?.openFileContext,
  );
  if (parsedOpenFileContext.error)
    return res.status(400).json({ error: parsedOpenFileContext.error });
  const openFileContext = parsedOpenFileContext.value;

  // Auto-create a conversation if none provided — every message must belong to one
  let conversation_id: string | undefined =
    (typeof req.body?.conversation_id === 'string' &&
    req.body.conversation_id.trim()
      ? req.body.conversation_id.trim()
      : undefined) ||
    (typeof req.body?.conversationId === 'string' &&
    req.body.conversationId.trim()
      ? req.body.conversationId.trim()
      : undefined) ||
    (typeof req.query?.conversation_id === 'string' &&
    req.query.conversation_id.trim()
      ? req.query.conversation_id.trim()
      : undefined) ||
    (typeof req.query?.conversationId === 'string' &&
    req.query.conversationId.trim()
      ? req.query.conversationId.trim()
      : undefined) ||
    undefined;
  let autoCreated = false;
  let existingConversation: Awaited<ReturnType<typeof getConversation>>;
  // null = explicitly start fresh (don't fall back to global sessions store)
  // string = resume this specific session
  let sessionOverride: string | null = null;
  let shouldForkSession = false;

  // A conversation ID is only meaningful inside the project chat encoded by
  // this route. The UI can keep an old callback alive briefly while navigating
  // between projects; without this ownership check, that stale ID caused the
  // new project's prompt to be written into (and resume) the old project's
  // conversation. Treat mismatches as not found before any message, transcript,
  // session, or runtime state is mutated.
  if (conversation_id) {
    existingConversation = await getConversation(conversation_id);
    if (
      !existingConversation ||
      existingConversation.group_folder !== group.folder
    ) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
  }
  // The conversation decides the objective; a request `objective_id` must agree
  // with it, and for a new conversation it must name this project's objective.
  const requestedObjective = await resolveRequestObjective(req, group.folder);
  if ('error' in requestedObjective)
    return res.status(404).json({ error: requestedObjective.error });
  const objectiveId = existingConversation
    ? (existingConversation.objective_id ?? null)
    : (requestedObjective.objective?.id ?? null);
  if (
    requestedObjective.objective &&
    requestedObjective.objective.id !== objectiveId
  ) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  if (objectiveId) {
    objective =
      requestedObjective.objective ?? (await getObjective(objectiveId));
    if (!objective || objective.project_id !== group.folder)
      return res.status(404).json({ error: 'Objective not found' });
  } else if (
    !conversation_id &&
    conversationWorktreeOptions(req.body).invalidBranch
  ) {
    return res.status(400).json({ error: 'Invalid branch name' });
  }
  if (
    openFileContext?.source === 'repo' &&
    openFileContext.repoContext === 'conversationWorktree' &&
    (!existingConversation ||
      existingConversation.id !== openFileContext.conversationId ||
      !existingConversation.use_worktree)
  ) {
    return res.status(400).json({
      error: 'Repo worktree context does not belong to this conversation',
    });
  }

  // Parse the client attachments, then re-classify them so videos are tagged
  // correctly even if the frontend missed it. `path` is client-supplied and is
  // later read by transcription and the model prompt, so only files the upload
  // endpoint stored for this project keep it.
  let rejectedAttachmentPaths = 0;
  const processedAttachments = Array.isArray(req.body?.attachments)
    ? req.body.attachments
        .slice(0, 20)
        .flatMap((raw: unknown) => {
          const parsed = incomingAttachmentSchema.safeParse(raw);
          return parsed.success ? [parsed.data] : [];
        })
        .map((att: any) => {
          if (att.mimetype.startsWith('image/')) {
            att.type = 'image';
          } else if (att.mimetype.startsWith('video/') && ENABLE_VIDEO) {
            att.type = 'video';
          } else if (att.mimetype.startsWith('audio/')) {
            att.type = 'audio';
          }
          if (att.path !== undefined) {
            const uploadedPath = resolveUploadedAttachmentPath(group, att.path);
            if (uploadedPath) {
              att.path = uploadedPath;
            } else {
              delete att.path;
              rejectedAttachmentPaths++;
            }
          }
          return att;
        })
    : null;
  if (rejectedAttachmentPaths > 0) {
    logger.warn(
      { project: group.folder, count: rejectedAttachmentPaths },
      'Dropped chat attachment paths outside the project upload directory',
    );
  }
  const deepLinks = Array.isArray(req.body?.deepLinks)
    ? req.body.deepLinks
        .filter(
          (
            link: unknown,
          ): link is { label: string; href: string; variant?: string } =>
            !!link &&
            typeof link === 'object' &&
            typeof (link as any).label === 'string' &&
            typeof (link as any).href === 'string',
        )
        .slice(0, 8)
        .map((link: { label: string; href: string; variant?: string }) => ({
          label: link.label.trim().slice(0, 80),
          href: link.href.trim().slice(0, 2_000),
          ...(['default', 'outline', 'destructive'].includes(link.variant ?? '')
            ? { variant: link.variant as 'default' | 'outline' | 'destructive' }
            : {}),
        }))
        .filter(
          (link: { label: string; href: string; variant?: string }) =>
            link.label &&
            link.href.startsWith('/') &&
            !link.href.startsWith('//'),
        )
    : undefined;

  let agent_cmd = req.body?.agent_cmd
    ? String(req.body.agent_cmd).trim()
    : undefined;
  const requestedRuntime = req.body?.runtimeSelection as
    | RuntimeSelection
    | undefined;
  if (
    requestedRuntime &&
    (typeof requestedRuntime.harnessId !== 'string' ||
      typeof requestedRuntime.modelId !== 'string' ||
      (requestedRuntime.reasoning !== undefined &&
        typeof requestedRuntime.reasoning !== 'string'))
  )
    return res.status(400).json({
      error:
        'runtimeSelection requires harnessId, modelId, and optional reasoning strings',
    });
  const rawChatMode =
    typeof req.body?.chat_mode === 'string'
      ? req.body.chat_mode.trim().toLowerCase()
      : undefined;
  const configuredModes = Array.isArray(group.settings?.chatModes)
    ? group.settings?.chatModes
    : DEFAULT_CHAT_MODES;
  const allowedModeIds = new Set(
    configuredModes
      .map((m: any) =>
        typeof m?.id === 'string' ? m.id.trim().toLowerCase() : '',
      )
      .filter(Boolean),
  );
  const chat_mode =
    rawChatMode && allowedModeIds.has(rawChatMode) ? rawChatMode : undefined;

  let conversationRuntime: RuntimeSelection | undefined;
  let mainAiUserContext: Awaited<ReturnType<typeof resolveMainAiUserContext>>;
  let mainPersonaGeneration: number | undefined;
  if (conversation_id) {
    conversationRuntime = existingConversation?.runtimeSelection ?? undefined;
  }
  const effectiveRuntime = resolveConversationRuntimeSelection(
    requestedRuntime,
    conversationRuntime,
    agent_cmd,
  );
  const isCompact = content.toLowerCase().startsWith('/compact');
  // An Auto selection (stored, project or global default) runs on the model it
  // was routed to. The router only runs where the provider cache is cold: the
  // conversation's first message and the first one after a compaction. An
  // explicit request selection, `agent_cmd` or non-Auto selection is untouched.
  let executionRuntime = effectiveRuntime;
  let newAutoPin: AutoRouting['newPin'];
  let agentConfig;
  try {
    const autoCandidate =
      effectiveRuntime ??
      (agent_cmd
        ? undefined
        : group.settings?.chatRuntimeSelection ||
          getDefaultRuntimeSelection('chat'));
    if (autoCandidate && isAutoSelection(autoCandidate)) {
      const routing = await routeAutoSelection(autoCandidate, {
        pin: existingConversation?.routedModel,
        userMessage: content,
        routable: !isCompact,
        projectId: group.folder,
      });
      executionRuntime = routing.selection;
      newAutoPin = routing.newPin;
    }
    if (conversation_id) {
      const personaSession = await resolveMainPersonaSession(
        conversation_id,
        group,
        executionRuntime,
      );
      mainAiUserContext = personaSession.mainAiUserContext;
      mainPersonaGeneration = personaSession.mainPersonaGeneration;
    }
    agentConfig =
      mainAiUserContext?.agentConfig ??
      getResolvedRuntimeConfig(group, executionRuntime, agent_cmd);
  } catch (err) {
    return res
      .status(400)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
  if (agent_cmd && !effectiveRuntime && !agentConfig) {
    return res
      .status(400)
      .json({ error: `Unknown runtime binding "${agent_cmd}"` });
  }
  if (executionRuntime || mainAiUserContext) agent_cmd = agentConfig?.id;
  let isLlm = !!agentConfig && isDirectRuntime(agentConfig);
  const humanParticipantName =
    (typeof req.authUser?.displayName === 'string' &&
      req.authUser.displayName.trim()) ||
    (typeof req.authUser?.username === 'string' &&
      req.authUser.username.trim()) ||
    'Human';
  const humanParticipantAvatarUrl = req.authUser?.id
    ? (await presentAccountIdentity(req.authUser)).avatarUrl
    : null;
  let mainParticipantName = mainAiUserContext?.aiUser.name ?? ASSISTANT_NAME;

  const transcriptionRuntime = getRuntimeCatalog().defaults.transcription;
  const liveTranscriptionConfig =
    req.body?.liveMode === true && transcriptionRuntime && !agentConfig?.audio
      ? (() => {
          const agent = resolveRuntimeSelection(transcriptionRuntime);
          return agent?.audio === true ? agent : undefined;
        })()
      : undefined;

  // Live Mode may use a dedicated GPU audio model for transcription. Every
  // voice message still needs a text transcript for the visible chat history,
  // including when the conversation model can consume the original audio.
  const transcribeAudioAttachments = async (targets: any[]): Promise<any[]> => {
    for (const att of targets) {
      if (att.type === 'audio' && att.path) {
        try {
          if (fs.existsSync(att.path)) {
            const buffer = await readAttachmentFile(att.path);
            let transcript = '';
            let transcriptionSource = '';
            let fallbackReason = '';
            if (liveTranscriptionConfig) {
              try {
                const transcriptionPrompt =
                  'Transcribe this voice message verbatim. Output only the spoken words, in the original language, with no commentary.';
                transcript = await transcribeAudioWithAgent(
                  buffer,
                  att.mimetype,
                  liveTranscriptionConfig,
                  {
                    filename: att.filename,
                    prompt: transcriptionPrompt,
                  },
                );
                if (
                  transcript &&
                  isTranscriptionPromptEcho(transcript, transcriptionPrompt)
                ) {
                  logger.warn(
                    { agentId: liveTranscriptionConfig.id },
                    'Rejected transcription prompt echo; falling back to Whisper',
                  );
                  transcript = '';
                  fallbackReason = 'prompt-echo';
                } else if (
                  transcript &&
                  isImplausibleShortAudioTranscript(buffer, transcript)
                ) {
                  logger.warn(
                    {
                      agentId: liveTranscriptionConfig.id,
                      durationMs: wavDurationMs(buffer),
                      transcriptLength: transcript.length,
                    },
                    'Rejected implausibly long transcript for short audio; falling back to Whisper',
                  );
                  transcript = '';
                  fallbackReason = 'short-audio';
                } else if (transcript) {
                  transcriptionSource = liveTranscriptionConfig.id;
                }
              } catch (err) {
                logger.warn(
                  { err, agentId: liveTranscriptionConfig.id },
                  'Live transcription agent failed; falling back to Whisper',
                );
                fallbackReason = 'agent-error';
              }
            }
            if (!transcript) {
              const transcriber = getTranscriber();
              if (transcriber) {
                transcript = await transcriber(
                  buffer,
                  att.mimetype,
                  att.filename,
                );
                if (transcript)
                  transcriptionSource = liveTranscriptionConfig
                    ? `whisper-${fallbackReason || 'empty'}-fallback`
                    : 'whisper';
              }
            }
            if (transcript) {
              (att as any).transcript = transcript;
              (att as any).transcriptionSource = transcriptionSource;
              logger.info(
                {
                  project: req.params.pid,
                  filename: att.filename,
                  transcriptionSource,
                },
                'Audio attachment transcribed',
              );
            }
          }
        } catch (err) {
          logger.error(
            { err, filename: att.filename },
            'Failed to transcribe audio attachment',
          );
        }
      }
    }
    return targets;
  };
  // A model that hears the recording does not wait for its transcript: the
  // run starts at once and the transcript joins the message when it is ready
  // (mergeLateAudioTranscripts). Copies keep the stored attachments stable.
  // Live Mode keeps waiting; its turns are driven by the transcript.
  let lateAudioTranscripts =
    agentConfig?.audio === true &&
    req.body?.liveMode !== true &&
    processedAttachments?.some((att: any) => att.type === 'audio' && att.path)
      ? transcribeAudioAttachments(
          processedAttachments.map((att: any) => ({ ...att })),
        )
      : null;
  if (!lateAudioTranscripts && processedAttachments)
    await transcribeAudioAttachments(processedAttachments);
  const recordLateAudioTranscripts = (messageId: string): void => {
    const lateConversationId = conversation_id;
    if (!lateAudioTranscripts || !lateConversationId) return;
    void lateAudioTranscripts
      .then((transcribed) => {
        const transcripts: string[] = [];
        for (const att of transcribed) {
          if (!att.transcript || !att.transcriptionSource) continue;
          transcripts.push(att.transcript);
          appendChatTranscriptEntry(group.folder, lateConversationId, {
            type: 'audio_transcription',
            source: att.transcriptionSource,
            content: att.transcript,
            filename: att.filename,
            messageId,
            created_at: new Date().toISOString(),
            conversation_id: lateConversationId,
          });
        }
        // The open chat already shows this message; hand it the transcript.
        if (transcripts.length > 0) {
          broadcast({
            type: 'chat_audio_transcript',
            payload: {
              folder: group.folder,
              conversation_id: lateConversationId,
              messageId,
              transcripts,
            },
          });
        }
      })
      .catch((err) =>
        logger.error({ err }, 'Failed to record late audio transcript'),
      );
  };

  if (!conversation_id) {
    // New conversation: create a record and start with no session.
    // Do NOT call resetGroupSession here — it would corrupt other concurrent
    // web-chat conversations sharing the same project.
    const { use_worktree, branch } = conversationWorktreeOptions(req.body);
    let conv: Awaited<ReturnType<typeof createConversation>>;
    try {
      conv = await createConversation(group.folder, {
        // Objective chats run in the objective folder, never in a worktree.
        use_worktree: objective ? false : use_worktree,
        branch_name: objective ? undefined : branch,
        promptCache1h: req.body?.promptCache1h === true,
        objective_id: objective?.id,
        ownerUserId: req.authUser?.id ?? group.user_id ?? null,
        triggerSource: req.authUser?.id ? 'user' : 'system',
      });
    } catch (err) {
      if (err instanceof ConversationWorktreeTransitionInProgressError) {
        return res.status(409).json({ error: err.message, branch: err.branch });
      }
      throw err;
    }
    await inviteProjectDefaultAiUsers(conv.id, group, req.authUser?.id ?? null);
    conversation_id = conv.id;
    existingConversation = conv;
    // A newly-created conversation did not exist during preflight resolution.
    // Resolve its inherited main persona before assigning the first session
    // generation so the opening turn never starts in a no-persona scope.
    const personaSession = await resolveMainPersonaSession(
      conversation_id,
      group,
      executionRuntime,
    );
    mainAiUserContext = personaSession.mainAiUserContext;
    mainPersonaGeneration = personaSession.mainPersonaGeneration;
    if (mainAiUserContext) {
      agentConfig = mainAiUserContext.agentConfig;
      agent_cmd = agentConfig.id;
      isLlm = isDirectRuntime(agentConfig);
      mainParticipantName = mainAiUserContext.aiUser.name;
      // The late transcript was decided with the pre-persona config. A
      // persona without audio support never receives the recording, so wait
      // for the transcript and deliver it like a synchronous one.
      if (lateAudioTranscripts && !agentConfig.audio) {
        const transcribed = await lateAudioTranscripts;
        lateAudioTranscripts = null;
        transcribed.forEach((att, index) => {
          if (!att.transcript || !att.transcriptionSource) return;
          const target = processedAttachments?.[index];
          if (!target) return;
          target.transcript = att.transcript;
          target.transcriptionSource = att.transcriptionSource;
        });
      }
    }
    autoCreated = true;
    broadcast({
      type: 'conversations_changed',
      payload: { folder: group.folder },
    });
  }

  // Resolve which agent will handle this turn so we can key session lookups
  // and writes by (conversation_id, agent_cmd). Mirrors runChatAgent's resolution:
  // explicit override > conversation runtime selection > project/global default.
  let agentForSession = agent_cmd as string | undefined;
  if (!agentForSession && conversation_id) {
    agentForSession = existingConversation?.runtimeSelection
      ? resolveRuntimeSelection(existingConversation.runtimeSelection).id
      : undefined;
  }
  // Session key = the binary agentCmd (e.g. `claude`), not the profile id, so
  // sibling profiles sharing an agentCmd resume the same session on switch.
  if (mainPersonaGeneration === undefined)
    throw new Error('Main persona generation was not resolved');
  const resolvedAgentCmd = mainAiUserContext
    ? runtimeSessionKey(mainAiUserContext.agentConfig)
    : resolveSessionAgentKey(group, agentForSession);
  const resolvedSessionKey = mainPersonaSessionKey(
    resolvedAgentCmd,
    mainPersonaGeneration,
  );

  if (!autoCreated) {
    // Continuing an existing conversation — use its stored session_id.
    // Use null (not undefined) so runAgent never falls back to the global sessions store.
    // Session IDs are scoped to the resolved agent runtime. Do not recover a
    // generic "last session" from the transcript here: after an agent switch,
    // the transcript's newest session can belong to a different runtime
    // (e.g. Claude), and passing it to the new runtime (e.g. Codex) makes the
    // CLI attempt an invalid cross-agent resume instead of starting with a
    // handoff summary.
    sessionOverride = await getConversationSessionId(
      conversation_id,
      resolvedSessionKey,
    );
    // If this is the first message in a forked conversation, use --fork-session to branch the session
    if (sessionOverride && (await isConversationForkPending(conversation_id))) {
      shouldForkSession = true;
    }
  }

  const persistedRuntime =
    effectiveRuntime ||
    (req.body?.agent_cmd && agentConfig?.harnessId && agentConfig.modelId
      ? runtimeSelectionFromResolvedAgent(agentConfig)
      : undefined);
  if (conversation_id && persistedRuntime) {
    await setConversationRuntimeSelection(conversation_id, persistedRuntime);
  }
  if (conversation_id && newAutoPin) {
    const sandbox = resolveEffectiveSandbox(group);
    await persistAutoModelPin(conversation_id, newAutoPin, {
      dir: hostIpcDir(group.folder, sandbox.instance, sandbox.stack),
      userMessage: content,
    });
  }

  const now = new Date().toISOString();

  // Save user message and broadcast
  // Cap attachments to 20 items and 50KB total serialized size
  const attachments = processedAttachments
    ? (() => {
        const capped = processedAttachments.slice(0, 20);
        const serialized = JSON.stringify(capped);
        return serialized.length <= 50_000 ? capped : null;
      })()
    : null;
  // Preserve the original audio on the persisted user message for playback,
  // but never forward it to a text/image-only model. This applies equally to
  // the dedicated Live Mode transcription runtime and the local Whisper path.
  const agentAttachments = agentConfig?.audio
    ? attachments
    : (attachments?.filter((attachment: any) => attachment.type !== 'audio') ??
      null);
  const audioTranscripts = (processedAttachments ?? [])
    .filter(
      (attachment: any) =>
        attachment.type === 'audio' &&
        typeof attachment.transcript === 'string' &&
        attachment.transcript.trim(),
    )
    .map((attachment: any): string => attachment.transcript.trim());
  const directLiveTranscript =
    req.body?.liveMode === true &&
    !agentConfig?.audio &&
    audioTranscripts.length > 0
      ? audioTranscripts.join('\n\n')
      : null;
  const agentContent = directLiveTranscript ?? content;
  // Derived from the user's original text, never from audio transcripts
  // (including the Live Mode transcript that replaces agentContent).
  const conversationPreview = buildConversationPreview(
    content,
    processedAttachments,
  );

  // Inject transcripts into the prompt and persistent message content
  let enrichedContent = agentContent;
  if (!directLiveTranscript && audioTranscripts.length > 0) {
    const transcriptBlock = audioTranscripts
      .map((transcript: string) => `[Voice message transcript]: ${transcript}`)
      .join('\n\n');
    enrichedContent = `${enrichedContent}\n\n${transcriptBlock}`;
  }

  const aiCoordinatorInstructions = await getAiCoordinatorInstructions(
    conversation_id,
    {
      humanName: humanParticipantName,
      mainParticipantName,
    },
  );

  const chat_jid = `${group.folder}@web`;
  const abortKey = chatAbortKey(group.folder, conversation_id, chat_jid);
  let isRunning = !!conversation_id && chatRunAbortControllers.has(abortKey);
  const activeStreamKey = conversation_id
    ? getActiveStreamKeyForConv(conversation_id)
    : undefined;
  let durableConversationRun = conversation_id
    ? await getActiveRunForConversation(conversation_id)
    : undefined;
  let hasActiveConversationRun = !!activeStreamKey || !!durableConversationRun;
  const senderUserId = req.authUser?.id ? String(req.authUser.id) : undefined;
  const activeAttributionChanged =
    (senderUserId ?? null) !==
    (existingConversation?.lastTriggeredByUserId ?? null);
  const steerAttributionChanged =
    req.body?.delivery === 'steer' &&
    (isRunning || hasActiveConversationRun) &&
    activeAttributionChanged;
  // Claim the slot before persisting the first turn. runChatAgent replaces
  // this controller with its real cancellation controller when it starts.
  // Without this reservation, two simultaneous POSTs can both see idle and
  // create overlapping runs before either has emitted chat_started.
  const submissionClaim = new AbortController();
  const humanLeaseId = `human:${randomUUID()}`;
  let humanExecutionLease =
    !isRunning && !hasActiveConversationRun && conversation_id
      ? await acquireConversationExecutionLease(conversation_id, humanLeaseId)
      : null;
  let busyExecutionLease = humanExecutionLease
    ? null
    : conversation_id
      ? await getConversationExecutionLease(conversation_id)
      : null;
  if (
    conversation_id &&
    !humanExecutionLease &&
    !activeStreamKey &&
    busyExecutionLease &&
    Date.now() - Date.parse(busyExecutionLease.acquiredAt) >=
      STALE_TERMINAL_LEASE_GRACE_MS &&
    !personaBoundaryQueueConsumers.has(conversation_id) &&
    !directLlmQueueConsumers.has(conversation_id)
  ) {
    const [latestMessage] = await getChatMessages(
      group.folder,
      1,
      conversation_id,
    );
    if (latestMessage?.role === 'assistant') {
      const staleOwnerId = busyExecutionLease.ownerId;
      chatRunAbortControllers.get(abortKey)?.abort();
      chatRunAbortControllers.delete(abortKey);
      if (durableConversationRun) {
        await completeActiveRun(durableConversationRun.id, 'error');
        durableConversationRun = undefined;
      }
      await releaseConversationExecutionLease(conversation_id, staleOwnerId);
      humanExecutionLease = await acquireConversationExecutionLease(
        conversation_id,
        humanLeaseId,
      );
      busyExecutionLease = humanExecutionLease
        ? null
        : await getConversationExecutionLease(conversation_id);
      isRunning = chatRunAbortControllers.has(abortKey);
      hasActiveConversationRun = !!activeStreamKey || !!durableConversationRun;
      logger.warn(
        { conversationId: conversation_id, staleOwnerId },
        'Recovered terminal conversation ownership while admitting a human follow-up',
      );
    }
  }
  let stopHumanLeaseHeartbeat = humanExecutionLease
    ? startConversationExecutionLeaseHeartbeat(conversation_id, humanLeaseId)
    : undefined;
  const releaseHumanExecutionLease = async () => {
    stopHumanLeaseHeartbeat?.();
    stopHumanLeaseHeartbeat = undefined;
    if (!humanExecutionLease) return;
    humanExecutionLease = null;
    await releaseConversationExecutionLease(conversation_id, humanLeaseId);
  };
  res.once('finish', () => {
    // Successful background runs retain the lease until their terminalizer.
    // Validation, duplicate, queue, and error responses have no executor.
    if (res.statusCode !== 202) void releaseHumanExecutionLease();
  });
  let ownedDirectDeliveryGate: DirectLlmDeliveryGate | undefined;
  // Releases everything this POST reserved at admission. A no-op once the
  // runner has replaced the claim with its own controller.
  const releaseSubmissionClaim = () => {
    if (chatRunAbortControllers.get(abortKey) !== submissionClaim) return;
    chatRunAbortControllers.delete(abortKey);
    personaBoundaryQueueConsumers.delete(conversation_id);
    directLlmQueueConsumers.delete(conversation_id);
    if (ownedDirectDeliveryGate)
      deleteDirectLlmDeliveryGate(conversation_id, ownedDirectDeliveryGate);
  };
  const claimedSubmissionSlot =
    !isRunning &&
    !hasActiveConversationRun &&
    !!conversation_id &&
    !!humanExecutionLease &&
    tryClaimChatRunAbortController(abortKey, submissionClaim);
  if (claimedSubmissionSlot) {
    const personaBoundaryOwner = !!(
      mainAiUserContext || aiCoordinatorInstructions
    );
    if (personaBoundaryOwner) {
      personaBoundaryQueueConsumers.add(conversation_id);
    } else if (isLlm) {
      directLlmQueueConsumers.add(conversation_id);
      ownedDirectDeliveryGate = openDirectLlmDeliveryGate(conversation_id);
    }
    const releaseExpiredSubmissionClaim = () => {
      if (chatRunAbortControllers.get(abortKey) === submissionClaim) {
        // Deferred memory preparation can legitimately outlive the original
        // admission timeout. Keep the in-memory claim aligned with the lease
        // heartbeat until the background run replaces or releases it. Persona
        // phases likewise run for a long time before runChatAgent replaces the
        // claim; releasing here would drop the boundary-queue consumer and
        // strand later messages. The run's finally owns that cleanup.
        if (memoryContext.level !== 'off' || personaBoundaryOwner) {
          setTimeout(releaseExpiredSubmissionClaim, 30_000).unref?.();
          return;
        }
        releaseSubmissionClaim();
      }
    };
    setTimeout(releaseExpiredSubmissionClaim, 30_000).unref?.();
    // Validation/persistence failures after the claim are reported through
    // Express. Release immediately on those error responses so a browser queue
    // is never left waiting for a chat_completed event from a run that did not
    // start. Successful 202 responses keep the claim until the runner replaces
    // it (or the background finally below observes that replacement never
    // happened).
    res.once('finish', () => {
      if (res.statusCode >= 400) releaseSubmissionClaim();
    });
  } else if (!isRunning && !hasActiveConversationRun && conversation_id) {
    // Another producer reserved the slot while the durable-run lookup was
    // pending. Treat it as running so this human turn follows the normal
    // priority/queue path instead of overwriting the reservation.
    isRunning = true;
    if (humanExecutionLease) {
      await releaseHumanExecutionLease();
      busyExecutionLease = await getConversationExecutionLease(conversation_id);
    }
  }

  // A worktree removal locks this conversation row against lease acquisition.
  // If that transition won after the initial route reads, refresh the binding
  // and session only after acquiring the execution lease so this turn cannot
  // resume the removed native session from a stale preflight snapshot.
  if (humanExecutionLease && !autoCreated) {
    const refreshedConversation = await getConversation(conversation_id);
    if (refreshedConversation) existingConversation = refreshedConversation;
    sessionOverride = await getConversationSessionId(
      conversation_id,
      resolvedSessionKey,
    );
    shouldForkSession =
      !!sessionOverride && (await isConversationForkPending(conversation_id));
  }

  // For forks, summarize the sliced transcript. Fresh sessions, including
  // sessions invalidated by worktree removal, receive the canonical gap.
  const gapSessionId = shouldForkSession ? null : sessionOverride;
  // Archive restoration shares the append lock. A synchronous read here can
  // collide with an in-flight async reader/writer on a new or empty transcript
  // and throw before admission returns 202. Await one snapshot for all handoff
  // builders, including persona and resumed-session context.
  const handoffEntries = await readChatTranscriptAsync(
    group.folder,
    conversation_id,
  );
  const contextGap = getAgentContextGap(
    group.folder,
    conversation_id,
    resolvedSessionKey,
    gapSessionId,
    handoffEntries,
  );
  const personaHandoffMessages = getPersonaHandoffMessages(
    group.folder,
    conversation_id,
    handoffEntries,
  );
  const personaContextGap =
    personaHandoffMessages.length > 0
      ? `[CONTEXT_SUMMARY: Invited persona messages since your previous turn:\n${personaHandoffMessages
          .map(
            (message) =>
              `Assistant (${message.senderName}): ${message.content}`,
          )
          .join('\n\n')}]`
      : null;
  const interleavedContextGap = sessionOverride
    ? getAgentInterleavedContextGap(
        group.folder,
        conversation_id,
        sessionOverride,
        handoffEntries,
      )
    : null;

  const handoffContext = sessionOverride
    ? (interleavedContextGap ?? personaContextGap ?? contextGap)
    : contextGap;
  const composeLlmPrompt = (memoryCapsule: string): string => {
    let prompt = prependMemoryCapsule(agentContent, memoryCapsule);
    // Strip any existing context summaries (e.g. if inherited from a fork)
    prompt = prompt.replace(/\[CONTEXT_SUMMARY:[\s\S]*?\]/g, '').trim();
    if (!directLiveTranscript && audioTranscripts.length > 0) {
      const transcriptBlock = audioTranscripts
        .map(
          (transcript: string) => `[Voice message transcript]: ${transcript}`,
        )
        .join('\n\n');
      prompt = `${prompt}\n\n${transcriptBlock}`;
    }
    if (lateAudioTranscripts) {
      prompt = `${prompt}\n\n[Voice message: the attached audio recording is the user's spoken message. Listen to it before replying.]`;
    }
    // CLI runtimes need the summary as an explicit handoff because they cannot
    // replay another runtime's native session. Direct LLM runs instead receive
    // the normalized transcript through getLlmHistory().
    if (!isLlm && handoffContext) {
      prompt = `${handoffContext}\n\n${prompt}`;
    }
    if (isCompact) {
      prompt = `[INSTRUCTION: Please summarize our entire conversation so far into a concise "Current Context" block that captures all key decisions, facts, and pending tasks. Output ONLY the summary text, no preamble or conversational filler. Your goal is to be perfectly prepared for a fresh session using ONLY this summary.]`;
    }
    return appendOpenFileContext(prompt, openFileContext);
  };
  const buildMemoryCapsuleForTurn = async (): Promise<string> => {
    try {
      const relatedGroups =
        memoryContext.level === 'deep' || memoryContext.level === 'standard'
          ? await resolveAuthorizedRelatedGroups(
              group,
              Object.values(registeredGroups),
              (folder) => userCanAccessGroup(req, folder),
              memoryContext.level,
            )
          : [];
      return await buildMemoryCapsule({
        level: memoryContext.level,
        prompt: agentContent,
        currentGroup: group,
        objectiveId: objectiveId ?? undefined,
        relatedGroups,
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to build memory capsule');
      return '';
    }
  };
  const deferMemoryCapsule =
    claimedSubmissionSlot && memoryContext.level !== 'off';
  // A busy submission never starts a run: it is queued by the browser (the
  // resubmit rebuilds the capsule), rejected, or steered, and only the persona
  // queue and direct-LLM pending paths consume the capsule. Build it lazily
  // there so the other paths do not wait on the memory judge.
  const submissionBusy = isRunning || hasActiveConversationRun;
  let capsule = '';
  let llmPrompt = composeLlmPrompt(capsule);
  let capsulePromise: Promise<string> | undefined;
  const ensureCapsule = (busyPath: string): Promise<string> => {
    capsulePromise ??= (async () => {
      const startedAt = Date.now();
      capsule = await buildMemoryCapsuleForTurn();
      llmPrompt = composeLlmPrompt(capsule);
      if (submissionBusy) {
        logger.debug(
          {
            folder: group.folder,
            conversation_id,
            path: busyPath,
            capsuleBuildMs: Date.now() - startedAt,
          },
          'Built memory capsule for busy submission',
        );
      }
      return capsule;
    })();
    return capsulePromise;
  };
  if (!deferMemoryCapsule && !submissionBusy) {
    await ensureCapsule('idle');
  }

  const shouldAttemptSteering =
    req.body?.delivery === 'steer' && !!(isRunning || hasActiveConversationRun);

  // A browser keeps a pending copy until this acknowledgement arrives. A
  // retry after a lost response must therefore recognize the canonical turn
  // instead of starting it again. Browser-owned queued responses have no
  // canonical row yet and continue through the ownership decision below.
  const clientSubmissionId =
    typeof req.body?.clientSubmissionId === 'string' &&
    req.body.clientSubmissionId.length <= 200
      ? req.body.clientSubmissionId
      : undefined;
  const clientSubmissionIds = Array.isArray(req.body?.clientSubmissionIds)
    ? req.body.clientSubmissionIds.filter(
        (id: unknown): id is string =>
          typeof id === 'string' && id.length <= 200,
      )
    : clientSubmissionId
      ? [clientSubmissionId]
      : [];
  let releasedRetryUserMessage: ChatMessage | undefined;
  let releasedRetryAlreadyConsumed = false;
  if (clientSubmissionId && conversation_id) {
    const transcript = readChatTranscript(group.folder, conversation_id);
    const existing = transcript.find(
      (entry) =>
        !!entry &&
        typeof entry === 'object' &&
        (entry as { type?: unknown }).type === 'message' &&
        (entry as { role?: unknown }).role === 'user' &&
        (entry as { id?: unknown }).id === clientSubmissionId,
    ) as Record<string, unknown> | undefined;
    if (existing) {
      const directDelivery = getDirectChatMessageDelivery(
        group.folder,
        conversation_id,
        clientSubmissionId,
      );
      if (directDelivery === 'released' || directDelivery === 'followup') {
        const followup = await claimReleasedDirectFollowup(
          group.folder,
          conversation_id,
          clientSubmissionId,
        );
        if (followup) {
          releaseSubmissionClaim();
          scheduleClaimedDirectFollowup(followup.claim.runId);
          return res.json({
            conversation_id,
            userMessage: existing,
            delivery: 'followup' as const,
            queueOwner: 'server' as const,
            runId: followup.claim.runId,
            memoryCapsule: capsule || undefined,
          });
        }
        const hasFinishedFollowup = transcript.some(
          (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            'type' in entry &&
            entry.type === 'direct_followup_finished' &&
            'messageId' in entry &&
            entry.messageId === clientSubmissionId,
        );
        if (hasFinishedFollowup) {
          releaseSubmissionClaim();
          return res.json({
            conversation_id,
            userMessage: existing,
            delivery: 'followup' as const,
            queueOwner: 'server' as const,
            memoryCapsule: capsule || undefined,
          });
        }
        // Pre-envelope releases and consumptions have no durable executor.
        // Preserve the legacy browser retry path instead of dropping its copy.
        releasedRetryUserMessage = existing as unknown as ChatMessage;
        releasedRetryAlreadyConsumed = directDelivery === 'followup';
      } else {
        releaseSubmissionClaim();
        return res.json({
          conversation_id,
          userMessage:
            directDelivery === 'pending' || directDelivery === 'steered'
              ? { ...existing, steeringDelivery: directDelivery }
              : existing,
          ...(directDelivery === 'pending'
            ? { delivery: 'pending' as const, queueOwner: 'direct' as const }
            : directDelivery === 'steered'
              ? { delivery: 'steered' as const }
              : directDelivery === 'released'
                ? {
                    delivery: 'queued' as const,
                    queueOwner: 'browser' as const,
                  }
                : {}),
          memoryCapsule: capsule || undefined,
        });
      }
    }
    const stableQueuePending = getQueuedChatMessageStates(
      group.folder,
      conversation_id,
    ).pending.includes(clientSubmissionId);
    if (stableQueuePending) {
      if (isRunning || hasActiveConversationRun) {
        return res.json({
          conversation_id,
          delivery: 'queued',
          queueOwner: 'persona',
          queuedMessageId: clientSubmissionId,
          memoryCapsule: capsule || undefined,
        });
      }
      await releaseUnconsumedQueuedChatMessages(group.folder, conversation_id);
    }
  }

  const directDeliveryClaim =
    !activeAttributionChanged && (isRunning || hasActiveConversationRun)
      ? claimDirectLlmDelivery(conversation_id)
      : undefined;

  if (
    (isRunning || hasActiveConversationRun) &&
    (req.body?.delivery !== 'steer' || steerAttributionChanged) &&
    !directDeliveryClaim
  ) {
    const requestedSource =
      typeof req.body?.source === 'string' ? req.body.source : 'web';
    const personaQueueOwner =
      !!conversation_id && personaBoundaryQueueConsumers.has(conversation_id);
    if (
      !personaQueueOwner &&
      (requestedSource === 'http' || requestedSource === 'whatsapp')
    ) {
      return res.status(409).json({
        error: 'Conversation is busy; retry this message after completion',
        retryable: true,
        conversation_id,
      });
    }
    const queuedMessageId = personaQueueOwner
      ? (clientSubmissionId ?? randomUUID())
      : undefined;
    if (personaQueueOwner) {
      await ensureCapsule('persona-queue');
      const queuedSenderUserId = req.authUser?.id
        ? String(req.authUser.id)
        : undefined;
      await updateConversation(conversation_id, group.folder, {
        lastTriggeredByUserId: queuedSenderUserId ?? null,
        lastTriggerSource: queuedSenderUserId ? 'user' : 'system',
        lastTriggeredAt: now,
      });
      if (queuedMessageId) recordLateAudioTranscripts(queuedMessageId);
      appendChatTranscriptEntry(group.folder, conversation_id, {
        type: 'queued_user_message',
        id: queuedMessageId,
        role: 'user',
        content: enrichedContent,
        sender_name: humanParticipantName,
        senderUserId: queuedSenderUserId,
        senderAvatarUrl: humanParticipantAvatarUrl,
        triggerSource: queuedSenderUserId ? 'user' : 'system',
        source: requestedSource,
        attachments,
        deepLinks,
        clientSubmissionIds:
          clientSubmissionIds.length > 0
            ? clientSubmissionIds
            : queuedMessageId
              ? [queuedMessageId]
              : [],
        queuedExecutionContent: llmPrompt,
        queuedAgentCmd: agentConfig?.id ?? agent_cmd,
        queuedRuntimeSelection:
          requestedRuntime ??
          conversationRuntime ??
          (agentConfig
            ? runtimeSelectionFromResolvedAgent(agentConfig)
            : undefined),
        queuedChatMode: chat_mode,
        queuedMemoryContextLevel: memoryContext.level,
        created_at: now,
        conversation_id,
      });
    }
    logger.info(
      { folder: group.folder, conversation_id },
      personaQueueOwner
        ? 'Agent already running, queued prompt for persona boundary'
        : 'Agent already running, returning prompt to browser queue',
    );
    return res.json({
      conversation_id,
      delivery: 'queued',
      queueOwner: personaQueueOwner ? 'persona' : 'browser',
      queuedMessageId,
      memoryCapsule: capsule || undefined,
    });
  }

  let acceptedCodexSteeringBoundary: ActiveStreamBoundary | undefined;
  let acceptedCodexSteering = false;
  if (
    (isRunning || hasActiveConversationRun) &&
    req.body?.delivery === 'steer' &&
    !activeAttributionChanged &&
    !directDeliveryClaim
  ) {
    // steerChatAgentProcess targets the main harness. An invited persona can
    // have a simultaneous UI placeholder, but persona runs disable steering;
    // anchoring this receipt to that placeholder splits the wrong speaker.
    acceptedCodexSteeringBoundary =
      getActiveMainStreamBoundaryForConv(conversation_id);
    const accepted = await steerChatAgentProcess(
      group.folder,
      conversation_id,
      appendOpenFileContext(enrichedContent, openFileContext),
    );
    if (!accepted) {
      logger.info(
        { folder: group.folder, conversation_id },
        'Steer rejected; returning prompt to browser queue',
      );
      return res.json({
        conversation_id,
        delivery: 'queued',
        queueOwner: 'browser',
        memoryCapsule: capsule || undefined,
      });
    }
    acceptedCodexSteering = true;
  }
  // Audio artifacts belong to the accepted delivery, not to the submission
  // attempt. In particular, a browser-owned queued response must not append
  // these ahead of the in-flight assistant turn; the completion retry will
  // append them once when it becomes the canonical user turn.
  let userMsg: Awaited<ReturnType<typeof saveChatMessage>>;
  const validSources = ['web', 'whatsapp', 'http', 'android', 'ios'] as const;
  const messageSource =
    typeof req.body?.source === 'string' &&
    validSources.includes(req.body.source as (typeof validSources)[number])
      ? (req.body.source as (typeof validSources)[number])
      : 'web';
  try {
    for (const attachment of releasedRetryUserMessage
      ? []
      : (processedAttachments ?? [])) {
      if (
        (attachment as any).transcript &&
        (attachment as any).transcriptionSource
      ) {
        appendChatTranscriptEntry(group.folder, conversation_id, {
          type: 'audio_transcription',
          source: (attachment as any).transcriptionSource,
          content: (attachment as any).transcript,
          filename: attachment.filename,
          created_at: now,
          conversation_id,
        });
      }
    }

    // Save user message to DB. We skip transcript append here because runChatAgent
    // (via runContainerAgent) will append it to the transcript with proper agent metadata.
    // Exception: Direct LLM runs don't auto-append user messages to the transcript in runContainerAgent.
    await updateConversation(conversation_id, group.folder, {
      lastTriggeredByUserId: senderUserId ?? null,
      lastTriggerSource: senderUserId ? 'user' : 'system',
      lastTriggeredAt: now,
    });
    userMsg =
      releasedRetryUserMessage ??
      (await saveChatMessage({
        id: clientSubmissionId,
        group_folder: group.folder,
        role: 'user',
        content: enrichedContent,
        sender_name: humanParticipantName,
        senderUserId,
        senderAvatarUrl: humanParticipantAvatarUrl,
        source: messageSource,
        created_at: now,
        conversation_id: conversation_id,
        objective_id: objective?.id,
        attachments,
        deepLinks,
      }));
    if (!releasedRetryUserMessage) recordLateAudioTranscripts(userMsg.id);
    if (openFileContext && !releasedRetryUserMessage) {
      appendChatTranscriptEntry(group.folder, conversation_id, {
        type: 'open_file_context',
        messageId: userMsg.id,
        context: openFileContext,
        created_at: now,
        conversation_id,
      });
    }

    if (acceptedCodexSteering) {
      beginChatSteeringDelivery(userMsg.id);
    }
    if (directDeliveryClaim) {
      await ensureCapsule('direct-user-pending');
      await directPendingReceiptTestBarrier?.({
        groupFolder: group.folder,
        conversationId: conversation_id,
        messageId: userMsg.id,
      });
      const followupAgentConfig =
        getResolvedRuntimeConfig(
          group,
          existingConversation!.runtimeSelection,
          existingConversation!.last_agent_cmd,
        ) ?? agentConfig!;
      appendChatTranscriptEntry(group.folder, conversation_id, {
        type: 'direct_user_pending',
        messageId: userMsg.id,
        conversation_id,
        objectiveId: existingConversation!.objective_id ?? undefined,
        agentCmd: followupAgentConfig.id,
        runtimeSelection: existingConversation!.runtimeSelection ?? undefined,
        chatMode: chat_mode ?? null,
        executionContent: llmPrompt,
        triggeredByUserId: senderUserId ?? null,
        triggerSource: senderUserId ? 'user' : 'system',
        created_at: now,
      });
    }
    if (acceptedCodexSteering) {
      await completeChatSteeringDelivery(
        group.folder,
        conversation_id,
        userMsg.id,
        true,
        acceptedCodexSteeringBoundary,
      );
    }

    // Update conversation preview with first message
    updateConversationPreview(conversation_id, conversationPreview);
    if (!releasedRetryUserMessage) {
      broadcast({
        type: 'chat_message',
        payload: {
          folder: group.folder,
          message:
            shouldAttemptSteering || directDeliveryClaim
              ? {
                  ...userMsg,
                  steeringDelivery: acceptedCodexSteering
                    ? 'steered'
                    : 'pending',
                  steeringStreamKey: activeStreamKey,
                }
              : clientSubmissionIds.length > 0
                ? { ...userMsg, clientSubmissionIds }
                : userMsg,
        },
      });
    }
  } finally {
    directDeliveryClaim?.();
  }
  // Brain events carry the conversation scope; execution remains shared.
  publishEvent(
    brainUrl,
    {
      type: 'objective_message',
      project_id: group.folder,
      task_id: null,
      objective_id: objective?.id ?? null,
      timestamp: now,
      data: { content: enrichedContent, conversation_id: conversation_id },
    },
    group,
  );

  // Use a per-run UUID as the stream key so each agent run has its own isolated
  // streaming slot. This prevents a new chat_started event from clearing the
  // previous run's streaming content when the user sends a message mid-stream.
  // The frontend maps conversation_id → streamKey via the activeStreamKeyByConv
  // store entry that is updated when the chat_started WebSocket event arrives.
  const streamKey = randomUUID();

  // If an agent is already running for this conversation, don't start another one.
  // The running agent will pick up this new message via polling (if it's in DirectLLM turn-loop).
  if (isRunning || hasActiveConversationRun) {
    if (directDeliveryClaim) {
      logger.info(
        { folder: group.folder, conversation_id },
        'DirectLLM delivery admitted for current turn',
      );
      return res.json({
        userMessage: {
          ...userMsg,
          steeringDelivery: 'pending',
          steeringStreamKey: activeStreamKey,
        },
        conversation_id,
        delivery: 'pending',
        queueOwner: 'direct',
        memoryCapsule: capsule || undefined,
      });
    }
    if (req.body?.delivery === 'steer') {
      logger.info(
        { folder: group.folder, conversation_id },
        'Steered active Codex turn',
      );
      return res.json({
        userMessage: userMsg,
        conversation_id,
        delivery: 'steered',
        steeringBoundary: acceptedCodexSteeringBoundary,
        memoryCapsule: capsule || undefined,
      });
    }
    logger.info(
      { folder: group.folder, conversation_id },
      'Agent already running, skipping new run; message saved for injection',
    );
    return res.json({
      userMessage: userMsg,
      conversation_id,
      delivery: 'queued',
      queueOwner: 'browser',
      memoryCapsule: capsule || undefined,
    });
  }

  // A previous Stop remains sticky until this first post-stop human turn. Do
  // this only after the active-run guard so a message queued during shutdown
  // cannot accidentally revive the old autonomous loop.
  stoppedLiveConversationIds.delete(conversation_id);

  if (releasedRetryUserMessage && !releasedRetryAlreadyConsumed) {
    appendChatTranscriptEntry(group.folder, conversation_id, {
      type: 'queued_user_consumed',
      messageId: releasedRetryUserMessage.id,
      created_at: new Date().toISOString(),
      conversation_id,
    });
  }

  const liveConversation =
    existingConversation ?? (await getConversation(conversation_id));
  if (liveConversation?.continuousPersonaLoop === false) {
    disabledContinuousPersonaConversationIds.add(conversation_id);
  } else {
    disabledContinuousPersonaConversationIds.delete(conversation_id);
  }
  const personaDriven = !!mainAiUserContext || !!aiCoordinatorInstructions;
  const initialUserMention = await resolveActivePersonaMention(
    conversation_id,
    enrichedContent,
    undefined,
    true,
  );
  const initialPersonaRows = await listConversationAiUserRows(conversation_id);
  const hasActiveInvitedPersona = initialPersonaRows.some(
    ({ aiUser, membership }) =>
      aiUser.enabled === 1 &&
      membership.status === 'active' &&
      aiUser.id !== mainAiUserContext?.aiUser.id,
  );
  const singlePersonaMainTurn = !!mainAiUserContext && !hasActiveInvitedPersona;
  const hasInitialBeforePersona = initialPersonaRows.some(
    ({ aiUser, membership }) =>
      aiUser.enabled === 1 &&
      membership.status === 'active' &&
      aiUser.id !== mainAiUserContext?.aiUser.id &&
      aiUser.turn === 'before',
  );
  const invitedPersonaOwnsInitialTurn =
    initialUserMention?.kind === 'select' ||
    (initialUserMention?.kind !== 'main' && hasInitialBeforePersona);
  let requestedLiveModeSessionId =
    req.body?.liveMode === true &&
    typeof req.body?.liveModeSessionId === 'string'
      ? req.body.liveModeSessionId.trim().slice(0, 128)
      : '';
  let requestedLiveModeKind: LiveModeKind =
    req.body?.liveModeKind === 'work'
      ? 'work'
      : req.body?.liveModeKind === 'personas'
        ? 'personas'
        : personaDriven
          ? 'personas'
          : 'work';
  // A message may only bind to a live run that is still on for this session
  // (or whose lease expired). A stale device must not re-open a run another
  // device stopped; only the first message of a conversation this request just
  // created may start one. Otherwise the message is processed as non-live.
  let liveModeRejected = false;
  if (requestedLiveModeSessionId && !autoCreated) {
    const bindableMode = await getBindableLiveRunMode(
      conversation_id,
      requestedLiveModeSessionId,
    );
    if (bindableMode) {
      requestedLiveModeKind = bindableMode;
    } else {
      liveModeRejected = true;
      requestedLiveModeSessionId = '';
    }
  }
  const workLiveModeRequested =
    !liveModeRejected &&
    req.body?.liveMode === true &&
    requestedLiveModeKind === 'work';
  if (requestedLiveModeSessionId) {
    setPersonaLiveSession(conversation_id, requestedLiveModeSessionId, {
      mode: requestedLiveModeKind,
      userId: req.authUser?.id,
      deviceId: req.authDeviceId,
      platform:
        messageSource === 'android' || messageSource === 'ios'
          ? messageSource
          : 'web',
    });
    await enableLiveQueue(conversation_id, {
      sessionId: requestedLiveModeSessionId,
      mode: requestedLiveModeKind,
      userId: req.authUser?.id,
      deviceId: req.authDeviceId,
      platform:
        messageSource === 'android' || messageSource === 'ios'
          ? messageSource
          : 'web',
    });
  }

  broadcast({
    type: 'chat_started',
    payload: {
      folder: group.folder,
      conversation_id,
      streamKey,
      liveTitle: liveConversation?.title ?? undefined,
      livePreview: conversationPreview,
      personaDriven,
      memoryPreparing: deferMemoryCapsule,
      // A configured main persona is rendered through the same identity-bound
      // rows as invited personas. Do not create a speculative generic main
      // placeholder before the talking stick reaches it.
      canonicalPersonaTurns: invitedPersonaOwnsInitialTurn,
      virtualSender: mainAiUserContext
        ? {
            id: mainAiUserContext.aiUser.id,
            name: mainAiUserContext.aiUser.name,
            identity: mainAiUserContext.aiUser.identity,
            avatarUrl: mainAiUserContext.aiUser.avatarPath
              ? `/api/ai-users/${encodeURIComponent(mainAiUserContext.aiUser.id)}/avatar?thumbnail=1&v=${encodeURIComponent(mainAiUserContext.aiUser.updatedAt || mainAiUserContext.aiUser.avatarPath)}`
              : null,
          }
        : null,
    },
  });

  // Return immediately so reverse proxies don't 504 on long agent runs.
  // The run continues in background and streams via WebSocket.
  res.status(202).json({
    userMessage: userMsg,
    conversation_id,
    memoryCapsule: capsule || undefined,
    ...(liveModeRejected ? { liveModeRejected: true } : {}),
  });

  void (async () => {
    let response: string | null = null;
    let runTelemetry: Record<string, unknown> | null = null;
    let runFailed = false;
    let runPending = false;
    let runUuid: string | undefined;
    let runGeneratedArtifacts: GeneratedImageArtifact[] = [];
    let mainAiUserEmote: string | undefined;
    let mainAiUserSpeechText: string | undefined;
    let talkingStickDecision: import('../modules/ai-users/orchestrator.js').TalkingStickDecision =
      { kind: 'pass' };
    let markerOnlyResponse = false;
    let lastInvitedAiUserId: string | undefined;
    const initiallyStoppedPersonaIds = new Set<string>();
    let beforeAiMessages: import('../modules/ai-users/orchestrator.js').AiUserTurnMessage[] =
      [];
    let addressedPersonaMessage:
      | import('../modules/ai-users/orchestrator.js').AiUserTurnMessage
      | undefined;
    let addressedPersonaHandoff:
      | import('../modules/ai-users/orchestrator.js').AiUserHandoff
      | undefined;
    let hasCompletedBeenBroadcasted = false;
    let terminalCompletionPromise: Promise<void> | undefined;
    let assistantCommitPromise: Promise<ChatMessage> | undefined;
    let causalRunId: string | null = null;
    let releasedQueuedMessageIds: string[] = [];
    const broadcastTerminalCompletion = async (
      payload: Record<string, unknown>,
      beforeBroadcast?: () => void | string[] | Promise<void | string[]>,
      claimReleasedFollowups = true,
    ): Promise<void> => {
      if (terminalCompletionPromise) return terminalCompletionPromise;
      // Claim terminalization synchronously. Stop and natural provider
      // completion can race, but only the winner may persist the final row,
      // release admitted messages, or publish chat_completed.
      terminalCompletionPromise = (async () => {
        // Close and drain boundary admission before any terminal callback can
        // scan receipts or abort the provider. A request that already claimed
        // this run remains owned until direct_user_pending is durable; later
        // requests remain browser-owned.
        personaBoundaryQueueConsumers.delete(conversation_id);
        if (ownedDirectDeliveryGate) {
          await closeDirectLlmDeliveryGate(
            conversation_id,
            ownedDirectDeliveryGate,
          );
        }
        directLlmQueueConsumers.delete(conversation_id);
        const releasedBeforeBroadcast = await beforeBroadcast?.();
        const handoff = claimReleasedFollowups
          ? await releaseAndClaimDirectFollowups(group.folder, conversation_id)
          : {
              releasedMessageIds:
                releasedBeforeBroadcast ??
                (await releaseUnconsumedQueuedChatMessages(
                  group.folder,
                  conversation_id,
                )),
              claimed: [],
            };
        releasedQueuedMessageIds = handoff.releasedMessageIds;
        const consumedQueuedMessageIds = getQueuedChatMessageStates(
          group.folder,
          conversation_id,
        ).consumed;
        // The completion event is the UI's signal that a follow-up can start.
        // Release the just-finished run's durable slot first; otherwise a
        // prompt submitted immediately after chat_completed is returned to a
        // browser queue whose draining completion has already passed.
        chatRunAbortControllers.delete(abortKey);
        await releaseHumanExecutionLease();
        broadcast({
          type: 'chat_completed',
          payload: {
            folder: group.folder,
            conversation_id,
            streamKey,
            ...payload,
            releasedQueuedMessageIds,
            consumedQueuedMessageIds,
          },
        });
        hasCompletedBeenBroadcasted = true;
        const lifecycleEvent =
          payload.pending === true
            ? 'needs_input'
            : payload.failed === true
              ? 'failed'
              : 'completed';
        await notifyEntityLifecycle({
          group_folder: group.folder,
          conversation_id,
          run_id: causalRunId ?? streamKey,
          event: lifecycleEvent,
          title:
            lifecycleEvent === 'needs_input'
              ? 'Conversation needs input'
              : lifecycleEvent === 'failed'
                ? 'Conversation failed'
                : 'Conversation completed',
        });
        for (const claim of handoff.claimed) {
          scheduleClaimedDirectFollowup(claim.runId);
        }
      })();
      return terminalCompletionPromise;
    };
    let stoppedByUser = false;
    const settleStoppedRun = (): Promise<void> => {
      stoppedByUser = true;
      stoppedLiveStreamKeys.delete(streamKey);
      return broadcastTerminalCompletion(
        {
          pending: true,
          failed: false,
          liveState: 'needs_input',
          completionSummary: 'Stopped by user.',
        },
        async () => {
          // Release admitted input before aborting the HTTP stream. Some SDKs
          // end an aborted iterator cleanly; without the receipt, their loop can
          // advance into one last steering scan and absorb the released turn.
          const releasedMessageIds = await releaseUnconsumedQueuedChatMessages(
            group.folder,
            conversation_id,
          );
          chatRunAbortControllers.get(abortKey)?.abort();

          // A provider may complete while Stop is in flight. If its canonical
          // assistant commit already won, wait for it rather than adding a stop
          // marker. A streamed provider row also wins, but still needs the
          // aggregate-only outcome write that the route normally performs.
          if (assistantCommitPromise) {
            await assistantCommitPromise;
          } else {
            const recent = await getChatMessages(
              group.folder,
              1,
              conversation_id,
            );
            if (recent[0]?.role === 'assistant') {
              await saveChatMessage({
                id: recent[0].id,
                group_folder: group.folder,
                role: 'assistant',
                content: recent[0].content,
                sender_name: recent[0].sender_name,
                source: 'web',
                created_at: new Date().toISOString(),
                conversation_id,
                skipTranscript: true,
              });
            } else if (recent[0]?.role === 'user') {
              const stopMsg = await saveChatMessage({
                group_folder: group.folder,
                role: 'assistant',
                content: '⏹ Stopped by user.',
                sender_name: null,
                source: 'web',
                created_at: new Date().toISOString(),
                conversation_id,
                skipTranscript: false,
              });
              broadcast({
                type: 'chat_message',
                payload: { folder: group.folder, message: stopMsg },
              });
            }
          }
          const activeRuns = await getActiveChatRunsForConversation(
            group.folder,
            conversation_id,
          );
          for (const run of activeRuns)
            await completeActiveRun(run.id, 'error');
          return releasedMessageIds;
        },
        false,
      );
    };
    const keepTerminalizerForRun = isLlm && !personaDriven;
    if (keepTerminalizerForRun || deferMemoryCapsule) {
      conversationRunTerminalizers.set(conversation_id, {
        streamKey,
        stop: settleStoppedRun,
      });
    }
    if (deferMemoryCapsule) {
      capsule = await buildMemoryCapsuleForTurn();
      if (
        submissionClaim.signal.aborted ||
        stoppedLiveConversationIds.has(conversation_id) ||
        terminalCompletionPromise
      ) {
        stoppedByUser = true;
        if (!terminalCompletionPromise) {
          await settleStoppedRun();
        }
        await terminalCompletionPromise;
        const pendingTerminalizer =
          conversationRunTerminalizers.get(conversation_id);
        if (pendingTerminalizer?.streamKey === streamKey) {
          conversationRunTerminalizers.delete(conversation_id);
        }
        if (chatRunAbortControllers.get(abortKey) === submissionClaim) {
          chatRunAbortControllers.delete(abortKey);
        }
        return;
      }
      if (!keepTerminalizerForRun) {
        const preparationTerminalizer =
          conversationRunTerminalizers.get(conversation_id);
        if (preparationTerminalizer?.streamKey === streamKey) {
          conversationRunTerminalizers.delete(conversation_id);
        }
      }
      llmPrompt = composeLlmPrompt(capsule);
      broadcast({
        type: 'memory_capsule_ready',
        payload: {
          folder: group.folder,
          conversation_id,
          streamKey,
          level: memoryContext.level,
          capsule,
        },
      });
    }
    const liveMarkers = new LiveMarkerParser();
    const talkingStickMarkers = new TalkingStickStreamParser();
    const publishedLiveStatuses = new Set<string>();
    const mainSpeechProfile = mainAiUserContext
      ? speechProfileForAiUser(mainAiUserContext.aiUser)
      : undefined;
    const mainLiveStatusSpeaker = mainAiUserContext
      ? {
          agent_name: `ai-main:${mainAiUserContext.aiUser.id}`,
          sender_name: mainAiUserContext.aiUser.identity,
          senderUserId: `ai:${mainAiUserContext.aiUser.id}`,
        }
      : undefined;
    const shouldDelayMainPersonaText = () =>
      !!mainAiUserContext && getLiveModeKind(conversation_id) === 'personas';
    const publishLiveStatuses = (
      statuses: string[],
      persistTranscript: boolean,
      speechProfile?: { voiceId: string; language: string },
      speaker?: {
        agent_name: string;
        sender_name: string;
        senderUserId: string;
      },
    ) => {
      for (const status of statuses) {
        const statusKey = `${speaker?.senderUserId ?? ''}\u0000${status}`;
        if (publishedLiveStatuses.has(statusKey)) continue;
        publishedLiveStatuses.add(statusKey);
        // DirectLLM writes transcript entries as the response streams, so its
        // marker-free assistant records need one adjacent structured status.
        // CLI output is archived at turn completion and retains the marker in
        // its original event position; writing this side-channel record too
        // would persist the same narration twice. Ephemeral persona runtimes
        // archive no raw stream and therefore opt into this structured write.
        if (persistTranscript) {
          appendChatTranscriptEntry(group.folder, conversation_id, {
            type: 'live_status',
            content: status,
            created_at: new Date().toISOString(),
            conversation_id,
            ...speaker,
          });
        }
        const activity = upsertLiveActivity({
          folder: group.folder,
          conversation_id,
          state: 'working',
          status,
        });
        broadcast({
          type: 'live_activity',
          payload: {
            ...activity,
            speechVoice: speechProfile?.voiceId,
            speechLang: speechProfile?.language,
          },
        });
      }
    };
    const participantLiveMarkers = new Map<string, LiveMarkerParser>();
    const participantTurnMessages = new Map<
      string,
      import('../modules/ai-users/orchestrator.js').AiUserTurnMessage
    >();
    const participantSpeechProfiles = new Map<
      string,
      { voiceId: string; language: string }
    >();
    const participantLiveStatusSpeakers = new Map<
      string,
      {
        agent_name: string;
        sender_name: string;
        senderUserId: string;
      }
    >();
    const workNarrationEnabled = () =>
      getLiveModeKind(conversation_id) === 'work';
    const personaLiveStreamPresentation = () => {
      const liveModeSessionId =
        getLiveModeKind(conversation_id) === 'personas'
          ? getPersonaLiveSession(conversation_id)
          : undefined;
      return {
        liveModeSessionId,
        voiceDelayed: Boolean(liveModeSessionId),
        hiddenUntilPlayback: Boolean(liveModeSessionId),
      };
    };
    const withWorkNarration = (visible: string, statuses: string[]) => {
      const narration = workNarrationEnabled()
        ? statuses.map((status) => `\n\n[[live: ${status}]]\n\n`).join('')
        : '';
      return narration + visible;
    };

    let causalTriggeredByUserId = req.authUser?.id ?? null;
    let causalTriggerSource: 'user' | 'system' = req.authUser?.id
      ? 'user'
      : 'system';
    let currentHumanPrompt = enrichedContent;
    let currentHumanName = humanParticipantName;
    const personaTurnCallbacks = {
      get triggeredByUserId() {
        return causalTriggeredByUserId;
      },
      get senderUserId() {
        return causalTriggeredByUserId;
      },
      get triggerSource() {
        return causalTriggerSource;
      },
      liveMode: workLiveModeRequested,
      // Persona Live Mode voices this turn's reply, so the persona must be
      // told to answer in short spoken form instead of "LIVE MODE IS OFF".
      // Read per turn: switching Live Mode off mid-run restores the OFF text.
      get personaVoice() {
        return (
          getLiveModeKind(conversation_id) === 'personas' &&
          !!getPersonaLiveSession(conversation_id)
        );
      },
      shouldStop: () =>
        stoppedLiveStreamKeys.has(streamKey) ||
        stoppedLiveConversationIds.has(conversation_id),
      onTurnStarted: (
        message: import('../modules/ai-users/orchestrator.js').AiUserTurnMessage,
      ) => {
        participantTurnMessages.set(message.id, message);
        if (workNarrationEnabled())
          participantLiveMarkers.set(message.id, new LiveMarkerParser());
        if (message.speechProfile)
          participantSpeechProfiles.set(message.id, message.speechProfile);
        participantLiveStatusSpeakers.set(message.id, {
          agent_name: message.senderUserId,
          sender_name: message.sender_name,
          senderUserId: message.senderUserId,
        });
        broadcast({
          type: 'chat_persona_started',
          payload: {
            folder: group.folder,
            conversation_id,
            ...personaLiveStreamPresentation(),
            message: { ...message, agent_name: message.senderUserId },
          },
        });
      },
      onTurnChunk: (messageId: string, content: string) => {
        const parsed = workNarrationEnabled()
          ? (
              participantLiveMarkers.get(messageId) ?? new LiveMarkerParser()
            ).push(content)
          : { visible: content, statuses: [] };
        publishLiveStatuses(
          parsed.statuses,
          true,
          participantSpeechProfiles.get(messageId),
          participantLiveStatusSpeakers.get(messageId),
        );
        const streamed = withWorkNarration(parsed.visible, parsed.statuses);
        const message = participantTurnMessages.get(messageId);
        if (streamed)
          broadcast({
            type: 'chat_persona_output',
            payload: {
              folder: group.folder,
              conversation_id,
              ...personaLiveStreamPresentation(),
              messageId,
              content: streamed,
              agent_name: message?.senderUserId,
              sender_name: message?.sender_name,
              senderUserId: message?.senderUserId,
              created_at: message?.created_at,
            },
          });
      },
      onTurnFinished: (
        messageId: string,
        failed: boolean,
        skipped?: boolean,
        message?: import('../modules/ai-users/orchestrator.js').AiUserTurnMessage,
      ) => {
        if (message && !getPersonaLiveSession(conversation_id)) {
          broadcast({
            type: 'chat_message',
            payload: { folder: group.folder, message },
          });
        }
        if (!workLiveModeRequested) {
          participantTurnMessages.delete(messageId);
          // Persona Live Mode normally renders canonical chat_message rows,
          // but a streamed placeholder may still be present in an observer's
          // transcript cache. Always publish the boundary so clients can
          // clear its streaming state instead of leaving a pulsing dot.
          broadcast({
            type: 'chat_persona_finished',
            payload: {
              folder: group.folder,
              conversation_id,
              messageId,
              failed,
              skipped,
              telemetry: message?.telemetry,
              message,
            },
          });
          return;
        }
        const parser = participantLiveMarkers.get(messageId);
        participantLiveMarkers.delete(messageId);
        const speechProfile = participantSpeechProfiles.get(messageId);
        participantSpeechProfiles.delete(messageId);
        const speaker = participantLiveStatusSpeakers.get(messageId);
        participantLiveStatusSpeakers.delete(messageId);
        const tail = parser?.finish();
        if (tail) {
          publishLiveStatuses(tail.statuses, true, speechProfile, speaker);
          const streamed = withWorkNarration(tail.visible, tail.statuses);
          const message = participantTurnMessages.get(messageId);
          if (streamed)
            broadcast({
              type: 'chat_persona_output',
              payload: {
                folder: group.folder,
                conversation_id,
                ...personaLiveStreamPresentation(),
                messageId,
                content: streamed,
                agent_name: message?.senderUserId,
                sender_name: message?.sender_name,
                senderUserId: message?.senderUserId,
                created_at: message?.created_at,
              },
            });
        }
        participantTurnMessages.delete(messageId);
        broadcast({
          type: 'chat_persona_finished',
          payload: {
            folder: group.folder,
            conversation_id,
            messageId,
            failed,
            skipped,
            telemetry: message?.telemetry,
            message,
          },
        });
      },
      onMessage: (
        message: import('../modules/ai-users/orchestrator.js').AiUserTurnMessage,
      ) => {
        const liveModeSessionId =
          getLiveModeKind(conversation_id) === 'personas'
            ? getPersonaLiveSession(conversation_id)
            : undefined;
        void (async () => {
          let publishMessage = true;
          if (liveModeSessionId) {
            const queued = await registerLiveQueueMessage({
              conversationId: conversation_id,
              messageId: message.id,
              participantId: message.senderUserId.slice('ai:'.length),
            });
            publishMessage = queued.isCurrent === true;
          }
          if (publishMessage)
            broadcast({
              type: 'chat_message',
              payload: { folder: group.folder, liveModeSessionId, message },
            });
          // Audio is pre-generated only for an active Live session; outside
          // Live Mode the bubble's play button generates it on demand.
          if (liveModeSessionId && !workNarrationEnabled()) {
            await generateAndPublishPersonaSpeech(
              {
                conversationId: conversation_id,
                messageId: message.id,
                projectId: group.folder,
                text: message.speechText || message.content,
                speakerId: message.senderUserId.slice('ai:'.length),
                voice: message.speechProfile?.voiceId,
                lang: message.speechProfile?.language,
              },
              Boolean(liveModeSessionId),
            );
          }
        })();
      },
    };

    let markerTailFlushed = false;
    const flushMarkerTail = () => {
      if (markerTailFlushed) return;
      markerTailFlushed = true;
      const talkingStickRemainder = talkingStickMarkers.finish();
      if (talkingStickRemainder) {
        const parsed = liveMarkers.push(talkingStickRemainder);
        publishLiveStatuses(
          parsed.statuses,
          isLlm,
          mainSpeechProfile,
          mainLiveStatusSpeaker,
        );
        const streamed = withWorkNarration(parsed.visible, parsed.statuses);
        if (streamed && !shouldDelayMainPersonaText())
          broadcast({
            type: 'chat_output',
            payload: {
              folder: group.folder,
              content: streamed,
              conversation_id,
              streamKey,
            },
          });
      }
      const remainder = liveMarkers.finish();
      publishLiveStatuses(
        remainder.statuses,
        isLlm,
        mainSpeechProfile,
        mainLiveStatusSpeaker,
      );
      const streamedRemainder = withWorkNarration(
        remainder.visible,
        remainder.statuses,
      );
      if (streamedRemainder && !shouldDelayMainPersonaText())
        broadcast({
          type: 'chat_output',
          payload: {
            folder: group.folder,
            content: streamedRemainder,
            conversation_id,
            streamKey,
          },
        });
    };

    try {
      try {
        const userMention = initialUserMention;
        beforeAiMessages =
          userMention?.kind === 'main'
            ? []
            : await runAiUserPhase({
                // A named active invite gets the first response, regardless of
                // its normal phase. Otherwise preserve the before-main roster.
                phase: userMention?.kind === 'select' ? 'any' : 'before',
                group,
                conversationId: conversation_id,
                humanPrompt: enrichedContent,
                humanName: humanParticipantName,
                mainParticipantName,
                decision:
                  userMention?.kind === 'select' ? userMention : undefined,
                deps: sharedDeps,
                onTurnSkipped: (aiUserId) => {
                  lastInvitedAiUserId = aiUserId;
                },
                onTurnStopped: (aiUserId) => {
                  initiallyStoppedPersonaIds.add(aiUserId);
                  lastInvitedAiUserId = aiUserId;
                },
                onTurnComplete: (message) => {
                  lastInvitedAiUserId = message.senderUserId.slice(
                    'ai:'.length,
                  );
                  if (message.talkingStickDecision?.kind === 'stop') {
                    initiallyStoppedPersonaIds.add(lastInvitedAiUserId);
                  }
                  return true;
                },
                ...personaTurnCallbacks,
              });
        const exactInvitedMention =
          isExclusiveInvitedPersonaMention(userMention);
        addressedPersonaMessage = exactInvitedMention
          ? beforeAiMessages[0]
          : undefined;
        if (addressedPersonaMessage) {
          addressedPersonaHandoff = await resolveTalkingStickTarget(
            conversation_id,
            addressedPersonaMessage.talkingStickDecision ?? { kind: 'pass' },
            addressedPersonaMessage.senderUserId.slice('ai:'.length),
          );
          // An exact @persona message belongs to that participant. Its reply
          // and talking-stick decision drive the next boundary; the main
          // runtime must not receive the same human prompt as a second turn.
          response = addressedPersonaMessage.content;
        }
        if (
          stoppedLiveStreamKeys.has(streamKey) ||
          stoppedLiveConversationIds.has(conversation_id)
        ) {
          stoppedByUser = true;
          stoppedLiveStreamKeys.delete(streamKey);
          await broadcastTerminalCompletion({
            liveState: 'needs_input',
            pending: true,
            completionSummary: 'Stopped by user.',
          });
          return;
        }
        if (exactInvitedMention && !addressedPersonaMessage) {
          await broadcastTerminalCompletion({
            liveState: 'needs_input',
            pending: true,
            completionSummary:
              'The addressed participant did not produce a reply.',
          });
          return;
        }
        if (beforeAiMessages.length > 0) {
          llmPrompt += `\n\n[INVITED AI USERS SPOKE BEFORE THE MAIN AGENT]\n${beforeAiMessages.map((message) => `${message.sender_name}: ${message.content}`).join('\n\n')}`;
        }
        const initialBeforePlaybackMessageId = addressedPersonaMessage
          ? undefined
          : beforeAiMessages[beforeAiMessages.length - 1]?.id;
        const initialBeforePlaybackSessionId =
          getLiveModeKind(conversation_id) === 'personas'
            ? getPersonaLiveSession(conversation_id)
            : undefined;
        if (initialBeforePlaybackSessionId && initialBeforePlaybackMessageId) {
          // Playback start opens exactly one server-owned lookahead slot. The
          // main response can prepare while the before-persona is speaking,
          // but remains hidden until the queue releases it.
          await waitForLiveQueueStart(
            conversation_id,
            initialBeforePlaybackMessageId,
          );
        }
        if (!addressedPersonaMessage) {
          if (invitedPersonaOwnsInitialTurn && mainAiUserContext) {
            // The invited first turn is complete. Re-enable the generic stream
            // only now, when its configured main persona actually starts.
            broadcast({
              type: 'chat_started',
              payload: {
                folder: group.folder,
                conversation_id,
                streamKey,
                personaDriven,
                canonicalPersonaTurns: false,
                virtualSender: {
                  id: mainAiUserContext.aiUser.id,
                  name: mainAiUserContext.aiUser.name,
                  identity: mainAiUserContext.aiUser.identity,
                  avatarUrl: mainAiUserContext.aiUser.avatarPath
                    ? `/api/ai-users/${encodeURIComponent(mainAiUserContext.aiUser.id)}/avatar?thumbnail=1&v=${encodeURIComponent(mainAiUserContext.aiUser.updatedAt || mainAiUserContext.aiUser.avatarPath)}`
                    : null,
                },
              },
            });
          }
          const runResult = await runChatAgent(
            group,
            llmPrompt,
            chat_jid,
            (chunk) => {
              if (chunk.type === 'text') {
                const parsed = liveMarkers.push(
                  talkingStickMarkers.push(chunk.content),
                );
                publishLiveStatuses(
                  parsed.statuses,
                  isLlm,
                  mainSpeechProfile,
                  mainLiveStatusSpeaker,
                );
                const streamed = withWorkNarration(
                  parsed.visible,
                  parsed.statuses,
                );
                if (streamed && !shouldDelayMainPersonaText()) {
                  broadcast({
                    type: 'chat_output',
                    payload: {
                      folder: group.folder,
                      content: streamed,
                      conversation_id,
                      streamKey,
                    },
                  });
                }
              } else if (chunk.type === 'background_tasks') {
                broadcast({
                  type: 'chat_background_tasks',
                  payload: {
                    folder: group.folder,
                    conversation_id,
                    streamKey,
                    tasks: chunk.tasks,
                  },
                });
              } else if (chunk.type === 'session' && conversation_id) {
                if (!sessionOverride) {
                  setConversationSessionId(
                    conversation_id,
                    resolvedSessionKey,
                    chunk.session_id,
                  );
                }
                broadcast({
                  type: 'conversations_changed',
                  payload: { folder: group.folder },
                });
              }
            },
            sessionOverride,
            shouldForkSession,
            conversation_id,
            undefined, // The runner resolves the conversation's working directory.
            {
              agentConfig,
              model: agentConfig?.model,
              agent_cmd: agentConfig?.id ?? agent_cmd,
              attachments: agentAttachments ?? undefined,
              skipInitialLog: true,
              disableSteering: personaDriven,
              beforeSteeringComplete:
                isLlm && !personaDriven && ownedDirectDeliveryGate
                  ? () =>
                      closeDirectLlmDeliveryGate(
                        conversation_id,
                        ownedDirectDeliveryGate!,
                      )
                  : undefined,
              onSteeringAbsorbed:
                isLlm && !personaDriven
                  ? (messages) => {
                      for (const message of messages) {
                        const steeringBoundary =
                          getActiveStreamBoundaryForConv(conversation_id);
                        broadcast({
                          type: 'chat_message',
                          payload: {
                            folder: group.folder,
                            message: {
                              ...message,
                              steeringDelivery: 'steered',
                              steeringStreamKey: steeringBoundary?.streamKey,
                            },
                          },
                        });
                      }
                    }
                  : undefined,
              senderUserId: causalTriggeredByUserId,
              triggeredByUserId: causalTriggeredByUserId,
              triggerSource: causalTriggerSource,
              onSlotAcquired: (runId) => {
                causalRunId = runId;
              },
              chat_mode,
              // saveChatMessage above has already persisted this user turn.
              // Direct LLM receives llmPrompt separately, so exclude that final
              // transcript entry from its history to avoid duplicating it.
              excludeTrailingUserHistory: isLlm,
              canonicalUserMessageId: userMsg.id,
              userMessage: content,
              // Work Live Mode narrates only explicit short status markers;
              // Persona Live Mode routes full participant replies through its
              // durable speech queue instead.
              liveMode: workLiveModeRequested,
              personaVoice:
                getLiveModeKind(conversation_id) === 'personas' &&
                !!getPersonaLiveSession(conversation_id),
              reasoning_effort: agentConfig?.reasoning_effort,
              systemPromptSuffix:
                [
                  mainAiUserContext?.systemPromptSuffix,
                  aiCoordinatorInstructions,
                ]
                  .filter(Boolean)
                  .join('\n\n') || undefined,
              participantRoster: aiCoordinatorInstructions ?? null,
              mainPersonaGeneration,
            },
            sharedDeps,
          );
          const selectedEmote = mainAiUserContext
            ? finishPersonaEmoteTurn(
                runResult.result || '',
                mainAiUserContext.emoteNames,
              )
            : {
                content: runResult.result || '',
                speechText: runResult.result || '',
                emote: undefined,
              };
          if (singlePersonaMainTurn) {
            response = stripTalkingStickControl(selectedEmote.content);
            mainAiUserSpeechText = stripTalkingStickControl(
              selectedEmote.speechText,
            );
          } else {
            const talkingStick = parseTalkingStickDecision(
              selectedEmote.content,
            );
            response = talkingStick.content;
            markerOnlyResponse =
              !response &&
              runResult.failed !== true &&
              hasTalkingStickMarker(selectedEmote.content);
            mainAiUserEmote = selectedEmote.emote;
            mainAiUserSpeechText = mainAiUserContext
              ? parseTalkingStickDecision(selectedEmote.speechText).content
              : undefined;
            const explicitTarget = await resolveTalkingStickTarget(
              conversation_id,
              talkingStick.decision,
              mainAiUserContext?.aiUser.id,
            );
            talkingStickDecision =
              explicitTarget.kind === 'main'
                ? { kind: 'pass' }
                : normalizeTalkingStickHandoff(explicitTarget);
          }
          if (singlePersonaMainTurn) mainAiUserEmote = selectedEmote.emote;
          runTelemetry = runResult.telemetry || null;
          runFailed = runResult.failed === true;
          runPending = runResult.pending === true;
          runUuid = runResult.uuid;
          runGeneratedArtifacts = runResult.generatedArtifacts || [];
          flushMarkerTail();
        }
      } catch (err) {
        logger.error(
          { project: req.params.pid, err },
          'Agent/LLM threw an unexpected error',
        );
        response = null;
        runFailed = true;
      }
      flushMarkerTail();
      stoppedByUser =
        stoppedLiveStreamKeys.has(streamKey) ||
        stoppedLiveConversationIds.has(conversation_id);

      // A user stop is a successful interruption, not a missing-response
      // failure. If the agent had not produced visible text yet, the completion
      // event in `finally` returns the conversation to needs_input, but the
      // conversation still reads "working" while the user's message is the
      // newest row, and the periodic stuck-conversation sweep would then record
      // it as a failed "server restart" turn. Leave a stop marker instead.
      if (!response && stoppedByUser) {
        // A Stop that already claimed terminalization (settleStoppedRun) owns
        // the stop row; the finally awaits its completion.
        if (terminalCompletionPromise) return;
        const recent = await getChatMessages(group.folder, 1, conversation_id);
        if (recent[0]?.role === 'user') {
          const stopMsg = await saveChatMessage({
            group_folder: group.folder,
            role: 'assistant',
            content: '⏹ Stopped by user.',
            sender_name: null,
            source: 'web',
            created_at: new Date().toISOString(),
            conversation_id,
            objective_id: objective?.id,
            skipTranscript: false,
          });
          broadcast({
            type: 'chat_message',
            payload: { folder: group.folder, streamKey, message: stopMsg },
          });
        }
        return;
      }

      if (!response && !markerOnlyResponse) {
        logger.warn({ project: req.params.pid }, 'Agent produced no response');
        const errorMsg = await saveChatMessage({
          group_folder: group.folder,
          role: 'assistant',
          content:
            '⚠️ The agent failed to respond. It may be misconfigured or temporarily unavailable.',
          sender_name: null,
          source: 'web',
          created_at: new Date().toISOString(),
          conversation_id: conversation_id,
          objective_id: objective?.id,
          failed: !stoppedByUser,
          pending: false,
        });
        broadcast({
          type: 'chat_message',
          payload: { folder: group.folder, streamKey, message: errorMsg },
        });
        await broadcastTerminalCompletion({
          telemetry: runTelemetry,
          failed: !stoppedByUser,
          pending: false,
          liveState: resolveLiveCompletionState(stoppedByUser, true),
        });
        return;
      }
      if (response === null) return;

      const cleanResponse = stripLiveMarkers(response);
      response = cleanResponse.content;
      publishLiveStatuses(
        cleanResponse.statuses,
        isLlm,
        mainSpeechProfile,
        mainLiveStatusSpeaker,
      );

      // --- Auto-Compaction Logic ---
      // tok_context_last is the per-turn context snapshot (Claude). tok_input
      // is a per-turn proxy for simple direct-LLM chat, but CUMULATIVE session
      // input for Codex (turn.completed reports running totals) — feeding a
      // cumulative 14M into a 256k limit would trip compaction every turn. Only
      // fall back to tok_input when usage is per-turn, signaled by the absence
      // of a cache/reasoning breakdown (only cumulative agents set those).
      const tokInIsCumulative =
        (runTelemetry?.tok_cache_read as number | undefined) != null ||
        (runTelemetry?.tok_reasoning as number | undefined) != null;
      const usageInput =
        (runTelemetry?.tok_context_last as number) ??
        (!tokInIsCumulative
          ? (runTelemetry?.tok_input as number)
          : undefined) ??
        0;
      const contextLimit = (runTelemetry?.context_size as number) || 0;
      const shouldAutoCompact =
        !singlePersonaMainTurn &&
        !isCompact &&
        contextLimit > 0 &&
        usageInput > contextLimit * 0.8;

      if (
        !addressedPersonaMessage &&
        shouldAutoCompact &&
        response &&
        conversation_id
      ) {
        logger.info(
          { project: req.params.pid, usageInput, contextLimit },
          'Auto-compacting conversation due to 80% context usage',
        );
        const compactionPrompt = `[INSTRUCTION: Please summarize our entire conversation so far into a concise "Current Context" block that captures all key decisions, facts, and pending tasks. Output ONLY the summary text, no preamble or conversational filler. Your goal is to be perfectly prepared for a fresh session using ONLY this summary.]`;

        try {
          const compactionResult = await runChatAgent(
            group,
            compactionPrompt,
            chat_jid,
            () => {}, // No streaming needed for background summary
            sessionOverride,
            false,
            conversation_id,
            undefined, // The runner resolves the conversation's working directory.
            {
              agentConfig,
              model: agentConfig?.model,
              agent_cmd: agentConfig?.id ?? agent_cmd,
              skipInitialLog: true,
              chat_mode,
              liveMode: workLiveModeRequested,
              reasoning_effort: agentConfig?.reasoning_effort,
              senderUserId: causalTriggeredByUserId,
              triggeredByUserId: causalTriggeredByUserId,
              triggerSource: causalTriggerSource,
              mainPersonaGeneration,
            },
            sharedDeps,
          );

          if (compactionResult.result) {
            await clearConversationSession(conversation_id, resolvedSessionKey);
            await setConversationRoutedModel(conversation_id, null);
            appendChatTranscriptEntry(group.folder, conversation_id, {
              type: 'compaction_marker',
              content: compactionResult.result,
              created_at: new Date().toISOString(),
            });
            response = `${response}\n\n---\n\n⚠️ **Context Auto-Compacted (80% full)**\n✅ Session cleared and summary generated for next turn.`;
          }
        } catch (err) {
          logger.warn({ err }, 'Auto-compaction background call failed');
        }
      }

      if (
        !addressedPersonaMessage &&
        isCompact &&
        response &&
        conversation_id
      ) {
        await clearConversationSession(conversation_id, resolvedSessionKey);
        await setConversationRoutedModel(conversation_id, null);
        appendChatTranscriptEntry(group.folder, conversation_id, {
          type: 'compaction_marker',
          content: response,
          created_at: new Date().toISOString(),
        });
        // Render as a tool-variant blockquote so MarkdownContent collapses the
        // summary behind a chevron (same UX as long tool results).
        const quoted = response
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n');
        response = `> **Context Compacted** ✅\n${quoted}\n`;
      }

      // Save assistant response and broadcast. Claim this persistence boundary
      // synchronously against Stop so a completion race cannot create both a
      // natural assistant row and a synthetic stop row.
      if (terminalCompletionPromise) return;
      const trustedGeneratedArtifacts = filterTrustedGeneratedArtifacts(
        runGeneratedArtifacts,
        group.folder,
      );
      assistantCommitPromise = addressedPersonaMessage
        ? Promise.resolve(addressedPersonaMessage)
        : saveChatMessage({
            id: runUuid,
            group_folder: group.folder,
            role: 'assistant',
            content: response,
            sender_name: mainAiUserContext?.aiUser.identity ?? null,
            senderUserId: mainAiUserContext
              ? `ai:${mainAiUserContext.aiUser.id}`
              : null,
            source: 'web',
            created_at: new Date().toISOString(),
            conversation_id: conversation_id,
            objective_id: objective?.id,
            telemetry: runTelemetry,
            emote: mainAiUserEmote,
            speechText: mainAiUserSpeechText,
            failed: runFailed && !stoppedByUser,
            pending: runPending && !runFailed && !stoppedByUser,
            attachments:
              !stoppedByUser && trustedGeneratedArtifacts.length > 0
                ? generatedArtifactsToAttachments(trustedGeneratedArtifacts)
                : undefined,
            skipTranscript: true,
          });
      const assistantMsg = await assistantCommitPromise;

      if (!addressedPersonaMessage && mainAiUserContext) {
        appendChatTranscriptEntry(group.folder, conversation_id, {
          id: runUuid,
          type: 'ai_user_attribution',
          role: 'assistant',
          content: '',
          agent_name: `ai-main:${mainAiUserContext.aiUser.id}`,
          sender_name: mainAiUserContext.aiUser.identity,
          senderUserId: `ai:${mainAiUserContext.aiUser.id}`,
          emote: mainAiUserEmote,
          speechText: mainAiUserSpeechText,
          created_at: assistantMsg.created_at,
        });
      }

      const mainLiveModeSessionId =
        getLiveModeKind(conversation_id) === 'personas'
          ? getPersonaLiveSession(conversation_id)
          : undefined;
      const mainSpeakerId =
        mainAiUserContext?.aiUser.id ?? MAIN_AGENT_SPEAKER_ID;
      let publishMainMessage = true;
      if (!addressedPersonaMessage && mainLiveModeSessionId) {
        const queued = await registerLiveQueueMessage({
          conversationId: conversation_id,
          messageId: assistantMsg.id,
          participantId: mainSpeakerId,
        });
        publishMainMessage = queued.isCurrent === true;
      }
      if (!addressedPersonaMessage && publishMainMessage)
        broadcast({
          type: 'chat_message',
          payload: {
            folder: group.folder,
            streamKey,
            liveModeSessionId: mainLiveModeSessionId,
            message: mainAiUserContext
              ? {
                  ...assistantMsg,
                  speechProfile: speechProfileForAiUser(
                    mainAiUserContext.aiUser,
                  ),
                }
              : assistantMsg,
          },
        });
      // Only an active Persona-kind Live session pre-generates audio (a plain
      // main agent speaks under MAIN_AGENT_SPEAKER_ID with the default voice).
      // Outside Live Mode the play button generates it on demand.
      if (!addressedPersonaMessage && mainLiveModeSessionId) {
        void generateAndPublishPersonaSpeech(
          {
            conversationId: conversation_id,
            messageId: assistantMsg.id,
            projectId: group.folder,
            text: mainAiUserSpeechText || assistantMsg.content,
            speakerId: mainSpeakerId,
            voice: mainAiUserContext?.aiUser.voiceId,
            lang: mainAiUserContext?.aiUser.voiceLang,
          },
          Boolean(mainLiveModeSessionId),
        );
      }

      if (singlePersonaMainTurn) {
        await setConversationAgentCmd(conversation_id, resolvedAgentCmd);
        await broadcastTerminalCompletion({
          telemetry: runTelemetry,
          failed: runFailed && !stoppedByUser,
          pending: runPending && !runFailed && !stoppedByUser,
          liveState: resolveLiveCompletionState(stoppedByUser, false),
          completionSummary: 'Agent completed the response.',
        });
        broadcast({
          type: 'conversations_changed',
          payload: { folder: group.folder },
        });
        logger.debug({ project: req.params.pid }, 'Web chat message processed');
        return;
      }

      let activePersonaIds = await listActivePersonaIds(conversation_id);
      const mainPersonaId = mainAiUserContext?.aiUser.id;
      let initialDefaultAgentBoundary = !addressedPersonaMessage;
      const stoppedPersonaIds = new Set(initiallyStoppedPersonaIds);
      let allPersonasStopped = false;
      let mainFollowUpOwed = false;
      const currentActivePersonaIds = () =>
        activePersonaIds.filter((aiUserId) => !stoppedPersonaIds.has(aiUserId));
      const handoffForPersona = (
        aiUserId: string,
      ): import('../modules/ai-users/orchestrator.js').AiUserHandoff =>
        aiUserId === mainPersonaId
          ? { kind: 'main' }
          : { kind: 'select', aiUserId };
      const nextActiveHandoffAfter = (
        aiUserId: string,
      ): import('../modules/ai-users/orchestrator.js').AiUserHandoff => {
        const activeIds = currentActivePersonaIds();
        if (activeIds.length === 0) {
          allPersonasStopped = true;
          return { kind: 'pass' };
        }
        const currentIndex = activePersonaIds.indexOf(aiUserId);
        for (let offset = 1; offset <= activePersonaIds.length; offset++) {
          const candidateIndex =
            currentIndex < 0
              ? offset - 1
              : (currentIndex + offset) % activePersonaIds.length;
          const candidateId = activePersonaIds[candidateIndex];
          if (candidateId && !stoppedPersonaIds.has(candidateId)) {
            return handoffForPersona(candidateId);
          }
        }
        allPersonasStopped = true;
        return { kind: 'pass' };
      };
      const nextDecisionAfter = (
        aiUserId: string,
        markerDecision: import('../modules/ai-users/orchestrator.js').AiUserHandoff,
      ): import('../modules/ai-users/orchestrator.js').AiUserHandoff => {
        if (markerDecision.kind === 'stop') stoppedPersonaIds.add(aiUserId);
        reinstateAddressedPersona(
          stoppedPersonaIds,
          markerDecision,
          mainPersonaId,
          aiUserId,
        );
        const activeIds = currentActivePersonaIds();
        if (activeIds.length === 0) {
          allPersonasStopped = true;
          return { kind: 'pass' };
        }
        if (
          markerDecision.kind === 'main' &&
          mainPersonaId &&
          activeIds.includes(mainPersonaId)
        ) {
          return markerDecision;
        }
        if (
          markerDecision.kind === 'select' &&
          markerDecision.aiUserId &&
          activeIds.includes(markerDecision.aiUserId)
        ) {
          return markerDecision;
        }
        return nextActiveHandoffAfter(aiUserId);
      };
      const initialSpeakerId = addressedPersonaMessage
        ? addressedPersonaMessage.senderUserId.slice('ai:'.length)
        : (mainPersonaId ?? '');
      const handoffAfterInitialSpeaker = nextDecisionAfter(
        initialSpeakerId,
        addressedPersonaHandoff ?? talkingStickDecision,
      );
      // An explicitly addressed invite owns the first response, but the human
      // prompt boundary remains before the main participant. Do not let that
      // invite's autonomous handoff bypass main indefinitely.
      const initialTalkingStickDecision = initialPersonaHandoffAfterHumanPrompt(
        Boolean(addressedPersonaMessage),
        currentActivePersonaIds(),
        mainPersonaId,
        handoffAfterInitialSpeaker,
      );
      const consumedUserMessageIds = new Set<string | number>([userMsg.id]);
      const pendingQueuedUserMessages = async () => {
        // Persona runs deliberately leave steering disabled. Every human turn
        // after the initiating prompt is consumed here at a speaker boundary.
        return (
          await getPendingChatMessages(group.folder, conversation_id, now)
        ).filter((message) => !consumedUserMessageIds.has(message.id));
      };
      type QueuedHumanPrompt = {
        content: string;
        humanName: string;
        triggeredByUserId: string | null;
        triggerSource: 'user' | 'system';
      };
      const takeQueuedUserPrompt = async (): Promise<
        QueuedHumanPrompt | undefined
      > => {
        const pending = await pendingQueuedUserMessages();
        const message = pending[0];
        const messageRecord = message as typeof message & {
          queuedExecutionContent?: unknown;
          sender_name?: unknown;
          triggerSource?: unknown;
          type?: unknown;
        };
        if (!message) return undefined;
        consumedUserMessageIds.add(message.id);
        if (messageRecord.type === 'queued_user_message') {
          const consumption =
            await consumeQueuedChatMessageExactlyOnce(message);
          if (!consumption.won || !consumption.message) return undefined;
          const delivered = consumption.message;
          consumedUserMessageIds.add(delivered.id);
          broadcast({
            type: 'chat_message',
            payload: { folder: group.folder, message: delivered },
          });
        }
        const executionContent = messageRecord.queuedExecutionContent;
        const content =
          typeof executionContent === 'string'
            ? executionContent.trim()
            : message.content.trim();
        if (!content) return undefined;
        const triggeredByUserId =
          typeof message.senderUserId === 'string'
            ? message.senderUserId
            : null;
        const triggerSource =
          messageRecord.triggerSource === 'user' ? 'user' : 'system';
        const humanName =
          typeof messageRecord.sender_name === 'string' &&
          messageRecord.sender_name.trim()
            ? messageRecord.sender_name.trim()
            : 'Human';
        await updateConversation(conversation_id, group.folder, {
          lastTriggeredByUserId: triggeredByUserId,
          lastTriggerSource: triggerSource,
          lastTriggeredAt: new Date().toISOString(),
        });
        return { content, humanName, triggeredByUserId, triggerSource };
      };
      const waitForCurrentPersonaPlayback = async (messageId: string) => {
        if (getLiveModeKind(conversation_id) !== 'personas') return;
        const currentSessionId = getPersonaLiveSession(conversation_id);
        if (!currentSessionId) return;
        await waitForLiveQueueStart(conversation_id, messageId);
      };
      const queuedHumanPromptsForMain: QueuedHumanPrompt[] = [];
      await (
        hasActiveInvitedPersona ? runContinuousAiUserTurns : async () => 'empty'
      )({
        initialContext: formatPersonaConversationTurn(
          addressedPersonaMessage?.sender_name ??
            mainAiUserContext?.aiUser.identity ??
            ASSISTANT_NAME,
          addressedPersonaMessage
            ? 'invited participant'
            : mainAiUserContext
              ? 'main participant'
              : 'main agent',
          response,
        ),
        initialMessageId: assistantMsg.id,
        initialDecision: initialTalkingStickDecision,
        activeParticipantIds: currentActivePersonaIds,
        beforeFinish: async () => {
          // Close admission before looking for the last queued record. Because
          // route handlers and this callback share the JS event loop, a prompt
          // racing this boundary is deterministically server-owned before the
          // delete or browser-owned after it.
          personaBoundaryQueueConsumers.delete(conversation_id);
          // A human Stop ends the run. Queued prompts stay unconsumed and are
          // released by the run's terminal completion; continuing here would
          // spin because shouldStop() never clears.
          if (personaTurnCallbacks.shouldStop()) return false;
          const pending = await pendingQueuedUserMessages();
          if (pending.length === 0) return false;
          stoppedPersonaIds.clear();
          allPersonasStopped = false;
          personaBoundaryQueueConsumers.add(conversation_id);
          return true;
        },
        shouldStop: () =>
          personaTurnCallbacks.shouldStop() || allPersonasStopped,
        waitForPlayback: waitForCurrentPersonaPlayback,
        runRound: async (personaContext, personaDecision) => {
          // Invitations, pauses, and removals made while the preceding speaker
          // was working or playing take effect at this talking-stick boundary.
          activePersonaIds = await listActivePersonaIds(conversation_id);
          const queuedUserTurn =
            personaDecision.kind === 'main' &&
            queuedHumanPromptsForMain.length > 0
              ? undefined
              : await takeQueuedUserPrompt();
          if (queuedUserTurn) {
            causalTriggeredByUserId = queuedUserTurn.triggeredByUserId;
            causalTriggerSource = queuedUserTurn.triggerSource;
            const queuedUserPrompt = queuedUserTurn.content;
            currentHumanPrompt = queuedUserPrompt;
            currentHumanName = queuedUserTurn.humanName;
            initialDefaultAgentBoundary = false;
            // A human message starts a fresh topic and reactivates every
            // persona that withdrew from the previous autonomous discussion.
            stoppedPersonaIds.clear();
            allPersonasStopped = false;
            const queuedMention = await resolveActivePersonaMention(
              conversation_id,
              queuedUserPrompt,
              undefined,
              true,
            );
            if (mainAiUserContext && !queuedMention) {
              const beforeReply = (
                await runAiUserPhase({
                  phase: 'before',
                  group,
                  conversationId: conversation_id,
                  humanPrompt: queuedUserPrompt,
                  humanName: queuedUserTurn.humanName,
                  mainParticipantName,
                  coordinatorResponse:
                    'The human interrupted the autonomous discussion. Respond before the main participant.',
                  deps: sharedDeps,
                  onTurnStopped: (aiUserId) => {
                    nextDecisionAfter(aiUserId, { kind: 'stop' });
                  },
                  onTurnComplete: () => true,
                  ...personaTurnCallbacks,
                })
              )[0];
              if (beforeReply) {
                queuedHumanPromptsForMain.push(queuedUserTurn);
                const beforeSpeakerId = beforeReply.senderUserId.slice(
                  'ai:'.length,
                );
                const beforeMarker = await resolveTalkingStickTarget(
                  conversation_id,
                  beforeReply.talkingStickDecision ?? { kind: 'pass' },
                  beforeSpeakerId,
                );
                const afterBefore = nextDecisionAfter(
                  beforeSpeakerId,
                  beforeMarker,
                );
                return {
                  messages: [beforeReply],
                  resetContext: true,
                  nextDecision:
                    mainPersonaId &&
                    currentActivePersonaIds().includes(mainPersonaId)
                      ? { kind: 'main' }
                      : afterBefore,
                };
              }
            }
            let priorityStoppedAiUserId: string | undefined;
            const queuedForInvitedPersona =
              isExclusiveInvitedPersonaMention(queuedMention);
            const priorityReply =
              mainAiUserContext && !queuedForInvitedPersona
                ? await runMainAiUserFollowUp({
                    group,
                    conversationId: conversation_id,
                    humanPrompt: queuedUserPrompt,
                    humanName: queuedUserTurn.humanName,
                    participantContext:
                      'The human interrupted the autonomous discussion. Answer this new message before giving the talking stick back.',
                    deps: sharedDeps,
                    onTurnStopped: (aiUserId) => {
                      priorityStoppedAiUserId = aiUserId;
                    },
                    ...personaTurnCallbacks,
                  })
                : (
                    await runAiUserPhase({
                      phase: 'any',
                      group,
                      conversationId: conversation_id,
                      humanPrompt: queuedUserPrompt,
                      humanName: queuedUserTurn.humanName,
                      mainParticipantName,
                      coordinatorResponse:
                        'The human interrupted the autonomous discussion. Answer this new message before giving the talking stick back.',
                      decision: queuedForInvitedPersona
                        ? queuedMention
                        : currentActivePersonaIds()[0]
                          ? {
                              kind: 'select',
                              aiUserId: currentActivePersonaIds()[0],
                            }
                          : undefined,
                      deps: sharedDeps,
                      onTurnStopped: (aiUserId) => {
                        priorityStoppedAiUserId = aiUserId;
                      },
                      onTurnComplete: () => true,
                      ...personaTurnCallbacks,
                    })
                  )[0];
            if (!priorityReply) {
              return priorityStoppedAiUserId
                ? {
                    messages: [],
                    nextDecision: nextDecisionAfter(priorityStoppedAiUserId, {
                      kind: 'stop',
                    }),
                    skipped: true,
                  }
                : [];
            }
            const markerHandoff = await resolveTalkingStickTarget(
              conversation_id,
              priorityReply.talkingStickDecision ?? { kind: 'pass' },
              priorityReply.senderUserId.slice('ai:'.length),
            );
            return {
              messages: [priorityReply],
              resetContext: true,
              nextDecision: nextDecisionAfter(
                priorityReply.senderUserId.slice('ai:'.length),
                markerHandoff,
              ),
            };
          }
          // A disabled continuous loop still allows one invited response to a
          // fresh human message. It stops only subsequent autonomous rounds.
          // Check this after queued-user priority so an utterance submitted
          // during the preceding response is never stranded.
          const canAdvance = canAdvancePersonaDiscussion(
            currentActivePersonaIds(),
            mainPersonaId,
            initialDefaultAgentBoundary,
            !disabledContinuousPersonaConversationIds.has(conversation_id),
            mainFollowUpOwed && personaDecision.kind === 'main',
          );
          const initialBoundaryRound = initialDefaultAgentBoundary;
          initialDefaultAgentBoundary = false;
          mainFollowUpOwed = false;
          if (
            !canAdvance &&
            !(
              personaDecision.kind === 'main' &&
              queuedHumanPromptsForMain.length > 0
            )
          ) {
            return [];
          }
          if (personaDecision.kind === 'main') {
            const queuedHumanPromptForMain = queuedHumanPromptsForMain.shift();
            const mainHumanPrompt =
              queuedHumanPromptForMain?.content ?? enrichedContent;
            const isQueuedHumanPriority = !!queuedHumanPromptForMain;
            const queuedMainHumanName =
              queuedHumanPromptForMain?.humanName ?? humanParticipantName;
            if (queuedHumanPromptForMain) {
              causalTriggeredByUserId =
                queuedHumanPromptForMain.triggeredByUserId;
              causalTriggerSource = queuedHumanPromptForMain.triggerSource;
            }
            let mainSkipped = false;
            let mainStopped = false;
            const mainFollowUp = await runMainAiUserFollowUp({
              group,
              conversationId: conversation_id,
              humanPrompt: mainHumanPrompt,
              humanName: queuedMainHumanName,
              participantContext: isQueuedHumanPriority
                ? `A before-priority participant has now answered the human's interruption:\n${personaContext}`
                : personaContext,
              deps: sharedDeps,
              onTurnSkipped: () => {
                mainSkipped = true;
              },
              onTurnStopped: () => {
                mainStopped = true;
              },
              ...personaTurnCallbacks,
            });
            if (!mainFollowUp) {
              if (mainStopped) {
                return {
                  messages: [],
                  nextDecision: nextDecisionAfter(
                    mainAiUserContext!.aiUser.id,
                    { kind: 'stop' },
                  ),
                  skipped: true,
                };
              }
              return mainSkipped
                ? {
                    messages: [],
                    nextDecision: nextDecisionAfter(
                      mainAiUserContext!.aiUser.id,
                      { kind: 'pass' },
                    ),
                    skipped: true,
                    skippedBy: [mainAiUserContext!.aiUser.id],
                  }
                : [];
            }
            const markerHandoff = await resolveTalkingStickTarget(
              conversation_id,
              mainFollowUp.talkingStickDecision ?? { kind: 'pass' },
              mainFollowUp.senderUserId.slice('ai:'.length),
            );
            return {
              messages: [mainFollowUp],
              nextDecision: nextDecisionAfter(
                mainFollowUp.senderUserId.slice('ai:'.length),
                markerHandoff,
              ),
            };
          }
          let markerHandoff:
            | import('../modules/ai-users/orchestrator.js').AiUserHandoff
            | undefined;
          const invitedSkipped = new Set<string>();
          const invitedStopped = new Set<string>();
          const selectedInvitedPersonaId =
            lastInvitedAiUserId ??
            (personaDecision.kind === 'select'
              ? personaDecision.aiUserId
              : undefined);
          const invitedMessages = await runAiUserPhase({
            // A direct name handoff overrides the persona's normal phase for
            // one turn. Autonomous cycles rotate through every active invite;
            // before/after controls only their first response to the human.
            phase: 'any',
            group,
            conversationId: conversation_id,
            humanPrompt: currentHumanPrompt,
            humanName: currentHumanName,
            mainParticipantName,
            coordinatorResponse: personaContext,
            decision: personaDecision,
            startAfterAiUserId: lastInvitedAiUserId,
            deps: sharedDeps,
            onTurnSkipped: (aiUserId) => {
              invitedSkipped.add(aiUserId);
              lastInvitedAiUserId = aiUserId;
            },
            onTurnStopped: (aiUserId) => {
              invitedStopped.add(aiUserId);
              lastInvitedAiUserId = aiUserId;
            },
            onTurnComplete: async (message) => {
              markerHandoff = await resolveTalkingStickTarget(
                conversation_id,
                message.talkingStickDecision ?? { kind: 'pass' },
                message.senderUserId.slice('ai:'.length),
              );
              lastInvitedAiUserId = message.senderUserId.slice('ai:'.length);
              // A round is exactly one speaker. The next turn can generate in
              // the background, but no additional roster members are launched
              // in this same round.
              return true;
            },
            ...personaTurnCallbacks,
          });
          if (
            invitedMessages.length === 0 ||
            personaTurnCallbacks.shouldStop()
          ) {
            if (invitedStopped.size > 0 && !personaTurnCallbacks.shouldStop()) {
              const stoppedAiUserId = [...invitedStopped][
                invitedStopped.size - 1
              ];
              return {
                messages: [],
                nextDecision: nextDecisionAfter(stoppedAiUserId, {
                  kind: 'stop',
                }),
                skipped: true,
              };
            }
            return invitedSkipped.size > 0 && !personaTurnCallbacks.shouldStop()
              ? {
                  messages: [],
                  nextDecision: nextDecisionAfter(lastInvitedAiUserId!, {
                    kind: 'pass',
                  }),
                  skipped: true,
                  skippedBy: [...invitedSkipped],
                }
              : invitedMessages.length === 0 &&
                  !personaTurnCallbacks.shouldStop() &&
                  selectedInvitedPersonaId
                ? {
                    // A failed/empty invited turn should not terminate an
                    // otherwise valid multi-persona rotation. Treat it as a
                    // silent skip so the talking stick advances; the outer
                    // loop still exits safely once every active participant
                    // has skipped in the same cycle.
                    messages: [],
                    nextDecision: nextDecisionAfter(selectedInvitedPersonaId, {
                      kind: 'pass',
                    }),
                    skipped: true,
                    skippedBy: [selectedInvitedPersonaId],
                  }
                : invitedMessages;
          }
          const lastInvitedMessage =
            invitedMessages[invitedMessages.length - 1];
          const afterInvited = nextDecisionAfter(
            lastInvitedMessage.senderUserId.slice('ai:'.length),
            markerHandoff ?? { kind: 'pass' },
          );
          // Main answered the human before this invited reply existed. When
          // it withdrew (stop) or the continuous loop is off, it would never
          // read the reply until the next human turn, so it gets one closing
          // turn here and rejoins the rotation unless it stops again.
          mainFollowUpOwed =
            initialBoundaryRound &&
            !!mainPersonaId &&
            activePersonaIds.includes(mainPersonaId) &&
            (stoppedPersonaIds.has(mainPersonaId) ||
              disabledContinuousPersonaConversationIds.has(conversation_id));
          if (mainFollowUpOwed) stoppedPersonaIds.delete(mainPersonaId!);
          return {
            messages: invitedMessages,
            nextDecision: mainFollowUpOwed ? { kind: 'main' } : afterInvited,
          };
        },
      });
      const consumedPersonaStop = stoppedLiveStreamKeys.delete(streamKey);
      stoppedByUser ||=
        consumedPersonaStop || stoppedLiveConversationIds.has(conversation_id);
      await setConversationAgentCmd(conversation_id, resolvedAgentCmd);
      await broadcastTerminalCompletion({
        telemetry: runTelemetry,
        failed: runFailed && !stoppedByUser,
        pending: runPending && !runFailed && !stoppedByUser,
        liveState: resolveLiveCompletionState(stoppedByUser, false),
        // Do not derive this from assistant prose: live events are a safe
        // metadata channel, not a second transcript transport.
        completionSummary: 'Agent completed the response.',
      });

      // Refresh conversation list to show new session IDs in header
      broadcast({
        type: 'conversations_changed',
        payload: { folder: group.folder },
      });

      logger.debug({ project: req.params.pid }, 'Web chat message processed');
    } finally {
      personaBoundaryQueueConsumers.delete(conversation_id);
      if (chatRunAbortControllers.get(abortKey) === submissionClaim) {
        chatRunAbortControllers.delete(abortKey);
      }
      const terminalizer = conversationRunTerminalizers.get(conversation_id);
      if (terminalizer?.streamKey === streamKey) {
        conversationRunTerminalizers.delete(conversation_id);
      }
      flushMarkerTail();
      if (!hasCompletedBeenBroadcasted) {
        stoppedByUser ||=
          stoppedLiveStreamKeys.delete(streamKey) ||
          stoppedLiveConversationIds.has(conversation_id);
        await broadcastTerminalCompletion({
          telemetry: runTelemetry,
          failed: !stoppedByUser,
          pending: false,
          liveState: resolveLiveCompletionState(stoppedByUser, true),
        });
      }
      directLlmQueueConsumers.delete(conversation_id);
      if (ownedDirectDeliveryGate) {
        await closeDirectLlmDeliveryGate(
          conversation_id,
          ownedDirectDeliveryGate,
        );
        deleteDirectLlmDeliveryGate(conversation_id, ownedDirectDeliveryGate);
      }
      await releaseHumanExecutionLease();
      try {
        if (objective)
          await aggregateRunStats(
            getObjectiveDir(group.folder, objective.id),
            group.folder,
            objective.id,
          );
      } catch (error) {
        logger.error(
          { error, conversation_id, objective_id: objective?.id },
          'Failed to update objective cost after conversation completion',
        );
      }
    }
  })();
}

router.post('/projects/:pid/messages', (req, res) =>
  sendConversationMessage(req, res),
);

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled Tasks (chat-context, linked via group_folder)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/projects/:pid/scheduled-tasks
 * List all scheduled tasks for the project's group folder.
 */
router.get('/projects/:pid/scheduled-tasks', async (req, res) => {
  const [tasks, runningTasks] = await Promise.all([
    getTasksForGroup(req.params.pid),
    getRunningScheduledTaskStatesForGroup(req.params.pid),
  ]);
  res.json(
    tasks.map((task) => scheduledTaskDto(task, runningTasks.get(task.id))),
  );
});

function scheduledTaskDto(
  task: ScheduledTask,
  runningState?: { startedAt: string | null } | null,
) {
  return {
    id: task.id,
    groupFolder: task.group_folder,
    chatJid: task.chat_jid,
    prompt: task.prompt,
    scheduleType: task.schedule_type,
    scheduleValue: task.schedule_value,
    contextMode: task.context_mode ?? 'isolated',
    runtimeSelection: task.runtimeSelection ?? null,
    nextRun: task.next_run,
    lastRun: task.last_run,
    lastResult: task.last_result,
    status: task.status,
    running: !!runningState,
    runningSince: runningState?.startedAt ?? null,
    createdAt: task.created_at,
  };
}

router.get('/projects/:pid/scheduled-tasks/:stid', async (req, res) => {
  const task = await getTaskById(req.params.stid);
  if (!task) return res.status(404).json({ error: 'Scheduled task not found' });
  if (task.group_folder !== req.params.pid)
    return res
      .status(403)
      .json({ error: 'Scheduled task does not belong to this project' });
  const runningState = await getRunningScheduledTaskState(task.id);
  res.json(scheduledTaskDto(task, runningState));
});

/**
 * PATCH /api/projects/:pid/scheduled-tasks/:stid
 * Update a scheduled task (e.g. pause or resume).
 */
router.patch('/projects/:pid/scheduled-tasks/:stid', async (req, res) => {
  const existing = await getTaskById(req.params.stid);
  if (!existing) {
    return res.status(404).json({ error: 'Scheduled task not found' });
  }
  if (existing.group_folder !== req.params.pid) {
    return res
      .status(403)
      .json({ error: 'Scheduled task does not belong to this project' });
  }
  const data: Partial<
    Pick<
      typeof existing,
      | 'status'
      | 'next_run'
      | 'runtimeSelection'
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'context_mode'
    >
  > = {};
  if (
    req.body === null ||
    typeof req.body !== 'object' ||
    Array.isArray(req.body)
  ) {
    return res.status(400).json({ error: 'Request body must be an object' });
  }
  const body = req.body as Record<string, unknown>;
  const currentRunAction = body.currentRunAction;
  if (
    currentRunAction !== undefined &&
    currentRunAction !== 'finish' &&
    currentRunAction !== 'stop'
  ) {
    return res.status(400).json({
      error: 'currentRunAction must be "finish" or "stop"',
    });
  }
  if ('prompt' in body) {
    if (typeof body.prompt !== 'string' || !body.prompt.trim())
      return res.status(400).json({ error: 'prompt must be non-empty' });
    data.prompt = body.prompt;
  }
  const hasScheduleType = Object.prototype.hasOwnProperty.call(
    body,
    'scheduleType',
  );
  const hasScheduleValue = Object.prototype.hasOwnProperty.call(
    body,
    'scheduleValue',
  );
  if (
    hasScheduleType &&
    (typeof body.scheduleType !== 'string' ||
      !['cron', 'interval', 'once'].includes(body.scheduleType))
  ) {
    return res.status(400).json({ error: 'Invalid schedule type' });
  }
  if (hasScheduleValue && typeof body.scheduleValue !== 'string') {
    return res.status(400).json({ error: 'Invalid schedule value' });
  }
  const scheduleType = hasScheduleType
    ? (body.scheduleType as typeof existing.schedule_type)
    : existing.schedule_type;
  const scheduleValue = hasScheduleValue
    ? (body.scheduleValue as string)
    : existing.schedule_value;
  const cadenceChanged =
    (hasScheduleType && scheduleType !== existing.schedule_type) ||
    (hasScheduleValue && scheduleValue !== existing.schedule_value);
  if (cadenceChanged) {
    if (scheduleType === 'cron') {
      try {
        // cron-parser treats an empty string as "* * * * *" (every minute).
        if (!scheduleValue.trim()) throw new Error('Blank cron expression');
        CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE });
      } catch {
        return res.status(400).json({ error: 'Invalid cron expression' });
      }
    } else if (scheduleType === 'interval') {
      try {
        parseIntervalMs(scheduleValue);
      } catch (err) {
        return res.status(400).json({
          error: err instanceof Error ? err.message : 'Invalid interval',
        });
      }
    } else {
      const isoTimestamp =
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
      if (
        !isoTimestamp.test(scheduleValue) ||
        !Number.isFinite(Date.parse(scheduleValue)) ||
        Date.parse(scheduleValue) <= Date.now()
      ) {
        return res.status(400).json({
          error: 'One-time schedule must be a future ISO timestamp',
        });
      }
    }
    data.schedule_type = scheduleType;
    data.schedule_value =
      scheduleType === 'once'
        ? new Date(scheduleValue).toISOString()
        : scheduleValue;
    const candidate = {
      ...existing,
      schedule_type: scheduleType,
      schedule_value: data.schedule_value,
    };
    data.next_run =
      scheduleType === 'once' ? data.schedule_value : calcNextRun(candidate);
    if (existing.status === 'completed') data.status = 'active';
  }
  if ('contextMode' in body) {
    if (body.contextMode !== 'group' && body.contextMode !== 'isolated')
      return res
        .status(400)
        .json({ error: 'contextMode must be "group" or "isolated"' });
    data.context_mode = body.contextMode;
  }
  if ('status' in body) {
    const status = body.status;
    if (status !== 'active' && status !== 'paused') {
      return res
        .status(400)
        .json({ error: 'status must be "active" or "paused"' });
    }
    if (
      status === 'active' &&
      existing.status === 'completed' &&
      !cadenceChanged
    ) {
      return res
        .status(400)
        .json({ error: 'Completed scheduled tasks cannot be reactivated' });
    }
    if (
      status === 'paused' &&
      existing.status === 'completed' &&
      !cadenceChanged
    ) {
      return res
        .status(400)
        .json({ error: 'Completed scheduled tasks cannot be paused' });
    }
    data.status = status;
  }
  // A valid cadence edit is the only supported transition out of completed.
  // It wins over a simultaneous stale paused/active form value so field order
  // cannot leave the newly scheduled task completed or paused.
  if (cadenceChanged && existing.status === 'completed') {
    data.status = 'active';
  }
  if ('runtimeSelection' in body) {
    const runtimeSelection = body.runtimeSelection as RuntimeSelection | null;
    if (
      runtimeSelection !== null &&
      (typeof runtimeSelection !== 'object' ||
        typeof runtimeSelection.harnessId !== 'string' ||
        !runtimeSelection.harnessId.trim() ||
        typeof runtimeSelection.modelId !== 'string' ||
        !runtimeSelection.modelId.trim())
    ) {
      return res.status(400).json({
        error: 'runtimeSelection requires harnessId and modelId strings',
      });
    }
    const runtimeError = validateRuntimeSelection(runtimeSelection);
    if (runtimeError) {
      return res.status(400).json({ error: runtimeError });
    }
    data.runtimeSelection = runtimeSelection;
  }
  if (
    data.status === 'active' &&
    existing.status === 'paused' &&
    scheduleType !== 'once' &&
    !cadenceChanged
  ) {
    const nextRun = calcNextRun(existing);
    if (nextRun === null) {
      return res.status(400).json({ error: 'Invalid recurring schedule' });
    }
    data.next_run = nextRun;
  }
  const runningState = await getRunningScheduledTaskState(existing.id);
  if (runningState) {
    const requestedFields = Object.keys(body).filter(
      (key) => key !== 'currentRunAction',
    );
    const isPauseOnly =
      requestedFields.length === 1 &&
      requestedFields[0] === 'status' &&
      data.status === 'paused';
    if (!isPauseOnly || currentRunAction === undefined) {
      return res.status(409).json({
        error: 'Scheduled task is currently running',
        code: 'scheduled_task_running',
      });
    }

    // Pausing the schedule first prevents completion (or a stop racing with
    // completion) from admitting another occurrence. The current run's
    // finalizer is occurrence-guarded and therefore preserves this status.
    await updateScheduledTask(existing.id, { status: 'paused' });
    if (currentRunAction === 'stop') {
      abortChatAgentWatcher(existing.group_folder, existing.chat_jid);
      if (runningState.run) {
        const interrupted = await gracefullyInterruptRun(runningState.run);
        if (interrupted) await completeActiveRun(runningState.run.id, 'error');
        else await killRun(runningState.run);
      }
    }
  } else if (!(await updateScheduledTaskIfIdle(req.params.stid, data))) {
    return res.status(409).json({
      error: 'Scheduled task is currently running',
      code: 'scheduled_task_running',
    });
  }
  logger.info(
    { scheduled_task_id: req.params.stid, project: req.params.pid },
    'Scheduled task updated',
  );
  res.json(
    scheduledTaskDto(
      (await getTaskById(req.params.stid))!,
      await getRunningScheduledTaskState(req.params.stid),
    ),
  );
});

router.get('/projects/:pid/scheduled-tasks/:stid/runs', async (req, res) => {
  const task = await getTaskById(req.params.stid);
  if (!task) return res.status(404).json({ error: 'Scheduled task not found' });
  if (task.group_folder !== req.params.pid)
    return res
      .status(403)
      .json({ error: 'Scheduled task does not belong to this project' });
  const { logs, pending } = await getScheduledTaskRuns(task.id, 50);
  type ScheduledTaskRunRecord = Awaited<
    ReturnType<typeof getScheduledTaskRuns>
  >['logs'][number];
  type ScheduledTaskRunDto = {
    id: string;
    runId: string | null;
    runAt: string;
    durationMs: number | null;
    status: 'running' | 'finalizing' | 'success' | 'error';
    result: string | null;
    error: string | null;
    model: string | null;
    modelName: string | null;
    tokTotal: number | null;
    costUsd: number | null;
    transcriptAvailable: boolean;
  };
  const rows: ScheduledTaskRunDto[] = logs.map(
    ({ log, run }: ScheduledTaskRunRecord) => ({
      id: String(log.id),
      runId: log.run_id,
      runAt: log.run_at,
      durationMs: log.duration_ms,
      status: log.status,
      result: log.result,
      error: log.error,
      model: run?.model ?? null,
      modelName: run?.model_name ?? null,
      tokTotal: run?.tok_total ?? null,
      costUsd: run?.cost_usd ?? null,
      transcriptAvailable: !!(
        log.run_id &&
        (() => {
          const directory = path.join(
            getGroupDir(task.group_folder),
            'session-transcripts',
          );
          const v1 = archivedCarapaRunV1Paths(directory, log.run_id);
          return fs.existsSync(v1.events) && fs.existsSync(v1.manifest);
        })()
      ),
    }),
  );
  if (pending)
    rows.push({
      id: `pending-${pending.id}`,
      runId: pending.id,
      runAt: pending.started_at,
      durationMs: null,
      status: pending.status === 'running' ? 'running' : 'finalizing',
      result: null,
      error: null,
      model: pending.model,
      modelName: pending.model_name,
      tokTotal: pending.tok_total,
      costUsd: pending.cost_usd,
      transcriptAvailable: false,
    });
  rows.sort((a, b) => Date.parse(b.runAt) - Date.parse(a.runAt));
  res.json(rows.slice(0, 50));
});

router.get(
  '/projects/:pid/scheduled-tasks/:stid/runs/:runId/transcript/v1',
  async (req, res) => {
    const task = await getTaskById(req.params.stid);
    if (!task)
      return res.status(404).json({ error: 'Scheduled task not found' });
    if (task.group_folder !== req.params.pid)
      return res
        .status(403)
        .json({ error: 'Scheduled task does not belong to this project' });
    if (!(await getScheduledTaskRunIds(task.id)).includes(req.params.runId))
      return res.status(404).json({ error: 'Run not found' });
    try {
      const groupDir = getGroupDir(task.group_folder);
      const directory = path.join(groupDir, 'session-transcripts');
      const document = readCarapaRunV1Pair(
        archivedCarapaRunV1Paths(directory, req.params.runId),
        { requireTerminal: true, containedIn: groupDir },
      );
      if (!document)
        return res.status(404).json({ error: 'V1 transcript unavailable' });
      return res.json({
        format: 'carapa-run',
        version: 1,
        manifest: document.manifest,
        events: document.events,
        projection: {
          entries: formatTranscriptEntries(projectCarapaRunV1Entries(document)),
          summary: summarizeCarapaRunV1(document),
        },
      });
    } catch (error) {
      logger.warn(
        { err: String(error), taskId: task.id, runId: req.params.runId },
        'Invalid V1 scheduled-task transcript',
      );
      return res.status(422).json({
        error: 'Invalid V1 transcript',
        detail: 'Transcript could not be read',
      });
    }
  },
);

router.get(
  '/projects/:pid/scheduled-tasks/:stid/runs/:runId/transcript',
  async (req, res) => {
    const task = await getTaskById(req.params.stid);
    if (!task)
      return res.status(404).json({ error: 'Scheduled task not found' });
    if (task.group_folder !== req.params.pid)
      return res
        .status(403)
        .json({ error: 'Scheduled task does not belong to this project' });
    if (!(await getScheduledTaskRunIds(task.id)).includes(req.params.runId))
      return res.status(404).json({ error: 'Run not found' });
    const groupDir = getGroupDir(task.group_folder);
    const directory = path.join(groupDir, 'session-transcripts');
    const promptFile = path.join(directory, `${req.params.runId}.prompt.txt`);
    const v1Paths = archivedCarapaRunV1Paths(directory, req.params.runId);
    if (!fs.existsSync(v1Paths.events) && !fs.existsSync(v1Paths.manifest))
      return res.status(404).json({ error: 'Transcript unavailable' });
    try {
      const document = readCarapaRunV1Pair(v1Paths, {
        requireTerminal: true,
        containedIn: groupDir,
      });
      if (!document) throw new Error('V1 transcript pair disappeared');
      return res.json({
        prompt: await readContainedText(groupDir, promptFile),
        entries: formatTranscriptEntries(projectCarapaRunV1Entries(document)),
        format: 'carapa-run',
        version: 1,
      });
    } catch (error) {
      logger.warn(
        { err: String(error), taskId: task.id, runId: req.params.runId },
        'Invalid V1 scheduled-task transcript',
      );
      return res.status(422).json({
        error: 'Invalid V1 transcript',
        detail: 'Transcript could not be read',
      });
    }
  },
);

/**
 * DELETE /api/projects/:pid/scheduled-tasks/:stid
 * Delete a scheduled task.
 */
router.delete('/projects/:pid/scheduled-tasks/:stid', async (req, res) => {
  const existing = await getTaskById(req.params.stid);
  if (!existing) {
    return res.status(404).json({ error: 'Scheduled task not found' });
  }
  if (existing.group_folder !== req.params.pid) {
    return res
      .status(403)
      .json({ error: 'Scheduled task does not belong to this project' });
  }
  const deleted = await deleteScheduledTaskWithTranscripts(
    req.params.stid,
    existing.group_folder,
  );
  if (!deleted) {
    return res
      .status(409)
      .json({ error: 'Scheduled task is currently running' });
  }
  logger.info(
    { scheduled_task_id: req.params.stid, project: req.params.pid },
    'Scheduled task deleted',
  );
  res.json({ ok: true });
});

/**
 * GET /api/projects/:pid/commands
 * Return available slash commands for a project by querying the sandbox_commands MCP tool.
 * Results are cached for ~60 s.
 * Also scans groups/<folder>/.agent/skills/ and objectives/<objId>/.agent/skills/
 */
router.get('/projects/:pid/commands', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });
  if (req.query.reload) invalidateCommandsCache(req.params.pid);
  const stack = resolveEffectiveSandbox(group).stack;
  const service = resolveEffectiveSandbox(group).service;
  const instance = resolveEffectiveSandbox(group).instance;

  // Determine additional skill directories to scan (group + objective level).
  // Group paths come from getGroupDir so nested layouts and the configured
  // data root are honoured.
  const additionalSkillDirs: string[] = [];
  const projectBase = getGroupDir(req.params.pid);

  // The group folder is agent-writable: probe it through a pinned root so a
  // linked .agent, objectives or skills entry is not reported (and the sandbox
  // tool is never pointed at another project's skills). Paths handed on stay host paths.
  const projectDir = await openGroupDir(req.params.pid).catch(() => null);
  if (projectDir) {
    try {
      const isDir = async (rel: string) =>
        (await lstatAt(projectDir, rel).catch(() => null))?.isDirectory() ===
        true;
      if (await isDir('.agent/skills')) {
        additionalSkillDirs.push(path.join(projectBase, '.agent', 'skills'));
      }

      // Scan objective-level skills within the project
      const objectives = await readdirAt(projectDir, 'objectives', {
        withFileTypes: true,
      }).catch(() => null); // Skip missing or unreadable objectives directory
      for (const entry of objectives ?? []) {
        if (
          entry.isDirectory() &&
          (await isDir(`objectives/${entry.name}/.agent/skills`))
        ) {
          additionalSkillDirs.push(
            path.join(
              projectBase,
              'objectives',
              entry.name,
              '.agent',
              'skills',
            ),
          );
        }
      }
    } finally {
      await projectDir.close();
    }
  }

  // Always scan box-level skills from ~/.agent/skills/
  const homeAgentSkills = path.join('/home/ubuntu', '.agent', 'skills');
  if (fs.existsSync(homeAgentSkills)) additionalSkillDirs.push(homeAgentSkills);

  res.json(
    await getProjectCommands(
      req.params.pid,
      stack,
      service,
      instance,
      additionalSkillDirs,
      { includeDisabled: req.query.includeDisabled === '1' },
    ),
  );
});

async function answerConversationUserInput(req: any, res: Response) {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });
  const conversationId =
    typeof req.body?.conversation_id === 'string'
      ? req.body.conversation_id
      : '';
  const requestId =
    typeof req.body?.requestId === 'string' ? req.body.requestId : '';
  const answers = req.body?.answers;
  const content =
    typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (
    !conversationId ||
    !requestId ||
    !answers ||
    typeof answers !== 'object' ||
    !content
  ) {
    return res.status(400).json({
      error: 'conversation_id, requestId, answers, and content are required',
    });
  }
  const conversation = await getConversation(conversationId);
  if (!conversation || conversation.group_folder !== group.folder) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  if (!(await requireConversationAccess(req, res, conversationId, 'write')))
    return;
  const accepted = await answerChatAgentUserInput(
    group.folder,
    conversationId,
    requestId,
    answers,
  );
  if (accepted) {
    const entry = {
      type: 'codex_user_input',
      request_id: requestId,
      content,
      answers,
      created_at: new Date().toISOString(),
      conversation_id: conversationId,
    };
    appendChatTranscriptEntry(group.folder, conversationId, entry);
    broadcast({
      type: 'chat_message',
      payload: { folder: group.folder, message: entry },
    });
  }
  return res.status(accepted ? 200 : 409).json({ ok: accepted });
}

/** POST /api/projects/:pid/conversations/:cid/background-tasks/:taskId/stop */
router.post(
  '/projects/:pid/conversations/:cid/background-tasks/:taskId/stop',
  async (req, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const conversation = await getConversation(req.params.cid);
    if (!conversation || conversation.group_folder !== group.folder) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (!(await requireConversationAccess(req, res, conversation.id, 'write')))
      return;
    const accepted = await stopChatBackgroundTask(
      group.folder,
      conversation.id,
      req.params.taskId,
    );
    return res.status(accepted ? 200 : 409).json({ ok: accepted });
  },
);

router.post('/projects/:pid/messages/codex-answer', (req, res) =>
  answerConversationUserInput(req, res),
);

/**
 * PUT /api/projects/:pid/conversations/:cid/persona-live-mode
 * Bind or release playback pacing for an already-running persona discussion.
 */
router.post(
  '/projects/:pid/conversations/:cid/messages/:messageId/speech',
  async (req, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    if (!(await requireConversationAccess(req, res, req.params.cid, 'read')))
      return;
    if (!(await loadConversationInProject(req.params.cid, group)))
      return res.status(404).json({ error: 'Conversation not found' });
    const existing = await getReadyMessageSpeechAsset(
      req.params.cid,
      req.params.messageId,
    );
    if (existing) {
      return res.json({
        state: 'ready',
        durationMs: existing.durationMs,
        mimeType: existing.mimeType,
      });
    }
    const source = await resolvePersonaSpeechSource(
      req.params.cid,
      req.params.messageId,
    );
    if (!source || source.projectId !== group.folder)
      return res.status(404).json({ error: 'Speech not found' });
    try {
      const asset = await ensurePersonaMessageSpeech(source);
      if (!asset)
        return res.status(502).json({ error: 'Speech synthesis failed' });
      return res.json({
        state: 'ready',
        durationMs: asset.durationMs,
        mimeType: asset.mimeType,
      });
    } catch (error: any) {
      logger.warn(
        {
          error,
          conversationId: req.params.cid,
          messageId: req.params.messageId,
        },
        'historical persona speech generation failed',
      );
      return res.status(502).json({
        state: 'failed',
        error: error?.message || 'Speech synthesis failed',
      });
    }
  },
);

router.get(
  '/projects/:pid/conversations/:cid/messages/:messageId/speech',
  async (req, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    if (!(await requireConversationAccess(req, res, req.params.cid, 'read')))
      return;
    const conversation = await getConversation(req.params.cid);
    if (!conversation || conversation.group_folder !== group.folder)
      return res.status(404).json({ error: 'Speech not found' });
    const asset = await getReadyMessageSpeechAsset(
      req.params.cid,
      req.params.messageId,
    );
    if (!asset) return res.status(404).json({ error: 'Speech not ready' });
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    await serveTtsAsset(req, res, asset);
  },
);

router.get(
  '/projects/:pid/conversations/:cid/persona-live-mode',
  async (req: any, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const conversation = await getConversation(req.params.cid);
    if (!conversation || conversation.group_folder !== group.folder) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (!(await requireConversationAccess(req, res, req.params.cid, 'read')))
      return;
    const sessionId =
      typeof req.query?.liveModeSessionId === 'string'
        ? req.query.liveModeSessionId.trim().slice(0, 128)
        : '';
    if (
      req.query?.platform === 'android' &&
      req.authUser?.id &&
      req.authDeviceId
    ) {
      registerLiveQueueWatcher(
        req.params.cid,
        req.authUser.id,
        req.authDeviceId,
      );
    }
    const snapshot = await getLiveQueueSnapshot(req.params.cid);
    return res.json({
      enabled: Boolean(snapshot && snapshot.status !== 'off'),
      liveModeKind: snapshot?.mode ?? null,
      ownedBySession: Boolean(
        sessionId && snapshot?.leaderSessionId === sessionId,
      ),
      liveModeSessionId: snapshot?.leaderSessionId ?? null,
      resumePlaybacks: [],
      snapshot,
    });
  },
);

router.delete(
  '/projects/:pid/conversations/:cid/persona-live-mode/watcher',
  async (req: any, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const conversation = await getConversation(req.params.cid);
    if (!conversation || conversation.group_folder !== group.folder) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (!(await requireConversationAccess(req, res, req.params.cid, 'read')))
      return;
    if (req.authDeviceId)
      unregisterLiveQueueWatcher(req.params.cid, req.authDeviceId);
    return res.json({ ok: true });
  },
);

router.put(
  '/projects/:pid/conversations/:cid/persona-live-mode',
  async (req: any, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const conversation = await getConversation(req.params.cid);
    if (!conversation || conversation.group_folder !== group.folder) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (!(await requireConversationAccess(req, res, req.params.cid, 'write')))
      return;
    const sessionId =
      typeof req.body?.liveModeSessionId === 'string'
        ? req.body.liveModeSessionId.trim().slice(0, 128)
        : '';
    if (!sessionId)
      return res.status(400).json({ error: 'liveModeSessionId is required' });
    const enabled = req.body?.enabled === true;
    const liveModeKind: LiveModeKind =
      req.body?.liveModeKind === 'work'
        ? 'work'
        : req.body?.liveModeKind === 'personas'
          ? 'personas'
          : (await resolveEffectiveMainAiUser(req.params.cid, group)) ||
              (await getAiCoordinatorInstructions(req.params.cid))
            ? 'personas'
            : 'work';
    const currentSessionId = getPersonaLiveSession(req.params.cid);
    const previousOwner = getPersonaLiveOwner(req.params.cid);
    let snapshot = await getLiveQueueSnapshot(req.params.cid);
    if (enabled) {
      const platform =
        req.body?.platform === 'android' || req.body?.platform === 'ios'
          ? req.body.platform
          : 'web';
      setPersonaLiveSession(req.params.cid, sessionId, {
        mode: liveModeKind,
        userId: req.authUser?.id,
        deviceId: req.authDeviceId,
        platform,
      });
      snapshot = await enableLiveQueue(req.params.cid, {
        sessionId,
        mode: liveModeKind,
        userId: req.authUser?.id,
        deviceId: req.authDeviceId,
        platform,
        deviceSpeech: platform === 'android' && req.body?.deviceSpeech === true,
      });
    } else {
      await stopLiveQueue(req.params.cid);
      snapshot = await getLiveQueueSnapshot(req.params.cid);
      if (snapshot?.status !== 'stopping')
        setPersonaLiveSession(req.params.cid, null);
      if (
        snapshot?.status !== 'stopping' &&
        currentSessionId &&
        previousOwner?.platform === 'android' &&
        previousOwner.userId &&
        previousOwner.deviceId
      ) {
        void getPushTokensForUser(previousOwner.userId)
          .then((tokens) =>
            sendPing(
              tokens.filter(
                (token) => token.device_id === previousOwner.deviceId,
              ),
              currentSessionId,
              'live_tts_stop',
              { user_id: previousOwner.userId },
            ),
          )
          .catch(() => undefined);
      }
    }
    publishPublicConversationEvent(req.params.cid, {
      type: 'liveMode',
      enabled: Boolean(getPersonaLiveSession(req.params.cid)),
    });
    broadcast({
      type: 'persona_live_mode',
      payload: {
        folder: group.folder,
        conversation_id: req.params.cid,
        enabled: Boolean(getPersonaLiveSession(req.params.cid)),
        liveModeKind: snapshot?.mode ?? liveModeKind,
        liveModeSessionId: getPersonaLiveSession(req.params.cid) ?? null,
      },
    });
    return res.json({
      ok: true,
      enabled: Boolean(snapshot && snapshot.status !== 'off'),
      liveModeKind: snapshot?.mode ?? liveModeKind,
      liveModeSessionId: snapshot?.leaderSessionId ?? null,
      resumePlaybacks: [],
      snapshot,
    });
  },
);

router.post(
  '/projects/:pid/conversations/:cid/persona-live-mode/heartbeat',
  async (req: any, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const conversation = await getConversation(req.params.cid);
    if (!conversation || conversation.group_folder !== group.folder) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (!(await requireConversationAccess(req, res, req.params.cid, 'read')))
      return;
    const sessionId =
      typeof req.body?.liveModeSessionId === 'string'
        ? req.body.liveModeSessionId.trim().slice(0, 128)
        : '';
    if (!sessionId)
      return res.status(400).json({ error: 'liveModeSessionId is required' });
    const platform =
      req.body?.platform === 'android' || req.body?.platform === 'ios'
        ? req.body.platform
        : 'web';
    if (platform === 'android' && req.authUser?.id && req.authDeviceId) {
      registerLiveQueueWatcher(
        req.params.cid,
        req.authUser.id,
        req.authDeviceId,
      );
    }
    const snapshot = await renewLiveLease(req.params.cid, sessionId, {
      userId: req.authUser?.id,
      deviceId: req.authDeviceId,
      platform,
      deviceSpeech: platform === 'android' && req.body?.deviceSpeech === true,
    });
    return snapshot
      ? res.json({ ok: true, snapshot })
      : res.status(409).json({ error: 'Stale Live Mode lease' });
  },
);

router.post(
  '/projects/:pid/conversations/:cid/persona-live-mode/items/:itemId/started',
  async (req: any, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const conversation = await getConversation(req.params.cid);
    if (!conversation || conversation.group_folder !== group.folder) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (!(await requireConversationAccess(req, res, req.params.cid, 'read')))
      return;
    const sessionId =
      typeof req.body?.liveModeSessionId === 'string'
        ? req.body.liveModeSessionId.trim().slice(0, 128)
        : '';
    const runId = typeof req.body?.runId === 'string' ? req.body.runId : '';
    const snapshot = await startLiveQueueItem({
      conversationId: req.params.cid,
      itemId: req.params.itemId,
      runId,
      sessionId,
      userId: req.authUser?.id,
      deviceId: req.authDeviceId,
    });
    return snapshot
      ? res.json({ ok: true, snapshot })
      : res.status(409).json({ error: 'Stale or unreleased Live Mode item' });
  },
);

router.patch(
  '/projects/:pid/conversations/:cid/persona-loop',
  async (req: any, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    if (!(await requireConversationAccess(req, res, req.params.cid, 'write')))
      return;
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const conversation = await getConversation(req.params.cid);
    if (!conversation || conversation.group_folder !== group.folder) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    await setConversationContinuousPersonaLoop(
      conversation.id,
      req.body.enabled,
    );
    if (req.body.enabled)
      disabledContinuousPersonaConversationIds.delete(conversation.id);
    else disabledContinuousPersonaConversationIds.add(conversation.id);
    broadcast({
      type: 'conversations_changed',
      payload: { folder: group.folder },
    });
    return res.json({ enabled: req.body.enabled });
  },
);

router.post(
  '/projects/:pid/conversations/:cid/persona-round',
  async (req: any, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    if (!(await requireConversationAccess(req, res, req.params.cid, 'write')))
      return;
    const conversation = await getConversation(req.params.cid);
    if (!conversation || conversation.group_folder !== group.folder) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    // A manual round is also the explicit resume action after Stop. The abort
    // controller from the stopped run can outlive its completion event briefly;
    // do not let that stale controller make Start next round a permanent 409.
    const wasStopped = stoppedLiveConversationIds.has(conversation.id);
    if (
      (getActiveStreamKeyForConv(conversation.id) && !wasStopped) ||
      (chatRunAbortControllers.has(
        chatAbortKey(group.folder, conversation.id, `${group.folder}@web`),
      ) &&
        !wasStopped)
    ) {
      return res
        .status(409)
        .json({ error: 'A conversation run is already active' });
    }
    const memberships = await listConversationAiUserRows(conversation.id);
    const effectiveMain = await resolveEffectiveMainAiUser(
      conversation.id,
      group,
    );
    const activeInvited = memberships.filter(
      ({ aiUser, membership }) =>
        aiUser.enabled === 1 &&
        membership.status === 'active' &&
        aiUser.id !== effectiveMain?.id,
    );
    if (activeInvited.length === 0) {
      return res
        .status(400)
        .json({ error: 'At least one active invited persona is required' });
    }
    const requestedRuntime = req.body?.runtimeSelection as
      | RuntimeSelection
      | undefined;
    const runtimeError = validateRuntimeSelection(requestedRuntime);
    if (runtimeError)
      return res
        .status(400)
        .json({ error: `runtimeSelection: ${runtimeError}` });
    if (requestedRuntime)
      await setConversationRuntimeSelection(conversation.id, requestedRuntime);

    const activePersonaIds = await listActivePersonaIds(conversation.id);
    const recent = await getChatMessages(group.folder, 24, conversation.id);
    // Resume is a phase boundary, not a continuation from whichever persona
    // happened to speak last. Always restart the documented round order:
    // before personas, main participant, then after personas.
    const activePersonaRows = [...activeInvited].sort(
      (left, right) =>
        activePersonaIds.indexOf(left.aiUser.id) -
        activePersonaIds.indexOf(right.aiUser.id),
    );
    const firstResumeSpeaker =
      activePersonaRows.find(({ aiUser }) => aiUser.turn === 'before')?.aiUser
        .id ??
      effectiveMain?.id ??
      activePersonaRows.find(({ aiUser }) => aiUser.turn === 'after')?.aiUser
        .id;
    const nextPersonaId = firstResumeSpeaker;
    if (!nextPersonaId)
      return res.status(400).json({ error: 'No active persona is available' });

    const latestHumanMessage = recent.find(
      (message) => message.role === 'user',
    );
    const latestHumanUserId =
      typeof latestHumanMessage?.senderUserId === 'string' &&
      latestHumanMessage.senderUserId.length > 0 &&
      !latestHumanMessage.senderUserId.startsWith('ai:')
        ? latestHumanMessage.senderUserId
        : req.authUser?.id;
    const latestHumanUser = latestHumanUserId
      ? await getUserById(latestHumanUserId)
      : null;
    const humanName =
      (typeof latestHumanUser?.displayName === 'string' &&
        latestHumanUser.displayName.trim()) ||
      (typeof latestHumanUser?.username === 'string' &&
        latestHumanUser.username.trim()) ||
      (latestHumanUserId === req.authUser?.id &&
        typeof req.authUser?.displayName === 'string' &&
        req.authUser.displayName.trim()) ||
      (latestHumanUserId === req.authUser?.id &&
        typeof req.authUser?.username === 'string' &&
        req.authUser.username.trim()) ||
      'Human';
    const lastHumanPrompt =
      latestHumanMessage?.content ?? 'Continue the current discussion.';
    const participantContext = [...recent]
      .reverse()
      .filter(
        (message) => message.role === 'assistant' && message.content.trim(),
      )
      .slice(-8)
      .map((message) =>
        formatPersonaConversationTurn(
          message.sender_name || ASSISTANT_NAME,
          message.senderUserId ===
            (effectiveMain ? `ai:${effectiveMain.id}` : '')
            ? 'main participant'
            : message.senderUserId?.startsWith('ai:')
              ? 'invited participant'
              : 'main agent',
          message.content,
        ),
      )
      .join('\n\n');
    const streamKey = randomUUID();
    const personaLeaseId = `persona:${streamKey}`;
    const personaExecutionLease = await acquireConversationExecutionLease(
      conversation.id,
      personaLeaseId,
    );
    if (!personaExecutionLease)
      return res
        .status(409)
        .json({ error: 'A conversation run is already active' });
    const stopPersonaLeaseHeartbeat = startConversationExecutionLeaseHeartbeat(
      conversation.id,
      personaLeaseId,
    );
    const personaAbortKey = chatAbortKey(
      group.folder,
      conversation.id,
      `${group.folder}@web`,
    );
    if (wasStopped) chatRunAbortControllers.delete(personaAbortKey);
    const personaReservation = new AbortController();
    if (!tryClaimChatRunAbortController(personaAbortKey, personaReservation)) {
      stopPersonaLeaseHeartbeat();
      await releaseConversationExecutionLease(conversation.id, personaLeaseId);
      return res
        .status(409)
        .json({ error: 'A conversation run is already active' });
    }
    let personaOwnershipReleased = false;
    const releasePersonaOwnership = async () => {
      if (personaOwnershipReleased) return;
      personaOwnershipReleased = true;
      chatRunAbortControllers.delete(personaAbortKey);
      stopPersonaLeaseHeartbeat();
      await releaseConversationExecutionLease(conversation.id, personaLeaseId);
    };
    stoppedLiveConversationIds.delete(conversation.id);
    stoppedLiveStreamKeys.delete(streamKey);
    broadcast({
      type: 'chat_started',
      payload: {
        folder: group.folder,
        conversation_id: conversation.id,
        streamKey,
        personaDriven: true,
        canonicalPersonaTurns: true,
        liveTitle: conversation.title ?? undefined,
        livePreview: conversation.preview ?? undefined,
      },
    });
    res.status(202).json({
      ok: true,
      conversationId: conversation.id,
      participantId: nextPersonaId,
    });

    void (async () => {
      const turnMessages = new Map<
        string,
        import('../modules/ai-users/orchestrator.js').AiUserTurnMessage
      >();
      const callbacks = {
        triggeredByUserId: latestHumanUserId ?? null,
        triggerSource: 'user' as const,
        get personaVoice() {
          return (
            getLiveModeKind(conversation.id) === 'personas' &&
            !!getPersonaLiveSession(conversation.id)
          );
        },
        shouldStop: () =>
          stoppedLiveStreamKeys.has(streamKey) ||
          stoppedLiveConversationIds.has(conversation.id),
        onTurnStarted: (
          message: import('../modules/ai-users/orchestrator.js').AiUserTurnMessage,
        ) => {
          // The generic chat stream is disabled for manual rounds. Announce the
          // actual speaker instead so the pending bubble has the right identity
          // and is replaced by that speaker's canonical message on completion.
          turnMessages.set(message.id, message);
          const liveModeSessionId =
            getLiveModeKind(conversation.id) === 'personas'
              ? getPersonaLiveSession(conversation.id)
              : undefined;
          broadcast({
            type: 'chat_persona_started',
            payload: {
              folder: group.folder,
              conversation_id: conversation.id,
              liveModeSessionId,
              voiceDelayed: Boolean(liveModeSessionId),
              hiddenUntilPlayback: Boolean(liveModeSessionId),
              message: { ...message, agent_name: message.senderUserId },
            },
          });
        },
        onTurnChunk: (messageId: string, content: string) => {
          if (!content) return;
          const message = turnMessages.get(messageId);
          const liveModeSessionId =
            getLiveModeKind(conversation.id) === 'personas'
              ? getPersonaLiveSession(conversation.id)
              : undefined;
          broadcast({
            type: 'chat_persona_output',
            payload: {
              folder: group.folder,
              conversation_id: conversation.id,
              liveModeSessionId,
              voiceDelayed: Boolean(liveModeSessionId),
              messageId,
              content,
              agent_name: message?.senderUserId,
              sender_name: message?.sender_name,
              senderUserId: message?.senderUserId,
              created_at: message?.created_at,
            },
          });
        },
        onTurnFinished: (
          messageId: string,
          failed: boolean,
          skipped?: boolean,
          message?: import('../modules/ai-users/orchestrator.js').AiUserTurnMessage,
        ) => {
          if (message && !getPersonaLiveSession(conversation.id)) {
            broadcast({
              type: 'chat_message',
              payload: { folder: group.folder, message },
            });
          }
          turnMessages.delete(messageId);
          broadcast({
            type: 'chat_persona_finished',
            payload: {
              folder: group.folder,
              conversation_id: conversation.id,
              messageId,
              failed,
              skipped,
              telemetry: message?.telemetry,
              message,
            },
          });
        },
        onMessage: (
          message: import('../modules/ai-users/orchestrator.js').AiUserTurnMessage,
        ) => {
          const liveModeSessionId =
            getLiveModeKind(conversation.id) === 'personas'
              ? getPersonaLiveSession(conversation.id)
              : undefined;
          void (async () => {
            let publishMessage = true;
            if (liveModeSessionId) {
              const queued = await registerLiveQueueMessage({
                conversationId: conversation.id,
                messageId: message.id,
                participantId: message.senderUserId.slice('ai:'.length),
              });
              publishMessage = queued.isCurrent === true;
            }
            if (publishMessage)
              broadcast({
                type: 'chat_message',
                payload: { folder: group.folder, liveModeSessionId, message },
              });
            if (!liveModeSessionId) return;
            await generateAndPublishPersonaSpeech(
              {
                conversationId: conversation.id,
                messageId: message.id,
                projectId: group.folder,
                text: message.speechText || message.content,
                speakerId: message.senderUserId.slice('ai:'.length),
                voice: message.speechProfile?.voiceId,
                lang: message.speechProfile?.language,
              },
              Boolean(liveModeSessionId),
            );
          })();
        },
      };
      try {
        // Resume always executes complete, deterministic phases. Talking-stick
        // markers are useful during a normal live run, but must not reorder a
        // resumed round: before -> main -> after, then repeat from before.
        let phaseContext =
          participantContext ||
          'Continue from the latest conversation context.';
        const appendMessages = (
          context: string,
          messages: import('../modules/ai-users/orchestrator.js').AiUserTurnMessage[],
        ) =>
          messages.length > 0
            ? [
                context,
                ...messages.map((message) =>
                  formatPersonaConversationTurn(
                    message.sender_name,
                    effectiveMain?.id ===
                      message.senderUserId.slice('ai:'.length)
                      ? 'main participant'
                      : 'invited participant',
                    message.content,
                  ),
                ),
              ]
                .filter(Boolean)
                .join('\n\n')
            : context;
        const waitForPersonaPlayback = async (messageId: string) => {
          if (getLiveModeKind(conversation.id) !== 'personas') return;
          if (!getPersonaLiveSession(conversation.id)) return;
          await waitForLiveQueueStart(conversation.id, messageId);
        };
        do {
          if (callbacks.shouldStop()) break;
          const beforeMessages = await runAiUserPhase({
            phase: 'before',
            group,
            conversationId: conversation.id,
            humanPrompt: lastHumanPrompt,
            humanName,
            mainParticipantName: effectiveMain?.identity ?? ASSISTANT_NAME,
            coordinatorResponse: phaseContext,
            deps: sharedDeps,
            onTurnComplete: async (message) => {
              await waitForPersonaPlayback(message.id);
              return false;
            },
            ...callbacks,
          });
          let cycleContext = appendMessages(phaseContext, beforeMessages);
          let cycleProducedMessage = beforeMessages.length > 0;

          if (effectiveMain && !callbacks.shouldStop()) {
            const mainMessage = await runMainAiUserFollowUp({
              group,
              conversationId: conversation.id,
              humanPrompt: lastHumanPrompt,
              humanName,
              participantContext: cycleContext,
              deps: sharedDeps,
              ...callbacks,
            });
            if (mainMessage) {
              cycleContext = appendMessages(cycleContext, [mainMessage]);
              cycleProducedMessage = true;
              await waitForPersonaPlayback(mainMessage.id);
            }
          }

          if (!callbacks.shouldStop()) {
            const afterMessages = await runAiUserPhase({
              phase: 'after',
              group,
              conversationId: conversation.id,
              humanPrompt: lastHumanPrompt,
              humanName,
              mainParticipantName: effectiveMain?.identity ?? ASSISTANT_NAME,
              coordinatorResponse: cycleContext,
              deps: sharedDeps,
              onTurnComplete: async (message) => {
                await waitForPersonaPlayback(message.id);
                return false;
              },
              ...callbacks,
            });
            cycleContext = appendMessages(cycleContext, afterMessages);
            cycleProducedMessage ||= afterMessages.length > 0;
          }
          phaseContext = cycleContext;
          if (!cycleProducedMessage) break;
        } while (
          conversation.continuousPersonaLoop !== false &&
          !disabledContinuousPersonaConversationIds.has(conversation.id) &&
          !callbacks.shouldStop()
        );
        await releasePersonaOwnership();
        broadcast({
          type: 'chat_completed',
          payload: {
            folder: group.folder,
            conversation_id: conversation.id,
            streamKey,
            liveState: 'needs_input',
            completionSummary: 'Persona round completed.',
          },
        });
        await notifyEntityLifecycle({
          group_folder: group.folder,
          conversation_id: conversation.id,
          run_id: streamKey,
          event: 'needs_input',
          title: 'Conversation needs input',
        });
      } catch (error) {
        logger.warn(
          { error, conversationId: conversation.id },
          'Manual persona round failed',
        );
        await releasePersonaOwnership();
        broadcast({
          type: 'chat_completed',
          payload: {
            folder: group.folder,
            conversation_id: conversation.id,
            streamKey,
            liveState: 'error',
            completionSummary:
              error instanceof Error ? error.message : 'Persona round failed.',
          },
        });
        await notifyEntityLifecycle({
          group_folder: group.folder,
          conversation_id: conversation.id,
          run_id: streamKey,
          event: 'failed',
          title: 'Conversation failed',
        });
      } finally {
        await releasePersonaOwnership();
      }
    })();
  },
);

/**
 * POST /api/projects/:pid/messages/stop
 * Stop the currently running web chat agent for this project.
 */
router.post('/projects/:pid/messages/stop', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });

  const chat_jid = `${group.folder}@web`;
  const conversation_id = req.body?.conversation_id as string | undefined;
  let stopStreamKey: string | undefined;

  // The run registries below are global and keyed by conversation id alone, so
  // scope and authorize the target before touching any of them.
  if (conversation_id) {
    const target = await getConversation(conversation_id);
    if (!target || target.group_folder !== group.folder)
      return res.status(404).json({ error: 'Conversation not found' });
    if (!(await requireConversationAccess(req, res, conversation_id, 'write')))
      return;
  } else if (!(req as any).authUser && (req as any).tokenScope) {
    if (!requireSignedInUser(req, res)) return;
  } else if (
    (req as any).authUser &&
    !adminBypassesProject((req as any).authUser, group.folder)
  ) {
    // Project-level stop aborts the project's shared chat run, so it needs the
    // same explicit non-viewer membership as creating a conversation.
    const access = (req as any).projectAccess;
    if (!explicitLevelAtLeast(access, 'editor'))
      return res
        .status(403)
        .json({ error: 'Cannot stop runs in this project' });
  }

  try {
    const wasAlreadyStopped = conversation_id
      ? stoppedLiveConversationIds.has(conversation_id)
      : false;
    // Capture the run-owned settlement closure before aborting. The provider
    // promise may reject and remove its registry entry while kill orchestration
    // awaits durable active-run cleanup.
    const terminalizer = conversation_id
      ? conversationRunTerminalizers.get(conversation_id)
      : undefined;
    // Record the specific active stream before aborting it. The run completion
    // path consumes this token; response text is never used to classify stops.
    stopStreamKey = conversation_id
      ? getActiveStreamKeyForConv(conversation_id)
      : undefined;
    if (stopStreamKey) stoppedLiveStreamKeys.add(stopStreamKey);
    if (conversation_id) stoppedLiveConversationIds.add(conversation_id);
    // Make Stop observable to persona loops before any asynchronous cleanup.
    // Waiting for the Live queue first left a window where an active persona
    // could continue and made a second click appear necessary.
    if (conversation_id) await stopLiveQueue(conversation_id);
    const stoppedClaimedFollowup = conversation_id
      ? await stopClaimedDirectFollowups(group.folder, conversation_id)
      : false;
    let stopped = false;
    if (
      terminalizer &&
      (!stopStreamKey || terminalizer.streamKey === stopStreamKey)
    ) {
      // Settle and release the durable Direct admission before aborting the
      // provider. Otherwise the abort can advance the steering loop just far
      // enough to absorb a message that Stop is responsible for reconciling.
      await terminalizer.stop();
      stopped = true;
    }
    stopped =
      (await killChatAgentProcess(group.folder, chat_jid, conversation_id)) ||
      stopped;
    if (stoppedClaimedFollowup) stopped = true;
    if (wasAlreadyStopped && !stopped) {
      // Retrying a completed Stop is an idempotent acknowledgement, not an
      // orphan lifecycle that should publish a second chat_completed event.
      stopped = true;
    }

    // Direct-LLM persona turns can be between provider requests when Stop is
    // clicked. The active outer stream is still authoritative even when there
    // is no process to kill at this instant; its stop predicate will observe
    // the conversation-scoped signal at the next speaker boundary.
    if (!stopped && stopStreamKey) stopped = true;

    // No live abort controller / sandbox process — but the UI may still show
    // "running" (chat_started without a registered run, or desync after restart).
    // Force-clear DB rows and emit chat_completed so the client can recover.
    if ((!stopped || stoppedClaimedFollowup) && conversation_id) {
      const orphanRuns = await getActiveChatRunsForConversation(
        group.folder,
        conversation_id,
      );
      for (const run of orphanRuns) {
        await completeActiveRun(run.id, 'error');
      }

      const conv = await getConversation(conversation_id);
      const objective_id = conv?.objective_id ?? undefined;

      // If the last saved message is from the user, write a stop marker so the
      // conversation leaves "working" status (last user > last assistant).
      const recent = await getChatMessages(group.folder, 1, conversation_id);
      const last = recent[0];
      if (last?.role === 'user') {
        const stopMsg = await saveChatMessage({
          group_folder: group.folder,
          role: 'assistant',
          content: '⏹ Stopped — no agent was running for this message.',
          sender_name: null,
          source: 'web',
          created_at: new Date().toISOString(),
          conversation_id,
          skipTranscript: true,
        });
        broadcast({
          type: 'chat_message',
          payload: { folder: group.folder, message: stopMsg },
        });
      }

      await closeActiveDirectLlmDeliveryGate(conversation_id);
      const releasedQueuedMessageIds =
        await releaseUnconsumedQueuedChatMessages(
          group.folder,
          conversation_id,
        );
      const consumedQueuedMessageIds = getQueuedChatMessageStates(
        group.folder,
        conversation_id,
      ).consumed;

      broadcast({
        type: 'chat_completed',
        payload: {
          ...chatEventScope(group.folder, objective_id),
          conversation_id,
          liveState: 'needs_input',
          completionSummary: 'Stopped by user.',
          releasedQueuedMessageIds,
          consumedQueuedMessageIds,
        },
      });
      await notifyEntityLifecycle({
        group_folder: group.folder,
        conversation_id,
        run_id: orphanRuns[0]?.id ?? randomUUID(),
        event: 'needs_input',
        title: 'Conversation needs input',
      });
      stopped = true;
    }

    res.json({ ok: true, stopped });
    if (stopped && conversation_id) {
      const activity = upsertLiveActivity({
        folder: group.folder,
        conversation_id,
        state: 'needs_input',
        status: null,
        completion_summary: 'Stopped by user.',
      });
      broadcast({ type: 'live_activity', payload: activity });
    }
  } catch (err) {
    logger.error(
      { project: req.params.pid, err },
      'Failed to stop web chat agent',
    );
    res.status(500).json({ error: 'Failed to stop web chat agent' });
  }
});

export default router;
