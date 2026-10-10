import type { Row } from "./api";

export type ListData = { items: Row[]; total?: number; offset?: number };
type Entry = { path: string; data: ListData; time: number };
const MAX_AGE = 30_000;
const MAX_ENTRIES = 30;
// One instance per mounted list/API identity. Never persisted or shared between
// accounts, spaces or permission contexts. Mutations replace the instance.
export class ListCache {
  private entries = new Map<string, Entry>();
  last?: Entry;

  get(path: string, now = Date.now()): Entry | undefined {
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
