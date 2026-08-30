import { createHash } from "crypto";
import Decimal from "decimal.js";
import { financeBadRequest } from "./finance.errors";
import { assertFinanceCurrency, type FinanceCurrency } from "./ledger";
import {
  assertPostingEvent,
  FINANCE_AMOUNT_KEYS,
  type FinanceAmountKey,
  type FinancePostingSource,
} from "./posting-rules";

export type FinanceEventDimensions = {
  orderId?: string;
  orderLegId?: string;
  customerEntityId?: string;
  branchId?: string;
  warehouseId?: string;
  carrierProviderId?: string;
  costCenterCode?: string;
  profitCenterCode?: string;
};

export type CanonicalFinanceSourceEvent = {
  schemaVersion: 1;
  sourceEventId: string;
  companyId: string;
  sourceType: FinancePostingSource;
  eventType: string;
  sourceId: string;
  actorUserId?: string | null;
  occurredAt: Date;
  documentDate: Date;
  postingDate: Date;
  currency: FinanceCurrency;
  fxRate: string;
  fxRateAsOf?: Date | null;
  amounts: Partial<Record<FinanceAmountKey, string>>;
  dimensions: FinanceEventDimensions;
  attributes: Record<string, string | number | boolean | null>;
  description?: string | null;
  metadata: Record<string, unknown>;
};

export type CanonicalFinanceSourceEventInput = Omit<
  CanonicalFinanceSourceEvent,
  "schemaVersion" | "occurredAt" | "documentDate" | "postingDate" | "currency" | "fxRateAsOf"
> & {
  schemaVersion?: 1;
  occurredAt: Date | string;
  documentDate?: Date | string;
  postingDate?: Date | string;
  currency: string;
  fxRateAsOf?: Date | string | null;
};

function requiredString(value: unknown, field: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw financeBadRequest(`${field} is required`, "FINANCE_SOURCE_EVENT_INVALID");
  }
  return normalized;
}

function eventDate(value: Date | string | undefined, field: string, fallback?: Date) {
  const parsed = value === undefined ? fallback : value instanceof Date ? value : new Date(value);
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw financeBadRequest(`${field} must be a valid date`, "FINANCE_SOURCE_EVENT_INVALID");
  }
  return parsed;
}

function normalizeAmount(value: unknown, key: string) {
  try {
    const amount = new Decimal(String(value));
    if (!amount.isFinite() || amount.lte(0)) throw new Error("not positive");
    return amount.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
  } catch {
    throw financeBadRequest(
      `amounts.${key} must be a positive decimal`,
      "FINANCE_SOURCE_EVENT_AMOUNT_INVALID",
    );
  }
}

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizeFinanceSourceEvent(
  input: CanonicalFinanceSourceEventInput,
): CanonicalFinanceSourceEvent {
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
    throw financeBadRequest("Unsupported finance source-event schema version", "FINANCE_SOURCE_EVENT_VERSION");
  }
  const sourceType = requiredString(input.sourceType, "sourceType") as FinancePostingSource;
  const eventType = requiredString(input.eventType, "eventType");
  assertPostingEvent(sourceType, eventType);
  const occurredAt = eventDate(input.occurredAt, "occurredAt");
  const currency = assertFinanceCurrency(input.currency);
  const amounts: Partial<Record<FinanceAmountKey, string>> = {};
  for (const [key, value] of Object.entries(input.amounts ?? {})) {
    if (!FINANCE_AMOUNT_KEYS.includes(key as FinanceAmountKey)) {
      throw financeBadRequest(`Unsupported finance amount key ${key}`, "FINANCE_SOURCE_EVENT_AMOUNT_KEY");
    }
    if (value !== undefined && value !== null) {
      amounts[key as FinanceAmountKey] = normalizeAmount(value, key);
    }
  }
  if (Object.keys(amounts).length === 0) {
    throw financeBadRequest("At least one finance amount is required", "FINANCE_SOURCE_EVENT_AMOUNTS_EMPTY");
  }
  const fxRate = normalizeAmount(input.fxRate, "fxRate");
  return {
    schemaVersion: 1,
    sourceEventId: requiredString(input.sourceEventId, "sourceEventId"),
    companyId: requiredString(input.companyId, "companyId"),
    sourceType,
    eventType,
    sourceId: requiredString(input.sourceId, "sourceId"),
    actorUserId: typeof input.actorUserId === "string" ? input.actorUserId.trim() || null : null,
    occurredAt,
    documentDate: eventDate(input.documentDate, "documentDate", occurredAt),
    postingDate: eventDate(input.postingDate, "postingDate", occurredAt),
    currency,
    fxRate,
    fxRateAsOf: input.fxRateAsOf ? eventDate(input.fxRateAsOf, "fxRateAsOf") : null,
    amounts,
    dimensions: plainRecord(input.dimensions) as FinanceEventDimensions,
    attributes: plainRecord(input.attributes) as Record<string, string | number | boolean | null>,
    description: typeof input.description === "string" ? input.description.trim() || null : null,
    metadata: plainRecord(input.metadata),
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function financeSourceEventHash(event: CanonicalFinanceSourceEvent) {
  return createHash("sha256").update(JSON.stringify(stable(event))).digest("hex");
}

function equalCondition(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((candidate) => equalCondition(actual, candidate));
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
      equalCondition((actual as Record<string, unknown>)[key], value),
    );
  }
  return actual === expected;
}

export function postingRuleMatches(
  event: CanonicalFinanceSourceEvent,
  conditions: unknown,
) {
  if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) return true;
  const context = {
    ...event.attributes,
    ...event.dimensions,
    currency: event.currency,
    sourceType: event.sourceType,
    eventType: event.eventType,
  };
  return Object.entries(conditions as Record<string, unknown>).every(([key, expected]) =>
    equalCondition(context[key as keyof typeof context], expected),
  );
}

export function documentTypeForSource(sourceType: FinancePostingSource, eventType?: string) {
  switch (sourceType) {
    case "invoice": return "customer_invoice" as const;
    case "payment": return "payment" as const;
    case "refund": return "adjustment" as const;
    case "cash_custody": return "cash_movement" as const;
    case "carrier_cost": return eventType === "carrier.bill_approved"
      ? "carrier_bill" as const
      : "carrier_cost_accrual" as const;
    case "payable": return "payment" as const;
  }
}
