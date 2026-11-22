import { sha256Hex } from '../../lib/hash.js';
import type { AiUserPrompt } from './types.js';

/** Stable fingerprint for conversations whose main agent has no persona. */
export const NO_MAIN_PERSONA_FINGERPRINT = 'main-persona:none:v1';
const MAIN_PERSONA_SESSION_KEY_PREFIX = 'main-persona-session:';

/**
 * Hash only persona-owned instructions that affect the main agent's identity
 * or behavior. Conversation context, project prompts, and invited participants
 * deliberately remain outside this fingerprint.
 */
export function createMainPersonaFingerprint(
  aiUser: { id: string; name: string },
  prompt: Pick<AiUserPrompt, 'identity' | 'body' | 'tools'>,
  emoteNames: readonly string[],
): string {
  const content = JSON.stringify({
    id: aiUser.id,
    name: aiUser.name.trim(),
    identity: prompt.identity,
    body: prompt.body,
    tools: [...prompt.tools].sort(),
    emotes: [...emoteNames].sort(),
  });
  return `main-persona:v1:${sha256Hex(content)}`;
}

/** Keep Board's resumable native-session row aligned with the warm generation. */
export function mainPersonaSessionKey(
  runtimeSessionKey: string,
  generation: number,
): string {
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new Error('Main persona generation must be a positive integer');
  return `${MAIN_PERSONA_SESSION_KEY_PREFIX}g${generation}:${runtimeSessionKey}`;
}

/**
 * Short revision of the instructions a warm persona process is created with.
 * Invited personas have no durable generation, so this selects their process.
 */
export function createPersonaInstructionRevision(
  instructions: readonly string[],
): string {
  return sha256Hex(JSON.stringify(instructions)).slice(0, 12);
}
