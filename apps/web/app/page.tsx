"use client";
import "./globals.css";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { featureRegistry, canReadFinancial, hasPermission } from "@palladium/contracts";
import { canUseFeature } from '../lib/features';
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
  Menu,
  X,
} from "lucide-react";
import {
  createApi,
  clearApi,
  errorMessage,
  type Api,
  type Business,
  type Row,
} from "../lib/api";
import { Notice } from "../components/shared";
import dynamic from "next/dynamic";
import { installClientDiagnostics } from "../lib/client-diagnostics";
import { defaultPalette } from "../lib/palette";
import { canNavigateTutor, navigateTutor, tutorLocationKeys } from "../lib/tutor-workspace";
import type { Audience } from "../features/communications";
function ScreenLoading() { return <p role="status">Opening this view…</p>; }
const Registration = dynamic(() => import("../features/registration").then(m => m.Registration), { loading: ScreenLoading });
const BusinessProfile = dynamic(() => import("../features/business-profile").then(m => m.BusinessProfile), { loading: ScreenLoading });
const DecisionDashboard = dynamic(() => import("../features/decision-dashboard").then(m => m.DecisionDashboard), { loading: ScreenLoading });
const WorkHistory = dynamic(() => import("../features/work-history").then(m => m.WorkHistory), { loading: ScreenLoading });
const CRM = dynamic(() => import("../features/crm").then(m => m.CRM), { loading: ScreenLoading });
const PlanningWorkspace = dynamic(() => import("../features/planning-workspace").then(m => m.PlanningWorkspace), { loading: ScreenLoading });
const StudentTracker = dynamic(() => import("../features/student-tracker").then(m => m.StudentTracker), { loading: ScreenLoading });
const CampaignComposer = dynamic(() => import("../features/communications").then(m => m.CampaignComposer), { loading: ScreenLoading });
const CommunicationConnections = dynamic(() => import("../features/communications").then(m => m.CommunicationConnections), { loading: ScreenLoading });
const Connectors = dynamic(() => import("../features/connectors").then(m => m.Connectors), { loading: ScreenLoading });
const AttributionSettings = dynamic(() => import("../features/attribution-settings").then(m => m.AttributionSettings), { loading: ScreenLoading });
const StudentBookingSettings = dynamic(() => import("../features/student-booking-settings").then(m => m.StudentBookingSettings), { loading: ScreenLoading });
const Sessions = dynamic(() => import("../features/sessions-calendar").then(m => m.Sessions), { loading: ScreenLoading });
const Learning = dynamic(() => import("../features/learning").then(m => m.Learning), { loading: ScreenLoading });
const Activity = dynamic(() => import("../features/finance").then(m => m.Activity), { loading: ScreenLoading });
const Invoices = dynamic(() => import("../features/finance").then(m => m.Invoices), { loading: ScreenLoading });
const Payments = dynamic(() => import("../features/finance").then(m => m.Payments), { loading: ScreenLoading });
const icons: Record<string, any> = {
  planning: ClipboardList,
  tracker: Users,
  clients: Users,
  scheduling: CalendarDays,
  learning: BookOpen,
  billing: ClipboardList,
  payments: Wallet,
  notifications: Bell,
  integrations: Plug,
};
type ConnectorFilter = "all" | "calendars" | "crm";
type WorkspaceRoute = { view: string; filter: ConnectorFilter };
function readRoute(business: Business): WorkspaceRoute {
  const params = new URLSearchParams(window.location.search);
  const rawView=params.get("view");
  const requested=rawView === "overview" ? "dashboard" : rawView ?? "dashboard";
  const allowed =
    requested === "dashboard" ||
    (requested === "settings" && hasPermission(business, 'platform.write')) ||
    featureRegistry.some(
      (f) =>
        f.id === requested && canUseFeature(business, f),
    );
  const filter = params.get("filter");
  return {
    view: allowed ? requested : "dashboard",
    filter:
      requested === "integrations" &&
      (filter === "crm" || filter === "calendars")
        ? filter
        : "all",
  };
}
function writeRoute(
  business: Business,
  route: WorkspaceRoute,
  replace = false,
) {
  const url = new URL(window.location.href);
  if (url.searchParams.get("business") !== business.id || url.searchParams.get("view") !== route.view) tutorLocationKeys.forEach(key => url.searchParams.delete(key));
  url.searchParams.set("business", business.id);
  url.searchParams.set("view", route.view);
  if (route.view === "integrations" && route.filter !== "all")
    url.searchParams.set("filter", route.filter);
  else url.searchParams.delete("filter");
  if (url.href !== window.location.href) {
    window.history[replace ? "replaceState" : "pushState"](null, "", url);
  }
}
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
    [route, setRoute] = useState<WorkspaceRoute>({
      view: "dashboard",
      filter: "all",
    }),
    [draftPalette, setDraftPalette] = useState<Row>(defaultPalette);
  async function loadBusinesses(preferred?: string, loaded?: Business[]) {
    const items = loaded ?? (await platform("platform/v1/businesses")).items;
    setBusinesses(items);
    const requestedId = new URLSearchParams(window.location.search).get(
      "business",
    );
    const selected =
      items.find(
        (b: Business) => b.id === (preferred ?? requestedId ?? business?.id),
      ) ??
      items[0] ??
      null;
    setBusiness(selected);
    if (selected) {
      const next =
        preferred && preferred !== requestedId
          ? { view: "dashboard", filter: "all" as const }
          : readRoute(selected);
      setRoute(next);
      writeRoute(selected, next, true);
    }
  }
  useEffect(() => {
    const restore = () => {
      const id = new URLSearchParams(window.location.search).get("business");
      const selected = businesses.find((b) => b.id === id) ?? businesses[0];
      if (!selected) return;
      const next = readRoute(selected);
      setBusiness(selected);
      setRoute(next);
      setNewBusiness(false);
      writeRoute(selected, next, true);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [businesses]);
  useEffect(() => {
    (async () => {
      try {
        const { item, items } = await platform("platform/v1/bootstrap");
        await loadBusinesses(undefined, items);
        setSession(item);
      } catch {
      } finally {
        setLoading(false);
      }
    })();
  }, [platform]);
  async function signedIn() {
    const { item, items } = await platform("platform/v1/bootstrap");
    await loadBusinesses(undefined, items);
    setSession(item);
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
  if (business && ['student', 'parent'].includes(business.role)) return <PortalRedirect businessId={business.id} />;
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
      route={route}
      onNavigate={(next) => {
        writeRoute(business, next);
        setRoute(next);
      }}
      onSelect={(selected) => {
        const next = { view: "dashboard", filter: "all" as const };
        writeRoute(selected, next);
        setRoute(next);
        setBusiness(selected);
      }}
      onSaved={saved}
      onAddBusiness={() => setNewBusiness(true)}
      onSignOut={async () => {
        await platform("platform/auth/sign-out", "POST", {});
        clearApi(platform);
        setSession(null);
        setBusiness(null);
        setBusinesses([]);
        window.history.replaceState(null, "", window.location.pathname);
      }}
    />
  );
}
function PortalRedirect({ businessId }: { businessId: string }) {
  useEffect(() => { window.location.replace(`/portal?business=${encodeURIComponent(businessId)}`); }, [businessId]);
  return <main className="loading-screen"><p>Opening your student portal…</p></main>;
}
function Workspace({
  business,
  businesses,
  user,
  onSelect,
  onSaved,
  onAddBusiness,
  onSignOut,
  route,
  onNavigate,
}: {
  business: Business;
  businesses: Business[];
  user: Row;
  onSelect: (b: Business) => void;
  onSaved: (b: Business) => Promise<void>;
  onAddBusiness: () => void;
  onSignOut: () => Promise<void>;
  route: WorkspaceRoute;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  const capabilityKey = JSON.stringify([user.id,business.role,business.permissions,business.entitlements,business.accessScope,business.studentIds]);
  const api = useMemo(() => createApi(business.id), [business.id,capabilityKey]);
  useEffect(() => () => clearApi(api), [api]);
  const { view, filter } = route;
  const diagnosticView = useRef(view);
  diagnosticView.current = view;
  useEffect(() => installClientDiagnostics(api, () => diagnosticView.current), [api]);
  const [historyFile,setHistoryFile]=useState<File|null>(null);
  const [dashboardTab,setDashboardTab]=useState<"overview"|"work">("overview");
  const [planningStudentId, setPlanningStudentId] = useState<string | undefined>();
  const [learningStudentId, setLearningStudentId] = useState<string | undefined>();
  const [learningAssignmentId, setLearningAssignmentId] = useState<string | undefined>();
  const [preview, setPreview] = useState<Row | null>(null),
    [menuOpen, setMenuOpen] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [messageAudience, setMessageAudience] = useState<Audience | null>(null);
  const content = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const previousView = useRef(view);
  useEffect(() => {
    setMenuOpen(false);
    setPreview(null);
    setError("");
    setNotice("");
    if (previousView.current !== view) {
      content.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    }
    previousView.current = view;
  }, [view, filter]);
  const branding = {
    ...defaultPalette,
    ...business.settings?.branding,
    ...preview,
  };
  const businessName = branding.displayName ?? business.name;
  const enabled = featureRegistry.filter((f) =>
    canUseFeature(business, f),
  );
  function go(next: string) {
    if (!canNavigateTutor(next, enabled.map(feature => feature.id), hasPermission(business, 'platform.write'))) return;
    setLearningAssignmentId(undefined);
    onNavigate({ view: next, filter: "all" });
    setMenuOpen(false);
    setPreview(null);
    setError("");
    setNotice("");
  }
  function openTutorRecord(next: "clients" | "tracker", id: string) {
    go(next);
    navigateTutor(business.id, next, next === "clients" ? {contact:id} : {student:id, trackerView:"all"}, true);
  }
  function connectors(type: "crm" | "calendars") {
    onNavigate({ view: "integrations", filter: type });
  }
  const title =
    view === "dashboard"
      ? "Dashboard"
      : view === "settings"
        ? "Business profile"
        : featureRegistry.find((f) => f.id === view)?.label;
  return (
    <div className="shell" style={theme(branding)}>
      <a className="skip-link" href="#workspace-content">
        Skip to workspace
      </a>
      <aside
        onKeyDown={(e) => {
          if (e.key === "Escape" && menuOpen) {
            setMenuOpen(false);
            menuButton.current?.focus();
          }
        }}
      >
        <div className="sidebar-heading">
          <div>
            <div className="wordmark">
              <GraduationCap />
              tuts
            </div>
            <span className="mobile-business">{businessName}</span>
          </div>
          <button
            ref={menuButton}
            className="mobile-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="workspace-navigation"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X size={18} /> : <Menu size={18} />}{" "}
            {menuOpen ? "Close" : "Menu"}
          </button>
        </div>
        <div
          id="workspace-navigation"
          className={`sidebar-content${menuOpen ? " is-open" : ""}`}
        >
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
          <nav aria-label="Workspace">
            <button
              className={view === "dashboard" ? "active" : ""}
              aria-current={view === "dashboard" ? "page" : undefined}
              onClick={() => go("dashboard")}
            >
              <LayoutDashboard size={18} />
              Dashboard
            </button>
            {enabled.map((f) => {
              const Icon = icons[f.id];
              return (
                <button
                  key={f.id}
                  className={view === f.id ? "active" : ""}
                  aria-current={view === f.id ? "page" : undefined}
                  onClick={() => go(f.id)}
                >
                  <Icon size={18} />
                  {f.label}
                </button>
              );
            })}
          </nav>
          <div className="sidebar-bottom">
            {hasPermission(business, 'platform.write') && <button
              className={view === "settings" ? "active" : ""}
              aria-current={view === "settings" ? "page" : undefined}
              onClick={() => go("settings")}
            >
              <Settings2 size={18} />
              Business profile
            </button>}
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
        <main
          ref={content}
          id="workspace-content"
          className="content"
          tabIndex={-1}
        >
          <Notice error={error} message={notice} />
          {view === "dashboard" && (
            <DecisionDashboard api={api} business={business} onInvoices={()=>go("billing")} onTracker={()=>go("tracker")} initialTab={dashboardTab} workTracker={<WorkHistory api={api} business={business} initialFile={historyFile} onFileConsumed={()=>setHistoryFile(null)}/>} monthlyInvoices={<WorkHistory api={api} business={business} mode="invoices"/>}/>
          )}
          {view === "tracker" && <StudentTracker api={api} business={business} onOpenCRM={(id) => openTutorRecord("clients", id)} onOpenPlanning={business.entitlements.includes("planning") && hasPermission(business, "planning.read") ? (studentId) => { setPlanningStudentId(studentId); go("planning"); } : undefined} onOpenLearning={business.entitlements.includes("learning") && hasPermission(business, "learning.write") ? (studentId, assignmentId) => { go("learning"); setLearningStudentId(studentId); setLearningAssignmentId(assignmentId); } : undefined} />}
          {view === "clients" && (
            <CRM
              api={api}
              businessId={business.id}
              onImportHistory={business.entitlements.includes("billing") && canReadFinancial(business) && hasPermission(business,"billing.write") ? file=>{setHistoryFile(file);setDashboardTab("work");go("dashboard");}:undefined}
              onOpenTracker={enabled.some(feature => feature.id === "tracker") ? (id) => openTutorRecord("tracker", id) : undefined}
              role={business.role}
              permissions={business.permissions}
              onMessage={
                business.entitlements.includes("notifications") && hasPermission(business, 'notifications.write')
                  ? setMessageAudience
                  : undefined
              }
              onConnect={() => connectors("crm")}
            />
          )}
          {view === "scheduling" && (
            <Sessions api={api} onConnect={() => connectors("calendars")} />
          )}
          {view === "learning" && (
            <Learning
              initialStudentId={learningStudentId}
              initialAssignmentId={learningAssignmentId}
              api={api}
              businessId={business.id}
              onOpenClients={() => go("clients")}
            />
          )}
          {view === "planning" && <PlanningWorkspace api={api} business={business} initialStudentId={planningStudentId} />}
          {view === "billing" && <Invoices api={api} business={business} />}
          {view === "payments" && (
            <Payments api={api} role={business.role} businessId={business.id} />
          )}
          {view === "notifications" && (
            <>
              <button onClick={() => setMessageAudience({ filter: {} })}>
                Messages & campaign history
              </button>
              <Activity api={api} />
            </>
          )}
          {view === "integrations" &&
            (business.entitlements.includes("integrations") ? (
              <>
                <Connectors api={api} role={business.role} filter={filter} />
                {filter !== "crm" && <StudentBookingSettings api={api} business={business} userId={user.id} />}
              {filter === "all" && <AttributionSettings api={api} business={business} />}
                {filter === "all" &&
                  business.entitlements.includes("notifications") && (
                    <CommunicationConnections api={api} role={business.role} />
                  )}
              </>
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
          {messageAudience && (
            <CampaignComposer
              api={api}
              role={business.role}
              audience={messageAudience}
              onClose={() => setMessageAudience(null)}
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
