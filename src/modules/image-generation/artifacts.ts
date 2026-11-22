import { logger } from '../../logger.js';
import { lstatAtSync } from '../../lib/group-fs.js';
import { artifactUrl, openArtifactsRootSync } from '../chat/artifacts.js';
import type { ChatMessageAttachment } from '../chat/types.js';
import { containerArtifactsDir } from './artifact-path.js';

export const GENERATED_IMAGE_ARTIFACT_TYPE = 'generated_image_artifact';

export interface GeneratedImageArtifact {
  provider: 'openai-codex' | 'gemini';
  model: string;
  mimetype: 'image/png' | 'image/jpeg' | 'image/webp';
  filename: string;
  relPath: string;
  containerPath: string;
  browserUrl: string;
}

export interface GeneratedImageArtifactEnvelope {
  type: typeof GENERATED_IMAGE_ARTIFACT_TYPE;
  artifact: GeneratedImageArtifact;
}

function isArtifact(value: unknown): value is GeneratedImageArtifact {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    (item.provider === 'openai-codex' || item.provider === 'gemini') &&
    typeof item.model === 'string' &&
    (item.mimetype === 'image/png' ||
      item.mimetype === 'image/jpeg' ||
      item.mimetype === 'image/webp') &&
    typeof item.filename === 'string' &&
    typeof item.relPath === 'string' &&
    typeof item.containerPath === 'string' &&
    typeof item.browserUrl === 'string'
  );
}

function visit(value: unknown, out: GeneratedImageArtifact[]): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
      return;
    }
    try {
      visit(JSON.parse(trimmed), out);
    } catch {
      // Agent transcripts are JSONL. Parse complete lines independently.
      if (trimmed.includes('\n')) {
        for (const line of trimmed.split('\n')) {
          const candidate = line.trim();
          if (candidate.startsWith('{') || candidate.startsWith('[')) {
            visit(candidate, out);
          }
        }
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visit(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (
    record.type === GENERATED_IMAGE_ARTIFACT_TYPE &&
    isArtifact(record.artifact)
  ) {
    out.push(record.artifact);
    return;
  }

  // Provider stream formats wrap MCP results at different nesting levels
  // (`item.result.content`, Claude `message.content`, etc.).
  for (const nested of Object.values(record)) visit(nested, out);
}

export function extractGeneratedImageArtifacts(
  value: unknown,
): GeneratedImageArtifact[] {
  const found: GeneratedImageArtifact[] = [];
  visit(value, found);
  return Array.from(
    new Map(found.map((artifact) => [artifact.browserUrl, artifact])).values(),
  );
}

function isGenuineRelPath(relPath: string): boolean {
  if (!relPath.startsWith('images/') || relPath.includes('\\')) return false;
  return relPath
    .split('/')
    .every((seg) => seg !== '' && seg !== '..' && seg !== '.');
}

function isExistingArtifactFile(groupFolder: string, relPath: string): boolean {
  try {
    const root = openArtifactsRootSync(groupFolder);
    if (!root) return false;
    try {
      return lstatAtSync(root, relPath)?.isFile() === true;
    } finally {
      root.closeSync();
    }
  } catch {
    return false;
  }
}

/**
 * Tool output is untrusted: any tool can print a forged artifact envelope.
 * Keep only artifacts that match exactly what the board's own image tool emits
 * for this project and that point at an existing file in its artifacts tree.
 */
export function filterTrustedGeneratedArtifacts(
  artifacts: GeneratedImageArtifact[],
  groupFolder: string,
): GeneratedImageArtifact[] {
  const artifactsDir = containerArtifactsDir(groupFolder);
  const trusted = artifacts.filter(
    (artifact) =>
      artifactsDir !== undefined &&
      isGenuineRelPath(artifact.relPath) &&
      artifact.browserUrl === artifactUrl(groupFolder, artifact.relPath) &&
      artifact.containerPath === `${artifactsDir}/${artifact.relPath}` &&
      isExistingArtifactFile(groupFolder, artifact.relPath),
  );
  const dropped = artifacts.length - trusted.length;
  if (dropped > 0) {
    logger.warn(
      { groupFolder, dropped },
      'Dropped untrusted generated image artifacts from tool output',
    );
  }
  return trusted;
}

export function generatedArtifactsToAttachments(
  artifacts: GeneratedImageArtifact[],
): ChatMessageAttachment[] {
  return artifacts.map((artifact) => ({
    type: 'image',
    url: artifact.browserUrl,
    mimetype: artifact.mimetype,
    filename: artifact.filename,
    path: artifact.containerPath,
  }));
}
