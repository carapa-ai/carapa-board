import { timingSafeEqual } from 'node:crypto';

export interface BrowserProcess {
  endpoint: string;
  closed: Promise<unknown>;
  stop(): Promise<void>;
}

export interface SessionInput {
  id: string;
  token: string;
  group: string;
  runId: string;
  expiresAt: number;
}

interface BrowserSessionClock {
  now(): number;
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const systemClock: BrowserSessionClock = {
  now: Date.now,
  setTimeout,
  clearTimeout,
};

export function equalSecret(actual: unknown, expected: string): boolean {
  return (
    typeof actual === 'string' &&
    expected.length >= 32 &&
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}

export class SessionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Session extends SessionInput {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  browser?: BrowserProcess;
  connections: Set<() => void>;
  starting?: Promise<BrowserProcess>;
}

/** Browser-tab leases (native runners) are renewable and counted separately. */
const TAB_SESSION_ID = /^browser-tab-[a-f0-9]{40}$/;
const SESSION_ID = /^(web-view-[a-f0-9-]{36}|browser-tab-[a-f0-9]{40})$/;

export interface TabSessionLimits {
  /** Maximum concurrent tab sessions, independent of the web_view capacity. */
  capacity: number;
  /** Furthest `expiresAt` a tab session may have, at creation and on renewal. */
  maxLifetimeMs: number;
}

/** The sidecar owns deadlines even when Board dies or loses its connection. */
export class BrowserSessions {
  private readonly sessions = new Map<string, Session>();
  constructor(
    private readonly launch: (
      id: string,
      signal: AbortSignal,
    ) => Promise<BrowserProcess>,
    private readonly capacity = 4,
    private readonly maxLifetimeMs = 300_000,
    private readonly clock: BrowserSessionClock = systemClock,
    private readonly tabs: TabSessionLimits = {
      capacity: 2,
      maxLifetimeMs: 1_200_000,
    },
  ) {}

  private isTab(id: string): boolean {
    return TAB_SESSION_ID.test(id);
  }
  private count(tab: boolean): number {
    let count = 0;
    for (const id of this.sessions.keys()) if (this.isTab(id) === tab) count++;
    return count;
  }
  private validExpiry(id: string, expiresAt: unknown): expiresAt is number {
    const limit = this.isTab(id) ? this.tabs.maxLifetimeMs : this.maxLifetimeMs;
    return (
      Number.isSafeInteger(expiresAt) &&
      (expiresAt as number) > this.clock.now() &&
      (expiresAt as number) <= this.clock.now() + limit
    );
  }

  async create(input: SessionInput): Promise<void> {
    const tab = this.isTab(input.id);
    if (
      !SESSION_ID.test(input.id) ||
      !/^[a-f0-9]{64}$/.test(input.token) ||
      typeof input.group !== 'string' ||
      !input.group ||
      input.group.length > 200 ||
      typeof input.runId !== 'string' ||
      !input.runId ||
      input.runId.length > 200 ||
      !this.validExpiry(input.id, input.expiresAt)
    ) {
      throw new SessionError(400, 'Invalid browser session');
    }
    if (this.sessions.has(input.id))
      throw new SessionError(409, 'Browser session already exists');
    // Separate pools: tab sessions never consume web_view capacity, or vice versa.
    if (this.count(tab) >= (tab ? this.tabs.capacity : this.capacity))
      throw new SessionError(429, 'Browser sidecar capacity exhausted');
    const session: Session = {
      ...input,
      controller: new AbortController(),
      connections: new Set(),
      timer: this.clock.setTimeout(() => {
        void this.delete(input.id);
      }, input.expiresAt - this.clock.now()),
    };
    session.timer.unref();
    this.sessions.set(input.id, session);
    try {
      session.starting = this.launch(input.id, session.controller.signal);
      session.browser = await session.starting;
      if (session.controller.signal.aborted) {
        await session.browser.stop();
        throw new SessionError(410, 'Browser session expired during startup');
      }
      void session.browser.closed.finally(() => this.delete(input.id));
    } catch (error) {
      await this.delete(input.id);
      throw error;
    }
  }

  /** Extends a live tab session; web_view sessions have a fixed deadline. */
  renew(id: string, expiresAt: unknown): void {
    const session = this.sessions.get(id);
    if (!this.isTab(id) || !this.validExpiry(id, expiresAt))
      throw new SessionError(400, 'Invalid browser session');
    if (!session || !session.browser)
      throw new SessionError(404, 'Browser session unavailable');
    this.clock.clearTimeout(session.timer);
    session.expiresAt = expiresAt;
    session.timer = this.clock.setTimeout(() => {
      void this.delete(id);
    }, expiresAt - this.clock.now());
    session.timer.unref();
  }

  authorize(id: string, token: unknown): Session | undefined {
    const session = this.sessions.get(id);
    return session &&
      session.expiresAt > this.clock.now() &&
      session.browser &&
      equalSecret(token, session.token)
      ? session
      : undefined;
  }

  async delete(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.clock.clearTimeout(session.timer);
    session.controller.abort();
    for (const close of session.connections) close();
    const browser =
      session.browser || (await session.starting?.catch(() => undefined));
    await browser?.stop();
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.delete(id)));
  }
}
