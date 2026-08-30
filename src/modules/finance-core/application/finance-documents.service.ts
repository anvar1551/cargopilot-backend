import {
  authoritativeDocumentHash,
  prepareCarrierBill,
  prepareProviderSettlement,
  type CarrierBillLineInput,
  type ProviderSettlementLineInput,
} from "../domain/authoritative-documents";
import { financeConflict } from "../domain/finance.errors";
import type {
  FinanceDocumentPage,
  FinanceDocumentsRepositoryPort,
  FinanceReferencePort,
} from "./finance-documents.port";

export class FinanceDocumentsService {
  constructor(
    private readonly repository: FinanceDocumentsRepositoryPort,
    private readonly references: FinanceReferencePort,
  ) {}

  async createProviderSettlement(input: {
    companyId: string;
    actorUserId: string;
    idempotencyKey: string;
    providerConfigId: string;
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
    const provisionalLines = input.lines.map((line, index) => ({
      ...line,
      sequence: index + 1,
    }));
    const resolved = await this.references.resolveProviderSettlement({
      companyId: input.companyId,
      providerConfigId: input.providerConfigId,
      currency: input.currency.trim().toUpperCase(),
      lines: provisionalLines,
    });
    const prepared = prepareProviderSettlement({
      ...input,
      providerConfigId: resolved.provider.id,
      providerCode: resolved.provider.providerCode,
      environment: resolved.provider.environment,
      lines: resolved.lines,
    });
    const settlement = {
      ...prepared,
      payloadHash: authoritativeDocumentHash({
        providerConfigId: resolved.provider.id,
        providerCode: resolved.provider.providerCode,
        environment: resolved.provider.environment,
        externalReference: input.externalReference ?? null,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        currency: prepared.currency,
        fxRate: prepared.fxRate,
        fxRateAsOf: input.fxRateAsOf ?? null,
        reportedNetAmount: input.reportedNetAmount ?? null,
        metadata: input.metadata,
        lines: provisionalLines,
      }),
    };
    return this.repository.createProviderSettlement({
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      settlement,
    });
  }

  listProviderSettlements(companyId: string, page: FinanceDocumentPage) {
    return this.repository.listProviderSettlements(companyId, page);
  }

  getProviderSettlement(companyId: string, settlementId: string) {
    return this.repository.getProviderSettlement(companyId, settlementId);
  }

  submitProviderSettlement(companyId: string, settlementId: string, actorUserId: string) {
    return this.repository.submitProviderSettlement(companyId, settlementId, actorUserId);
  }

  async reconcileProviderSettlementLine(input: {
    companyId: string;
    settlementId: string;
    lineId: string;
    actorUserId: string;
    paymentIntentId?: string | null;
    paymentRefundId?: string | null;
  }) {
    const settlement = await this.repository.getProviderSettlement(
      input.companyId,
      input.settlementId,
    );
    if (settlement.status !== "draft" && settlement.status !== "submitted") {
      throw financeConflict(
        "Only draft or submitted settlements can be reconciled",
        "FINANCE_WORKFLOW_STATE_INVALID",
      );
    }
    const line = settlement.lines.find((candidate: { id: string }) => candidate.id === input.lineId);
    if (!line) {
      throw financeConflict(
        "Settlement line does not belong to this document",
        "FINANCE_SETTLEMENT_LINE_NOT_FOUND",
      );
    }
    if (line.type !== "payment" && line.type !== "refund") {
      throw financeConflict(
        "Only payment and refund lines require reconciliation",
        "FINANCE_SETTLEMENT_LINE_NOT_RECONCILABLE",
      );
    }
    const resolved = await this.references.resolveProviderSettlement({
      companyId: input.companyId,
      providerConfigId: settlement.providerConfigId,
      currency: settlement.currency,
      lines: [{
        sequence: line.sequence,
        type: line.type,
        amount: line.amount.toFixed(4),
        externalTransactionId: line.externalTransactionId,
        paymentIntentId: input.paymentIntentId ?? null,
        paymentRefundId: input.paymentRefundId ?? null,
        orderId: line.orderId,
      }],
    });
    return this.repository.reconcileProviderSettlementLine({
      companyId: input.companyId,
      settlementId: input.settlementId,
      lineId: input.lineId,
      actorUserId: input.actorUserId,
      resolvedLine: resolved.lines[0],
    });
  }

  async approveProviderSettlement(input: {
    companyId: string;
    settlementId: string;
    actorUserId: string;
    allowSelfApproval: boolean;
  }) {
    const settlement = await this.repository.getProviderSettlement(
      input.companyId,
      input.settlementId,
    );
    if (!input.allowSelfApproval && settlement.createdByUserId === input.actorUserId) {
      throw financeConflict(
        "Settlement creator cannot approve the same document",
        "FINANCE_SELF_APPROVAL_FORBIDDEN",
      );
    }
    return this.repository.approveProviderSettlement(
      input.companyId,
      input.settlementId,
      input.actorUserId,
    );
  }

  rejectProviderSettlement(
    companyId: string,
    settlementId: string,
    actorUserId: string,
    reason: string,
  ) {
    return this.repository.rejectProviderSettlement(companyId, settlementId, actorUserId, reason);
  }

  async createCarrierBill(input: {
    companyId: string;
    actorUserId: string;
    idempotencyKey: string;
    carrierProviderId: string;
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
    const carrier = await this.references.resolveCarrierProvider({
      companyId: input.companyId,
      providerId: input.carrierProviderId,
    });
    await this.references.validateCarrierBillLegs({
      companyId: input.companyId,
      carrierProviderId: carrier.id,
      lines: input.lines,
    });
    const bill = prepareCarrierBill({
      ...input,
      carrierProviderId: carrier.id,
      carrierCode: carrier.providerCode,
    });
    return this.repository.createCarrierBill({
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      bill,
    });
  }

  listCarrierBills(companyId: string, page: FinanceDocumentPage) {
    return this.repository.listCarrierBills(companyId, page);
  }

  getCarrierBill(companyId: string, billId: string) {
    return this.repository.getCarrierBill(companyId, billId);
  }

  submitCarrierBill(companyId: string, billId: string, actorUserId: string) {
    return this.repository.submitCarrierBill(companyId, billId, actorUserId);
  }

  async approveCarrierBill(input: {
    companyId: string;
    billId: string;
    actorUserId: string;
    allowSelfApproval: boolean;
  }) {
    const bill = await this.repository.getCarrierBill(input.companyId, input.billId);
    if (!input.allowSelfApproval && bill.createdByUserId === input.actorUserId) {
      throw financeConflict(
        "Carrier bill creator cannot approve the same document",
        "FINANCE_SELF_APPROVAL_FORBIDDEN",
      );
    }
    return this.repository.approveCarrierBill(input.companyId, input.billId, input.actorUserId);
  }

  rejectCarrierBill(companyId: string, billId: string, actorUserId: string, reason: string) {
    return this.repository.rejectCarrierBill(companyId, billId, actorUserId, reason);
  }
}
