"use client";
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { featureRegistry } from "@palladium/contracts";
import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  Plug,
  Settings2,
  Users,
  Wallet,
  Bell,
} from "lucide-react";
import {
  createApi,
  errorMessage,
  type Api,
  type Business,
  type Row,
} from "../lib/api";
import { Notice } from "../components/shared";
import { BusinessProfile, defaultPalette } from "../features/business-profile";
import { CRM } from "../features/crm";
import { Connectors, Sessions } from "../features/connectors";
import { Learning } from "../features/learning";
import { Activity, Invoices, Payments } from "../features/finance";
const icons: Record<string, any> = {
  clients: Users,
  scheduling: CalendarDays,
  learning: BookOpen,
  billing: ClipboardList,
  payments: Wallet,
  notifications: Bell,
  integrations: Plug,
};
function theme(branding: Row): CSSProperties {
  const c = branding.primaryColor ?? defaultPalette.primaryColor;
  const light =
    (parseInt(c.slice(1, 3), 16) * 299 +
      parseInt(c.slice(3, 5), 16) * 587 +
      parseInt(c.slice(5, 7), 16) * 114) /
      1000 >
    160;
  return {
    "--on-accent": light ? "#17251e" : "#ffffff",
    "--accent": branding.primaryColor ?? defaultPalette.primaryColor,
    "--secondary": branding.secondaryColor ?? defaultPalette.secondaryColor,
    "--background": branding.backgroundColor ?? defaultPalette.backgroundColor,
    "--ink": branding.textColor ?? defaultPalette.textColor,
  } as CSSProperties;
}
export default function Home() {
  const platform = useMemo(() => createApi(), []);
  const [session, setSession] = useState<Row | null>(null),
    [businesses, setBusinesses] = useState<Business[]>([]),
    [business, setBusiness] = useState<Business | null>(null),
    [loading, setLoading] = useState(true),
    [newBusiness, setNewBusiness] = useState(false),
    [draftPalette, setDraftPalette] = useState<Row>(defaultPalette);
  async function loadBusinesses(preferred?: string) {
    const { items } = await platform("platform/v1/businesses");
    setBusinesses(items);
    setBusiness(
      (current) =>
        items.find((b: Business) => b.id === (preferred ?? current?.id)) ??
        items[0] ??
        null,
    );
  }
  useEffect(() => {
    (async () => {
      try {
        const { item } = await platform("platform/v1/session");
        setSession(item);
        await loadBusinesses();
      } catch {
      } finally {
        setLoading(false);
      }
    })();
  }, [platform]);
  async function signedIn() {
    const { item } = await platform("platform/v1/session");
    setSession(item);
    await loadBusinesses();
  }
  async function saved(created: Business) {
    await loadBusinesses(created.id);
    setNewBusiness(false);
  }
  if (loading)
    return (
      <main className="loading-screen">
        <GraduationCap size={32} />
        <p>Opening your workspace…</p>
      </main>
    );
  if (!session) return <Registration api={platform} onSignedIn={signedIn} />;
  if (!business || newBusiness)
    return (
      <main className="onboarding" style={theme(draftPalette)}>
        <BusinessProfile
          api={platform}
          onSaved={saved}
          onPalette={setDraftPalette}
          onCancel={business ? () => setNewBusiness(false) : undefined}
        />
      </main>
    );
  return (
    <Workspace
      key={business.id}
      business={business}
      businesses={businesses}
      user={session.user}
      onSelect={setBusiness}
      onSaved={saved}
      onAddBusiness={() => setNewBusiness(true)}
      onSignOut={async () => {
        await platform("platform/auth/sign-out", "POST", {});
        setSession(null);
        setBusiness(null);
        setBusinesses([]);
      }}
    />
  );
}
function Registration({
  api,
  onSignedIn,
}: {
  api: Api;
  onSignedIn: () => Promise<void>;
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
          <span className="eyebrow light">ROOM TO TEACH</span>
          <h1>
            Your practice.
            <br />
            All together.
          </h1>
          <p>
            Your students, your tools,
            <br />
            your own way of teaching.
          </p>
        </div>
        <div className="auth-foot">
          <span className="little-star">✳</span>Built around independent
          educators.
        </div>
      </div>
      <div className="auth-panel">
        <div className="auth-card">
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h2>{register ? "Make room for good teaching." : "Welcome back."}</h2>
          <p className="muted">
            {register
              ? "Create your account, then make this space your own."
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
function Workspace({
  business,
  businesses,
  user,
  onSelect,
  onSaved,
  onAddBusiness,
  onSignOut,
}: {
  business: Business;
  businesses: Business[];
  user: Row;
  onSelect: (b: Business) => void;
  onSaved: (b: Business) => Promise<void>;
  onAddBusiness: () => void;
  onSignOut: () => Promise<void>;
}) {
  const api = useMemo(() => createApi(business.id), [business.id]);
  const [view, setView] = useState("overview"),
    [filter, setFilter] = useState<"all" | "calendars" | "crm">("all"),
    [preview, setPreview] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const branding = {
    ...defaultPalette,
    ...business.settings?.branding,
    ...preview,
  };
  const businessName = branding.displayName ?? business.name;
  const enabled = featureRegistry.filter((f) =>
    business.entitlements.includes(f.entitlement),
  );
  function go(next: string) {
    setView(next);
    setPreview(null);
    setError("");
    setNotice("");
    if (next === "integrations") setFilter("all");
  }
  function connectors(type: "crm" | "calendars") {
    go("integrations");
    setFilter(type);
  }
  const title =
    view === "overview"
      ? "Overview"
      : view === "settings"
        ? "Business profile"
        : featureRegistry.find((f) => f.id === view)?.label;
  return (
    <div className="shell" style={theme(branding)}>
      <aside>
        <div className="wordmark">
          <GraduationCap />
          tuts
        </div>
        <div className="business-picker">
          {branding.logoDataUrl || branding.logoUrl ? (
            <img
              className="business-logo"
              src={branding.logoDataUrl ?? branding.logoUrl}
              alt=""
            />
          ) : (
            <span className="avatar">{businessName[0]}</span>
          )}
          <select
            aria-label="Business workspace"
            value={business.id}
            onChange={(e) =>
              onSelect(businesses.find((b) => b.id === e.target.value)!)
            }
          >
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.settings?.branding?.displayName ?? b.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </div>
        <span className="nav-caption">WORKSPACE</span>
        <nav>
          <button
            className={view === "overview" ? "active" : ""}
            onClick={() => go("overview")}
          >
            <LayoutDashboard size={18} />
            Overview
          </button>
          {enabled.map((f) => {
            const Icon = icons[f.id];
            return (
              <button
                key={f.id}
                className={view === f.id ? "active" : ""}
                onClick={() => go(f.id)}
              >
                <Icon size={18} />
                {f.label}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => go("settings")}
          >
            <Settings2 size={18} />
            Business profile
          </button>
          <button className="new-business" onClick={onAddBusiness}>
            + Add a business
          </button>
          <div className="profile">
            <span className="avatar pale">{user.name?.[0]}</span>
            <div>
              <strong>{user.name}</strong>
              <small>{business.role}</small>
            </div>
            <button
              title="Sign out"
              aria-label="Sign out"
              onClick={() =>
                void onSignOut().catch((e) => setError(errorMessage(e)))
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <section className="workspace">
        <header>
          <div>
            <span className="muted">{businessName}</span>
            <span className="slash">/</span>
            {title}
          </div>
          <span className="header-account">Your tutoring workspace</span>
        </header>
        <main className="content">
          <Notice error={error} message={notice} />
          {view === "overview" && (
            <Overview api={api} business={business} user={user} go={go} />
          )}
          {view === "clients" && (
            <CRM api={api} onConnect={() => connectors("crm")} />
          )}
          {view === "scheduling" && (
            <Sessions api={api} onConnect={() => connectors("calendars")} />
          )}
          {view === "learning" && (
            <Learning api={api} businessId={business.id} />
          )}
          {view === "billing" && <Invoices api={api} business={business} />}
          {view === "payments" && <Payments api={api} />}
          {view === "notifications" && <Activity api={api} />}
          {view === "integrations" &&
            (business.entitlements.includes("integrations") ? (
              <Connectors api={api} role={business.role} filter={filter} />
            ) : (
              <div className="panel">
                Connectors are not enabled for this workspace.
              </div>
            ))}
          {view === "settings" && (
            <BusinessProfile
              key={business.id}
              api={api}
              business={business}
              onPalette={setPreview}
              onSaved={async (b) => {
                await onSaved(b);
                setPreview(null);
                setNotice(
                  "Business profile saved. Your workspace now uses these details.",
                );
              }}
            />
          )}
          <footer>
            tuts <span>·</span>A little more room to teach.
          </footer>
        </main>
      </section>
    </div>
  );
}
function Overview({
  api,
  business,
  user,
  go,
}: {
  api: Api;
  business: Business;
  user: Row;
  go: (v: string) => void;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const entries = [
    {
      id: "clients",
      label: "CRM contacts",
      path: "clients/v1/clients?limit=1",
    },
    {
      id: "scheduling",
      label: "Connected sessions",
      path: "scheduling/v1/external-sessions",
    },
    { id: "learning", label: "Assignments", path: "learning/v1/assignments" },
    { id: "billing", label: "Invoices", path: "billing/v1/invoices" },
  ].filter((e) => business.entitlements.includes(e.id));
  useEffect(() => {
    let active = true;
    Promise.allSettled(
      entries.map(async (e) => {
        const r = await api(e.path);
        return [e.id, r.total ?? r.items.length] as const;
      }),
    ).then((results) => {
      if (active)
        setCounts(
          Object.fromEntries(
            results
              .filter((r) => r.status === "fulfilled")
              .map(
                (r) =>
                  (r as PromiseFulfilledResult<readonly [string, number]>)
                    .value,
              ),
          ),
        );
    });
    return () => {
      active = false;
    };
  }, [api]);
  return (
    <>
      <div className="section-heading">
        <div>
          <span className="eyebrow">
            WELCOME, {String(user.name).split(" ")[0].toUpperCase()}
          </span>
          <h1>A little clarity for your day.</h1>
          <p className="muted">More time for the work that matters.</p>
        </div>
      </div>
      {!business.settings?.profile && (
        <div className="onboarding-banner">
          <div>
            <strong>Make this workspace yours.</strong>
            <p>
              Add your logo, business address, and palette once. We’ll reuse
              them on invoices.
            </p>
          </div>
          <button onClick={() => go("settings")}>
            Complete business profile
            <ArrowRight size={15} />
          </button>
        </div>
      )}
      <div className="stat-grid">
        {entries.map((e) => {
          const Icon = icons[e.id];
          return (
            <button className="stat-card" key={e.id} onClick={() => go(e.id)}>
              <div>
                <span>{e.label}</span>
                <Icon size={20} />
              </div>
              <strong>{counts[e.id] ?? "—"}</strong>
              <small>
                Open {e.label.toLowerCase()}
                <ArrowRight size={13} />
              </small>
            </button>
          );
        })}
      </div>
      <div className="overview-grid">
        <section className="welcome-card">
          <span className="eyebrow light">A PRACTICE THAT FITS YOU</span>
          <h2>
            Your tools.
            <br />
            Your students.
            <br />
            One clear view.
          </h2>
          <p>
            Connect your booking calendar, bring your contacts, and keep
            learning materials close.
          </p>
          <button onClick={() => go("integrations")}>
            Connect your tools
            <ArrowRight size={17} />
          </button>
          <div className="decor-circle">✳</div>
        </section>
        <section className="panel">
          <div className="panel-title">
            <h3>Your workspace</h3>
          </div>
          {featureRegistry
            .filter((f) => business.entitlements.includes(f.entitlement))
            .map((f) => {
              const Icon = icons[f.id];
              return (
                <button
                  className="feature-row"
                  key={f.id}
                  onClick={() => go(f.id)}
                >
                  <span className="feature-icon">
                    <Icon size={18} />
                  </span>
                  <span>
                    {f.label}
                    <small>
                      {f.id === "clients"
                        ? "Contacts, imports & relationships"
                        : f.id === "integrations"
                          ? "Calendars, forms & data sources"
                          : f.id === "learning"
                            ? "Assignments & attached resources"
                            : "Open this feature"}
                    </small>
                  </span>
                  <ArrowRight size={16} />
                </button>
              );
            })}
        </section>
      </div>
    </>
  );
}
