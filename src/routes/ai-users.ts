import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { Router } from 'express';
import multer from 'multer';
import { AVATAR_GENERATION_TIMEOUT_MS } from '../config.js';
import { isUniqueViolationError } from '../lib/db-errors.js';
import { logger } from '../logger.js';
import {
  requireAdmin,
  requireConversationAccess,
  type ConversationAccessLevel,
} from './_helpers.js';
import {
  deleteAiUserRow,
  deleteAiUserTeamRow,
  getAiUserRow,
  getAiUserTeamRow,
  getConversation,
  insertAiUserRow,
  insertAiUserTeamRow,
  inviteConversationAiUser,
  inviteConversationAiUserTeam,
  listAiUserRows,
  listAiUserTeamRows,
  listConversationAiUserRows,
  publishAiUserEmote,
  replaceAiUserTeamMembers,
  removeConversationAiUser,
  setConversationAiUserStatus,
  setMainConversationAiUser,
  unpublishAiUserEmote,
  updateAiUserRow,
  updateAiUserPersonaRow,
  updateAiUserTeamRow,
} from '../db.js';
import {
  directRuntimeBaseUrl,
  getChatAgents,
  getRuntimeCatalog,
  isDirectRuntime,
  resolveRuntimeSelection,
  type ChatAgentOption,
} from '../lib/chat-agents.js';
import {
  generateImage,
  extensionForMime,
  sniffMime,
} from '../modules/image-generation/client.js';
import {
  decodeAvatarDataUrl,
  generateAvatarImage,
  normalizeAvatarGenerationError,
} from '../modules/image-generation/avatar-image.js';
import {
  directLlmFallbackOption,
  runDirectLlm,
} from '../modules/chat/direct-llm.js';
import { getConfigurableToolsets } from '../modules/tools/registry.js';
import { parseAiUserPrompt } from '../modules/ai-users/prompt.js';
import {
  normalizeAvatarPromptDraft,
  normalizePersonaDraft,
} from '../modules/ai-users/drafting.js';
import {
  getAvatarGenerationState,
  startAvatarGeneration,
} from '../modules/ai-users/avatar-generation.js';
import {
  ensureAiUserAvatarThumbnail,
  ensureAiUserEmoteThumbnail,
} from '../modules/ai-users/avatar-thumbnail.js';
import {
  readAiUserPrompt,
  readAiUserImageReference,
  discardAiUserAvatarCandidate,
  findAiUserAvatarCandidate,
  normalizeEmoteName,
  removeAiUserEmoteAsset,
  removeAiUserFiles,
  resolveAiUserPath,
  promoteAiUserAvatarCandidate,
  writeAiUserAvatar,
  writeAiUserAvatarCandidate,
  writeImmutableAiUserEmote,
  writeAiUserPrompt,
  writeAiUserVoiceStyle,
  type AiUserEmoteAsset,
} from '../modules/ai-users/storage.js';
import { SUPERTONIC_LANGUAGES } from '../modules/tts/config.js';
import { resolveEffectiveMainAiUser } from '../modules/ai-users/orchestrator.js';
import type { MainAiUserSelection } from '../types.js';
import {
  importVoiceStyle,
  listTtsVoices,
  personaVoiceId,
  validateVoiceStyleJson,
} from '../modules/tts/voice-styles.js';

export const aiUsersAdminRouter = Router();
export const conversationAiUsersRouter = Router();
const voiceStyleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 },
});

/** Persona names drive @mention matching and menu labels; cap them like teams. */
const AI_USER_NAME_MAX_LENGTH = 120;

function findPreset(presetId: string) {
  return getRuntimeCatalog().presets.find((preset) => preset.id === presetId);
}

/** Resolve the default chat model onto an HTTP-capable binding for short admin drafting calls. */
function getDraftingAgent(): ChatAgentOption | undefined {
  const defaultSelection = getRuntimeCatalog().defaults.chat;
  const resolved = resolveRuntimeSelection(defaultSelection);
  if (
    resolved.model &&
    isDirectRuntime(resolved) &&
    directRuntimeBaseUrl(resolved)
  )
    return resolved;
  return getChatAgents().find(
    (agent) =>
      agent.modelId === defaultSelection.modelId &&
      !!agent.model &&
      isDirectRuntime(agent) &&
      !!directRuntimeBaseUrl(agent),
  );
}

async function runDraftingPrompt(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const agent = getDraftingAgent();
  if (!agent?.model) {
    const error = new Error(
      'The default chat model has no HTTP-capable runtime for drafting',
    );
    (error as any).status = 503;
    throw error;
  }
  const response = await runDirectLlm(
    systemPrompt,
    userPrompt,
    agent.model,
    () => {},
    [],
    [],
    {
      wireApi: agent.wireApi,
      reasoning_effort: agent.reasoning_effort,
      temperature: 0.35,
      max_tokens: agent.max_tokens,
      skipInitialLog: true,
      baseUrl: directRuntimeBaseUrl(agent),
      apiKey:
        agent.apiKey ||
        agent.env?.OPENAI_API_KEY ||
        agent.env?.ANTHROPIC_API_KEY,
      agent_id: agent.id,
      fallback: directLlmFallbackOption(agent),
    },
  );
  if (!response.result?.trim())
    throw new Error('The default chat model returned no draft');
  return response.result;
}

