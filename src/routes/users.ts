import { presentAccountIdentity } from '../modules/account/profile.js';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import {
  createUser,
  MainFolderTakenError,
  listUsers,
  upsertProjectMember,
  upsertKbMember,
  removeProjectMember,
  removeKbMember,
  searchUsersByUsername,
  getProjectMembersDetailed,
  getKbMembersDetailed,
  getProjectAccess,
  userIsKbOwner,
  kbHasOwner,
  adminBypassesKb,
  getKbAccessLevel,
  getUserById,
  updateUserPassword,
  updateUserAdminStanding,
  LastAdminError,
  projectRowExists,
  getKnowledgeBase,
  countActiveAdmins,
  deleteUser,
  getUserMainFolder,
  type UserRole,
  type AuthUser,
} from '../db.js';
import { getGroupByFolder } from '../state-manager.js';
import { isOwnedByOtherUser } from '../lib/project-ownership.js';
import {
  closeUserSockets,
  invalidateUserAccess,
} from '../modules/objectives/ws-events.js';
import { projectChanges } from '../lib/project-changes.js';
import { isUniqueViolationError } from '../lib/db-errors.js';
import { buildSessionCookie, signUserJwt } from '../lib/auth-jwt.js';
import { logger } from '../logger.js';
import { notifyUserSystem } from '../modules/tools/push-tools.js';
import {
  archivePersonalMain,
  MainArchiveRefusedError,
  withMainLock,
  withMainRunsFenced,
} from '../modules/projects/archive-main.js';
import {
  explicitLevelAtLeast,
  normalizeProjectAccessLevel,
  requireAdmin,
  requireOwnerOrAdmin,
} from './_helpers.js';
import { requireAuth } from './auth-helpers.js';

const router = Router();

// `withMainLock` key shared by every change to the set of active admins.
const ADMIN_SET_LOCK = '@admin-set';

// Admins manage members only of projects and KBs no other user owns.
const requireProjectOwnerOrAdmin = requireOwnerOrAdmin(
  async (req) => {
    // A project with a registered owner (`projects.user_id`) is managed by
    // that owner alone, as is a personal main: an owner-level membership row
    // held by anyone else, admin or not, does not count. Only an ownerless
    // project falls back to its owner members.
    const group = getGroupByFolder(req.params.pid);
    if (group?.user_id || group?.is_main) {
      return group.user_id === req.authUser.id;
    }
    return explicitLevelAtLeast(
      await getProjectAccess(req.authUser.id, req.params.pid),
      'owner',
    );
  },
  {
    denied: 'Owner or admin access required',
    adminBypass: (req) => !isOwnedByOtherUser(req.authUser.id, req.params.pid),
  },
);

const requireKbOwnerOrAdmin = requireOwnerOrAdmin(
  (req) => userIsKbOwner(req.authUser.id, req.params.kb_id),
  {
    denied: 'Owner or admin access required',
    adminBypass: async (req) => !(await kbHasOwner(req.params.kb_id)),
  },
);

// --- Users ---

async function presentUser(user: AuthUser) {
  const identity = await presentAccountIdentity(user);
  return {
    id: identity.id,
    username: identity.username,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
    role: user.role,
    created_at: user.created_at,
    disabled: user.disabled,
  };
}

router.get('/users', requireAdmin, async (_req, res) => {
  const users = await listUsers();
  res.json(await Promise.all(users.map(presentUser)));
});

