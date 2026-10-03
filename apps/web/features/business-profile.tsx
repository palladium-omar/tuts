import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Upload } from "lucide-react";
import { errorMessage, type Api, type Business, type Row } from "../lib/api";
import { Notice } from "../components/shared";
export const defaultPalette = {
  primaryColor: "#315d4d",
  secondaryColor: "#cbd8a3",
  backgroundColor: "#f7f8f5",
  textColor: "#202b28",
};
export const palettes = [
  { name: "Sage", ...defaultPalette },
  {
    name: "Ocean",
    primaryColor: "#185b86",
    secondaryColor: "#b9def0",
    backgroundColor: "#f2f7fb",
    textColor: "#19334a",
  },
  {
    name: "Plum",
    primaryColor: "#714166",
    secondaryColor: "#eed5e4",
    backgroundColor: "#fcf7fb",
    textColor: "#382639",
  },
  {
    name: "Terracotta",
    primaryColor: "#974b36",
    secondaryColor: "#f1d4aa",
    backgroundColor: "#fcf8f1",
    textColor: "#3c3029",
  },
];
async function prepareLogo(file: File): Promise<string> {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 5 * 1024 * 1024
  )
    throw new Error("Choose a PNG, JPG, or WebP logo under 5 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const ratio = Math.min(1, 512 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    canvas
      .getContext("2d")!
      .drawImage(image, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL("image/webp", 0.85);
    if (result.length > 340000)
      throw new Error("This logo is too detailed. Choose a smaller image.");
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}
export function BusinessProfile({
  api,
  business,
  onSaved,
  onPalette,
  onCancel,
}: {
  api: Api;
  business?: Business;
  onSaved: (b: Business) => Promise<void> | void;
  onPalette?: (value: Row) => void;
  onCancel?: () => void;
}) {
  const [step, setStep] = useState(0),
    [name, setName] = useState(
      business?.settings?.branding?.displayName ?? business?.name ?? "",
    );
  const [profile, setProfile] = useState<Row>(
    business?.settings?.profile ?? {},
  );
  const [branding, setBranding] = useState<Row>({
    ...defaultPalette,
    ...business?.settings?.branding,
  });
  const [timezone, setTimezone] = useState(
    business?.settings?.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const changeBrand = (patch: Row) => {
    const next = { ...branding, ...patch };
    setBranding(next);
    onPalette?.(next);
  };
  const profileField = (key: string, label: string, type = "text") => (
    <label>
      {label}
      <input
        type={type}
        value={profile[key] ?? ""}
        onChange={(e) => setProfile({ ...profile, [key]: e.target.value })}
      />
    </label>
  );
  const addressField = (key: string, label: string) => (
    <label>
      {label}
      <input
        value={profile.address?.[key] ?? ""}
        onChange={(e) =>
          setProfile({
            ...profile,
            address: { ...profile.address, [key]: e.target.value },
          })
        }
      />
    </label>
  );
  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!name.trim()) {
      setError("Give your business a name.");
      setStep(0);
      return;
    }
    setBusy(true);
    setError("");
    const clean: Row = {};
    for (const [key, value] of Object.entries(profile)) {
      if (key === "address") {
        clean.address = value
          ? Object.fromEntries(
              Object.entries(value as Row).map(([k, v]) => [k, v || null]),
            )
          : null;
      } else clean[key] = value || null;
    }
    const details = {
      profile: clean,
      branding: { ...branding, displayName: name.trim() },
      timezone,
    };
    try {
      const result = await api(
        business
          ? `platform/v1/businesses/${business.id}/settings`
          : "platform/v1/businesses",
        business ? "PATCH" : "POST",
        business ? details : { name: name.trim(), ...details },
      );
      await onSaved(result.item);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="profile-editor panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">
            {business ? "YOUR BUSINESS" : "MAKE IT YOURS"}
          </span>
          <h2>
            {business
              ? "Business profile & appearance"
              : "Set up your tutoring space"}
          </h2>
          <p className="muted">
            Your details and logo are saved once and reused on invoices.
            Everything except the business name is optional.
          </p>
        </div>
      </div>
      <Notice error={error} />
      {!business && (
        <div className="step-tabs">
          <button
            className={step === 0 ? "active" : ""}
            onClick={() => setStep(0)}
          >
            1 · Business details
          </button>
          <button
            className={step === 1 ? "active" : ""}
            onClick={() => {
              if (name.trim()) setStep(1);
              else setError("Enter your business name first.");
            }}
          >
            2 · Make it yours
          </button>
        </div>
      )}
      <form
        onSubmit={
          business || step === 1
            ? save
            : (e) => {
                e.preventDefault();
                setError("");
                setStep(1);
              }
        }
      >
        {(business || step === 0) && (
          <>
            <h3>Business details</h3>
            <div className="form-grid">
              <label>
                Business name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={120}
                />
              </label>
              {profileField("legalName", "Legal / invoice name")}
              {profileField("email", "Business email", "email")}
              {profileField("phone", "Phone", "tel")}
              {profileField("website", "Website", "url")}
              {profileField("taxId", "Tax / registration number")}
            </div>
            <h3 className="form-section-title">Business address</h3>
            <div className="form-grid">
              {addressField("line1", "Street address")}
              {addressField("line2", "Apartment / suite")}
              {addressField("city", "City")}
              {addressField("region", "State / region")}
              {addressField("postalCode", "Postal code")}
              {addressField("country", "Country")}
              <label>
                Timezone
                <input
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                />
              </label>
            </div>
          </>
        )}
        {(business || step === 1) && (
          <>
            <h3 className="form-section-title">Your logo</h3>
            <div className="logo-upload">
              {branding.logoDataUrl || branding.logoUrl ? (
                <img
                  src={branding.logoDataUrl ?? branding.logoUrl}
                  alt="Business logo"
                />
              ) : (
                <div className="logo-placeholder">{name[0] ?? "T"}</div>
              )}
              <div>
                <label className="upload-button">
                  <Upload size={16} />
                  Choose logo
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file)
                        try {
                          changeBrand({
                            logoDataUrl: await prepareLogo(file),
                            logoUrl: null,
                          });
                          setError("");
                        } catch (err) {
                          setError(errorMessage(err));
                        }
                      e.target.value = "";
                    }}
                  />
                </label>
                <p className="small-note">
                  PNG, JPG, or WebP. We resize it for you.
                </p>
                {(branding.logoDataUrl || branding.logoUrl) && (
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      changeBrand({ logoDataUrl: null, logoUrl: null })
                    }
                  >
                    Remove logo
                  </button>
                )}
              </div>
            </div>
            <h3 className="form-section-title">Workspace palette</h3>
            <p className="muted">
              Applies to your workspace, navigation, cards, and buttons.
            </p>
            <div className="palette-presets">
              {palettes.map((p) => (
                <button
                  type="button"
                  key={p.name}
                  onClick={() => {
                    const { name: _, ...colors } = p;
                    changeBrand(colors);
                  }}
                >
                  <span style={{ background: p.primaryColor }} />
                  <span style={{ background: p.secondaryColor }} />
                  {p.name}
                </button>
              ))}
            </div>
            <div className="palette-fields">
              {Object.entries({
                primaryColor: "Primary",
                secondaryColor: "Secondary",
                backgroundColor: "Background",
                textColor: "Text",
              }).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    type="color"
                    value={branding[key]}
                    onChange={(e) => changeBrand({ [key]: e.target.value })}
                  />
                  <code>{branding[key]}</code>
                </label>
              ))}
            </div>
            <div
              className="brand-preview"
              style={{
                background: branding.backgroundColor,
                color: branding.textColor,
                borderColor: branding.secondaryColor,
              }}
            >
              <div
                className="preview-top"
                style={{ background: branding.primaryColor }}
              >
                <span style={{ color: "#fff" }}>
                  {name || "Your tutoring business"}
                </span>
              </div>
              <strong>A workspace that feels like you.</strong>
              <p>Your students, resources, and business in one place.</p>
              <span
                className="preview-pill"
                style={{
                  background: branding.secondaryColor,
                  color: branding.textColor,
                }}
              >
                Your next session
              </span>
            </div>
          </>
        )}
        <div className="form-actions">
          {onCancel && (
            <button type="button" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          )}
          {!business && step === 1 && (
            <button type="button" onClick={() => setStep(0)}>
              <ArrowLeft size={16} /> Back
            </button>
          )}
          {!business && step === 0 && (
            <button type="button" disabled={busy} onClick={() => void save()}>
              Skip optional details
            </button>
          )}
          <button className="primary" disabled={busy}>
            {busy
              ? "Saving…"
              : business
                ? "Save business profile"
                : step === 0
                  ? "Continue"
                  : "Open my workspace"}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </section>
  );
}
