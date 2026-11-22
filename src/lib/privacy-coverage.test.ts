/**
 * Egress coverage guard for `settings.privacyMode`.
 *
 * Every non-test source file under `src/` that calls global `fetch(` or
 * `llmComplete(` must be listed in EGRESS_ALLOWLIST. The value is either:
 *  - a PrivacyPurpose name: the file reaches a privacy gate
 *    (`assertEgressAllowed` / `assertRuntimeAllowed`) for that purpose, or
 *  - `'exempt: <reason>'`: the file does not need a gate (local service, no
 *    project content leaves the board's own network, ...).
 *  - `'exempt: UNGATED <reason>'`: known gap — project content can reach a
 *    configurable endpoint without a gate. Listed so it stays visible.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PrivacyPurpose } from './privacy-policy.js';

const PURPOSES: Record<PrivacyPurpose, true> = {
  agent: true,
  chat: true,
  memory: true,
  jev: true,
  embedding: true,
  knowledge_verify: true,
  stt: true,
  image: true,
  web: true,
  helper: true,
  unknown: true,
};

const EGRESS_ALLOWLIST: Record<string, string> = {
  // --- Reaches a privacy gate -------------------------------------------
  // The gate lives inside llmComplete (assertEgressAllowed with the caller's
  // privacyPurpose, defaulting to 'unknown').
  'src/lib/llm-client.ts': 'unknown',
  'src/modules/kanban/description-draft.ts': 'helper',
  'src/modules/chat/public-content-safety.ts': 'helper',
  'src/modules/fs/tools.ts': 'helper',
  'src/modules/memory/history-reflection.ts': 'memory',
  // These call llmComplete without an explicit privacyPurpose, so the gate
  // sees 'unknown' (still enforced under local_memory and strict).
  'src/modules/memory/memory-capsule-plan.ts': 'unknown',
  'src/modules/memory/memory-capsule.ts': 'unknown',
  'src/modules/memory/tool-reflector.ts': 'unknown',
  // TTS text normalizer: llmComplete with no projectId/purpose ('unknown').
  'src/modules/tts/normalizer.ts': 'unknown',
  'src/modules/vector-store/store.ts': 'embedding',
  'src/modules/objectives/brain-client.ts': 'agent',
  // The image-generation tool is gated by tool-execution.ts on
  // tool.privacyPurpose. The avatar/emote routes (ai-users.ts, preferences.ts
  // via avatar-image.ts) call it directly without a gate; those prompts are
  // account-level, not project content.
  'src/modules/image-generation/client.ts': 'image',
  'src/modules/web/proxy.ts': 'web',

  // --- Exempt: local / board-internal services --------------------------
  'src/http-service.ts': 'exempt: proxies carapa-wa-link media (local service)',
  'src/routes/public-conversations.ts':
    'exempt: proxies carapa-wa-link media (local service)',
  'src/lib/media-processor.ts':
    'exempt: downloads inbound media from carapa-wa-link (local service)',
  'src/modules/whatsapp/messaging-client.ts':
    'exempt: carapa-wa-link local service client',
  'src/lib/mcp-client.ts': 'exempt: CarapaBox/MCP local service client',
  'src/sandbox/relay-token-sync.ts':
    'exempt: CarapaBox admin API, token sync only (no project content)',
  'src/lib/model-discovery.ts':
    'exempt: CarapaBox admin API model listing (local service, no project content)',
  'src/lib/provider-login-state.ts':
    'exempt: CarapaBox admin API provider-account listing (local service, no project content)',
  'src/service-watcher.ts': 'exempt: local service health checks',
  'src/modules/build-info/tools.ts': 'exempt: local service version lookup',
  'src/modules/gitnexus/tools.ts': 'exempt: local gitnexus-hub service',
  'src/modules/tts/synthesizer.ts': 'exempt: local TTS service',
  'src/modules/tts/voice-styles.ts': 'exempt: local TTS service',
  'src/modules/push/fcm-sender.ts':
    'exempt: FCM push carries only an opaque reference, no content',
  'src/lib/carapa-device-client.ts':
    'exempt: device client calling the user’s own board',
  'src/modules/web/sidecar/server.ts':
    'exempt: Bun.serve request handler, not an outbound call',
  'src/routes/conversations-direct-stop.integration.ts':
    'exempt: integration test harness against a local board',

  // --- Known gaps (visible on purpose) ----------------------------------
  'src/modules/whisper/transcriber.ts':
    'exempt: UNGATED uploads audio to WHISPER_API_URL (may be OpenAI/Groq); stt purpose is never asserted',
  'src/modules/live-voice/streaming.ts':
    'exempt: UNGATED Live Mode STT uploads utterance audio to a configured GPU endpoint',
  'src/lib/audio-for-llm.ts':
    'exempt: UNGATED ollamaNativeChat client; direct-llm gates its call but transcribe-audio-llm.ts does not',
};

const EGRESS_PATTERN = /(?<![.\w$])fetch\(|\bllmComplete\(/;

/** True when `source` contains a global `fetch(` or an `llmComplete(` call. */
export function hasEgressCall(source: string): boolean {
  return EGRESS_PATTERN.test(source);
}

