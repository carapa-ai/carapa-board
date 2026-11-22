export type LiveModeKind = 'personas' | 'work';
export interface PersonaLiveOwner {
  sessionId: string;
  mode: LiveModeKind;
  userId?: string;
  deviceId?: string;
  platform?: 'web' | 'android' | 'ios';
}
const liveOwners = new Map<string, PersonaLiveOwner>();

/** The one browser session currently allowed to pace this conversation. */
export function getPersonaLiveSession(
  conversationId: string,
): string | undefined {
  return liveOwners.get(conversationId)?.sessionId;
}

export function getPersonaLiveOwner(
  conversationId: string,
): PersonaLiveOwner | undefined {
  return liveOwners.get(conversationId);
}

export function getLiveModeKind(
  conversationId: string,
): LiveModeKind | undefined {
  return liveOwners.get(conversationId)?.mode;
}

export function setPersonaLiveSession(
  conversationId: string,
  sessionId: string | null,
  owner?: Partial<Omit<PersonaLiveOwner, 'sessionId'>>,
): void {
  if (sessionId) {
    const previousOwner = liveOwners.get(conversationId);
    liveOwners.set(conversationId, {
      sessionId,
      mode: owner?.mode ?? previousOwner?.mode ?? 'personas',
      ...owner,
    });
    return;
  }
  liveOwners.delete(conversationId);
}

export function resetPersonaPlaybackGateForTest(): void {
  liveOwners.clear();
}
