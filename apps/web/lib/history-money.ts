export function currencyScale(currency = "EUR") {
  const digits =
    new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  return { digits, scale: 10 ** digits };
}
export function decimalMinor(value: string, currency = "EUR") {
  const { digits, scale } = currencyScale(currency);
  const text = value.trim().replace(",", ".");
  const pattern = digits ? new RegExp(`^\\d+(\\.\\d{1,${digits}})?$`) : /^\d+$/;
  if (!pattern.test(text))
    throw new Error(
      `Enter an amount with at most ${digits} decimal places for ${currency}.`,
    );
  const [whole, fraction = ""] = text.split(".");
  const result = Number(
    BigInt(whole!) * BigInt(scale) +
      BigInt(fraction.padEnd(digits, "0") || "0"),
  );
  if (!Number.isSafeInteger(result)) throw new Error("Amount is too large.");
  return result;
}
