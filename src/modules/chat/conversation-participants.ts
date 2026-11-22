import { getUserProfilesByIds } from '../knowledge/db-kb.js';
import { presentAccountIdentity } from '../account/profile.js';

export interface ConversationParticipant {
  userId?: string;
  name: string;
  avatarUrl?: string | null;
}

interface PresentedUserProfile {
  name: string;
  avatarUrl: string | null;
}

async function presentUserProfiles(userIds: string[]) {
  const profiles = await getUserProfilesByIds(userIds);
  return Object.fromEntries(
    await Promise.all(
      Object.values(profiles).map(async (profile) => {
        const identity = await presentAccountIdentity(profile);
        return [
          profile.id,
          {
            name: identity.name,
            avatarUrl: identity.avatarUrl,
          } satisfies PresentedUserProfile,
        ];
      }),
    ),
  ) as Record<string, PresentedUserProfile>;
}

interface ParticipantRef {
  userId?: string;
  senderName?: string;
}

function participantRefs(entries: unknown[]): ParticipantRef[] {
  const refs: ParticipantRef[] = [];
  const seen = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const raw = entries[index];
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (entry.role !== 'user' || entry.source === 'agent') continue;
    const userId =
      typeof entry.senderUserId === 'string' ? entry.senderUserId.trim() : '';
    const senderName =
      typeof entry.sender_name === 'string' ? entry.sender_name.trim() : '';
    const key = userId
      ? `id:${userId}`
      : senderName && !['web', 'you'].includes(senderName.toLowerCase())
        ? `name:${senderName.toLowerCase()}`
        : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    refs.push(userId ? { userId } : { senderName });
  }
  return refs;
}

export async function resolveConversationParticipants(
  transcriptGroups: unknown[][],
): Promise<ConversationParticipant[][]> {
  const refGroups = transcriptGroups.map(participantRefs);
  const profiles = await presentUserProfiles(
    refGroups.flatMap((refs) =>
      refs.flatMap((ref) => (ref.userId ? [ref.userId] : [])),
    ),
  );
  return refGroups.map((refs) => {
    const participants: ConversationParticipant[] = [];
    for (const ref of refs) {
      const profile = ref.userId ? profiles[ref.userId] : undefined;
      const name = ref.userId
        ? profile?.name || 'Unknown user'
        : ref.senderName!;
      participants.push({
        ...(ref.userId ? { userId: ref.userId } : {}),
        name,
        ...(profile ? { avatarUrl: profile.avatarUrl } : {}),
      });
    }
    return participants;
  });
}

export async function hydrateTranscriptSenderNames(
  entries: unknown[],
): Promise<unknown[]> {
  const userIds = entries.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const senderUserId = (raw as Record<string, unknown>).senderUserId;
    return typeof senderUserId === 'string' && senderUserId
      ? [senderUserId]
      : [];
  });
  const profiles = await presentUserProfiles(userIds);
  return entries.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const entry = raw as Record<string, unknown>;
    const senderUserId =
      typeof entry.senderUserId === 'string' ? entry.senderUserId : '';
    if (!senderUserId) return raw;
    const profile = profiles[senderUserId];
    if (!profile) return raw;
    return {
      ...entry,
      sender_name: profile.name,
      senderAvatarUrl: profile.avatarUrl,
    };
  });
}
