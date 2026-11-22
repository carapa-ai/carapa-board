import { runtimeChanges } from './lib/runtime-changes.js';
import { broadcast } from './modules/objectives/ws-events.js';
import { registeredGroups } from './state-manager.js';
import { resolveEffectiveSandbox } from './sandbox/effective-settings.js';

/** Batch sibling mutations and never include catalog, shell or container data. */
export function startRuntimeNotifications(): () => void {
  const pending = new Set<string>();
  const shellOwners = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (kind: string, owner?: string) => {
    pending.add(kind);
    if (owner) shellOwners.add(owner);
    timer ??= setTimeout(() => {
      timer = undefined;
      if (pending.has('catalog'))
        broadcast({ type: 'runtime_catalog_changed', payload: {} });
      if (pending.has('sandbox'))
        broadcast({ type: 'sandbox_state_changed', payload: {} });
      if (pending.has('shells')) {
        for (const group of Object.values(registeredGroups)) {
          if (
            shellOwners.has(group.folder) ||
            shellOwners.has(resolveEffectiveSandbox(group).owner.folder)
          ) {
            broadcast({
              type: 'shells_changed',
              payload: { folder: group.folder },
            });
          }
        }
      }
      pending.clear();
      shellOwners.clear();
    }, 150);
  };
  const catalog = () => schedule('catalog');
  const sandbox = () => schedule('sandbox');
  const shells = (owner: string) => schedule('shells', owner);
  runtimeChanges.on('catalog', catalog);
  runtimeChanges.on('sandbox', sandbox);
  runtimeChanges.on('shells', shells);
  return () => {
    if (timer) clearTimeout(timer);
    runtimeChanges.off('catalog', catalog);
    runtimeChanges.off('sandbox', sandbox);
    runtimeChanges.off('shells', shells);
  };
}
