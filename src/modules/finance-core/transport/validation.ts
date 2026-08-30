import { z } from "zod";
import { FINANCE_CURRENCIES } from "../domain/ledger";
import { FINANCE_AMOUNT_KEYS } from "../domain/posting-rules";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const decimal = z.string().regex(/^\d+(\.\d{1,10})?$/, "Expected a non-negative decimal string");
const signedDecimal = z.string().regex(/^-?\d+(\.\d{1,4})?$/, "Expected a decimal string");
const metadata = z.record(z.string(), z.unknown());

export const cursorPageSchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const sourceEventPageSchema = cursorPageSchema.extend({
  status: z.enum(["pending", "processing", "posted", "exception"]).optional(),
});

export const receivablesAgingQuerySchema = cursorPageSchema.extend({
  asOf: date,
  currency: z.enum(FINANCE_CURRENCIES).optional(),
  customerEntityId: uuid.optional(),
});

export const payablesAgingQuerySchema = cursorPageSchema.extend({
  asOf: date,
  currency: z.enum(FINANCE_CURRENCIES).optional(),
  carrierProviderId: uuid.optional(),
});

export const unappliedCashQuerySchema = cursorPageSchema.extend({
  currency: z.enum(FINANCE_CURRENCIES).optional(),
  customerEntityId: uuid.optional(),
  type: z.enum(["receipt", "refund"]).optional(),
  status: z.enum(["open", "applied"]).default("open"),
});

export const financeIdParamSchema = z.object({ id: uuid });

export const configureLegalEntitySchema = z.object({
  baseCurrency: z.enum(FINANCE_CURRENCIES),
  reportingCurrency: z.enum(FINANCE_CURRENCIES).nullable().optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
  timezone: z.string().trim().min(1).max(100).default("Asia/Tashkent"),
});

export const createAccountSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  type: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
  parentId: uuid.nullable().optional(),
  allowPosting: z.boolean().default(true),
  isControlAccount: z.boolean().default(false),
  currency: z.enum(FINANCE_CURRENCIES).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  metadata: metadata.optional(),
});

export const bootstrapChartSchema = z.object({
  templateCode: z.literal("logistics_standard"),
  templateVersion: z.literal(1),
});

const postingRuleLineSchema = z.object({
  side: z.enum(["debit", "credit"]),
  accountId: uuid,
  amountKey: z.enum(FINANCE_AMOUNT_KEYS),
  descriptionTemplate: z.string().trim().max(500).nullable().optional(),
  dimensions: metadata.optional(),
});

export const createPostingRuleSchema = z.object({
  code: z.string().trim().min(2).max(100).regex(/^[a-z0-9_.-]+$/),
  name: z.string().trim().min(2).max(200),
  sourceType: z.enum(["invoice", "payment", "refund", "cash_custody", "carrier_cost", "payable"]),
  eventType: z.enum([
    "invoice.issued",
    "invoice.credit_note_issued",
    "payment.succeeded",
    "payment.provider_fee_recorded",
    "payment.refunded",
    "cash.collected",
    "cash.handed_off",
    "cash.settled",
    "carrier.cost_accrued",
    "carrier.bill_approved",
    "payable.payment_executed",
  ]),
  priority: z.number().int().min(0).max(1_000_000).default(100),
  conditions: metadata.optional(),
  validFrom: z.string().datetime().nullable().optional(),
  validTo: z.string().datetime().nullable().optional(),
  lines: z.array(postingRuleLineSchema).min(2).max(50),
});

export const changePostingRuleStatusSchema = z.object({
  status: z.enum(["active", "inactive"]),
});

export const createPeriodSchema = z.object({
  fiscalYear: z.number().int().min(2000).max(2200),
  periodNumber: z.number().int().min(1).max(53),
  name: z.string().trim().min(1).max(100),
  startDate: date,
  endDate: date,
});

export const changePeriodStatusSchema = z.object({
  status: z.enum(["open", "restricted", "closed"]),
});

const journalLineSchema = z.object({
  accountId: uuid,
  debitAmount: decimal.default("0"),
  creditAmount: decimal.default("0"),
  description: z.string().trim().max(1000).optional(),
  orderId: uuid.optional(),
  orderLegId: uuid.optional(),
  customerEntityId: uuid.optional(),
  branchId: uuid.optional(),
  warehouseId: uuid.optional(),
  carrierProviderId: uuid.optional(),
  costCenterCode: z.string().trim().max(100).optional(),
  profitCenterCode: z.string().trim().max(100).optional(),
  metadata: metadata.optional(),
});

export const createJournalSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  documentDate: date,
  postingDate: date,
  currency: z.enum(FINANCE_CURRENCIES),
  fxRate: decimal,
  fxRateAsOf: z.string().datetime().nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  sourceType: z.string().trim().max(100).nullable().optional(),
  sourceId: z.string().trim().max(200).nullable().optional(),
  sourceEventId: z.string().trim().max(200).nullable().optional(),
  metadata: metadata.optional(),
  lines: z.array(journalLineSchema).min(2).max(500),
});

