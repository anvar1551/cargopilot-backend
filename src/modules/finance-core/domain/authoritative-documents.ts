import { createHash } from "crypto";
import Decimal from "decimal.js";
import { financeBadRequest } from "./finance.errors";
import { assertFinanceCurrency } from "./ledger";

export type ProviderSettlementLineInput = {
  type: "payment" | "refund" | "fee" | "adjustment";
  amount: string;
  externalTransactionId?: string | null;
  paymentIntentId?: string | null;
  paymentRefundId?: string | null;
  orderId?: string | null;
  reconciliationStatus?: "unmatched" | "matched" | "mismatch" | "ignored";
  reconciliationMessage?: string | null;
  occurredAt?: Date | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
};

export type CarrierBillLineInput = {
  orderId: string;
  orderLegId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxAmount: string;
  metadata?: Record<string, unknown>;
};

function decimal(value: string, field: string, options?: { signed?: boolean; zero?: boolean }) {
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    throw financeBadRequest(`${field} must be a decimal`, "FINANCE_DOCUMENT_AMOUNT_INVALID");
  }
  if (!parsed.isFinite() || parsed.decimalPlaces() > 4) {
    throw financeBadRequest(
      `${field} must have at most four decimal places`,
      "FINANCE_DOCUMENT_AMOUNT_INVALID",
    );
  }
  if (!options?.signed && parsed.isNegative()) {
    throw financeBadRequest(`${field} cannot be negative`, "FINANCE_DOCUMENT_AMOUNT_INVALID");
  }
  if (!options?.zero && parsed.isZero()) {
    throw financeBadRequest(`${field} must be non-zero`, "FINANCE_DOCUMENT_AMOUNT_INVALID");
  }
  return parsed;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

export function authoritativeDocumentHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function prepareProviderSettlement(input: {
  providerConfigId: string;
  providerCode: string;
  environment: string;
  externalReference?: string | null;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  fxRate: string;
  fxRateAsOf?: Date | null;
  reportedNetAmount?: string | null;
  metadata?: Record<string, unknown>;
  lines: ProviderSettlementLineInput[];
}) {
  if (input.periodStart > input.periodEnd) {
    throw financeBadRequest(
      "Settlement period start must be on or before period end",
      "FINANCE_SETTLEMENT_DATE_RANGE_INVALID",
    );
  }
  if (input.lines.length === 0) {
    throw financeBadRequest(
      "Provider settlement requires at least one line",
      "FINANCE_SETTLEMENT_LINES_EMPTY",
    );
  }
  const currency = assertFinanceCurrency(input.currency);
  const fxRate = decimal(input.fxRate, "fxRate").toFixed(10);
  const lines = input.lines.map((line, index) => ({
    ...line,
    sequence: index + 1,
    reconciliationStatus: line.reconciliationStatus ??
      (line.type === "fee" || line.type === "adjustment" ? "ignored" : "unmatched"),
    reconciliationMessage: line.reconciliationMessage ?? null,
    amount: decimal(line.amount, `lines.${index}.amount`, {
      signed: line.type === "adjustment",
    }).toFixed(4),
  }));
  const sum = (type: ProviderSettlementLineInput["type"]) => lines
    .filter((line) => line.type === type)
    .reduce((total, line) => total.plus(line.amount), new Decimal(0));
  const grossAmount = sum("payment");
  const refundAmount = sum("refund");
  const feeAmount = sum("fee");
  const adjustmentAmount = sum("adjustment");
  const netAmount = grossAmount.minus(refundAmount).minus(feeAmount).plus(adjustmentAmount);
  if (netAmount.isNegative()) {
    throw financeBadRequest(
      "Derived settlement net amount cannot be negative",
      "FINANCE_SETTLEMENT_TOTAL_INVALID",
    );
  }
  if (input.reportedNetAmount !== undefined && input.reportedNetAmount !== null) {
    const reported = decimal(input.reportedNetAmount, "reportedNetAmount", { zero: true });
    if (!reported.eq(netAmount)) {
      throw financeBadRequest(
        `Reported net amount ${reported.toFixed(4)} does not match derived ${netAmount.toFixed(4)}`,
        "FINANCE_SETTLEMENT_RECONCILIATION_MISMATCH",
      );
    }
  }
  const prepared = {
    providerConfigId: input.providerConfigId,
    providerCode: input.providerCode,
    environment: input.environment,
    externalReference: input.externalReference ?? null,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    currency,
    fxRate,
    fxRateAsOf: input.fxRateAsOf ?? null,
    grossAmount: grossAmount.toFixed(4),
    refundAmount: refundAmount.toFixed(4),
    feeAmount: feeAmount.toFixed(4),
    adjustmentAmount: adjustmentAmount.toFixed(4),
    netAmount: netAmount.toFixed(4),
    metadata: input.metadata,
    lines,
  };
  return { ...prepared, payloadHash: authoritativeDocumentHash(prepared) };
}

