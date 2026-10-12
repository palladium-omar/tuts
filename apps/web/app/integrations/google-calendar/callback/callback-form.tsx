"use client";

import styles from "../../../recovery.module.css";

import { useEffect, useRef, useState } from "react";
import { createApi, errorMessage, isAuthenticationRequired } from "../../../../lib/api";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const seenStates = new Set<string>();

type CallbackResult =
  | { kind: "working" }
  | { kind: "error"; message: string; businessId?: string; signIn?: boolean };

function integrationsUrl(businessId: string) {
  const query = new URLSearchParams({
    business: businessId,
    view: "integrations",
    filter: "calendars",
  });
  return `/?${query.toString()}`;
}

export default function GoogleCalendarCallbackPage() {
  const started = useRef(false);
  const [result, setResult] = useState<CallbackResult>({ kind: "working" });

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const url = new URL(window.location.href);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const googleError = url.searchParams.get("error") ?? "";
    for (const key of ["code", "state", "error", "error_description", "error_uri"]) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, "", url);

    const [businessId, nonce, extra] = state.split(".");
    if (!uuid.test(businessId ?? "") || !nonce || extra !== undefined || !/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) {
      setResult({ kind: "error", message: "This Google Calendar link is invalid or expired. Return to Tuts and start a new connection." });
      return;
    }
    if (googleError) {
      setResult({
        kind: "error",
        businessId,
        message: googleError === "access_denied"
          ? "Google authorization was cancelled. You can start again when you’re ready."
          : "Google could not authorize this connection. Return to Tuts and try again.",
      });
      return;
    }
    if (!code) {
      setResult({ kind: "error", businessId, message: "Google did not return an authorization code. Start a new connection from Tuts." });
      return;
    }
    if (seenStates.has(state)) return;
    seenStates.add(state);

    void (async () => {
      try {
        const data = await createApi(businessId)(
          "integrations/v1/google-calendar/oauth/complete",
          "POST",
          { state, code },
        );
        const item = data.item ?? data;
        if (!item?.id || (item.businessId && item.businessId !== businessId)) {
          throw new Error("Tuts returned a connection for a different workspace. Start a new connection.");
        }
        const target = new URL(integrationsUrl(businessId), window.location.origin);
        target.searchParams.set("googleCalendarConnection", String(item.id));
        window.location.replace(target.href);
      } catch (cause) {
        setResult({
          kind: "error",
          businessId,
          signIn: isAuthenticationRequired(cause),
          message: isAuthenticationRequired(cause)
            ? "Sign in to Tuts with an account that can manage this workspace, then start a new Google Calendar connection. The authorization code was not retried."
            : errorMessage(cause),
        });
      }
    })();
  }, []);

  const home = result.kind === "error" && result.businessId
    ? integrationsUrl(result.businessId)
    : "/";
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-live="polite">
        <div className={styles.wordmark}>tuts</div>
        <h1>Google Calendar</h1>
        {result.kind === "working" ? (
          <p role="status">Finishing your secure connection…</p>
        ) : (
          <>
            <p>{result.message}</p>
            <a className={styles.primaryLink} href={home}>
              {result.signIn ? "Sign in to Tuts" : "Return to Tuts"}
            </a>
          </>
        )}
      </section>
    </main>
  );
}
