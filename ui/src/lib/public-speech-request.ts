export interface PublicSpeechRequest {
  id: number;
  signal: AbortSignal;
}

/** Keeps public conversation speech preparation/downloads strictly latest-wins. */
export class PublicSpeechRequestGate {
  private sequence = 0;
  private active: { id: number; controller: AbortController } | null = null;

  begin(): PublicSpeechRequest {
    this.cancel();
    const controller = new AbortController();
    const active = { id: this.sequence, controller };
    this.active = active;
    return { id: active.id, signal: controller.signal };
  }

  cancel(): void {
    this.sequence += 1;
    this.active?.controller.abort();
    this.active = null;
  }

  isCurrent(request: PublicSpeechRequest): boolean {
    return !request.signal.aborted && this.active?.id === request.id;
  }

  release(request: PublicSpeechRequest): void {
    if (this.active?.id === request.id) this.active = null;
  }
}