export const reverseJournalSchema = z.object({
  postingDate: date,
  reason: z.string().trim().min(3).max(1000),
  idempotencyKey: z.string().trim().min(8).max(200),
});

export const trialBalanceQuerySchema = z.object({
  from: date,
  to: date,
});

export const financeDocumentPageSchema = cursorPageSchema.extend({
  status: z.enum(["draft", "submitted", "approved", "rejected", "cancelled"]).optional(),
});

export const createProviderSettlementSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  providerConfigId: uuid,
  externalReference: z.string().trim().max(200).nullable().optional(),
  periodStart: date,
  periodEnd: date,
  currency: z.enum(FINANCE_CURRENCIES),
  fxRate: decimal,
  fxRateAsOf: z.string().datetime().nullable().optional(),
  reportedNetAmount: decimal.nullable().optional(),
  metadata: metadata.optional(),
  lines: z.array(z.object({
    type: z.enum(["payment", "refund", "fee", "adjustment"]),
    amount: signedDecimal,
    externalTransactionId: z.string().trim().max(200).nullable().optional(),
    paymentIntentId: uuid.nullable().optional(),
    paymentRefundId: uuid.nullable().optional(),
    orderId: uuid.nullable().optional(),
    occurredAt: z.string().datetime().nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    metadata: metadata.optional(),
  })).min(1).max(5000),
});

export const createCarrierBillSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  carrierProviderId: uuid,
  supplierInvoiceNumber: z.string().trim().min(1).max(200),
  invoiceDate: date,
  dueDate: date.nullable().optional(),
  currency: z.enum(FINANCE_CURRENCIES),
  fxRate: decimal,
  fxRateAsOf: z.string().datetime().nullable().optional(),
  reportedTotalAmount: decimal.nullable().optional(),
  metadata: metadata.optional(),
  lines: z.array(z.object({
    orderId: uuid,
    orderLegId: uuid,
    description: z.string().trim().min(1).max(1000),
    quantity: decimal.default("1"),
    unitPrice: decimal,
    taxAmount: decimal.default("0"),
    metadata: metadata.optional(),
  })).min(1).max(1000),
});

export const rejectFinanceDocumentSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
});

export const reconcileSettlementLineSchema = z.object({
  paymentIntentId: uuid.nullable().optional(),
  paymentRefundId: uuid.nullable().optional(),
}).superRefine((value, context) => {
  if (!value.paymentIntentId && !value.paymentRefundId) {
    context.addIssue({
      code: "custom",
      message: "paymentIntentId or paymentRefundId is required",
    });
  }
});

export const bankAccountPageSchema = cursorPageSchema.extend({
  status: z.enum(["active", "inactive"]).optional(),
});

export const createBankAccountSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  code: z.string().trim().min(2).max(50),
  name: z.string().trim().min(2).max(200),
  bankName: z.string().trim().min(2).max(200),
  accountIdentifier: z.string().trim().min(4).max(100),
  currency: z.enum(FINANCE_CURRENCIES),
  metadata: metadata.optional(),
});

export const changeBankAccountStatusSchema = z.object({
  isActive: z.boolean(),
});

export const paymentRunPageSchema = cursorPageSchema.extend({
  status: z.enum(["draft", "submitted", "approved", "rejected", "executed"]).optional(),
});

export const createPaymentRunSchema = z.object({
  bankAccountId: uuid,
  idempotencyKey: z.string().trim().min(8).max(200),
  paymentDate: date,
  currency: z.enum(FINANCE_CURRENCIES),
  fxRate: decimal,
  fxRateAsOf: z.string().datetime().nullable().optional(),
  metadata: metadata.optional(),
  lines: z.array(z.object({
    payableItemId: uuid,
    amount: decimal,
  })).min(1).max(1000),
});

export const executePaymentRunSchema = z.object({
  bankReference: z.string().trim().min(1).max(200),
  executedAt: z.string().datetime(),
});

export const bankStatementPageSchema = cursorPageSchema.extend({
  status: z.enum(["draft", "submitted", "approved", "rejected"]).optional(),
});

export const createBankStatementSchema = z.object({
  bankAccountId: uuid,
  statementNumber: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(8).max(200),
  periodStart: date,
  periodEnd: date,
  currency: z.enum(FINANCE_CURRENCIES),
  openingBalance: signedDecimal,
  reportedClosingBalance: signedDecimal,
  metadata: metadata.optional(),
  lines: z.array(z.object({
    bookingDate: date,
    valueDate: date.nullable().optional(),
    direction: z.enum(["debit", "credit"]),
    amount: decimal,
    externalTransactionId: z.string().trim().max(200).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    metadata: metadata.optional(),
  })).min(1).max(10_000),
});

export const reconcileBankStatementLineSchema = z.object({
  targetType: z.enum(["payment_run", "provider_settlement"]),
  targetId: uuid,
});

export const financeReasonSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
});

export function toDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}
