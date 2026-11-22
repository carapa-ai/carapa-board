import fs from 'fs/promises';
import {
  TTS_API_URL,
  TTS_LANG,
  TTS_VOICE,
  SUPERTONIC_LANGUAGES,
} from './config.js';
import { getAiUserRow, listAiUserRows } from '../../db.js';
import { sha256Hex } from '../../lib/hash.js';
import { isRecord } from '../../lib/type-guards.js';
import { logger } from '../../logger.js';
import { resolveAiUserPath } from '../ai-users/storage.js';

export interface TtsVoiceInfo {
  id: string;
  kind: 'builtin' | 'custom';
}

const imported = new Set<string>();

export function personaVoiceId(aiUserId: string): string {
  return `ai-user-${aiUserId}`.slice(0, 64);
}

function validStylePayload(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return value.style_ttl != null && value.style_dp != null;
}

export function validateVoiceStyleJson(data: Buffer): Record<string, unknown> {
  if (!data.length || data.length > 1024 * 1024)
    throw new Error('Voice style JSON must be under 1 MB');
  let value: unknown;
  try {
    value = JSON.parse(data.toString('utf8'));
  } catch {
    throw new Error('Voice style must be valid JSON');
  }
  if (!validStylePayload(value))
    throw new Error('Voice style must contain style_ttl and style_dp');
  return value;
}

export async function listTtsVoices(): Promise<{
  available: boolean;
  voices: TtsVoiceInfo[];
  languages: readonly string[];
  defaults: { voiceId: string; language: string };
}> {
  try {
    const response = await fetch(`${TTS_API_URL}/v1/styles`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`TTS ${response.status}`);
    const body = (await response.json()) as {
      styles?: Array<{ name?: unknown; kind?: unknown }>;
    };
    const voices = (body.styles || []).flatMap((style): TtsVoiceInfo[] =>
      typeof style.name === 'string' &&
      (style.kind === 'builtin' || style.kind === 'custom')
        ? [{ id: style.name, kind: style.kind }]
        : [],
    );
    for (const voice of voices)
      if (voice.kind === 'custom') imported.add(voice.id);
    return {
      available: true,
      voices,
      languages: SUPERTONIC_LANGUAGES,
      defaults: { voiceId: TTS_VOICE, language: TTS_LANG },
    };
  } catch (error) {
    logger.debug({ error }, 'Unable to list TTS voices');
    return {
      available: false,
      voices: [],
      languages: SUPERTONIC_LANGUAGES,
      defaults: { voiceId: TTS_VOICE, language: TTS_LANG },
    };
  }
}

export async function importVoiceStyle(
  name: string,
  data: Buffer,
  overwrite = true,
): Promise<void> {
  validateVoiceStyleJson(data);
  const form = new FormData();
  form.append('name', name);
  form.append(
    'file',
    new Blob([data], { type: 'application/json' }),
    `${name}.json`,
  );
  const response = await fetch(
    `${TTS_API_URL}/v1/styles/import?overwrite=${overwrite ? 'true' : 'false'}`,
    {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(
      `TTS voice import ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  imported.add(name);
}

export async function ensurePersonaVoice(
  voiceId: string,
  force = false,
): Promise<boolean> {
  if (!voiceId.startsWith('ai-user-')) return false;
  if (!force && imported.has(voiceId)) return true;
  const aiUserId = voiceId.slice('ai-user-'.length);
  const row =
    (await getAiUserRow(aiUserId)) ||
    (await listAiUserRows()).find((candidate) => candidate.voiceId === voiceId);
  if (!row?.voiceStylePath) return false;
  try {
    const data = await fs.readFile(resolveAiUserPath(row.voiceStylePath));
    await importVoiceStyle(voiceId, data, true);
    return true;
  } catch (error) {
    logger.warn(
      { error, aiUserId, voiceId },
      'Failed to synchronize persona voice style',
    );
    return false;
  }
}

export async function syncPersonaVoiceStyles(): Promise<void> {
  const rows = await listAiUserRows();
  await Promise.all(
    rows
      .filter((row) => row.voiceId && row.voiceStylePath)
      .map(async (row) => {
        await ensurePersonaVoice(row.voiceId!, true);
      }),
  );
}

/** Stable cache discriminator for mutable custom voice-style files. */
export async function voiceStyleRevision(voiceId: string): Promise<string> {
  if (!voiceId.startsWith('ai-user-')) return 'builtin';
  const aiUserId = voiceId.slice('ai-user-'.length);
  const row =
    (await getAiUserRow(aiUserId)) ||
    (await listAiUserRows()).find((candidate) => candidate.voiceId === voiceId);
  if (!row?.voiceStylePath) return 'missing';
  try {
    return sha256Hex(await fs.readFile(resolveAiUserPath(row.voiceStylePath)));
  } catch {
    return 'missing';
  }
}
