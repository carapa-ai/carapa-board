// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { repositoryDiscoveryAvailability } from './repository-discovery';

describe('repository discovery report UI', () => {
  test('disables discovery until workspace roots are saved and unchanged', () => {
    expect(
      repositoryDiscoveryAvailability(
        {
          isParent: true,
          sandboxOwnership: 'shared',
          sharedWorkspaceHostLocation: '/host/new',
          sharedWorkspaceContainerRoot: '/workspace/new',
        },
        {
          isParent: true,
          sandboxOwnership: 'shared',
          sharedWorkspaceHostLocation: '/host/old',
          sharedWorkspaceContainerRoot: '/workspace/old',
        },
      ),
    ).toEqual({
      enabled: false,
      reason: 'Save workspace location changes before running discovery.',
    });
    expect(
      repositoryDiscoveryAvailability(
        {
          isParent: true,
          sandboxOwnership: 'shared',
          sharedWorkspaceHostLocation: '/host/repos',
          sharedWorkspaceContainerRoot: '/workspace/repos',
        },
        undefined,
      ).enabled,
    ).toBe(false);
    expect(
      repositoryDiscoveryAvailability(
        {
          isParent: true,
          sandboxOwnership: 'shared',
          sharedWorkspaceHostLocation: ' /host/repos ',
          sharedWorkspaceContainerRoot: '/workspace/repos',
        },
        {
          isParent: true,
          sandboxOwnership: 'shared',
          sharedWorkspaceHostLocation: '/host/repos',
          sharedWorkspaceContainerRoot: '/workspace/repos',
        },
      ),
    ).toEqual({ enabled: true });
  });

  test('disables discovery when parent/shared eligibility is only present in the unsaved form', () => {
    expect(
      repositoryDiscoveryAvailability(
        {
          isParent: true,
          sandboxOwnership: 'shared',
          sharedWorkspaceHostLocation: '/host/repos',
          sharedWorkspaceContainerRoot: '/workspace/repos',
        },
        {
          isParent: false,
          sandboxOwnership: 'standalone',
          sharedWorkspaceHostLocation: '/host/repos',
          sharedWorkspaceContainerRoot: '/workspace/repos',
        },
      ),
    ).toEqual({
      enabled: false,
      reason:
        'Save parent and sandbox ownership changes before running discovery.',
    });
  });
});
