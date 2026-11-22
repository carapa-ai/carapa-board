import { randomUUID } from 'crypto';
import type { RegisteredGroup } from '../../types.js';
import type {
  ChatAgentOption,
  RuntimeSelection,
} from '../../lib/chat-agents.js';
import type { McpServerDeps } from '../../mcp/auth.js';
import { runChatAgent } from '../../agent-runner.js';
import {
  getChatAgents,
  getDefaultRuntimeSelection,
  getRuntimeCatalog,
  isDirectRuntime,
  resolveRuntimeSelection,
} from '../../lib/chat-agents.js';
import {
  insertAiTurnRun,
  listConversationAiUserRows,
  getAiUserRow,
  getConversation,
  getConversationMainPersonaSourceObservation,
  resolveConversationMainPersonaGeneration,
  updateAiTurnRun,
  saveChatMessage,
} from '../../db.js';
import { normalizeEmoteName, readAiUserPrompt } from './storage.js';
import { parseAiUserPrompt } from './prompt.js';
import {
  createMainPersonaFingerprint,
  createPersonaInstructionRevision,
  NO_MAIN_PERSONA_FINGERPRINT,
} from './session-revision.js';
import type { ConversationMainPersonaSourceObservation } from '../chat/db-chats.js';
import { resolveAllowedPersonaTools } from '../tools/registry.js';
import { appendChatTranscriptEntry } from '../../group-dir.js';
import { getLlmHistory } from '../transcripts/transcript-store.js';
import { logger } from '../../logger.js';
import { escapeRegex } from '../../utils.js';
import { getGroupByFolder } from '../../state-manager.js';
import {
  ENABLE_TTS_EXPRESSIONS,
  SUPERTONIC_EXPRESSIONS,
  TTS_LANG,
  TTS_VOICE,
} from '../tts/config.js';
import {
  parseTalkingStickDecision,
  TalkingStickStreamParser,
  type TalkingStickDecision,
} from './talking-stick.js';

export { parseTalkingStickDecision } from './talking-stick.js';
export type { TalkingStickDecision } from './talking-stick.js';

const MAX_AI_TURNS_PER_PHASE = 12;

export async function resolveEffectiveMainAiUser(
  conversationId: string,
  knownGroup?: RegisteredGroup,
) {
  const conversation = await getConversation(conversationId);
  if (!conversation) return undefined;
  const mode =
    conversation.mainAiUserMode ??
    (conversation.mainAiUserId ? 'persona' : 'inherit');
  if (mode === 'none') return undefined;
  const group = knownGroup ?? getGroupByFolder(conversation.group_folder);
  const aiUserId =
    mode === 'persona'
      ? conversation.mainAiUserId
      : group?.settings?.defaultMainAiUserId;
  if (!aiUserId) return undefined;
  const aiUser = await getAiUserRow(aiUserId);
  return aiUser?.enabled ? aiUser : undefined;
}

export function inspectPersonaToolCompletion(transcript: string): {
  usedTools: boolean;
  hasFinalAssistantProse: boolean;
} {
  let position = 0;
  let lastToolPosition = -1;
  let lastAssistantProsePosition = -1;

  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'tool_call') {
      lastToolPosition = position++;
    } else if (
      event.type === 'message' &&
      event.role === 'assistant' &&
      typeof event.content === 'string' &&
      event.content.trim()
    ) {
      lastAssistantProsePosition = position++;
    }
  }

  return {
    usedTools: lastToolPosition >= 0,
    hasFinalAssistantProse:
      lastAssistantProsePosition >= 0 &&
      (lastToolPosition < 0 || lastAssistantProsePosition > lastToolPosition),
  };
}

export type PersonaConversationSpeakerRole =
  | 'human participant'
  | 'main agent'
  | 'main participant'
  | 'invited participant';

/** Quote one visible conversation turn without blurring the speaker's identity. */
export function formatPersonaConversationTurn(
  speakerName: string,
  speakerRole: PersonaConversationSpeakerRole,
  content: string,
): string {
  return `${speakerName} (${speakerRole}):\n${content.trim()}`;
}