/** Repo-relative paths in `files` that match and are not in `allowlist`. */
export function findUnlisted(
  files: Record<string, string>,
  allowlist: Record<string, string>,
): string[] {
  return Object.keys(files)
    .filter((file) => hasEgressCall(files[file]) && !(file in allowlist))
    .sort();
}

const REPO_ROOT = path.resolve(import.meta.dir, '../..');

function readSourceFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const rel of new Bun.Glob('src/**/*.ts').scanSync({ cwd: REPO_ROOT })) {
    if (/\.(test|spec)\.ts$/.test(rel) || rel.split('/').includes('__tests__'))
      continue;
    files[rel] = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  }
  return files;
}

describe('privacy egress coverage', () => {
  const sources = readSourceFiles();

  test('every fetch(/llmComplete( caller is listed with a purpose or an exempt reason', () => {
    const unlisted = findUnlisted(sources, EGRESS_ALLOWLIST);
    expect(
      unlisted,
      `Unlisted outbound caller(s): ${unlisted.join(', ')}. Add each file to ` +
        'EGRESS_ALLOWLIST in src/lib/privacy-coverage.test.ts with the ' +
        'PrivacyPurpose of the gate it reaches (see src/lib/privacy-policy.ts) ' +
        "or an 'exempt: <reason>' entry.",
    ).toEqual([]);
  });

  test('allowlist entries are not stale', () => {
    const stale = Object.keys(EGRESS_ALLOWLIST)
      .filter((file) => !(file in sources) || !hasEgressCall(sources[file]))
      .sort();
    expect(
      stale,
      `Stale EGRESS_ALLOWLIST entries (file missing or no longer calls fetch(/llmComplete(): ${stale.join(', ')}. Remove them.`,
    ).toEqual([]);
  });

  test('allowlist values are a PrivacyPurpose or an exempt reason', () => {
    const invalid = Object.entries(EGRESS_ALLOWLIST)
      .filter(
        ([, value]) =>
          !(value in PURPOSES) &&
          !(value.startsWith('exempt: ') && value.length > 'exempt: '.length),
      )
      .map(([file]) => file);
    expect(invalid).toEqual([]);
  });

  test('scanner detects global fetch and llmComplete but not method fetch', () => {
    expect(hasEgressCall("await fetch('x')")).toBe(true);
    expect(hasEgressCall('const r = await llmComplete(cfg, p, u)')).toBe(true);
    expect(hasEgressCall('app.fetch(req)')).toBe(false);
    expect(hasEgressCall('const x = 1;')).toBe(false);

    expect(
      findUnlisted(
        { 'src/new/caller.ts': "await fetch('x')", 'src/ok.ts': 'const x = 1' },
        {},
      ),
    ).toEqual(['src/new/caller.ts']);
    expect(
      findUnlisted(
        { 'src/new/caller.ts': "await fetch('x')" },
        { 'src/new/caller.ts': 'web' },
      ),
    ).toEqual([]);
  });
});
