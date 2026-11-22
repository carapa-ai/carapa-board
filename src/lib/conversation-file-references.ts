import {
  chatTranscriptStatKey,
  readLiveChatTranscriptAsync,
} from '../group-dir.js';
import { getSharedConversationIds } from '../modules/knowledge/db-kb.js';
import { logger } from '../logger.js';

// Characters that continue a path or file name. A reference only counts when it
// is not glued to more of these, so `images/a` never matches `images/a.png`.
const PATH_CHAR = /[A-Za-z0-9._~%/-]/;

// Membership is checked on every request; only the transcript-derived decision
// is reused, and only while all live transcript markers remain unchanged.
const decisionCache = new Map<
  string,
  { markers: string; allowed: boolean; expires: number }
>();
const DECISION_TTL_MS = 5_000;

/** What an implicit (chat-only) user asks to read. */
export interface GroupFileReference {
  /** Whole-path strings that name the file in a transcript (raw form). */
  needles: string[];
  /** Artifact source path `S`; adds the bare `artifacts/S` needle. */
  bareArtifactPath?: string;
  /** Conversation id when the file is `artifacts/upload/<cid>/...`. */
  uploadConversationId?: string;
}

function encodePath(value: string): string {
  return value
    .split('/')
    .map((segment) => (segment ? encodeURIComponent(segment) : segment))
    .join('/');
}

function containsWholePath(
  text: string,
  needle: string,
  checkLeadingBoundary: boolean,
): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return false;
    const before = at > 0 ? text[at - 1] : '';
    const after = text[at + needle.length] ?? '';
    if (
      (!checkLeadingBoundary || !before || !PATH_CHAR.test(before)) &&
      (!after || !PATH_CHAR.test(after))
    ) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * Whether a chat-only user (conversation member without project membership)
 * may read a project file: only when it lives under
 * `artifacts/upload/<cid>/` for one of their conversations, or when the live
 * transcript of one of their conversations references it as a whole path.
 *
 * Reads live transcripts only (`readLiveChatTranscriptAsync`), so a file
 * request never restores archived data; opening an archived conversation in
 * the UI restores it first. Fails closed on any error.
 *
 * Accepted risk: a chat-only user with editor access to a conversation can
 * post a message naming any path and then fetch it. That is no wider than
 * asking the agent in that conversation, which reads the whole project
 * folder. A chat-only viewer cannot post and only sees what others referenced.
 */
export async function implicitUserMayReadGroupFile(
  userId: string,
  folder: string,
  ref: GroupFileReference,
): Promise<boolean> {
  try {
    const conversationIds = await getSharedConversationIds(userId, folder);
    if (conversationIds.length === 0) return false;
    if (
      ref.uploadConversationId &&
      conversationIds.includes(ref.uploadConversationId)
    ) {
      return true;
    }

    const key = JSON.stringify([userId, folder, ref]);
    const transcriptMarkers = async () =>
      JSON.stringify(
        await Promise.all(
          conversationIds.map(async (id) => [
            id,
            await chatTranscriptStatKey(folder, id),
          ]),
        ),
      );
    const markers = await transcriptMarkers();
    const cached = decisionCache.get(key);
    if (cached && cached.expires > Date.now() && cached.markers === markers) {
      return cached.allowed;
    }

    const plain: string[] = [];
    for (const needle of ref.needles) {
      plain.push(needle, encodePath(needle));
    }
    const bare = ref.bareArtifactPath
      ? [
          `artifacts/${ref.bareArtifactPath}`,
          `artifacts/${encodePath(ref.bareArtifactPath)}`,
        ]
      : [];
    const matches = (text: string) =>
      plain.some((needle) => containsWholePath(text, needle, false)) ||
      bare.some((needle) => containsWholePath(text, needle, true));

    let allowed = false;
    for (const conversationId of conversationIds) {
      const entries = await readLiveChatTranscriptAsync(folder, conversationId);
      if (entries.some((entry) => matches(JSON.stringify(entry)))) {
        allowed = true;
        break;
      }
    }
    if (markers === (await transcriptMarkers())) {
      decisionCache.delete(key);
      if (decisionCache.size >= 1024)
        decisionCache.delete(decisionCache.keys().next().value!);
      decisionCache.set(key, {
        markers,
        allowed,
        expires: Date.now() + DECISION_TTL_MS,
      });
    } else {
      decisionCache.delete(key);
    }
    return allowed;
  } catch (err) {
    logger.warn({ err, folder }, 'Conversation file reference check failed');
    return false;
  }
}
