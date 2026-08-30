import type {
  prepareCarrierBill,
  prepareProviderSettlement,
} from "../domain/authoritative-documents";

export type PreparedProviderSettlement = ReturnType<typeof prepareProviderSettlement>;
export type PreparedCarrierBill = ReturnType<typeof prepareCarrierBill>;

export type FinanceDocumentPage = {
  cursor?: string;
  limit: number;
  status?: "draft" | "submitted" | "approved" | "rejected" | "cancelled";
};

export interface FinanceDocumentsRepositoryPort {
  createProviderSettlement(command: {
    companyId: string;
    actorUserId: string;
    idempotencyKey: string;
    settlement: PreparedProviderSettlement;
  }): Promise<any>;
  listProviderSettlements(companyId: string, page: FinanceDocumentPage): Promise<any>;
  getProviderSettlement(companyId: string, settlementId: string): Promise<any>;
  submitProviderSettlement(companyId: string, settlementId: string, actorUserId: string): Promise<any>;
  reconcileProviderSettlementLine(command: {
    companyId: string;
    settlementId: string;
    lineId: string;
    actorUserId: string;
    resolvedLine: {
      reconciliationStatus: "unmatched" | "matched" | "mismatch" | "ignored";
      reconciliationMessage?: string | null;
      paymentIntentId?: string | null;
      paymentRefundId?: string | null;
      orderId?: string | null;
    };
  }): Promise<any>;
  approveProviderSettlement(companyId: string, settlementId: string, actorUserId: string): Promise<any>;
  rejectProviderSettlement(
    companyId: string,
    settlementId: string,
    actorUserId: string,
    reason: string,
  ): Promise<any>;

  createCarrierBill(command: {
    companyId: string;
    actorUserId: string;
    idempotencyKey: string;
    bill: PreparedCarrierBill;
  }): Promise<any>;
  listCarrierBills(companyId: string, page: FinanceDocumentPage): Promise<any>;
  getCarrierBill(companyId: string, billId: string): Promise<any>;
  submitCarrierBill(companyId: string, billId: string, actorUserId: string): Promise<any>;
  approveCarrierBill(companyId: string, billId: string, actorUserId: string): Promise<any>;
  rejectCarrierBill(
    companyId: string,
    billId: string,
    actorUserId: string,
    reason: string,
  ): Promise<any>;
}

export interface FinanceReferencePort {
  resolveProviderSettlement(input: {
    companyId: string;
    providerConfigId: string;
    currency: string;
    lines: Array<{
      sequence: number;
      type: "payment" | "refund" | "fee" | "adjustment";
      amount: string;
      externalTransactionId?: string | null;
      paymentIntentId?: string | null;
      paymentRefundId?: string | null;
      orderId?: string | null;
    }>;
  }): Promise<{
    provider: { id: string; providerCode: string; environment: string };
    lines: any[];
  }>;
  resolveCarrierProvider(input: {
    companyId: string;
    providerId: string;
  }): Promise<{ id: string; providerCode: string }>;
  validateCarrierBillLegs(input: {
    companyId: string;
    carrierProviderId: string;
    lines: Array<{ orderId: string; orderLegId: string }>;
  }): Promise<void>;
}
