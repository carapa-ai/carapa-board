import { loadImage } from '@napi-rs/canvas';
import { AVATAR_GENERATION_TIMEOUT_MS } from '../../config.js';
import {
  extensionForMime,
  generateImage,
  ImageProviderError,
  sniffMime,
} from './client.js';
import type { ImageReference } from './client.js';

export const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
export type AvatarGenerationMode = 'generate' | 'modify';

export async function decodeAvatarDataUrl(
  dataUrl: unknown,
): Promise<{ data: Buffer; extension: string } | null> {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(
    /^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/=]+)$/,
  );
  if (!match) return null;
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > AVATAR_MAX_BYTES) return null;
  const mimetype = sniffMime(data);
  if (!mimetype || mimetype !== `image/${match[1]}`) return null;
  if (
    (mimetype === 'image/png' && data.length < 24) ||
    (mimetype === 'image/jpeg' && data.length < 11) ||
    (mimetype === 'image/webp' && data.length < 14)
  ) {
    return null;
  }
  try {
    const image = await loadImage(data);
    if (
      !Number.isFinite(image.width) ||
      !Number.isFinite(image.height) ||
      image.width <= 0 ||
      image.height <= 0
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { data, extension: extensionForMime(mimetype) };
}

export function normalizeAvatarGenerationError(error: unknown): Error {
  if (error instanceof ImageProviderError) {
    if (error.status === 429) {
      return new Error(
        'Nano Banana image generation is rate-limited or out of quota on the Google AI subscription. Wait a little and try again.',
      );
    }
    if (error.status === 401 || error.status === 403) {
      return new Error(
        'Nano Banana image generation is not authorized. Check the Google (Antigravity) login under Admin → Provider accounts.',
      );
    }
  }
  const message =
    error instanceof Error ? error.message : 'Avatar generation failed';
  return new Error(
    /timed? out|timeout/i.test(message)
      ? 'Avatar generation exceeded the provider wait time. Please try again.'
      : `Nano Banana avatar generation failed: ${message}`,
  );
}

export async function generateAvatarImage(options: {
  prompt: string;
  mode: AvatarGenerationMode;
  reference?: ImageReference;
  subject: 'account' | 'persona';
}): Promise<{ data: Buffer; extension: string; mimetype: string }> {
  if (options.mode === 'modify' && !options.reference) {
    throw new Error('The base avatar is no longer available');
  }
  const generationPrompt =
    options.mode === 'modify'
      ? [
          `Edit the supplied current ${options.subject} avatar while preserving the same recognizable identity and overall visual continuity.`,
          `Apply these requested modifications: ${options.prompt}`,
          'Return one polished square profile avatar only. Do not create an emote sheet or add text, lettering, logos, watermarks, or borders.',
        ].join(' ')
      : options.prompt;
  const generated = await generateImage(
    generationPrompt,
    options.reference ? [options.reference] : [],
    '1:1',
    undefined,
    {
      quality: 'low',
      timeoutMs: AVATAR_GENERATION_TIMEOUT_MS,
      provider: 'gemini',
    },
  );
  return {
    data: generated.data,
    extension: extensionForMime(generated.mimetype),
    mimetype: generated.mimetype,
  };
}