function avatarUrl(row: {
  id: string;
  avatarPath: string | null;
  updatedAt?: string;
}): string | null {
  return row.avatarPath
    ? `/api/ai-users/${encodeURIComponent(row.id)}/avatar?thumbnail=1&v=${encodeURIComponent(row.updatedAt || row.avatarPath)}`
    : null;
}

async function presentAiUser(row: any) {
  let prompt = '';
  try {
    prompt = await readAiUserPrompt(row.promptPath);
  } catch {
    /* surfaced as empty content */
  }
  const emotes: AiUserEmoteAsset[] = row.publishedEmotes ?? [];
  const avatarCandidate = await findAiUserAvatarCandidate(row.id);
  const { publishedEmotes: _publishedEmotes, ...presentedRow } = row;
  return {
    ...presentedRow,
    enabled: row.enabled === 1 || row.enabled === true,
    prompt,
    avatarUrl: avatarUrl(row),
    avatarCandidateUrl: avatarCandidate
      ? `/api/ai-users/${encodeURIComponent(row.id)}/avatar-candidate?v=${encodeURIComponent(avatarCandidate.version)}`
      : null,
    emotes: emotes.map((emote) => ({
      name: emote.name,
      url: `/api/ai-users/${encodeURIComponent(row.id)}/emotes/${encodeURIComponent(emote.name)}?thumbnail=1&v=${encodeURIComponent(emote.version)}`,
    })),
  };
}

aiUsersAdminRouter.get('/admin/ai-users', requireAdmin, async (_req, res) => {
  res.json(await Promise.all((await listAiUserRows()).map(presentAiUser)));
});

function parseTeamMemberIds(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    value.some((id) => typeof id !== 'string' || !id)
  )
    return null;
  return [...new Set(value)];
}

async function validateTeamMembers(memberIds: string[]): Promise<boolean> {
  const known = new Set((await listAiUserRows()).map((row) => row.id));
  return memberIds.every((id) => known.has(id));
}

function isUniqueTeamNameError(error: unknown): boolean {
  const candidate = error as { message?: string };
  return (
    isUniqueViolationError(error) ||
    /uq_ai_user_teams_name|unique constraint/i.test(candidate?.message || '')
  );
}

aiUsersAdminRouter.get(
  '/admin/ai-user-teams',
  requireAdmin,
  async (_req, res) => {
    res.json(await listAiUserTeamRows());
  },
);

aiUsersAdminRouter.post(
  '/admin/ai-user-teams',
  requireAdmin,
  async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description =
      typeof req.body?.description === 'string'
        ? req.body.description.trim()
        : '';
    const memberIds = parseTeamMemberIds(req.body?.memberIds ?? []);
    if (!name || name.length > 120)
      return res.status(400).json({
        error: 'Team name is required and must be at most 120 characters',
      });
    if (description.length > 2_000)
      return res
        .status(400)
        .json({ error: 'Team description must be at most 2000 characters' });
    if (!memberIds)
      return res
        .status(400)
        .json({ error: 'memberIds must be an array of AI user IDs' });
    if (!(await validateTeamMembers(memberIds)))
      return res.status(400).json({
        error: 'Every team member must reference an existing AI user',
      });
    const now = new Date().toISOString();
    try {
      const team = await insertAiUserTeamRow({
        id: randomUUID(),
        name,
        description,
        createdAt: now,
        updatedAt: now,
      });
      await replaceAiUserTeamMembers(team.id, memberIds);
      res.status(201).json(await getAiUserTeamRow(team.id));
    } catch (error) {
      if (isUniqueTeamNameError(error))
        return res
          .status(409)
          .json({ error: 'A team with this name already exists' });
      throw error;
    }
  },
);

