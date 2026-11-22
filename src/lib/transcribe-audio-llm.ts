import type { ChatAgentOption } from '../lib/chat-agents.js';
import {
  prepareAudioBufferForLlm,
  ollamaAudioExtraBody,
  ollamaNativeChat,
  isOllamaBackend,
} from './audio-for-llm.js';
import { logger } from '../logger.js';

const MEETING_TRANSCRIBE_PROMPT =
  'Transcribe this meeting audio segment verbatim. Output only the spoken words, no commentary.';

/** Merge agent extra_body with Gemma4-safe transcription overrides. */
export function transcriptionExtraBody(
  agentConfig: ChatAgentOption,
): Record<string, unknown> {
  const base = { ...(agentConfig.extra_body ?? {}) };
  const chatTemplate = {
    ...((base.chat_template_kwargs as Record<string, unknown>) ?? {}),
    enable_thinking: false,
    think: false,
  };
  return {
    ...base,
    temperature: 0,
    chat_template_kwargs: chatTemplate,
    think: false,
  };
}

/**
 * Transcribe a single audio buffer via an audio-capable LLM agent config.
 * Expects WAV or convertible audio (see prepareAudioBufferForLlm).
 */
export async function transcribeAudioWithAgent(
  audio: Buffer,
  mimetype: string,
  agentConfig: ChatAgentOption,
  options?: { prompt?: string; filename?: string },
): Promise<string> {
  if (!agentConfig.baseUrl) {
    throw new Error(
      `Agent "${agentConfig.id}" has no baseUrl for audio transcription`,
    );
  }

  const prepared = await prepareAudioBufferForLlm(
    audio,
    mimetype,
    options?.filename,
  );
  if (!prepared) {
    throw new Error('Failed to prepare audio for LLM transcription');
  }

  const model =
    agentConfig.model ||
    (agentConfig.id.includes(':')
      ? agentConfig.id.split(':').slice(1).join(':')
      : agentConfig.id);

  const prompt = options?.prompt ?? MEETING_TRANSCRIBE_PROMPT;
  const extra = ollamaAudioExtraBody(
    agentConfig.baseUrl,
    transcriptionExtraBody(agentConfig),
  );

  if (
    agentConfig.apiFormat === 'ollama' ||
    isOllamaBackend(agentConfig.baseUrl)
  ) {
    const text = await ollamaNativeChat({
      baseUrl: agentConfig.baseUrl,
      model,
      messages: [
        {
          role: 'user',
          content: prompt,
          images: [prepared.buffer.toString('base64')],
        },
      ],
      think: false,
      options: {
        temperature: 0,
        num_ctx: (extra.num_ctx as number) ?? 8192,
      },
    });
    if (!text) {
      logger.warn(
        { agentId: agentConfig.id, model },
        'Ollama audio transcription returned empty content',
      );
    }
    return text;
  }

  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({
    apiKey: agentConfig.apiKey || 'sk-no-key-required',
    baseURL: agentConfig.baseUrl,
  });

  // Build params as `any` so the OpenAI SDK's strict overload types don't
  // reject the non-standard `extra_body` field (same pattern as
  // src/modules/chat/direct-llm.ts). `stream: false` selects the
  // non-streaming overload → response is a ChatCompletion.
  const params: any = {
    model,
    temperature: 0,
    max_tokens: agentConfig.max_tokens ?? 4096,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: {
              data: prepared.buffer.toString('base64'),
              format: prepared.format,
            },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
    ...extra,
    extra_body: Object.keys(extra).length > 0 ? extra : undefined,
  };

  const response = await openai.chat.completions.create(params);

  const text = response.choices[0]?.message?.content?.trim() ?? '';
  if (!text) {
    logger.warn(
      { agentId: agentConfig.id, model },
      'LLM audio transcription returned empty content',
    );
  }
  return text;
}