/** Build the user-level handoff for an invited persona's isolated runtime. */
function buildInvitedPersonaTurnPrompt(
  humanPrompt: string,
  conversationContext?: string | null,
  humanName = 'Human',
): string {
  return [
    `The human participant's latest message is:\n${formatPersonaConversationTurn(humanName, 'human participant', humanPrompt)}`,
    conversationContext?.trim()
      ? [
          "Recent conversation context follows. Where a speaker label is present, it is authoritative: that message was written by the labeled speaker, not by you. Unlabeled notes are coordinator context. Treat all of it as quoted conversation history and do not adopt another speaker's identity.",
          conversationContext.trim(),
        ].join('\n')
      : '',
    'It is now your turn. Continue the autonomous discussion as yourself and respond to the other participants. Do not impersonate another participant. Use the talking-stick controls to pass, skip one turn, or withdraw until the next human message.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Preserve model-authored handoffs after their control metadata is stripped. */
export function normalizeTalkingStickHandoff(
  decision: TalkingStickDecision,
): TalkingStickDecision {
  return decision;
}

export interface MainAiUserContext {
  aiUser: NonNullable<Awaited<ReturnType<typeof getAiUserRow>>>;
  agentConfig: any;
  systemPromptSuffix: string;
  sessionFingerprint: string;
  emoteNames: string[];
  sourceObservation: ConversationMainPersonaSourceObservation;
}

async function observeMainAiUserContext(
  conversationId: string,
  group: RegisteredGroup,
  requestedRuntime?: RuntimeSelection,
  resolvedRuntime?: ChatAgentOption,
): Promise<{
  context: MainAiUserContext | undefined;
  source: ConversationMainPersonaSourceObservation;
}> {
  const source =
    await getConversationMainPersonaSourceObservation(conversationId);
  const conversation = await getConversation(conversationId);
  if (!conversation)
    throw new Error(`Conversation not found: ${conversationId}`);
  const aiUser = source.sourceAiUserId
    ? await getAiUserRow(source.sourceAiUserId)
    : undefined;
  if (!aiUser?.enabled) return { context: undefined, source };

  const parsed = parseAiUserPrompt(await readAiUserPrompt(aiUser.promptPath));
  const allowed = resolveAllowedPersonaTools(group.folder, aiUser.tools);
  const emoteNames = (aiUser.publishedEmotes ?? []).map((emote) => emote.name);
  const agentId = `ai-main:${aiUser.id}`;
  const runtime =
    resolvedRuntime ??
    resolveRuntimeSelection(
      requestedRuntime ??
        conversation.runtimeSelection ??
        group.settings?.chatRuntimeSelection ??
        getDefaultRuntimeSelection('chat'),
    );
  return {
    source,
    context: {
      aiUser,
      emoteNames,
      sessionFingerprint: createMainPersonaFingerprint(
        aiUser,
        parsed,
        emoteNames,
      ),
      agentConfig: {
        ...runtime,
        id: agentId,
        sessionFamily: `${runtime.sessionFamily || runtime.agentCmd || runtime.id}:ai-main:${aiUser.id}`,
        allowedToolNames: allowed.toolNames,
      },
      systemPromptSuffix: [
        `# Main virtual participant identity\n${parsed.body}`,
        `Your participant name is: ${aiUser.name}`,
        `Your visible identity is: ${parsed.identity}`,
        'You are the main responding participant in this conversation. Respond as yourself and do not impersonate the human users or invited participants.',
        `Permitted toolsets: ${allowed.toolsets.join(', ') || 'core only'}.`,
        personaTurnControlInstructions(
          emoteNames,
          (await listActivePersonaIds(conversationId)).some(
            (id) => id !== aiUser.id,
          ),
        ),
      ].join('\n\n'),
      sourceObservation: source,
    },
  };
}

export async function resolveMainAiUserContext(
  conversationId: string,
  group: RegisteredGroup,
  requestedRuntime?: RuntimeSelection,
  resolvedRuntime?: ChatAgentOption,
): Promise<MainAiUserContext | undefined> {
  return (
    await observeMainAiUserContext(
      conversationId,
      group,
      requestedRuntime,
      resolvedRuntime,
    )
  ).context;
}

const MAX_MAIN_PERSONA_RESOLUTION_ATTEMPTS = 8;

function personaObservationKey(observed: {
  context: MainAiUserContext | undefined;
  source: ConversationMainPersonaSourceObservation;
}): string {
  return JSON.stringify([
    observed.context?.sessionFingerprint ?? NO_MAIN_PERSONA_FINGERPRINT,
    observed.source,
  ]);
}

/** Resolve matching persona instructions and routing generation as one bounded CAS loop. */
export async function resolveMainPersonaSession(
  conversationId: string,
  group: RegisteredGroup,
  requestedRuntime?: RuntimeSelection,
  resolvedRuntime?: ChatAgentOption,
  initialContext?: MainAiUserContext,
): Promise<{
  mainAiUserContext: MainAiUserContext | undefined;
  mainPersonaGeneration: number;
}> {
  let observed = initialContext
    ? { context: initialContext, source: initialContext.sourceObservation }
    : await observeMainAiUserContext(
        conversationId,
        group,
        requestedRuntime,
        resolvedRuntime,
      );
  let repeatedRejectionKey: string | undefined;
  for (
    let attempt = 0;
    attempt < MAX_MAIN_PERSONA_RESOLUTION_ATTEMPTS;
    attempt++
  ) {
    const generation = await resolveConversationMainPersonaGeneration(
      conversationId,
      observed.context?.sessionFingerprint ?? NO_MAIN_PERSONA_FINGERPRINT,
      observed.source,
    );
    if (generation !== null) {
      return {
        mainAiUserContext: observed.context,
        mainPersonaGeneration: generation,
      };
    }
    const refreshed = await observeMainAiUserContext(
      conversationId,
      group,
      requestedRuntime,
      resolvedRuntime,
    );
    const observedKey = personaObservationKey(observed);
    const refreshedKey = personaObservationKey(refreshed);
    if (refreshedKey === observedKey) {
      if (repeatedRejectionKey === refreshedKey) {
        throw new Error(
          `Main persona publication is incomplete for conversation ${conversationId}`,
        );
      }
      repeatedRejectionKey = refreshedKey;
    } else {
      repeatedRejectionKey = undefined;
    }
    observed = refreshed;
  }
  throw new Error(
    `Main persona publication did not stabilize for conversation ${conversationId}`,
  );
}

function personaTurnControlInstructions(
  emoteNames: string[],
  hasInvitedPersona = true,
): string {
  const emoteMarkerPosition = hasInvitedPersona
    ? ' (before any talking-stick marker)'
    : '';
  const emotes =
    emoteNames.length === 0
      ? ''
      : `Your available visual emotes are: ${emoteNames.join(', ')}. When one reinforces this response, include exactly one invisible control comment <!-- persona-emote:NAME --> at the end of your response${emoteMarkerPosition}, using an exact available name.`;
  const expressions = ENABLE_TTS_EXPRESSIONS
    ? `For natural voice delivery, you may place at most three inline control comments using one of these exact values: ${SUPERTONIC_EXPRESSIONS.join(', ')}. The syntax is <!-- persona-expression:VALUE -->. Use them sparingly and only at the exact point they should be heard.`
    : '';
  const talkingStick = hasInvitedPersona
    ? 'Contribute only when you have something useful and non-redundant to add. When the human directly addresses you as the main responding participant, answer them. Automatic participant-to-participant continuation requires at least two distinct active AI personas; when you are the only active persona, answer the human once and wait for their next message. During autonomous participant discussion, if you have nothing useful to add on this turn but may contribute later, output exactly <!-- talking-stick: skip --> and no other text or control marker; this silently passes one turn while keeping you in the rotation. To withdraw from the current autonomous discussion until the next human message, use <!-- talking-stick: stop -->. You may put visible text before the stop marker when making a final contribution, or output only the stop marker to withdraw silently. Never write visible prose such as "I stop" merely to communicate this control state; use the hidden stop marker. If you speak and remain in the discussion, finish with exactly one talking-stick marker: <!-- talking-stick: pass --> for normal rotation, or <!-- talking-stick: Exact Persona Name --> to hand the very next turn to that participant; this also wakes a participant that withdrew. Use the participant identity exactly as listed; do not rely on mentioning their name in visible prose.'
    : '';
  return [
    talkingStick,
    emotes,
    expressions,
    'Respond directly without prefixing your answer with your participant name, role, identity, or a bracketed Persona label.',
    'These markers are control metadata and are removed before display and speech.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Remove an exact model-generated self-attribution from the start of a turn. */
function stripPersonaSelfAttribution(
  content: string,
  persona: { name: string; identity: string },
): string {
  const labels = [
    ...new Set(
      [persona.identity, persona.name]
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ].sort((left, right) => right.length - left.length);
  for (const label of labels) {
    const escaped = escapeRegex(label).replace(/\s+/g, '\\s+');
    const prefix = new RegExp(
      `^\\s*(?:\\[\\s*(?:Persona\\s+)?${escaped}\\s*\\]|(?:Persona\\s+)?${escaped})\\s*:\\s*`,
      'i',
    );
    if (prefix.test(content)) return content.replace(prefix, '').trimStart();
  }
  return content;
}

/** Withhold a possible self-attribution until it can be stripped or ruled out. */
export class PersonaSelfAttributionStreamParser {
  private pending = '';
  private resolved = false;
  private readonly prefixes: string[];

  constructor(private readonly persona: { name: string; identity: string }) {
    const labels = [
      ...new Set(
        [persona.identity, persona.name]
          .map((label) => label.trim())
          .filter(Boolean),
      ),
    ];
    this.prefixes = labels
      .flatMap((label) => [
        `[${label}]:`,
        `[Persona ${label}]:`,
        `${label}:`,
        `Persona ${label}:`,
      ])
      .map(normalizePersonaAttributionPrefix);
  }

  push(chunk: string): string {
    if (this.resolved || !chunk) return chunk;
    this.pending += chunk;

    const stripped = stripPersonaSelfAttribution(this.pending, this.persona);
    if (stripped !== this.pending) {
      this.pending = '';
      this.resolved = true;
      return stripped;
    }

    const normalized = normalizePersonaAttributionPrefix(this.pending);
    if (this.prefixes.some((prefix) => prefix.startsWith(normalized)))
      return '';

    const pending = this.pending;
    this.pending = '';
    this.resolved = true;
    return pending;
  }

  finish(): string {
    if (this.resolved) return '';
    const pending = stripPersonaSelfAttribution(this.pending, this.persona);
    this.pending = '';
    this.resolved = true;
    return pending;
  }
}

function normalizePersonaAttributionPrefix(value: string): string {
  return value
    .trimStart()
    .replace(/\s+/g, ' ')
    .replace(/\[\s+/g, '[')
    .replace(/\s+\]/g, ']')
    .replace(/\]\s+/g, ']')
    .toLowerCase();
}

/** Validate one persona-scoped response marker and strip all emote metadata. */
export function finishPersonaEmoteTurn(
  content: string,
  emoteNames: readonly string[],
): { content: string; speechText: string; emote?: string } {
  let markerEmote: string | undefined;
  const withoutEmotes = content.replace(
    /[ \t]*<!--\s*persona-emote:\s*([^>]+?)\s*-->[ \t]*/gi,
    (_match, raw: string) => {
      try {
        const normalized = normalizeEmoteName(raw);
        if (emoteNames.includes(normalized)) markerEmote = normalized;
      } catch {
        /* invalid control metadata is ignored and removed */
      }
      return '';
    },
  );
  let expressionCount = 0;
  const expressionNames = new Set<string>(SUPERTONIC_EXPRESSIONS);
  const expressionAlternation = SUPERTONIC_EXPRESSIONS.join('|');
  const expressionMarker = new RegExp(
    '[ \\t]*<' + '!--\\s*persona-expression:\\s*([^>]+?)\\s*--' + '>[ \\t]*',
    'gi',
  );
  let speechWithTokens = '';
  let expressionCursor = 0;
  for (const match of withoutEmotes.matchAll(expressionMarker)) {
    speechWithTokens += withoutEmotes.slice(expressionCursor, match.index);
    const expression = String(match[1] || '')
      .trim()
      .toLowerCase();
    if (
      ENABLE_TTS_EXPRESSIONS &&
      expressionCount < 3 &&
      expressionNames.has(expression)
    ) {
      expressionCount++;
      speechWithTokens += ` __CARAPA_EXPRESSION_${expression.toUpperCase()}__ `;
    } else {
      speechWithTokens += ' ';
    }
    expressionCursor = (match.index || 0) + match[0].length;
  }
  speechWithTokens += withoutEmotes.slice(expressionCursor);
  const stripRawExpressions = (value: string) =>
    value.replace(
      new RegExp(`[ \\t]*<\\/?(?:${expressionAlternation})>[ \\t]*`, 'gi'),
      ' ',
    );
  const visible = stripRawExpressions(speechWithTokens)
    .replace(
      new RegExp(
        `[ \\t]*__CARAPA_EXPRESSION_(?:${expressionAlternation})__[ \\t]*`,
        'gi',
      ),
      ' ',
    )
    .trim();
  const speechText = stripRawExpressions(speechWithTokens)
    .replace(
      new RegExp(`__CARAPA_EXPRESSION_(${expressionAlternation})__`, 'gi'),
      (_match, value: string) => `<${value.toLowerCase()}>`,
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { content: visible, speechText, emote: markerEmote };
}

export function speechProfileForAiUser(aiUser: {
  voiceId?: string | null;
  voiceLang?: string | null;
}) {
  return {
    voiceId: aiUser.voiceId || TTS_VOICE,
    language: aiUser.voiceLang || TTS_LANG,
  };
}

export async function getAiCoordinatorInstructions(
  conversationId: string,
  identities?: { humanName: string; mainParticipantName: string },
): Promise<string | undefined> {
  const main = await resolveEffectiveMainAiUser(conversationId);
  const memberships = await listConversationAiUserRows(conversationId);
  const active = memberships.filter(
    ({ aiUser, membership }) =>
      aiUser.id !== main?.id &&
      aiUser.enabled === 1 &&
      membership.status === 'active',
  );
  if (active.length === 0) return undefined;
  const roster = active
    .map(
      ({ aiUser }) =>
        `- Name: ${aiUser.name}; identity: ${aiUser.identity}; turn: ${aiUser.turn}`,
    )
    .join('\n');
  const identityContext = identities
    ? `# Conversation identities\n- ${identities.humanName} (human participant)\n- ${identities.mainParticipantName} (main agent)\n\n`
    : '';
  return `${identityContext}# Invited virtual participants\n${roster}\n\nYou coordinate the talking stick. Every active participant starts in the autonomous rotation, regardless of whether their configured first turn is before or after the main participant. End your response with exactly one invisible control comment: <!-- talking-stick: pass --> for normal rotation, <!-- talking-stick: Exact Participant Name --> to give that participant the next turn (this also wakes one that withdrew), or <!-- talking-stick: stop --> to withdraw yourself until the next human message. Copy the participant's Name field exactly from the roster; do not use their identity or role description. Do not rely on a visible prose mention for handoff, and do not announce a stop in visible prose merely to express the control state. Never end the cycle after only your response unless you deliberately withdraw with the stop marker. The comment is control metadata and will be removed before display.`;
}

/** Snapshot the active persona roster used to detect a unanimous skip cycle. */
export async function listActivePersonaIds(
  conversationId: string,
): Promise<string[]> {
  const main = await resolveEffectiveMainAiUser(conversationId);
  const memberships = await listConversationAiUserRows(conversationId);
  return [
    ...(main ? [main.id] : []),
    ...memberships
      .filter(
        ({ aiUser, membership }) =>
          aiUser.id !== main?.id &&
          aiUser.enabled === 1 &&
          membership.status === 'active',
      )
      .map(({ aiUser }) => aiUser.id),
  ];
}

export interface AiUserTurnMessage {
  id: string;
  group_folder: string;
  role: 'assistant';
  content: string;
  sender_name: string;
  senderUserId: string;
  source: 'web' | 'public';
  publicInteractionId?: string;
  created_at: string;
  conversation_id: string;
  telemetry?: Record<string, unknown> | null;
  emote?: string | null;
  speechText?: string | null;
  speechProfile?: { voiceId: string; language: string };
  talkingStickDecision?: TalkingStickDecision;
}

export type AiUserHandoff = TalkingStickDecision | { kind: 'main' };

export interface PublicPersonaExecution {
  interactionId: string;
  /** Shared across before/main/after so skipped turns still consume the cap. */
  callBudget: { remaining: number };
  transformOutput: (content: string) => Promise<string>;
  signal?: AbortSignal;
}

export function forcePublicPersonaRuntime<T extends Record<string, any>>(
  runtime: T,
  id: string,
): T {
  if (!isDirectRuntime(runtime) || !runtime.baseUrl)
    throw new Error('Public persona runtime is not direct');
  return {
    ...runtime,
    id,
    sessionFamily: `${runtime.sessionFamily || runtime.agentCmd || runtime.id}:${id}`,
    allowedToolNames: [],
  };
}
export interface PersonaMentionCandidate {
  id: string;
  identity: string;
  handoff: AiUserHandoff;
}

function normalizedMentionText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
}

/**
 * Resolve the last unambiguous active persona name in a message. Full names
 * always work; a first-name shorthand works only when it identifies one
 * persona. The current speaker is excluded to avoid self-references looping.
 */
export async function resolveActivePersonaMention(
  conversationId: string,
  content: string,
  excludeAiUserId?: string,
  requireAtMention = false,
): Promise<AiUserHandoff | undefined> {
  const main = await resolveEffectiveMainAiUser(conversationId);
  const memberships = await listConversationAiUserRows(conversationId);
  const candidates: PersonaMentionCandidate[] = [
    ...(main && main.id !== excludeAiUserId
      ? [
          {
            id: main.id,
            identity: main.name,
            handoff: { kind: 'main' } as const,
          },
        ]
      : []),
    ...memberships
      .filter(
        ({ aiUser, membership }) =>
          aiUser.enabled === 1 &&
          membership.status === 'active' &&
          aiUser.id !== main?.id &&
          aiUser.id !== excludeAiUserId,
      )
      .map(({ aiUser }) => ({
        id: aiUser.id,
        identity: aiUser.name,
        handoff: { kind: 'select', aiUserId: aiUser.id } as const,
      })),
  ];
  return resolvePersonaMention(content, candidates, requireAtMention);
}

/** Resolve a name against the supplied active, unambiguous persona roster. */
export function resolvePersonaMention(
  content: string,
  candidates: PersonaMentionCandidate[],
  requireAtMention = false,
): AiUserHandoff | undefined {
  if (candidates.length === 0) return undefined;
  const normalized = normalizedMentionText(content);
  const aliasCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const firstName = normalizedMentionText(candidate.identity).split(/\s+/)[0];
    if (firstName && firstName.length >= 3) {
      aliasCounts.set(firstName, (aliasCounts.get(firstName) ?? 0) + 1);
    }
  }

  let resolved:
    | { index: number; aliasLength: number; handoff: AiUserHandoff }
    | undefined;
  for (const candidate of candidates) {
    const fullName = normalizedMentionText(candidate.identity).trim();
    const aliases = [fullName];
    const firstName = fullName.split(/\s+/)[0];
    if (
      firstName &&
      firstName.length >= 3 &&
      aliasCounts.get(firstName) === 1
    ) {
      aliases.push(firstName);
    }
    for (const alias of aliases) {
      if (!alias) continue;
      const escapedAlias = escapeRegex(alias);
      const matches = requireAtMention
        ? [
            ...normalized.matchAll(
              new RegExp(`@${escapedAlias}(?=$|[^a-z0-9])`, 'g'),
            ),
            ...normalized.matchAll(
              new RegExp(`^\\s*${escapedAlias}(?=$|[^a-z0-9])`, 'g'),
            ),
          ]
        : [
            ...normalized.matchAll(
              new RegExp(`(^|[^a-z0-9])${escapedAlias}(?=$|[^a-z0-9])`, 'g'),
            ),
          ];
      for (const match of matches) {
        const leadingOffset = requireAtMention
          ? match[0].startsWith('@')
            ? 1
            : match[0].search(/\S/)
          : match[1].length;
        const index = (match.index ?? 0) + Math.max(0, leadingOffset);
        if (
          !resolved ||
          index > resolved.index ||
          (index === resolved.index && alias.length > resolved.aliasLength)
        ) {
          resolved = {
            index,
            aliasLength: alias.length,
            handoff: candidate.handoff,
          };
        }
      }
    }
  }
  return resolved?.handoff;
}

/** Resolve an explicit talking-stick name against the active exact roster. */
export async function resolveTalkingStickTarget(
  conversationId: string,
  decision: TalkingStickDecision,
  excludeAiUserId?: string,
): Promise<AiUserHandoff> {
  if (decision.kind !== 'select' || !decision.personaName) return decision;
  const target = normalizedMentionText(decision.personaName).trim();
  const main = await resolveEffectiveMainAiUser(conversationId);
  if (
    main &&
    main.id !== excludeAiUserId &&
    normalizedMentionText(main.name).trim() === target
  ) {
    return { kind: 'main' };
  }
  const memberships = await listConversationAiUserRows(conversationId);
  const invited = memberships.find(
    ({ aiUser, membership }) =>
      aiUser.enabled === 1 &&
      membership.status === 'active' &&
      aiUser.id !== main?.id &&
      aiUser.id !== excludeAiUserId &&
      normalizedMentionText(aiUser.name).trim() === target,
  );
  return invited
    ? { kind: 'select', aiUserId: invited.aiUser.id }
    : { kind: 'pass' };
}

export interface AiUserRound {
  messages: AiUserTurnMessage[];
  nextDecision?: AiUserHandoff;
  skipped?: boolean;
  skippedBy?: string[];
  /** Start a fresh participant context after a new human message interrupts the discussion. */
  resetContext?: boolean;
}

/**
 * An explicit name handoff wakes a participant that withdrew with a stop
 * marker: a stop means "done unless addressed".
 */
export function reinstateAddressedPersona(
  stoppedPersonaIds: Set<string>,
  marker: AiUserHandoff,
  mainPersonaId: string | undefined,
  speakerId: string,
): void {
  const targetId =
    marker.kind === 'main'
      ? mainPersonaId
      : marker.kind === 'select'
        ? marker.aiUserId
        : undefined;
  if (targetId && targetId !== speakerId) stoppedPersonaIds.delete(targetId);
}

/** A named invite may answer first, but a new human prompt must still reach main. */
export function initialPersonaHandoffAfterHumanPrompt(
  addressedInvitedPersona: boolean,
  activePersonaIds: readonly string[],
  mainPersonaId: string | undefined,
  fallback: AiUserHandoff,
): AiUserHandoff {
  return addressedInvitedPersona &&
    mainPersonaId &&
    activePersonaIds.includes(mainPersonaId)
    ? { kind: 'main' }
    : fallback;
}

/** Autonomous persona-to-persona discussion requires two distinct speakers. */
function hasAutonomousPersonaQuorum(
  activePersonaIds: readonly string[],
): boolean {
  return new Set(activePersonaIds).size >= 2;
}

/** The default chat agent may hand its completed turn to one newly active persona once. */
export function canAdvancePersonaDiscussion(
  activePersonaIds: readonly string[],
  mainPersonaId: string | undefined,
  initialDefaultAgentBoundary: boolean,
  continuousLoopEnabled = true,
  mainFollowUpOwed = false,
): boolean {
  // Main gets one closing turn to read the first invited reply to a human
  // prompt, even if it withdrew or the continuous loop is off (it may skip).
  if (mainFollowUpOwed) return true;
  // Disabling continuous discussion still permits the first handoff after a
  // new human prompt. Otherwise an active invited participant never receives
  // the message at all unless the human explicitly names them. Subsequent
  // persona-to-persona rounds remain opt-in.
  if (!continuousLoopEnabled && !initialDefaultAgentBoundary) return false;
  // A main participant that withdrew with a stop marker has already left the
  // active list, but the remaining invited participant still gets that first
  // handoff.
  return (
    hasAutonomousPersonaQuorum(activePersonaIds) ||
    (initialDefaultAgentBoundary &&
      activePersonaIds.some((id) => id !== mainPersonaId))
  );
}

/**
 * Keep handing the conversation to the active after-main roster. The human
 * Stop is the only normal completion condition. A marked skipped round keeps
 * cycling, while an unmarked empty round is a safety exit for failures.
 */
export async function runContinuousAiUserTurns(options: {
  initialContext: string;
  initialMessageId?: string;
  initialDecision: AiUserHandoff;
  shouldStop: () => boolean;
  waitForPlayback?: (messageId: string) => Promise<void>;
  activeParticipantIds?: string[] | (() => string[]);
  /**
   * Called immediately before the loop would terminate. Returning true keeps
   * the loop alive for another boundary (for example, when a human prompt was
   * atomically admitted just before the consumer closed).
   */
  beforeFinish?: () => Promise<boolean>;
  runRound: (
    coordinatorResponse: string,
    decision: AiUserHandoff,
  ) => Promise<AiUserTurnMessage[] | AiUserRound>;
}): Promise<'stopped' | 'empty' | 'all-skipped'> {
  let context = options.initialContext;
  let decision = options.initialDecision;
  let playbackMessageId = options.initialMessageId;
  const skippedThisCycle = new Set<string>();
  const shouldContinueAtFinish = async () => {
    if ((await options.beforeFinish?.()) !== true) return false;
    // Microtasks alone never let timers or I/O run, so a consumer that keeps
    // answering true must not be able to starve the event loop.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return true;
  };

  while (true) {
    if (options.shouldStop()) {
      if (await shouldContinueAtFinish()) continue;
      return 'stopped';
    }
    if (playbackMessageId && options.waitForPlayback) {
      await options.waitForPlayback(playbackMessageId);
      if (options.shouldStop()) {
        if (await shouldContinueAtFinish()) continue;
        return 'stopped';
      }
      playbackMessageId = undefined;
    }
    const result = await options.runRound(context, decision);
    const { messages, nextDecision, skipped, resetContext } = Array.isArray(
      result,
    )
      ? {
          messages: result,
          nextDecision: undefined,
          skipped: false,
          resetContext: false,
        }
      : result;
    if (options.shouldStop()) {
      if (await shouldContinueAtFinish()) continue;
      return 'stopped';
    }
    if (messages.length === 0 && !skipped) {
      if (await shouldContinueAtFinish()) continue;
      return 'empty';
    }
    if (messages.length > 0) {
      skippedThisCycle.clear();
      const completedTurns = messages
        .map((message) => `${message.sender_name}: ${message.content}`)
        .join('\n\n');
      context = resetContext
        ? completedTurns
        : [context, completedTurns].filter(Boolean).join('\n\n');
    }
    for (const aiUserId of Array.isArray(result)
      ? []
      : (result.skippedBy ?? [])) {
      skippedThisCycle.add(aiUserId);
    }
    const activeParticipantIds =
      typeof options.activeParticipantIds === 'function'
        ? options.activeParticipantIds()
        : options.activeParticipantIds;
    if (
      activeParticipantIds?.length &&
      activeParticipantIds.every((id) => skippedThisCycle.has(id))
    ) {
      if (await shouldContinueAtFinish()) {
        skippedThisCycle.clear();
        continue;
      }
      return 'all-skipped';
    }
    decision = nextDecision ?? { kind: 'pass' };
    playbackMessageId = messages[messages.length - 1]?.id;
  }
}

export function resolvePersonaTriggerAttribution(options: {
  publicVisitor?: unknown;
  triggeredByUserId?: string | null;
  triggerSource?: 'user' | 'agent' | 'schedule' | 'public' | 'system';
}) {
  return options.publicVisitor
    ? { triggeredByUserId: null, triggerSource: 'public' as const }
    : {
        triggeredByUserId: options.triggeredByUserId ?? null,
        triggerSource:
          options.triggerSource ??
          (options.triggeredByUserId ? ('user' as const) : ('system' as const)),
      };
}

/** An explicit `null` sender means no human preferences; only `undefined` falls back to the trigger user. */
function resolvePersonaSenderUserId(options: {
  publicVisitor?: unknown;
  senderUserId?: string | null;
  triggeredByUserId?: string | null;
}): string | null {
  if (options.publicVisitor) return null;
  return options.senderUserId !== undefined
    ? options.senderUserId
    : (options.triggeredByUserId ?? null);
}

/** Run a subsequent autonomous turn for the conversation's main persona. */
export async function runMainAiUserFollowUp(options: {
  group: RegisteredGroup;
  conversationId: string;
  humanPrompt: string;
  humanName?: string;
  participantContext: string;
  deps?: McpServerDeps;
  shouldStop?: () => boolean;
  liveMode?: boolean;
  /** Persona Live Mode: this turn's reply is read aloud. */
  personaVoice?: boolean;
  onTurnStarted?: (message: AiUserTurnMessage) => void;
  onTurnChunk?: (messageId: string, content: string) => void;
  onTurnFinished?: (
    messageId: string,
    failed: boolean,
    skipped?: boolean,
    message?: AiUserTurnMessage,
  ) => void;
  onTurnSkipped?: (aiUserId: string) => void;
  onTurnStopped?: (aiUserId: string) => void;
  shouldYieldToUser?: () => Promise<boolean>;
  onTurnYielded?: (telemetry?: Record<string, unknown>) => void;
  onMessage: (message: AiUserTurnMessage) => void;
  publicVisitor?: PublicPersonaExecution;
  senderUserId?: string | null;
  triggeredByUserId?: string | null;
  triggerSource?: 'user' | 'agent' | 'schedule' | 'public' | 'system';
  /** Stable caller-owned identity for durable autonomous turn recovery. */
  runId?: string;
}): Promise<AiUserTurnMessage | undefined> {
  if (options.shouldStop?.()) return undefined;
  const { mainAiUserContext: main, mainPersonaGeneration } =
    await resolveMainPersonaSession(options.conversationId, options.group);
  if (!main) return undefined;
  if (options.publicVisitor && options.publicVisitor.callBudget.remaining <= 0)
    return undefined;

  const runId = options.runId ?? randomUUID();
  const allowed = resolveAllowedPersonaTools(
    options.group.folder,
    main.aiUser.tools,
  );
  await insertAiTurnRun({
    id: runId,
    conversationId: options.conversationId,
    aiUserId: main.aiUser.id,
    phase: 'after',
    presetId: main.aiUser.presetId,
    effectiveToolsets: allowed.toolsets,
    decision: 'pass',
    status: 'queued',
    stopReason: null,
    createdAt: new Date().toISOString(),
  });

  const startedAt = new Date().toISOString();
  const streamParser = new TalkingStickStreamParser();
  const attributionParser = new PersonaSelfAttributionStreamParser(main.aiUser);
  options.onTurnStarted?.({
    id: runId,
    group_folder: options.group.folder,
    role: 'assistant',
    content: '',
    sender_name: main.aiUser.identity,
    senderUserId: `ai:${main.aiUser.id}`,
    source: options.publicVisitor ? 'public' : 'web',
    publicInteractionId: options.publicVisitor?.interactionId,
    created_at: startedAt,
    conversation_id: options.conversationId,
    speechProfile: speechProfileForAiUser(main.aiUser),
  });

  try {
    await updateAiTurnRun(runId, { status: 'running', startedAt });
    const publicPreset = options.publicVisitor
      ? getRuntimeCatalog().presets.find(
          (preset) => preset.id === main.aiUser.presetId,
        )
      : undefined;
    const publicBaseRuntime = publicPreset
      ? resolveRuntimeSelection(publicPreset.selection)
      : undefined;
    const mainRuntime = options.publicVisitor
      ? forcePublicPersonaRuntime(
          publicBaseRuntime || {},
          `ai-main:${main.aiUser.id}`,
        )
      : main.agentConfig;
    if (options.publicVisitor) {
      options.publicVisitor.callBudget.remaining -= 1;
    }
    const result = await runChatAgent(
      options.group,
      [
        `The human participant originally said:\n${formatPersonaConversationTurn(options.humanName ?? 'Human', 'human participant', options.humanPrompt)}`,
        `The invited participants most recently said:\n${options.participantContext}`,
        'Continue the autonomous discussion as the main participant. Respond to the invited participants and advance the discussion. Use the talking-stick controls to pass, skip one turn, or withdraw until the next human message.',
      ].join('\n\n'),
      `${options.group.folder}@web`,
      (chunk) => {
        if (chunk.type !== 'text' || options.shouldStop?.()) return;
        const visible = streamParser.push(chunk.content);
        const sanitized = attributionParser.push(visible);
        if (sanitized) options.onTurnChunk?.(runId, sanitized);
      },
      undefined,
      false,
      options.conversationId,
      undefined,
      {
        agent_cmd: mainRuntime.id,
        agentConfig: mainRuntime,
        model: mainRuntime.model,
        skipInitialLog: true,
        disableSteering: true,
        ephemeral: true,
        captureInspection: !options.publicVisitor,
        ...resolvePersonaTriggerAttribution(options),
        senderUserId: resolvePersonaSenderUserId(options),
        skipUserPreferences: Boolean(options.publicVisitor),
        excludeTrailingUserHistory: Boolean(options.publicVisitor),
        reasoning_effort: mainRuntime.reasoning_effort,
        liveMode: options.liveMode === true,
        personaVoice: options.personaVoice === true,
        systemPromptSuffix: main.systemPromptSuffix,
        mainPersonaGeneration,
        signal: options.publicVisitor?.signal,
        suppressPersonaProviderContext: Boolean(options.publicVisitor),
      },
      options.deps,
    );
    await updateAiTurnRun(runId, {
      inspection: result.inspection
        ? {
            ...result.inspection,
            handoff: {
              kind: 'main',
              phase: 'after',
              participantContext: options.participantContext,
            },
          }
        : null,
    });

    if (options.shouldStop?.()) {
      await updateAiTurnRun(runId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        stopReason: 'user-stopped',
      });
      options.onTurnFinished?.(runId, true);
      return undefined;
    }
    const streamTail =
      attributionParser.push(streamParser.finish()) +
      attributionParser.finish();
    if (streamTail) options.onTurnChunk?.(runId, streamTail);
    if (!result.result?.trim())
      throw new Error('Main AI user produced no response');
    if (await options.shouldYieldToUser?.()) {
      const completedAt = new Date().toISOString();
      await updateAiTurnRun(runId, {
        status: 'completed',
        completedAt,
        decision: 'user-priority',
        stopReason: 'user-priority',
      });
      options.onTurnYielded?.(result.telemetry);
      options.onTurnFinished?.(runId, false, true);
      return undefined;
    }

    const selectedEmote = finishPersonaEmoteTurn(
      result.result,
      main.emoteNames,
    );
    const visibleTurn = parseTalkingStickDecision(selectedEmote.content);
    const speechTurn = parseTalkingStickDecision(selectedEmote.speechText);
    let cleaned = stripPersonaSelfAttribution(visibleTurn.content, main.aiUser);
    let speechText = stripPersonaSelfAttribution(
      speechTurn.content,
      main.aiUser,
    );
    if (visibleTurn.decision.kind === 'skip' && !cleaned.trim()) {
      const completedAt = new Date().toISOString();
      await updateAiTurnRun(runId, {
        status: 'completed',
        completedAt,
        decision: 'skip',
        stopReason: 'persona-skipped',
      });
      options.onTurnSkipped?.(main.aiUser.id);
      options.onTurnFinished?.(runId, false, true);
      return undefined;
    }
    if (visibleTurn.decision.kind === 'stop' && !cleaned.trim()) {
      const completedAt = new Date().toISOString();
      await updateAiTurnRun(runId, {
        status: 'completed',
        completedAt,
        decision: 'stop',
        stopReason: 'persona-stopped',
      });
      options.onTurnStopped?.(main.aiUser.id);
      options.onTurnFinished?.(runId, false, true);
      return undefined;
    }
    if (!cleaned.trim())
      throw new Error('Main AI user produced no visible response');
    if (options.publicVisitor) {
      cleaned = await options.publicVisitor.transformOutput(cleaned);
      speechText = cleaned;
    }

    const createdAt = new Date().toISOString();
    const message = (await saveChatMessage({
      id: runId,
      group_folder: options.group.folder,
      role: 'assistant',
      content: cleaned,
      sender_name: main.aiUser.identity,
      senderUserId: `ai:${main.aiUser.id}`,
      source: options.publicVisitor ? 'public' : 'web',
      publicInteractionId: options.publicVisitor?.interactionId,
      created_at: createdAt,
      conversation_id: options.conversationId,
      telemetry: result.telemetry,
      emote: selectedEmote.emote,
      speechText,
    })) as AiUserTurnMessage;
    message.speechProfile = speechProfileForAiUser(main.aiUser);
    message.talkingStickDecision = visibleTurn.decision;
    appendChatTranscriptEntry(options.group.folder, options.conversationId, {
      id: runId,
      type: 'ai_user_attribution',
      role: 'assistant',
      content: '',
      agent_name: `ai-main:${main.aiUser.id}`,
      sender_name: main.aiUser.identity,
      senderUserId: `ai:${main.aiUser.id}`,
      emote: selectedEmote.emote,
      speechText,
      source: options.publicVisitor ? 'public' : 'web',
      publicInteractionId: options.publicVisitor?.interactionId,
      created_at: createdAt,
    });
    options.onMessage(message);
    await updateAiTurnRun(runId, {
      status: 'completed',
      completedAt: createdAt,
      decision: 'pass',
    });
    options.onTurnFinished?.(runId, false, false, message);
    return message;
  } catch (error: any) {
    await updateAiTurnRun(runId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      stopReason: error?.message || 'unknown-error',
    });
    options.onTurnFinished?.(runId, true);
    logger.warn(
      {
        conversationId: options.conversationId,
        aiUserId: main.aiUser.id,
        error: error?.message || String(error),
      },
      'Main virtual participant follow-up failed',
    );
    return undefined;
  }
}

export async function runAiUserPhase(options: {
  phase: 'before' | 'after' | 'any';
  group: RegisteredGroup;
  conversationId: string;
  humanPrompt: string;
  humanName?: string;
  mainParticipantName?: string;
  coordinatorResponse?: string | null;
  decision?: TalkingStickDecision;
  startAfterAiUserId?: string;
  deps?: McpServerDeps;
  shouldStop?: () => boolean;
  liveMode?: boolean;
  /** Persona Live Mode: this turn's reply is read aloud. */
  personaVoice?: boolean;
  onTurnStarted?: (message: AiUserTurnMessage) => void;
  onTurnChunk?: (messageId: string, content: string) => void;
  onTurnFinished?: (
    messageId: string,
    failed: boolean,
    skipped?: boolean,
    message?: AiUserTurnMessage,
  ) => void;
  onTurnSkipped?: (aiUserId: string) => void;
  onTurnStopped?: (aiUserId: string) => void;
  shouldYieldToUser?: () => Promise<boolean>;
  onTurnYielded?: () => void;
  onTurnComplete?: (
    message: AiUserTurnMessage,
  ) => Promise<boolean | void> | boolean | void;
  onMessage: (message: AiUserTurnMessage) => void;
  publicVisitor?: PublicPersonaExecution;
  senderUserId?: string | null;
  triggeredByUserId?: string | null;
  triggerSource?: 'user' | 'agent' | 'schedule' | 'public' | 'system';
}): Promise<AiUserTurnMessage[]> {
  const emitted: AiUserTurnMessage[] = [];
  // Freeze provider history at the phase's causal boundary. A persona can
  // wait for a runtime slot while later human prompts are persisted. Reading
  // the transcript only when that delayed runtime starts would let it answer
  // those future prompts in this older turn; the real next run would then
  // answer them again. The explicit persona prompt already carries the
  // current human turn, so exclude that trailing user row from the snapshot.
  const causalHistory = await getLlmHistory(
    options.group.folder,
    options.conversationId,
    true,
  );
  const mainAiUser = await resolveEffectiveMainAiUser(
    options.conversationId,
    options.group,
  );
  const memberships = await listConversationAiUserRows(options.conversationId);
  const phaseActive = memberships.filter(
    ({ aiUser, membership }) =>
      aiUser.enabled === 1 &&
      membership.status === 'active' &&
      aiUser.id !== mainAiUser?.id &&
      (options.phase === 'any' || aiUser.turn === options.phase),
  );
  const selectedAiUserId =
    options.decision?.kind === 'select' ? options.decision.aiUserId : undefined;
  const selected = selectedAiUserId
    ? phaseActive.filter(({ aiUser }) => aiUser.id === selectedAiUserId)
    : (() => {
        const previousIndex = options.startAfterAiUserId
          ? phaseActive.findIndex(
              ({ aiUser }) => aiUser.id === options.startAfterAiUserId,
            )
          : -1;
        return previousIndex < 0
          ? phaseActive
          : [
              ...phaseActive.slice(previousIndex + 1),
              ...phaseActive.slice(0, previousIndex + 1),
            ];
      })();
  // A stale or hallucinated selection must not turn an active roster into an
  // empty handoff. Fall back to every active participant for this phase.
  const active = (selected.length > 0 ? selected : phaseActive).slice(
    0,
    MAX_AI_TURNS_PER_PHASE,
  );
  const handoffFields = {
    conversationId: options.conversationId,
    phase: options.phase,
    decision: options.decision?.kind ?? 'pass',
    selectedAiUserId,
    eligibleAiUserIds: phaseActive.map(({ aiUser }) => aiUser.id),
    runningAiUserIds: active.map(({ aiUser }) => aiUser.id),
  };
  if (handoffFields.decision === 'pass') {
    logger.debug(handoffFields, 'Resolved virtual participant handoff');
  } else {
    logger.info(handoffFields, 'Resolved virtual participant handoff');
  }
  if (options.decision?.kind === 'stop') return emitted;
  if (active.length === 0) return emitted;

  const roster = [
    `- ${options.humanName ?? 'Human'} (human participant)`,
    ...(mainAiUser?.enabled
      ? [
          `- Name: ${mainAiUser.name}; identity: ${mainAiUser.identity}; role: main participant; status: active`,
        ]
      : options.mainParticipantName
        ? [`- ${options.mainParticipantName} (main agent, active)`]
        : []),
    ...memberships.map(
      ({ aiUser, membership }) =>
        `- Name: ${aiUser.name}; identity: ${aiUser.identity}; turn: ${aiUser.turn}; status: ${membership.status}`,
    ),
  ].join('\n');

  for (const { aiUser } of active) {
    if (options.shouldStop?.()) break;
    if (
      options.publicVisitor &&
      options.publicVisitor.callBudget.remaining <= 0
    )
      break;
    // Re-read membership immediately before the turn so pause takes effect at a boundary.
    const current = (
      await listConversationAiUserRows(options.conversationId)
    ).find((entry) => entry.aiUser.id === aiUser.id);
    if (!current || current.membership.status !== 'active') continue;

    const preset = getRuntimeCatalog().presets.find(
      (item) => item.id === aiUser.presetId,
    );
    const runId = randomUUID();
    const allowed = resolveAllowedPersonaTools(
      options.group.folder,
      aiUser.tools,
    );
    const effectivePhase =
      options.phase === 'any' ? aiUser.turn : options.phase;
    await insertAiTurnRun({
      id: runId,
      conversationId: options.conversationId,
      aiUserId: aiUser.id,
      phase: effectivePhase,
      presetId: aiUser.presetId,
      effectiveToolsets: allowed.toolsets,
      decision: options.decision?.kind ?? 'pass',
      status: preset ? 'queued' : 'failed',
      stopReason: preset ? null : 'preset-unavailable',
      createdAt: new Date().toISOString(),
    });
    if (!preset) continue;

    const startedAt = new Date().toISOString();
    const streamParser = new TalkingStickStreamParser();
    const attributionParser = new PersonaSelfAttributionStreamParser(aiUser);
    options.onTurnStarted?.({
      id: runId,
      group_folder: options.group.folder,
      role: 'assistant',
      content: '',
      sender_name: aiUser.identity,
      senderUserId: `ai:${aiUser.id}`,
      source: options.publicVisitor ? 'public' : 'web',
      publicInteractionId: options.publicVisitor?.interactionId,
      created_at: startedAt,
      conversation_id: options.conversationId,
      speechProfile: speechProfileForAiUser(aiUser),
    });
    try {
      await updateAiTurnRun(runId, { status: 'running', startedAt });
      const parsed = parseAiUserPrompt(
        await readAiUserPrompt(aiUser.promptPath),
      );
      const emoteNames = (aiUser.publishedEmotes ?? []).map(
        (emote) => emote.name,
      );
      const runtime = resolveRuntimeSelection(preset.selection);
      const agentId = `ai:${aiUser.id}`;
      let isolatedRuntime = {
        ...runtime,
        id: agentId,
        sessionFamily: `${runtime.sessionFamily || runtime.agentCmd || runtime.id}:ai:${aiUser.id}`,
        allowedToolNames: options.publicVisitor ? [] : allowed.toolNames,
      } as any;
      if (options.publicVisitor)
        isolatedRuntime = forcePublicPersonaRuntime(runtime, agentId);
      const phaseReplies = emitted
        .map((message) =>
          formatPersonaConversationTurn(
            message.sender_name || 'Participant',
            'invited participant',
            message.content,
          ),
        )
        .join('\n\n');
      const conversationContext = [options.coordinatorResponse, phaseReplies]
        .filter((value): value is string => Boolean(value?.trim()))
        .join('\n\n');
      const context = [
        buildInvitedPersonaTurnPrompt(
          options.humanPrompt,
          conversationContext,
          options.humanName,
        ),
        `Talking-stick phase: ${options.phase}.`,
      ].join('\n\n');
      const leadingInstructions = [
        `# Virtual participant identity\n${parsed.body}`,
        `Your participant name is: ${aiUser.name}`,
        `Your visible identity is: ${parsed.identity}`,
        `Conversation participants:\n${roster}`,
      ];
      const trailingInstructions = [
        `Permitted toolsets: ${options.publicVisitor ? 'none' : allowed.toolsets.join(', ') || 'core only'}.`,
        'Naming an active persona by its exact name gives that persona the next turn.',
        personaTurnControlInstructions(emoteNames),
      ];
      // Permitted toolsets are bound when a warm process is created, so they
      // are part of the revision; the talking-stick phase varies per turn and
      // is sent in the per-turn prompt instead.
      const personaSessionRevision = createPersonaInstructionRevision([
        ...leadingInstructions,
        ...trailingInstructions,
      ]);
      const runAttempt = (prompt: string, attemptRuntime = isolatedRuntime) => {
        if (options.publicVisitor) {
          if (options.publicVisitor.callBudget.remaining <= 0)
            throw new Error('Public persona call cap reached');
          options.publicVisitor.callBudget.remaining -= 1;
        }
        return runChatAgent(
          options.group,
          prompt,
          `${options.group.folder}@web`,
          (chunk) => {
            if (chunk.type !== 'text' || options.shouldStop?.()) return;
            const visible = streamParser.push(chunk.content);
            const sanitized = attributionParser.push(visible);
            if (sanitized) options.onTurnChunk?.(runId, sanitized);
          },
          undefined,
          false,
          options.conversationId,
          undefined,
          {
            agent_cmd: attemptRuntime.id,
            agentConfig: attemptRuntime,
            model: attemptRuntime.model,
            skipInitialLog: true,
            disableSteering: true,
            ephemeral: true,
            captureInspection: !options.publicVisitor,
            skipUserPreferences: Boolean(options.publicVisitor),
            historyOverride: causalHistory,
            ...resolvePersonaTriggerAttribution(options),
            senderUserId: resolvePersonaSenderUserId(options),
            excludeTrailingUserHistory: Boolean(options.publicVisitor),
            reasoning_effort: attemptRuntime.reasoning_effort,
            liveMode: options.liveMode === true,
            personaVoice: options.personaVoice === true,
            signal: options.publicVisitor?.signal,
            suppressPersonaProviderContext: Boolean(options.publicVisitor),
            personaSessionRevision,
            systemPromptSuffix: [
              ...leadingInstructions,
              ...trailingInstructions,
            ].join('\n\n'),
          },
          options.deps,
        );
      };
      let result = await runAttempt(context);
      const firstInspection = result.inspection;
      const completion = inspectPersonaToolCompletion(
        firstInspection?.transcript ?? '',
      );
      if (
        !options.publicVisitor &&
        completion.usedTools &&
        !completion.hasFinalAssistantProse &&
        !options.shouldStop?.()
      ) {
        let ranCompletionPass = false;
        const recoveredToolOutput =
          result.result?.trim().slice(-12_000) || '(tool output unavailable)';
        const catalog = getRuntimeCatalog();
        const configuredCompletionRuntime = catalog.defaults.peekFiles
          ? resolveRuntimeSelection(catalog.defaults.peekFiles)
          : undefined;
        const completionBaseRuntime = [
          runtime,
          configuredCompletionRuntime,
          resolveRuntimeSelection(catalog.defaults.chat),
          ...getChatAgents(),
        ].find((agent) => agent && isDirectRuntime(agent) && agent.baseUrl);
        if (!completionBaseRuntime) {
          result = {
            ...result,
            result: `⚠️ ${aiUser.identity} completed tool calls but did not provide a final response.`,
          };
        } else {
          const completionRuntime = {
            ...completionBaseRuntime,
            id: `ai-completion:${aiUser.id}:${completionBaseRuntime.id}`,
            sessionFamily: `${completionBaseRuntime.sessionFamily || completionBaseRuntime.id}:ai-completion:${aiUser.id}`,
            allowedToolNames: [],
          } as any;
          ranCompletionPass = true;
          result = await runAttempt(
            [
              'Your previous tool-assisted attempt ended without a final visible response.',
              'Tools are disabled for this completion pass. Using only the recovered output below, answer the human as yourself with concise visible prose and finish with one talking-stick marker.',
              `Recovered tool output:\n${recoveredToolOutput}`,
            ].join('\n\n'),
            completionRuntime,
          );
        }
        if (ranCompletionPass && result.inspection && firstInspection) {
          result.inspection = {
            ...result.inspection,
            transcript: [
              firstInspection.transcript,
              result.inspection.transcript,
            ]
              .filter(Boolean)
              .join('\n'),
          };
        }
        const retryCompletion = ranCompletionPass
          ? inspectPersonaToolCompletion(result.inspection?.transcript ?? '')
          : undefined;
        if (
          retryCompletion?.usedTools &&
          !retryCompletion.hasFinalAssistantProse
        ) {
          result = {
            ...result,
            result: `⚠️ ${aiUser.identity} completed tool calls but did not provide a final response.`,
          };
        }
      }
      await updateAiTurnRun(runId, {
        inspection: result.inspection
          ? {
              ...result.inspection,
              handoff: {
                decision: options.decision ?? { kind: 'pass' },
                phase: effectivePhase,
                selectedAiUserId: selectedAiUserId ?? null,
                eligibleAiUserIds: phaseActive.map(
                  ({ aiUser: eligible }) => eligible.id,
                ),
                runningAiUserIds: active.map(
                  ({ aiUser: running }) => running.id,
                ),
                previousParticipantTurns: options.coordinatorResponse ?? null,
              },
            }
          : null,
      });
      if (options.shouldStop?.()) {
        await updateAiTurnRun(runId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          stopReason: 'user-stopped',
        });
        options.onTurnFinished?.(runId, true);
        break;
      }
      const streamTail =
        attributionParser.push(streamParser.finish()) +
        attributionParser.finish();
      if (streamTail) options.onTurnChunk?.(runId, streamTail);
      if (!result.result?.trim())
        throw new Error('AI user produced no response');
      if (await options.shouldYieldToUser?.()) {
        const completedAt = new Date().toISOString();
        await updateAiTurnRun(runId, {
          status: 'completed',
          completedAt,
          decision: 'user-priority',
          stopReason: 'user-priority',
        });
        options.onTurnYielded?.();
        options.onTurnFinished?.(runId, false, true);
        break;
      }
      const selectedEmote = finishPersonaEmoteTurn(result.result, emoteNames);
      const visibleTurn = parseTalkingStickDecision(selectedEmote.content);
      const speechTurn = parseTalkingStickDecision(selectedEmote.speechText);
      let visibleContent = stripPersonaSelfAttribution(
        visibleTurn.content,
        aiUser,
      );
      let speechContent = stripPersonaSelfAttribution(
        speechTurn.content,
        aiUser,
      );
      if (visibleTurn.decision.kind === 'skip' && !visibleContent.trim()) {
        const completedAt = new Date().toISOString();
        await updateAiTurnRun(runId, {
          status: 'completed',
          completedAt,
          decision: 'skip',
          stopReason: 'persona-skipped',
        });
        options.onTurnSkipped?.(aiUser.id);
        options.onTurnFinished?.(runId, false, true);
        continue;
      }
      if (visibleTurn.decision.kind === 'stop' && !visibleContent.trim()) {
        const completedAt = new Date().toISOString();
        await updateAiTurnRun(runId, {
          status: 'completed',
          completedAt,
          decision: 'stop',
          stopReason: 'persona-stopped',
        });
        options.onTurnStopped?.(aiUser.id);
        options.onTurnFinished?.(runId, false, true);
        continue;
      }
      if (!visibleContent.trim())
        throw new Error('AI user produced no visible response');
      if (options.publicVisitor) {
        visibleContent =
          await options.publicVisitor.transformOutput(visibleContent);
        speechContent = visibleContent;
      }
      const createdAt = new Date().toISOString();
      const message = (await saveChatMessage({
        id: runId,
        group_folder: options.group.folder,
        role: 'assistant',
        content: visibleContent,
        sender_name: aiUser.identity,
        senderUserId: `ai:${aiUser.id}`,
        source: options.publicVisitor ? 'public' : 'web',
        publicInteractionId: options.publicVisitor?.interactionId,
        created_at: createdAt,
        conversation_id: options.conversationId,
        telemetry: result.telemetry,
        emote: selectedEmote.emote,
        // The runtime is transcript-silent; this save is the one canonical
        // entry used by both live refetch and page reload.
        speechText: speechContent,
      })) as AiUserTurnMessage;
      message.speechProfile = speechProfileForAiUser(aiUser);
      message.talkingStickDecision = visibleTurn.decision;
      appendChatTranscriptEntry(options.group.folder, options.conversationId, {
        id: runId,
        type: 'ai_user_attribution',
        role: 'assistant',
        content: '',
        agent_name: `ai:${aiUser.id}`,
        sender_name: aiUser.identity,
        senderUserId: `ai:${aiUser.id}`,
        emote: selectedEmote.emote,
        speechText: speechContent,
        source: options.publicVisitor ? 'public' : 'web',
        publicInteractionId: options.publicVisitor?.interactionId,
        created_at: createdAt,
      });
      options.onMessage(message);
      emitted.push(message);
      await updateAiTurnRun(runId, {
        status: 'completed',
        completedAt: createdAt,
        decision: options.decision?.kind ?? 'pass',
      });
      options.onTurnFinished?.(runId, false, false, message);
      if (await options.onTurnComplete?.(message)) break;
    } catch (error: any) {
      await updateAiTurnRun(runId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        stopReason: error?.message || 'unknown-error',
      });
      options.onTurnFinished?.(runId, true);
      logger.warn(
        {
          conversationId: options.conversationId,
          aiUserId: aiUser.id,
          phase: options.phase,
          error: error?.message || String(error),
        },
        'Virtual participant turn failed',
      );
    }
  }
  return emitted;
}
