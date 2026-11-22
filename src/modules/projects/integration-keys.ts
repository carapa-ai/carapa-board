/**
 * Project integration keys are CarapaBox project-scope provider accounts bound
 * to a sandbox name `{stack, instance}`; Box serves them to the container of
 * that name and does not know which project a key belongs to. A project that
 * releases a name must take the keys on it along, or the next project that uses
 * the name is served them. Keys are selected by name only: there is no sharing
 * exception.
 */
import { CARAPA_BOX_URL, CARAPA_BOX_API_TOKEN } from '../../config.js';
import type { RegisteredGroup } from '../../types.js';
import { resolveEffectiveSandbox } from '../../sandbox/effective-settings.js';

export type SandboxBinding = { stack: string; instance: string };

const ACCOUNT_ID = /^[a-f0-9-]{36}$/;
const boxConfiguration = () => ({
  url: CARAPA_BOX_URL,
  token: CARAPA_BOX_API_TOKEN,
});

/** CarapaBox could not list or delete keys; the request maps it to 502. */
export class BoxCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoxCleanupError';
  }
}

/** The project's own `{stack, instance}`; none for a child inheriting its parent's sandbox. */
export function ownSandboxBinding(
  group: RegisteredGroup,
): SandboxBinding | undefined {
  const effective = resolveEffectiveSandbox(group);
  return effective.inherited
    ? undefined
    : { stack: effective.stack, instance: effective.instance };
}

/**
 * Project-scope Box keys whose instance equals `folder` (any stack: the next
 * project with that folder may use any) or that sit on `own`. Without a Box
 * token no project key can exist and Box is not called. Throws when Box does
 * not answer with a list of accounts.
 */
export async function listProjectKeyIds(
  folder: string,
  own?: SandboxBinding,
  request: typeof fetch = fetch,
  configuration = boxConfiguration(),
): Promise<string[]> {
  if (!configuration.token) return [];
  const listing = await request(
    new URL('/api/admin/provider-accounts', configuration.url),
    {
      headers: { Authorization: `Bearer ${configuration.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!listing.ok)
    throw new Error(
      `CarapaBox provider account listing failed (${listing.status})`,
    );
  const body: any = await listing.json();
  // An answer that is not a list proves nothing about the keys: fail closed.
  if (!Array.isArray(body?.accounts))
    throw new Error('CarapaBox provider account listing was not a list');
  return body.accounts
    .filter(
      (a: any) =>
        a?.scope === 'project' &&
        ACCOUNT_ID.test(String(a.id)) &&
        (a.project?.instance === folder ||
          (own &&
            a.project?.stack === own.stack &&
            a.project?.instance === own.instance)),
    )
    .map((a: any) => a.id);
}

/** Deletes the given Box keys; throws on the first failure. */
export async function deleteProjectKeyIds(
  ids: string[],
  request: typeof fetch = fetch,
  configuration = boxConfiguration(),
): Promise<void> {
  for (const id of ids) {
    const removed = await request(
      new URL('/api/admin/provider-accounts/' + id, configuration.url),
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${configuration.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
    );
    // A key already gone is the state we want.
    if (!removed.ok && removed.status !== 404)
      throw new Error(
        `CarapaBox project key deletion failed (${removed.status})`,
      );
  }
}

/** Deletes the keys selected by `listProjectKeyIds`; resolves to how many were removed. */
export async function deleteProjectKeys(
  folder: string,
  own?: SandboxBinding,
): Promise<number> {
  const ids = await listProjectKeyIds(folder, own);
  await deleteProjectKeyIds(ids);
  return ids.length;
}
