import { z } from "zod";
export const FINANCIAL_DELEGATION_REVISION = "financial-delegation.v1";
export const FINANCIAL_PROFILES = Object.freeze({
  "pricing-maker.v1": ["pricing.read", "pricing.write", "pricing.tariffs.propose", "billing.policies.propose"],
  "pricing-checker.v1": ["pricing.read", "pricing.tariffs.approve", "billing.policies.approve"],
  "billing-operator.v1": ["customers.read", "billing.payers.bind", "pricing.orders.accept"],
  "price-exception-checker.v1": ["customers.read", "pricing.orders.approve"],
  "manual-invoice-issuer.v1": ["customers.read", "finance.invoices.read", "finance.invoices.issue"],
  "entity-configuration-reader.v1": ["finance.settings.read"],
} as const);
export type FinancialProfile = keyof typeof FINANCIAL_PROFILES;
export const financialProfileSchema = z.enum(["pricing-maker.v1", "pricing-checker.v1", "billing-operator.v1", "price-exception-checker.v1", "manual-invoice-issuer.v1", "entity-configuration-reader.v1"]);
export const financialProfilesSchema = z.array(financialProfileSchema).min(1).max(6).refine(v => new Set(v).size === v.length, "Duplicate profile").transform(v => [...v].sort());
// Shared customer and pricing read permissions still serve existing operational callers.
// Financial mutation/finance-read keys require explicit durable financial acceptance.
export const FINANCIAL_ACCEPTANCE_KEYS: readonly string[] = ["pricing.write", "pricing.tariffs.propose", "pricing.tariffs.approve",
  "billing.policies.propose", "billing.policies.approve", "billing.payers.bind", "pricing.orders.accept", "pricing.orders.approve",
  "finance.invoices.read", "finance.invoices.issue", "finance.settings.read"];
