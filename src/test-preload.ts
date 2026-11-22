/**
 * Bun test preload — runs once per test process before any test module is imported.
 *
 * Why it exists:
 * `src/config.ts` resolves DATA_DIR/STORE_DIR/GROUPS_DIR/KNOWLEDGE_DIR from
 * `process.env.CARAPA_DATA_DIR` at import time. Without this preload, tests
 * that call `registerGroup` (or `createUser`, which registers a `main-<user>`
 * group internally) would write `AGENTS.md`, symlinks, and `logs/` directories
 * into the developer's real data dir — polluting `ai-knowledge-base/groups/`
 * with `state-test-project/`, `main-admin-h/`, etc.
 *
 * We override CARAPA_DATA_DIR (and CARAPA_GROUPS_HOST_DIR, which is read
 * separately in config.ts) to a unique temp dir, then delete that dir after
 * all tests finish via a top-level `afterAll`. Bun loads .env before preload
 * scripts, so we must overwrite unconditionally rather than guarding on
 * existing values. (`process.on('exit')` is not reliable under `bun test`.)
 */
import { afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startJevMock, stopJevMock } from './test-utils/jev-mock-server.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-board-test-'));

process.env.CARAPA_DATA_DIR = tmpRoot;
process.env.CARAPA_GROUPS_HOST_DIR = path.join(tmpRoot, 'groups');
// Objective route tests exercise the enabled feature. Docker CI intentionally
// does not copy the developer .env, so make that test contract explicit here.
process.env.ENABLE_OBJECTIVES = 'true';
// Persona speech-expression tests likewise cover the enabled processing path
// and must not depend on a developer-specific duplicate .env setting.
process.env.ENABLE_TTS_EXPRESSIONS = 'true';
// Tests must never reach an external Jev/Laya server. Point config at an
// in-process mock before any module reads JEV_URL at import time.
// Backend tests simulate the agent runtime by writing into Board's own IPC
// directory, i.e. the single-host shared layout. CarapaBox IPC replication is
// covered by CarapaBox's sandbox_ipc_sync tests, so keep it off here.
process.env.IPC_REPLICA = 'off';
// Tests must never reach a live CarapaBox: project delete, rename and archive
// delete integration keys through its API when a token is configured. Neither
// the environment nor a secrets file may supply one.
process.env.SECRETS_DIR = path.join(tmpRoot, 'secrets');
process.env.CARAPA_BOX_API_TOKEN = '';
// Build/restart tests cover the enabled admin feature, which is off unless a
// service name is configured.
process.env.CARAPA_BOARD_DEPLOY_SERVICE = 'carapa-board';
process.env.JEV_URL = startJevMock();
process.env.JEV_API_KEY = '';
process.env.JEV_BATCH = 'true';

afterAll(async () => {
  await stopJevMock();
  // PGlite keeps a WASM worker and temporary files alive after test assertions
  // finish. Removing CARAPA_DATA_DIR first makes Bun exit with status 99/100
  // despite reporting every test as passed. Close the shared in-memory client
  // before removing the test root so the runner has a clean process teardown.
  try {
    const { drizzleDbRef } = await import('./db/drizzle-client.js');
    const handle = drizzleDbRef.current as
      | {
          $client?: { close?: () => Promise<void> };
          _?: { client?: { close?: () => Promise<void> } };
          session?: { client?: { close?: () => Promise<void> } };
        }
      | undefined;
    const client =
      handle?.$client ?? handle?._?.client ?? handle?.session?.client;
    await client?.close?.();
  } catch {
    /* Some test files never initialize PGlite. */
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
