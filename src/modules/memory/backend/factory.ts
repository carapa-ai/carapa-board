import { pgMemoryBackend } from './pg-backend.js';
import type { MemoryBackend } from './types.js';

export function getMemoryBackend(): MemoryBackend {
  return pgMemoryBackend;
}