aiUsersAdminRouter.patch(
  '/admin/ai-user-teams/:id',
  requireAdmin,
  async (req, res) => {
    const existing = await getAiUserTeamRow(req.params.id);
    if (!existing)
      return res.status(404).json({ error: 'AI user team not found' });
    const name =
      req.body?.name === undefined
        ? existing.name
        : typeof req.body.name === 'string'
          ? req.body.name.trim()
          : '';
    const description =
      req.body?.description === undefined
        ? existing.description
        : typeof req.body.description === 'string'
          ? req.body.description.trim()
          : '';
    const memberIds =
      req.body?.memberIds === undefined
        ? existing.memberIds
        : parseTeamMemberIds(req.body.memberIds);
    if (!name || name.length > 120)
      return res.status(400).json({
        error: 'Team name is required and must be at most 120 characters',
      });
    if (description.length > 2_000)
      return res
        .status(400)
        .json({ error: 'Team description must be at most 2000 characters' });
    if (!memberIds)
      return res
        .status(400)
        .json({ error: 'memberIds must be an array of AI user IDs' });
    if (!(await validateTeamMembers(memberIds)))
      return res.status(400).json({
        error: 'Every team member must reference an existing AI user',
      });
    try {
      await updateAiUserTeamRow(existing.id, {
        name,
        description,
        updatedAt: new Date().toISOString(),
      });
      await replaceAiUserTeamMembers(existing.id, memberIds);
      res.json(await getAiUserTeamRow(existing.id));
    } catch (error) {
      if (isUniqueTeamNameError(error))
        return res
          .status(409)
          .json({ error: 'A team with this name already exists' });
      throw error;
    }
  },
);

aiUsersAdminRouter.delete(
  '/admin/ai-user-teams/:id',
  requireAdmin,
  async (req, res) => {
    const existing = await getAiUserTeamRow(req.params.id);
    if (!existing)
      return res.status(404).json({ error: 'AI user team not found' });
    await deleteAiUserTeamRow(existing.id);
    res.json({ ok: true });
  },
);

aiUsersAdminRouter.get('/admin/tts/voices', requireAdmin, async (_req, res) => {
  res.json(await listTtsVoices());
});

function optionalVoice(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value))
    throw new Error('voiceId is invalid');
  return value;
}

function optionalVoiceLang(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (
    typeof value !== 'string' ||
    !(SUPERTONIC_LANGUAGES as readonly string[]).includes(value)
  )
    throw new Error('voiceLang is unsupported');
  return value;
}

aiUsersAdminRouter.post(
  '/admin/ai-users/draft-persona',
  requireAdmin,
  async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const currentPrompt =
      typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const guidance =
      typeof req.body?.guidance === 'string' ? req.body.guidance.trim() : '';
    if (currentPrompt.length > 30_000 || guidance.length > 8_000) {
      return res.status(400).json({
        error: 'Persona source or drafting instructions are too long',
      });
    }
    const availableTools = getConfigurableToolsets();
    try {
      const raw = await runDraftingPrompt(
        'You are an expert persona designer. Return only complete Markdown for a virtual participant, with valid YAML frontmatter and a specific behavioral instruction body. Never use code fences or commentary.',
        `Improve or create a complete virtual AI-user persona.

Required frontmatter schema:
---
identity: "Visible participant name and concise role"
turn: before | after
tools:
  - one of the allowed toolsets
---

Allowed toolsets: ${availableTools.join(', ') || '(none)'}.
Preserve sensible details from the current draft, but make the identity, expertise, perspective, boundaries, interaction style, and contribution criteria concrete. The persona participates in a multi-user conversation and must not impersonate the main agent or human users.

AI persona name: ${name || '(not supplied)'}
Human drafting instructions: ${guidance || '(none; improve completeness and specificity)'}
Current persona Markdown:
${currentPrompt || '(none)'}`,
      );
      res.json(normalizePersonaDraft(raw));
    } catch (error: any) {
      res
        .status(error?.status || 502)
        .json({ error: error?.message || 'Persona drafting failed' });
    }
  },
);

aiUsersAdminRouter.post(
  '/admin/ai-users/draft-avatar-prompt',
  requireAdmin,
  async (req, res) => {
    const persona =
      typeof req.body?.persona === 'string' ? req.body.persona.trim() : '';
    const guidance =
      typeof req.body?.guidance === 'string' ? req.body.guidance.trim() : '';
    if (!persona) return res.status(400).json({ error: 'persona is required' });
    if (persona.length > 30_000 || guidance.length > 8_000) {
      return res
        .status(400)
        .json({ error: 'Persona source or avatar instructions are too long' });
    }
    let parsed;
    try {
      parsed = parseAiUserPrompt(persona);
    } catch (error: any) {
      return res
        .status(400)
        .json({ error: error?.message || 'Persona Markdown is invalid' });
    }
    try {
      const raw = await runDraftingPrompt(
        'You write excellent prompts for square profile-avatar image generation. Return only the image prompt as plain text, with no label, quotes, Markdown fence, or commentary.',
        `Write a distinctive, visually coherent square profile portrait prompt for this virtual participant.

Identity: ${parsed.identity}
Persona:
${parsed.body}

Human visual direction: ${guidance || '(none)'}

Describe subject, composition, expression, wardrobe or symbolic details, art direction, lighting, palette, and a clean background. Avoid text, lettering, logos, watermarks, multiple people, and copyrighted characters.`,
      );
      res.json({ prompt: normalizeAvatarPromptDraft(raw) });
    } catch (error: any) {
      res
        .status(error?.status || 502)
        .json({ error: error?.message || 'Avatar prompt drafting failed' });
    }
  },
);

