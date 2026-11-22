export type ConnectionMode = 'home' | 'remote';

function isPrivateIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (first === 10) return true;
  if (first === 192 && second === 168) return true;
  return first === 172 && second >= 16 && second <= 31;
}

/** `window.location.hostname` wraps IPv6 literals in brackets (`[::1]`). */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function isLocalHostname(
  hostname: string,
  configuredHosts: ReadonlySet<string>,
  localIp: string,
): boolean {
  const normalized = stripBrackets(hostname.toLowerCase());
  const normalizedLocalIp = stripBrackets(localIp.toLowerCase());
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    (normalizedLocalIp !== '' && normalized === normalizedLocalIp) ||
    normalized.endsWith('.local') ||
    configuredHosts.has(normalized) ||
    configuredHosts.has(`[${normalized}]`) ||
    isPrivateIpv4(normalized)
  );
}

let connectionModeHolds = 0;
const holdReleasedListeners = new Set<() => void>();

/**
 * Keep an expected long-running local operation from being mistaken for a
 * network departure. The detector still probes and rechecks as soon as the
 * final hold is released.
 */
export function holdConnectionMode(): () => void {
  connectionModeHolds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    connectionModeHolds = Math.max(0, connectionModeHolds - 1);
    if (connectionModeHolds === 0) {
      holdReleasedListeners.forEach((listener) => listener());
    }
  };
}

export function isConnectionModeHeld(): boolean {
  return connectionModeHolds > 0;
}

export function onConnectionModeHoldReleased(listener: () => void): () => void {
  holdReleasedListeners.add(listener);
  return () => holdReleasedListeners.delete(listener);
}

/**
 * Apply a detected mode change and recreate realtime transport only when the
 * resolved endpoint changes. This avoids reconnecting when repeated probes
 * report the current mode, or when home and remote share one origin.
 */
export function applyConnectionModeChange(
  currentMode: ConnectionMode,
  nextMode: ConnectionMode,
  originForMode: (mode: ConnectionMode) => string,
  setMode: (mode: ConnectionMode) => void,
  reconnectRealtime: () => void,
): boolean {
  if (currentMode === nextMode) return false;

  const originChanged = originForMode(currentMode) !== originForMode(nextMode);
  setMode(nextMode);
  if (originChanged) reconnectRealtime();
  return true;
}

export interface ProbeResult {
  at: number;
  ok: boolean;
  /** Failure reason (HTTP status or error message); absent on success. */
  message?: string;
}

// In-memory only: the latest LAN probe outcome, shown in the header popover.
let lastProbeResult: ProbeResult | null = null;
const probeResultListeners = new Set<() => void>();

export function getLastProbeResult(): ProbeResult | null {
  return lastProbeResult;
}

export function subscribeProbeResult(listener: () => void): () => void {
  probeResultListeners.add(listener);
  return () => probeResultListeners.delete(listener);
}

function recordProbeResult(result: ProbeResult) {
  lastProbeResult = result;
  probeResultListeners.forEach((listener) => listener());
}

/**
 * Serializes local reachability probes and requires repeated failures before
 * declaring the home endpoint unavailable. A probe reports a failure either by
 * resolving false or by throwing; the thrown message is recorded as the reason.
 */
export class NetworkProbeCoordinator {
  private consecutiveFailures = 0;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly probeHome: () => Promise<boolean>,
    private readonly onModeDetected: (mode: ConnectionMode) => void,
    private readonly failureThreshold = 2,
  ) {}

  check(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;

    const run = (async () => {
      let reachable = false;
      let message: string | undefined;
      try {
        reachable = await this.probeHome();
        if (!reachable) message = 'unreachable';
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      if (this.stopped) return;

      recordProbeResult({ at: Date.now(), ok: reachable, message });
      console.log(
        `[NetworkDetection] LAN probe ${reachable ? 'ok' : `failed: ${message}`}`,
      );

      if (reachable) {
        this.consecutiveFailures = 0;
        this.onModeDetected('home');
        return;
      }

      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.onModeDetected('remote');
      }
    })();

    this.inFlight = run.finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  stop() {
    this.stopped = true;
  }
}