export function prepareCarrierBill(input: {
  carrierProviderId: string;
  carrierCode: string;
  supplierInvoiceNumber: string;
  invoiceDate: Date;
  dueDate?: Date | null;
  currency: string;
  fxRate: string;
  fxRateAsOf?: Date | null;
  reportedTotalAmount?: string | null;
  metadata?: Record<string, unknown>;
  lines: CarrierBillLineInput[];
}) {
  if (input.dueDate && input.dueDate < input.invoiceDate) {
    throw financeBadRequest(
      "Carrier bill due date cannot precede invoice date",
      "FINANCE_CARRIER_BILL_DATE_RANGE_INVALID",
    );
  }
  if (input.lines.length === 0) {
    throw financeBadRequest(
      "Carrier bill requires at least one line",
      "FINANCE_CARRIER_BILL_LINES_EMPTY",
    );
  }
  const currency = assertFinanceCurrency(input.currency);
  const fxRate = decimal(input.fxRate, "fxRate").toFixed(10);
  const lines = input.lines.map((line, index) => {
    const quantity = decimal(line.quantity, `lines.${index}.quantity`);
    const unitPrice = decimal(line.unitPrice, `lines.${index}.unitPrice`, { zero: true });
    const taxAmount = decimal(line.taxAmount, `lines.${index}.taxAmount`, { zero: true });
    return {
      ...line,
      sequence: index + 1,
      quantity: quantity.toFixed(4),
      unitPrice: unitPrice.toFixed(4),
      amount: quantity.mul(unitPrice).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
      taxAmount: taxAmount.toFixed(4),
    };
  });
  const subtotalAmount = lines.reduce(
    (total, line) => total.plus(line.amount),
    new Decimal(0),
  );
  const taxAmount = lines.reduce(
    (total, line) => total.plus(line.taxAmount),
    new Decimal(0),
  );
  const totalAmount = subtotalAmount.plus(taxAmount);
  if (totalAmount.lte(0)) {
    throw financeBadRequest(
      "Carrier bill total must be positive",
      "FINANCE_CARRIER_BILL_TOTAL_INVALID",
    );
  }
  if (input.reportedTotalAmount !== undefined && input.reportedTotalAmount !== null) {
    const reported = decimal(input.reportedTotalAmount, "reportedTotalAmount");
    if (!reported.eq(totalAmount)) {
      throw financeBadRequest(
        `Reported total ${reported.toFixed(4)} does not match derived ${totalAmount.toFixed(4)}`,
        "FINANCE_CARRIER_BILL_RECONCILIATION_MISMATCH",
      );
    }
  }
  const prepared = {
    carrierProviderId: input.carrierProviderId,
    carrierCode: input.carrierCode,
    supplierInvoiceNumber: input.supplierInvoiceNumber,
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate ?? null,
    currency,
    fxRate,
    fxRateAsOf: input.fxRateAsOf ?? null,
    subtotalAmount: subtotalAmount.toFixed(4),
    taxAmount: taxAmount.toFixed(4),
    totalAmount: totalAmount.toFixed(4),
    metadata: input.metadata,
    lines,
  };
  return { ...prepared, payloadHash: authoritativeDocumentHash(prepared) };
}
