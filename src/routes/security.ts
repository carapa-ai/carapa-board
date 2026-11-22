import { Router } from 'express';
import {
  createConversation,
  saveChatMessage,
} from '../modules/chat/db-chats.js';
import { enqueuePersistedDirectFollowup } from '../modules/chat/direct-followups.js';
import { getResolvedRuntimeConfig } from '../lib/resolve-agent-config.js';
import { registeredGroups } from '../state-manager.js';
import type { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import {
  readPrompt,
  writePrompt,
  deletePrompt,
  MAX_LEN,
  lenError,
} from './_helpers.js';
import { requireAuth } from './auth-helpers.js';

/**
 * Security-related endpoints. Currently:
 *
 *   POST /api/security/duress
 *     The client side detected a duress-PIN entry and is now wiping its
 *     local session. This endpoint writes a marked chat message to the
 *     calling user's main-group chat so the agent can act on per-user
 *     instructions configured in its prompt.
 *
 *     Auth: session cookie (the user is logged in at this point — the
 *     LockScreen is downstream of authentication). The endpoint MUST
 *     return 200 in every observable failure mode: a different status
 *     code, latency, or error body could tip off a coercer that the
 *     PIN they just observed was a duress code rather than the real one.
 *
 *   GET / PUT /api/security/duress-instructions
 *     Read/write the per-user instructions the main agent follows when a
 *     duress signal fires. Stored server-side only (never on the device —
 *     a coerced/stolen phone can't read them) as a prompt file
 *     `groups/<mainGroup.folder>/.agent/prompts/duress.md`. Re-auth is
 *     enforced client-side (app PIN on Android, biometric/WebAuthn on
 *     web/iOS) before these endpoints are called.
 */

/** Filename of the duress instructions prompt within a group's .agent/prompts dir. */
const DURESS_PROMPT_FILE = 'duress.md';

const router = Router();

/**
 * Locate the calling user's main agent group. In a multi-user deployment each
 * user has their own main group keyed by user_id; the global lookup (just
 * `is_main`) would route every user to the same group — wrong.
 */
function findMainGroup(userId: string): RegisteredGroup | undefined {
  return Object.values(registeredGroups).find(
    (g) => !!g.is_main && g.user_id === userId,
  );
}

router.post('/security/duress', requireAuth, async (req: any, res) => {
  const userId = req.authUser.id as string;
  const username = (req.authUser.username as string | undefined) ?? userId;

  const timestamp =
    typeof req.body?.timestamp === 'string' && req.body.timestamp.length > 0
      ? req.body.timestamp
      : new Date().toISOString();
  const hint =
    typeof req.body?.hint === 'string' && req.body.hint.length > 0
      ? req.body.hint
      : null;

  const mainGroup = findMainGroup(userId);

  if (!mainGroup) {
    // Log internally so an operator can see why the alert went nowhere,
    // but return success to the client — never expose this state.
    logger.error(
      { userId, mainGroupFolder: null },
      '[security:duress] no main group registered for this user; alert dropped',
    );
    return res.status(200).json({ ok: true });
  }

  const lines: string[] = [
    `🚨 DURESS SIGNAL · ${timestamp}`,
    `User: ${username}`,
  ];
  if (hint) lines.push(`Hint: ${hint}`);
  lines.push(
    'The user just entered their duress PIN. The device session has been ' +
      'wiped (kill-switch fired) and the app is now showing a connection-error ' +
      'screen to the holder of the device, indistinguishable from a real ' +
      'network outage. Follow the per-user instructions configured in your ' +
      'prompt to handle this signal.',
  );

  // Append the user's configured duress instructions, if any. These are
  // stored server-side (never on the device) and delivered at the moment
  // they're needed rather than injected into every normal run's context.
  // A missing/empty file simply means no appended instructions.
  try {
    const instructions = await readPrompt(
      mainGroup.folder,
      mainGroup.parentId,
      DURESS_PROMPT_FILE,
    );
    if (instructions) {
      lines.push('', '--- Configured duress instructions ---', instructions);
    }
  } catch {
    logger.error(
      { userId, mainGroupFolder: mainGroup.folder },
      '[security:duress] failed to read duress instructions; continuing without them',
    );
  }

  try {
    const runtime = getResolvedRuntimeConfig(mainGroup);
    if (!runtime) throw new Error('No chat runtime configured');
    const conversation = await createConversation(mainGroup.folder, {
      ownerUserId: userId,
      triggerSource: 'system',
    });
    const content = lines.join('\n');
    const message = await saveChatMessage({
      group_folder: mainGroup.folder,
      conversation_id: conversation.id,
      role: 'user',
      content,
      source: 'web',
      created_at: new Date().toISOString(),
      sender_name: 'duress-signal',
    });
    await enqueuePersistedDirectFollowup({
      message,
      metadata: {
        conversationId: conversation.id,
        executionContent: content,
        agentCmd: runtime.id,
        triggeredByUserId: userId,
        triggerSource: 'system',
      },
    });
    logger.warn(
      { userId, mainGroupFolder: mainGroup.folder },
      '[security:duress] duress signal delivered',
    );
  } catch {
    logger.error(
      { userId, mainGroupFolder: mainGroup.folder },
      '[security:duress] failed to deliver duress signal',
    );
    // Still 200 — see top-of-file note about indistinguishable failure modes.
  }

  return res.status(200).json({ ok: true });
});

/**
 * GET /api/security/duress-instructions
 *   Read the per-user duress instructions for the caller's main group.
 *   Re-auth (app PIN / biometric) is enforced client-side before this call.
 */
router.get(
  '/security/duress-instructions',
  requireAuth,
  async (req: any, res) => {
    const userId = req.authUser.id as string;
    const mainGroup = findMainGroup(userId);
    if (!mainGroup) {
      return res
        .status(404)
        .json({ error: 'No main group registered for this user' });
    }
    const instructions = await readPrompt(
      mainGroup.folder,
      mainGroup.parentId,
      DURESS_PROMPT_FILE,
    );
    return res.status(200).json({ instructions: instructions ?? '' });
  },
);

/**
 * PUT /api/security/duress-instructions
 *   Save (or clear) the per-user duress instructions for the caller's main
 *   group. An empty string clears the stored file. Re-auth (app PIN /
 *   biometric) is enforced client-side before this call.
 */
router.put(
  '/security/duress-instructions',
  requireAuth,
  async (req: any, res) => {
    const userId = req.authUser.id as string;

    const instructions =
      typeof req.body?.instructions === 'string' ? req.body.instructions : '';
    const lenErr = lenError(instructions, MAX_LEN.prompt, 'instructions');
    if (lenErr) return res.status(400).json({ error: lenErr });

    const mainGroup = findMainGroup(userId);
    if (!mainGroup) {
      return res
        .status(404)
        .json({ error: 'No main group registered for this user' });
    }

    const trimmed = instructions.trim();
    if (trimmed.length === 0) {
      await deletePrompt(
        mainGroup.folder,
        mainGroup.parentId,
        DURESS_PROMPT_FILE,
      );
    } else {
      await writePrompt(
        mainGroup.folder,
        mainGroup.parentId,
        DURESS_PROMPT_FILE,
        trimmed,
      );
    }

    return res.status(200).json({ ok: true });
  },
);

export default router;
