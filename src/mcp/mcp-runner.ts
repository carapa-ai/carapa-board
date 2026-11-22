/**
 * MCP-based Agent Runner for CarapaBoard — barrel re-export.
 *
 * The implementation is split into three focused modules:
 * - stream/parsers.ts   — ChunkData stream type and display re-exports
 * - concurrency/semaphore.ts — Per-group slot semaphore for sandbox concurrency
 * - sandbox/process.ts  — MCP client lifecycle, launch, wait, kill, cleanup, snapshots
 *
 * This file re-exports the public API so existing consumers (`import { ... } from './mcp-runner.js'`)
 * continue to work without changes.
 */

// Stream parsers
export { type ChunkData } from '../stream/parsers.js';

// Sandbox process lifecycle, types, and helpers
export {
  type ContainerInput,
  type SandboxExecutionTarget,
  type AvailableGroup,
  persistentVariantTag,
  isCurrentProcessRun,
  markCurrentProcessRun,
  unmarkCurrentProcessRun,
  cleanupProcesses,
  resolveHostRunDir,
  reconcileSandboxPool,
  waitForRun,
  runContainerAgent,
  killAgentProcess,
  steerAgentProcess,
  readAgentRunControlResponse,
  clearAgentRunControlResponse,
  interruptAgentTurn,
  steerChatAgentProcess,
  answerChatAgentUserInput,
  stopChatBackgroundTask,
  killChatAgentProcess,
  abortChatAgentWatcher,
  gracefullyInterruptRun,
  killRun,
  chatRunAbortControllers,
  STAGE_HANDOFF_TIMEOUT_ABORT_REASON,
  chatAbortKey,
  tryClaimChatRunAbortController,
} from '../sandbox/process.js';
