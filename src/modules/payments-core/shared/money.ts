export type ProviderAmountTarget = "CLICK" | "PAYME" | "UZUM";

const CURRENCY_EXPONENT: Record<string, number> = {
  UZS: 2,
  USD: 2,
  CNY: 2,
};

export function normalizeCurrency(code: string): string {
  const normalized = String(code ?? "").trim().toUpperCase();
  if (!normalized) return "UZS";
  return normalized;
}

export function currencyExponent(code: string): number {
  const normalized = normalizeCurrency(code);
  return CURRENCY_EXPONENT[normalized] ?? 2;
}

export function minorToMajorFloat(amountMinor: bigint, currency: string): number {
  const exp = currencyExponent(currency);
  const divisor = 10 ** exp;
  return Number(amountMinor) / divisor;
}

export function minorToMajorString(amountMinor: bigint, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = amountMinor < 0n;
  const absolute = negative ? -amountMinor : amountMinor;
  if (exponent === 0) return `${negative ? "-" : ""}${absolute}`;
  const raw = absolute.toString().padStart(exponent + 1, "0");
  const whole = raw.slice(0, -exponent);
  const fraction = raw.slice(-exponent);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function formatProviderAmount(
  amountMinor: bigint,
  currency: string,
  target: ProviderAmountTarget,
): string | number {
  const normalizedCurrency = normalizeCurrency(currency);
  if (target === "CLICK") {
    // Click merchant API uses amount as numeric value. We send major units.
    // Example: 130000 minor (tiyin) -> 1300.00 UZS.
    const major = minorToMajorFloat(amountMinor, normalizedCurrency);
    return Number(major.toFixed(currencyExponent(normalizedCurrency)));
  }
  if (target === "PAYME") {
    // Payme checkout URL `a` expects integer amount in minor units.
    return amountMinor.toString();
  }
  // Uzum webhook-driven flow does not currently require amount formatting
  // during create intent, keep minor unit representation for metadata.
  return amountMinor.toString();
}
