#!/usr/bin/env bun
/**
 * Commit one approved platform/template proposal into its source repository.
 * Run by CarapaBoard through the promotion sandbox; the payload is a JSON file
 * Board wrote into the sandbox IPC run directory.
 *
 *   bun scripts/apply-promotion.ts hash  /workspace/ipc/runs/<run>/payload.json
 *   bun scripts/apply-promotion.ts apply /workspace/ipc/runs/<run>/payload.json
 *
 * Prints `HASH <sha256>` or `COMMIT <sha>`; refusals print `ERROR: ...` or
 * `STALE: ...` and exit non-zero, leaving the repository unchanged.
 */
import { runPromotionCli } from '../src/modules/proposals/promotion-apply.js';

const [mode = '', payloadFile = ''] = process.argv.slice(2);
process.exit(runPromotionCli(mode, payloadFile));
