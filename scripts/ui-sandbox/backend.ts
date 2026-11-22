import path from 'node:path';

import '../../src/index.js';

import {
  approveDevice,
  getAllDevices,
  getTask,
  updateTask,
} from '../../src/db.js';
import {
  SANDBOX_ADMIN,
  findBootstrapAdminDevice,
  hasApprovedDeviceForUser,
} from './shared.js';

const gitRepo = process.env.UI_SANDBOX_GIT_REPO;
if (gitRepo) {
  const expectedWorktree = path.join(gitRepo, '.worktrees', 'ui-symlink-task');
  const deadline = Date.now() + 45_000;
  let restored = false;
  while (Date.now() < deadline) {
    try {
      const task = await getTask('ui-task-symlink-changes');
      if (task?.worktree_path === expectedWorktree) {
        restored = true;
        break;
      }
      if (task?.worktree_path === null) {
        await updateTask(task.id, { worktree_path: expectedWorktree });
        restored = true;
        break;
      }
    } catch {
      // Database/bootstrap is still initializing.
    }
    await Bun.sleep(50);
  }
  if (!restored) {
    throw new Error(
      'UI sandbox Git fixture worktree was not restored after recovery',
    );
  }
}

// Two-user mode: the admin's first browser device lands pending because the
// member already exists, and a pending device cannot sign the fresh-signature
// request that approves it. Approve that one bootstrap device directly in this
// disposable database; every later approval goes through the signed API.
if (process.env.UI_SANDBOX_TWO_USER === 'true') {
  void (async () => {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      try {
        const devices = await getAllDevices();
        if (hasApprovedDeviceForUser(devices, SANDBOX_ADMIN.username)) return;
        const device = findBootstrapAdminDevice(
          devices,
          SANDBOX_ADMIN.username,
        );
        if (device) {
          await approveDevice(device.deviceId, device.userId);
          return;
        }
      } catch {
        // Database/bootstrap is still initializing.
      }
      await Bun.sleep(100);
    }
  })();
}
