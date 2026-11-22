import { getSandboxClient } from '../../lib/mcp-client.js';
import { readArtifactFile } from '../chat/artifacts.js';
import { containerArtifactsDir } from '../image-generation/artifact-path.js';
import { GroupFsError } from '../../lib/group-fs.js';
import {
  prepareGroupSandbox,
  resolveSandboxPath,
  shellQuote,
} from '../fs/sandbox-fs.js';

const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;

/** Read project image bytes across the board/sandbox boundary, never a host path. */
export async function readThumbnailSource(
  groupFolder: string,
  sourcePath: string,
): Promise<Buffer> {
  const effectiveArtifactsDir = containerArtifactsDir(groupFolder);
  const prefix = [
    ...(effectiveArtifactsDir ? [`${effectiveArtifactsDir}/`] : []),
    'artifacts/',
    `/workspace/${groupFolder}/artifacts/`,
    '/workspace/group/artifacts/',
  ].find((candidate) => sourcePath.startsWith(candidate));
  let data: Buffer;
  if (prefix) {
    const result = await readArtifactFile(
      groupFolder,
      sourcePath.slice(prefix.length).split('/'),
      MAX_THUMBNAIL_BYTES,
    ).catch((err) => {
      if (err instanceof GroupFsError && err.code === 'too_large')
        throw new Error(
          'Thumbnail source must be an image file of at most 10 MB',
        );
      throw err;
    });
    if (!result)
      throw new Error(
        'Thumbnail source is missing or outside project artifacts',
      );
    data = result;
  } else {
    const sandbox = await prepareGroupSandbox(groupFolder);
    const resolved = resolveSandboxPath(
      { primary: sandbox.workspaceRoot, extra: sandbox.extraRoots },
      sourcePath,
    );
    const result = await getSandboxClient().sandboxExec(
      sandbox.stack,
      sandbox.service,
      `fs-tool.sh read-file ${shellQuote(resolved)}`,
      { instance: sandbox.instance, timeout: 60 },
    );
    const encoded = result.stdout.trim();
    if (
      result.isError ||
      !encoded ||
      encoded.length > Math.ceil(MAX_THUMBNAIL_BYTES / 3) * 4
    )
      throw new Error('Unable to read thumbnail source (maximum 10 MB)');
    data = Buffer.from(encoded, 'base64');
    if (data.toString('base64') !== encoded)
      throw new Error('Unable to read thumbnail source');
  }
  if (data.length > MAX_THUMBNAIL_BYTES)
    throw new Error('Thumbnail source exceeds 10 MB');
  return data;
}
