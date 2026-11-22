export class QueryInvalidationCoalescer {
  private readonly pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; trailing: boolean; run: () => void }
  >();

  constructor(private readonly windowMs: number) {}

  invalidate(key: string, run: () => void): void {
    const active = this.pending.get(key);
    if (active) {
      active.trailing = true;
      active.run = run;
      clearTimeout(active.timer);
      active.timer = setTimeout(() => this.flushWindow(key), this.windowMs);
      return;
    }

    run();
    this.pending.set(key, {
      trailing: false,
      run,
      timer: setTimeout(() => this.flushWindow(key), this.windowMs),
    });
  }

  clear(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }

  private flushWindow(key: string): void {
    const active = this.pending.get(key);
    if (!active) return;
    this.pending.delete(key);
    if (active.trailing) active.run();
  }
}