router.post('/users', requireAdmin, async (req, res) => {
  const { username, password, role } = req.body || {};
  const trimmedUsername = typeof username === 'string' ? username.trim() : '';
  const rawPassword = typeof password === 'string' ? password : '';
  if (!trimmedUsername || !rawPassword) {
    return res
      .status(400)
      .json({ error: 'username and password are required' });
  }
  const safeRole: UserRole = role === 'admin' ? 'admin' : 'user';
  try {
    const user = await createUser(trimmedUsername, rawPassword, safeRole);
    return res.status(201).json(await presentUser(user));
  } catch (err: unknown) {
    // A duplicate username is the only expected conflict. Any other failure is
    // logged server-side and reported without the driver message: the data
    // layer's error text carries the SQL and its bind parameters, including
    // the hashed password.
    if (isUniqueViolationError(err)) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    if (
      err instanceof MainFolderTakenError ||
      (err as { name?: string } | null)?.name === 'MainFolderTakenError'
    ) {
      return res.status(409).json({
        error:
          'The personal project folder for this username is already used by another project. Rename that project or choose another username.',
      });
    }
    if ((err as { name?: string } | null)?.name === 'MainArchiveRefusedError') {
      return res.status(409).json({ error: (err as Error).message });
    }
    logger.error({ err }, 'Failed to create user');
    return res.status(500).json({ error: 'Failed to create user' });
  }
});

/** Stored notification summaries are cut at 120 characters (`notifyUserSystem`). */
const NOTIFICATION_SUMMARY_MAX = 120;

/**
 * Log an admin resetting another user's password and tell that user. A failure
 * here never undoes the reset.
 */
async function recordAdminPasswordReset(
  admin: AuthUser,
  targetId: string,
): Promise<void> {
  logger.warn(
    { adminUserId: admin.id, targetUserId: targetId },
    "Admin reset another user's password",
  );
  try {
    const adminName =
      (await getUserById(admin.id))?.displayName?.trim() || admin.username;
    const at = new Date().toISOString();
    // The summary is capped, so the name is shortened (with an ellipsis) only
    // when it does not fit; the content always carries the full name.
    const summaryHead = 'Password reset by ';
    const summaryTail = ` at ${at.slice(0, 16)}Z. Contact the admin if unexpected.`;
    const room =
      NOTIFICATION_SUMMARY_MAX - summaryHead.length - summaryTail.length;
    const shortName =
      adminName.length <= room ? adminName : `${adminName.slice(0, room - 1)}…`;
    const mainFolder = await getUserMainFolder(targetId);
    await notifyUserSystem(targetId, mainFolder ?? '', {
      summary: `${summaryHead}${shortName}${summaryTail}`,
      content: `${adminName} (admin) reset your password at ${at}. If this was unexpected, contact the admin.`,
      source_id: `admin-password-reset:${targetId}:${at}:${randomUUID()}`,
      suppress_push: !mainFolder,
    });
  } catch (err) {
    logger.warn(
      { adminUserId: admin.id, targetUserId: targetId, err: String(err) },
      'Failed to notify user about admin password reset',
    );
  }
}

/**
 * PATCH /api/users/:id  (admin only)
 * Body: { role?: 'admin'|'user', password?: string, disabled?: boolean }
 *
 * Guardrails:
 *  - admin cannot demote, disable, or change their own account here
 *  - cannot demote/disable the last remaining active admin
 */
router.patch('/users/:id', requireAdmin, async (req: any, res) => {
  const target = await getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const body = req.body || {};
  const wantsRole =
    typeof body.role === 'string' &&
    (body.role === 'admin' || body.role === 'user');
  const wantsPassword =
    typeof body.password === 'string' && body.password.length > 0;
  const wantsDisabled = typeof body.disabled === 'boolean';

  if (!wantsRole && !wantsPassword && !wantsDisabled) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  const isSelf = target.id === req.authUser?.id;

  // Self-guard: admin can only reset their own password here, not demote/disable themselves.
  if (isSelf) {
    if (
      (wantsRole && body.role !== 'admin') ||
      (wantsDisabled && body.disabled === true)
    ) {
      return res
        .status(400)
        .json({ error: 'Cannot demote or disable your own account' });
    }
  }

  // Last-admin guard: a change that would remove the last remaining active
  // admin is rejected; the check and the update run under one lock.
  if (wantsRole || wantsDisabled) {
    try {
      await withMainLock(ADMIN_SET_LOCK, () =>
        updateUserAdminStanding(target.id, {
          role: wantsRole ? (body.role as UserRole) : undefined,
          disabled: wantsDisabled ? body.disabled : undefined,
        }),
      );
    } catch (err) {
      if (err instanceof LastAdminError) {
        return res.status(400).json({
          error: 'Cannot demote or disable the last remaining active admin',
        });
      }
      throw err;
    }
  }
  if (wantsPassword) {
    // The bump ends every session issued before it. The caller changing their
    // own password gets a fresh cookie so they stay signed in.
    const tokenVersion = await updateUserPassword(
      target.id,
      String(body.password),
    );
    if (isSelf) {
      res.setHeader(
        'Set-Cookie',
        buildSessionCookie(
          signUserJwt(target.id, req.authDeviceId, tokenVersion),
          req,
          31536000,
        ),
      );
    } else {
      await recordAdminPasswordReset(req.authUser, target.id);
    }
  }

  invalidateUserAccess(target.id);
  if (wantsDisabled && body.disabled) closeUserSockets(target.id);
  // A board-role or disabled change alters which project writes the account may
  // make (admin bypass), so open clients re-read their permissions.
  if (wantsRole || wantsDisabled) projectChanges.emit('changed');
  const updated = await getUserById(target.id);
  return res.json(updated ? await presentUser(updated) : null);
});

