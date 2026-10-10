import { useEffect, useMemo, useState, type SetStateAction } from "react";
import { errorMessage, type Api } from "./api";
import { ListCache, type ListData } from "./list-cache";

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
  const cache = useMemo(() => new ListCache(), [api, enabled, revision, scope]);
  const [result, setResult] = useState<{
    api: Api;
    scope: string;
    data?: ListData;
    cache: ListCache;
    path: string;
    error: string;
  }>();
  const [, refresh] = useState(0);
  const cached = enabled ? cache.get(path) : undefined;
  const current = result?.cache === cache && result.path === path;
  const error = current ? result.error : "";
  const previous =
    result?.api === api && result.scope === scope ? result.data : undefined;
  const data = enabled ? ((cached ?? cache.last)?.data ?? previous) : undefined;
  const loading = enabled && !cached && !current;

  useEffect(() => {
    if (!enabled) return;
    if (cache.get(path)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api(path, "GET", undefined, undefined, {
        signal: controller.signal,
        fresh: revision > 0,
      })
        .then((data) => {
          if (controller.signal.aborted) return;
          cache.put(path, data);
          setResult({ api, scope, data, cache, path, error: "" });
          refresh((value) => value + 1);
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setResult((previous) => ({
              api,
              scope,
              data:
                previous?.api === api && previous.scope === scope
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
  }, [api, path, enabled, cache, delay, revision, scope]);

  return {
    data,
    error,
    loading,
    initialLoading: loading && !data,
    stale: enabled && !cached,
  };
}
