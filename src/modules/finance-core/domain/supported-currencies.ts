/** Server support, not a tenant or database currency enum. Adding a currency
 * requires deliberately validated exact calculation/storage support. No FX or
 * provider minor-unit guarantee follows from this list. */
export const SUPPORTED_FINANCE_CURRENCIES = ["UZS", "USD", "CNY"] as const;