/**
 * DELETE /api/users/:id  (admin only)
 *
 * Guardrails:
 *  - admin cannot delete themselves
 *  - cannot delete the last remaining active admin
 */
router.delete('/users/:id', requireAdmin, async (req: any, res) => {
  const target = await getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target.id === req.authUser?.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  // The personal main is archived first, so the username can be re-created
  // with an empty main. A failure leaves the user in place. The main's sandbox
  // starts stay fenced until the user is gone: Alice's credentials work until
  // then, and a start in between would revive the instance being retired.
  // Concurrent deletes of the same user queue behind one lock and re-read the
  // main and the user once they hold it.
  const removeUser = async (): Promise<boolean> => {
    if (!(await getUserById(target.id))) return false;
    await deleteUser(target.id);
    return true;
  };
  // Keyed by the user, not the main: the archive clears ownership early, so a
  // second delete that looked the main up meanwhile would find none and remove
  // the user while the first one could still roll back.
  const deleteOwnedMain = (): Promise<boolean> =>
    withMainLock(`user:${target.id}`, async () => {
      const mainFolder = await getUserMainFolder(target.id);
      if (!mainFolder) return removeUser();
      return withMainRunsFenced(mainFolder, async () => {
        if ((await getUserMainFolder(target.id)) === mainFolder) {
          await archivePersonalMain(mainFolder);
        }
        return removeUser();
      });
    });
  // Admin-affecting changes queue behind one in-process lock, so the check
  // below runs before the main is archived and sees every earlier change. The
  // database lock in `deleteUser` still covers other processes.
  const deleteUnlessLastAdmin = async (): Promise<boolean> => {
    const current = await getUserById(target.id);
    if (!current) return false;
    if (
      current.role === 'admin' &&
      !current.disabled &&
      (await countActiveAdmins()) <= 1
    ) {
      throw new LastAdminError();
    }
    return deleteOwnedMain();
  };
  try {
    if (!(await withMainLock(ADMIN_SET_LOCK, deleteUnlessLastAdmin))) {
      return res.status(404).json({ error: 'User not found' });
    }
  } catch (err) {
    if (err instanceof LastAdminError) {
      return res
        .status(400)
        .json({ error: 'Cannot delete the last remaining active admin' });
    }
    if (
      err instanceof MainArchiveRefusedError &&
      (err.reason === 'tasks_running' || err.reason === 'custom_sandbox')
    ) {
      return res.status(409).json({
        error:
          err.reason === 'tasks_running'
            ? 'Cannot delete a user while their personal project has running tasks'
            : err.message,
      });
    }
    logger.error({ err, userId: target.id }, 'Failed to delete user');
    return res.status(500).json({ error: 'Failed to delete the user' });
  }
  invalidateUserAccess(target.id);
  res.json({ ok: true });
});

