/**
 * WhatsApp REST routes — project management endpoints for WhatsApp groups.
 *
 * Mounted by the whatsapp module via getRouter() so these routes are only
 * active when ENABLE_WHATSAPP is true.
 *
 * Endpoints:
 *   GET    /groups                    — list available WhatsApp groups
 *   POST   /groups                    — register a WhatsApp group as a project
 *   POST   /whatsapp/logout           — clear WhatsApp session
 *   POST   /projects/:pid/link-whatsapp — link a project to a WhatsApp group
 *   DELETE /groups/:jid               — unregister (unlink) a WhatsApp group
 */

import { Router } from 'express';
import { ENABLE_WHATSAPP } from './config.js';
import { getMessagingClient } from './messaging-client.js';
import {
  registeredGroups,
  findSandboxNameConflict,
  isSandboxNameReserved,
  registerGroup,
  sandboxNameConflictMessage,
  rekeyGroupJid,
  getAvailableGroups,
  setLastAgentTimestamp,
  getGroupEntryByFolder,
} from '../../state-manager.js';
import { ASSISTANT_NAME } from '../../config.js';
import { logger } from '../../logger.js';
import {
  MAX_LEN,
  canAccessProject,
  isForeignMainFor,
  lenError,
  requireAdmin,
} from '../../routes/_helpers.js';
import {
  isReservedMainFolder,
  isReservedProjectFolder,
} from '../projects/reserved-folders.js';

const router = Router();

/**
 * GET /api/groups
 * List all WhatsApp groups the bot is in, with registration status.
 */
router.get('/groups', requireAdmin, async (_req, res) => {
  if (!ENABLE_WHATSAPP)
    return res.status(404).json({ error: 'WhatsApp is not enabled' });
  try {
    res.json(await getAvailableGroups());
  } catch (err) {
    logger.error({ err }, 'Failed to fetch available WhatsApp groups');
    res.status(503).json({ error: 'WhatsApp service unavailable' });
  }
});

/**
 * POST /api/whatsapp/logout
 * Clear WhatsApp session so the QR pairing flow restarts.
 */
router.post('/whatsapp/logout', requireAdmin, async (_req, res) => {
  if (!ENABLE_WHATSAPP)
    return res.status(404).json({ error: 'WhatsApp is not enabled' });
  try {
    const client = getMessagingClient();
    await client.logout();
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'Failed to logout WhatsApp session');
    res.status(503).json({ error: 'WhatsApp service unavailable' });
  }
});

/**
 * POST /api/groups
 * Register a WhatsApp group as a project.
 */
