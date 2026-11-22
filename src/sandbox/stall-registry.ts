// In-memory registry of stall-watchdog controls, keyed by runId.
//
// Populated by waitForRun() when a run starts; removed when the run ends.
// Consumed by the POST /api/active-runs/:runId/extend route so an external
// caller (currently chat-mode UI) can push the kill deadline out when the
// agent is silent but expected to keep working.

export interface StallControl {
  reset: () => void;
  pause: () => void;
  resume: () => void;
  /** Fail the wait immediately, e.g. because the sandbox was stopped. */
  interrupt: (reason: string) => void;
}

const controls = new Map<string, StallControl>();

export function registerStallControl(
  runId: string,
  control: StallControl,
): void {
  controls.set(runId, control);
}

export function unregisterStallControl(runId: string): void {
  controls.delete(runId);
}

export function tryExtendRun(runId: string): boolean {
  const control = controls.get(runId);
  if (!control) return false;
  control.reset();
  return true;
}

export function resumeRunStallWatchdog(runId: string): boolean {
  const control = controls.get(runId);
  if (!control) return false;
  control.resume();
  return true;
}

export function interruptRun(runId: string, reason: string): boolean {
  const control = controls.get(runId);
  if (!control) return false;
  control.interrupt(reason);
  return true;
}

export function isExtendable(runId: string): boolean {
  return controls.has(runId);
}