aiUsersAdminRouter.post('/admin/ai-users', requireAdmin, async (req, res) => {
  const { name, presetId, prompt, enabled = true } = req.body || {};
  if (typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'name is required' });
  if (name.trim().length > AI_USER_NAME_MAX_LENGTH)
    return res.status(400).json({
      error: `name must be at most ${AI_USER_NAME_MAX_LENGTH} characters`,
    });
  if (typeof presetId !== 'string' || !findPreset(presetId))
    return res
      .status(400)
      .json({ error: 'presetId must reference an enabled runtime preset' });
  if (typeof prompt !== 'string')
    return res.status(400).json({ error: 'prompt is required' });
  let parsed;
  try {
    parsed = parseAiUserPrompt(prompt);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
  let voiceId: string | null;
  let voiceLang: string | null;
  try {
    voiceId = optionalVoice(req.body?.voiceId);
    voiceLang = optionalVoiceLang(req.body?.voiceLang);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
  const id = randomUUID();
  const promptPath = await writeAiUserPrompt(id, prompt);
  const now = new Date().toISOString();
  const row = await insertAiUserRow({
    id,
    name: name.trim(),
    presetId,
    promptPath,
    avatarPath: null,
    identity: parsed.identity,
    turn: parsed.turn,
    tools: parsed.tools,
    voiceId,
    voiceLang,
    voiceStylePath: null,
    publishedEmotes: [],
    enabled: enabled === false ? 0 : 1,
    createdAt: now,
    updatedAt: now,
  });
  res.status(201).json(await presentAiUser(row));
});

aiUsersAdminRouter.patch(
  '/admin/ai-users/:id',
  requireAdmin,
  async (req, res) => {
    const existing = await getAiUserRow(String(req.params.id));
    if (!existing) return res.status(404).json({ error: 'AI user not found' });
    const name = req.body?.name === undefined ? existing.name : req.body.name;
    const presetId =
      req.body?.presetId === undefined ? existing.presetId : req.body.presetId;
    const prompt =
      req.body?.prompt === undefined
        ? await readAiUserPrompt(existing.promptPath)
        : req.body.prompt;
    if (typeof name !== 'string' || !name.trim())
      return res.status(400).json({ error: 'name is required' });
    if (name.trim().length > AI_USER_NAME_MAX_LENGTH)
      return res.status(400).json({
        error: `name must be at most ${AI_USER_NAME_MAX_LENGTH} characters`,
      });
    if (typeof presetId !== 'string' || !findPreset(presetId))
      return res
        .status(400)
        .json({ error: 'presetId must reference an enabled runtime preset' });
    if (typeof prompt !== 'string')
      return res.status(400).json({ error: 'prompt must be a string' });
    let parsed;
    try {
      parsed = parseAiUserPrompt(prompt);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
    let voiceId: string | null;
    let voiceLang: string | null;
    try {
      voiceId =
        req.body?.voiceId === undefined
          ? existing.voiceId
          : optionalVoice(req.body.voiceId);
      voiceLang =
        req.body?.voiceLang === undefined
          ? existing.voiceLang
          : optionalVoiceLang(req.body.voiceLang);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
    const promptPath = await writeAiUserPrompt(existing.id, prompt);
    const row = await updateAiUserPersonaRow(existing.id, {
      name: name.trim(),
      presetId,
      promptPath,
      identity: parsed.identity,
      turn: parsed.turn,
      tools: parsed.tools,
      voiceId,
      voiceLang,
      enabled:
        req.body?.enabled === undefined
          ? existing.enabled
          : req.body.enabled
            ? 1
            : 0,
      updatedAt: new Date().toISOString(),
    });
    res.json(await presentAiUser(row));
  },
);

aiUsersAdminRouter.post(
  '/admin/ai-users/:id/voice-style',
  requireAdmin,
  voiceStyleUpload.single('file'),
  async (req, res) => {
    const existing = await getAiUserRow(String(req.params.id));
    if (!existing) return res.status(404).json({ error: 'AI user not found' });
    if (!req.file?.buffer)
      return res
        .status(400)
        .json({ error: 'A Voice Builder JSON file is required' });
    try {
      validateVoiceStyleJson(req.file.buffer);
      const voiceId = personaVoiceId(existing.id);
      await importVoiceStyle(voiceId, req.file.buffer, true);
      const voiceStylePath = await writeAiUserVoiceStyle(
        existing.id,
        req.file.buffer,
      );
      const row = await updateAiUserRow(existing.id, {
        voiceId,
        voiceStylePath,
        updatedAt: new Date().toISOString(),
      });
      return res.json(await presentAiUser(row));
    } catch (error: any) {
      return res
        .status(/under 1 MB/.test(error?.message || '') ? 413 : 400)
        .json({ error: error?.message || 'Voice style import failed' });
    }
  },
);

aiUsersAdminRouter.delete(
  '/admin/ai-users/:id',
  requireAdmin,
  async (req, res) => {
    const existing = await getAiUserRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'AI user not found' });
    await deleteAiUserRow(existing.id);
    await removeAiUserFiles(existing.id);
    res.json({ ok: true });
  },
);

const decodeAvatar = decodeAvatarDataUrl;

aiUsersAdminRouter.post(
  '/admin/ai-users/:id/avatar',
  requireAdmin,
  async (req, res) => {
    const existing = await getAiUserRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'AI user not found' });
    const decoded = await decodeAvatar(req.body?.dataUrl);
    if (!decoded)
      return res.status(400).json({
        error: 'A PNG, JPEG, or WebP data URL under 8 MB is required',
      });
    const avatarPath = await writeAiUserAvatar(
      existing.id,
      decoded.extension,
      decoded.data,
    );
    const row = await updateAiUserRow(existing.id, {
      avatarPath,
      updatedAt: new Date().toISOString(),
    });
    res.json(await presentAiUser(row));
  },
);

