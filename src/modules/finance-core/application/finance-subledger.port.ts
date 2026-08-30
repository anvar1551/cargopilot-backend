export type ReceivablesAgingQuery = {
  companyId: string;
  asOf: Date;
  cursor?: string;
  limit: number;
  currency?: string;
  customerEntityId?: string;
};

export type PayablesAgingQuery = {
  companyId: string;
  asOf: Date;
  cursor?: string;
  limit: number;
  currency?: string;
  carrierProviderId?: string;
};

export type UnappliedCashQuery = {
  companyId: string;
  cursor?: string;
  limit: number;
  currency?: string;
  customerEntityId?: string;
  type?: "receipt" | "refund";
  status?: "open" | "applied";
};

export interface FinanceSubledgerRepositoryPort {
  getReceivablesAging(query: ReceivablesAgingQuery): Promise<unknown>;
  getPayablesAging(query: PayablesAgingQuery): Promise<unknown>;
  listUnappliedCash(query: UnappliedCashQuery): Promise<unknown>;
}
