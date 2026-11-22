/**
 * Move the chats of an objective, with their transcripts, to the project the
 * objective now belongs to. Used by `moveObjective` for the move itself and for
 * the backfill of chats an earlier move left behind. Safe to repeat: it only
 * looks at chats still outside the target project.
 */

import path from 'path';

import {
  chatArchiveLowerBound,
  chatArchiveMemberNames,
  chatTranscriptPath,
  getGroupDir,
} from '../../group-dir.js';
import { lstatGroupPathSync } from '../../lib/group-fs.js';
import { logger } from '../../logger.js';
import { restoreFromArchiveIfMissingAsync } from '../transcripts/archive-restore.js';
import { moveTranscriptSync } from '../transcripts/transcript-append-service.js';
import {
  getObjectiveConversationsOutside,
  moveConversationToProject,
  type ObjectiveConversationRef,
} from './db-objectives.js';

export interface ConversationMoveReport {
  movedConversations: number;
  /** Chats whose transcript was missing or could not be moved (still moved). */
  skippedTranscripts: number;
  /** False when a chat could not be listed or re-homed; repeat the move. */
  conversationStepComplete: boolean;
}

function hasContent(file: string): boolean {
  try {
    return (lstatGroupPathSync(file)?.size ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Bring the live transcript (and its index sidecar) into the target project,
 * or restore the archived copy there. The source bundles stay untouched. A
 * transcript already in the target wins and is never overwritten. Returns
 * false when the chat has no transcript anywhere.
 */
async function moveTranscript(
  conversation: ObjectiveConversationRef,
  targetProject: string,
): Promise<boolean> {
  const { id, group_folder, created_at } = conversation;
  const source = chatTranscriptPath(group_folder, undefined, id);
  const target = chatTranscriptPath(targetProject, undefined, id);
  if (hasContent(target)) return true;
  if (hasContent(source)) {
    moveTranscriptSync(source, target);
    if (!hasContent(target)) {
      throw new Error(`transcript did not arrive at ${target}`);
    }
    return true;
  }
  return restoreFromArchiveIfMissingAsync(
    path.join(getGroupDir(group_folder), 'transcripts', 'archive'),
    target,
    chatArchiveMemberNames(id),
    chatArchiveLowerBound(id, created_at),
  );
}

export async function moveObjectiveConversations(
  objectiveId: string,
  targetProject: string,
): Promise<ConversationMoveReport> {
  const report: ConversationMoveReport = {
    movedConversations: 0,
    skippedTranscripts: 0,
    conversationStepComplete: true,
  };
  let leftovers: ObjectiveConversationRef[];
  try {
    leftovers = await getObjectiveConversationsOutside(
      objectiveId,
      targetProject,
    );
  } catch (err) {
    logger.error(
      { err, objective_id: objectiveId, targetProject },
      'Objective moved, but its conversations could not be listed',
    );
    return { ...report, conversationStepComplete: false };
  }
  for (const conversation of leftovers) {
    const log = {
      objective_id: objectiveId,
      conversation_id: conversation.id,
      from: conversation.group_folder,
      targetProject,
    };
    try {
      if (!(await moveTranscript(conversation, targetProject))) {
        report.skippedTranscripts++;
        logger.warn(log, 'Conversation has no transcript to move');
      }
    } catch (err) {
      report.skippedTranscripts++;
      logger.warn({ err, ...log }, 'Conversation transcript was not moved');
    }
    try {
      await moveConversationToProject(
        conversation.id,
        conversation.group_folder,
        targetProject,
      );
      report.movedConversations++;
    } catch (err) {
      report.conversationStepComplete = false;
      logger.error({ err, ...log }, 'Conversation could not be moved');
    }
  }
  return report;
}
