import fs from 'fs/promises';
import path from 'path';
import { Router } from 'express';
import {
  acknowledgeKanbanCompletions,
  getUserById,
  getUserPreferences,
  setUserPreferences,
  getUserDictationLanguage,
  setUserDictationLanguage,
  updateUserProfile,
  getMemberPreferences,
  setMemberPreferences,
  getMemberPushEnabled,
  setMemberPushEnabled,
  resolvePushTargetUser,
  getMemberMode,
  setMemberMode,
  type ProjectMode,
} from '../db.js';
import { MEETING_LANGUAGES } from '../config.js';
import { getMeetingLanguage } from '../lib/meeting-languages.js';
import { getGroupByFolder } from '../state-manager.js';
import { logger } from '../logger.js';
import { canAccessProject } from './_helpers.js';
import {
  decodeAvatarDataUrl,
  generateAvatarImage,
  normalizeAvatarGenerationError,
} from '../modules/image-generation/avatar-image.js';
import {
  getAvatarGenerationState,
  startAvatarGeneration,
} from '../modules/ai-users/avatar-generation.js';
import { ensureAvatarThumbnail } from '../modules/ai-users/avatar-thumbnail.js';
import {
  discardAccountAvatarCandidate,
  findAccountAvatarCandidate,
  promoteAccountAvatarCandidate,
  readAccountAvatarReference,
  resolveOwnedAccountAvatarPath,
  writeAccountAvatar,
  writeAccountAvatarCandidate,
} from '../modules/account/avatar-storage.js';
import { presentAccountIdentity } from '../modules/account/profile.js';
import { invalidatePromptContextCaches } from '../system-prompt-builder.js';
import { adminBypassesProject } from '../lib/project-ownership.js';
import { requireAuth } from './auth-helpers.js';

const router = Router();

function pickContent(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') return null;
  return raw.trim() === '' ? null : raw;
}

function normalizeDictationLanguage(raw: unknown): string {
  if (typeof raw !== 'string') return 'auto';
  return getMeetingLanguage(MEETING_LANGUAGES, raw)?.code ?? 'auto';
}
const MAX_DISPLAY_NAME_LENGTH = 120;

