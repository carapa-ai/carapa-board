import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

import type { ToolDefinition } from '../tools/types.js';
import { startToolProgress } from '../tools/tool-execution.js';
import { getSandboxClient } from '../../lib/mcp-client.js';
import {
  prepareGroupSandbox,
  resolveSandboxPath,
  shellQuote,
} from '../fs/sandbox-fs.js';
import {
  groupArtifactsDir,
  readArtifactFile,
  writeArtifactFile,
} from '../chat/artifacts.js';
import { GroupFsError } from '../../lib/group-fs.js';
import {
  generateImage,
  sanitizedImageFilename,
  type ImageAspectRatio,
  type ImageGenerationOptions,
  type ImageReference,
} from './client.js';
import {
  GENERATED_IMAGE_ARTIFACT_TYPE,
  type GeneratedImageArtifactEnvelope,
} from './artifacts.js';
import { broadcast } from '../objectives/ws-events.js';
import { safeResolve } from '../../lib/file-content.js';
import { containerArtifactsDir } from './artifact-path.js';

// Models the agent may pick. Omitting `model` keeps the configured default
// (GPT_IMAGE_MODEL, with Gemini as fallback); an explicit choice never falls
// back silently, so a failure is visible and the agent can retry another.
const IMAGE_MODEL_CHOICES = {
  'gpt-image-2.6-sunburst': {
    provider: 'openai',
    gptModel: 'gpt-image-2.6-sunburst',
  },
  'gpt-image-2.6-flare': {
    provider: 'openai',
    gptModel: 'gpt-image-2.6-flare',
  },
  'nano-banana': { provider: 'gemini' },
} as const satisfies Record<string, ImageGenerationOptions>;

type ImageModelChoice = keyof typeof IMAGE_MODEL_CHOICES;

const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;
const REFERENCE_READ_TIMEOUT_S = 60;

