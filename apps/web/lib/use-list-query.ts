import { useEffect, useMemo, useState, type SetStateAction } from "react";
import { errorMessage, onApiInvalidation, type Api } from "./api";
import { ListCache, type ListData } from "./list-cache";

const snapshots = new WeakMap<Api, Map<string, ListCache>>();
function scopedCache(api: Api, scope: string) {
  let scopes = snapshots.get(api);
  if (!scopes) {
    scopes = new Map(); snapshots.set(api, scopes);
    onApiInvalidation(api, (matches, reason) => scopes!.forEach(cache => cache.invalidate(matches, reason === "access")));
  }
  let cache = scopes.get(scope);
  if (!cache) {
    if (scopes.size >= 30) scopes.delete(scopes.keys().next().value!);
    cache = new ListCache(); scopes.set(scope, cache);
  }
  return cache;
}

/** Reset pagination in the same render as filters, before a request can start. */
export function useListOffset(key: string) {
  const [page, setPage] = useState({ key, offset: 0 });
  const offset = page.key === key ? page.offset : 0;
  const setOffset = (value: SetStateAction<number>) =>
    setPage((current) => ({
      key,
      offset:
        typeof value === "function"
          ? value(current.key === key ? current.offset : 0)
          : value,
    }));
  return [offset, setOffset] as const;
}

export function useListQuery(
  api: Api,
  path: string,
  {
    enabled = true,
    revision = 0,
    scope = "",
    delay = 0,
  }: {
    enabled?: boolean;
    revision?: number;
    scope?: string;
    delay?: number;
  } = {},
) {
  const cache = useMemo(() => scopedCache(api, scope), [api, scope]);
  const [result, setResult] = useState<{
    api: Api;
    scope: string;
    data?: ListData;
    cache: ListCache;
    path: string;
    error: string;
  }>();
  const [refreshVersion, refresh] = useState(0);
  useEffect(() => cache.subscribe(path, () => {
    setResult(previous => cache.accessRevoked ? undefined : previous ? {...previous, path: ""} : undefined);
    refresh(value => value + 1);
  }), [cache, path]);
  const cached = enabled ? cache.get(path) : undefined;
  const current = result?.cache === cache && result.path === path;
  const error = cache.accessRevoked ? "Your access changed. Refresh your workspace to continue." : current ? result.error : "";
  const previous =
    result?.api === api && result.scope === scope ? result.data : undefined;
  const data = enabled && !cache.accessRevoked ? ((cached ?? cache.snapshot(path))?.data ?? previous) : undefined;
  const loading = enabled && !cache.accessRevoked && !cached && !current;

  useEffect(() => {
    if (!enabled || cache.accessRevoked) return;
    if (!revision && cache.get(path)) return;
    const controller = new AbortController();
    const version = cache.version(path);
    const timer = setTimeout(() => {
      api(path, "GET", undefined, undefined, {
        signal: controller.signal,
        fresh: revision > 0,
      })
        .then((data) => {
          if (controller.signal.aborted || cache.version(path) !== version) return;
          cache.put(path, data);
          setResult({ api, scope, data, cache, path, error: "" });
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setResult((previous) => ({
              api,
              scope,
              data:
                !cache.accessRevoked && previous?.api === api && previous.scope === scope
                  ? previous.data
                  : undefined,
              cache,
              path,
              error: errorMessage(e),
            }));
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, path, enabled, cache, delay, revision, scope, refreshVersion]);

  return {
    data,
    error,
    loading,
    initialLoading: loading && !data,
    stale: enabled && !cached,
  };
}