/**
 * GET /api/users/search?q=foo&limit=10
 * Returns minimal {id, username} list for the share-dialog autocomplete.
 * Available to any authenticated user.
 */
router.get('/users/search', requireAuth, async (req: any, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const limit = Math.min(
    Math.max(1, parseInt(String(req.query.limit ?? '10'), 10) || 10),
    50,
  );
  const results = await searchUsersByUsername(q, limit);
  const filtered = results.filter((u) => u.id !== req.authUser?.id);
  res.json(filtered);
});

// --- Project members ---

// A member list is account metadata: admins see any project's, everyone else
// only that of a project they own (editors, viewers and chat-only users not).
// Owners are as `getProjectAccess` defines them (the registered owner, anyone
// holding an owner membership, and on a personal main the registered owner
// alone), the rule the UI's `accessLevel === 'owner'` follows. This is
// deliberately wider than member management, which needs the registered owner.
async function mayListProjectMembers(user: any, pid: string) {
  if (user?.role === 'admin') return true;
  return explicitLevelAtLeast(await getProjectAccess(user?.id, pid), 'owner');
}

router.get('/projects/:pid/members', requireAuth, async (req: any, res) => {
  if (!(await mayListProjectMembers(req.authUser, req.params.pid))) {
    return res.status(403).json({ error: 'Owner or admin access required' });
  }
  const members = await getProjectMembersDetailed(req.params.pid);
  res.json(members);
});

router.post(
  '/projects/:pid/members',
  requireProjectOwnerOrAdmin,
  async (req, res) => {
    const { user_id, access_level } = req.body || {};
    if (typeof user_id !== 'string' || !user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }
    if (!(await getUserById(user_id))) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!(await projectRowExists(req.params.pid))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    await upsertProjectMember(
      user_id,
      req.params.pid,
      normalizeProjectAccessLevel(access_level),
    );
    invalidateUserAccess(user_id);
    return res.json({ ok: true });
  },
);

router.delete(
  '/projects/:pid/members/:user_id',
  requireProjectOwnerOrAdmin,
  async (req: any, res) => {
    if (
      req.authUser?.role !== 'admin' &&
      req.params.user_id === req.authUser?.id
    ) {
      return res.status(400).json({ error: 'Owners cannot remove themselves' });
    }
    await removeProjectMember(req.params.user_id, req.params.pid);
    invalidateUserAccess(req.params.user_id);
    res.json({ ok: true });
  },
);

// --- KB members ---

router.get(
  '/knowledge-bases/:kb_id/members',
  requireAuth,
  async (req: any, res) => {
    if (
      !(await adminBypassesKb(req.authUser, req.params.kb_id)) &&
      !(await getKbAccessLevel(req.authUser?.id, req.params.kb_id))
    ) {
      return res
        .status(403)
        .json({ error: 'Access denied to this knowledge base' });
    }
    const members = await getKbMembersDetailed(req.params.kb_id);
    res.json(members);
  },
);

router.post(
  '/knowledge-bases/:kb_id/members',
  requireKbOwnerOrAdmin,
  async (req, res) => {
    const { user_id, access_level } = req.body || {};
    if (typeof user_id !== 'string' || !user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }
    if (!(await getUserById(user_id))) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!(await getKnowledgeBase(req.params.kb_id))) {
      return res.status(404).json({ error: 'Knowledge base not found' });
    }
    await upsertKbMember(
      user_id,
      req.params.kb_id,
      normalizeProjectAccessLevel(access_level),
    );
    invalidateUserAccess(user_id);
    return res.json({ ok: true });
  },
);

router.delete(
  '/knowledge-bases/:kb_id/members/:user_id',
  requireKbOwnerOrAdmin,
  async (req: any, res) => {
    if (
      req.authUser?.role !== 'admin' &&
      req.params.user_id === req.authUser?.id
    ) {
      return res.status(400).json({ error: 'Owners cannot remove themselves' });
    }
    await removeKbMember(req.params.user_id, req.params.kb_id);
    invalidateUserAccess(req.params.user_id);
    res.json({ ok: true });
  },
);

export default router;
