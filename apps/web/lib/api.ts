export type Row = Record<string, any>;
export type Business = {
  id: string;
  name: string;
  role: string;
  entitlements: string[];
  permissions?: string[];
  accessScope?: 'business' | 'students';
  studentIds?: string[];
  settings: Row;
};
export type Api = (
  path: string,
  method?: string,
  body?: unknown,
  key?: string,
) => Promise<any>;
export const gateway =
  (process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080").replace(/\/$/, "");
export function supportReference(response: Response): string {
  const id = response.headers.get("x-request-id");
  return id && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id) ? ` Reference: ${id}` : "";
}
export function createApi(businessId?: string): Api {
  return async (path, method = "GET", body, key) => {
    const multipart = body instanceof FormData;
    const response = await fetch(`${gateway}/api/${path}`, {
      method,
      credentials: "include",
      headers: {
        ...(!multipart && body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(businessId ? { "X-Business-Id": businessId } : {}),
        ...(["POST", "PUT", "PATCH", "DELETE"].includes(method)
          ? { "Idempotency-Key": key ?? crypto.randomUUID() }
          : {}),
      },
      ...(body === undefined
        ? {}
        : { body: multipart ? body : JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        data.error?.message ??
        data.message ??
        `Request failed (${response.status})`;
      throw new Error(
        (Array.isArray(message) ? message.join(". ") : String(message)) + supportReference(response),
      );
    }
    return data;
  };
}
export async function downloadFile(
  path: string,
  businessId: string,
  filename: string,
) {
  const response = await fetch(`${gateway}/api/${path}`, {
    credentials: "include",
    headers: { "X-Business-Id": businessId },
  });
  if (!response.ok) throw new Error("The file could not be downloaded.");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const money = (amount: number, currency = "USD") =>
  new Intl.NumberFormat("en", { style: "currency", currency }).format(
    amount /
      10 **
        (new Intl.NumberFormat("en", {
          style: "currency",
          currency,
        }).resolvedOptions().maximumFractionDigits ?? 2),
  );
export const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";
