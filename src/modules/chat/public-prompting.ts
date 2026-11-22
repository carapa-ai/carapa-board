import {
  getRuntimeCatalog,
  isDirectRuntime,
  resolveRuntimeSelection,
} from '../../lib/chat-agents.js';
import { JEV_URL, PUBLIC_SAFETY_JUDGE_ENGINE } from '../../config.js';
import {
  listConversationAiUserRows,
  getAiUserRow,
  getConversation,
} from '../../db.js';
import { getGroupByFolder } from '../../state-manager.js';

export interface PublicPromptingEligibility {
  available: boolean;
  reason: string | null;
  personaIds: string[];
}

export async function getPublicPromptingEligibility(
  conversationId: string,
): Promise<PublicPromptingEligibility> {
  const conversation = await getConversation(conversationId);
  if (!conversation)
    return {
      available: false,
      reason: 'Conversation not found.',
      personaIds: [],
    };
  const group = getGroupByFolder(conversation.group_folder);
  if (!group)
    return {
      available: false,
      reason: 'Project is unavailable.',
      personaIds: [],
    };

  const catalog = getRuntimeCatalog();
  if (PUBLIC_SAFETY_JUDGE_ENGINE === 'jev') {
    if (!JEV_URL) {
      return {
        available: false,
        reason: 'Configure JEV_URL for the Jev public safety judge first.',
        personaIds: [],
      };
    }
  } else {
    const judgeSelection = catalog.defaults.publicSafetyJudge;
    if (!judgeSelection) {
      return {
        available: false,
        reason: 'Configure a direct public safety judge first.',
        personaIds: [],
      };
    }
    try {
      const judge = resolveRuntimeSelection(judgeSelection);
      if (!isDirectRuntime(judge) || !judge.baseUrl)
        throw new Error('not direct');
    } catch {
      return {
        available: false,
        reason: 'The public safety judge must use a direct LLM runtime.',
        personaIds: [],
      };
    }
  }

  const mode =
    conversation.mainAiUserMode ??
    (conversation.mainAiUserId ? 'persona' : 'inherit');
  const mainId =
    mode === 'none'
      ? null
      : mode === 'persona'
        ? conversation.mainAiUserId
        : group.settings?.defaultMainAiUserId;
  const main = mainId ? await getAiUserRow(mainId) : undefined;
  const memberships = await listConversationAiUserRows(conversationId);
  const personas = [
    ...(main?.enabled ? [main] : []),
    ...memberships
      .filter(
        ({ aiUser, membership }) =>
          aiUser.enabled === 1 &&
          membership.status === 'active' &&
          aiUser.id !== main?.id,
      )
      .map(({ aiUser }) => aiUser),
  ];
  if (personas.length === 0) {
    return {
      available: false,
      reason: 'Add at least one active persona to this conversation.',
      personaIds: [],
    };
  }
  for (const persona of personas) {
    const preset = catalog.presets.find((item) => item.id === persona.presetId);
    if (!preset) {
      return {
        available: false,
        reason: `${persona.name} has an unavailable runtime preset.`,
        personaIds: [],
      };
    }
    try {
      const runtime = resolveRuntimeSelection(preset.selection);
      if (!isDirectRuntime(runtime) || !runtime.baseUrl)
        throw new Error('not direct');
    } catch {
      return {
        available: false,
        reason: `${persona.name} must use a direct LLM preset.`,
        personaIds: [],
      };
    }
  }
  return {
    available: true,
    reason: null,
    personaIds: personas.map((persona) => persona.id),
  };
}
