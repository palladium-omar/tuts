/** Private, short-lived cache. One instance belongs to one authenticated API context. */
export class RequestCache {
  private generation = 0;
  private entries = new Map<string, { value: unknown; expires: number }>();
  private pending = new Map<string, Promise<unknown>>();
  clear() {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
  }
  async read<T>(
    key: string,
    load: () => Promise<T>,
    now = Date.now(),
    ttl = 15000,
  ): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) return structuredClone(hit.value) as T;
    let task = this.pending.get(key);
    if (!task) {
      const generation = this.generation;
      task = load()
        .then((value) => {
          if (generation === this.generation) {
            if (this.entries.size >= 60)
              this.entries.delete(this.entries.keys().next().value!);
            this.entries.set(key, {
              value: structuredClone(value),
              expires: Date.now() + ttl,
            });
          }
          return value;
        })
        .finally(() => {
          if (this.pending.get(key) === task) this.pending.delete(key);
        });
      this.pending.set(key, task);
    }
    return structuredClone(await task) as T;
  }
}

/** Cancel a subscriber without aborting a read shared by another mounted view. */
export function waitForRead<T>(
  task: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) {
    void task.catch(() => {});
    return Promise.reject(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    task.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
