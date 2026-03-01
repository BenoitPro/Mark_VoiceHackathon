type SessionCacheEntry<T> = {
  value: T;
  fetchedAtMs: number;
};

export class TimedSessionCache<T> {
  private readonly entries = new Map<string, SessionCacheEntry<T>>();

  constructor(private readonly ttlMs: number) {}

  async get(sessionId: string, loader: () => Promise<T>, nowMs = Date.now()): Promise<T> {
    const cached = this.entries.get(sessionId);
    if (cached && nowMs - cached.fetchedAtMs < this.ttlMs) {
      return cached.value;
    }

    const loaded = await loader();
    this.entries.set(sessionId, {
      value: loaded,
      fetchedAtMs: nowMs
    });
    return loaded;
  }

  clear(sessionId: string): void {
    this.entries.delete(sessionId);
  }
}
