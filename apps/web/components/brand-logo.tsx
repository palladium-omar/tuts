import "./brand-logo.css";

const brands: Record<string, { name: string; asset: string; square?: boolean }> = {
  calcom: { name: "Cal.com", asset: "calcom.svg" },
  calendly: { name: "Calendly", asset: "calendly.svg", square: true },
  google_calendar: { name: "Google Calendar", asset: "google-calendar.svg", square: true },
  commonapp: { name: "Common App", asset: "commonapp.svg" },
  ucas: { name: "UCAS", asset: "ucas.svg" },
  bocconi: { name: "Bocconi", asset: "bocconi.svg" },
  campusfrance: { name: "Campus France", asset: "campusfrance.webp" },
};

export function BrandLogo({ brand, size = 40, className = "" }: { brand: string; size?: number; className?: string }) {
  const item = brands[brand];
  if (!item) return null;
  const height = Math.max(20, Math.min(80, size));
  return <span className={`brand-logo brand-logo-${brand} ${className}`} style={{ width: item.square ? height : height * 2, height }}>
    <img src={`/brands/${item.asset}`} width={item.square ? height : height * 2} height={height} alt={`${item.name} logo`} decoding="async" />
  </span>;
}
