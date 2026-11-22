/**
 * Admin API for CarapaBox hosts (`/api/admin/boxes`).
 *
 * Mounted behind admin + freshly signed human-device middleware: issuing a box
 * token or placing a project on a reduced-isolation runner is security-critical.
 */
import { Router } from 'express';
import { logger } from '../logger.js';
import {
  connectedBoxIds,
  disconnectBox,
  getBoxConnection,
} from '../modules/boxes/connections.js';
import {
  createBox,
  deleteBox,
  getBox,
  getBoxForwarderKey,
  isValidBoxId,
  listBoxes,
  LOCAL_BOX_ID,
  revokeBox,
  rotateBoxToken,
  type BoxKind,
} from '../modules/boxes/registry.js';
import { updateProjectBoxId } from '../modules/kanban/db-kanban.js';
import { onPlacementChanged } from '../modules/boxes/routing.js';
import {
  resolveEffectiveSandbox,
  sharedSandboxOwner,
} from '../sandbox/effective-settings.js';
import crypto from 'node:crypto';
import { createSecretReader } from '../lib/env.js';
import {
  applyGroupUpdateInMemory,
  getGroupEntryByFolder,
  registeredGroups,
} from '../state-manager.js';

function projectsOnBox(boxId: string): string[] {
  return Object.values(registeredGroups)
    .filter(
      (group) =>
        (resolveEffectiveSandbox(group).owner.settings?.boxId ||
          LOCAL_BOX_ID) === boxId,
    )
    .map((group) => group.folder)
    .sort();
}

const router = Router();

router.get('/admin/boxes', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const records = await listBoxes();
  const known = new Set(records.map((box) => box.id));
  const boxes = records.map((box) => {
    const live = getBoxConnection(box.id);
    return {
      ...box,
      online: Boolean(live),
      connectedAt: live?.connectedAt ?? null,
      isolationLevel: live?.isolationLevel ?? box.isolationLevel,
      version: live?.version ?? box.version,
      projects: projectsOnBox(box.id),
    };
  });
  // The local box is implicit: reachable over CARAPA_BOX_URL unless it was
  // registered to connect over WebSocket like any other box.
  if (!known.has(LOCAL_BOX_ID)) {
    boxes.unshift({
      id: LOCAL_BOX_ID,
      label: 'Local CarapaBox (CARAPA_BOX_URL)',
      kind: 'docker' as BoxKind,
      tokenPrefix: '',
      isolationLevel: 'container',
      version: null,
      capabilities: [],
      createdAt: '',
      lastSeenAt: null,
      revokedAt: null,
      online: true,
      connectedAt: null,
      projects: projectsOnBox(LOCAL_BOX_ID),
    });
  }
  res.json({ boxes, connected: connectedBoxIds() });
});