const avatarGenerationError = normalizeAvatarGenerationError;

aiUsersAdminRouter.get(
  '/admin/ai-users/:id/avatar/generation',
  requireAdmin,
  async (req, res) => {
    const existing = await getAiUserRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'AI user not found' });
    res.json(getAvatarGenerationState(existing.id));
  },
);

aiUsersAdminRouter.post(
  '/admin/ai-users/:id/avatar/generate',
  requireAdmin,
  async (req, res) => {
    const existing = await getAiUserRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'AI user not found' });
    const mode = req.body?.mode === undefined ? 'generate' : req.body.mode;
    if (mode !== 'generate' && mode !== 'modify') {
      return res
        .status(400)
        .json({ error: 'Avatar generation mode must be generate or modify' });
    }
    if (mode === 'modify' && !existing.avatarPath) {
      return res.status(400).json({
        error: 'Upload or generate a base avatar before modifying it',
      });
    }
    const prompt =
      typeof req.body?.prompt === 'string' && req.body.prompt.trim()
        ? req.body.prompt.trim()
        : `Square profile portrait avatar for ${existing.identity}. Clean background, distinctive and friendly.`;
    if (prompt.length > 4_000)
      return res.status(400).json({ error: 'Avatar prompt is too long' });
    // Providers do not expose a 400x400 generation canvas. Keep their original
    // 1024px square output, but use GPT Image's faster avatar-friendly quality.
    const state = startAvatarGeneration(existing.id, async () => {
      try {
        const current = await getAiUserRow(existing.id);
        if (!current) return;
        if (mode === 'modify' && !current.avatarPath) {
          throw new Error('The base avatar is no longer available');
        }
        const reference =
          mode === 'modify'
            ? await readAiUserImageReference(current.avatarPath!)
            : undefined;
        const generated = await generateAvatarImage({
          prompt,
          mode,
          reference,
          subject: 'persona',
        });
        if (!(await getAiUserRow(existing.id))) return;
        const candidate = await writeAiUserAvatarCandidate(
          existing.id,
          generated.extension,
          generated.data,
        );
        logger.info(
          { aiUserId: existing.id, avatarCandidatePath: candidate.path, mode },
          'AI user avatar generation completed',
        );
      } catch (error) {
        const normalized = avatarGenerationError(error);
        logger.warn(
          { aiUserId: existing.id, mode, err: normalized.message },
          'AI user avatar generation failed',
        );
        throw normalized;
      }
    });
    res.status(202).json(state);
  },
);

aiUsersAdminRouter.post(
  '/admin/ai-users/:id/avatar/candidate',
  requireAdmin,
  async (req, res) => {
    const existing = await getAiUserRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'AI user not found' });
    const choice = req.body?.choice;
    if (choice !== 'current' && choice !== 'candidate') {
      return res
        .status(400)
        .json({ error: 'Avatar choice must be current or candidate' });
    }
    if (choice === 'current') {
      if (!(await discardAiUserAvatarCandidate(existing.id))) {
        return res
          .status(404)
          .json({ error: 'No generated avatar candidate is available' });
      }
      return res.json(await presentAiUser(existing));
    }
    try {
      const avatarPath = await promoteAiUserAvatarCandidate(
        existing.id,
        existing.avatarPath,
      );
      const row = await updateAiUserRow(existing.id, {
        avatarPath,
        updatedAt: new Date().toISOString(),
      });
      if (!row)
        throw new Error(
          'AI user was removed before the avatar choice was saved',
        );
      return res.json(await presentAiUser(row));
    } catch (error: any) {
      return res
        .status(
          /No generated avatar candidate/.test(error?.message || '')
            ? 404
            : 500,
        )
        .json({ error: error?.message || 'Unable to save avatar choice' });
    }
  },
);

