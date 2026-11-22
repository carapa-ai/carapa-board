import {
  PUBLIC_PROMPT_PERSONA_CALL_MAX,
  PUBLIC_PROMPT_TIMEOUT_MS,
} from '../../config.js';
import { getConversation } from '../../db.js';
import { getGroupByFolder } from '../../state-manager.js';
import {
  runAiUserPhase,
  runMainAiUserFollowUp,
  type AiUserTurnMessage,
} from '../ai-users/orchestrator.js';
import { publishPublicConversationEvent } from './public-conversation-events.js';
import {
  judgePublicContent,
  PUBLIC_SAFE_PERSONA_REFUSAL,
  scrubPublicText,
} from './public-content-safety.js';
import { wrapUntrustedPublicContent } from '../transcripts/transcript-store.js';

type PublicPersonaTurnOptions = {
  conversationId: string;
  interactionId: string;
  prompt: string;
  visitorName: string;
};

let publicPersonaTurnOverride:
  | ((options: PublicPersonaTurnOptions) => Promise<number>)
  | undefined;

/** Test seam for the durable dispatcher; production always leaves this unset. */
export function setPublicPersonaTurnOverride(
  override?: (options: PublicPersonaTurnOptions) => Promise<number>,
): void {
  publicPersonaTurnOverride = override;
}

export async function runPublicPersonaTurns(
  options: PublicPersonaTurnOptions,
): Promise<number> {
  if (publicPersonaTurnOverride) return publicPersonaTurnOverride(options);
  const conversation = await getConversation(options.conversationId);
  if (!conversation) throw new Error('Conversation not found');
  const group = getGroupByFolder(conversation.group_folder);
  if (!group) throw new Error('Project unavailable');
  const deadline = Date.now() + PUBLIC_PROMPT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(PUBLIC_PROMPT_TIMEOUT_MS);
  const callBudget = { remaining: PUBLIC_PROMPT_PERSONA_CALL_MAX };
  const untrustedPrompt = wrapUntrustedPublicContent(options.prompt);
  let responderCount = 0;
  const messages: AiUserTurnMessage[] = [];
  const onMessage = (message: AiUserTurnMessage) => {
    messages.push(message);
    responderCount += 1;
    publishPublicConversationEvent(options.conversationId, {
      type: 'changed',
      messageId: message.id,
    });
  };
  const publicVisitor = {
    interactionId: options.interactionId,
    callBudget,
    signal,
    transformOutput: async (raw: string) => {
      const scrubbed = scrubPublicText(raw, group);
      const decision = await judgePublicContent('output', scrubbed, group);
      return decision.allowed ? scrubbed : PUBLIC_SAFE_PERSONA_REFUSAL;
    },
  };
  const common = {
    group,
    conversationId: options.conversationId,
    humanPrompt: untrustedPrompt,
    humanName: options.visitorName,
    shouldStop: () => Date.now() >= deadline,
    onMessage,
    publicVisitor,
  };
  const before = await runAiUserPhase({ ...common, phase: 'before' });
  if (Date.now() < deadline && callBudget.remaining > 0) {
    await runMainAiUserFollowUp({
      ...common,
      participantContext:
        before
          .map((message) => `${message.sender_name}: ${message.content}`)
          .join('\n\n') ||
        'No invited participant has replied yet. Respond directly to the human participant.',
    });
  }
  if (Date.now() < deadline && callBudget.remaining > 0) {
    await runAiUserPhase({
      ...common,
      phase: 'after',
      coordinatorResponse: messages
        .map((message) => `${message.sender_name}: ${message.content}`)
        .join('\n\n'),
    });
  }
  return responderCount;
}