function normalizeDisplayName(raw: unknown): string | null {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string')
    throw new Error('displayName must be a string or null');
  const normalized = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!normalized) return null;
  if (normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new Error(
      `displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
    );
  }
  if (/\p{Cc}/u.test(normalized)) {
    throw new Error('displayName must not contain control characters');
  }
  return normalized;
}

async function presentAccountProfile(userId: string) {
  const user = await getUserById(userId);
  if (!user) return null;
  const [identity, candidate] = await Promise.all([
    presentAccountIdentity(user),
    findAccountAvatarCandidate(user.id),
  ]);
  return {
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
    avatarCandidateUrl: candidate
      ? `/api/account/avatar/candidate?v=${encodeURIComponent(candidate.version)}`
      : null,
  };
}

/**
 * Project access for *personal* preferences. A user can read/write their own
 * row whenever any of these is true:
 *   - they're an admin, except on a project owned by another user
 *   - they own the project or have a project_members row (explicit access)
 *   - the in-memory group state agrees they own it (fast path)
 */
async function canManageOwnPrefs(
  authUserId: string,
  role: string | undefined,
  project_id: string,
): Promise<boolean> {
  if (adminBypassesProject({ id: authUserId, role }, project_id)) return true;
  const group = getGroupByFolder(project_id);
  if (group?.user_id === authUserId) return true;
  return canAccessProject({ id: authUserId }, project_id, { min: 'viewer' });
}

async function requireProjectPreferencesAccess(
  req: any,
  res: any,
  next: any,
): Promise<any> {
  if (
    !(await canManageOwnPrefs(
      req.authUser.id,
      req.authUser.role,
      req.params.pid,
    ))
  ) {
    return res.status(403).json({ error: 'No access to this project' });
  }
  return next();
}

// --- Account-level (cross-project) preferences for the current user ---

router.get('/account/preferences', requireAuth, async (req: any, res) => {
  const [content, stored, profile] = await Promise.all([
    getUserPreferences(req.authUser.id),
    getUserDictationLanguage(req.authUser.id),
    presentAccountProfile(req.authUser.id),
  ]);
  res.json({
    content,
    dictationLanguage: stored ? normalizeDictationLanguage(stored) : null,
    ...profile,
  });
});

router.put('/account/preferences', requireAuth, async (req: any, res) => {
  const hasContent = Object.prototype.hasOwnProperty.call(
    req.body ?? {},
    'content',
  );
  const next = hasContent
    ? pickContent(req.body?.content)
    : await getUserPreferences(req.authUser.id);
  const rawLanguage = req.body?.dictationLanguage;
  const hasLanguage = Object.prototype.hasOwnProperty.call(
    req.body ?? {},
    'dictationLanguage',
  );
  const hasDisplayName = Object.prototype.hasOwnProperty.call(
    req.body ?? {},
    'displayName',
  );
  let displayName: string | null | undefined;
  try {
    displayName = hasDisplayName
      ? normalizeDisplayName(req.body?.displayName)
      : undefined;
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
  const nextLanguage = hasLanguage
    ? rawLanguage === null
      ? null
      : normalizeDictationLanguage(rawLanguage)
    : await getUserDictationLanguage(req.authUser.id);
  await Promise.all([
    hasContent ? setUserPreferences(req.authUser.id, next) : Promise.resolve(),
    hasLanguage
      ? setUserDictationLanguage(req.authUser.id, nextLanguage)
      : Promise.resolve(),
    hasDisplayName
      ? updateUserProfile(req.authUser.id, { displayName })
      : Promise.resolve(),
  ]);
  invalidatePromptContextCaches();
  res.json({
    content: next,
    dictationLanguage: nextLanguage
      ? normalizeDictationLanguage(nextLanguage)
      : null,
    ...(await presentAccountProfile(req.authUser.id)),
  });
});

router.get('/users/:userId/avatar', requireAuth, async (req: any, res) => {
  const user = await getUserById(String(req.params.userId));
  if (!user?.avatarPath)
    return res.status(404).json({ error: 'Avatar not found' });
  let filePath: string;
  try {
    filePath = resolveOwnedAccountAvatarPath(user.id, user.avatarPath);
  } catch {
    return res.status(404).json({ error: 'Avatar not found' });
  }
  if (req.query.thumbnail === '1' || req.query.thumbnail === 'true') {
    filePath = (await ensureAvatarThumbnail(filePath)) ?? filePath;
  }
  const data = await fs.readFile(filePath).catch(() => null);
  if (!data) return res.status(404).json({ error: 'Avatar not found' });
  const versioned = typeof req.query.v === 'string' && req.query.v.length > 0;
  return res
    .type(path.extname(filePath))
    .set(
      'Cache-Control',
      versioned ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    )
    .send(data);
});

router.get('/account/avatar/candidate', requireAuth, async (req: any, res) => {
  const candidate = await findAccountAvatarCandidate(req.authUser.id);
  if (!candidate)
    return res.status(404).json({ error: 'Avatar candidate not found' });
  const data = await fs
    .readFile(resolveOwnedAccountAvatarPath(req.authUser.id, candidate.path))
    .catch(() => null);
  if (!data)
    return res.status(404).json({ error: 'Avatar candidate not found' });
  return res
    .type(path.extname(candidate.path))
    .set('Cache-Control', 'private, max-age=31536000, immutable')
    .send(data);
});

router.post('/account/avatar', requireAuth, async (req: any, res) => {
  const decoded = await decodeAvatarDataUrl(req.body?.dataUrl);
  if (!decoded) {
    return res.status(400).json({
      error: 'A valid PNG, JPEG, or WebP data URL under 8 MB is required',
    });
  }
  await writeAccountAvatar(
    req.authUser.id,
    decoded.extension,
    decoded.data,
    async (avatarPath) => {
      await updateUserProfile(req.authUser.id, { avatarPath });
    },
  );
  await discardAccountAvatarCandidate(req.authUser.id).catch(() => false);
  return res.json(await presentAccountProfile(req.authUser.id));
});

router.get('/account/avatar/generation', requireAuth, async (req: any, res) => {
  res.json(getAvatarGenerationState(`account:${req.authUser.id}`));
});

router.post('/account/avatar/generate', requireAuth, async (req: any, res) => {
  const user = await getUserById(req.authUser.id);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  const mode = req.body?.mode === undefined ? 'generate' : req.body.mode;
  if (mode !== 'generate' && mode !== 'modify') {
    return res
      .status(400)
      .json({ error: 'Avatar generation mode must be generate or modify' });
  }
  if (mode === 'modify' && !user.avatarPath) {
    return res
      .status(400)
      .json({ error: 'Upload or generate a base avatar before modifying it' });
  }
  const prompt =
    typeof req.body?.prompt === 'string' && req.body.prompt.trim()
      ? req.body.prompt.trim()
      : `Square profile portrait avatar for ${user.displayName || user.username}. Clean background, distinctive and friendly.`;
  if (prompt.length > 4_000) {
    return res.status(400).json({ error: 'Avatar prompt is too long' });
  }
  const generationKey = `account:${user.id}`;
  const state = startAvatarGeneration(generationKey, async () => {
    try {
      const current = await getUserById(user.id);
      if (!current) return;
      const reference =
        mode === 'modify' && current.avatarPath
          ? await readAccountAvatarReference(current.id, current.avatarPath)
          : undefined;
      const generated = await generateAvatarImage({
        prompt,
        mode,
        reference,
        subject: 'account',
      });
      await writeAccountAvatarCandidate(
        user.id,
        generated.extension,
        generated.data,
      );
    } catch (error) {
      const normalized = normalizeAvatarGenerationError(error);
      logger.warn(
        { userId: user.id, mode, err: normalized.message },
        'Account avatar generation failed',
      );
      throw normalized;
    }
  });
  return res.status(202).json(state);
});

router.post('/account/avatar/candidate', requireAuth, async (req: any, res) => {
  const choice = req.body?.choice;
  if (choice !== 'current' && choice !== 'candidate') {
    return res
      .status(400)
      .json({ error: 'Avatar choice must be current or candidate' });
  }
  if (choice === 'current') {
    if (!(await discardAccountAvatarCandidate(req.authUser.id))) {
      return res
        .status(404)
        .json({ error: 'No generated avatar candidate is available' });
    }
    return res.json(await presentAccountProfile(req.authUser.id));
  }
  const user = await getUserById(req.authUser.id);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  try {
    await promoteAccountAvatarCandidate(
      user.id,
      async () => (await getUserById(user.id))?.avatarPath ?? null,
      async (avatarPath) => {
        await updateUserProfile(user.id, { avatarPath });
      },
    );
    return res.json(await presentAccountProfile(user.id));
  } catch (error: any) {
    if (error?.message === 'No generated avatar candidate is available') {
      return res
        .status(404)
        .json({ error: 'No generated avatar candidate is available' });
    }
    logger.warn(
      { err: error, userId: user.id },
      'Account avatar promotion failed',
    );
    return res.status(500).json({ error: 'Unable to save avatar choice' });
  }
});

// --- Per-(user, project) preferences for the current user ---
//
// The PUT setters persist only for an existing member or the project owner.
// An admin who is not a member of a foreign project still gets a success
// response (the UI keeps the value in client state for the session), but
// nothing is stored and no project_members row is created, so GET keeps
// returning the default (null). Privileged access never grants membership.

router.get(
  '/projects/:pid/preferences',
  requireAuth,
  requireProjectPreferencesAccess,
  async (req: any, res) => {
    const content = await getMemberPreferences(req.authUser.id, req.params.pid);
    res.json({ content });
  },
);

router.put(
  '/projects/:pid/preferences',
  requireAuth,
  requireProjectPreferencesAccess,
  async (req: any, res) => {
    const raw = req.body?.content;
    if (
      !Object.prototype.hasOwnProperty.call(req.body ?? {}, 'content') ||
      (raw !== null && typeof raw !== 'string')
    ) {
      return res
        .status(400)
        .json({ error: 'content must be a string or null' });
    }
    const next = pickContent(raw);
    await setMemberPreferences(req.authUser.id, req.params.pid, next);
    invalidatePromptContextCaches();
    res.json({ content: next });
  },
);

// --- Per-(user, project) view mode (kanban / chat / objectives) ---

router.get(
  '/projects/:pid/preferences/mode',
  requireAuth,
  requireProjectPreferencesAccess,
  async (req: any, res) => {
    const mode = await getMemberMode(req.authUser.id, req.params.pid);
    res.json({ mode });
  },
);

router.put(
  '/projects/:pid/preferences/mode',
  requireAuth,
  requireProjectPreferencesAccess,
  async (req: any, res) => {
    const raw = req.body?.mode;
    let next: ProjectMode | null;
    if (raw === null) next = null;
    else if (raw === 'kanban' || raw === 'chat' || raw === 'objectives')
      next = raw;
    else
      return res
        .status(400)
        .json({ error: 'mode must be kanban, chat, objectives, or null' });
    await setMemberMode(req.authUser.id, req.params.pid, next);
    res.json({ mode: next });
  },
);

router.post(
  '/projects/:pid/preferences/kanban-acknowledgement',
  requireAuth,
  requireProjectPreferencesAccess,
  async (req: any, res) => {
    const rawEventIds = req.body?.visibleCompletionEventIds;
    if (
      !Array.isArray(rawEventIds) ||
      rawEventIds.some(
        (eventId) =>
          typeof eventId !== 'number' ||
          !Number.isSafeInteger(eventId) ||
          eventId <= 0,
      )
    ) {
      return res.status(400).json({
        error:
          'visibleCompletionEventIds must be an array of positive integer event IDs',
      });
    }
    const visibleCompletionEventIds = [...new Set(rawEventIds)];
    const acknowledgedEventId = await acknowledgeKanbanCompletions(
      req.authUser.id,
      req.params.pid,
      visibleCompletionEventIds,
    );
    res.json({ acknowledgedEventId });
  },
);

// --- Per-(user, project) push notification opt-in ---

router.get(
  '/projects/:pid/preferences/push',
  requireAuth,
  requireProjectPreferencesAccess,
  async (req: any, res) => {
    const enabled = await getMemberPushEnabled(req.authUser.id, req.params.pid);
    const access = await resolvePushTargetUser(req.params.pid, req.authUser.id);
    res.json({ enabled, effective: access.allowed });
  },
);

router.put(
  '/projects/:pid/preferences/push',
  requireAuth,
  requireProjectPreferencesAccess,
  async (req: any, res) => {
    const raw = req.body?.enabled;
    let next: boolean | null;
    if (raw === null) next = null;
    else if (raw === true || raw === false) next = raw;
    else {
      return res
        .status(400)
        .json({ error: 'enabled must be true, false, or null' });
    }
    await setMemberPushEnabled(req.authUser.id, req.params.pid, next);
    const access = await resolvePushTargetUser(req.params.pid, req.authUser.id);
    res.json({ enabled: next, effective: access.allowed });
  },
);

export default router;
