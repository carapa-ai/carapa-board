// Required Notice: Copyright Regun Software SRL (https://carapa.ai)

import {
  getRuntimeCatalog,
  getRuntimeLocality,
  resolveRuntimeSelection,
  type ChatAgentOption,
} from '../../lib/chat-agents.js';
import { logger } from '../../logger.js';
import {
  wrapUntrustedWebContent,
  type WebScreeningDeps,
} from './content-safety.js';

const OCR_TIMEOUT_MS = 30_000;
const OCR_MAX_TOKENS = 1024;
export const OCR_MAX_CHARS = 4_000;
const OCR_PROMPT =
  'Transcribe the text in this image exactly. Output only the text. If there is no text, output nothing.';

const IMAGE_OCR_UNCONFIGURED_NOTE =
  '(Image text was not transcribed or screened: no local vision runtime configured.)';
const IMAGE_OCR_FAILED_NOTE = '(Image transcription failed.)';
const IMAGE_OCR_EMPTY_NOTE = 'No text found in the image.';

interface ImageOcrClient {
  chat: {
    completions: {
      create(
        params: any,
        options?: { signal?: AbortSignal },
      ): Promise<{ choices: Array<{ message?: { content?: string | null } }> }>;
    };
  };
}

export interface ImageOcrDeps {
  /** The configured `defaults.imageOcr` runtime, if any. */
  resolveAgent?: () => ChatAgentOption | undefined;
  createClient?: (agent: ChatAgentOption) => Promise<ImageOcrClient>;
}

function resolveConfiguredAgent(): ChatAgentOption | undefined {
  const selection = getRuntimeCatalog().defaults.imageOcr;
  return selection ? resolveRuntimeSelection(selection) : undefined;
}

async function createOpenAiClient(
  agent: ChatAgentOption,
): Promise<ImageOcrClient> {
  const OpenAI = (await import('openai')).default;
  return new OpenAI({
    apiKey: agent.apiKey || 'sk-no-key-required',
    baseURL: agent.baseUrl,
  }) as unknown as ImageOcrClient;
}

/**
 * Transcribe the text in an image with the local vision runtime selected by
 * `defaults.imageOcr`. Returns null when no usable runtime is configured: the
 * runtime must be local and image-capable, because downloaded images can come
 * from private chats and never go to a remote model. Throws on request failure.
 */
export async function transcribeImageText(
  buffer: Buffer,
  mimetype: string,
  signal?: AbortSignal,
  deps: ImageOcrDeps = {},
): Promise<string | null> {
  const agent = (deps.resolveAgent ?? resolveConfiguredAgent)();
  if (
    !agent ||
    agent.image !== true ||
    !agent.baseUrl ||
    getRuntimeLocality(agent) !== 'local'
  ) {
    return null;
  }

  const client = await (deps.createClient ?? createOpenAiClient)(agent);
  const timeout = AbortSignal.timeout(OCR_TIMEOUT_MS);
  const response = await client.chat.completions.create(
    {
      model: agent.model ?? agent.id,
      temperature: 0,
      max_tokens: OCR_MAX_TOKENS,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimetype};base64,${buffer.toString('base64')}`,
              },
            },
            { type: 'text', text: OCR_PROMPT },
          ],
        },
      ],
      ...(agent.extra_body ?? {}),
    },
    { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
  );

  const text = (response.choices[0]?.message?.content ?? '').trim();
  return text.slice(0, OCR_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, '');
}

/**
 * Text appended to the web_fetch_image result: the screened transcription
 * inside the untrusted envelope, or a note on why there is none. Never throws.
 */
export async function describeImageText(options: {
  buffer: Buffer;
  mimetype: string;
  source: string;
  projectId: string | undefined;
  signal?: AbortSignal;
  ocr?: ImageOcrDeps;
  screening?: WebScreeningDeps;
}): Promise<string> {
  const { buffer, mimetype, source, projectId, signal } = options;
  let text: string | null;
  try {
    text = await transcribeImageText(buffer, mimetype, signal, options.ocr);
  } catch (err) {
    logger.warn(
      { err, project: projectId },
      'web_fetch_image transcription failed',
    );
    return IMAGE_OCR_FAILED_NOTE;
  }
  if (text === null) return IMAGE_OCR_UNCONFIGURED_NOTE;
  if (!text) return IMAGE_OCR_EMPTY_NOTE;
  return wrapUntrustedWebContent({
    tool: 'web_fetch_image',
    source,
    heading: 'Text found in the image:',
    content: text,
    projectId,
    signal,
    deps: options.screening,
  });
}
