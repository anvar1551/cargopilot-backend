import type { AppUser } from "../../../types/app-user";
export type ReceivablesAgingQuery = {
  asOf: Date;
  cursor?: string;
  limit: number;
  currency?: string;
  customerEntityId?: string;
};

export type PayablesAgingQuery = {
  asOf: Date;
  cursor?: string;
  limit: number;
  currency?: string;
  carrierProviderId?: string;
};

export type UnappliedCashQuery = {
  cursor?: string;
  limit: number;
  currency?: string;
  customerEntityId?: string;
  type?: "receipt" | "refund";
  status?: "open" | "applied";
};

export interface FinanceSubledgerRepositoryPort {
  getReceivablesAging(actor: AppUser, query: ReceivablesAgingQuery): Promise<unknown>;
  getPayablesAging(actor: AppUser, query: PayablesAgingQuery): Promise<unknown>;
  listUnappliedCash(actor: AppUser, query: UnappliedCashQuery): Promise<unknown>;
}