function emoteGenerationKey(aiUserId: string, emoteName: string): string {
  return `${aiUserId}:emote:${emoteName}`;
}

function emoteGenerationError(error: unknown): Error {
  const normalized = avatarGenerationError(error);
  return new Error(
    normalized.message
      .replace(/avatar generation/gi, 'emote generation')
      .replace(/Avatar generation/g, 'Emote generation'),
  );
}

aiUsersAdminRouter.get(
  '/admin/ai-users/:id/emotes/:name/generation',
  requireAdmin,
  async (req, res) => {
    const existing = await getAiUserRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'AI user not found' });
    let name: string;
    try {
      name = normalizeEmoteName(req.params.name);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
    res.json(getAvatarGenerationState(emoteGenerationKey(existing.id, name)));
  },
);

aiUsersAdminRouter.post(
  '/admin/ai-users/:id/emotes/generate',
  requireAdmin,
  async (req, res) => {
    const existing = await getAiUserRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'AI user not found' });
    if (!existing.avatarPath)
      return res
        .status(400)
        .json({ error: 'Generate or upload a base avatar first' });
    let name: string;
    try {
      name = normalizeEmoteName(String(req.body?.name || ''));
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
    const direction =
      typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (direction.length > 4_000)
      return res.status(400).json({ error: 'Emote direction is too long' });

    const jobKey = emoteGenerationKey(existing.id, name);
    const state = startAvatarGeneration(jobKey, async () => {
      try {
        const current = await getAiUserRow(existing.id);
        if (!current?.avatarPath)
          throw new Error('The base avatar is no longer available');
        const avatarData = await fs.readFile(
          resolveAiUserPath(current.avatarPath),
        );
        const mimetype = sniffMime(avatarData);
        if (!mimetype)
          throw new Error(
            'The base avatar is not a supported PNG, JPEG, or WebP image',
          );
        const generated = await generateImage(
          [
            `Create a derived square emote portrait named "${name}" from the supplied base avatar.`,
            'Preserve the exact same character identity, face, distinguishing features, wardrobe, palette, rendering style, framing, and background language.',
            `Change only the expression, body language, and pose needed to communicate: ${direction || name}.`,
            'Use one character only. Do not add text, lettering, logos, watermarks, borders, or an emote sheet.',
          ].join(' '),
          [{ data: avatarData.toString('base64'), mimetype }],
          '1:1',
          undefined,
          {
            quality: 'low',
            timeoutMs: AVATAR_GENERATION_TIMEOUT_MS,
            provider: 'gemini',
          },
        );
        if (!(await getAiUserRow(existing.id))) return;
        const emote = await writeImmutableAiUserEmote(
          existing.id,
          name,
          extensionForMime(generated.mimetype),
          generated.data,
        );
        try {
          const published = await publishAiUserEmote(
            existing.id,
            emote,
            new Date().toISOString(),
          );
          if (!published)
            throw new Error(
              'AI user was removed before the emote change was saved',
            );
          if (published.replaced)
            await removeAiUserEmoteAsset(published.replaced);
        } catch (error) {
          await removeAiUserEmoteAsset(emote);
          throw error;
        }
        logger.info(
          { aiUserId: existing.id, emote: emote.name, path: emote.path },
          'AI user emote generation completed',
        );
      } catch (error) {
        const normalized = emoteGenerationError(error);
        logger.warn(
          { aiUserId: existing.id, emote: name, err: normalized.message },
          'AI user emote generation failed',
        );
        throw normalized;
      }
    });
    res.status(202).json(state);
  },
);

aiUsersAdminRouter.delete(
  '/admin/ai-users/:id/emotes/:name',
  requireAdmin,
  async (req, res) => {
    const existing = await getAiUserRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'AI user not found' });
    try {
      const name = normalizeEmoteName(req.params.name);
      const unpublished = await unpublishAiUserEmote(
        existing.id,
        name,
        new Date().toISOString(),
      );
      if (!unpublished?.removed) {
        return res.status(404).json({ error: 'Emote not found' });
      }
      await removeAiUserEmoteAsset(unpublished.removed);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
    res.json({ ok: true });
  },
);

aiUsersAdminRouter.get('/ai-users/:id/avatar', async (req, res) => {
  const existing = await getAiUserRow(req.params.id);
  if (!existing?.avatarPath)
    return res.status(404).json({ error: 'Avatar not found' });
  const filePath = resolveAiUserPath(existing.avatarPath);
  if (req.query.thumbnail === '1' || req.query.thumbnail === 'true') {
    const thumbnailPath = await ensureAiUserAvatarThumbnail(filePath);
    if (thumbnailPath) {
      return res
        .type('image/jpeg')
        .set('Cache-Control', 'private, max-age=31536000, immutable')
        .sendFile(thumbnailPath);
    }
  }
  const data = await fs.readFile(filePath).catch(() => null);
  if (!data) return res.status(404).json({ error: 'Avatar not found' });
  res
    .type(path.extname(filePath))
    .set('Cache-Control', 'private, max-age=300')
    .send(data);
});

