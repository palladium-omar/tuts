"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { gateway, supportReference } from "../../lib/api";
import styles from "../recovery.module.css";

export default function ForgotPasswordForm() {
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const successHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (complete) successHeading.current?.focus();
  }, [complete]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const email = String(new FormData(form).get("email") ?? "").trim();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${gateway}/api/platform/auth/request-password-reset`, {
        method: "POST",
        credentials: "include",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, redirectTo: `${window.location.origin}/reset-password` }),
      });
      if (!response.ok) {
        setError((response.status === 429
          ? "Too many requests. Wait a few minutes before trying again."
          : "Password reset email is currently unavailable. Please contact support.") + supportReference(response));
        return;
      }
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
      <section className={styles.card} aria-labelledby="forgot-heading">
        <div className={styles.wordmark}>tuts</div>
        {complete ? (
          <>
            <h1 id="forgot-heading" ref={successHeading} tabIndex={-1}>Check your email.</h1>
            <p role="status">If an account exists for that email address, you’ll receive a password reset link. Check your spam folder too.</p>
            <p>For your security, the link expires after 30 minutes and can be used once.</p>
          </>
        ) : (
          <>
            <h1 id="forgot-heading">Forgot your password?</h1>
            <p>Enter the email address you use to sign in. We’ll send a link to choose a new password.</p>
            {error && <p className={styles.error} role="alert">{error}</p>}
            <form onSubmit={submit}>
              <fieldset disabled={busy} aria-busy={busy}>
                <legend className={styles.srOnly}>Password reset email</legend>
                <label htmlFor="reset-email">Email address</label>
                <input id="reset-email" name="email" type="email" autoComplete="email" maxLength={254} required />
                <button type="submit">{busy ? "Requesting link…" : "Send reset link"}</button>
              </fieldset>
            </form>
          </>
        )}
        <p className={styles.back}><a href="/" referrerPolicy="no-referrer">Back to sign in</a></p>
        <noscript>Enable JavaScript to request a password reset link.</noscript>
      </section>
    </main>
  );
}
