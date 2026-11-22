import { AsyncLocalStorage } from 'node:async_hooks';
import { logger, serializeError } from '../../logger.js';
import { getGroupByFolder } from '../../state-manager.js';
import { getOpenTaskCards } from '../kanban/db-kanban.js';
import { getGroupStages } from '../kanban/stages.js';
import { getMemoryBackend } from './backend/factory.js';
import { recentObserverMemories } from './db-memories.js';
import { matchOpenCardReference } from './open-card-match.js';

type OpenCards = ReturnType<typeof getOpenTaskCards>;

const reflectionCards = new AsyncLocalStorage<Map<string, OpenCards>>();

/** Share one open-card load per project across a reflection run. */
export function withOpenCardCache<T>(run: () => Promise<T>): Promise<T> {
  return reflectionCards.run(new Map(), run);
}

export function loadOpenProjectCards(projectId: string): OpenCards {
  const cache = reflectionCards.getStore();
  const cached = cache?.get(projectId);
  if (cached) return cached;
  const doneStatuses = getGroupStages(getGroupByFolder(projectId))
    .filter((stage) => stage.type === 'done')
    .map((stage) => stage.id);
  const loaded = getOpenTaskCards(projectId, doneStatuses);
  cache?.set(projectId, loaded);
  loaded.catch(() => cache?.delete(projectId));
  return loaded;
}

/** Best-effort catch-up for cards created after their observer memory. */
export async function sweepObserverCardMemories(
  projectId: string,
): Promise<void> {
  let checked = 0;
  let invalidated = 0;
  try {
    const cards = await loadOpenProjectCards(projectId);
    if (cards.length) {
      const candidates = await recentObserverMemories(
        projectId,
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      );
      const backend = getMemoryBackend();
      for (const memory of candidates) {
        checked++;
        const match = matchOpenCardReference(memory.content, cards);
        if (!match) continue;
        try {
          await backend.invalidate(
            memory.id,
            { group_folder: projectId },
            undefined,
            memory.updated_at,
          );
          invalidated++;
          logger.info(
            {
              projectId,
              memoryId: memory.id,
              cardId: match.cardId,
              token: match.token,
            },
            'Invalidated observer memory: restates open card',
          );
        } catch (error) {
          logger.warn(
            {
              projectId,
              memoryId: memory.id,
              cardId: match.cardId,
              err: serializeError(error),
            },
            'Failed to invalidate observer memory restating open card',
          );
        }
      }
    }
    logger.info(
      { projectId, checked, invalidated },
      'Observer open-card memory sweep',
    );
  } catch (error) {
    logger.warn(
      { projectId, checked, invalidated, err: serializeError(error) },
      'Observer open-card memory sweep failed',
    );
  }
}
