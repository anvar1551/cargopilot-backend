import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type {
  FinanceDocumentPage,
  FinanceDocumentsRepositoryPort,
} from "../application/finance-documents.port";
import { financeConflict, financeNotFound } from "../domain/finance.errors";
import { createFinanceSourceEvent } from "./finance-source-event.store";

type Tx = Prisma.TransactionClient;

const settlementInclude = {
  lines: { orderBy: { sequence: "asc" as const } },
} satisfies Prisma.FinanceProviderSettlementInclude;

const settlementListInclude = {
  _count: { select: { lines: true } },
} satisfies Prisma.FinanceProviderSettlementInclude;

const carrierBillInclude = {
  lines: { orderBy: { sequence: "asc" as const } },
} satisfies Prisma.FinanceCarrierBillInclude;

function json(value: Record<string, unknown> | undefined) {
  return value ? value as Prisma.InputJsonValue : undefined;
}

function pageResult<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    pageInfo: {
      hasMore,
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
    },
  };
}

async function requireEntity(tx: Tx, companyId: string) {
  const entity = await tx.financeLegalEntity.findUnique({ where: { companyId } });
  if (!entity || !entity.isActive) {
    throw financeNotFound(
      "Finance legal entity is not configured for this company",
      "FINANCE_ENTITY_NOT_CONFIGURED",
    );
  }
  return entity;
}

async function allocateNumber(tx: Tx, legalEntityId: string, key: string, prefix: string) {
  const sequence = await tx.financeNumberSequence.upsert({
    where: { legalEntityId_key: { legalEntityId, key } },
    create: { legalEntityId, key, prefix, nextValue: 2n, padding: 8 },
    update: { nextValue: { increment: 1 } },
  });
  return `${sequence.prefix}${(sequence.nextValue - 1n).toString().padStart(sequence.padding, "0")}`;
}

