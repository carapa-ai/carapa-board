/**
 * Conversation sharing endpoints — owner-or-admin can share an individual
 * conversation with another user (live read/write collab).
 *
 * Mounted on the kanban router (already gated on /projects/:pid). Paths:
 *   GET    /projects/:pid/conversations/:cid/members
 *   POST   /projects/:pid/conversations/:cid/members
 *   DELETE /projects/:pid/conversations/:cid/members/:user_id
 */
import { Router } from 'express';
import {
  getConversation,
  getUserById,
  getConversationMembers,
  upsertConversationMember,
  removeConversationMember,
  userIsConversationOwner,
  getConversationPublicShare,
  createOrEnableConversationPublicShare,
  rotateConversationPublicShare,
  revokeConversationPublicShare,
  setConversationPublicVisitorPrompts,
} from '../db.js';
import { isOwnedByOtherUser } from '../lib/project-ownership.js';
import { getGroupByFolder } from '../state-manager.js';
import { invalidateUserAccess } from '../modules/objectives/ws-events.js';
import { publishPublicConversationEvent } from '../modules/chat/public-conversation-events.js';
import { getPublicPromptingEligibility } from '../modules/chat/public-prompting.js';
import {
  explicitLevelAtLeast,
  normalizeProjectAccessLevel,
  requireConversationAccess,
  requireOwnerOrAdmin,
} from './_helpers.js';

const router = Router();

async function publicSharePayload(
  row: Awaited<ReturnType<typeof getConversationPublicShare>>,
) {
  const eligibility = row
    ? await getPublicPromptingEligibility(row.conversationId)
    : { available: false, reason: 'Create a public link first.' };
  if (!row || row.revokedAt)
    return {
      active: false,
      url: null,
      createdAt: null,
      updatedAt: null,
      allowVisitorPrompts: false,
      visitorPromptingAvailable: eligibility.available,
      visitorPromptingUnavailableReason: eligibility.reason,
    };
  return {
    active: true,
    url: `/share/${row.publicToken}`,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    allowVisitorPrompts: row.allowVisitorPrompts === 1,
    visitorPromptingAvailable: eligibility.available,
    visitorPromptingUnavailableReason: eligibility.reason,
  };
}

async function ensureConversationInProject(
  req: any,
  res: any,
): Promise<boolean> {
  const conv = await getConversation(req.params.cid);
  if (!conv || conv.group_folder !== req.params.pid) {
    res.status(404).json({ error: 'Conversation not found' });
    return false;
  }
  return true;
}

// Project owners can also share any conversation in their project.
const requireConversationOwnerOrAdmin = requireOwnerOrAdmin(
  async (req) =>
    explicitLevelAtLeast(req.projectAccess, 'owner') ||
    (await userIsConversationOwner(req.authUser.id, req.params.cid)),
  {
    denied: 'Conversation owner or admin required',
    precheck: ensureConversationInProject,
    // In a project owned by another user an admin has only their membership.
    adminBypass: (req) => !isOwnedByOtherUser(req.authUser.id, req.params.pid),
  },
);

router.get(
  '/projects/:pid/conversations/:cid/public-share',
  requireConversationOwnerOrAdmin,
  async (req, res) => {
    res.json(
      await publicSharePayload(
        await getConversationPublicShare(req.params.cid),
      ),
    );
  },
);

router.put(
  '/projects/:pid/conversations/:cid/public-share',
  requireConversationOwnerOrAdmin,
  async (req: any, res) => {
    const row = await createOrEnableConversationPublicShare(
      req.params.cid,
      req.authUser?.id ?? null,
    );
    res.json(await publicSharePayload(row));
  },
);

router.post(
  '/projects/:pid/conversations/:cid/public-share/regenerate',
  requireConversationOwnerOrAdmin,
  async (req: any, res) => {
    publishPublicConversationEvent(req.params.cid, { type: 'revoked' });
    const row = await rotateConversationPublicShare(
      req.params.cid,
      req.authUser?.id ?? null,
    );
    res.json(await publicSharePayload(row));
  },
);

router.patch(
  '/projects/:pid/conversations/:cid/public-share/visitor-prompts',
  requireConversationOwnerOrAdmin,
  async (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean')
      return res.status(400).json({ error: 'enabled must be a boolean' });
    const existing = await getConversationPublicShare(req.params.cid);
    if (!existing || existing.revokedAt)
      return res.status(404).json({ error: 'Create a public link first' });
    if (enabled) {
      const eligibility = await getPublicPromptingEligibility(req.params.cid);
      if (!eligibility.available) {
        return res.status(409).json({
          error: eligibility.reason || 'Visitor prompting is unavailable',
        });
      }
    }
    const row = await setConversationPublicVisitorPrompts(
      req.params.cid,
      enabled,
    );
    publishPublicConversationEvent(req.params.cid, { type: 'changed' });
    res.json(await publicSharePayload(row));
  },
);

router.delete(
  '/projects/:pid/conversations/:cid/public-share',
  requireConversationOwnerOrAdmin,
  async (req, res) => {
    await revokeConversationPublicShare(req.params.cid);
    publishPublicConversationEvent(req.params.cid, { type: 'revoked' });
    res.json({ ok: true });
  },
);

router.get('/projects/:pid/conversations/:cid/members', async (req, res) => {
  if (!(await ensureConversationInProject(req, res))) return;
  if (
    !(await requireConversationAccess(req, res, String(req.params.cid), 'read'))
  )
    return;
  const members = await getConversationMembers(req.params.cid);
  res.json(members);
});

router.post(
  '/projects/:pid/conversations/:cid/members',
  requireConversationOwnerOrAdmin,
  async (req, res) => {
    const { user_id, access_level } = req.body || {};
    if (typeof user_id !== 'string' || !user_id)
      return res.status(400).json({ error: 'user_id is required' });
    // A personal main admits only its owner (`userCanAccessConversation`), so
    // a member row there would report success but never grant access.
    const group = getGroupByFolder(req.params.pid);
    if (group?.is_main && group.user_id)
      return res
        .status(400)
        .json({ error: 'Conversations in a personal main cannot be shared' });
    if (!(await getUserById(user_id)))
      return res.status(404).json({ error: 'User not found' });
    await upsertConversationMember(
      user_id,
      req.params.cid,
      normalizeProjectAccessLevel(access_level),
    );
    invalidateUserAccess(user_id);
    res.json({ ok: true });
  },
);

router.delete(
  '/projects/:pid/conversations/:cid/members/:user_id',
  requireConversationOwnerOrAdmin,
  async (req: any, res) => {
    if (
      req.authUser?.role !== 'admin' &&
      req.params.user_id === req.authUser?.id
    ) {
      return res.status(400).json({ error: 'Owners cannot remove themselves' });
    }
    await removeConversationMember(req.params.user_id, req.params.cid);
    invalidateUserAccess(req.params.user_id);
    res.json({ ok: true });
  },
);

export default router;
