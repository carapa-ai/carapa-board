import { effectiveContainerGroupDir } from '../../sandbox/effective-settings.js';
import { getGroupByFolder } from '../../state-manager.js';

/** The project artifacts mount in its effective agent sandbox. */
export function containerArtifactsDir(groupFolder: string): string | undefined {
  const group = getGroupByFolder(groupFolder);
  return group ? `${effectiveContainerGroupDir(group)}/artifacts` : undefined;
}