function referenceMime(data: Buffer): ImageReference['mimetype'] | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50)
    return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8)
    return 'image/jpeg';
  if (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

async function readReferences(
  groupFolder: string,
  requestedPaths: string[],
  artifactsDir: string,
): Promise<ImageReference[]> {
  if (requestedPaths.length === 0) return [];
  const sandbox = await prepareGroupSandbox(groupFolder);
  const client = getSandboxClient();
  const references: ImageReference[] = [];
  for (const requestedPath of requestedPaths) {
    const artifactPrefixes = [
      `${artifactsDir}/`,
      `/workspace/${groupFolder}/artifacts/`,
      'artifacts/',
    ];
    const artifactPrefix = artifactPrefixes.find((prefix) =>
      requestedPath.startsWith(prefix),
    );
    if (artifactPrefix) {
      const rel = requestedPath.slice(artifactPrefix.length);
      const root = groupArtifactsDir(groupFolder);
      if (!rel) {
        throw new Error(`Invalid artifact reference "${requestedPath}"`);
      }
      try {
        safeResolve(root, rel);
      } catch {
        throw new Error(`Invalid artifact reference "${requestedPath}"`);
      }
      // A missing root, unsafe path or unreadable file is "unable to read".
      let data: Buffer | null = null;
      try {
        data = await readArtifactFile(
          groupFolder,
          rel.split('/'),
          MAX_REFERENCE_BYTES,
        );
      } catch (err) {
        if (err instanceof GroupFsError && err.code === 'too_large') {
          throw new Error(`Reference image "${requestedPath}" exceeds 25 MB`);
        }
      }
      if (!data) {
        throw new Error(`Unable to read reference image "${requestedPath}"`);
      }
      const mimetype = referenceMime(data);
      if (!mimetype) {
        throw new Error(
          `Reference image "${requestedPath}" is not a readable PNG, JPEG, or WebP file (it may be missing, empty, or deleted while being read)`,
        );
      }
      references.push({ data: data.toString('base64'), mimetype });
      continue;
    }
    const resolvedPath = resolveSandboxPath(
      { primary: sandbox.workspaceRoot, extra: sandbox.extraRoots },
      requestedPath,
    );
    const result = await client.sandboxExec(
      sandbox.stack,
      sandbox.service,
      `fs-tool.sh read-file ${shellQuote(resolvedPath)}`,
      { instance: sandbox.instance, timeout: REFERENCE_READ_TIMEOUT_S },
    );
    if (result.isError || !result.stdout.trim()) {
      throw new Error(`Unable to read reference image "${requestedPath}"`);
    }
    const data = Buffer.from(result.stdout.trim(), 'base64');
    if (data.length > MAX_REFERENCE_BYTES) {
      throw new Error(`Reference image "${requestedPath}" exceeds 25 MB`);
    }
    const mimetype = referenceMime(data);
    if (!mimetype) {
      throw new Error(
        `Reference image "${requestedPath}" is not a readable PNG, JPEG, or WebP file (it may be missing, empty, or deleted while being read)`,
      );
    }
    references.push({ data: data.toString('base64'), mimetype });
  }
  return references;
}

export const generateImageTool: ToolDefinition = {
  name: 'generate_image',
  privacyPurpose: 'image',
  description:
    'Generate a new image or edit up to five existing project images. The result is saved under the project artifacts/images folder and attached to the final reply. Photos the user uploaded to the chat are readable as artifacts/upload/<conversation-id>/<file>; paths under /workspace/ipc/ are not accepted. Do not delete or move a reference file until the call has returned.',
  inputSchema: {
    prompt: z
      .string()
      .min(1)
      .max(32_000)
      .describe('The image to generate, or editing instructions.'),
    referenced_image_paths: z
      .array(z.string())
      .max(5)
      .optional()
      .describe(
        'Optional project/sandbox image paths to edit or use as references (maximum five).',
      ),
    aspect_ratio: z
      .enum(['auto', '1:1', '3:2', '2:3', '16:9', '9:16'])
      .optional()
      .describe('Optional output aspect ratio. Defaults to auto.'),
    model: z
      .enum(
        Object.keys(IMAGE_MODEL_CHOICES) as [
          keyof typeof IMAGE_MODEL_CHOICES,
          ...(keyof typeof IMAGE_MODEL_CHOICES)[],
        ],
      )
      .optional()
      .describe(
        'Optional model. gpt-image-2.6-sunburst: best quality and edit consistency (slower). gpt-image-2.6-flare: fast drafts. nano-banana: Gemini, good for quick edits and reference-photo likeness. Omit to use the default.',
      ),
    filename: z
      .string()
      .max(160)
      .optional()
      .describe(
        'Optional output filename. The extension is selected from the returned image type.',
      ),
  },
  requiredPermissions: ['images:generate'],
  mcpTimeoutMs: 10 * 60 * 1000,
  handler: async (
    { prompt, referenced_image_paths, aspect_ratio, model, filename },
    _deps,
    context,
  ) => {
    const artifactsDir = containerArtifactsDir(context.group_folder);
    if (!artifactsDir)
      throw new Error(`Group not found: ${context.group_folder}`);
    const references = await readReferences(
      context.group_folder,
      referenced_image_paths || [],
      artifactsDir,
    );
    // Generation can outlast an MCP client's 60 s request timeout.
    const stopProgress = startToolProgress(context, 'Generating image…');
    let generated;
    try {
      generated = await generateImage(
        prompt.trim(),
        references,
        (aspect_ratio || 'auto') as ImageAspectRatio,
        context.signal,
        model ? { ...IMAGE_MODEL_CHOICES[model as ImageModelChoice] } : {},
      );
    } finally {
      stopProgress();
    }
    const safeFilename = sanitizedImageFilename(filename, generated.mimetype);
    const storedName = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeFilename}`;
    const relPath = path.posix.join('images', storedName);
    const stored = await writeArtifactFile(
      context.group_folder,
      relPath,
      generated.data,
      { mimetype: generated.mimetype, source: 'agent' },
    );
    broadcast({
      type: 'artifacts_changed',
      payload: { folder: context.group_folder },
    });

    const envelope: GeneratedImageArtifactEnvelope = {
      type: GENERATED_IMAGE_ARTIFACT_TYPE,
      artifact: {
        provider: generated.provider,
        model: generated.model,
        mimetype: generated.mimetype,
        filename: safeFilename,
        relPath: stored.relPath,
        containerPath: `${artifactsDir}/${stored.relPath}`,
        browserUrl: stored.url,
      },
    };
    return envelope;
  },
};
