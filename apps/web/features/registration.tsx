"use client";
import { useState, type FormEvent } from "react";
import { ArrowRight, GraduationCap } from "lucide-react";
import { errorMessage, type Api } from "../lib/api";
import { Notice } from "../components/shared";

export function Registration({
  api,
  onSignedIn,
  audience = "tutor",
}: {
  api: Api;
  onSignedIn: () => Promise<void>;
  audience?: "tutor" | "student";
}) {
  const [register, setRegister] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [showPassword, setShowPassword] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password"));
    setError("");
    if (register && password !== f.get("confirmPassword")) {
      setError(
        "The passwords don’t match. Please enter the same password in both fields.",
      );
      return;
    }
    setBusy(true);
    try {
      await api(
        `platform/auth/${register ? "sign-up" : "sign-in"}/email`,
        "POST",
        {
          email: f.get("email"),
          password,
          ...(register ? { name: f.get("name") } : {}),
        },
      );
      await onSignedIn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth">
      <div className="auth-story">
        <div className="wordmark">
          <GraduationCap />
          tuts
        </div>
        <div>
          <span className="eyebrow light">{audience === "student" ? "YOUR LEARNING SPACE" : "ROOM TO TEACH"}</span>
          <h1>
            {audience === "student" ? "Your next step." : "Your practice."}
            <br />
            All together.
          </h1>
          <p>
            {audience === "student" ? "Your tasks, your resources," : "Your students, your tools,"}
            <br />
            {audience === "student" ? "your own way forward." : "your own way of teaching."}
          </p>
        </div>
        <div className="auth-foot">
          <span className="little-star">✳</span>{audience === "student" ? "A little room to grow." : "Built around independent educators."}
        </div>
      </div>
      <div className="auth-panel">
        <div className="auth-card">
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h2>{register ? (audience === "student" ? "Create your student account." : "Make room for good teaching.") : "Welcome back."}</h2>
          <p className="muted">
            {register
              ? (audience === "student" ? "Use the email address your tutor invited." : "Create your account, then make this space your own.")
              : "Sign in to pick up where you left off."}
          </p>
          <Notice error={error} />
          <form onSubmit={submit}>
            {register && (
              <label>
                Your name
                <input name="name" autoComplete="name" required />
              </label>
            )}
            <label>
              Email address
              <input name="email" type="email" autoComplete="email" required />
            </label>
            <label>
              Password
              <input
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete={register ? "new-password" : "current-password"}
                minLength={register ? 8 : undefined}
                maxLength={128}
                required
              />
              {register && (
                <span className="field-hint">
                  At least 8 characters. No special-character or uppercase
                  rules.
                </span>
              )}
            </label>
            {register && (
              <label>
                Confirm password
                <input
                  name="confirmPassword"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  required
                />
              </label>
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={showPassword}
                onChange={(e) => setShowPassword(e.target.checked)}
              />
              Show password{register ? "s" : ""}
            </label>
            <button className="primary full" disabled={busy}>
              {busy ? "Please wait…" : register ? "Create account" : "Sign in"}
              <ArrowRight size={17} />
            </button>
          </form>
          {!register && (
            <p className="small-note">
              <a href="/forgot-password">Forgot password?</a>
            </p>
          )}
          <button
            className="link"
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register
              ? "Already have an account? Sign in"
              : "New here? Create an account"}
          </button>
        </div>
      </div>
    </main>
  );
}
