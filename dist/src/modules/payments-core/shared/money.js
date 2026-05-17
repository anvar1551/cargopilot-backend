"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeCurrency = normalizeCurrency;
exports.currencyExponent = currencyExponent;
exports.minorToMajorFloat = minorToMajorFloat;
exports.formatProviderAmount = formatProviderAmount;
const CURRENCY_EXPONENT = {
    UZS: 2,
    USD: 2,
    EUR: 2,
    RUB: 2,
    CNY: 2,
};
function normalizeCurrency(code) {
    const normalized = String(code ?? "").trim().toUpperCase();
    if (!normalized)
        return "UZS";
    return normalized;
}
function currencyExponent(code) {
    const normalized = normalizeCurrency(code);
    return CURRENCY_EXPONENT[normalized] ?? 2;
}
function minorToMajorFloat(amountMinor, currency) {
    const exp = currencyExponent(currency);
    const divisor = 10 ** exp;
    return Number(amountMinor) / divisor;
}
function formatProviderAmount(amountMinor, currency, target) {
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
