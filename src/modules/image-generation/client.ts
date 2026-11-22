import path from 'node:path';

import {
  CLOUD_IMAGE_URL,
  ENABLE_GPT_IMAGE_OAUTH,
  GPT_IMAGE_MODEL,
  IMAGE_GENERATION_RELAY_URL,
  IMAGE_GENERATION_TIMEOUT_MS,
} from '../../config.js';

export type ImageAspectRatio = 'auto' | '1:1' | '3:2' | '2:3' | '16:9' | '9:16';
type ImageQuality = 'auto' | 'low' | 'medium' | 'high';

export interface ImageGenerationOptions {
  quality?: ImageQuality;
  timeoutMs?: number;
  provider?: 'auto' | 'openai' | 'gemini';
  /** GPT Image model for the OpenAI route; defaults to GPT_IMAGE_MODEL. */
  gptModel?: string;
}

export interface ImageReference {
  data: string;
  mimetype: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface GeneratedImage {
  data: Buffer;
  mimetype: 'image/png' | 'image/jpeg' | 'image/webp';
  provider: 'openai-codex' | 'gemini';
  model: string;
}

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const GPT_SIZE_BY_ASPECT: Record<ImageAspectRatio, string> = {
  auto: 'auto',
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  // GPT Image currently exposes one landscape and one portrait size. Wider
  // ratios use the closest supported canvas and remain in the prompt/tool
  // contract so a future provider upgrade does not change callers.
  '16:9': '1536x1024',
  '9:16': '1024x1536',
};

export class ImageProviderError extends Error {
  constructor(
    message: string,
    readonly fallbackEligible: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ImageProviderError';
  }
}

function withTimeout(
  signal?: AbortSignal,
  timeoutMs = IMAGE_GENERATION_TIMEOUT_MS,
): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new Error('Image generation timed out')),
    timeoutMs,
  );
  timer.unref?.();
  const combined =
    signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeout.signal])
      : timeout.signal;
  return {
    signal: combined,
    timedOut: () =>
      timeout.signal.aborted && combined.reason === timeout.signal.reason,
    dispose: () => clearTimeout(timer),
  };
}

export function sniffMime(data: Buffer): GeneratedImage['mimetype'] | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function decodeBase64(encoded: string): Buffer {
  const normalized = encoded.replace(/\s+/g, '');
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new ImageProviderError(
      'Image provider returned malformed base64 data',
      false,
    );
  }
  const data = Buffer.from(normalized, 'base64');
  if (
    data.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')
  ) {
    throw new ImageProviderError(
      'Image provider returned malformed base64 data',
      false,
    );
  }
  return data;
}

function validateImage(data: Buffer): GeneratedImage['mimetype'] {
  if (data.length === 0)
    throw new ImageProviderError(
      'Image provider returned an empty file',
      false,
    );
  if (data.length > MAX_OUTPUT_BYTES) {
    throw new ImageProviderError(
      'Generated image exceeds the 50 MB output limit',
      false,
    );
  }
  const mimetype = sniffMime(data);
  if (!mimetype) {
    throw new ImageProviderError(
      'Image provider returned an unsupported file type',
      false,
    );
  }
  return mimetype;
}

function fallbackEligibleStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 429 ||
    status >= 500
  );
}

async function codexFailure(response: Response): Promise<ImageProviderError> {
  let classification = '';
  try {
    const raw = await response.text();
    if (raw.length <= 64 * 1024) {
      const payload = JSON.parse(raw) as {
        error?: { code?: unknown; type?: unknown; message?: unknown };
      };
      classification = [
        payload.error?.code,
        payload.error?.type,
        payload.error?.message,
      ]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase();
    }
  } catch {
    // Status alone is sufficient when the upstream does not return JSON.
  }
  const isSafetyRefusal =
    classification.includes('safety') ||
    classification.includes('moderation') ||
    classification.includes('content_policy') ||
    classification.includes('content policy');
  return new ImageProviderError(
    `GPT image generation failed with HTTP ${response.status}`,
    !isSafetyRefusal && fallbackEligibleStatus(response.status),
    response.status,
  );
}