aiUsersAdminRouter.get(
  '/ai-users/:id/avatar-candidate',
  requireAdmin,
  async (req, res) => {
    const existing = await getAiUserRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'AI user not found' });
    const candidate = await findAiUserAvatarCandidate(existing.id);
    if (!candidate)
      return res.status(404).json({ error: 'Avatar candidate not found' });
    const filePath = resolveAiUserPath(candidate.path);
    const data = await fs.readFile(filePath).catch(() => null);
    if (!data)
      return res.status(404).json({ error: 'Avatar candidate not found' });
    res
      .type(path.extname(filePath))
      .set('Cache-Control', 'private, no-cache')
      .send(data);
  },
);

aiUsersAdminRouter.get('/ai-users/:id/emotes/:name', async (req, res) => {
  const existing = await getAiUserRow(req.params.id);
  if (!existing) return res.status(404).json({ error: 'AI user not found' });
  let name: string;
  try {
    name = normalizeEmoteName(req.params.name);
  } catch {
    return res.status(404).json({ error: 'Emote not found' });
  }
  const emote = (existing.publishedEmotes ?? []).find(
    (item) => item.name === name,
  );
  if (!emote) return res.status(404).json({ error: 'Emote not found' });
  const filePath = resolveAiUserPath(emote.path);
  if (req.query.thumbnail === '1' || req.query.thumbnail === 'true') {
    const thumbnailPath = await ensureAiUserEmoteThumbnail(filePath);
    if (thumbnailPath) {
      const versioned =
        typeof req.query.v === 'string' && req.query.v.length > 0;
      return res
        .type('image/jpeg')
        .set(
          'Cache-Control',
          versioned
            ? 'private, max-age=31536000, immutable'
            : 'private, no-cache',
        )
        .sendFile(thumbnailPath);
    }
  }
  const data = await fs.readFile(filePath).catch(() => null);
  if (!data) return res.status(404).json({ error: 'Emote not found' });
  // Same-named emotes may be regenerated in place, so always revalidate them.
  res
    .type(path.extname(filePath))
    .set('Cache-Control', 'private, no-cache')
    .send(data);
});

async function ensureConversation(
  req: any,
  res: any,
  level: ConversationAccessLevel,
) {
  const conversation = await getConversation(req.params.cid);
  if (!conversation || conversation.group_folder !== req.params.pid) {
    res.status(404).json({ error: 'Conversation not found' });
    return null;
  }
  if (!(await requireConversationAccess(req, res, conversation.id, level)))
    return null;
  return conversation;
}

conversationAiUsersRouter.get(
  '/projects/:pid/conversations/:cid/ai-users',
  async (req, res) => {
    if (!(await ensureConversation(req, res, 'read'))) return;
    const memberships = await listConversationAiUserRows(req.params.cid);
    const effectiveMain = await resolveEffectiveMainAiUser(req.params.cid);
    res.json(
      await Promise.all(
        memberships
          .filter(({ aiUser }) => aiUser.id !== effectiveMain?.id)
          .map(async ({ aiUser, membership }) => ({
            ...(await presentAiUser(aiUser)),
            status: membership.status,
            invitedBy: membership.invitedBy,
            invitedAt: membership.invitedAt,
          })),
      ),
    );
  },
);

conversationAiUsersRouter.get(
  '/projects/:pid/ai-users/available',
  async (_req, res) => {
    const rows = (await listAiUserRows()).filter((row) => row.enabled === 1);
    res.json(await Promise.all(rows.map(presentAiUser)));
  },
);

conversationAiUsersRouter.get(
  '/projects/:pid/ai-user-teams/available',
  async (_req, res) => {
    const enabledIds = new Set(
      (await listAiUserRows())
        .filter((row) => row.enabled === 1)
        .map((row) => row.id),
    );
    const teams = await listAiUserTeamRows();
    res.json(
      teams.map((team) => ({
        ...team,
        memberIds: team.memberIds.filter((id) => enabledIds.has(id)),
      })),
    );
  },
);

conversationAiUsersRouter.get(
  '/projects/:pid/conversations/:cid/ai-users/available',
  async (req, res) => {
    if (!(await ensureConversation(req, res, 'read'))) return;
    const rows = (await listAiUserRows()).filter((row) => row.enabled === 1);
    res.json(await Promise.all(rows.map(presentAiUser)));
  },
);

