/** Share one in-flight result among concurrent callers without caching it. */
export class InFlightCoalescer {
  private readonly requests = new Map<string, Promise<unknown>>();

  run<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.requests.get(key);
    if (existing) return existing as Promise<T>;

    const request = load();
    this.requests.set(key, request);
    const clearRequest = () => {
      if (this.requests.get(key) === request) this.requests.delete(key);
    };
    void request.then(clearRequest, clearRequest);
    return request;
  }
}
