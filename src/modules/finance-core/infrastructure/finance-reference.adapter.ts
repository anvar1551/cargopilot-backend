import { resolveCarrierProviderForFinance } from "../../integrations-core/application/finance-reference.service";
import { validateCarrierBillOrderLegs } from "../../orders-core/application/finance-reference.service";
import { resolveProviderSettlementReferences } from "../../payments-core/application/finance-reference.service";
import type { FinanceReferencePort } from "../application/finance-documents.port";

export const financeReferenceAdapter: FinanceReferencePort = {
  resolveProviderSettlement: resolveProviderSettlementReferences,
  resolveCarrierProvider: resolveCarrierProviderForFinance,
  validateCarrierBillLegs: validateCarrierBillOrderLegs,
};
