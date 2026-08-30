import { Prisma } from "@prisma/client";
import type { CanonicalFinanceSourceEvent } from "../domain/source-event";
import { financeConflict } from "../domain/finance.errors";
import { openItemStatus } from "../domain/subledger";

type Tx = Prisma.TransactionClient;

function json(value: Record<string, unknown>) {
  return value as Prisma.InputJsonValue;
}

function eventAmount(event: CanonicalFinanceSourceEvent, key: keyof CanonicalFinanceSourceEvent["amounts"]) {
  const value = event.amounts[key];
  if (!value) {
    throw financeConflict(`Subledger projection requires amount ${key}`, "FINANCE_SUBLEDGER_AMOUNT_MISSING");
  }
  return new Prisma.Decimal(value);
}

function requiredOrderId(event: CanonicalFinanceSourceEvent) {
  if (!event.dimensions.orderId) {
    throw financeConflict("Subledger event requires orderId", "FINANCE_SUBLEDGER_ORDER_REQUIRED");
  }
  return event.dimensions.orderId;
}

function metadataString(event: CanonicalFinanceSourceEvent, key: string) {
  const value = event.metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function attributeString(event: CanonicalFinanceSourceEvent, key: string) {
  const value = event.attributes[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function applyReceiptToReceivables(
  tx: Tx,
  legalEntityId: string,
  event: CanonicalFinanceSourceEvent,
  amount: Prisma.Decimal,
) {
  const orderId = requiredOrderId(event);
  let remaining = amount;
  let customerEntityId = event.dimensions.customerEntityId ?? null;
  const receivables = await tx.financeReceivableItem.findMany({
    where: {
      legalEntityId,
      orderId,
      currency: event.currency,
      outstandingAmount: { gt: 0 },
    },
    orderBy: [{ dueDate: "asc" }, { documentDate: "asc" }, { id: "asc" }],
  });
  for (const receivable of receivables) {
    if (remaining.lte(0)) break;
    customerEntityId ??= receivable.customerEntityId;
    const allocated = Prisma.Decimal.min(remaining, receivable.outstandingAmount);
    const outstanding = receivable.outstandingAmount.minus(allocated);
    await tx.financeReceivableAllocation.create({
      data: {
        receivableId: receivable.id,
        sourceEventId: event.sourceEventId,
        type: "payment",
        amount: allocated,
        currency: event.currency,
        paymentIntentId: event.sourceId,
        occurredAt: event.occurredAt,
        metadataJson: json(event.metadata),
      },
    });
    await tx.financeReceivableItem.update({
      where: { id: receivable.id },
      data: {
        outstandingAmount: outstanding,
        status: openItemStatus(receivable.originalAmount.toString(), outstanding.toString()),
      },
    });
    remaining = remaining.minus(allocated);
  }
  if (remaining.gt(0)) {
    await tx.financeUnappliedCash.create({
      data: {
        legalEntityId,
        sourceEventId: event.sourceEventId,
        type: "receipt",
        orderId,
        customerEntityId,
        currency: event.currency,
        originalAmount: remaining,
        remainingAmount: remaining,
        occurredAt: event.occurredAt,
        metadataJson: json({ ...event.metadata, paymentIntentId: event.sourceId }),
      },
    });
  }
}

async function consumeUnappliedReceipts(
  tx: Tx,
  legalEntityId: string,
  receivable: {
    id: string;
    orderId: string;
    customerEntityId: string | null;
    currency: string;
    originalAmount: Prisma.Decimal;
    outstandingAmount: Prisma.Decimal;
  },
  occurredAt: Date,
) {
  let outstanding = receivable.outstandingAmount;
  const receipts = await tx.financeUnappliedCash.findMany({
    where: {
      legalEntityId,
      orderId: receivable.orderId,
      currency: receivable.currency,
      type: "receipt",
      status: "open",
      remainingAmount: { gt: 0 },
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  for (const receipt of receipts) {
    if (outstanding.lte(0)) break;
    const allocated = Prisma.Decimal.min(outstanding, receipt.remainingAmount);
    const receiptRemaining = receipt.remainingAmount.minus(allocated);
    outstanding = outstanding.minus(allocated);
    await tx.financeReceivableAllocation.create({
      data: {
        receivableId: receivable.id,
        sourceEventId: receipt.sourceEventId,
        type: "unapplied_receipt",
        amount: allocated,
        currency: receivable.currency,
        paymentIntentId: typeof (receipt.metadataJson as Record<string, unknown> | null)?.paymentIntentId === "string"
          ? String((receipt.metadataJson as Record<string, unknown>).paymentIntentId)
          : null,
        occurredAt,
        metadataJson: json({ unappliedCashId: receipt.id }),
      },
    });
    await tx.financeUnappliedCashApplication.create({
      data: {
        unappliedCashId: receipt.id,
        receivableId: receivable.id,
        idempotencyKey: `${receipt.id}:receivable:${receivable.id}`,
        sourceEventId: receipt.sourceEventId,
        type: "receivable",
        amount: allocated,
        currency: receivable.currency,
        occurredAt,
        metadataJson: json({ receivableId: receivable.id }),
      },
    });
    await tx.financeUnappliedCash.update({
      where: { id: receipt.id },
      data: {
        remainingAmount: receiptRemaining,
        status: receiptRemaining.lte(0) ? "applied" : "open",
        customerEntityId: receipt.customerEntityId ?? receivable.customerEntityId,
      },
    });
  }
  if (!outstanding.equals(receivable.outstandingAmount)) {
    await tx.financeReceivableItem.update({
      where: { id: receivable.id },
      data: {
        outstandingAmount: outstanding,
        status: openItemStatus(receivable.originalAmount.toString(), outstanding.toString()),
      },
    });
  }
}

async function projectInvoice(tx: Tx, legalEntityId: string, event: CanonicalFinanceSourceEvent) {
  const orderId = requiredOrderId(event);
  const amount = eventAmount(event, "gross_amount");
  const dueAt = metadataString(event, "dueAt");
  const dueDate = dueAt ? new Date(dueAt) : event.documentDate;
  const receivable = await tx.financeReceivableItem.create({
    data: {
      legalEntityId,
      sourceEventId: event.sourceEventId,
      sourceInvoiceId: event.sourceId,
      invoiceNumber: metadataString(event, "invoiceNumber") ?? event.sourceId,
      orderId,
      customerEntityId: event.dimensions.customerEntityId ?? null,
      documentDate: event.documentDate,
      dueDate,
      currency: event.currency,
      originalAmount: amount,
      outstandingAmount: amount,
      metadataJson: json(event.metadata),
    },
  });
  await consumeUnappliedReceipts(tx, legalEntityId, receivable, event.occurredAt);
}

async function projectRefund(tx: Tx, legalEntityId: string, event: CanonicalFinanceSourceEvent) {
  const orderId = requiredOrderId(event);
  let remaining = eventAmount(event, "refund_amount");
  const receipts = await tx.financeUnappliedCash.findMany({
    where: {
      legalEntityId,
      orderId,
      currency: event.currency,
      type: "receipt",
      status: "open",
      remainingAmount: { gt: 0 },
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
  for (const receipt of receipts) {
    if (remaining.lte(0)) break;
    const consumed = Prisma.Decimal.min(remaining, receipt.remainingAmount);
    const receiptRemaining = receipt.remainingAmount.minus(consumed);
    await tx.financeUnappliedCash.update({
      where: { id: receipt.id },
      data: {
        remainingAmount: receiptRemaining,
        status: receiptRemaining.lte(0) ? "applied" : "open",
      },
    });
    await tx.financeUnappliedCashApplication.create({
      data: {
        unappliedCashId: receipt.id,
        idempotencyKey: `${receipt.id}:refund:${event.sourceEventId}`,
        sourceEventId: event.sourceEventId,
        type: "refund",
        amount: consumed,
        currency: event.currency,
        occurredAt: event.occurredAt,
        metadataJson: json({ paymentRefundId: event.sourceId }),
      },
    });
    remaining = remaining.minus(consumed);
  }
  const receivables = await tx.financeReceivableItem.findMany({
    where: {
      legalEntityId,
      orderId,
      currency: event.currency,
    },
    orderBy: [{ documentDate: "desc" }, { id: "desc" }],
  });
  for (const receivable of receivables) {
    if (remaining.lte(0)) break;
    const reopenCapacity = receivable.originalAmount.minus(receivable.outstandingAmount);
    if (reopenCapacity.lte(0)) continue;
    const reopened = Prisma.Decimal.min(remaining, reopenCapacity);
    const outstanding = receivable.outstandingAmount.plus(reopened);
    await tx.financeReceivableAllocation.create({
      data: {
        receivableId: receivable.id,
        sourceEventId: event.sourceEventId,
        type: "refund",
        amount: reopened,
        currency: event.currency,
        paymentRefundId: event.sourceId,
        occurredAt: event.occurredAt,
        metadataJson: json(event.metadata),
      },
    });
    await tx.financeReceivableItem.update({
      where: { id: receivable.id },
      data: {
        outstandingAmount: outstanding,
        status: openItemStatus(receivable.originalAmount.toString(), outstanding.toString()),
      },
    });
    remaining = remaining.minus(reopened);
  }
  if (remaining.gt(0)) {
    await tx.financeUnappliedCash.create({
      data: {
        legalEntityId,
        sourceEventId: event.sourceEventId,
        type: "refund",
        orderId,
        customerEntityId: event.dimensions.customerEntityId ?? null,
        currency: event.currency,
        originalAmount: remaining,
        remainingAmount: remaining,
        occurredAt: event.occurredAt,
        metadataJson: json({ ...event.metadata, paymentRefundId: event.sourceId }),
      },
    });
  }
}

async function projectCarrierBill(tx: Tx, legalEntityId: string, event: CanonicalFinanceSourceEvent) {
  const carrierProviderId = event.dimensions.carrierProviderId;
  if (!carrierProviderId) {
    throw financeConflict("Carrier payable requires carrierProviderId", "FINANCE_SUBLEDGER_CARRIER_REQUIRED");
  }
  const amount = eventAmount(event, "carrier_cost");
  const dueAt = metadataString(event, "dueDate");
  await tx.financePayableItem.create({
    data: {
      legalEntityId,
      sourceEventId: event.sourceEventId,
      sourceCarrierBillId: event.sourceId,
      billNumber: attributeString(event, "billNumber") ?? event.sourceId,
      supplierInvoiceNumber: attributeString(event, "supplierInvoiceNumber") ?? event.sourceId,
      carrierProviderId,
      carrierCode: attributeString(event, "carrierCode") ?? "unknown",
      documentDate: event.documentDate,
      dueDate: dueAt ? new Date(dueAt) : event.documentDate,
      currency: event.currency,
      originalAmount: amount,
      outstandingAmount: amount,
      metadataJson: json(event.metadata),
    },
  });
}

async function projectPayablePayment(tx: Tx, legalEntityId: string, event: CanonicalFinanceSourceEvent) {
  const payableItemId = metadataString(event, "payableItemId");
  const paymentRunLineId = metadataString(event, "paymentRunLineId");
  if (!payableItemId || !paymentRunLineId) {
    throw financeConflict(
      "Payable payment requires payableItemId and paymentRunLineId",
      "FINANCE_PAYABLE_ALLOCATION_REFERENCE_REQUIRED",
    );
  }
  const [payable, runLine] = await Promise.all([
    tx.financePayableItem.findFirst({ where: { id: payableItemId, legalEntityId } }),
    tx.financePaymentRunLine.findFirst({
      where: {
        id: paymentRunLineId,
        payableItemId,
        accountingSourceEventId: event.sourceEventId,
        status: "executed",
      },
    }),
  ]);
  if (!payable || !runLine) {
    throw financeConflict(
      "Executed payment-run line does not match the payable",
      "FINANCE_PAYABLE_ALLOCATION_REFERENCE_INVALID",
    );
  }
  const amount = eventAmount(event, "payable_amount");
  if (payable.currency !== event.currency || !runLine.amount.equals(amount)) {
    throw financeConflict(
      "Payable allocation amount or currency does not match the payment run",
      "FINANCE_PAYABLE_ALLOCATION_MISMATCH",
    );
  }
  if (amount.gt(payable.outstandingAmount)) {
    throw financeConflict(
      "Payable allocation exceeds outstanding balance",
      "FINANCE_PAYABLE_ALLOCATION_OVERFLOW",
    );
  }
  const outstanding = payable.outstandingAmount.minus(amount);
  await tx.financePayableAllocation.create({
    data: {
      payableItemId: payable.id,
      paymentRunLineId: runLine.id,
      sourceEventId: event.sourceEventId,
      amount,
      currency: event.currency,
      occurredAt: event.occurredAt,
      metadataJson: json(event.metadata),
    },
  });
  await Promise.all([
    tx.financePayableItem.update({
      where: { id: payable.id },
      data: {
        outstandingAmount: outstanding,
        status: openItemStatus(payable.originalAmount.toString(), outstanding.toString()),
      },
    }),
    tx.financePaymentRunLine.update({
      where: { id: runLine.id },
      data: { status: "allocated" },
    }),
  ]);
}

export async function projectFinanceSubledgerEvent(
  tx: Tx,
  legalEntityId: string,
  event: CanonicalFinanceSourceEvent,
) {
  const orderId = event.dimensions.orderId;
  const payableItemId = metadataString(event, "payableItemId");
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`${legalEntityId}:subledger:${orderId ?? payableItemId ?? event.sourceId}`}, 0))
  `);
  if (event.eventType === "invoice.issued") return projectInvoice(tx, legalEntityId, event);
  if (event.eventType === "payment.succeeded") {
    return applyReceiptToReceivables(tx, legalEntityId, event, eventAmount(event, "gross_amount"));
  }
  if (event.eventType === "payment.refunded") return projectRefund(tx, legalEntityId, event);
  if (event.eventType === "carrier.bill_approved") return projectCarrierBill(tx, legalEntityId, event);
  if (event.eventType === "payable.payment_executed") return projectPayablePayment(tx, legalEntityId, event);
}
