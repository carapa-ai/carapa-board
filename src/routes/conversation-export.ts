/**
 * Conversation export — one conversation as a downloadable zip of static HTML.
 *
 * Mounted on the kanban router (already gated on /projects/:pid). Path:
 *   GET /projects/:pid/conversations/:cid/export
 */
import { Router } from 'express';

import { getConversation } from '../db.js';
import { readChatTranscriptAsync } from '../group-dir.js';
import { buildConversationExport } from '../modules/chat/conversation-export.js';
import { hydrateTranscriptSenderNames } from '../modules/chat/conversation-participants.js';
import { formatPrivateUiTranscriptEntries } from '../modules/transcripts/transcript-store.js';
import { getGroupByFolder } from '../state-manager.js';
import { requireConversationAccess } from './_helpers.js';

const router = Router();

router.get('/projects/:pid/conversations/:cid/export', async (req, res) => {
  const { pid, cid } = req.params;
  const group = getGroupByFolder(pid);
  const conv = await getConversation(cid);
  if (!group || !conv || conv.group_folder !== group.folder) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  if (!(await requireConversationAccess(req, res, cid, 'read'))) return;

  // Same pipeline as the chat UI transcript, so the export sees what it sees.
  const rawEntries = await readChatTranscriptAsync(
    pid,
    cid,
    conv.created_at ?? null,
  );
  const entries = await hydrateTranscriptSenderNames(
    formatPrivateUiTranscriptEntries(rawEntries),
  );
  const { filename, zip } = await buildConversationExport({
    conversationId: conv.id,
    title: conv.title,
    group,
    entries,
  });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(Buffer.from(zip));
});

export default router;