async function lockDocumentKey(tx: Tx, value: string) {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${value}, 0))`);
}

function assertFxSnapshot(entity: { baseCurrency: string }, input: {
  currency: string;
  fxRateAsOf: Date | null;
}) {
  if (input.currency !== entity.baseCurrency && !input.fxRateAsOf) {
    throw financeConflict(
      "Foreign-currency finance documents require fxRateAsOf",
      "FINANCE_FX_SNAPSHOT_REQUIRED",
    );
  }
}

export class PrismaFinanceDocumentsRepository implements FinanceDocumentsRepositoryPort {
  async createProviderSettlement(command: Parameters<FinanceDocumentsRepositoryPort["createProviderSettlement"]>[0]) {
    return prisma.$transaction(async (tx) => {
      const entity = await requireEntity(tx, command.companyId);
      assertFxSnapshot(entity, command.settlement);
      await lockDocumentKey(tx, `${entity.id}:provider-settlement:${command.idempotencyKey}`);
      const existing = await tx.financeProviderSettlement.findUnique({
        where: {
          legalEntityId_idempotencyKey: {
            legalEntityId: entity.id,
            idempotencyKey: command.idempotencyKey,
          },
        },
        include: settlementInclude,
      });
      if (existing) {
        if (existing.payloadHash !== command.settlement.payloadHash) {
          throw financeConflict(
            "Settlement idempotency key was used with different contents",
            "FINANCE_IDEMPOTENCY_CONFLICT",
          );
        }
        return existing;
      }
      const settlementNumber = await allocateNumber(tx, entity.id, "provider_settlement", "PSET-");
      const settlement = await tx.financeProviderSettlement.create({
        data: {
          legalEntityId: entity.id,
          settlementNumber,
          providerConfigId: command.settlement.providerConfigId,
          providerCode: command.settlement.providerCode,
          environment: command.settlement.environment,
          externalReference: command.settlement.externalReference,
          periodStart: command.settlement.periodStart,
          periodEnd: command.settlement.periodEnd,
          currency: command.settlement.currency,
          grossAmount: command.settlement.grossAmount,
          refundAmount: command.settlement.refundAmount,
          feeAmount: command.settlement.feeAmount,
          adjustmentAmount: command.settlement.adjustmentAmount,
          netAmount: command.settlement.netAmount,
          fxRate: command.settlement.fxRate,
          fxRateAsOf: command.settlement.fxRateAsOf,
          idempotencyKey: command.idempotencyKey,
          payloadHash: command.settlement.payloadHash,
          metadataJson: json(command.settlement.metadata),
          createdByUserId: command.actorUserId,
          lines: {
            create: command.settlement.lines.map((line) => ({
              sequence: line.sequence,
              type: line.type,
              reconciliationStatus: line.reconciliationStatus,
              reconciliationMessage: line.reconciliationMessage,
              amount: line.amount,
              externalTransactionId: line.externalTransactionId,
              paymentIntentId: line.paymentIntentId,
              paymentRefundId: line.paymentRefundId,
              orderId: line.orderId,
              occurredAt: line.occurredAt,
              description: line.description,
              metadataJson: json(line.metadata),
            })),
          },
        },
        include: settlementInclude,
      });
      await tx.financeAuditEvent.create({
        data: {
          legalEntityId: entity.id,
          action: "finance.provider_settlement.created",
          actorUserId: command.actorUserId,
          detailsJson: { settlementId: settlement.id, settlementNumber },
        },
      });
      return settlement;
    });
  }

  async listProviderSettlements(companyId: string, page: FinanceDocumentPage) {
    const rows = await prisma.financeProviderSettlement.findMany({
      where: { legalEntity: { companyId }, ...(page.status ? { status: page.status } : {}) },
      orderBy: [{ periodEnd: "desc" }, { id: "desc" }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      include: settlementListInclude,
    });
    return pageResult(rows, page.limit);
  }

  async getProviderSettlement(companyId: string, settlementId: string) {
    const row = await prisma.financeProviderSettlement.findFirst({
      where: { id: settlementId, legalEntity: { companyId } },
      include: settlementInclude,
    });
    if (!row) throw financeNotFound("Provider settlement not found", "FINANCE_SETTLEMENT_NOT_FOUND");
    return row;
  }

  async submitProviderSettlement(companyId: string, settlementId: string, actorUserId: string) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.financeProviderSettlement.findFirst({
        where: { id: settlementId, legalEntity: { companyId } },
      });
      if (!row) throw financeNotFound("Provider settlement not found", "FINANCE_SETTLEMENT_NOT_FOUND");
      if (row.status !== "draft") {
        throw financeConflict("Only draft settlements can be submitted", "FINANCE_WORKFLOW_STATE_INVALID");
      }
      const updated = await tx.financeProviderSettlement.update({
        where: { id: row.id },
        data: { status: "submitted", submittedByUserId: actorUserId, submittedAt: new Date() },
        include: settlementInclude,
      });
      await tx.financeAuditEvent.create({
        data: {
          legalEntityId: row.legalEntityId,
          action: "finance.provider_settlement.submitted",
          actorUserId,
          detailsJson: { settlementId: row.id },
        },
      });
      return updated;
    });
  }

  async reconcileProviderSettlementLine(
    command: Parameters<FinanceDocumentsRepositoryPort["reconcileProviderSettlementLine"]>[0],
  ) {
    return prisma.$transaction(async (tx) => {
      const settlement = await tx.financeProviderSettlement.findFirst({
        where: {
          id: command.settlementId,
          legalEntity: { companyId: command.companyId },
          status: { in: ["draft", "submitted"] },
        },
      });
      if (!settlement) {
        throw financeConflict(
          "Settlement is not available for reconciliation",
          "FINANCE_WORKFLOW_STATE_INVALID",
        );
      }
      const line = await tx.financeProviderSettlementLine.findFirst({
        where: { id: command.lineId, settlementId: settlement.id },
      });
      if (!line) {
        throw financeNotFound(
          "Provider settlement line not found",
          "FINANCE_SETTLEMENT_LINE_NOT_FOUND",
        );
      }
      const updated = await tx.financeProviderSettlementLine.update({
        where: { id: line.id },
        data: {
          reconciliationStatus: command.resolvedLine.reconciliationStatus,
          reconciliationMessage: command.resolvedLine.reconciliationMessage,
          paymentIntentId: command.resolvedLine.paymentIntentId,
          paymentRefundId: command.resolvedLine.paymentRefundId,
          orderId: command.resolvedLine.orderId,
        },
      });
      await tx.financeAuditEvent.create({
        data: {
          legalEntityId: settlement.legalEntityId,
          action: "finance.provider_settlement.line_reconciled",
          actorUserId: command.actorUserId,
          detailsJson: {
            settlementId: settlement.id,
            lineId: line.id,
            previousStatus: line.reconciliationStatus,
            nextStatus: updated.reconciliationStatus,
            paymentIntentId: updated.paymentIntentId,
            paymentRefundId: updated.paymentRefundId,
          },
        },
      });
      return updated;
    });
  }

  async approveProviderSettlement(companyId: string, settlementId: string, actorUserId: string) {
    return prisma.$transaction(async (tx) => {
      await lockDocumentKey(tx, `provider-settlement-approval:${settlementId}`);
      const row = await tx.financeProviderSettlement.findFirst({
        where: { id: settlementId, legalEntity: { companyId } },
        include: { ...settlementInclude, legalEntity: true },
      });
      if (!row) throw financeNotFound("Provider settlement not found", "FINANCE_SETTLEMENT_NOT_FOUND");
      if (row.status === "approved") return row;
      if (row.status !== "submitted") {
        throw financeConflict("Only submitted settlements can be approved", "FINANCE_WORKFLOW_STATE_INVALID");
      }
      const unresolved = row.lines.find((line) =>
        (line.type === "payment" || line.type === "refund") &&
        line.reconciliationStatus !== "matched",
      );
      if (unresolved) {
        throw financeConflict(
          `Settlement line ${unresolved.sequence} is not reconciled`,
          "FINANCE_SETTLEMENT_UNRECONCILED",
        );
      }
      const now = new Date();
      const sourceEventId = row.feeAmount.gt(0)
        ? `provider_settlement:${row.id}:approved`
        : null;
      if (sourceEventId) {
        await createFinanceSourceEvent(tx, row.legalEntityId, {
          sourceEventId,
          companyId,
          sourceType: "payment",
          eventType: "payment.provider_fee_recorded",
          sourceId: row.id,
          actorUserId,
          occurredAt: now,
          documentDate: row.periodEnd,
          postingDate: row.periodEnd,
          currency: row.currency,
          fxRate: row.fxRate.toFixed(10),
          fxRateAsOf: row.fxRateAsOf,
          amounts: { fee_amount: row.feeAmount.toFixed(4) },
          dimensions: {},
          attributes: {
            provider: row.providerCode,
            environment: row.environment,
            settlementNumber: row.settlementNumber,
          },
          description: `Provider fees approved for settlement ${row.settlementNumber}`,
          metadata: {
            providerConfigId: row.providerConfigId,
            externalReference: row.externalReference,
            grossAmount: row.grossAmount.toFixed(4),
            refundAmount: row.refundAmount.toFixed(4),
            adjustmentAmount: row.adjustmentAmount.toFixed(4),
            netAmount: row.netAmount.toFixed(4),
          },
        });
      }
      const updated = await tx.financeProviderSettlement.update({
        where: { id: row.id },
        data: {
          status: "approved",
          approvedByUserId: actorUserId,
          approvedAt: now,
          accountingSourceEventId: sourceEventId,
        },
        include: settlementInclude,
      });
      await tx.financeAuditEvent.create({
        data: {
          legalEntityId: row.legalEntityId,
          action: "finance.provider_settlement.approved",
          actorUserId,
          detailsJson: { settlementId: row.id, sourceEventId },
        },
      });
      return updated;
    });
  }

  async rejectProviderSettlement(
    companyId: string,
    settlementId: string,
    actorUserId: string,
    reason: string,
  ) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.financeProviderSettlement.findFirst({
        where: { id: settlementId, legalEntity: { companyId } },
      });
      if (!row) throw financeNotFound("Provider settlement not found", "FINANCE_SETTLEMENT_NOT_FOUND");
      if (row.status !== "submitted") {
        throw financeConflict("Only submitted settlements can be rejected", "FINANCE_WORKFLOW_STATE_INVALID");
      }
      const updated = await tx.financeProviderSettlement.update({
        where: { id: row.id },
        data: {
          status: "rejected",
          rejectedByUserId: actorUserId,
          rejectedAt: new Date(),
          rejectionReason: reason,
        },
        include: settlementInclude,
      });
      await tx.financeAuditEvent.create({
        data: {
          legalEntityId: row.legalEntityId,
          action: "finance.provider_settlement.rejected",
          actorUserId,
          detailsJson: { settlementId: row.id, reason },
        },
      });
      return updated;
    });
  }

  async createCarrierBill(command: Parameters<FinanceDocumentsRepositoryPort["createCarrierBill"]>[0]) {
    return prisma.$transaction(async (tx) => {
      const entity = await requireEntity(tx, command.companyId);
      assertFxSnapshot(entity, command.bill);
      await lockDocumentKey(tx, `${entity.id}:carrier-bill:${command.idempotencyKey}`);
      const existing = await tx.financeCarrierBill.findUnique({
        where: {
          legalEntityId_idempotencyKey: {
            legalEntityId: entity.id,
            idempotencyKey: command.idempotencyKey,
          },
        },
        include: carrierBillInclude,
      });
      if (existing) {
        if (existing.payloadHash !== command.bill.payloadHash) {
          throw financeConflict(
            "Carrier bill idempotency key was used with different contents",
            "FINANCE_IDEMPOTENCY_CONFLICT",
          );
        }
        return existing;
      }
      const billNumber = await allocateNumber(tx, entity.id, "carrier_bill", "CBILL-");
      const bill = await tx.financeCarrierBill.create({
        data: {
          legalEntityId: entity.id,
          billNumber,
          carrierProviderId: command.bill.carrierProviderId,
          carrierCode: command.bill.carrierCode,
          supplierInvoiceNumber: command.bill.supplierInvoiceNumber,
          invoiceDate: command.bill.invoiceDate,
          dueDate: command.bill.dueDate,
          currency: command.bill.currency,
          subtotalAmount: command.bill.subtotalAmount,
          taxAmount: command.bill.taxAmount,
          totalAmount: command.bill.totalAmount,
          fxRate: command.bill.fxRate,
          fxRateAsOf: command.bill.fxRateAsOf,
          idempotencyKey: command.idempotencyKey,
          payloadHash: command.bill.payloadHash,
          metadataJson: json(command.bill.metadata),
          createdByUserId: command.actorUserId,
          lines: {
            create: command.bill.lines.map((line) => ({
              sequence: line.sequence,
              orderId: line.orderId,
              orderLegId: line.orderLegId,
              description: line.description,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              amount: line.amount,
              taxAmount: line.taxAmount,
              metadataJson: json(line.metadata),
            })),
          },
        },
        include: carrierBillInclude,
      });
      await tx.financeAuditEvent.create({
        data: {
          legalEntityId: entity.id,
          action: "finance.carrier_bill.created",
          actorUserId: command.actorUserId,
          detailsJson: { billId: bill.id, billNumber },
        },
      });
      return bill;
    });
  }

  async listCarrierBills(companyId: string, page: FinanceDocumentPage) {
    const rows = await prisma.financeCarrierBill.findMany({
      where: { legalEntity: { companyId }, ...(page.status ? { status: page.status } : {}) },
      orderBy: [{ invoiceDate: "desc" }, { id: "desc" }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      include: carrierBillInclude,
    });
    return pageResult(rows, page.limit);
  }

  async getCarrierBill(companyId: string, billId: string) {
    const row = await prisma.financeCarrierBill.findFirst({
      where: { id: billId, legalEntity: { companyId } },
      include: carrierBillInclude,
    });
    if (!row) throw financeNotFound("Carrier bill not found", "FINANCE_CARRIER_BILL_NOT_FOUND");
    return row;
  }

  async submitCarrierBill(companyId: string, billId: string, actorUserId: string) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.financeCarrierBill.findFirst({
        where: { id: billId, legalEntity: { companyId } },
      });
      if (!row) throw financeNotFound("Carrier bill not found", "FINANCE_CARRIER_BILL_NOT_FOUND");
      if (row.status !== "draft") {
        throw financeConflict("Only draft carrier bills can be submitted", "FINANCE_WORKFLOW_STATE_INVALID");
      }
      const updated = await tx.financeCarrierBill.update({
        where: { id: row.id },
        data: { status: "submitted", submittedByUserId: actorUserId, submittedAt: new Date() },
        include: carrierBillInclude,
      });
      await tx.financeAuditEvent.create({
        data: {
          legalEntityId: row.legalEntityId,
          action: "finance.carrier_bill.submitted",
          actorUserId,
          detailsJson: { billId: row.id },
        },
      });
      return updated;
    });
  }

  async approveCarrierBill(companyId: string, billId: string, actorUserId: string) {
    return prisma.$transaction(async (tx) => {
      await lockDocumentKey(tx, `carrier-bill-approval:${billId}`);
      const row = await tx.financeCarrierBill.findFirst({
        where: { id: billId, legalEntity: { companyId } },
        include: { ...carrierBillInclude, legalEntity: true },
      });
      if (!row) throw financeNotFound("Carrier bill not found", "FINANCE_CARRIER_BILL_NOT_FOUND");
      if (row.status === "approved") return row;
      if (row.status !== "submitted") {
        throw financeConflict("Only submitted carrier bills can be approved", "FINANCE_WORKFLOW_STATE_INVALID");
      }
      const now = new Date();
      const sourceEventId = `carrier_bill:${row.id}:approved`;
      await createFinanceSourceEvent(tx, row.legalEntityId, {
        sourceEventId,
        companyId,
        sourceType: "carrier_cost",
        eventType: "carrier.bill_approved",
        sourceId: row.id,
        actorUserId,
        occurredAt: now,
        documentDate: row.invoiceDate,
        postingDate: row.invoiceDate,
        currency: row.currency,
        fxRate: row.fxRate.toFixed(10),
        fxRateAsOf: row.fxRateAsOf,
        amounts: { carrier_cost: row.totalAmount.toFixed(4) },
        dimensions: { carrierProviderId: row.carrierProviderId },
        attributes: {
          carrierCode: row.carrierCode,
          billNumber: row.billNumber,
          supplierInvoiceNumber: row.supplierInvoiceNumber,
        },
        description: `Carrier bill ${row.billNumber} approved`,
        metadata: {
          subtotalAmount: row.subtotalAmount.toFixed(4),
          taxAmount: row.taxAmount.toFixed(4),
          lineCount: row.lines.length,
          orderLegIds: row.lines.map((line) => line.orderLegId),
          dueDate: row.dueDate?.toISOString() ?? null,
        },
      });
      const updated = await tx.financeCarrierBill.update({
        where: { id: row.id },
        data: {
          status: "approved",
          approvedByUserId: actorUserId,
          approvedAt: now,
          accountingSourceEventId: sourceEventId,
        },
        include: carrierBillInclude,
      });
      await tx.financeAuditEvent.create({
        data: {
          legalEntityId: row.legalEntityId,
          action: "finance.carrier_bill.approved",
          actorUserId,
          detailsJson: { billId: row.id, sourceEventId },
        },
      });
      return updated;
    });
  }

  async rejectCarrierBill(companyId: string, billId: string, actorUserId: string, reason: string) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.financeCarrierBill.findFirst({
        where: { id: billId, legalEntity: { companyId } },
      });
      if (!row) throw financeNotFound("Carrier bill not found", "FINANCE_CARRIER_BILL_NOT_FOUND");
      if (row.status !== "submitted") {
        throw financeConflict("Only submitted carrier bills can be rejected", "FINANCE_WORKFLOW_STATE_INVALID");
      }
      const updated = await tx.financeCarrierBill.update({
        where: { id: row.id },
        data: {
          status: "rejected",
          rejectedByUserId: actorUserId,
          rejectedAt: new Date(),
          rejectionReason: reason,
        },
        include: carrierBillInclude,
      });
      await tx.financeAuditEvent.create({
        data: {
          legalEntityId: row.legalEntityId,
          action: "finance.carrier_bill.rejected",
          actorUserId,
          detailsJson: { billId: row.id, reason },
        },
      });
      return updated;
    });
  }
}

export const prismaFinanceDocumentsRepository = new PrismaFinanceDocumentsRepository();