router.post('/groups', requireAdmin, async (req, res) => {
  const { jid, name, folder: rawFolder, trigger } = req.body || {};

  if (!jid || !name) {
    return res.status(400).json({ error: 'jid and name are required' });
  }
  if (
    typeof jid !== 'string' ||
    typeof name !== 'string' ||
    (rawFolder !== undefined && typeof rawFolder !== 'string') ||
    (trigger !== undefined && typeof trigger !== 'string')
  ) {
    return res
      .status(400)
      .json({ error: 'jid, name, folder and trigger must be strings' });
  }

  const groupNameErr = lenError(name, MAX_LEN.name, 'name');
  if (groupNameErr) return res.status(400).json({ error: groupNameErr });
  const groupFolderErr = lenError(rawFolder, MAX_LEN.name, 'folder');
  if (groupFolderErr) return res.status(400).json({ error: groupFolderErr });
  const groupTriggerErr = lenError(trigger, MAX_LEN.trigger, 'trigger');
  if (groupTriggerErr) return res.status(400).json({ error: groupTriggerErr });

  if (registeredGroups[jid]) {
    return res.status(409).json({ error: 'Group already registered' });
  }

  const folder = (rawFolder || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (!folder) {
    return res
      .status(400)
      .json({ error: 'Could not derive a valid folder slug' });
  }

  if (isReservedProjectFolder(folder) || isReservedMainFolder(folder)) {
    return res
      .status(400)
      .json({ error: `Project folder "${folder}" is reserved` });
  }

  const folderExists = Object.values(registeredGroups).some(
    (g) => g.folder === folder,
  );
  if (folderExists) {
    return res
      .status(409)
      .json({ error: `Project folder "${folder}" already exists` });
  }
  if (
    findSandboxNameConflict(folder, undefined, { includeFolders: true }) ||
    isSandboxNameReserved(folder)
  ) {
    return res.status(409).json({ error: sandboxNameConflictMessage(folder) });
  }

  await registerGroup(
    jid,
    {
      name,
      folder,
      trigger: trigger || `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      settings: { mode: 'chat' },
    },
    { requirePersistence: true },
  );

  logger.info({ jid, folder, name }, 'WhatsApp group registered via UI');

  res.status(201).json({ jid, name, folder });
});

/**
 * POST /api/projects/:pid/link-whatsapp
 * Link an existing project to a WhatsApp group.
 */
router.post('/projects/:pid/link-whatsapp', requireAdmin, async (req, res) => {
  const entry = getGroupEntryByFolder(req.params.pid);
  if (!entry) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { jid, group } = entry;
  const user = (req as any).authUser;
  if (group.is_main && isForeignMainFor(user?.id, group.folder)) {
    return res.status(403).json({ error: 'Access denied to this project' });
  }
  const { whatsappJid, name, trigger } = req.body || {};

  // Check that we're not trying to link to a group that's already registered
  if (registeredGroups[whatsappJid]) {
    return res
      .status(409)
      .json({ error: 'WhatsApp group is already registered' });
  }

  // Validate that the WhatsApp JID actually exists in our available groups.
  const groups = await getAvailableGroups();
  const status = group.is_main
    ? await getMessagingClient().getStatus()
    : undefined;
  const isSelfChat =
    status?.status === 'connected' && status.jid === whatsappJid;
  const isValidJid = groups.some((g) => g.jid === whatsappJid) || isSelfChat;

  if (!isValidJid) {
    return res.status(400).json({ error: 'WhatsApp group not found' });
  }

  // Re-key in place: the project row (and everything that cascades from it) stays
  const updatedData = {
    ...group,
    name: name || group.name,
    trigger: trigger || group.trigger || `@${ASSISTANT_NAME}`,
  };
  try {
    await rekeyGroupJid(jid, whatsappJid, {
      name: updatedData.name,
      trigger: updatedData.trigger,
      ...(group.is_main
        ? { whatsappSelfChatAutoLinkDisabled: !isSelfChat }
        : {}),
    });
  } catch (err) {
    logger.error({ err: String(err), jid, whatsappJid }, 'Link re-key failed');
    return res.status(500).json({ error: 'Failed to link WhatsApp group' });
  }
  // Set message cursor to "now" so old chat history isn't replayed
  setLastAgentTimestamp(whatsappJid);

  logger.info(
    { oldJid: jid, whatsappJid, folder: group.folder },
    'Project linked to WhatsApp group',
  );

  res.json({
    id: group.folder,
    name: updatedData.name,
    folder: group.folder,
    trigger: updatedData.trigger,
    jid: whatsappJid,
  });
});

/**
 * DELETE /api/groups/:jid
 * Unregister (unlink) a WhatsApp group.
 *
 * For a main group, re-keys to its folder id.
 * For ordinary projects, re-keys to a local JID so the project persists
 * without WhatsApp. Both re-key in place; unregisterGroup would delete the
 * project and everything that cascades from it.
 */
router.delete('/groups/:jid', requireAdmin, async (req, res) => {
  const { jid } = req.params;

  if (!/^[^@\s]+@(g\.us|s\.whatsapp\.net|lid)$/.test(jid)) {
    return res.status(400).json({ error: 'Not a WhatsApp jid' });
  }

  if (!registeredGroups[jid]) {
    return res.status(404).json({ error: 'Group not found' });
  }

  const g = registeredGroups[jid];
  const user = (req as any).authUser;
  if (
    isForeignMainFor(user?.id, g.folder) ||
    !(await canAccessProject(user, g.folder, { min: 'editor' }))
  ) {
    return res.status(403).json({ error: 'Access denied to this project' });
  }

  // Preserve the main project and remember the deliberate unlink.
  if (g.is_main) {
    try {
      await rekeyGroupJid(jid, g.folder, {
        whatsappSelfChatAutoLinkDisabled: true,
      });
    } catch (err) {
      logger.error({ err: String(err), jid }, 'Unlink re-key failed');
      return res.status(500).json({ error: 'Failed to unlink group' });
    }
    return res.json({ ok: true });
  }

  // For ordinary projects, re-key to a local JID so the project persists
  // without WhatsApp.
  try {
    await rekeyGroupJid(jid, `ui-${g.folder}`);
  } catch (err) {
    logger.error({ err: String(err), jid }, 'Unlink re-key failed');
    return res.status(500).json({ error: 'Failed to unlink group' });
  }

  res.json({ ok: true });
});

export default router;
