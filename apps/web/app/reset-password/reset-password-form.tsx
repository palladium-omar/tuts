"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { gateway } from "../../lib/api";
import styles from "../recovery.module.css";

const expiredMessage =
  "This reset link has expired or has already been used. Request a new link to continue.";

export default function ResetPasswordForm() {
  const token = useRef<string | null>(null);
  const captured = useRef(false);
  const successHeading = useRef<HTMLHeadingElement>(null);
  const [ready, setReady] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // Capture only once: React's development effect replay must not discard
    // the token after the URL has been cleaned. No browser storage is used.
    if (captured.current) return;
    captured.current = true;
    const url = new URL(window.location.href);
    const fragmentToken = new URLSearchParams(url.hash.slice(1)).get("token");
    const resetToken = fragmentToken || url.searchParams.get("token");
    const invalid = !fragmentToken && url.searchParams.get("error") === "INVALID_TOKEN";
    url.searchParams.delete("token");
    url.searchParams.delete("error");
    url.hash = "";
    try {
      window.history.replaceState(window.history.state, "", url.pathname + url.search);
      token.current = invalid ? null : resetToken;
      setHasToken(Boolean(token.current));
      if (invalid) setError(expiredMessage);
      else if (!token.current)
        setError("This page needs a password reset link. Open the full link from your email, or request a new one.");
    } catch {
      token.current = null;
      setError("We couldn’t open this reset link safely. Close this page and open the link again.");
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (complete) successHeading.current?.focus();
  }, [complete]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !token.current) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const newPassword = String(values.get("newPassword") ?? "");
    setError("");
    if (newPassword.length < 8 || newPassword.length > 128) {
      setError("Use a password between 8 and 128 characters.");
      return;
    }
    if (newPassword !== values.get("confirmPassword")) {
      setError("The passwords don’t match. Enter the same password in both fields.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${gateway}/api/platform/auth/reset-password`, {
        method: "POST",
        credentials: "include",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.current, newPassword }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const code = data?.code ?? data?.error?.code;
        if (code === "INVALID_TOKEN" || code === "TOKEN_EXPIRED") {
          token.current = null;
          setHasToken(false);
          form.reset();
          setError(expiredMessage);
        } else if (response.status === 429) {
          setError("Too many attempts. Wait a few minutes before trying again.");
        } else {
          setError("We couldn’t reset your password. Try again, or request a new reset link.");
        }
        return;
      }
      if (data?.status !== true) {
        setError("We couldn’t confirm the password reset. Try again, or request a new link.");
        return;
      }
      token.current = null;
      setHasToken(false);
      form.reset();
      setComplete(true);
    } catch {
      setError("We couldn’t connect. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="reset-heading">
        <div className={styles.wordmark}>tuts</div>
        {complete ? (
          <>
            <h1 id="reset-heading" ref={successHeading} tabIndex={-1}>Password updated.</h1>
            <p>Your new password is ready. Sign in to return to your workspace.</p>
            <a className={styles.primaryLink} href="/" referrerPolicy="no-referrer">Sign in</a>
          </>
        ) : (
          <>
            <h1 id="reset-heading">Reset your password.</h1>
            <p>Choose a new password for your Tuts account.</p>
            {!ready && <p role="status">Opening your reset link…</p>}
            {error && <p className={styles.error} role="alert">{error}</p>}
            {ready && hasToken && (
              <form onSubmit={submit}>
                <fieldset disabled={busy} aria-busy={busy}>
                  <legend className={styles.srOnly}>New password</legend>
                  <label htmlFor="new-password">New password</label>
                  <input id="new-password" name="newPassword" type="password" autoComplete="new-password" minLength={8} maxLength={128} aria-describedby="password-hint" required />
                  <p id="password-hint" className={styles.hint}>8–128 characters. No special-character or uppercase rules.</p>
                  <label htmlFor="confirm-password">Confirm new password</label>
                  <input id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
                  <button type="submit">{busy ? "Updating password…" : "Update password"}</button>
                </fieldset>
              </form>
            )}
            {ready && !hasToken && <p><a href="/forgot-password" referrerPolicy="no-referrer">Request a new reset link</a></p>}
            <p className={styles.back}><a href="/" referrerPolicy="no-referrer">Back to sign in</a></p>
          </>
        )}
        <noscript>Enable JavaScript to reset your password.</noscript>
      </section>
    </main>
  );
}
