import { assertFinanceCurrency } from "../domain/ledger";
import { financeBadRequest } from "../domain/finance.errors";
import type {
  FinanceSubledgerRepositoryPort,
  PayablesAgingQuery,
  ReceivablesAgingQuery,
  UnappliedCashQuery,
} from "./finance-subledger.port";

function assertAsOf(asOf: Date) {
  if (Number.isNaN(asOf.getTime())) {
    throw financeBadRequest("asOf must be a valid date", "FINANCE_AGING_DATE_INVALID");
  }
  return asOf;
}

export class FinanceSubledgerService {
  constructor(private readonly repository: FinanceSubledgerRepositoryPort) {}

  getReceivablesAging(query: ReceivablesAgingQuery) {
    return this.repository.getReceivablesAging({
      ...query,
      asOf: assertAsOf(query.asOf),
      currency: query.currency ? assertFinanceCurrency(query.currency) : undefined,
    });
  }

  getPayablesAging(query: PayablesAgingQuery) {
    return this.repository.getPayablesAging({
      ...query,
      asOf: assertAsOf(query.asOf),
      currency: query.currency ? assertFinanceCurrency(query.currency) : undefined,
    });
  }

  listUnappliedCash(query: UnappliedCashQuery) {
    return this.repository.listUnappliedCash({
      ...query,
      currency: query.currency ? assertFinanceCurrency(query.currency) : undefined,
    });
  }
}
