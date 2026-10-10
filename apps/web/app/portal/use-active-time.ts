import { useEffect, useState } from "react";
import type { Api } from "../../lib/api";

/** Estimate time from visibility and recent interaction without recording content. */
export function useActiveTime(api: Api, studentId: string | undefined, enabled: boolean) {
  const [error, setError] = useState("");
  useEffect(() => {
    setError(""); if (!enabled || !studentId) return;
    let cancelled = false, posting = false, baselineSent = false, sequence = 0, accumulated = 0, interactedAt = 0, sampledAt = performance.now();
    const sessionId = crypto.randomUUID();
    const interact = () => { interactedAt = Date.now(); if (!baselineSent) void heartbeat(true); };
    const visibility = () => { accumulated = 0; sampledAt = performance.now(); };
    const eligible = () => document.visibilityState === "visible" && Date.now() - interactedAt <= 60_000;
    async function heartbeat(initial = false) {
      if (cancelled || posting || !eligible()) return;
      const activeSeconds = initial ? 0 : Math.min(30, Math.floor(accumulated));
      if (!initial && activeSeconds <= 0) return;
      accumulated = 0; posting = true; baselineSent = true; sequence++;
      try { await api("reporting/v1/activity", "POST", { studentId, sessionId, sequence, activeSeconds }); if (!cancelled) setError(""); }
      catch { if (!cancelled) setError("Activity recording is temporarily unavailable."); }
      finally { posting = false; }
    }
    const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    for (const event of events) window.addEventListener(event, interact, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    const sample = setInterval(() => { const now = performance.now(), elapsed = Math.min(2, Math.max(0, (now - sampledAt) / 1000)); sampledAt = now; if (eligible()) accumulated = Math.min(30, accumulated + elapsed); else accumulated = 0; }, 1000);
    const send = setInterval(() => { void heartbeat(); }, 30_000);
    void heartbeat(true);
    return () => { cancelled = true; clearInterval(sample); clearInterval(send); for (const event of events) window.removeEventListener(event, interact); document.removeEventListener("visibilitychange", visibility); };
  }, [api, studentId, enabled]);
  return error;
}
