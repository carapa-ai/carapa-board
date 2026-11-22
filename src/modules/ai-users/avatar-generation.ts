type AvatarGenerationStatus = 'idle' | 'running' | 'completed' | 'error';

export interface AvatarGenerationState {
  status: AvatarGenerationStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

const idleState: AvatarGenerationState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  error: null,
};

const jobs = new Map<string, AvatarGenerationState>();

export function getAvatarGenerationState(
  aiUserId: string,
): AvatarGenerationState {
  return jobs.get(aiUserId) ?? idleState;
}

export function startAvatarGeneration(
  aiUserId: string,
  work: () => Promise<void>,
): AvatarGenerationState {
  const current = jobs.get(aiUserId);
  if (current?.status === 'running') return current;

  const running: AvatarGenerationState = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  jobs.set(aiUserId, running);

  void Promise.resolve()
    .then(work)
    .then(() => {
      jobs.set(aiUserId, {
        ...running,
        status: 'completed',
        finishedAt: new Date().toISOString(),
      });
    })
    .catch((error: unknown) => {
      jobs.set(aiUserId, {
        ...running,
        status: 'error',
        finishedAt: new Date().toISOString(),
        error:
          error instanceof Error ? error.message : 'Avatar generation failed',
      });
    });

  return running;
}

/** Test-only reset; production jobs are retained so page revisits can inspect them. */
export function clearAvatarGenerationStates(): void {
  jobs.clear();
}
