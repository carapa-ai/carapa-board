export type MainResponseOwner = 'generic-stream' | 'canonical-transcript';

/**
 * Keep the generic main-agent bubble as the sole owner while an invited
 * persona is active. The canonical row takes ownership once the outer run is
 * complete. Persona rows are separate, additive renderers.
 */
export function mainResponseOwner({
  personaDriven,
  hasVirtualSender,
  mainPersonaIsVoiceDelayed = false,
  hasPersistedResponse = false,
  chatRunning,
  sending,
  streamIsActive,
}: {
  personaDriven: boolean;
  hasVirtualSender: boolean;
  /** Configured main personas stay in the transcript while invited speakers stream. */
  mainPersonaIsVoiceDelayed?: boolean;
  hasPersistedResponse?: boolean;
  chatRunning: boolean;
  /** The completion effect clears this one render after chatRunning. */
  sending: boolean;
  streamIsActive: boolean;
}): MainResponseOwner {
  // Persona Live owns configured-main text through its per-speaker row from
  // generation onward. The generic stream must never remain mounted as a
  // second owner while the voice-paced row is being prepared or revealed.
  if (mainPersonaIsVoiceDelayed && hasVirtualSender) {
    return 'canonical-transcript';
  }
  return personaDriven && !hasVirtualSender && (chatRunning || sending) && streamIsActive
    ? 'generic-stream'
    : 'canonical-transcript';
}