export async function callCodex(
  prompt: string,
  references: ImageReference[],
  aspectRatio: ImageAspectRatio,
  signal?: AbortSignal,
  options: ImageGenerationOptions = {},
): Promise<GeneratedImage> {
  const model = options.gptModel || GPT_IMAGE_MODEL;
  const endpoint =
    references.length > 0 ? 'images/edits' : 'images/generations';
  const parameters = {
    prompt,
    model,
    quality: options.quality || 'auto',
    size: GPT_SIZE_BY_ASPECT[aspectRatio],
    background: 'auto',
    output_format: 'png',
  };
  // api-relay's /codex proxy accepts JSON only. The Images edits endpoint
  // supports JSON image references through `images[].image_url`, so encode
  // the already-validated project images as data URLs instead of multipart
  // `image[]` uploads. This keeps credentials in the relay while allowing
  // reference-image requests through the same path as text-only generations.
  const body = JSON.stringify({
    ...parameters,
    ...(references.length > 0
      ? {
          images: references.map((reference) => ({
            image_url: `data:${reference.mimetype};base64,${reference.data}`,
          })),
        }
      : {}),
  });
  const headers = { 'content-type': 'application/json' };

  const timeout = withTimeout(signal, options.timeoutMs);
  try {
    const response = await fetch(
      `${IMAGE_GENERATION_RELAY_URL.replace(/\/+$/, '')}/${endpoint}`,
      {
        method: 'POST',
        headers,
        body,
        signal: timeout.signal,
      },
    );
    if (!response.ok) {
      throw await codexFailure(response);
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_OUTPUT_BYTES * 2) {
      throw new ImageProviderError(
        'GPT image response exceeds the allowed size',
        false,
      );
    }
    const payload = (await response.json()) as {
      data?: Array<{ b64_json?: string }>;
    };
    const encoded = payload.data?.[0]?.b64_json;
    if (!encoded || typeof encoded !== 'string') {
      throw new ImageProviderError(
        'GPT image generation returned no image data',
        false,
      );
    }
    const data = decodeBase64(encoded);
    const mimetype = validateImage(data);
    return { data, mimetype, provider: 'openai-codex', model };
  } catch (error) {
    if (error instanceof ImageProviderError) throw error;
    if (timeout.timedOut()) throw timeout.signal.reason;
    if (signal?.aborted) throw error;
    throw new ImageProviderError('GPT image generation is unavailable', true);
  } finally {
    timeout.dispose();
  }
}

export async function callGemini(
  prompt: string,
  references: ImageReference[],
  aspectRatio: ImageAspectRatio,
  signal?: AbortSignal,
  options: ImageGenerationOptions = {},
): Promise<GeneratedImage> {
  const timeout = withTimeout(signal, options.timeoutMs);
  try {
    const response = await fetch(
      `${CLOUD_IMAGE_URL.replace(/\/+$/, '')}/v1/images`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt,
          ...(aspectRatio !== 'auto' ? { aspect_ratio: aspectRatio } : {}),
          ...(references.length > 0
            ? {
                images: references.map((reference) => ({
                  data: reference.data,
                  mime: reference.mimetype,
                })),
              }
            : {}),
        }),
        signal: timeout.signal,
      },
    );
    if (!response.ok) {
      throw new ImageProviderError(
        `Gemini image generation failed with HTTP ${response.status}`,
        false,
        response.status,
      );
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_OUTPUT_BYTES) {
      throw new ImageProviderError(
        'Generated image exceeds the 50 MB output limit',
        false,
      );
    }
    const data = Buffer.from(await response.arrayBuffer());
    const mimetype = validateImage(data);
    // The cloud-image sidecar owns the model choice (CLOUD_IMAGE_MODEL).
    const model = response.headers.get('x-image-model') || 'cloud-image';
    return { data, mimetype, provider: 'gemini', model };
  } catch (error) {
    if (error instanceof ImageProviderError) throw error;
    if (timeout.timedOut()) throw timeout.signal.reason;
    if (signal?.aborted) throw error;
    throw new ImageProviderError(
      'Gemini image generation is unavailable',
      false,
    );
  } finally {
    timeout.dispose();
  }
}

export async function generateImage(
  prompt: string,
  references: ImageReference[],
  aspectRatio: ImageAspectRatio,
  signal?: AbortSignal,
  options: ImageGenerationOptions = {},
): Promise<GeneratedImage> {
  if (options.provider === 'openai') {
    return callCodex(prompt, references, aspectRatio, signal, options);
  }
  if (options.provider === 'gemini') {
    return callGemini(prompt, references, aspectRatio, signal, options);
  }
  if (ENABLE_GPT_IMAGE_OAUTH) {
    try {
      return await callCodex(prompt, references, aspectRatio, signal, options);
    } catch (error) {
      if (!(error instanceof ImageProviderError) || !error.fallbackEligible) {
        throw error;
      }
    }
  }
  return callGemini(prompt, references, aspectRatio, signal, options);
}

export function extensionForMime(mimetype: GeneratedImage['mimetype']): string {
  return mimetype === 'image/jpeg'
    ? '.jpg'
    : mimetype === 'image/webp'
      ? '.webp'
      : '.png';
}

export function sanitizedImageFilename(
  requested: string | undefined,
  mimetype: GeneratedImage['mimetype'],
): string {
  const extension = extensionForMime(mimetype);
  const raw = path
    .basename(requested || 'generated-image')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const withoutExtension =
    raw.replace(/\.(png|jpe?g|webp)$/i, '') || 'generated-image';
  return `${withoutExtension}${extension}`;
}