conversationAiUsersRouter.get(
  '/projects/:pid/conversations/:cid/ai-users/main',
  async (req, res) => {
    const conversation = await ensureConversation(req, res, 'read');
    if (!conversation) return;
    const aiUser = await resolveEffectiveMainAiUser(conversation.id);
    res.json(aiUser ? await presentAiUser(aiUser) : null);
  },
);

conversationAiUsersRouter.get(
  '/projects/:pid/conversations/:cid/ai-users/main-selection',
  async (req, res) => {
    const conversation = await ensureConversation(req, res, 'read');
    if (!conversation) return;
    const mode =
      conversation.mainAiUserMode ??
      (conversation.mainAiUserId ? 'persona' : 'inherit');
    const selection: MainAiUserSelection =
      mode === 'persona' && conversation.mainAiUserId
        ? { mode: 'persona', aiUserId: conversation.mainAiUserId }
        : mode === 'none' || mode === 'persona'
          ? { mode: 'none' }
          : { mode: 'inherit' };
    const effective = await resolveEffectiveMainAiUser(conversation.id);
    res.json({ selection, effectiveAiUserId: effective?.id ?? null });
  },
);

conversationAiUsersRouter.patch(
  '/projects/:pid/conversations/:cid/ai-users/main',
  async (req, res) => {
    const conversation = await ensureConversation(req, res, 'write');
    if (!conversation) return;
    let selection: MainAiUserSelection;
    if (
      req.body?.selection?.mode === 'inherit' ||
      req.body?.selection?.mode === 'none'
    ) {
      selection = { mode: req.body.selection.mode };
    } else if (
      req.body?.selection?.mode === 'persona' &&
      typeof req.body.selection.aiUserId === 'string' &&
      req.body.selection.aiUserId.trim()
    ) {
      selection = {
        mode: 'persona',
        aiUserId: req.body.selection.aiUserId.trim(),
      };
    } else if ('aiUserId' in (req.body ?? {})) {
      selection =
        req.body.aiUserId == null
          ? { mode: 'none' }
          : { mode: 'persona', aiUserId: String(req.body.aiUserId).trim() };
    } else {
      return res
        .status(400)
        .json({ error: 'A valid main persona selection is required' });
    }
    const aiUserId = selection.mode === 'persona' ? selection.aiUserId : null;
    if (aiUserId) {
      const aiUser = await getAiUserRow(aiUserId);
      if (!aiUser?.enabled)
        return res.status(400).json({ error: 'Enabled AI user is required' });
    }
    await setMainConversationAiUser(conversation.id, selection);
    res.json({ ok: true });
  },
);

conversationAiUsersRouter.post(
  '/projects/:pid/conversations/:cid/ai-users',
  async (req: any, res) => {
    if (!(await ensureConversation(req, res, 'write'))) return;
    const aiUserId = String(req.body?.aiUserId || '');
    const aiUser = await getAiUserRow(aiUserId);
    if (!aiUser?.enabled)
      return res.status(400).json({ error: 'Enabled AI user is required' });
    const effectiveMain = await resolveEffectiveMainAiUser(req.params.cid);
    if (effectiveMain?.id === aiUserId)
      return res
        .status(400)
        .json({ error: 'The main AI persona cannot also be invited' });
    await inviteConversationAiUser(
      req.params.cid,
      aiUserId,
      req.authUser?.id ?? null,
    );
    res.json({ ok: true });
  },
);

conversationAiUsersRouter.post(
  '/projects/:pid/conversations/:cid/ai-users/teams/:teamId',
  async (req: any, res) => {
    const conversation = await ensureConversation(req, res, 'write');
    if (!conversation) return;
    const team = await getAiUserTeamRow(req.params.teamId);
    if (!team) return res.status(404).json({ error: 'AI user team not found' });
    const effectiveMain = await resolveEffectiveMainAiUser(conversation.id);
    const result = await inviteConversationAiUserTeam(
      conversation.id,
      team.id,
      req.authUser?.id ?? null,
      effectiveMain?.id ?? null,
    );
    res.json(result);
  },
);

conversationAiUsersRouter.patch(
  '/projects/:pid/conversations/:cid/ai-users/:aiUserId',
  async (req, res) => {
    if (!(await ensureConversation(req, res, 'write'))) return;
    if (req.body?.status !== 'active' && req.body?.status !== 'paused')
      return res.status(400).json({ error: 'status must be active or paused' });
    const row = await setConversationAiUserStatus(
      req.params.cid,
      req.params.aiUserId,
      req.body.status,
    );
    if (!row)
      return res.status(404).json({ error: 'Invited AI user not found' });
    res.json({ ok: true });
  },
);

conversationAiUsersRouter.delete(
  '/projects/:pid/conversations/:cid/ai-users/:aiUserId',
  async (req, res) => {
    if (!(await ensureConversation(req, res, 'write'))) return;
    await removeConversationAiUser(req.params.cid, req.params.aiUserId);
    res.json({ ok: true });
  },
);