router.post('/admin/boxes', async (req: any, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  const kind = req.body?.kind === 'native' ? 'native' : 'docker';
  if (!isValidBoxId(id)) {
    return res
      .status(400)
      .json({ error: 'id must be lowercase letters, digits and dashes' });
  }
  if (await getBox(id))
    return res.status(409).json({ error: 'Box already exists' });
  try {
    const { box, token } = await createBox({
      id,
      label: req.body?.label,
      kind,
    });
    logger.info(
      { boxId: id, kind, by: req.authUser?.id },
      '[boxes] Box registered',
    );
    // The plaintext token is returned exactly once.
    res.status(201).json({ box, token });
  } catch (err) {
    res
      .status(400)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/admin/boxes/:id/rotate-token', async (req: any, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const issued = await rotateBoxToken(req.params.id);
    disconnectBox(req.params.id, 'token rotated');
    logger.info(
      { boxId: req.params.id, by: req.authUser?.id },
      '[boxes] Box token rotated',
    );
    res.json({ token: issued });
  } catch (err) {
    res
      .status(404)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/admin/boxes/:id/revoke', async (req: any, res) => {
  if (!(await revokeBox(req.params.id))) {
    return res.status(404).json({ error: 'Box not found' });
  }
  disconnectBox(req.params.id, 'revoked');
  logger.info(
    { boxId: req.params.id, by: req.authUser?.id },
    '[boxes] Box revoked',
  );
  res.json({ ok: true });
});

router.delete('/admin/boxes/:id', async (req: any, res) => {
  const assigned = projectsOnBox(req.params.id);
  if (assigned.length) {
    return res.status(409).json({
      error: 'Move the projects off this box first',
      projects: assigned,
    });
  }
  if (!(await deleteBox(req.params.id))) {
    return res.status(404).json({ error: 'Box not found' });
  }
  disconnectBox(req.params.id, 'deleted');
  res.json({ ok: true });
});

/**
 * Place a project's sandbox on a box. Its group directory and IPC tree live on
 * that box host; moving an existing project is an explicit export/import, so
 * running work must be stopped first. Native boxes require an explicit
 * acknowledgement of their reduced isolation.
 */
router.put('/admin/boxes/:id/projects/:folder', async (req: any, res) => {
  const entry = getGroupEntryByFolder(req.params.folder);
  if (!entry) return res.status(404).json({ error: 'Project not found' });
  const owner = sharedSandboxOwner(entry.group);
  if (owner !== entry.group) {
    return res.status(400).json({
      error: `This project shares its parent sandbox and must follow parent project "${owner.folder}" on its box`,
    });
  }
  const boxId = req.params.id;
  if (boxId !== LOCAL_BOX_ID) {
    const box = await getBox(boxId);
    if (!box || box.revokedAt)
      return res.status(404).json({ error: 'Box not found' });
    if (
      box.kind === 'native' &&
      req.body?.acknowledgeReducedIsolation !== true
    ) {
      return res.status(400).json({
        error:
          'This box runs agents without container isolation; set acknowledgeReducedIsolation to assign a project to it',
      });
    }
  }
  if (boxId !== LOCAL_BOX_ID && entry.group.is_main) {
    // The main project mounts every group directory; it stays on the hub.
    return res
      .status(400)
      .json({ error: 'The main project always runs on the local box' });
  }
  const nextBoxId = boxId === LOCAL_BOX_ID ? undefined : boxId;
  await updateProjectBoxId(entry.group.folder, nextBoxId);
  const settings = { ...(entry.group.settings ?? {}) };
  if (nextBoxId) settings.boxId = nextBoxId;
  else delete settings.boxId;
  applyGroupUpdateInMemory(entry.jid, { settings });
  onPlacementChanged();
  logger.info(
    { project: entry.group.folder, boxId, by: req.authUser?.id },
    '[boxes] Project assigned to box',
  );
  res.json({ ok: true, project: entry.group.folder, boxId });
});

/**
 * Central api-relay lookup (machine-to-machine, `CARAPA_RELAY_HUB_SECRET`):
 * the key a box's forwarder signs with and the sandbox projects placed on it.
 * A forwarder may only speak for sandboxes of projects on its own box.
 */
export async function relayForwarderPolicy(req: any, res: any): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  // SECRETS_DIR/carapa_relay_hub_secret, falling back to the environment.
  const secret = createSecretReader()('CARAPA_RELAY_HUB_SECRET');
  const header = String(req.headers?.authorization || '');
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const presentedBytes = Buffer.from(presented);
  const secretBytes = Buffer.from(secret);
  const valid =
    secretBytes.length >= 16 &&
    presentedBytes.length === secretBytes.length &&
    crypto.timingSafeEqual(presentedBytes, secretBytes);
  if (!valid) {
    res
      .status(secret ? 401 : 503)
      .json({ error: 'Relay lookup not authorized' });
    return;
  }
  const boxId = String(req.params.boxId || '');
  const key =
    boxId && boxId !== LOCAL_BOX_ID ? await getBoxForwarderKey(boxId) : null;
  if (!key) {
    res.status(404).json({ error: 'Unknown box' });
    return;
  }
  const projects = new Set<string>();
  for (const group of Object.values(registeredGroups)) {
    try {
      const effective = resolveEffectiveSandbox(group);
      if (effective.owner.settings?.boxId === boxId) {
        projects.add(`${effective.stack}-${effective.instance}`);
      }
    } catch {
      /* unresolvable group */
    }
  }
  res.json({ key, projects: [...projects].sort() });
}

export default router;
