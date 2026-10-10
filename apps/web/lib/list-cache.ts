import type { Row } from "./api";

export type ListData = { items: Row[]; total?: number; offset?: number };
type Entry = { path: string; data: ListData; time: number };
const MAX_AGE = 30_000;
const MAX_ENTRIES = 30;
// Retained only within one authenticated API/scope identity. Never persisted or
// shared between accounts, spaces or permission contexts. Mutations invalidate resources.
export class ListCache {
  accessRevoked = false;
  private versions = new Map<string, object>();
  private listeners = new Map<string, Set<() => void>>();
  version(path: string) { return this.versions.get(path); }
  subscribe(path: string, listener: () => void) {
    const listeners = this.listeners.get(path) ?? new Set();
    listeners.add(listener); this.listeners.set(path, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) { this.listeners.delete(path); this.versions.delete(path); } };
  }
  private entries = new Map<string, Entry>();
  last?: Entry;

  invalidate(matches: (path: string) => boolean, accessRevoked = false) {
    if (accessRevoked) this.accessRevoked = true;
    for (const path of new Set([...this.entries.keys(), ...this.listeners.keys()])) {
      if (!matches(path)) continue;
      this.entries.delete(path);
      if (this.listeners.has(path)) this.versions.set(path, {});
      this.listeners.get(path)?.forEach(listener => listener());
    }
    if (this.last && matches(this.last.path)) this.last = undefined;
  }
  snapshot(path: string, now = Date.now()): Entry | undefined {
    if (this.accessRevoked) return undefined;
    const entry = this.entries.get(path);
    return entry && now - entry.time < 120_000 ? entry : undefined;
  }
  get(path: string, now = Date.now()): Entry | undefined {
    if (this.accessRevoked) return undefined;
    const exact = this.entries.get(path);
    if (exact && now - exact.time < MAX_AGE) return exact;
    // Related identities participate in server search. Only exact filters are cached.
  }

  put(path: string, data: ListData, time = Date.now()) {
    const entry = {
      path,
      data: {
        ...data,
        offset: Number(
          new URLSearchParams(path.split("?")[1]).get("offset") ?? 0,
        ),
      },
      time,
    };
    this.entries.delete(path);
    this.entries.set(path, entry);
    if (this.entries.size > MAX_ENTRIES)
      this.entries.delete(this.entries.keys().next().value!);
    this.last = entry;
  }
}
